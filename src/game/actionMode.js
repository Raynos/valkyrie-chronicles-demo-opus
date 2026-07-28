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
  GRENADE, attackForecast, bloomFor, coverFor, effectiveAccuracy, explode, fireBurst,
  predictArc, shotSigma, solveArc, traceScene, traceWorld,
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
const _arcOut = [];

const MODE = { MOVE: 0, AIM: 1, GRENADE: 2, INTERACT: 3, FIRING: 4, DONE: 5 };

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
    this.bloom = 1;
    this.aimTarget = null;            // Unit under the reticle
    this.aimPart = null;
    this.forecast = null;
    this.timeScale = 1;
    this.timeScaleTarget = 1;
    this.reticleRadiusPx = 0;
    this.attacksLeft = 1;
    this.postFire = 0;                // cinematic hold after the shot

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
    this.bloom = 1;
    this.postFire = 0;
    this.interactProgress = 0;
    this.timeScale = this.timeScaleTarget = 1;
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

  driveAnimation(u, dt) {
    if (u.isVehicle) return;
    const s = this.speedSmoothed;
    const crouched = u.stance === STANCE.CROUCH;
    const prone = u.stance === STANCE.PRONE;
    let clip;
    if (prone) clip = 'prone';
    else if (this.mode === MODE.AIM) clip = 'aim';
    else if (s < 0.25) clip = crouched ? 'crouchIdle' : 'idle';
    else if (crouched) clip = 'crouchWalk';
    else clip = s > u.classDef.speed.walk * 1.12 ? 'run' : 'walk';
    if (clip !== this._lastClip) { u.actor?.play?.(clip); this._lastClip = clip; }

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
    if (CFG.capture) { this.updateAimSolve(dt); return; }

    if (Input.pressed('enter') || Input.pressed('f')) { this.requestEnd(); return; }

    // Grenade toggle
    if (Input.pressed('g') && u.grenades > 0 && this.attacksLeft > 0) {
      this.mode = this.mode === MODE.GRENADE ? MODE.MOVE : MODE.GRENADE;
      this.aimHold = 0;
      Bus.emit('sfx', { name: this.mode === MODE.GRENADE ? 'aimIn' : 'aimOut' });
    }

    // Aim toggle (hold RMB)
    const wantAim = Input.mouse.right && this.attacksLeft > 0 && u.ammo > 0 && this.mode !== MODE.GRENADE;
    if (wantAim && this.mode !== MODE.AIM) this.enterAim();
    else if (!wantAim && this.mode === MODE.AIM) this.exitAim();

    if (this.mode === MODE.AIM) {
      this.aimHold += this.speedSmoothed > 0.2 ? -dt * 1.6 : dt;
      this.aimHold = clamp(this.aimHold, 0, u.weapon.settle * 1.4);
      this.updateAimSolve(dt);
      if (Input.mouse.leftJust) this.fire();
    } else if (this.mode === MODE.GRENADE) {
      this.updateGrenadeArc();
      if (Input.mouse.leftJust) this.throwGrenade();
    } else {
      this.aimHold = 0;
      this.bloom = 1;
      if (this.aimTarget) { this.aimTarget = null; Bus.emit('aim:target', { unit: u, target: null }); }
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
    this._lastClip = null;
    Bus.emit('aim:exit', { unit: u });
    Bus.emit('aim:target', { unit: u, target: null });
    Bus.emit('sfx', { name: 'aimOut' });
  }

  /** Trace the reticle, size the accuracy circle, publish the hit-% readout. */
  updateAimSolve(dt) {
    const u = this.unit;
    const w = u.usingAlt && u.altAmmo ? u.altAmmo : u.weapon;
    this.bloom = bloomFor(w, this.aimHold, clamp01(this.speedSmoothed / 3));

    this.camera.getWorldDirection(_dir);
    _camPos.copy(this.camera.position);
    const hit = traceScene(_camPos, _dir, w.maxRange * 1.6, { ignore: u, units: this.battle.units, world: this.world });
    if (hit) _aimPoint.copy(hit.point);
    else _aimPoint.copy(_camPos).addScaledVector(_dir, w.maxRange);

    const prev = this.aimTarget;
    this.aimTarget = hit && hit.kind === 'unit' ? hit.unit : null;
    this.aimPart = hit && hit.kind === 'unit' ? hit.partLabel : null;

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
    } else {
      this.forecast = null;
      const acc = effectiveAccuracy(u, w, { aimed: true, range: 25, cover: 0, target: null, battle: this.battle });
      this._sigma = shotSigma(u, w, acc, this.bloom, this.speedSmoothed);
    }

    // Angular sigma -> pixels: r = tan(sigma) * focalPx, focalPx = (h/2)/tan(fov/2)
    const h = typeof innerHeight === 'number' ? innerHeight : 1080;
    const focal = (h * 0.5) / Math.tan((this.camera.fov * Math.PI) / 360);
    this.reticleRadiusPx = Math.tan(this._sigma * 2.146) * focal;   // 2.146 sigma = 90% circle

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
      });
      if (this.aimTarget && prev !== this.aimTarget) Bus.emit('sfx', { name: 'targetLock' });
    }
  }

  /** The one attack. */
  fire() {
    const u = this.unit;
    if (this.attacksLeft <= 0 || u.ammo <= 0) {
      Bus.emit('sfx', { name: 'dryFire' });
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
    _v1.subVectors(_camWant, _pivot);
    const want = _v1.length();
    if (want > 1e-4) {
      _v1.multiplyScalar(1 / want);
      const h = traceWorld(_pivot.x, _pivot.y, _pivot.z, _v1.x, _v1.y, _v1.z, want + 0.35, this.world);
      if (h) {
        const safe = Math.max(0.45, h.t - 0.32);
        _camWant.copy(_pivot).addScaledVector(_v1, safe);
      }
    }
    // Never dip below the terrain.
    if (this.nav) {
      const gy = this.nav.heightAt(_camWant.x, _camWant.z) + 0.4;
      if (_camWant.y < gy) _camWant.y = gy;
    }

    const lag = this.mode === MODE.AIM ? 22 : 12;
    cam.position.lerp(_camWant, 1 - Math.exp(-lag * dt));

    // Look target sits a little ahead of the soldier so the reticle is on the world, not the head.
    _v2.copy(_pivot).addScaledVector(_fwd, 40).addScaledVector(_rgt, this.shoulder * 0.35);
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
