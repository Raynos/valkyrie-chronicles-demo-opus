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

/**
 * INTERCEPTION TUNING — retuned in round 23, with the numbers it was retuned against.
 *
 * Round 22's playtest lost FOUR of six soldiers during the PLAYER'S OWN TURN, mid-run, on the
 * bridge deck, to guns dug in 14-22 m away, with no cover reachable and no decision available.
 * Measured on the deck section of that crossing (25.3 m, scout, 62 HP, six trials each):
 *
 *     open ground          24.3 damage   10.7 rounds at you   15.6% hit rate
 *     Caution (1 CP)       11.7 damage    5.5 rounds          18.2%
 *     crouched in cover     4.0 damage    8.0 rounds           4.2%
 *     both guns SUPPRESSED 21.3 damage   10.0 rounds          16.7%   <- the whole problem
 *
 * That is 0.96 damage per metre in the open, so the real 80-91 m crossing costs about 82 HP
 * and a 62 HP scout simply does not arrive. And suppressing the guns covering the crossing —
 * the classic answer, and the one a playtester independently named as "the game" — bought
 * THREE DAMAGE, because interception never read `unit.suppression` at all.
 *
 * So: the raw rate comes down about 40%, and the rest of the fix is counterplay, not safety.
 *   - burst gap 0.55-1.35 s -> 0.95-2.05 s. The single biggest lever, and it costs nothing in
 *     menace: the gap is where you hear the bolt work and decide whether to run for it.
 *   - acquire 0.45 -> 0.70 s, so breaking cover buys you a beat, and Caution (x2.8 -> x3.6)
 *     buys you two and a half seconds of it for one Command Point.
 *   - maxConcurrent 6 -> 4. Six tracer streams was never readable, and it is a straight
 *     multiplier on damage.
 *   - SMG burst 6 -> 5, MG 8 -> 6.
 *   - SUPPRESSION now throttles the shooter: slower acquire, longer gaps, shorter bursts, and
 *     above `duckAt` he simply keeps his head down. Combined with units.js holding suppression
 *     instead of forgetting it in two seconds, a Command Point spent on the man covering the
 *     bridge is now the correct play.
 *   - COVER now makes a shooter hold fire against a MOVING target too, not only a stationary
 *     one, and throws the burst wider when he does fire.
 *
 * It is still lethal: run the open deck in front of four guns and a scout arrives on a third
 * of his health, stop out there and he dies, and a second crossing in the same turn kills him.
 */
export const INTERCEPT = {
  acquire: 0.70,
  gapMin: 0.95,
  gapMax: 2.05,
  stationaryScale: 0.28,     // cadence multiplier when the target is not moving
  maxConcurrent: 4,
  cautionAcquire: 3.6,       // x acquire time vs a soldier under the Caution order
  proneAcquire: 1.7,
  crouchAcquire: 1.3,
  // These four stack multiplicatively, so they are deliberately mild on their own. The first
  // pass ran them at 1.5 / 1.6 / 0.5 / 0.9 and fully suppressing the guns took a crossing from
  // 10.3 damage to 0.0 — which is the false-fix twin of the bug: a mechanic that switches
  // interception OFF is no better drama than one you cannot answer.
  supAcquire: 1.0,           // x acquire time per point of SHOOTER suppression
  supGap: 1.0,               // x burst gap per point of shooter suppression
  supBurst: 0.4,             // fraction of burst length lost at full shooter suppression
  duckAt: 0.45,              // shooter suppression above which he starts refusing to fire
  duckChance: 0.6,           // x suppression = chance he ducks instead of firing
  coverHold: 0.5,            // x cover = chance he holds fire against a RUNNER in cover
  coverSigma: 1.4,           // dispersion added by the target's cover (was 0.6)
  moverSuppression: 0.05,    // suppression a round in your direction puts on YOU
  moverSuppressionCap: 0.55, // ...and the ceiling, so being shot at never blinds you outright
};

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
    // Tuning — see INTERCEPT above for what every number is worth and what it was measured
    // against. Kept as instance fields so a mission or a difficulty setting can override one.
    this.acquireTime = INTERCEPT.acquire;
    this.burstGapMin = INTERCEPT.gapMin;
    this.burstGapMax = INTERCEPT.gapMax;
    this.stationaryScale = INTERCEPT.stationaryScale;
    this.maxConcurrent = INTERCEPT.maxConcurrent;   // readability cap — nearest N engage
  }

  /**
   * Seconds a shooter needs to draw a bead. Caution and a low stance buy the RUNNER time;
   * fire on the shooter buys it too, which is the point of suppressing the gun that covers
   * the crossing before you cross it.
   */
  acquireTimeFor(m, shooter = null) {
    let t = this.acquireTime;
    if (m.stealth) t *= INTERCEPT.cautionAcquire;
    if (m.stance === 2) t *= INTERCEPT.proneAcquire;
    else if (m.stance === 1) t *= INTERCEPT.crouchAcquire;
    if (shooter) t *= 1 + (shooter.suppression || 0) * INTERCEPT.supAcquire;
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
        st.nextBurstAt = this.time + this.acquireTimeFor(m, e) * (0.6 + this.rng() * 0.9);
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
          const gap = lerp(this.burstGapMin, this.burstGapMax, this.rng())
            * (1 + (e.suppression || 0) * INTERCEPT.supGap);
          st.nextBurstAt = this.time + gap * (targetMoving ? 1 : 1 / this.stationaryScale);
        }
      }
      return;
    }

    if (!aligned || st.acquireT < this.acquireTimeFor(m, e)) return;
    if (this.time < st.nextBurstAt) return;

    // A SUPPRESSED MAN KEEPS HIS HEAD DOWN. This is the counterplay the crossing was missing:
    // one Command Point spent shooting the gun that covers the bridge now buys the bridge.
    const sup = e.suppression || 0;
    if (sup > INTERCEPT.duckAt && this.rng() < sup * INTERCEPT.duckChance) {
      st.nextBurstAt = this.time + 0.8 + this.rng() * 0.9;
      return;
    }

    // Cover. VC rewards hugging sandbags, and it now rewards it while you are still moving:
    // a runner behind the bridge parapet is a bad shot, so the shooter waits for the gap
    // instead of stitching the stonework.
    const cov = coverFor(m, e.pos.x, e.pos.y + 1.4, e.pos.z, this.battle.world);
    if (!targetMoving) {
      if (cov > 0.6 && this.rng() > 0.25) { st.nextBurstAt = this.time + 1.2; return; }
    } else if (cov > 0.3 && this.rng() < cov * INTERCEPT.coverHold) {
      st.nextBurstAt = this.time + 0.6 + this.rng() * 0.7;
      return;
    }

    // HOLD FIRE THROUGH A SQUADMATE. Interception is the one place in the game where a
    // shooter never chose its own line: the mover picks the geometry. A soldier who opens
    // up with a friendly 3 m in front of him reads as broken even now that the rounds pass
    // harmlessly through, so he waits for the lane instead.
    if (this._blocked(e, m)) { st.nextBurstAt = this.time + 0.35; return; }

    const w = e.isVehicle && e.secondary ? e.secondary : e.weapon;
    const shrink = (targetMoving ? 1 : 0.6) * (1 - sup * INTERCEPT.supBurst);
    st.roundsLeft = Math.max(1, Math.round(interceptBurstSize(w) * shrink));
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
    sigma *= 1 + cover * INTERCEPT.coverSigma;

    jitterDirection(_dir, sigma, this.rng, _jit);
    const res = fireRound(e, _muzzle, _jit, {
      weapon: w, rng: this.rng, aimed: false,
      // Explicit even though fireRound now defaults to it: interception is the call site
      // that shipped the friendly-fire kills, and the intent should be readable here.
      ignoreTeam: e.team,
      units: this.battle.units, world: this.battle.world, battle: this.battle,
      maxDist: w.maxRange * 1.2, tracerForce: this.rng() < 0.5,
    });

    // Being shot at rattles you too — but capped, so a runner under fire still has a shot to
    // take when he reaches the far side. Symmetric with what the player does to them.
    m.applySuppression?.(INTERCEPT.moverSuppression, 1.2, INTERCEPT.moverSuppressionCap);
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
      st.acquireT = Math.max(st.acquireT, this.acquireTimeFor(unit, e));
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
    case 'smg': return 5;
    case 'mg': return 6;
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
  // Must track the live cadence or the command-mode threat overlay lies to the player about
  // the crossing it is drawing.
  const burstGap = (INTERCEPT.gapMin + INTERCEPT.gapMax) * 0.5
    * (1 + (shooter.suppression || 0) * INTERCEPT.supGap);
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
