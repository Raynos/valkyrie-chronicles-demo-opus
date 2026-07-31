// src/game/actionMode.js — real-time third-person control of one soldier.
//
// Spring-arm shoulder camera with collision pull-in, stance system (stand/crouch/prone),
// sprint, vaulting, ladders, AP burned per metre travelled, and the VC targeting state:
// time dilates, the camera pulls in, the reticle bloom converges, you get ONE attack, and
// then you must go back to Command Mode and spend another CP to use this soldier again.
//
// Adapters the contract does not name:
//   * ladders  — world.ladders : [{ a:Vector3 bottom, b:Vector3 top }]  (optional)
//   * physics  — see combat.js setPhysics(); we fall back to our own tracing.
//   * grenade visuals — ActionMode.visualFactory(kind) may be replaced by the integrator
//     to hand back a themed mesh; the built-in makes a plain low-poly stand-in.

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { CFG } from '../core/config.js';
import { Input } from '../core/input.js';
import { clamp, clamp01, damp, dampAngle, lerp, TAU } from '../core/math.js';
import {
  GRENADE, attackForecast, bloomFor, canSee, coverFor, effectiveAccuracy, explode, fireBurst,
  friendlyInLine, hasLOS, predictArc, shotSigma, solveArc, traceScene, traceWorld,
} from './combat.js';
import { moveWithCollision } from './nav.js';
import { STANCE } from './units.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _camWant = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _aimPoint = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _head = new THREE.Vector3();
const _off = new THREE.Vector3();
const _up = new THREE.Vector3();
const _arcOut = [];

const MODE = { MOVE: 0, AIM: 1, GRENADE: 2, INTERACT: 3, FIRING: 4, DONE: 5 };

// Target-magnetism cone, as a fraction of screen HEIGHT. 0.26 * 720 = 187 px, which through the
// aim FOV is 4.4 deg: at 14 m that reaches about half a body-height past the edge of a man, so
// "crosshair on the dirt by his boots" still means him. MEASURED: the latch envelope is 0-4.7 deg
// of angular error at 14 m (see the round-21 notes). Generous on purpose — the nearest man to the
// crosshair wins, so width costs forgiveness, not accuracy.
const MAGNET_SCREEN_FRAC = 0.26;

// ---------------------------------------------------------------------------
// THE CLOSE-RANGE LOCK, AND WHY IT USED TO BE IMPOSSIBLE. Round-23 measurement.
//
// A screen-space cone is a fixed ANGLE, so the slack it grants in WORLD metres grows with
// range: 4.68 deg is 0.36 m of forgiveness at 4.5 m and 3.39 m at 41 m. Meanwhile the aim
// camera used to converge on a point a flat 40 m ahead of the soldier, so the crosshair only
// coincided with the weapon's aim line at 40 m; nearer than that the shoulder offset threw the
// crosshair sideways off the line by
//        0.43 m at 3 m   0.41 at 5   0.39 at 8   0.33 at 17   0.16 at 40   0.03 at 58
// Two curves that cross at about 4.5 m. Past the crossing the magnet swallows the parallax and
// you cannot miss; inside it the parallax is bigger than the entire forgiveness envelope and
// you cannot hit. MEASURED, same build, same session: sniper five for five at 40.5-58.5 m,
// scout/shocktrooper ZERO for ten at 2.9-19.8 m, every failure `noTarget` with a man filling a
// third of the screen. The sniper was never immune because he is a sniper — he was immune
// because at 44 m the parallax is 0.15 m.
//
// Two fixes, and both are needed: the camera now converges on the thing you are aiming AT
// (see updateCamera, `convergeDist`), which deletes the parallax at every range; and the
// magnet gets a floor in METRES so a man three paces away is at least as forgiving as a man
// at thirty.
//
// NEAR_FORGIVE_M is "a man's shoulders plus half a stride". MAGNET_MAX_RAD caps the whole
// thing at 18 deg off the crosshair so the floor can never reach round a corner for someone
// the player is plainly not pointing at — below ~2.9 m the cap takes over and the envelope
// tightens back to pure angle, which is right: at arm's length you ARE pointing precisely.
const NEAR_FORGIVE_M = 0.9;
const MAGNET_MAX_RAD = 0.32;

// Where the camera axis crosses the soldier's aim line. Free-look keeps the old far
// convergence (the shoulder offset is what makes a third-person camera read as third-person);
// aim mode converges on the thing under the reticle, floored so a wall at arm's length cannot
// swing the lens round in front of the man.
const CONVERGE_FAR = 40;
const CONVERGE_MIN = 3.2;
// With no man locked, converge no nearer than this. Converging on whatever surface the reticle
// happens to rest on swings the lens hard when you point at a sandbag two paces away — measured,
// it put 26% of one bridge-deck frame under the soldier's own back. A man always wins over a
// surface, and the magnet's near-field floor (0.9 m) comfortably covers the residual parallax
// this leaves at 3 m (0.33 m), so the lock still happens and the convergence then snaps to him.
const CONVERGE_IDLE = 14;

// Camera anti-clip. CAM_RADIUS is the half-width of the cheap sphere-cast that keeps the lens
// out of masonry the single centre ray used to slip past; HEAD_CLEAR is how far the lens must
// stay off the subject's own head, which is what "40% of the frame is his green helmet" was.
const CAM_RADIUS = 0.26;
const CAM_PAD = 0.3;
const HEAD_CLEAR = 0.72;

// How far past the weapon's own reach the reticle will still NAME a man. Inside maxRange he is
// a target; between maxRange and this he is named with the metres you are short and the trigger
// is refused, because the alternative — measured — is that the game does nothing at all and the
// player cannot tell "too far" from "broken". 3x covers the worst case in the mission: a
// shocktrooper's SMG reaches 30 m into engagements that start at 37 m.
const NAME_RANGE_MUL = 3;

// Aim states published on `aim:target.status`. Three different failures used to be one silent
// nothing; the HUD needs to say which.
export const AIM_STATUS = {
  LOCKED: 'locked',              // a man, in range, with a clear muzzle line. Chance is real.
  OUT_OF_RANGE: 'outOfRange',    // named, `nearest.needCloser` metres short, trigger refused
  NO_LOS: 'noLineOfSight',       // something solid between the muzzle and him
  NO_TARGET: 'noTarget',         // nobody in the cone at all
  NO_ATTACKS: 'noAttacks',       // the sortie's one attack is spent
  NO_AMMO: 'noAmmo',
};

export class ActionMode {
  /**
   * @param {object} battle
   * @param {THREE.PerspectiveCamera} camera
   * @param {object} opts { scene }
   */
  constructor(battle, camera, opts = {}) {
    this.battle = battle;
    this.camera = camera;
    this.scene = opts.scene || battle.scene;
    this.world = battle.world;
    this.nav = battle.nav;
    this.rng = battle.rng || Math.random;

    this.active = false;
    this.unit = null;
    this.mode = MODE.MOVE;

    // --- camera rig -------------------------------------------------------
    this.camYaw = 0;
    this.camPitch = -0.06;
    this.armLength = 3.45;
    this.armTarget = 3.45;
    this.shoulder = 0.62;
    this.shoulderTarget = 0.62;
    this.camHeight = 1.52;
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.fov = CFG.camera.fov;
    this.fovTarget = CFG.camera.fov;
    this.sensitivity = 0.0022;
    this.pitchMin = -0.95;
    this.pitchMax = 0.82;
    this.shake = 0;
    this.recoilKick = 0;
    this.recoilYaw = 0;

    // --- locomotion -------------------------------------------------------
    this.sprinting = false;
    this.moveInput = new THREE.Vector2();
    this.speedSmoothed = 0;
    this.footAccum = 0;
    this.vault = null;                // { t, dur, from, to }
    this.ladder = null;               // { rail, t, dir }
    this.groundY = 0;

    // --- aiming -----------------------------------------------------------
    this.aimHold = 0;                 // seconds settled
    this.aimToggled = false;          // Q-latch; see the aim block in update()
    this.bloom = 1;
    this.aimTarget = null;            // Unit under the reticle
    this.aimPart = null;
    this.forecast = null;
    this.timeScale = 1;
    this.timeScaleTarget = 1;
    this.reticleRadiusPx = 0;
    this.attacksLeft = 1;
    this.postFire = 0;                // cinematic hold after the shot
    this.aimStatus = AIM_STATUS.NO_TARGET;
    this.aimNearest = null;           // { unit, distance, maxRange, needCloser }
    this.aimBlockedBy = null;         // a squadmate standing in the lane
    this.aimOutOfRange = false;       // the trigger is refused while this is true
    this._spotT = 0;
    this.aimFocus = new THREE.Vector3();  // world point the reticle is on, for camera convergence
    this.aimFocusValid = false;
    this.aimFocusIsMan = false;           // a man wins over a surface: converge all the way in
    this.convergeDist = CONVERGE_FAR;     // where the camera axis meets the soldier's aim line

    // --- grenade ----------------------------------------------------------
    this.grenades = [];
    this.arcPoints = _arcOut;
    this.arcCount = 0;
    this.throwPower = GRENADE.throwSpeed;
    this.visualFactory = defaultVisualFactory;

    // --- interaction ------------------------------------------------------
    this.interactTarget = null;       // { kind, unit|collider|camp, label, progress, duration }
    this.interactProgress = 0;

    this.apStartOfAction = 0;
    this.endRequested = false;
    this._bound = false;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  enter(unit) {
    this.active = true;
    this.unit = unit;
    this.mode = MODE.MOVE;
    this.apStartOfAction = unit.ap;
    this.attacksLeft = 1 + (unit.extraAttacks || 0);
    unit.extraAttacks = 0;
    this.endRequested = false;
    this.aimHold = 0;
    this.aimToggled = false;
    this.bloom = 1;
    this.postFire = 0;
    this.interactProgress = 0;
    this.timeScale = this.timeScaleTarget = 1;
    this.aimStatus = AIM_STATUS.NO_TARGET;
    this.aimNearest = null;
    this.aimBlockedBy = null;
    this.aimOutOfRange = false;
    this.aimFocusValid = false;
    this.convergeDist = CONVERGE_FAR;
    this._spotT = 0;
    this.camYaw = unit.yaw;
    this.camPitch = -0.08;
    this.armLength = this.armTarget = unit.isVehicle ? 8.5 : 3.45;
    this.fovTarget = CFG.camera.fov;
    this.speedSmoothed = 0;
    this.sprinting = false;
    unit.setStance?.(STANCE.STAND);
    unit.actor?.play?.('idle');
    this.battle.interception?.setMover(unit);
    if (!CFG.capture) Input.requestLock();
    Bus.emit('action:enter', { unit, ap: unit.ap });
    Bus.emit('sfx', { name: 'actionEnter' });
  }

  exit() {
    if (!this.active) return;
    const u = this.unit;
    this.active = false;
    this.mode = MODE.DONE;
    this.timeScale = this.timeScaleTarget = 1;
    this.battle.interception?.setMover(null);
    if (u) {
      u.speed = 0;
      u.velocity.set(0, 0, 0);
      u.actor?.play?.('idle');
      u.setStance?.(STANCE.STAND);
    }
    if (!CFG.capture) Input.exitLock();
    Bus.emit('action:exit', { unit: u, apLeft: u ? u.ap : 0 });
    this.unit = null;
  }

  requestEnd() { this.endRequested = true; }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt  REAL seconds (camera/input run at real time)
   * @param {number} gdt gameplay seconds (already scaled by battle.timeScale)
   */
  update(dt, gdt = dt) {
    // Grenades keep cooking even when the player has left the mode.
    this.updateGrenades(gdt);
    if (!this.active || !this.unit) return;
    const u = this.unit;

    if (!u.active) { this.finish('downed'); return; }

    this.timeScale = damp(this.timeScale, this.timeScaleTarget, 9, dt);

    this.readLook(dt);
    if (this.vault) this.updateVault(gdt);
    else if (this.ladder) this.updateLadder(gdt);
    else this.updateLocomotion(gdt);

    this.sweepSpotting(dt);
    this.updateModeInput(dt, gdt);
    this.updateInteraction(gdt);
    this.updateCamera(dt);

    u.syncActor?.();

    if (this.postFire > 0) {
      this.postFire -= dt;
      if (this.postFire <= 0 && this.attacksLeft <= 0 && u.ap <= 0) this.finish('spent');
    }
    if (this.endRequested) this.finish('manual');
  }

  finish(reason) {
    if (!this.active) return;
    const u = this.unit;
    Bus.emit('action:end', { unit: u, reason, apLeft: u ? u.ap : 0 });
    this.exit();
    this.battle.endAction(reason);
  }

  // -------------------------------------------------------------------------
  // Look
  // -------------------------------------------------------------------------

  readLook(dt) {
    if (CFG.capture) return;
    const sens = this.sensitivity * (this.mode === MODE.AIM ? (this.unit.weapon.scope ? 0.32 : 0.55) : 1);
    this.camYaw -= Input.mouse.dx * sens;
    this.camPitch -= Input.mouse.dy * sens;
    this.camPitch = clamp(this.camPitch, this.pitchMin, this.pitchMax);
    if (this.camYaw > Math.PI) this.camYaw -= TAU;
    if (this.camYaw < -Math.PI) this.camYaw += TAU;
    // Recoil recovery
    this.recoilKick = damp(this.recoilKick, 0, 6, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, 6, dt);
  }

  // -------------------------------------------------------------------------
  // Locomotion
  // -------------------------------------------------------------------------

  updateLocomotion(dt) {
    const u = this.unit;
    const cls = u.classDef;

    // --- input ------------------------------------------------------------
    let mx = 0, mz = 0;
    if (this.scriptedMove) {
      // Capture shots and the headless test harness drive the soldier directly.
      mx = this.scriptedMove.x; mz = this.scriptedMove.y;
    } else if (!CFG.capture) {
      if (Input.down('w') || Input.down('arrowup')) mz += 1;
      if (Input.down('s') || Input.down('arrowdown')) mz -= 1;
      if (Input.down('a') || Input.down('arrowleft')) mx -= 1;
      if (Input.down('d') || Input.down('arrowright')) mx += 1;
    }
    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }

    // --- stance -----------------------------------------------------------
    if (!CFG.capture && !u.isVehicle) {
      if (Input.pressed('c') || Input.pressed('control')) {
        u.setStance(u.stance === STANCE.CROUCH ? STANCE.STAND : STANCE.CROUCH);
      }
      if (Input.pressed('z')) {
        u.setStance(u.stance === STANCE.PRONE ? STANCE.STAND : STANCE.PRONE);
      }
    }
    this.sprinting = !CFG.capture && Input.down('shift') && u.stance === STANCE.STAND && this.mode === MODE.MOVE;

    // --- speed ------------------------------------------------------------
    let speed = u.stance === STANCE.PRONE ? cls.speed.crouch * 0.45
      : u.stance === STANCE.CROUCH ? cls.speed.crouch
        : this.sprinting ? cls.speed.run : cls.speed.walk;
    if (this.mode === MODE.AIM || this.mode === MODE.GRENADE) speed *= 0.32;
    if (u.suppression > 0.5) speed *= lerp(1, 0.72, clamp01((u.suppression - 0.5) * 2));
    if (u.tracksDisabled) speed = 0;
    if (u.ap <= 0) speed = 0;

    // Slope: uphill costs speed, downhill a little more.
    if (this.world?.terrain?.slopeAt) {
      const s = this.world.terrain.slopeAt(u.pos.x, u.pos.z);
      speed *= lerp(1, 0.52, clamp01(s / 0.8));
    }

    // --- move -------------------------------------------------------------
    _fwd.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
    _rgt.set(_fwd.z, 0, -_fwd.x);
    _v0.set(0, 0, 0).addScaledVector(_fwd, mz).addScaledVector(_rgt, mx);
    const wants = _v0.lengthSq() > 1e-6;
    if (wants) _v0.normalize();

    let travelled = 0;
    if (wants && speed > 0.01) {
      const step = speed * dt;
      travelled = moveWithCollision(
        u.pos, _v0.x * step, _v0.z * step,
        u.isVehicle ? 1.6 : 0.36, this.nav, this.world, u.isVehicle ? 2.4 : 1.75,
      );
      // Charge AP. Sprinting is the same metres but the extra exposure is the real cost.
      const paid = u.spendMove(travelled, u.stance === STANCE.PRONE ? 1.25 : 1);
      if (paid < travelled - 1e-4) {
        // Ran out mid-step: snap back the unpaid remainder.
        u.pos.x -= _v0.x * (travelled - paid);
        u.pos.z -= _v0.z * (travelled - paid);
        travelled = paid;
      }
      // Body faces travel direction, upper body tracks the camera.
      const moveYaw = Math.atan2(_v0.x, _v0.z);
      u.yaw = dampAngle(u.yaw, this.mode === MODE.MOVE ? moveYaw : this.camYaw, 11, dt);
    } else if (this.mode !== MODE.MOVE) {
      u.yaw = dampAngle(u.yaw, this.camYaw, 9, dt);
    }

    const inst = dt > 1e-5 ? travelled / dt : 0;
    this.speedSmoothed = damp(this.speedSmoothed, inst, 12, dt);
    u.speed = this.speedSmoothed;
    u.velocity.set(_v0.x * u.speed, 0, _v0.z * u.speed);
    u.aimYaw = this.camYaw;
    u.aimPitch = -this.camPitch;

    // Ground follow (nav.heightAt already applied inside moveWithCollision; re-sample when idle)
    this.groundY = this.nav ? this.nav.heightAt(u.pos.x, u.pos.z) : u.pos.y;
    u.pos.y = damp(u.pos.y, this.groundY, 18, dt);

    // --- animation --------------------------------------------------------
    this.driveAnimation(u, dt);

    // --- vault / ladder probes -------------------------------------------
    if (!CFG.capture && Input.pressed(' ')) {
      if (!this.tryLadder()) this.tryVault();
    }
  }

  /**
   * Locomotion is driven by GROUND SPEED, never by a clip name.
   *
   * anim.js cross-blends the stance's clip set by `speed` and derives the cycle rate from the
   * blended stride (metres per cycle), so the ONE thing it needs from the game layer is how
   * fast the man is actually moving. Nothing ever told it: this used to `play(clip)`, and
   * `play()` on a locomotion member snaps `animator.speed` to that clip's NOMINAL speed
   * (walk = 1.30 m/s). Every soldier therefore ran his cycle for 1.30 m/s while travelling at
   * 2.5-5.7. `play()` is now reserved for one-shots (fire / reload / vault / hit).
   *
   * Consequence worth stating plainly: at walk = 3.1 m/s the blend lands on the `run` clip,
   * because 3.1 m/s IS a run. Locked feet under an honest cycle beat a walk cycle skating.
   *
   * MEASURED, headless, engineer at 2.9-3.0 m/s (ground travelled per cycle / the foot's own
   * swing per cycle; 1.0 = planted):
   *     stand  3.53, 3.27  ->  2.55, 2.38          crouch  2.72  ->  1.25
   * The remaining error is NOT here. anim.js's rate math is exact — the root now travels one
   * declared `stride` per cycle to within 1% — but the clips' declared strides overstate the
   * distance the ankle actually swings: walk declares 1.38 m and swings 0.89, run declares
   * 2.30 and swings 0.85, crouchWalk declares 0.62 and swings 0.49. The residual is exactly
   * declaredStride / actualSwing, and it lives in src/actors/anim.js CLIP_DEFS (widen the leg
   * swing in walk/run — do NOT just shrink the declared stride, that gives a 3.5 Hz shuffle).
   */
  driveAnimation(u, dt) {
    if (u.isVehicle) return;
    const s = this.speedSmoothed;
    const crouched = u.stance === STANCE.CROUCH;
    const prone = u.stance === STANCE.PRONE;
    const stance = prone ? 'prone'
      : crouched ? 'crouch'
        : this.mode === MODE.AIM ? 'aim' : 'stand';
    u.actor?.setLocomotion?.(s, { stance });

    // Footsteps at a cadence proportional to speed.
    if (s > 0.4) {
      this.footAccum += s * dt * (crouched ? 1.1 : 1.55);
      if (this.footAccum > 1) {
        this.footAccum -= 1;
        Bus.emit('sfx', { name: 'footstep', pos: u.pos, vol: clamp01(0.25 + s / 7) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Vault & ladders
  // -------------------------------------------------------------------------

  /** Look for a waist-high ledge ahead and hop it. Costs the AP of ~2 m of walking. */
  tryVault() {
    const u = this.unit;
    if (u.isVehicle || u.ap <= 0) return false;
    _fwd.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
    _v1.set(u.pos.x, u.pos.y + 0.55, u.pos.z);
    const h = traceWorld(_v1.x, _v1.y, _v1.z, _fwd.x, 0, _fwd.z, 1.35, this.world);
    if (!h) return false;
    // Is the top of that obstacle low enough to clear?
    const topProbeX = u.pos.x + _fwd.x * 1.55, topProbeZ = u.pos.z + _fwd.z * 1.55;
    const gy = this.nav ? this.nav.heightAt(topProbeX, topProbeZ) : u.pos.y;
    const clearance = traceWorld(topProbeX, u.pos.y + 2.4, topProbeZ, 0, -1, 0, 3.0, this.world);
    const landY = clearance ? clearance.y : gy;
    if (landY - u.pos.y > 1.45) return false;
    if (this.nav && !this.nav.walkableAt(topProbeX, topProbeZ) && landY - u.pos.y < 0.2) return false;

    this.vault = {
      t: 0, dur: 0.62,
      from: u.pos.clone(),
      to: new THREE.Vector3(topProbeX, landY, topProbeZ),
      apex: Math.max(u.pos.y, landY) + 0.75,
    };
    u.spendMove(2.0);
    u.actor?.play?.('vault', { once: true });
    Bus.emit('sfx', { name: 'vault', pos: u.pos });
    Bus.emit('action:vault', { unit: u });
    return true;
  }

  updateVault(dt) {
    const v = this.vault, u = this.unit;
    v.t += dt;
    const t = clamp01(v.t / v.dur);
    // Quadratic Bezier through the apex reads as a real hand-over-the-wall hop.
    const it = 1 - t;
    u.pos.x = it * it * v.from.x + 2 * it * t * ((v.from.x + v.to.x) * 0.5) + t * t * v.to.x;
    u.pos.z = it * it * v.from.z + 2 * it * t * ((v.from.z + v.to.z) * 0.5) + t * t * v.to.z;
    u.pos.y = it * it * v.from.y + 2 * it * t * v.apex + t * t * v.to.y;
    u.speed = v.from.distanceTo(v.to) / v.dur;
    if (t >= 1) { this.vault = null; this._lastClip = null; u.speed = 0; }
  }

  tryLadder() {
    const u = this.unit;
    const rails = this.world?.ladders;
    if (!rails || u.isVehicle) return false;
    let best = null, bestD = 2.0;
    for (let i = 0; i < rails.length; i++) {
      const r = rails[i];
      const d = Math.hypot(r.a.x - u.pos.x, r.a.z - u.pos.z);
      const dTop = Math.hypot(r.b.x - u.pos.x, r.b.z - u.pos.z);
      const near = Math.min(d, dTop);
      if (near < bestD) { bestD = near; best = r; }
    }
    if (!best) return false;
    const goingUp = Math.abs(u.pos.y - best.a.y) < Math.abs(u.pos.y - best.b.y);
    this.ladder = { rail: best, t: 0, dur: Math.abs(best.b.y - best.a.y) / 1.6, up: goingUp };
    u.actor?.play?.('climb');
    Bus.emit('sfx', { name: 'ladder', pos: u.pos });
    Bus.emit('action:ladder', { unit: u, up: goingUp });
    return true;
  }

  updateLadder(dt) {
    const L = this.ladder, u = this.unit;
    L.t += dt;
    const t = clamp01(L.t / Math.max(0.2, L.dur));
    const from = L.up ? L.rail.a : L.rail.b;
    const to = L.up ? L.rail.b : L.rail.a;
    u.pos.lerpVectors(from, to, t);
    u.speed = 1.6;
    u.spendMove(1.6 * dt * 1.4);       // climbing is expensive
    if (t >= 1 || u.ap <= 0) { this.ladder = null; this._lastClip = null; u.speed = 0; }
  }

  // -------------------------------------------------------------------------
  // Mode input: aim / grenade / interact / end
  // -------------------------------------------------------------------------

  updateModeInput(dt, gdt) {
    const u = this.unit;
    if (CFG.capture) {
      // Capture shots drive the mode directly; only solve the reticle when one asked for aim.
      if (this.mode === MODE.AIM) this.updateAimSolve(dt);
      else if (this.mode === MODE.GRENADE) this.updateGrenadeArc();
      return;
    }

    if (Input.pressed('enter') || Input.pressed('f')) { this.requestEnd(); return; }

    // Grenade toggle
    if (Input.pressed('g') && u.grenades > 0 && this.attacksLeft > 0) {
      this.mode = this.mode === MODE.GRENADE ? MODE.MOVE : MODE.GRENADE;
      this.aimHold = 0;
      this.aimToggled = false;   // else backing out of grenade mode snaps into aim
      Bus.emit('sfx', { name: this.mode === MODE.GRENADE ? 'aimIn' : 'aimOut' });
    }

    // Aim: hold RMB, or latch with Q. A trackpad only has one physical click, so
    // "hold right, click left" is unreachable there — Q gives it the same
    // toggle-then-click shape the grenade already uses.
    if (Input.pressed('q') && this.attacksLeft > 0 && u.ammo > 0 && this.mode !== MODE.GRENADE) {
      this.aimToggled = !this.aimToggled;
    }
    // Raising the weapon with nothing to fire used to be a silent nothing — no sound, no
    // message, no state change. Say which of the two it is.
    if ((Input.pressed('q') || Input.mouse.rightJust) && this.mode !== MODE.GRENADE
        && (this.attacksLeft <= 0 || u.ammo <= 0)) {
      this.denyAim(this.attacksLeft <= 0 ? AIM_STATUS.NO_ATTACKS : AIM_STATUS.NO_AMMO);
    }
    const wantAim = (Input.mouse.right || this.aimToggled)
      && this.attacksLeft > 0 && u.ammo > 0 && this.mode !== MODE.GRENADE;
    if (wantAim && this.mode !== MODE.AIM) this.enterAim();
    else if (!wantAim && this.mode === MODE.AIM) this.exitAim();

    if (this.mode === MODE.AIM) {
      this.updateAimSolve(dt);          // the settle clock lives in there now — see below
      if (Input.mouse.leftJust) this.fire();
    } else if (this.mode === MODE.GRENADE) {
      this.updateGrenadeArc();
      if (Input.mouse.leftJust) this.throwGrenade();
    } else {
      this.aimHold = 0;
      this.bloom = 1;
      this.aimStatus = AIM_STATUS.NO_TARGET;
      this.aimNearest = null;
      this.aimBlockedBy = null;
      this.aimOutOfRange = false;
      if (this.aimTarget) {
        this.aimTarget = null;
        Bus.emit('aim:target', { unit: u, target: null, status: AIM_STATUS.NO_TARGET, canFire: true });
      }
    }

    if (Input.pressed('e')) this.beginInteract();
    if (Input.pressed('r') && u.ammo < u.maxAmmo) {
      // Manual "check weapon" — no ammo gained, but it plays the reload and settles the sights.
      u.actor?.play?.('reload', { once: true });
      Bus.emit('sfx', { name: 'reload', pos: u.pos });
      this.aimHold = 0;
    }
    if (Input.pressed('x') && u.isVehicle && u.altAmmo) {
      u.usingAlt = !u.usingAlt;
      Bus.emit('weapon:switch', { unit: u, weapon: u.usingAlt ? u.altAmmo : u.weapon });
      Bus.emit('sfx', { name: 'uiSelect' });
    }
  }

  // -------------------------------------------------------------------------
  // Spotting, while the man is actually walking
  // -------------------------------------------------------------------------

  /**
   * MEASURED BUG THIS EXISTS FOR: `Battle.refreshFog()` runs at turn boundaries and at the end
   * of a sortie — never during one. So across the 30 m a soldier walks to contact, `spotted` is
   * whatever it was when he set off. Headless, real play: Rosie Stark walked 65.7 m -> 36.8 m
   * towards an Imperial Späher and the Späher stayed `spotted:false` for every sample, with
   * zero `enemy:spotted` events. No HUD marker, no world label, and the aim magnet's fog gate
   * vetoed the lock — on a man whose mesh was on screen the whole time, because
   * commandMode.exit() re-shows every unit it hid.
   *
   * This ADDS spots and never takes one away. Calling refreshFog from here would be worse than
   * the bug: it would hide the man you are walking towards mid-stride. Fog still closes at the
   * turn boundary, which is where a fog-of-war concept belongs.
   */
  sweepSpotting(dt) {
    if (CFG.capture) return;                  // capture frames own their own visibility
    this._spotT -= dt;
    if (this._spotT > 0) return;
    this._spotT = 0.25;                       // 4 Hz; 11 foes x one LOS trace is nothing
    const u = this.unit;
    if (!u || u.team !== 0) return;
    const units = this.battle.units;
    for (let i = 0; i < units.length; i++) {
      const o = units[i];
      if (o.team === u.team || o.spotted || !o.alive || !o.deployed) continue;
      if (canSee(u, o, this.world)) this.revealFoe(o);
    }
  }

  /** Flip one Imperial out of the fog, with the same bookkeeping Battle.refreshFog does. */
  revealFoe(o) {
    if (!o || o.spotted) return false;
    o.spotted = true;
    o.lastKnown?.copy(o.pos);
    o.lastKnownTurn = this.battle.turn;
    if (o.root) o.root.visible = true;
    Bus.emit('enemy:spotted', { unit: o });
    return true;
  }

  enterAim() {
    const u = this.unit;
    this.mode = MODE.AIM;
    this.aimHold = 0;
    this.timeScaleTarget = CFG.gameplay.aimSlowFactor;
    const scope = u.weapon.scope || 1;
    this.fovTarget = CFG.camera.fov / (u.isVehicle ? 1.55 : (scope > 1 ? scope : 1.9));
    this.armTarget = u.isVehicle ? 6.2 : 1.45;
    this.shoulderTarget = u.isVehicle ? 0 : 0.46;
    u.actor?.play?.('aim');
    Bus.emit('aim:enter', { unit: u, weapon: u.weapon, scope: u.weapon.scope || 0 });
    Bus.emit('sfx', { name: 'aimIn' });
  }

  exitAim() {
    const u = this.unit;
    this.mode = MODE.MOVE;
    this.timeScaleTarget = 1;
    this.fovTarget = CFG.camera.fov;
    this.armTarget = u && u.isVehicle ? 8.5 : 3.45;
    this.shoulderTarget = 0.62;
    this.aimTarget = null;
    this.aimToggled = false;
    this.aimFocusValid = false;
    this._lastClip = null;
    Bus.emit('aim:exit', { unit: u });
    Bus.emit('aim:target', { unit: u, target: null });
    Bus.emit('sfx', { name: 'aimOut' });
  }

  /**
   * Sweep a screen-space cone for the enemy nearest the crosshair. Returns him, or null.
   *
   * A third-person camera looks past the soldier's shoulder and the resting pitch points a
   * metre short of a man's boots, so a ray-only solve spends most of an engagement reporting
   * "dirt" while the player is plainly pointing at somebody. VC's aim mode locks on; so does
   * this. The rules that keep it honest rather than magic:
   *   * the RAY wins whenever it hits a unit — magnetism only fills a miss;
   *   * the cone is in PIXELS, so a scope narrows it in world terms exactly as much as it
   *     magnifies, and it is never smaller than the accuracy circle the HUD is drawing —
   *     anything inside that circle is already a plausible hit;
   *   * it never snaps onto a friendly (rounds pass through your own side since Round 21, so a
   *     mate in the way is a blocked lane to report, not a target to lock);
   *   * it needs a clear line from the MUZZLE, so it cannot promise a shot through a wall.
   *
   * THE FOG GATE IS GONE, and that was the whole defect. It required `o.spotted`, which
   * `Battle.refreshFog` only recomputes between sorties (see sweepSpotting), so a man standing
   * in the open 30 m down your own sights could not be aimed at. Spotting is a fog-of-war
   * concept for the tactical map; it has no business vetoing a shot the player is physically
   * taking. A clear muzzle line IS the player seeing him — so the lock also marks him spotted.
   *
   * @returns {{target: Unit|null, reject: Unit|null, why: string, distance: number}}
   *   `reject` is the nearest-to-crosshair man the shot CANNOT be taken against, with `why`
   *   saying which of the two reasons it was, so the HUD can print it.
   */
  magnetScan(camPos, dir, weapon, radiusPx) {
    const out = this._magOut || (this._magOut = { target: null, reject: null, why: '', distance: 0 });
    out.target = null; out.reject = null; out.why = ''; out.distance = 0;
    const u = this.unit;
    if (!u) return out;
    const h = typeof innerHeight === 'number' ? innerHeight : 1080;
    const focal = (h * 0.5) / Math.tan((this.camera.fov * Math.PI) / 360);
    const cone = Math.min(0.16, Math.atan2(Math.max(radiusPx || 0, h * MAGNET_SCREEN_FRAC), focal));
    const tanCone = Math.tan(cone);
    const tanCap = Math.tan(MAGNET_MAX_RAD);
    const units = this.battle.units;
    // Score is the miss measured in FRACTIONS OF THE ENVELOPE (0 = dead centre, 1 = the edge),
    // not a dot product, because the envelope is no longer the same width at every range.
    let bestScore = 1, bestD = 0;
    let rejScore = 1, rejD = 0;
    u.muzzlePoint(_muzzle);
    for (let i = 0; i < units.length; i++) {
      const o = units[i];
      if (o === u || !o.alive || !o.deployed || o.downed) continue;
      if (o.team === u.team) continue;
      o.centerPoint(_v1);
      _v2.subVectors(_v1, camPos);
      const d = _v2.length();
      if (d < 0.6 || d > weapon.maxRange * NAME_RANGE_MUL) continue;
      const along = _v2.dot(dir);
      if (along <= 0.3) continue;                 // behind the lens
      // Perpendicular miss from the crosshair ray to his chest, in metres, against an envelope
      // that is the screen-space cone OR the near-field floor, whichever is more generous —
      // capped so it never opens wider than MAGNET_MAX_RAD off the crosshair.
      const perp = Math.sqrt(Math.max(0, d * d - along * along));
      const allow = Math.min(Math.max(along * tanCone, NEAR_FORGIVE_M), along * tanCap);
      if (perp >= allow) continue;                // not being pointed at
      const score = perp / allow;
      // RANGE is measured from the muzzle, because that is the distance combat.hitProbability
      // scores and it is up to 3.45 m shorter over the shoulder. Mixing the two gave a band
      // around maxRange where the magnet promised a lock and the forecast scored it 0.
      const dm = _muzzle.distanceTo(_v1);
      const inRange = dm <= weapon.maxRange;
      if (inRange && score >= bestScore) continue;   // a better lock already found
      if (!inRange && score >= rejScore && out.reject) continue;
      // Chest OR head: a man behind a sandbag with his shoulders over the top is a shot, and
      // fireBurst agrees — measured, a chest-only probe reported 'noLineOfSight' on two shots
      // that then did 67 and 40 damage. Probing one point made the readout pessimistic and the
      // player distrust it.
      let los = hasLOS(_muzzle.x, _muzzle.y, _muzzle.z, _v1.x, _v1.y, _v1.z, this.world);
      if (!los) {
        o.headPoint(_v3);
        los = hasLOS(_muzzle.x, _muzzle.y, _muzzle.z, _v3.x, _v3.y, _v3.z, this.world);
      }
      if (!los) {
        // Last word goes to the round itself: if the first thing a bullet leaving this muzzle
        // would hit IS him, there is a shot, whatever the sight-line heuristic thinks of the
        // bush in between. hasLOS calls anything over 0.35 cover "blocked", which is how the
        // HUD came to print 'noLineOfSight' over a shot that then did 57 damage.
        _v3.subVectors(_v1, _muzzle).normalize();
        const sh = traceScene(_muzzle, _v3, dm + 0.6,
          { ignore: u, units: this.battle.units, world: this.world });
        los = !!sh && sh.kind === 'unit' && sh.unit === o;
      }
      if (inRange && los) { bestScore = score; bestD = dm; out.target = o; continue; }
      // Not a shot — but it is the answer to "why did nothing happen?".
      // Out of range beats no-line-of-sight: it is the one the player can act on.
      const why = !los ? AIM_STATUS.NO_LOS : AIM_STATUS.OUT_OF_RANGE;
      const better = !out.reject
        || (why === AIM_STATUS.OUT_OF_RANGE && out.why === AIM_STATUS.NO_LOS)
        || (why === out.why && score < rejScore);
      if (better) { rejScore = score; rejD = dm; out.reject = o; out.why = why; }
    }
    out.distance = out.target ? bestD : rejD;
    return out;
  }

  /** Trace the reticle, size the accuracy circle, publish the hit-% readout. */
  updateAimSolve(dt) {
    const u = this.unit;
    const w = u.usingAlt && u.altAmmo ? u.altAmmo : u.weapon;

    // The settle clock lives HERE, not in the input path. Every route into the aim solve —
    // mouse, the Q latch, capture shots, a headless harness posing the mode directly — has
    // to converge the reticle, and while this lived in updateModeInput the capture/scripted
    // path returned before it and the circle never moved: holding aim bought the player
    // nothing at all.
    this.aimHold = clamp(this.aimHold + (this.speedSmoothed > 0.2 ? -dt * 1.6 : dt), 0, w.settle * 2.2);
    this.bloom = bloomFor(w, this.aimHold, clamp01(this.speedSmoothed / 3));

    this.camera.getWorldDirection(_dir);
    _camPos.copy(this.camera.position);
    const hit = traceScene(_camPos, _dir, w.maxRange * 1.6, { ignore: u, units: this.battle.units, world: this.world });
    if (hit) _aimPoint.copy(hit.point);
    else _aimPoint.copy(_camPos).addScaledVector(_dir, w.maxRange);

    const prev = this.aimTarget;
    // A squadmate under the crosshair is NOT a target: since Round 21 rounds pass straight
    // through your own side, so locking him showed "99% Hit" on a shot that could only ever
    // do nothing. Measured in ten played attempts: 2 of them latched a mate and burned the
    // sortie's one attack for 0 damage. Report him as a blocked lane and look past him.
    const rayUnit = hit && hit.kind === 'unit' ? hit.unit : null;
    const rayFoe = rayUnit && rayUnit.team !== u.team ? rayUnit : null;
    this.aimBlockedBy = rayUnit && rayUnit.team === u.team ? rayUnit : null;
    this.aimTarget = rayFoe;
    this.aimPart = rayFoe ? hit.partLabel : null;
    this._magnet = rayFoe ? 'ray' : 'none';
    this.aimNearest = null;
    this.aimStatus = AIM_STATUS.NO_TARGET;
    if (!this.aimTarget) {
      const scan = this.magnetScan(_camPos, _dir, w, this.reticleRadiusPx);
      if (scan.target) {
        this.aimTarget = scan.target;
        this.aimPart = 'body';
        this._magnet = 'magnet';
        // The round has to go where the lock says it goes, or the readout is a lie: fire()
        // converges the muzzle onto _aimPoint.
        scan.target.centerPoint(_aimPoint);
      } else if (scan.reject) {
        // Name him and say what is wrong. A man out of reach with a clear line is one the
        // player is plainly looking at, so he comes out of the fog too; a man behind a wall
        // stays hidden unless he was already spotted.
        const nameHim = scan.why === AIM_STATUS.OUT_OF_RANGE || scan.reject.spotted;
        if (scan.why === AIM_STATUS.OUT_OF_RANGE) this.revealFoe(scan.reject);
        this.aimStatus = scan.why;
        this.aimNearest = {
          unit: scan.reject, name: scan.reject.name, distance: scan.distance,
          maxRange: w.maxRange, needCloser: Math.max(0, scan.distance - w.maxRange),
        };
        if (nameHim) { this.aimTarget = scan.reject; this.aimPart = 'body'; this._magnet = scan.why; }
      }
    }

    if (this.aimTarget) {
      u.muzzlePoint(_muzzle);
      const acc = effectiveAccuracy(u, w, {
        aimed: true, range: _muzzle.distanceTo(this.aimTarget.pos),
        cover: coverFor(this.aimTarget, _muzzle.x, _muzzle.y, _muzzle.z, this.world),
        target: this.aimTarget, battle: this.battle,
      });
      this.forecast = attackForecast(u, this.aimTarget, {
        weapon: w, aimed: true, bloom: this.bloom, battle: this.battle, world: this.world,
      });
      this._sigma = shotSigma(u, w, acc, this.bloom, this.speedSmoothed);
      // A man the reticle names is out of the fog: the player is looking down his sights at him.
      if (this.aimStatus === AIM_STATUS.NO_TARGET) {
        this.aimStatus = this.forecast.range > w.maxRange ? AIM_STATUS.OUT_OF_RANGE
          : this.forecast.blocked ? AIM_STATUS.NO_LOS : AIM_STATUS.LOCKED;
        if (this.aimStatus !== AIM_STATUS.NO_LOS) this.revealFoe(this.aimTarget);
      }
      if (this.aimStatus === AIM_STATUS.OUT_OF_RANGE && !this.aimNearest) {
        this.aimNearest = {
          unit: this.aimTarget, name: this.aimTarget.name, distance: this.forecast.range,
          maxRange: w.maxRange, needCloser: Math.max(0, this.forecast.range - w.maxRange),
        };
      }
      // A squadmate in the lane is worth saying even when the lock itself is good.
      if (!this.aimBlockedBy) {
        this.aimBlockedBy = friendlyInLine(u, _muzzle, _aimPoint, this.battle.units) || null;
      }
    } else {
      this.forecast = null;
      const acc = effectiveAccuracy(u, w, { aimed: true, range: 25, cover: 0, target: null, battle: this.battle });
      this._sigma = shotSigma(u, w, acc, this.bloom, this.speedSmoothed);
    }
    // Refusing the trigger is only ever about reach: a 0% shot spends the sortie's one attack
    // for nothing, and the player was never told he was short. Blocked line, cover, a bad
    // angle — those stay the player's call, with an honest number on them.
    this.aimOutOfRange = this.aimStatus === AIM_STATUS.OUT_OF_RANGE;

    // Angular sigma -> pixels: r = tan(sigma) * focalPx, focalPx = (h/2)/tan(fov/2).
    // Clamped at both ends because the circle is a PROMISE the player aims with: a quarter
    // of the screen is not a reticle, and a hairline cannot be read.
    const h = typeof innerHeight === 'number' ? innerHeight : 1080;
    const focal = (h * 0.5) / Math.tan((this.camera.fov * Math.PI) / 360);
    this.reticleRadiusPx = clamp(Math.tan(this._sigma * 2.146) * focal, 7, h * 0.155);

    // What the camera should converge on. A LOCKED man beats the traced surface: converging on
    // him is what puts the crosshair on the aim line at his range and kills the parallax that
    // made close shots impossible. Otherwise use whatever the reticle is resting on.
    if (this.aimTarget) this.aimTarget.centerPoint(this.aimFocus);
    else this.aimFocus.copy(_aimPoint);
    this.aimFocusIsMan = !!this.aimTarget;
    this.aimFocusValid = true;

    if (prev !== this.aimTarget || this._pubTimer === undefined || (this._pubTimer -= dt) <= 0) {
      this._pubTimer = 0.06;
      Bus.emit('aim:target', {
        unit: u, target: this.aimTarget, part: this.aimPart,
        chance: this.forecast ? this.forecast.chance : 0,
        expectedDamage: this.forecast ? this.forecast.expectedDamage : 0,
        lethal: this.forecast ? this.forecast.lethal : false,
        distance: this.forecast ? this.forecast.range : _aimPoint.distanceTo(_camPos),
        reticlePx: this.reticleRadiusPx, bloom: this.bloom,
        point: _aimPoint,
        // --- why nothing is happening. See AIM_STATUS. ------------------------
        status: this.aimStatus,             // 'locked' | 'outOfRange' | 'noLineOfSight' | 'noTarget'
        canFire: !this.aimOutOfRange,       // false => the trigger will be refused
        nearest: this.aimNearest,           // { unit, name, distance, maxRange, needCloser }
        blockedBy: this.aimBlockedBy,       // a squadmate in the lane, or null
      });
      if (this.aimTarget && prev !== this.aimTarget && this.aimStatus === AIM_STATUS.LOCKED) {
        Bus.emit('sfx', { name: 'targetLock' });
      }
    }
  }

  /**
   * Tell the player why the weapon did not go up, or did not go off. `aim:denied` carries
   * `reason` (an AIM_STATUS) plus whatever numbers make it actionable.
   */
  denyAim(reason, extra = null, dropAim = true) {
    // Out-of-range keeps the sights up on purpose: the readout that says how much closer he
    // needs to be is only on screen while the weapon is up.
    if (dropAim) this.aimToggled = false;
    Bus.emit('aim:denied', Object.assign({ unit: this.unit, reason }, extra || {}));
    Bus.emit('sfx', { name: 'uiDeny' });
  }

  /** The one attack. */
  fire() {
    const u = this.unit;
    if (this.attacksLeft <= 0 || u.ammo <= 0) {
      Bus.emit('sfx', { name: 'dryFire' });
      this.denyAim(this.attacksLeft <= 0 ? AIM_STATUS.NO_ATTACKS : AIM_STATUS.NO_AMMO);
      return;
    }
    // A shot at a man past the weapon's reach is a 0% shot (combat.hitProbability zeroes it),
    // and it spends the sortie's ONE attack. Refuse it and say how much closer he needs to be.
    // Measured: a shocktrooper's SMG reaches 30 m and the mission's engagements open at 37 m,
    // so this is the difference between "the game is broken" and "I have to close".
    if (this.aimOutOfRange && this.aimNearest) {
      this.denyAim(AIM_STATUS.OUT_OF_RANGE, {
        target: this.aimNearest.unit, distance: this.aimNearest.distance,
        maxRange: this.aimNearest.maxRange, needCloser: this.aimNearest.needCloser,
      }, false);
      return;
    }
    const w = u.usingAlt && u.altAmmo ? u.altAmmo : u.weapon;
    u.muzzlePoint(_muzzle);
    // Converge the muzzle onto the point the reticle is over, not the camera axis — otherwise
    // the shoulder offset makes close-range shots miss to the side.
    _dir.subVectors(_aimPoint, _muzzle);
    if (_dir.lengthSq() < 1e-6) this.camera.getWorldDirection(_dir);
    _dir.normalize();

    const summary = fireBurst(u, _muzzle, _dir, {
      weapon: w, rng: this.rng, aimed: true, sigma: this._sigma,
      units: this.battle.units, world: this.world, battle: this.battle,
      target: this.aimTarget,
    });

    u.ammo = Math.max(0, u.ammo - 1);
    this.attacksLeft--;
    if (this.attacksLeft <= 0) u.attackUsed = true;
    u.actor?.play?.('fire', { once: true });

    this.recoilKick += w.recoil * 40;
    this.camPitch = clamp(this.camPitch + w.recoil * 9, this.pitchMin, this.pitchMax);
    this.shake = Math.min(1.4, this.shake + (w.kind === 'cannon' ? 1.1 : 0.35));
    this.aimHold = 0;
    this.postFire = 0.85;

    this.battle.interception?.alertTo(u);
    Bus.emit('attack:resolved', {
      unit: u, target: summary.target, hits: summary.hits, shots: w.shots || 1,
      damage: summary.damage, kills: summary.kills, crits: summary.crits,
      attacksLeft: this.attacksLeft, weapon: w,
    });
    if (w.backblast) Bus.emit('explosion', { pos: _muzzle.clone().addScaledVector(_dir, -1.1), radius: 1.4, power: 0 });

    if (this.attacksLeft <= 0) {
      // VC: after your attack you may keep walking on leftover AP, but you cannot shoot again.
      this.exitAim();
      if (u.ap <= 0) this.postFire = 1.25;
    }
  }

  // -------------------------------------------------------------------------
  // Grenades
  // -------------------------------------------------------------------------

  updateGrenadeArc() {
    const u = this.unit;
    this.camera.getWorldDirection(_dir);
    _camPos.copy(this.camera.position);
    const hit = traceScene(_camPos, _dir, 60, { ignore: u, units: this.battle.units, world: this.world });
    if (hit) _aimPoint.copy(hit.point);
    else _aimPoint.copy(_camPos).addScaledVector(_dir, 32);
    u.muzzlePoint(_muzzle);
    _muzzle.y += 0.25;
    const vel = solveArc(_muzzle, _aimPoint, this.throwPower);
    this.arcCount = predictArc(_muzzle, vel, this.arcPoints, 56, 0.055, this.world);
    Bus.emit('grenade:preview', {
      unit: u, points: this.arcPoints, count: this.arcCount,
      impact: this.arcCount > 0 ? this.arcPoints[this.arcCount - 1] : _aimPoint,
      radius: GRENADE.splash,
    });
  }

  throwGrenade() {
    const u = this.unit;
    if (u.grenades <= 0 || this.attacksLeft <= 0) { Bus.emit('sfx', { name: 'dryFire' }); return; }
    u.muzzlePoint(_muzzle);
    _muzzle.y += 0.25;
    const vel = solveArc(_muzzle, _aimPoint, this.throwPower);
    this.spawnGrenade(u, _muzzle, vel);
    u.grenades--;
    this.attacksLeft--;
    if (this.attacksLeft <= 0) u.attackUsed = true;
    this.mode = MODE.MOVE;
    this.postFire = 0.5;
    u.actor?.play?.('throw', { once: true });
    Bus.emit('sfx', { name: GRENADE.sfx, pos: u.pos });
    this.battle.interception?.alertTo(u);
  }

  spawnGrenade(owner, pos, vel) {
    const g = {
      owner, pos: pos.clone(), vel: vel.clone(), fuse: GRENADE.fuse,
      rest: 0, mesh: null, alive: true,
    };
    if (this.scene) {
      g.mesh = this.visualFactory('grenade');
      if (g.mesh) { g.mesh.position.copy(g.pos); this.scene.add(g.mesh); }
    }
    this.grenades.push(g);
    Bus.emit('grenade:spawn', { grenade: g, unit: owner });
    return g;
  }

  updateGrenades(dt) {
    if (!this.grenades.length) return;
    const G = 9.81;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      // Integrate + collide against the ground with restitution and friction.
      _v1.copy(g.pos);
      g.vel.y -= G * dt;
      _v2.copy(g.vel).multiplyScalar(dt);
      const seg = _v2.length();
      if (seg > 1e-5) {
        _v3.copy(_v2).multiplyScalar(1 / seg);
        const h = traceWorld(_v1.x, _v1.y, _v1.z, _v3.x, _v3.y, _v3.z, seg, this.world);
        if (h) {
          g.pos.set(h.x + h.nx * 0.06, h.y + h.ny * 0.06, h.z + h.nz * 0.06);
          const dot = g.vel.x * h.nx + g.vel.y * h.ny + g.vel.z * h.nz;
          g.vel.x -= 2 * dot * h.nx; g.vel.y -= 2 * dot * h.ny; g.vel.z -= 2 * dot * h.nz;
          g.vel.multiplyScalar(0.34);
          if (g.vel.lengthSq() < 0.6) { g.vel.set(0, 0, 0); g.rest += dt; }
          Bus.emit('sfx', { name: 'grenadeBounce', pos: g.pos, vol: 0.45 });
        } else {
          g.pos.add(_v2);
        }
      }
      if (g.mesh) {
        g.mesh.position.copy(g.pos);
        g.mesh.rotation.x += dt * 9; g.mesh.rotation.z += dt * 6;
      }
      if (g.fuse <= 0) {
        explode(g.pos, GRENADE.splash, GRENADE.splashPower, {
          source: g.owner, aaPower: GRENADE.aaSplashPower,
          units: this.battle.units, world: this.world, battle: this.battle,
        });
        if (g.mesh) { this.scene?.remove(g.mesh); g.mesh.geometry?.dispose?.(); g.mesh.material?.dispose?.(); }
        this.grenades.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Contextual interactions
  // -------------------------------------------------------------------------

  /** Scan for the best thing within reach; called every frame so the HUD can prompt. */
  scanInteract() {
    const u = this.unit;
    if (!u) return null;
    let best = null, bestD = 3.4;
    const units = this.battle.units;
    for (let i = 0; i < units.length; i++) {
      const o = units[i];
      if (o === u || !o.alive || !o.deployed) continue;
      const d = o.pos.distanceTo(u.pos);
      if (d > bestD) continue;
      if (o.downed && o.team === u.team && u.classDef.canRescue) {
        best = { kind: 'rescue', unit: o, label: `Rescue ${o.name}`, duration: 1.4, d }; bestD = d;
      } else if (o.downed && o.team !== u.team) {
        best = { kind: 'captureBody', unit: o, label: `Capture ${o.name}`, duration: 1.0, d }; bestD = d;
      } else if (o.team === u.team && o.isVehicle && o.hp < o.maxHp && u.classDef.canRepair && d < 4.2) {
        best = { kind: 'repair', unit: o, label: `Repair ${o.name}`, duration: 2.4, d }; bestD = d;
      } else if (o.team === u.team && u.classDef.canResupply && (o.ammo < o.maxAmmo || o.grenades < o.maxGrenades)) {
        best = { kind: 'resupply', unit: o, label: `Resupply ${o.name}`, duration: 1.2, d }; bestD = d;
      }
    }
    // Sandbag / barricade repair
    if (!best && u.classDef.canRepair && this.world?.colliders) {
      for (let i = 0; i < this.world.colliders.length; i++) {
        const c = this.world.colliders[i];
        if (!c.destroyed) continue;
        const cp = c.center || c.pos || c.position;
        if (!cp) continue;
        const d = Math.hypot(cp.x - u.pos.x, cp.z - u.pos.z);
        if (d < 2.6) { best = { kind: 'rebuild', collider: c, label: 'Rebuild cover', duration: 2.0, d }; break; }
      }
    }
    // Base camp
    if (!best) {
      const camp = this.battle.campAt(u.pos);
      if (camp && camp.owner !== u.team && u.classDef.canCapture) {
        best = { kind: 'capture', camp, label: `Capture ${camp.name}`, duration: 0, d: 0 };
      }
    }
    return best;
  }

  beginInteract() {
    const t = this.scanInteract();
    if (!t) { Bus.emit('sfx', { name: 'uiDeny' }); return; }
    this.interactTarget = t;
    this.interactProgress = 0;
    Bus.emit('interact:begin', { unit: this.unit, target: t });
  }

  updateInteraction(dt) {
    const u = this.unit;
    const hint = this.scanInteract();
    if ((hint?.kind || null) !== (this.hint?.kind || null) || hint?.unit !== this.hint?.unit) {
      this.hint = hint;
      Bus.emit('interact:hint', { unit: u, hint });
    }
    if (!this.interactTarget) return;
    const t = this.interactTarget;
    if (!CFG.capture && !Input.down('e')) {
      this.interactTarget = null;
      Bus.emit('interact:cancel', { unit: u });
      return;
    }
    const speed = t.kind === 'rescue' && u.hasPotential('fieldMedic') ? 2.2 : 1;
    this.interactProgress += (dt / Math.max(0.1, t.duration)) * speed;
    Bus.emit('interact:progress', { unit: u, target: t, progress: clamp01(this.interactProgress) });
    if (this.interactProgress < 1) return;

    switch (t.kind) {
      case 'rescue': t.unit.rescue(u); break;
      case 'captureBody': t.unit.capture(u); break;
      case 'repair': t.unit.repair(t.unit.maxHp * 0.28); u.spendMove(4); break;
      case 'resupply': t.unit.resupply(); u.spendMove(3); break;
      case 'rebuild':
        t.collider.destroyed = false;
        this.nav?.rebuildArea(t.collider.center?.x || 0, t.collider.center?.z || 0, 4);
        Bus.emit('cover:rebuilt', { collider: t.collider });
        u.spendMove(4);
        break;
      case 'capture': this.battle.captureCamp(t.camp, u); break;
      default: break;
    }
    Bus.emit('interact:done', { unit: u, target: t });
    this.interactTarget = null;
    this.interactProgress = 0;
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  updateCamera(dt) {
    const u = this.unit;
    const cam = this.camera;

    this.armLength = damp(this.armLength, this.armTarget, 8, dt);
    this.shoulder = damp(this.shoulder, this.shoulderTarget, 8, dt);
    this.fov = damp(this.fov, this.fovTarget, 7, dt);
    this.shake = Math.max(0, this.shake - dt * 3.1);

    const stanceLift = u.isVehicle ? 2.15 : lerp(1.52, 0.92, 1 - u.stanceScale);
    _pivot.set(u.pos.x, u.pos.y + stanceLift, u.pos.z);

    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    _fwd.set(Math.sin(this.camYaw) * cp, sp, Math.cos(this.camYaw) * cp);
    _rgt.set(_fwd.z, 0, -_fwd.x).normalize();

    _camWant.copy(_pivot)
      .addScaledVector(_fwd, -this.armLength)
      .addScaledVector(_rgt, this.shoulder)
      .add(_v0.set(0, this.armLength * 0.06, 0));

    // --- collision avoidance: sweep the pivot->camera segment ---------------
    // A single centre ray is not a camera. It slips past the corner of a slab and parks the
    // lens INSIDE the bridge abutment (measured: 60% of one aim frame was flat cream masonry
    // with the tank invisible underneath it), and when it does pull in it pulls in to 0.45 m
    // of the soldier's own eye line, which is the frame that came back 40% green helmet.
    // So: cast four offset rays as well as the centre one, then check from the OUTSIDE in for
    // the tunnelling case, then hold the lens off the man's own head.
    _v1.subVectors(_camWant, _pivot);
    const want = _v1.length();
    if (want > 1e-4) {
      _v1.multiplyScalar(1 / want);
      let safe = want;
      _up.crossVectors(_rgt, _v1);
      if (_up.lengthSq() < 1e-6) _up.set(0, 1, 0); else _up.normalize();
      for (let i = 0; i < 5; i++) {
        // centre, then +/- right, then +/- up: a poor man's sphere cast, four extra traces.
        const sx = i === 1 ? CAM_RADIUS : i === 2 ? -CAM_RADIUS : 0;
        const sy = i === 3 ? CAM_RADIUS : i === 4 ? -CAM_RADIUS : 0;
        _off.copy(_pivot).addScaledVector(_rgt, sx).addScaledVector(_up, sy);
        const h = traceWorld(_off.x, _off.y, _off.z, _v1.x, _v1.y, _v1.z, safe + CAM_PAD, this.world);
        if (h) safe = Math.min(safe, h.t - CAM_PAD);
      }
      // Tunnelling: the outward cast can pass over a low wall and land the lens inside the far
      // side of it. Look back down the arm — anything hit on the way home is a surface the
      // camera is behind, so come in to just this side of it.
      if (safe > 0.5) {
        _off.copy(_pivot).addScaledVector(_v1, safe);
        const back = traceWorld(_off.x, _off.y, _off.z, -_v1.x, -_v1.y, -_v1.z, safe - 0.2, this.world);
        if (back) safe = Math.min(safe, safe - back.t - CAM_PAD);
      }
      _camWant.copy(_pivot).addScaledVector(_v1, Math.max(0.2, safe));
    }
    // The lens must clear the subject's own head. When the wall behind squeezes it in, go OVER
    // the helmet rather than through it — climbing is nearly always free, and the aim line
    // still passes through the target because the camera now converges on him.
    u.headPoint(_head);
    _off.subVectors(_camWant, _head);
    const dHead = _off.length();
    const clear = u.isVehicle ? 1.2 : HEAD_CLEAR;
    if (dHead < clear) {
      if (dHead < 1e-3) _off.copy(_fwd).multiplyScalar(-1);
      _off.y += 0.55;                                   // bias the escape upward
      _off.normalize();
      const hb = traceWorld(_head.x, _head.y, _head.z, _off.x, _off.y, _off.z, clear + CAM_PAD, this.world);
      _camWant.copy(_head).addScaledVector(_off, hb ? Math.max(0.2, hb.t - 0.12) : clear);
    }
    // Never dip below the terrain.
    if (this.nav) {
      const gy = this.nav.heightAt(_camWant.x, _camWant.z) + 0.4;
      if (_camWant.y < gy) _camWant.y = gy;
    }

    const lag = this.mode === MODE.AIM ? 22 : 12;
    cam.position.lerp(_camWant, 1 - Math.exp(-lag * dt));

    // --- where the camera axis crosses the aim line -------------------------
    // Free-look converges far away, which is what gives a third-person camera its shoulder
    // offset. AIM converges on what the reticle is over, so the crosshair sits ON the soldier's
    // aim line at the target's own range instead of only at 40 m. Without this a man three
    // metres away renders 0.43 m — 137 px, a body's width — to the shoulder side of the
    // crosshair, which is the whole reason close-range locks failed.
    const wantConv = this.mode === MODE.AIM && this.aimFocusValid
      ? clamp(_pivot.distanceTo(this.aimFocus),
        this.aimFocusIsMan ? CONVERGE_MIN : CONVERGE_IDLE, CONVERGE_FAR)
      : CONVERGE_FAR;
    this.convergeDist = damp(this.convergeDist, wantConv, 12, dt);

    // Look target sits ahead of the soldier so the reticle is on the world, not the head.
    _v2.copy(_pivot).addScaledVector(_fwd, this.convergeDist)
      .addScaledVector(_rgt, this.mode === MODE.AIM ? 0 : this.shoulder * 0.35);
    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 0.10;
      _v2.x += (this.rng() - 0.5) * s;
      _v2.y += (this.rng() - 0.5) * s;
      _v2.z += (this.rng() - 0.5) * s;
    }
    this.camLook.lerp(_v2, 1 - Math.exp(-24 * dt));
    cam.lookAt(this.camLook);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  // -------------------------------------------------------------------------

  dispose() {
    for (const g of this.grenades) {
      if (g.mesh) { this.scene?.remove(g.mesh); g.mesh.geometry?.dispose?.(); g.mesh.material?.dispose?.(); }
    }
    this.grenades.length = 0;
    this.exit();
  }
}

/**
 * Fallback visual for thrown ordnance. The integrator can replace ActionMode#visualFactory
 * with one that returns meshes built from src/render/materials.js so the grenade takes the
 * NPR outline like everything else.
 */
let _grenGeo = null;
function defaultVisualFactory(kind) {
  if (kind !== 'grenade') return null;
  if (!_grenGeo) _grenGeo = new THREE.IcosahedronGeometry(0.055, 1);
  const mat = new THREE.MeshLambertMaterial({ color: 0x4b4a3c });
  const m = new THREE.Mesh(_grenGeo, mat);
  m.castShadow = true;
  m.userData.outline = true;
  return m;
}

export { MODE as ACTION_MODE_STATE };
export default ActionMode;
