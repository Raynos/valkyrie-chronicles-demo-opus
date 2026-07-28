// src/game/ai.js — the Imperial turn.
//
// The AI plays the same game the player does: it spends CP one soldier at a time, walks that
// soldier along a real path (eating your interception fire the whole way), takes exactly one
// attack, and stops. Nothing teleports and nothing is free.
//
// Planning is a two-stage search. For each unit we flood-fill its reachable ground, cheaply
// score every candidate stop (cover, threat, objective pull, class preference), keep the best
// handful, then pay for the expensive part — line of sight and expected damage — only on those.
// The unit whose best plan scores highest is the one that gets the CP.

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { CFG } from '../core/config.js';
import { clamp01, dampAngle, lerp, shortestAngle } from '../core/math.js';
import {
  CombatFlags, GRENADE, attackForecast, explode, fireBurst, hasLOS, solveArc, unitsHaveLOS,
} from './combat.js';
import { moveWithCollision, truncatePath } from './nav.js';
import { STANCE } from './units.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _aim = new THREE.Vector3();

const STATE = {
  IDLE: 'idle',
  PLANNING: 'planning',
  MOVING: 'moving',
  SETTLING: 'settling',
  ATTACKING: 'attacking',
  RECOVER: 'recover',
  DONE: 'done',
};

// How badly the AI wants each class dead, independent of raw damage.
const TARGET_VALUE = { sniper: 1.55, engineer: 1.45, lancer: 1.3, scout: 1.15, shock: 1.0, tank: 1.6 };

export class EnemyAI {
  constructor(battle, opts = {}) {
    this.battle = battle;
    this.world = battle.world;
    this.nav = battle.nav;
    this.rng = battle.rng || Math.random;
    this.team = opts.team ?? 1;

    this.state = STATE.IDLE;
    this.running = false;
    this.done = true;

    this.actor = null;              // unit currently taking its action
    this.plan = null;
    this.pathIndex = 0;
    this.stateT = 0;
    this.actionT = 0;
    this.maxActionTime = opts.maxActionTime ?? 14;
    this.thinkPause = opts.thinkPause ?? 0.35;
    this.plans = new Map();
    this._planQueue = [];
    this._speed = 0;

    this.speedScale = CFG.capture ? 6 : (opts.speedScale ?? 1);
  }

  // -------------------------------------------------------------------------

  begin(team = this.team) {
    this.team = team;
    this.running = true;
    this.done = false;
    this.state = STATE.PLANNING;
    this.stateT = 0;
    this.actor = null;
    this.plan = null;
    this.plans.clear();
    this._planQueue = this.myUnits();
    // Threat map is "where the enemy of this AI can shoot", so we build it *for* our team.
    this.nav?.buildThreat(this.battle.units, this.team);
    Bus.emit('ai:begin', { team, cp: this.battle.cp[team] });
  }

  abort() {
    if (this.actor) this.finishAction('aborted');
    this.running = false;
    this.done = true;
    this.state = STATE.DONE;
    this.battle.interception?.setMover(null);
  }

  myUnits() {
    return this.battle.units.filter((u) => u.team === this.team && u.active);
  }
  enemyUnits() {
    return this.battle.units.filter((u) => u.team !== this.team && u.alive && u.deployed);
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  update(dt) {
    if (!this.running) return false;
    const t = dt * this.speedScale;
    this.stateT += t;

    switch (this.state) {
      case STATE.PLANNING: this.tickPlanning(t); break;
      case STATE.MOVING: this.tickMoving(t); break;
      case STATE.SETTLING: this.tickSettling(t); break;
      case STATE.ATTACKING: this.tickAttacking(t); break;
      case STATE.RECOVER:
        if (this.stateT > 0.55) this.finishAction('complete');
        break;
      default: break;
    }
    if (this.actor) {
      this.actionT += t;
      if (this.actionT > this.maxActionTime) this.finishAction('timeout');
    }
    return this.running;
  }

  /** Plan a few units per frame so a 12-soldier turn never stalls the frame. */
  tickPlanning(dt) {
    let budget = 3;
    while (this._planQueue.length && budget-- > 0) {
      const u = this._planQueue.pop();
      if (!u.active) continue;
      this.plans.set(u, this.buildPlan(u));
    }
    if (this._planQueue.length) return;
    if (this.stateT < this.thinkPause) return;

    // Pick the best plan we can still afford.
    const cp = this.battle.cp[this.team];
    if (cp <= 0) { this.endTurn(); return; }

    let best = null, bestScore = -Infinity;
    for (const [u, p] of this.plans) {
      if (!u.active || !p) continue;
      if (!this.battle.canSelect(u, this.team)) continue;
      // Re-selecting a soldier that has already gone is progressively worse value.
      const decayPenalty = u.actionsThisTurn * 34;
      const s = p.score - decayPenalty;
      if (s > bestScore) { bestScore = s; best = u; }
    }
    // Spend freely while there is plenty of CP left; get fussy on the last point or two.
    const minGain = cp > 2 ? 8 : 26;
    if (!best || bestScore < minGain) { this.endTurn(); return; }

    this.startAction(best, this.plans.get(best));
  }

  startAction(unit, plan) {
    if (!this.battle.spendCpFor(unit, this.team)) { this.endTurn(); return; }
    this.actor = unit;
    this.battle.aiFocus = unit;
    this.plan = plan;
    this.actionT = 0;
    this.pathIndex = 1;
    this._speed = 0;
    unit.beginAction();
    unit.setStance?.(plan.crouch ? STANCE.CROUCH : STANCE.STAND);
    this.battle.interception?.setMover(unit);
    this.state = plan.path && plan.path.length > 1 ? STATE.MOVING : STATE.SETTLING;
    this.stateT = 0;
    Bus.emit('ai:act', { unit, plan: plan.kind, target: plan.target || null });
    Bus.emit('ai:focus', { unit });
  }

  finishAction(reason) {
    const u = this.actor;
    if (u) {
      u.speed = 0;
      u.velocity.set(0, 0, 0);
      u.actor?.play?.('idle');
      u.endAction();
      this.battle.onUnitActionEnd?.(u);
    }
    this.battle.interception?.setMover(null);
    this.actor = null;
    this.plan = null;
    this._lastClip = null;
    Bus.emit('ai:actEnd', { unit: u, reason });
    // Re-plan for the next activation.
    this.plans.clear();
    this._planQueue = this.myUnits();
    this.nav?.buildThreat(this.battle.units, this.team);
    this.state = STATE.PLANNING;
    this.stateT = 0;
    if (this.battle.checkObjectives()) { this.running = false; this.done = true; }
  }

  endTurn() {
    this.running = false;
    this.done = true;
    this.state = STATE.DONE;
    this.battle.interception?.setMover(null);
    Bus.emit('ai:end', { team: this.team });
    this.battle.endTurn();
  }

  // -------------------------------------------------------------------------
  // Movement execution
  // -------------------------------------------------------------------------

  tickMoving(dt) {
    const u = this.actor, p = this.plan;
    if (!u || !p?.path) { this.state = STATE.SETTLING; this.stateT = 0; return; }
    if (u.ap <= 0 || this.pathIndex >= p.path.length) {
      u.speed = 0; u.velocity.set(0, 0, 0);
      this.state = STATE.SETTLING; this.stateT = 0; return;
    }

    const wp = p.path[this.pathIndex];
    _v0.set(wp.x - u.pos.x, 0, wp.z - u.pos.z);
    const dist = _v0.length();
    if (dist < 0.45) {
      this.pathIndex++;
      if (this.pathIndex >= p.path.length) { this.state = STATE.SETTLING; this.stateT = 0; }
      return;
    }
    _v0.multiplyScalar(1 / dist);

    const cls = u.classDef;
    // Sprint across open ground, drop to a walk when close to the destination or under fire.
    const remaining = dist + this.remainingPathLength();
    const wantRun = remaining > 6 && u.suppression < 0.55 && !p.crouch;
    let speed = p.crouch ? cls.speed.crouch : (wantRun ? cls.speed.run : cls.speed.walk);
    if (u.suppression > 0.6) speed *= 0.75;
    if (u.tracksDisabled) speed = 0;

    const step = speed * dt;
    const moved = moveWithCollision(u.pos, _v0.x * step, _v0.z * step,
      u.isVehicle ? 1.6 : 0.36, this.nav, this.world, u.isVehicle ? 2.4 : 1.75);
    const paid = u.spendMove(moved, p.crouch ? 1 : 1);
    if (paid < moved - 1e-4) { u.ap = 0; }

    if (moved < step * 0.15) {
      // Stuck against geometry — nudge the waypoint index rather than grinding.
      this.pathIndex++;
    }

    this._speed = dt > 1e-5 ? moved / dt : 0;
    u.speed = this._speed;
    u.velocity.set(_v0.x * u.speed, 0, _v0.z * u.speed);
    u.yaw = dampAngle(u.yaw, Math.atan2(_v0.x, _v0.z), 9, dt);
    u.aimYaw = u.yaw;
    if (this.nav) u.pos.y = this.nav.heightAt(u.pos.x, u.pos.z);

    const clip = u.isVehicle ? null : (p.crouch ? 'crouchWalk' : (this._speed > cls.speed.walk * 1.1 ? 'run' : 'walk'));
    if (clip && clip !== this._lastClip) { u.actor?.play?.(clip); this._lastClip = clip; }
    u.syncActor?.();

    // Opportunistic: if we planned no attack and something wandered into point-blank range,
    // stop and shoot it.
    if (!p.target && this.stateT > 0.4) {
      const opp = this.findOpportunity(u);
      if (opp) { p.target = opp; p.kind = 'attack'; u.ap = Math.min(u.ap, 40); }
    }
  }

  remainingPathLength() {
    const p = this.plan;
    if (!p?.path) return 0;
    let d = 0;
    for (let i = this.pathIndex; i < p.path.length - 1; i++) d += p.path[i].distanceTo(p.path[i + 1]);
    return d;
  }

  findOpportunity(u) {
    if (u.attackUsed || u.ammo <= 0) return null;
    let best = null, bestV = 0;
    for (const e of this.enemyUnits()) {
      if (e.downed) continue;
      const d = u.pos.distanceTo(e.pos);
      if (d > u.weapon.range * 0.6) continue;
      if (!unitsHaveLOS(u, e, this.world)) continue;
      const f = attackForecast(u, e, { aimed: true, bloom: 0.6, battle: this.battle, world: this.world });
      const v = f.expectedDamage * (TARGET_VALUE[e.cls] || 1);
      if (v > bestV) { bestV = v; best = e; }
    }
    return bestV > 14 ? best : null;
  }

  // -------------------------------------------------------------------------
  // Attack execution
  // -------------------------------------------------------------------------

  tickSettling(dt) {
    const u = this.actor, p = this.plan;
    if (!u) return;
    u.speed = 0;
    u.velocity.set(0, 0, 0);
    if (this._lastClip !== 'idle') { u.actor?.play?.(p?.crouch ? 'crouchIdle' : 'idle'); this._lastClip = 'idle'; }

    // Capture / rescue / repair business that happens on arrival.
    if (this.stateT < 0.05) this.doArrivalActions(u, p);

    const target = p?.target;
    if (!target || !target.active || u.attackUsed || u.ammo <= 0) {
      if (this.stateT > 0.5) { this.state = STATE.RECOVER; this.stateT = 0; }
      return;
    }
    // Swivel onto the target, then hold the sights for the settle time.
    target.centerPoint(_aim);
    const want = Math.atan2(_aim.x - u.pos.x, _aim.z - u.pos.z);
    u.yaw = dampAngle(u.yaw, want, u.isVehicle ? 1.6 : 6, dt);
    u.aimYaw = dampAngle(u.aimYaw, want, u.isVehicle ? 1.4 : 8, dt);
    u.muzzlePoint(_muzzle);
    u.aimPitch = Math.atan2(_aim.y - _muzzle.y, Math.hypot(_aim.x - _muzzle.x, _aim.z - _muzzle.z));
    if (this._lastClip !== 'aim') { u.actor?.play?.('aim'); this._lastClip = 'aim'; }
    u.syncActor?.();

    const aligned = Math.abs(shortestAngle(u.aimYaw, want)) < 0.06;
    const settle = Math.min(u.weapon.settle, 1.4);
    if (aligned && this.stateT > settle * 0.75) { this.state = STATE.ATTACKING; this.stateT = 0; }
    if (this.stateT > settle * 3) { this.state = STATE.RECOVER; this.stateT = 0; }
  }

  doArrivalActions(u, p) {
    const b = this.battle;
    // Capture the camp we are standing in.
    const camp = b.campAt(u.pos);
    if (camp && camp.owner !== u.team && u.classDef.canCapture) b.captureCamp(camp, u);
    // Finish off / rescue bodies.
    for (const o of b.units) {
      if (!o.downed || !o.alive) continue;
      if (o.pos.distanceTo(u.pos) > 2.6) continue;
      if (o.team === u.team && u.classDef.canRescue) o.rescue(u);
      else if (o.team !== u.team) o.capture(u);
    }
    // Engineers patch the Imperial tank.
    if (u.classDef.canRepair) {
      for (const o of b.units) {
        if (o.team !== u.team || !o.isVehicle || o.hp >= o.maxHp) continue;
        if (o.pos.distanceTo(u.pos) < 4.5) { o.repair(o.maxHp * 0.22); break; }
      }
    }
    if (p?.grenadeAt) this.throwGrenade(u, p.grenadeAt);
  }

  tickAttacking() {
    const u = this.actor, p = this.plan;
    if (!u || !p?.target) { this.state = STATE.RECOVER; this.stateT = 0; return; }
    const target = p.target;
    const w = u.usingAlt && u.altAmmo ? u.altAmmo : u.weapon;

    u.muzzlePoint(_muzzle);
    target.centerPoint(_aim);
    // Aim slightly high on soldiers so the group straddles the chest, not the mud.
    if (!target.isVehicle) _aim.y += 0.08;
    _v1.subVectors(_aim, _muzzle).normalize();

    const summary = fireBurst(u, _muzzle, _v1, {
      weapon: w, rng: this.rng, aimed: true, target,
      bloom: w.settled * 1.15,
      units: this.battle.units, world: this.world, battle: this.battle,
      range: _muzzle.distanceTo(_aim),
    });
    u.ammo = Math.max(0, u.ammo - 1);
    u.attackUsed = true;
    u.actor?.play?.('fire', { once: true });
    this._lastClip = null;
    this.battle.interception?.alertTo(u);
    Bus.emit('attack:resolved', {
      unit: u, target: summary.target || target, hits: summary.hits, shots: w.shots || 1,
      damage: summary.damage, kills: summary.kills, crits: summary.crits, weapon: w, ai: true,
    });
    this.state = STATE.RECOVER;
    this.stateT = 0;
  }

  throwGrenade(u, point) {
    if (u.grenades <= 0) return;
    u.grenades--;
    u.muzzlePoint(_muzzle);
    _muzzle.y += 0.25;
    const vel = solveArc(_muzzle, point, GRENADE.throwSpeed);
    const am = this.battle.actionMode;
    if (am) am.spawnGrenade(u, _muzzle, vel);
    else {
      // No action-mode host (headless capture): resolve immediately at the aim point.
      explode(point, GRENADE.splash, GRENADE.splashPower, {
        source: u, aaPower: GRENADE.aaSplashPower,
        units: this.battle.units, world: this.world, battle: this.battle,
      });
    }
    u.actor?.play?.('throw', { once: true });
    Bus.emit('sfx', { name: GRENADE.sfx, pos: u.pos });
    Bus.emit('ai:grenade', { unit: u, point: point.clone() });
  }

  // =========================================================================
  // Planning
  // =========================================================================

  /**
   * @returns {null | { score, kind, path, target, crouch, grenadeAt, dest }}
   */
  buildPlan(u) {
    if (!u.active || !this.nav) return null;
    CombatFlags.silent = true;
    try { return this._buildPlan(u); } finally { CombatFlags.silent = false; }
  }

  _buildPlan(u) {
    const b = this.battle;
    const ap = b.previewAp(u);
    const range = ap / u.apPerMetre;
    const hurt = u.hpFrac < 0.34;

    // Only the nearest handful of enemies matter for scoring, and the LOS pass is the
    // expensive part — trimming here is what keeps a 12-soldier turn off the frame budget.
    let enemies = this.enemyUnits().filter((e) => !e.downed);
    if (enemies.length > 8) {
      enemies = enemies
        .map((e) => [e, e.pos.distanceToSquared(u.pos)])
        .sort((a, c) => a[1] - c[1])
        .slice(0, 8)
        .map((p) => p[0]);
    }

    // --- objective pull ---------------------------------------------------
    const goal = this.pickObjective(u, enemies);

    // --- candidate stops --------------------------------------------------
    const fill = this.nav.floodFill(u.pos, range);
    const cells = fill.cells;
    if (!cells.length) return null;
    const stride = Math.max(1, Math.floor(cells.length / 220));

    const nav = this.nav;
    const role = ROLE[u.cls] || ROLE.shock;
    const baseHeight = u.pos.y;

    /**
     * Cheap positional desirability of a cell. Absolute values here are meaningless — what
     * matters is the DIFFERENCE against where the soldier is already standing, because that
     * difference is what one Command Point buys.
     */
    const cheap = (ci, walked) => {
      const ix = ci % nav.w, iz = (ci / nav.w) | 0;
      const x = nav.worldX(ix), z = nav.worldZ(iz);
      let s = 0;
      s += nav.cover[ci] * role.cover;
      s -= nav.threat[ci] * (hurt ? role.threat * 2.2 : role.threat);
      s += (nav.height[ci] - baseHeight) * role.height;
      s -= walked * role.travel;

      if (goal) {
        const dg = Math.hypot(x - goal.x, z - goal.z);
        s -= dg * role.goal;
        if (goal.isCamp && dg < (goal.radius || 6)) s += 140;
      }

      let nearest = 1e6, nearestU = null;
      for (let k = 0; k < enemies.length; k++) {
        const d = Math.hypot(x - enemies[k].pos.x, z - enemies[k].pos.z);
        if (d < nearest) { nearest = d; nearestU = enemies[k]; }
      }
      if (nearestU) {
        const ideal = role.standoff(u, nearestU);
        s -= Math.abs(nearest - ideal) * role.standoffWeight;
        if (nearest < role.tooClose) s -= (role.tooClose - nearest) * 9;
      }
      if (hurt) s += Math.min(nearest, 40) * 3.2;      // wounded men break contact
      return s;
    };

    const cand = _cand;
    cand.length = 0;
    for (let i = 0; i < cells.length; i += stride) {
      const ci = cells[i];
      cand.push(ci, cheap(ci, nav.reachDist(ci)));
    }

    // Keep the best TOP candidates for the expensive LOS pass. `cand` is a flat
    // (cellIndex, score) list; sort an index list rather than re-packing it.
    const TOP = 14;
    const order = _order;
    order.length = 0;
    for (let i = 0; i < cand.length; i += 2) order.push(i);
    order.sort((a, c) => cand[c + 1] - cand[a + 1]);
    const top = _top;
    top.length = 0;
    for (let i = 0; i < order.length && i < TOP; i++) top.push(cand[order[i]], cand[order[i] + 1]);

    // --- evaluate the shortlist with real LOS + expected damage ------------
    let best = null;
    for (let i = 0; i < top.length; i += 2) {
      const ci = top[i];
      const posScore = top[i + 1];
      const ix = ci % nav.w, iz = (ci / nav.w) | 0;
      _v2.set(nav.worldX(ix), nav.height[ci], nav.worldZ(iz));
      const ev = this.evaluateFirePosition(u, _v2, enemies);
      let total = posScore + ev.value;
      if (hurt && !ev.target) total += 60;            // retreating with no shot is still fine
      if (!best || total > best.total) {
        best = { total, cell: ci, pos: _v2.clone(), target: ev.target, ev };
      }
    }
    if (!best) return null;

    // --- what does staying put get us? -------------------------------------
    // Only the positional half: the soldier cannot take a shot without being activated,
    // so a free firing solution from the current cell is a genuine reason to spend a CP.
    const curCell = nav.nearestWalkable(u.pos.x, u.pos.z);
    const baseScore = curCell >= 0 ? cheap(curCell, 0) : best.total;
    const gain = best.total - baseScore;

    // --- path -------------------------------------------------------------
    let path = this.nav.findPath(u.pos, best.pos, { threatWeight: hurt ? 0.9 : 0.35 });
    if (!path) path = [u.pos.clone(), best.pos.clone()];
    path = truncatePath(path, range);

    // --- grenade opportunity ---------------------------------------------
    const gren = u.grenades > 0 && !u.isVehicle ? this.findGrenadeSpot(u, best.pos, enemies) : null;

    const kind = gren ? 'grenade'
      : best.target ? 'attack'
        : goal?.isCamp ? 'capture'
          : hurt ? 'retreat' : 'advance';

    return {
      score: gain + (gren ? gren.value : 0),
      kind,
      path,
      dest: best.pos,
      target: gren ? null : best.target,
      grenadeAt: gren ? gren.point : null,
      crouch: role.crouch && !u.isVehicle && best.ev.cover > 0.3,
    };
  }

  /** Expected value of shooting from `pos`; the LOS traces live here. */
  evaluateFirePosition(u, pos, enemies) {
    const out = _eval;
    out.value = 0; out.target = null; out.cover = 0;
    if (u.attackUsed || u.ammo <= 0) {
      out.cover = this.nav ? this.nav.coverAtCell(pos.x, pos.z) : 0;
      return out;
    }
    const eyeY = pos.y + (u.isVehicle ? 2.0 : 1.55);
    const w = u.usingAlt && u.altAmmo ? u.altAmmo : u.weapon;
    let bestV = 0, bestT = null;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const d = Math.hypot(pos.x - e.pos.x, pos.z - e.pos.z);
      if (d > w.maxRange) continue;
      e.centerPoint(_v1);
      if (!hasLOS(pos.x, eyeY, pos.z, _v1.x, _v1.y, _v1.z, this.world)) continue;
      // Evaluate as if we were standing there. `_logicalOnly` makes muzzlePoint/headPoint
      // derive from `pos` instead of the rigged mesh, which has not moved.
      const sx = u.pos.x, sy = u.pos.y, sz = u.pos.z;
      u.pos.set(pos.x, pos.y, pos.z);
      u._logicalOnly = true;
      const f = attackForecast(u, e, { aimed: true, bloom: w.settled * 1.2, battle: this.battle, world: this.world });
      u._logicalOnly = false;
      u.pos.set(sx, sy, sz);
      let v = f.expectedDamage * (TARGET_VALUE[e.cls] || 1);
      if (f.lethal) v += 90;
      if (e.isVehicle && u.cls === 'lancer') v *= 1.9;
      if (!e.isVehicle && u.cls === 'lancer') v *= 0.45;    // don't waste lances on riflemen
      if (u.cls === 'sniper' && d > 30) v *= 1.35;
      v *= 1 - clamp01(f.cover) * 0.5;
      if (v > bestV) { bestV = v; bestT = e; }
    }
    out.value = bestV;
    out.target = bestT;
    out.cover = this.nav ? this.nav.coverAtCell(pos.x, pos.z) : 0;
    return out;
  }

  /**
   * Best grenade impact point: maximise (units in blast) weighted by how hurt they'd be,
   * requiring at least two bodies or one very exposed one.
   */
  findGrenadeSpot(u, from, enemies) {
    let best = null, bestV = 0;
    for (let i = 0; i < enemies.length; i++) {
      const c = enemies[i];
      const d = Math.hypot(from.x - c.pos.x, from.z - c.pos.z);
      if (d > 24 || d < 6) continue;
      if (!hasLOS(from.x, from.y + 1.5, from.z, c.pos.x, c.pos.y + 1.0, c.pos.z, this.world)) continue;
      let v = 0, n = 0;
      for (let k = 0; k < enemies.length; k++) {
        const e = enemies[k];
        const dd = e.pos.distanceTo(c.pos);
        if (dd > GRENADE.splash) continue;
        const f = 1 - clamp01(dd / GRENADE.splash);
        v += GRENADE.splashPower * f * (TARGET_VALUE[e.cls] || 1) * (e.isVehicle ? 0.12 : 1);
        n++;
      }
      // Blue-on-blue check.
      for (const a of this.myUnits()) {
        if (a.pos.distanceTo(c.pos) < GRENADE.splash * 1.15) v -= 220;
      }
      if (n >= 2) v *= 1.5;
      if (n >= 1 && v > bestV && v > 70) { bestV = v; best = c.pos; }
    }
    return best ? { point: best.clone(), value: bestV * 0.55 } : null;
  }

  /**
   * What is this soldier trying to reach? Camps first (they win the mission), then the
   * juiciest target, then the player's centre of mass.
   */
  pickObjective(u, enemies) {
    const b = this.battle;
    // Lancers hunt armour above all else.
    if (u.cls === 'lancer') {
      let tank = null, bd = 1e9;
      for (const e of enemies) {
        if (!e.isVehicle) continue;
        const d = e.pos.distanceTo(u.pos);
        if (d < bd) { bd = d; tank = e; }
      }
      if (tank) return { x: tank.pos.x, z: tank.pos.z, isCamp: false, unit: tank };
    }
    // Snipers hold whatever high ground they already own.
    if (u.cls === 'sniper' && u.hpFrac > 0.5) {
      let t = null, bd = 1e9;
      for (const e of enemies) {
        const d = e.pos.distanceTo(u.pos);
        if (d < bd && d < u.weapon.maxRange) { bd = d; t = e; }
      }
      if (t) return { x: lerp(u.pos.x, t.pos.x, 0.12), z: lerp(u.pos.z, t.pos.z, 0.12), isCamp: false };
      return { x: u.pos.x, z: u.pos.z, isCamp: false };
    }
    // Everyone else: closest capturable camp, preferring the player's.
    let camp = null, bd = 1e9;
    for (const c of b.camps) {
      if (c.owner === u.team) continue;
      if (!u.classDef.canCapture && c.owner !== -1) continue;
      const d = Math.hypot(c.pos.x - u.pos.x, c.pos.z - u.pos.z);
      const bias = c.owner === (this.team === 1 ? 0 : 1) ? 0.7 : 1.0;
      if (d * bias < bd) { bd = d * bias; camp = c; }
    }
    if (camp && u.classDef.canCapture) {
      return { x: camp.pos.x, z: camp.pos.z, isCamp: true, radius: camp.radius, camp };
    }
    // Otherwise converge on the enemy schwerpunkt.
    if (enemies.length) {
      _v0.set(0, 0, 0);
      for (const e of enemies) _v0.add(e.pos);
      _v0.multiplyScalar(1 / enemies.length);
      return { x: _v0.x, z: _v0.z, isCamp: false };
    }
    return camp ? { x: camp.pos.x, z: camp.pos.z, isCamp: true, radius: camp.radius, camp } : null;
  }

  dispose() { this.abort(); }
}

// ---------------------------------------------------------------------------
// Class doctrine. Every weight here is "how many score points is one unit of X worth".
// ---------------------------------------------------------------------------

const ROLE = {
  scout: {
    cover: 20, threat: 0.55, height: 1.0, travel: 0.55, goal: 2.4,
    standoff: (u, e) => 16, standoffWeight: 1.1, tooClose: 7, crouch: false,
  },
  shock: {
    cover: 34, threat: 0.65, height: 1.4, travel: 0.35, goal: 2.9,
    standoff: (u, e) => 10, standoffWeight: 2.0, tooClose: 4, crouch: true,
  },
  lancer: {
    cover: 30, threat: 1.15, height: 0.8, travel: 0.5, goal: 3.6,
    standoff: (u, e) => (e.isVehicle ? 9 : 20), standoffWeight: 2.6, tooClose: 5, crouch: true,
  },
  engineer: {
    cover: 40, threat: 1.5, height: 1.0, travel: 0.5, goal: 1.2,
    standoff: () => 26, standoffWeight: 1.5, tooClose: 12, crouch: true,
  },
  sniper: {
    cover: 30, threat: 1.9, height: 5.5, travel: 1.6, goal: 0.35,
    standoff: () => 48, standoffWeight: 1.8, tooClose: 22, crouch: true,
  },
  tank: {
    cover: 8, threat: 0.9, height: 0.6, travel: 0.4, goal: 2.2,
    standoff: (u, e) => (e.cls === 'lancer' ? 26 : 20), standoffWeight: 2.2, tooClose: 12, crouch: false,
  },
};

const _cand = [];
const _top = [];
const _order = [];
const _eval = { value: 0, target: null, cover: 0 };

export { STATE as AI_STATE, ROLE as AI_ROLES };
export default EnemyAI;
