// src/actors/tankPhysics.js
// Tracked-vehicle dynamics against the terrain heightfield, plus the ground FX
// that belong to it (track imprints and dust). Fixed 60 Hz; the renderer reads
// interpolated transforms.
//
// Model, in short:
//   * Planar body (x, z, yaw) driven by a differential-thrust track model with
//     slip-limited longitudinal force and a hard lateral grip budget.
//   * Ride model (heave, pitch, roll) driven by six spring/damper probes plus
//     explicit d'Alembert load transfer, so the hull squats under acceleration
//     and leans out of turns.
//   * Six road wheels per side follow the terrain individually on top of the
//     ride model, which is what actually sells a tracked vehicle.

import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, TAU } from '../core/math.js';
import { makeRng } from '../core/rng.js';
import { capsuleVsWorld, SURFACE } from '../physics/collision.js';

const _v0 = new THREE.Vector3();
const _seg0 = new THREE.Vector3();
const _seg1 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e0 = new THREE.Euler();

/** Rolling resistance coefficient per surface — mud eats a tank's top speed. */
const ROLL_RESIST = {
  dirt: 0.075, grass: 0.062, rock: 0.05, mud: 0.155, stone: 0.045, brick: 0.05,
  wood: 0.05, metal: 0.04, sandbag: 0.14, water: 0.22, flesh: 0.1,
};
/** Track-to-ground friction coefficient. */
const GRIP = {
  dirt: 1.05, grass: 0.95, rock: 0.78, mud: 0.52, stone: 0.8, brick: 0.85,
  wood: 0.75, metal: 0.6, sandbag: 0.7, water: 0.45, flesh: 0.9,
};

export class TankPhysics {
  /**
   * @param {object} tank  the Tank actor (read for layout, written for pose)
   * @param {object} world World instance ({ terrain, colliders })
   * @param {object} opts  { scene, physics, mass, seed, trackMarks:boolean }
   */
  constructor(tank, world, opts = {}) {
    this.tank = tank;
    this.world = world;
    this.rng = makeRng(opts.seed ?? 0x7a4b1);

    // ---- chassis constants ------------------------------------------------
    this.mass = opts.mass ?? 13200;          // kg — a light/medium tank
    this.gauge = opts.gauge ?? 2.42;         // track centre-to-centre, m
    this.trackLength = opts.trackLength ?? 3.45; // ground contact length, m
    this.hullHalfLen = 2.6;
    this.hullHalfWidth = 1.34;
    this.cgHeight = 0.78;                    // above the roll axis
    this.rideHeight = opts.rideHeight ?? 0.60;
    this.maxTravel = 0.24;                   // bump
    this.maxDroop = 0.20;

    // Inertia about the pitch (X) and roll (Z) axes for a solid box.
    const L = this.hullHalfLen * 2, W = this.hullHalfWidth * 2, H = 1.5;
    this.Ipitch = (this.mass * (L * L + H * H)) / 12;
    this.Iroll = (this.mass * (W * W + H * H)) / 12;
    this.Iyaw = (this.mass * (L * L + W * W)) / 12;

    // Suspension: sized for a ~1.1 Hz ride frequency at static load.
    const perProbe = (this.mass * 9.81) / 6;
    this.springK = opts.springK ?? perProbe / 0.11;     // N/m to sag 11 cm
    this.springC = opts.springC ?? 2 * 0.42 * Math.sqrt(this.springK * (this.mass / 6));

    // ---- drivetrain -------------------------------------------------------
    this.maxSpeed = opts.maxSpeed ?? 9.4;    // m/s (~34 km/h)
    this.maxReverse = opts.maxReverse ?? 4.2;
    this.trackAuthority = opts.trackAuthority ?? this.mass * 6.5; // N per m/s slip
    this.maxTrackForce = opts.maxTrackForce ?? this.mass * 4.4;   // clutch limit
    /**
     * Sustained engine power, W. This is what actually sets the top speed on a
     * grade: force available at speed v is P/v, so a climb that needs more
     * tractive effort than the engine can deliver at 9 m/s simply gets driven
     * slower. Without it the tank climbs a 40% slope at full speed.
     */
    this.enginePower = opts.enginePower ?? this.mass * 14.5;      // ~190 kW at 13 t
    this.brakeForce = this.mass * 6.0;
    this.pivotRate = opts.pivotRate ?? 0.95; // rad/s neutral-steer max

    // ---- state ------------------------------------------------------------
    this.pos = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.renderPos = new THREE.Vector3();
    this.vel = new THREE.Vector3();          // world-space linear velocity
    this.localVel = new THREE.Vector3();     // x = right, z = forward
    this.yaw = 0; this.prevYaw = 0; this.renderYaw = 0;
    this.pitch = 0; this.prevPitch = 0; this.renderPitch = 0;
    this.roll = 0; this.prevRoll = 0; this.renderRoll = 0;
    this.yawRate = 0;
    this.pitchRate = 0;
    this.rollRate = 0;
    this.heaveVel = 0;
    this.airborne = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    /** Ground gradient in hull axes: rise per metre forward / to the right. */
    this.gradeFwd = 0;
    this.gradeLat = 0;
    this.surface = SURFACE.GRASS;
    this.accelLocal = new THREE.Vector3();   // measured, for load transfer

    this.throttle = 0;
    this.steer = 0;
    this.brake = 0;
    this.handbrake = false;
    /** 0..1 per side; 0 = thrown track, no drive and heavy drag. */
    this.trackHealth = [1, 1];
    this.engineRpm = 0.15;                   // 0..1, drives audio + exhaust
    this.engineLoad = 0;

    // ---- suspension probes: 3 per side, front / centre / rear -------------
    const zs = [this.trackLength * 0.42, 0, -this.trackLength * 0.42];
    this.probes = [];
    for (let s = -1; s <= 1; s += 2) {
      for (let i = 0; i < 3; i++) {
        this.probes.push({
          x: (s * this.gauge) / 2,
          z: zs[i],
          side: s < 0 ? 0 : 1,
          compression: 0.11,
          rawComp: 0.11,
          prevLength: this.rideHeight,
          force: 0,
          contact: true,
          groundY: 0,
        });
      }
    }

    // ---- visual road wheels ----------------------------------------------
    this.wheelCount = opts.wheelCount ?? 6;
    this.wheelRadius = opts.wheelRadius ?? 0.34;
    this.wheelZ = new Float32Array(this.wheelCount);
    const span = this.trackLength * 0.5 - this.wheelRadius * 0.55;
    for (let i = 0; i < this.wheelCount; i++) {
      this.wheelZ[i] = lerp(span, -span, i / (this.wheelCount - 1));
    }
    /** Vertical offset of each road wheel from its rest position, in hull space. */
    this.wheelOffset = new Float32Array(this.wheelCount * 2);
    this._wheelVel = new Float32Array(this.wheelCount * 2);
    /** Wheel spin angle (rad) and per-side track surface speed (m/s). */
    this.wheelSpin = [0, 0];
    this.trackSpeed = [0, 0];
    this.trackDistance = [0, 0];

    // ---- ground FX --------------------------------------------------------
    this.scene = opts.scene || null;
    this.marks = null;
    this.dust = null;
    if (this.scene && opts.trackMarks !== false) {
      this.marks = new TrackMarks({ capacity: opts.markCapacity ?? 320, seed: opts.seed ?? 7 });
      this.scene.add(this.marks.mesh);
      this.dust = new PuffSystem({
        capacity: opts.dustCapacity ?? 96,
        palette: 'dust',
        seed: (opts.seed ?? 7) + 31,
      });
      this.scene.add(this.dust.mesh);
    }
    this._markAccum = [0, 0];
    this._dustAccum = 0;
  }

  // ------------------------------------------------------------- controls ---

  setThrottle(v) { this.throttle = clamp(v, -1, 1); }
  setSteer(v) { this.steer = clamp(v, -1, 1); }
  setBrake(v) { this.brake = clamp01(v); }

  /** Drop the tank onto the terrain at (x, z) facing `yaw`. */
  teleport(x, z, yaw = this.yaw) {
    const h = this._height(x, z);
    this.pos.set(x, h + this.rideHeight, z);
    this.prevPos.copy(this.pos);
    this.renderPos.copy(this.pos);
    this.yaw = this.prevYaw = this.renderYaw = yaw;
    this.pitch = this.roll = 0;
    this.vel.set(0, 0, 0);
    this.yawRate = this.pitchRate = this.rollRate = this.heaveVel = 0;
    for (const p of this.probes) { p.compression = 0.11; p.prevLength = this.rideHeight; }
    return this;
  }

  _height(x, z) {
    const t = this.world && this.world.terrain;
    return t && t.heightAt ? t.heightAt(x, z) : 0;
  }

  _surfaceAt(x, z) {
    const t = this.world && this.world.terrain;
    if (t && t.materialAt) return t.materialAt(x, z) || SURFACE.DIRT;
    if (t && t.slopeAt) return t.slopeAt(x, z) > 0.6 ? SURFACE.ROCK : SURFACE.GRASS;
    return SURFACE.GRASS;
  }

  // ------------------------------------------------------------- stepping ---

  /** Standalone driver when no PhysicsWorld is present. */
  update(dt) {
    let t = Math.min(dt, 0.1);
    while (t > 0) {
      const h = Math.min(t, 1 / 60);
      this.fixedStep(h);
      t -= h;
    }
    this.interpolate(1);
  }

  fixedStep(h) {
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
    this.prevRoll = this.roll;

    this._suspension(h);
    this._drivetrain(h);
    this._integrate(h);
    this._collide(h);
    this._wheels(h);
    this._groundFx(h);
  }

  interpolate(alpha) {
    this.renderPos.lerpVectors(this.prevPos, this.pos, alpha);
    this.renderYaw = this.prevYaw + shortest(this.prevYaw, this.yaw) * alpha;
    this.renderPitch = lerp(this.prevPitch, this.pitch, alpha);
    this.renderRoll = lerp(this.prevRoll, this.roll, alpha);
    if (this.marks) this.marks.update(alpha);
    if (this.dust) this.dust.updateRender();
  }

  /**
   * Write the interpolated pose onto the tank.
   *
   * The pose is deliberately SPLIT. `root` gets only what the game layer also
   * believes about the vehicle — the ground point and the heading — while the
   * ride height, heave, pitch and roll go on `chassis`. Unit.syncActor rewrites
   * root.position/rotation.y from Unit.pos every frame and lands after this, so
   * anything else stored on root is silently thrown away; putting the ride
   * height there is what sank the hull into the terrain by a full 0.60 m.
   *
   * Composition is exact: root's R_y times chassis's R_x·R_z reproduces the
   * original YXZ euler.
   */
  applyToRoot(root, chassis) {
    const gy = this._height(this.renderPos.x, this.renderPos.z);
    root.position.set(this.renderPos.x, gy, this.renderPos.z);
    root.rotation.set(0, this.renderYaw, 0);
    if (chassis) {
      // Suspension EXTENSION, not an absolute height — so it stays valid even
      // when the game layer, not the simulation, owns where the hull is. Clamped
      // to the real travel so a stale or un-teleported sim can never leave the
      // tank hovering or half-buried.
      const t = this.maxTravel;
      chassis.position.set(0, clamp(this.renderPos.y - gy, this.rideHeight - t, this.rideHeight + t), 0);
      _e0.set(this.renderPitch, 0, this.renderRoll, 'YXZ');
      chassis.quaternion.setFromEuler(_e0);
    }
  }

  // ------------------------------------------------------------ suspension ---

  /**
   * Six spring/damper probes. Forces feed heave, pitch and roll; the explicit
   * d'Alembert terms add the load transfer that makes the hull squat and lean.
   */
  _suspension(h) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);

    let Fsum = 0, Tpitch = 0, Troll = 0, contacts = 0;
    // Ground-plane fit accumulators (hull-local): front/rear and left/right
    // mean ground heights under the probes. Fitting the plane the tank is
    // actually sitting on beats averaging six point normals — it is free
    // (the heights are already sampled), allocation-free, and far less noisy
    // over rough ground.
    let hF = 0, nF = 0, hR = 0, nR = 0, hL = 0, nL = 0, hRt = 0, nRt = 0;

    for (let i = 0; i < this.probes.length; i++) {
      const p = this.probes[i];
      // Hull-space attach point -> world. Small-angle-free: full YXZ rotation.
      const lx = p.x, ly = 0, lz = p.z;
      // Rotate by roll (Z), then pitch (X), then yaw (Y) — matches Euler 'YXZ'.
      let ax = lx * cr - ly * sr;
      let ay = lx * sr + ly * cr;
      let az = lz;
      const ay2 = ay * cp - az * sp;
      const az2 = ay * sp + az * cp;
      ay = ay2; az = az2;
      const wx = this.pos.x + (ax * cy + az * sy);
      const wz = this.pos.z + (-ax * sy + az * cy);
      const wy = this.pos.y + ay;

      const gy = this._height(wx, wz);
      p.groundY = gy;
      if (p.z > 0.1) { hF += gy; nF++; } else if (p.z < -0.1) { hR += gy; nR++; }
      if (p.side === 0) { hL += gy; nL++; } else { hRt += gy; nRt++; }
      const length = wy - gy;                       // suspension extension
      const rate = (length - p.prevLength) / h;
      p.prevLength = length;

      const rawComp = this.rideHeight - length;
      p.rawComp = rawComp;
      if (rawComp < -this.maxDroop) {
        // Wheel hanging in the air — no force, but keep the geometry sane.
        p.contact = false;
        p.compression = -this.maxDroop;
        p.force = 0;
        continue;
      }
      p.contact = true;
      contacts++;
      const comp = Math.min(rawComp, this.maxTravel);
      p.compression = comp;

      let f = this.springK * Math.max(0, comp) - this.springC * rate;
      // Bump stop: going past full travel is progressively brutal.
      if (comp > this.maxTravel * 0.92) {
        f += this.springK * 9 * (comp - this.maxTravel * 0.92);
      }
      if (f < 0) f = 0;
      p.force = f;

      Fsum += f;
      Tpitch += -p.z * f;
      Troll += p.x * f;
    }

    // Ground gradient in hull-local axes: metres of rise per metre travelled
    // forward (+Z) and per metre to the right (+X).
    const zSpan = this.trackLength * 0.84;
    this.gradeFwd = (nF && nR) ? (hF / nF - hR / nR) / zSpan : 0;
    this.gradeLat = (nL && nRt) ? (hRt / nRt - hL / nL) / this.gauge : 0;

    this.airborne = contacts === 0;
    if (contacts > 0) {
      // World-space normal, for the FX and camera layers.
      const lnx = -this.gradeLat, lnz = -this.gradeFwd;
      this.groundNormal.set(lnx * cy + lnz * sy, 1, -lnx * sy + lnz * cy).normalize();
      this.surface = this._surfaceAt(this.pos.x, this.pos.z);
    }

    // Load transfer: forward acceleration lifts the nose, lateral acceleration
    // leans the body out of the turn.
    Tpitch += -this.mass * this.accelLocal.z * this.cgHeight;
    Troll += this.mass * this.accelLocal.x * this.cgHeight;

    // Heave.
    const ay = Fsum / this.mass - 9.81;
    this.heaveVel += ay * h;
    this.heaveVel *= 1 - 0.9 * h;
    this.pos.y += this.heaveVel * h;

    // Pitch / roll, with structural damping so the hull settles instead of
    // ringing (real torsion bars are heavily damped by the tracks themselves).
    this.pitchRate += (Tpitch / this.Ipitch) * h;
    this.rollRate += (Troll / this.Iroll) * h;
    this.pitchRate *= 1 - Math.min(0.98, 5.2 * h);
    this.rollRate *= 1 - Math.min(0.98, 5.6 * h);
    this.pitch = clamp(this.pitch + this.pitchRate * h, -0.62, 0.62);
    this.roll = clamp(this.roll + this.rollRate * h, -0.5, 0.5);

    // Hard non-penetration guarantee: no probe may compress past full bump.
    // If one has, the hull is inside the hill — lift it out this instant.
    let worst = 0;
    for (let i = 0; i < this.probes.length; i++) {
      const need = (this.probes[i].rawComp || 0) - this.maxTravel;
      if (need > worst) worst = need;
    }
    if (worst > 0) {
      this.pos.y += worst;
      if (this.heaveVel < 0) this.heaveVel = 0;
      for (const p of this.probes) {
        p.rawComp = Math.min(p.rawComp, this.maxTravel);
        p.prevLength += worst;
      }
    }
    // And absolutely never below the terrain under the hull centre.
    const centreGround = this._height(this.pos.x, this.pos.z);
    const floor = centreGround + this.rideHeight - this.maxTravel - 0.02;
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.heaveVel < 0) this.heaveVel = 0;
    }
  }

  // ------------------------------------------------------------ drivetrain ---

  /**
   * Differential thrust. Each track has a commanded surface speed; the
   * difference between that and the actual contact-patch velocity is slip, and
   * slip makes force up to the friction budget carried by that track's share
   * of the vehicle weight.
   */
  _drivetrain(h) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    // World velocity -> hull frame.
    const vz = this.vel.x * sy + this.vel.z * cy;
    const vx = this.vel.x * cy - this.vel.z * sy;
    this.localVel.set(vx, this.vel.y, vz);

    const grip = GRIP[this.surface] ?? 0.95;
    const rr = ROLL_RESIST[this.surface] ?? 0.07;

    // Normal load per side from the probe forces (this is what couples the
    // ride model to the traction model — lift a track and it loses grip).
    let loadL = 0, loadR = 0;
    for (let i = 0; i < this.probes.length; i++) {
      const p = this.probes[i];
      if (p.side === 0) loadL += p.force; else loadR += p.force;
    }
    if (this.airborne) { loadL = loadR = 0; }
    const staticLoad = this.mass * 9.81 * 0.5;
    loadL = clamp(loadL, 0, staticLoad * 2.2);
    loadR = clamp(loadR, 0, staticLoad * 2.2);

    // Commanded track speeds.
    const top = this.throttle >= 0 ? this.maxSpeed : this.maxReverse;
    const base = this.throttle * top;
    const diff = this.steer * this.pivotRate * this.gauge * 0.5;
    // With no throttle the sticks still counter-rotate (neutral steer).
    let cmdL = base - diff;
    let cmdR = base + diff;
    // A thrown track is dead weight: no drive, and it drags hard.
    cmdL *= this.trackHealth[0] > 0.05 ? 1 : 0;
    cmdR *= this.trackHealth[1] > 0.05 ? 1 : 0;

    // Actual contact-patch speeds.
    const half = this.gauge * 0.5;
    const actL = vz - this.yawRate * half;
    const actR = vz + this.yawRate * half;

    const slipL = cmdL - actL;
    const slipR = cmdR - actR;

    const capL = Math.min(this.maxTrackForce * 0.5, grip * loadL) * this.trackHealth[0];
    const capR = Math.min(this.maxTrackForce * 0.5, grip * loadR) * this.trackHealth[1];

    let FL = clamp(this.trackAuthority * 0.5 * slipL, -capL, capL);
    let FR = clamp(this.trackAuthority * 0.5 * slipR, -capR, capR);

    // Engine power ceiling, applied only where the track is doing positive
    // work. Retardation (engine braking, reversing direction) isn't limited by
    // available power, so it must not be clamped here.
    const powerCap = (this.enginePower * 0.5) / Math.max(1.2, Math.abs(vz));
    if (FL * actL > 0) FL = clamp(FL, -powerCap, powerCap);
    if (FR * actR > 0) FR = clamp(FR, -powerCap, powerCap);

    // Braking / handbrake: force opposing the actual patch velocity.
    if (this.brake > 0 || this.handbrake) {
      const bf = (this.handbrake ? 1 : this.brake) * this.brakeForce * 0.5;
      FL += clamp(-actL * this.mass, -bf, bf);
      FR += clamp(-actR * this.mass, -bf, bf);
    }

    // Rolling resistance + thrown-track drag.
    const rrL = rr * loadL * (1 + (1 - this.trackHealth[0]) * 4);
    const rrR = rr * loadR * (1 + (1 - this.trackHealth[1]) * 4);
    FL -= Math.sign(actL) * Math.min(rrL, Math.abs(actL) * this.mass * 0.5);
    FR -= Math.sign(actR) * Math.min(rrR, Math.abs(actR) * this.mass * 0.5);

    let Fz = FL + FR;
    let Tz = (FR - FL) * half;

    // Slope resistance: the component of gravity along the ground plane. This
    // is what makes the tank bog down climbing and run away downhill. Climbing
    // means gradeFwd > 0, which must produce a force pointing BACKWARDS.
    const gz = this.gradeFwd, gx = this.gradeLat;
    const airFactor = this.airborne ? 0 : 1;
    const slopeAlong = -gz / Math.sqrt(1 + gz * gz);
    Fz += this.mass * 9.81 * slopeAlong * airFactor;
    const slopeLat = -gx / Math.sqrt(1 + gx * gx);
    let Fx = this.mass * 9.81 * slopeLat * airFactor;

    // Lateral grip: tracks resist sideslip hard, but not infinitely — get a
    // heavy vehicle sliding across a slope and it will keep sliding.
    const latCap = grip * (loadL + loadR) * 0.85;
    Fx += clamp(-vx * this.mass * 4.0, -latCap, latCap);

    // Yaw scrub damping: turning a tracked vehicle drags the whole contact
    // patch sideways, which is a big rotational damper.
    const scrubCap = grip * (loadL + loadR) * this.trackLength * 0.11;
    Tz += clamp(-this.yawRate * this.Iyaw * 2.6, -scrubCap, scrubCap);

    // Integrate the planar body in hull space.
    const az = Fz / this.mass;
    const ax = Fx / this.mass;
    const newVz = vz + az * h;
    const newVx = vx + ax * h;
    this.accelLocal.set(
      damp(this.accelLocal.x, ax, 14, h),
      0,
      damp(this.accelLocal.z, az, 14, h)
    );
    this.yawRate += (Tz / this.Iyaw) * h;
    // Absolute cap so a hard turn can't spin the hull unrealistically.
    this.yawRate = clamp(this.yawRate, -this.pivotRate * 1.35, this.pivotRate * 1.35);

    // Back to world space.
    this.vel.x = newVx * cy + newVz * sy;
    this.vel.z = -newVx * sy + newVz * cy;

    // Engine model, for audio and the exhaust plume.
    const speedFrac = clamp01(Math.abs(newVz) / this.maxSpeed);
    const demand = clamp01(Math.abs(this.throttle) + Math.abs(this.steer) * 0.55);
    const targetRpm = clamp01(0.16 + demand * 0.55 + speedFrac * 0.4);
    this.engineRpm = damp(this.engineRpm, targetRpm, 3.4, h);
    this.engineLoad = damp(this.engineLoad, clamp01(demand + Math.max(0, gz) * 2.2), 2.2, h);

    // Track surface speeds drive the link animation and the wheel spin.
    this.trackSpeed[0] = this.trackHealth[0] > 0.05 ? cmdL * 0.35 + actL * 0.65 : 0;
    this.trackSpeed[1] = this.trackHealth[1] > 0.05 ? cmdR * 0.35 + actR * 0.65 : 0;
  }

  _integrate(h) {
    this.pos.x += this.vel.x * h;
    this.pos.z += this.vel.z * h;
    this.yaw += this.yawRate * h;
    if (this.yaw > Math.PI) this.yaw -= TAU;
    else if (this.yaw < -Math.PI) this.yaw += TAU;

    // Vertical motion is entirely owned by the ride model (which applies g
    // whether or not the probes are in contact), so there is nothing to add
    // here for the airborne case.
    this.trackDistance[0] += this.trackSpeed[0] * h;
    this.trackDistance[1] += this.trackSpeed[1] * h;
    const invR = 1 / this.wheelRadius;
    this.wheelSpin[0] += this.trackSpeed[0] * invR * h;
    this.wheelSpin[1] += this.trackSpeed[1] * invR * h;
  }

  /** Hull vs world colliders — a capsule down the centreline, pushed out. */
  _collide(h) {
    const cols = this.world && this.world.colliders;
    if (!cols || !cols.length) return;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const ext = this.hullHalfLen - this.hullHalfWidth;
    _seg0.set(this.pos.x + sy * ext, this.pos.y + 0.55, this.pos.z + cy * ext);
    _seg1.set(this.pos.x - sy * ext, this.pos.y + 0.55, this.pos.z - cy * ext);
    const r = capsuleVsWorld(_seg0, _seg1, this.hullHalfWidth, this.world);
    if (!r.hit) return;
    const mtv = r.mtv;
    // Ignore the terrain's vertical component — the ride model owns Y.
    _v0.set(mtv.x, 0, mtv.z);
    const len = _v0.length();
    if (len < 1e-4) return;
    _n.copy(_v0).divideScalar(len);
    this.pos.x += _n.x * Math.min(len, 0.35);
    this.pos.z += _n.z * Math.min(len, 0.35);
    const into = this.vel.x * _n.x + this.vel.z * _n.z;
    if (into < 0) {
      this.vel.x -= _n.x * into * 1.05;
      this.vel.z -= _n.z * into * 1.05;
    }
    // Glancing a wall nudges the hull round — tracked vehicles slew off cover.
    const fx = sy, fz = cy;
    this.yawRate += (fx * _n.z - fz * _n.x) * 0.9 * clamp01(len * 4) * (1 - h);
  }

  /**
   * Visual road-wheel travel. Each wheel independently chases the terrain
   * beneath it with a critically-damped follower, on top of the hull pose.
   */
  _wheels(h) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    const half = this.gauge * 0.5;
    const omega = 26, zeta = 1.0;              // follower stiffness

    for (let s = 0; s < 2; s++) {
      const lx = s === 0 ? -half : half;
      for (let i = 0; i < this.wheelCount; i++) {
        const lz = this.wheelZ[i];
        // Rest position of this wheel's axle in world space (hull pose only).
        let ax = lx * cr, ay = lx * sr, az = lz;
        const ay2 = ay * cp - az * sp;
        const az2 = ay * sp + az * cp;
        ay = ay2; az = az2;
        const wx = this.pos.x + (ax * cy + az * sy);
        const wz = this.pos.z + (-ax * sy + az * cy);
        const wy = this.pos.y + ay;

        const gy = this._height(wx, wz);
        // `wy` is where this axle sits with the suspension at rest; the hull
        // datum is `rideHeight` above the ground under it, and the wheel just
        // touches. So the travel needed to put the wheel back on the ground is
        // simply how far the local ground has moved relative to that datum.
        let target = gy - (wy - this.rideHeight);
        target = clamp(target, -this.maxDroop, this.maxTravel);

        const k = s * this.wheelCount + i;
        const x = this.wheelOffset[k];
        let v = this._wheelVel[k];
        // Critically damped spring toward the terrain-derived target.
        v += (-2 * zeta * omega * v - omega * omega * (x - target)) * h;
        this._wheelVel[k] = v;
        this.wheelOffset[k] = clamp(x + v * h, -this.maxDroop, this.maxTravel);
      }
    }
  }

  // -------------------------------------------------------------- ground FX ---

  _groundFx(h) {
    if (!this.marks && !this.dust) return;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const half = this.gauge * 0.5;
    const speed = Math.hypot(this.vel.x, this.vel.z);

    for (let s = 0; s < 2; s++) {
      const lx = s === 0 ? -half : half;
      const wx = this.pos.x + lx * cy;
      const wz = this.pos.z - lx * sy;
      const travelled = Math.abs(this.trackSpeed[s]) * h;
      this._markAccum[s] += travelled;
      if (this.marks && this._markAccum[s] >= 0.42 && !this.airborne) {
        this._markAccum[s] = 0;
        const gy = this._height(wx, wz);
        // Slip between the commanded track speed and the hull's motion churns
        // the ground — that's when the imprint should be darkest.
        const slip = clamp01(Math.abs(this.trackSpeed[s] - forwardAt(this, s)) * 0.5);
        this.marks.spawn(wx, gy + 0.035, wz, this.yaw, 0.62 + slip * 0.28, this.surface);
      }
    }

    if (this.dust) {
      const dryness = this.surface === SURFACE.WATER || this.surface === SURFACE.MUD ? 0
        : this.surface === SURFACE.GRASS ? 0.55 : 1;
      const slipTotal = Math.abs(this.trackSpeed[0] - this.localVel.z) +
                        Math.abs(this.trackSpeed[1] - this.localVel.z);
      const rate = (speed * 1.5 + slipTotal * 1.2) * dryness;
      this._dustAccum += rate * h;
      while (this._dustAccum >= 1) {
        this._dustAccum -= 1;
        const s = this.rng() < 0.5 ? 0 : 1;
        const lx = (s === 0 ? -half : half) + (this.rng() - 0.5) * 0.3;
        const lz = -this.trackLength * 0.5 + (this.rng() - 0.5) * 0.5;
        const wx = this.pos.x + (lx * cy + lz * sy);
        const wz = this.pos.z + (-lx * sy + lz * cy);
        const gy = this._height(wx, wz);
        this.dust.spawn(
          wx, gy + 0.12, wz,
          (this.rng() - 0.5) * 0.5 - this.vel.x * 0.12,
          0.35 + this.rng() * 0.4,
          (this.rng() - 0.5) * 0.5 - this.vel.z * 0.12,
          0.5 + this.rng() * 0.55,
          1.1 + this.rng() * 0.8
        );
      }
      this.dust.step(h);
    }
    if (this.marks) this.marks.step(h);
  }

  dispose() {
    if (this.marks) { this.marks.dispose(); this.scene?.remove(this.marks.mesh); this.marks = null; }
    if (this.dust) { this.dust.dispose(); this.scene?.remove(this.dust.mesh); this.dust = null; }
  }
}

function forwardAt(tp, side) {
  const half = tp.gauge * 0.5;
  return tp.localVel.z + (side === 0 ? -1 : 1) * tp.yawRate * half;
}

function shortest(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}


// ============================================================================
//  Ground decals — track imprints
// ============================================================================

/**
 * A ring buffer of instanced, ground-aligned quads stamped behind the treads.
 * The shader keeps the CANVAS look: the imprint is a *quantised* two-tone wash
 * (violet-brown in the deep part, warm umber at the rim) rather than a smooth
 * alpha blend, and the paper grain shows through it.
 */
export class TrackMarks {
  constructor({ capacity = 320, seed = 7, width = 0.62, length = 0.8 } = {}) {
    this.capacity = capacity;
    this.head = 0;
    this.count = 0;
    this.rng = makeRng(seed);
    this.life = 26;

    this.aPos = new Float32Array(capacity * 3);
    this.aParam = new Float32Array(capacity * 4);  // yaw, size, seed, birthAge
    this.age = new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.aFade = new Float32Array(capacity);

    const geo = new THREE.InstancedBufferGeometry();
    const hw = width * 0.5, hl = length * 0.5;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -hw, 0, -hl, hw, 0, -hl, hw, 0, hl, -hw, 0, hl,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(this.aPos, 3));
    geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(this.aParam, 4));
    geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(this.aFade, 1));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: { uTread: { value: makeTreadTexture(seed) } },
      vertexShader: /* glsl */`
        attribute vec3 aPos;
        attribute vec4 aParam;   // x yaw, y size, z seed, w unused
        attribute float aFade;
        varying vec2 vUv;
        varying float vFade;
        varying float vSeed;
        void main() {
          vUv = uv;
          vFade = aFade;
          vSeed = aParam.z;
          float c = cos(aParam.x), s = sin(aParam.x);
          vec3 p = position * aParam.y;
          vec3 w = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c) + aPos;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uTread;
        varying vec2 vUv;
        varying float vFade;
        varying float vSeed;
        // Gouache palette: never grey, never black.
        const vec3 DEEP = vec3(0.243, 0.196, 0.216);   // warm brown-violet
        const vec3 RIM  = vec3(0.404, 0.333, 0.243);   // umber
        void main() {
          vec4 t = texture2D(uTread, vUv);
          // Soft oval mask so the stamp doesn't read as a rectangle.
          vec2 d = (vUv - 0.5) * vec2(2.1, 1.9);
          float mask = 1.0 - smoothstep(0.72, 1.0, dot(d, d));
          float a = t.r * mask * vFade;
          if (a < 0.02) discard;
          // Two-tone quantisation — the wet-on-dry watercolour edge.
          float band = smoothstep(0.34, 0.44, t.r);
          vec3 col = mix(RIM, DEEP, band);
          gl_FragColor = vec4(col, a * 0.82);
        }`,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -2;         // under everything, over the terrain
    this.mesh.userData.outline = false;
    this.mesh.userData.noPrepass = true;
    this.mesh.name = 'trackMarks';
    this.geo = geo;
    this._dirty = false;
  }

  spawn(x, y, z, yaw, strength, surface) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
    this.aPos[i * 3] = x; this.aPos[i * 3 + 1] = y; this.aPos[i * 3 + 2] = z;
    this.aParam[i * 4] = yaw;
    this.aParam[i * 4 + 1] = 1;
    this.aParam[i * 4 + 2] = this.rng();
    this.aParam[i * 4 + 3] = 0;
    // Stone barely takes an imprint; dirt and sandbags take a deep one.
    const soft = (surface === SURFACE.STONE || surface === SURFACE.BRICK ||
                  surface === SURFACE.ROCK) ? 0.28 : surface === SURFACE.MUD ? 1.3 : 1;
    this.age[i] = 0;
    this.alive[i] = 1;
    this.aFade[i] = clamp01(strength * soft);
    this._dirty = true;
    this.geo.instanceCount = this.count;
  }

  step(h) {
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      this.age[i] += h;
      const t = this.age[i] / this.life;
      if (t >= 1) { this.alive[i] = 0; this.aFade[i] = 0; this._dirty = true; continue; }
      // Hold, then wash out — rain and wind take the imprint slowly.
      if (t > 0.55) {
        this.aFade[i] *= 1 - h * 0.55;
        this._dirty = true;
      }
    }
  }

  update() {
    if (!this._dirty) return;
    this.geo.attributes.aPos.needsUpdate = true;
    this.geo.attributes.aParam.needsUpdate = true;
    this.geo.attributes.aFade.needsUpdate = true;
    this._dirty = false;
  }

  clear() {
    this.alive.fill(0);
    this.aFade.fill(0);
    this.count = 0; this.head = 0;
    this.geo.instanceCount = 0;
    this._dirty = true;
  }

  dispose() {
    this.geo.dispose();
    this.material.uniforms.uTread.value?.dispose();
    this.material.dispose();
  }
}

// ============================================================================
//  Puffs — dust, exhaust smoke, damage smoke, fire
// ============================================================================

const PUFF_PALETTES = {
  // [core, mid, edge] in linear-ish sRGB. All warm or violet — never grey.
  dust:  [[0.85, 0.78, 0.62], [0.72, 0.63, 0.47], [0.55, 0.47, 0.42]],
  smoke: [[0.42, 0.37, 0.41], [0.30, 0.26, 0.31], [0.23, 0.19, 0.22]],
  exhaust: [[0.55, 0.50, 0.52], [0.40, 0.36, 0.40], [0.29, 0.25, 0.30]],
  fire:  [[1.00, 0.93, 0.72], [0.95, 0.62, 0.26], [0.62, 0.25, 0.16]],
  muzzle: [[1.00, 0.96, 0.82], [0.98, 0.80, 0.42], [0.70, 0.42, 0.22]],
};

/**
 * Instanced camera-facing puffs with a painterly, band-quantised alpha ramp.
 * One draw call; positions and parameters live in typed arrays and only the
 * live range is uploaded.
 */
export class PuffSystem {
  constructor({ capacity = 96, palette = 'smoke', seed = 3, additive = false, softness = 1 } = {}) {
    this.capacity = capacity;
    this.head = 0;
    this.rng = makeRng(seed);

    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.growth = new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);

    this.aPos = new Float32Array(capacity * 3);
    this.aParam = new Float32Array(capacity * 4);  // size, alpha, rot, seed

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(this.aPos, 3));
    geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(this.aParam, 4));
    geo.instanceCount = capacity;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const pal = PUFF_PALETTES[palette] || PUFF_PALETTES.smoke;
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uBlob: { value: makeSoftBlobTexture(seed) },
        uCore: { value: new THREE.Color(pal[0][0], pal[0][1], pal[0][2]) },
        uMid: { value: new THREE.Color(pal[1][0], pal[1][1], pal[1][2]) },
        uEdge: { value: new THREE.Color(pal[2][0], pal[2][1], pal[2][2]) },
        uSoft: { value: softness },
      },
      vertexShader: /* glsl */`
        attribute vec3 aPos;
        attribute vec4 aParam;   // x size, y alpha, z rot, w seed
        varying vec2 vUv;
        varying float vAlpha;
        varying float vSeed;
        void main() {
          vUv = uv;
          vAlpha = aParam.y;
          vSeed = aParam.w;
          float c = cos(aParam.z), s = sin(aParam.z);
          vec2 p = vec2(position.x * c - position.y * s,
                        position.x * s + position.y * c) * aParam.x;
          vec4 mv = viewMatrix * vec4(aPos, 1.0);
          mv.xy += p;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uBlob;
        uniform vec3 uCore, uMid, uEdge;
        uniform float uSoft;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vSeed;
        void main() {
          float d = texture2D(uBlob, vUv).r;
          float a = d * vAlpha;
          if (a < 0.015) discard;
          // Quantise the density into three washes with bleeding boundaries —
          // gouache does not blend smoothly.
          float b1 = smoothstep(0.30, 0.30 + 0.16 * uSoft, d);
          float b2 = smoothstep(0.62, 0.62 + 0.14 * uSoft, d);
          vec3 col = mix(uEdge, uMid, b1);
          col = mix(col, uCore, b2);
          // Slight hue drift by seed so no two puffs are the same wash.
          col *= 0.92 + 0.16 * fract(vSeed * 7.13);
          gl_FragColor = vec4(col, a);
        }`,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.userData.outline = false;
    this.mesh.userData.noPrepass = true;
    this.geo = geo;
    this.gravity = 0.0;
    this.drag = 0.9;
    this.rise = 0.0;
  }

  /** @returns {number} slot index */
  spawn(x, y, z, vx, vy, vz, size, life, growth = 1.7) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size0[i] = size;
    this.growth[i] = growth;
    this.alive[i] = 1;
    this.aParam[i * 4 + 2] = this.rng() * TAU;
    this.aParam[i * 4 + 3] = this.rng();
    return i;
  }

  step(h) {
    const drag = Math.max(0, 1 - this.drag * h);
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) {
        this.aParam[i * 4 + 1] = 0;
        continue;
      }
      this.age[i] += h;
      const t = this.age[i] / this.life[i];
      if (t >= 1) { this.alive[i] = 0; this.aParam[i * 4 + 1] = 0; continue; }
      const i3 = i * 3;
      this.vel[i3] *= drag;
      this.vel[i3 + 1] = this.vel[i3 + 1] * drag + (this.rise + this.gravity) * h;
      this.vel[i3 + 2] *= drag;
      this.pos[i3] += this.vel[i3] * h;
      this.pos[i3 + 1] += this.vel[i3 + 1] * h;
      this.pos[i3 + 2] += this.vel[i3 + 2] * h;
      this.aPos[i3] = this.pos[i3];
      this.aPos[i3 + 1] = this.pos[i3 + 1];
      this.aPos[i3 + 2] = this.pos[i3 + 2];
      // Grow, then fade: fast in, slow out.
      this.aParam[i * 4] = this.size0[i] * (1 + this.growth[i] * t);
      const fadeIn = Math.min(1, t * 8);
      this.aParam[i * 4 + 1] = fadeIn * (1 - t) * (1 - t * 0.35);
      this.aParam[i * 4 + 2] += h * (this.aParam[i * 4 + 3] - 0.5) * 0.9;
    }
  }

  updateRender() {
    this.geo.attributes.aPos.needsUpdate = true;
    this.geo.attributes.aParam.needsUpdate = true;
  }

  clear() {
    this.alive.fill(0);
    for (let i = 0; i < this.capacity; i++) this.aParam[i * 4 + 1] = 0;
    this.updateRender();
  }

  dispose() {
    this.geo.dispose();
    this.material.uniforms.uBlob.value?.dispose();
    this.material.dispose();
  }
}

// ============================================================================
//  Procedural textures
// ============================================================================

function canvas2d(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { c, g: c.getContext('2d') };
}

/**
 * A soft, irregular blob with a fibrous edge — the alpha ramp for every puff.
 * Built from summed radial falloffs so the silhouette is lumpy, not circular.
 */
export function makeSoftBlobTexture(seed = 1, size = 128) {
  const rng = makeRng(seed * 2654435761 >>> 0);
  const { c, g } = canvas2d(size);
  const img = g.createImageData(size, size);
  const d = img.data;
  // 7 offset lobes make the blob asymmetric like a real smoke puff.
  const lobes = [];
  for (let i = 0; i < 7; i++) {
    lobes.push({
      x: 0.5 + (rng() - 0.5) * 0.34,
      y: 0.5 + (rng() - 0.5) * 0.34,
      r: 0.20 + rng() * 0.20,
      w: 0.5 + rng() * 0.6,
    });
  }
  let norm = 0;
  for (const l of lobes) norm += l.w;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let a = 0;
      for (const l of lobes) {
        const dx = u - l.x, dy = v - l.y;
        const t = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / l.r);
        a += l.w * t * t;
      }
      a /= norm;
      // Fibrous edge: a little high-frequency noise, only where alpha is mid.
      const n = (Math.sin(x * 0.9 + y * 1.7) * 0.5 + Math.sin(x * 2.3 - y * 1.1) * 0.5);
      a += n * 0.045 * (1 - Math.abs(a - 0.5) * 2);
      // Hard radial cut so nothing bleeds off the quad.
      const rx = (u - 0.5) * 2, ry = (v - 0.5) * 2;
      a *= Math.max(0, 1 - Math.pow(rx * rx + ry * ry, 1.6));
      const val = Math.max(0, Math.min(1, a * 1.45)) * 255;
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = val;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Track-shoe imprint: the cleat pattern plus the churned soil between cleats,
 * drawn with a wobbly pen so it never reads as a repeating decal.
 */
export function makeTreadTexture(seed = 1, size = 128) {
  const rng = makeRng((seed * 40503 + 7) >>> 0);
  const { c, g } = canvas2d(size);
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);

  // Churned base: soft blotches of mid value.
  for (let i = 0; i < 90; i++) {
    const x = rng() * size, y = rng() * size, r = 3 + rng() * 12;
    const a = 0.05 + rng() * 0.14;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(255,255,255,${a})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Cleats: 5 bars across the width, each hand-drawn slightly off.
  const bars = 5;
  g.lineCap = 'round';
  for (let i = 0; i < bars; i++) {
    const y = (i + 0.5) * (size / bars) + (rng() - 0.5) * 3;
    const w = 7 + rng() * 3;
    g.strokeStyle = `rgba(255,255,255,${0.62 + rng() * 0.3})`;
    g.lineWidth = w;
    g.beginPath();
    const segs = 6;
    for (let s = 0; s <= segs; s++) {
      const x = (s / segs) * (size * 0.94) + size * 0.03;
      const yy = y + Math.sin(s * 1.7 + i) * 1.6 + (rng() - 0.5) * 1.4;
      if (s === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
    }
    g.stroke();
    // Centre guide-horn groove: a dark break in the middle of each cleat.
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(size * 0.5 - 3, y - w); g.lineTo(size * 0.5 - 3, y + w);
    g.stroke();
  }
  // Edge falloff so consecutive stamps blend into a continuous rut.
  const grd = g.createLinearGradient(0, 0, size, 0);
  grd.addColorStop(0, 'rgba(0,0,0,1)');
  grd.addColorStop(0.12, 'rgba(0,0,0,0)');
  grd.addColorStop(0.88, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
