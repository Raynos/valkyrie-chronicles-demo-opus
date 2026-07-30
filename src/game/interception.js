// src/game/interception.js — the mechanic that makes VC feel like VC.
//
// While ANY unit is moving in real time (player in Action Mode, or an AI soldier walking its
// plan), every hostile with line of sight, range and a firing arc opens up on it. Rounds are
// real traced bullets from combat.js, so cover, stance and speed all matter for the same reason
// they matter when the player pulls the trigger.
//
// The system is symmetric: player units intercept the enemy turn exactly the same way.

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { CFG } from '../core/config.js';
import { clamp, clamp01, dampAngle, lerp, shortestAngle } from '../core/math.js';
import {
  Ctx, coverFor, effectiveAccuracy, fireRound, friendlyInLine, jitterDirection, shotSigma,
  unitsHaveLOS,
} from './combat.js';

const _muzzle = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _jit = new THREE.Vector3();

// Per-shooter interception state, lazily attached to the unit.
function icp(u) {
  let s = u._icp;
  if (!s) {
    s = u._icp = {
      target: null,
      acquireT: 0,        // seconds spent tracking the current target
      nextBurstAt: 0,
      roundsLeft: 0,
      nextRoundAt: 0,
      firedThisMove: 0,
      lastSeen: 0,
    };
  }
  return s;
}

export class InterceptionSystem {
  /**
   * @param {object} battle  Battle instance (units, world, rng)
   */
  constructor(battle) {
    this.battle = battle;
    this.enabled = true;
    this.time = 0;
    this.mover = null;                   // the unit currently in motion
    this.moverTeam = -1;
    this.activeShooters = [];            // rebuilt only when the mover changes or every refreshEvery
    this._refreshAt = 0;
    this.refreshEvery = 0.22;            // seconds between LOS re-checks (LOS traces are the cost)
    this.rng = battle?.rng || Math.random;
    // Tuning
    this.acquireTime = 0.45;             // seconds before a shooter can open fire on a new target
    this.burstGapMin = 0.55;
    this.burstGapMax = 1.35;
    this.stationaryScale = 0.28;         // cadence multiplier when the target is not moving
    this.maxConcurrent = 6;              // readability cap — the nearest N shooters engage
  }

  /** Seconds a shooter needs to draw a bead. Caution (and a prone target) buys you time. */
  acquireTimeFor(m) {
    let t = this.acquireTime;
    if (m.stealth) t *= 2.8;
    if (m.stance === 2) t *= 1.6;
    else if (m.stance === 1) t *= 1.25;
    return t;
  }

  /** Called by actionMode / ai when a unit starts or stops moving under fire. */
  setMover(unit) {
    if (this.mover === unit) return;
    this._releaseAll();
    this.mover = unit || null;
    this.moverTeam = unit ? unit.team : -1;
    this._refreshAt = 0;
  }

  reset() {
    this._releaseAll();
    this.mover = null;
    this.moverTeam = -1;
    this.activeShooters.length = 0;
  }

  _releaseAll() {
    for (let i = 0; i < this.activeShooters.length; i++) {
      const s = this.activeShooters[i];
      const st = icp(s);
      if (st.target) Bus.emit('interception:end', { shooter: s, target: st.target });
      st.target = null;
      st.acquireT = 0;
      st.roundsLeft = 0;
    }
    this.activeShooters.length = 0;
  }

  /** Rebuild the list of hostiles that can currently engage the mover. */
  _refresh() {
    const out = this.activeShooters;
    const prev = _prevSet;
    prev.clear();
    for (let i = 0; i < out.length; i++) prev.add(out[i]);
    out.length = 0;

    const m = this.mover;
    if (!m || !m.active) { this._releaseAll(); return; }

    const units = this.battle.units;
    _cands.length = 0;
    for (let i = 0; i < units.length; i++) {
      const e = units[i];
      if (!e.active || e.team === m.team) continue;
      const C = e.classDef;
      const range = C.interceptRange || 0;
      if (range <= 0) continue;             // lancers and snipers do not intercept
      if (e.ammo <= 0 && !e.isVehicle) continue;
      const d2 = e.pos.distanceToSquared(m.pos);
      if (d2 > range * range) continue;
      if (!unitsHaveLOS(e, m, this.battle.world)) continue;
      _cands.push(e);
    }
    // Nearest first, capped — a wall of 12 tracer streams is noise, 6 is drama.
    _cands.sort((a, b) => a.pos.distanceToSquared(m.pos) - b.pos.distanceToSquared(m.pos));
    const n = Math.min(_cands.length, this.maxConcurrent);
    for (let i = 0; i < n; i++) {
      const e = _cands[i];
      out.push(e);
      const st = icp(e);
      st.lastSeen = this.time;
      if (st.target !== m) {
        st.target = m;
        st.acquireT = 0;
        st.roundsLeft = 0;
        st.nextBurstAt = this.time + this.acquireTimeFor(m) * (0.6 + this.rng() * 0.9);
        Bus.emit('interception', { shooter: e, target: m, first: true });
        Bus.emit('sfx', { name: 'interceptWarn', pos: e.pos });
      }
    }
    // Anyone who dropped out of the list disengages.
    for (const p of prev) {
      if (out.indexOf(p) < 0) {
        const st = icp(p);
        if (st.target) Bus.emit('interception:end', { shooter: p, target: st.target });
        st.target = null; st.roundsLeft = 0;
      }
    }
  }

  update(dt) {
    if (!this.enabled) return;
    this.time += dt;
    const m = this.mover;
    if (!m || !m.active) {
      if (this.activeShooters.length) this._releaseAll();
      return;
    }

    if (this.time >= this._refreshAt) {
      this._refreshAt = this.time + this.refreshEvery;
      this._refresh();
    }

    const moving = m.speed > 0.35;
    for (let i = 0; i < this.activeShooters.length; i++) {
      this._tickShooter(this.activeShooters[i], m, dt, moving);
    }
  }

  _tickShooter(e, m, dt, targetMoving) {
    const st = icp(e);
    if (st.target !== m) return;

    // Swivel to track. A shooter that has not lined up yet cannot fire.
    m.centerPoint(_aim);
    const want = Math.atan2(_aim.x - e.pos.x, _aim.z - e.pos.z);
    const turnRate = e.isVehicle ? 1.1 : 3.4;
    e.aimYaw = dampAngle(e.aimYaw, want, turnRate, dt);
    if (!e.isVehicle) e.yaw = dampAngle(e.yaw, want, turnRate * 0.55, dt);
    e.muzzlePoint(_muzzle);
    const dyaw = Math.abs(shortestAngle(e.aimYaw, want));
    e.aimPitch = Math.atan2(_aim.y - _muzzle.y, Math.hypot(_aim.x - _muzzle.x, _aim.z - _muzzle.z));

    const halfCone = (e.classDef.interceptCone || CFG.gameplay.interceptCone) * 0.5;
    const aligned = dyaw < Math.min(0.28, halfCone);
    st.acquireT += dt;

    // Firing a burst
    if (st.roundsLeft > 0) {
      if (this.time >= st.nextRoundAt) {
        // A squadmate has walked into the lane mid-burst: stop, do not stitch through him.
        if (this._blocked(e, m)) {
          st.roundsLeft = 0;
          st.nextBurstAt = this.time + 0.4;
          return;
        }
        this._fireOne(e, m, st);
        st.roundsLeft--;
        st.nextRoundAt = this.time + 60 / Math.max(60, e.weapon.rpm);
        if (st.roundsLeft <= 0) {
          const gap = lerp(this.burstGapMin, this.burstGapMax, this.rng());
          st.nextBurstAt = this.time + gap * (targetMoving ? 1 : 1 / this.stationaryScale);
        }
      }
      return;
    }

    if (!aligned || st.acquireT < this.acquireTimeFor(m)) return;
    if (this.time < st.nextBurstAt) return;
    // Stationary, well-covered targets get shot at far less — VC rewards hugging sandbags.
    if (!targetMoving) {
      const cov = coverFor(m, e.pos.x, e.pos.y + 1.4, e.pos.z, this.battle.world);
      if (cov > 0.6 && this.rng() > 0.25) { st.nextBurstAt = this.time + 1.2; return; }
    }

    // HOLD FIRE THROUGH A SQUADMATE. Interception is the one place in the game where a
    // shooter never chose its own line: the mover picks the geometry. A soldier who opens
    // up with a friendly 3 m in front of him reads as broken even now that the rounds pass
    // harmlessly through, so he waits for the lane instead.
    if (this._blocked(e, m)) { st.nextBurstAt = this.time + 0.35; return; }

    const w = e.isVehicle && e.secondary ? e.secondary : e.weapon;
    st.roundsLeft = Math.max(1, Math.round(interceptBurstSize(w) * (targetMoving ? 1 : 0.6)));
    st.nextRoundAt = this.time;
    Bus.emit('interception', { shooter: e, target: m, first: false });
  }

  /** Is one of `e`'s own side between its muzzle and the mover? */
  _blocked(e, m) {
    e.muzzlePoint(_muzzle);
    m.centerPoint(_aim);
    return !!friendlyInLine(e, _muzzle, _aim, this.battle.units);
  }

  _fireOne(e, m, st) {
    const w = e.isVehicle && e.secondary ? e.secondary : e.weapon;
    e.muzzlePoint(_muzzle);
    // Lead the target a little so tracers look like they are chasing you.
    m.centerPoint(_aim);
    const dist = _muzzle.distanceTo(_aim);
    const lead = clamp(dist / 380, 0, 0.35);
    _aim.addScaledVector(m.velocity, lead);
    _dir.subVectors(_aim, _muzzle).normalize();

    const cover = coverFor(m, _muzzle.x, _muzzle.y, _muzzle.z, this.battle.world);
    const acc = effectiveAccuracy(e, w, {
      aimed: false, range: dist, cover, target: m,
      battle: this.battle, underFire: false, targetSpeed: m.speed,
    });
    // Interception is snap fire: never fully settled, and hard to keep on a sprinting man.
    const _defCtxLocal = { cover, battle: this.battle, underFire: true, attacker: e };
    const dmods = m.evalPotentials('defend', _defCtxLocal);
    const eva = clamp01(m.evasion + dmods.eva + clamp01(m.speed / 5.5) * 0.26 + m.stanceCover() * 0.35);
    let sigma = shotSigma(e, w, acc, lerp(1.0, 0.62, clamp01(st.acquireT / 2.2)), 0);
    sigma *= 1 + eva * 1.9;
    sigma *= 1 + cover * 0.6;

    jitterDirection(_dir, sigma, this.rng, _jit);
    const res = fireRound(e, _muzzle, _jit, {
      weapon: w, rng: this.rng, aimed: false,
      // Explicit even though fireRound now defaults to it: interception is the call site
      // that shipped the friendly-fire kills, and the intent should be readable here.
      ignoreTeam: e.team,
      units: this.battle.units, world: this.battle.world, battle: this.battle,
      maxDist: w.maxRange * 1.2, tracerForce: this.rng() < 0.5,
    });

    if (!m.suppressionImmune) m.suppression = clamp01(m.suppression + 0.08);
    Bus.emit('interception:shot', {
      shooter: e, target: m, hit: res.hit, damage: res.damage, part: res.part,
      point: res.point.clone(),
    });
    if (res.hit && res.unit === m) {
      Bus.emit('sfx', { name: 'nearMiss', pos: m.pos, vol: 0.6 });
    } else if (res.distance < 1e5) {
      // Crack of a round going past the player's ear.
      const miss = res.point.distanceTo(_aim);
      if (miss < 2.2) Bus.emit('sfx', { name: 'nearMiss', pos: m.pos, vol: clamp01(1 - miss / 2.2) });
    }
  }

  /**
   * Immediate retaliation: firing your weapon gives away your position, so every hostile
   * that can see you re-acquires instantly instead of waiting out its acquire timer.
   */
  alertTo(unit) {
    if (!unit?.active) return;
    const units = this.battle.units;
    for (let i = 0; i < units.length; i++) {
      const e = units[i];
      if (!e.active || e.team === unit.team) continue;
      if (e.pos.distanceToSquared(unit.pos) > 60 * 60) continue;
      if (!unitsHaveLOS(e, unit, this.battle.world)) continue;
      const st = icp(e);
      st.acquireT = Math.max(st.acquireT, this.acquireTimeFor(unit));
      if (st.target === unit) st.nextBurstAt = Math.min(st.nextBurstAt, this.time + 0.15);
    }
  }

  /** Units currently shooting at `unit` — the HUD draws a warning chevron per shooter. */
  shootersOn(unit) {
    _out.length = 0;
    for (let i = 0; i < this.activeShooters.length; i++) {
      const s = this.activeShooters[i];
      if (icp(s).target === unit) _out.push(s);
    }
    return _out;
  }

  /** 0..1 how hot the current position is; drives the HUD's danger vignette. */
  pressure() {
    if (!this.mover) return 0;
    let p = 0;
    for (let i = 0; i < this.activeShooters.length; i++) {
      const s = this.activeShooters[i];
      const st = icp(s);
      if (st.target !== this.mover) continue;
      p += st.roundsLeft > 0 ? 0.34 : 0.16;
    }
    return clamp01(p);
  }

  dispose() { this.reset(); }
}

/** Rounds per interception burst — SMGs hose, rifles double-tap. */
export function interceptBurstSize(w) {
  switch (w.kind) {
    case 'smg': return 6;
    case 'mg': return 8;
    case 'rifle': return 2;
    case 'cannon': return 1;
    default: return 2;
  }
}

/**
 * Standalone predictor used by commandMode's threat overlay and by the AI: how much damage
 * would `mover` expect to eat crossing `metres` of open ground inside `shooter`'s envelope?
 */
export function expectedInterceptionDamage(shooter, mover, metres, world = Ctx.world) {
  const C = shooter.classDef;
  if (!C.interceptRange) return 0;
  const w = shooter.isVehicle && shooter.secondary ? shooter.secondary : shooter.weapon;
  const speed = Math.max(1.5, mover.classDef.speed.walk);
  const seconds = metres / speed;
  const burstGap = 0.95;
  const bursts = Math.max(0, seconds / burstGap - 0.5);
  const rounds = bursts * interceptBurstSize(w);
  const dist = shooter.pos.distanceTo(mover.pos);
  const cover = coverFor(mover, shooter.pos.x, shooter.pos.y + 1.4, shooter.pos.z, world);
  const acc = effectiveAccuracy(shooter, w, { aimed: false, range: dist, cover, target: mover });
  const sigma = shotSigma(shooter, w, acc, 0.8, 0) * (1 + mover.evasion * 2);
  const theta = Math.atan2(mover.targetRadius() * (1 - cover * 0.82), Math.max(1, dist));
  const p = 1 - Math.exp(-(theta * theta) / (2 * sigma * sigma));
  const per = (mover.isVehicle ? w.aaDamage : w.apDamage) * (1 - clamp01(mover.defense));
  return rounds * p * per;
}

const _cands = [];
const _out = [];
const _prevSet = new Set();

export default InterceptionSystem;
