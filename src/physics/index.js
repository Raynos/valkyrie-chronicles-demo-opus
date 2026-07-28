// src/physics/index.js
// The shared physics facade. Everything in the game that needs to hit, push,
// blow up or fall over goes through here.
//
// Fixed 60 Hz accumulator with render interpolation: `step(dt)` runs zero or
// more deterministic 1/60 s ticks and then hands the leftover fraction to the
// subsystems as `alpha` so meshes are drawn between ticks instead of snapping.

import * as THREE from 'three';

export {
  Hit, SURFACE, SURFACE_HARDNESS,
  normalizeCollider, closestPointOnSegment, closestPointOnBox,
  rayVsBox, rayVsSphere, rayVsCapsule,
  sweptSphereVsBoxes, rayVsHeightfield, capsuleVsWorld, lineOfSight,
} from './collision.js';

export { Ballistics, WEAPON_BALLISTICS, BODYPART_MULT, registerWeapon, hitVolumesSweep, GRAVITY }
  from './ballistics.js';
export { RigidBodySim, RigidBody, orientationFromNormal } from './rigid.js';
export { Explosions } from './explosions.js';

import { Ballistics } from './ballistics.js';
import { RigidBodySim } from './rigid.js';
import { Explosions } from './explosions.js';
import { capsuleVsWorld, rayVsHeightfield, sweptSphereVsBoxes, Hit } from './collision.js';

export const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;          // beyond this we drop time rather than spiral

/**
 * Owns the fixed clock and the three subsystems. Register it with the Engine:
 *   engine.add(physics)
 * and it will tick before anything that reads its results (add it early).
 */
export class PhysicsWorld {
  constructor(world, opts = {}) {
    this.world = world;
    this.units = opts.units || [];
    this.rigid = new RigidBodySim(world, opts.rigid);
    this.explosions = new Explosions(world, Object.assign({ rigid: this.rigid, units: this.units }, opts.explosions));
    this.ballistics = new Ballistics(world, Object.assign({ explosions: this.explosions, units: this.units }, opts.ballistics));
    /** Extra systems that want the fixed clock (e.g. TankPhysics). */
    this.steppers = [];
    this._acc = 0;
    this.alpha = 0;
    this.time = 0;
    this.ticks = 0;
    this.timeScale = 1;
    this.enabled = true;
  }

  /** Point every subsystem at the live unit list (Battle owns it). */
  setUnits(units) {
    this.units = units;
    this.ballistics.setUnits(units);
    this.explosions.setUnits(units);
    return this;
  }

  /** @param {{fixedStep:(h:number)=>void, interpolate?:(a:number)=>void}} s */
  addStepper(s) { this.steppers.push(s); return s; }
  removeStepper(s) {
    const i = this.steppers.indexOf(s);
    if (i >= 0) this.steppers.splice(i, 1);
  }

  /** Engine system hook. */
  update(dt) { this.step(dt); }

  step(dt) {
    if (!this.enabled) return;
    this._acc += Math.min(dt, 0.25) * this.timeScale;
    let n = 0;
    while (this._acc >= FIXED_DT && n < MAX_SUBSTEPS) {
      this.fixedStep(FIXED_DT);
      this._acc -= FIXED_DT;
      n++;
    }
    if (n === MAX_SUBSTEPS) this._acc = 0;   // give up on the backlog
    this.alpha = this._acc / FIXED_DT;
    this.ballistics.interpolate(this.alpha);
    this.rigid.interpolate(this.alpha);
    for (let i = 0; i < this.steppers.length; i++) this.steppers[i].interpolate?.(this.alpha);
  }

  fixedStep(h) {
    this.time += h;
    this.ticks++;
    this.explosions.fixedStep(h);
    for (let i = 0; i < this.steppers.length; i++) this.steppers[i].fixedStep(h);
    this.ballistics.fixedStep(h);
    this.rigid.fixedStep(h);
  }

  clear() {
    this.ballistics.clear();
    this.rigid.clear();
    this.explosions.clear();
  }
  dispose() { this.clear(); this.steppers.length = 0; }
}

// --------------------------------------------------------------- helpers ----

const _seg0 = new THREE.Vector3();
const _seg1 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hit = new Hit();

/**
 * Move a capsule (a walking unit, or the tank's collision proxy) through the
 * world with penetration resolution and a terrain floor. Mutates `pos`.
 *
 * @param {THREE.Vector3} pos     feet position, updated in place
 * @param {THREE.Vector3} delta   desired motion this step
 * @param {number} radius
 * @param {number} height         total capsule height (feet to top)
 * @param {object} world
 * @param {number} stepHeight     max ledge the mover can walk up
 * @returns {{grounded:boolean, blocked:boolean, groundNormal:THREE.Vector3}}
 */
const _moveOut = { grounded: false, blocked: false, groundNormal: new THREE.Vector3(0, 1, 0) };
export function moveCapsule(pos, delta, radius, height, world, stepHeight = 0.45) {
  const startY = pos.y;
  pos.add(delta);
  let blocked = false;
  // Two relaxation passes: enough for corners, cheap enough for 20 units.
  for (let i = 0; i < 2; i++) {
    _seg0.set(pos.x, pos.y + radius, pos.z);
    _seg1.set(pos.x, pos.y + height - radius, pos.z);
    const r = capsuleVsWorld(_seg0, _seg1, radius, world);
    if (!r.hit) { _moveOut.grounded = r.grounded; _moveOut.groundNormal.copy(r.groundNormal); break; }
    // Vertical-only pushes below the step height are absorbed as a step-up.
    if (r.mtv.y > 0 && r.mtv.y <= stepHeight && Math.abs(r.mtv.x) + Math.abs(r.mtv.z) < 0.02) {
      pos.y += r.mtv.y;
    } else {
      pos.add(r.mtv);
      if (Math.abs(r.mtv.x) + Math.abs(r.mtv.z) > 1e-4) blocked = true;
    }
    _moveOut.grounded = r.grounded;
    _moveOut.groundNormal.copy(r.groundNormal);
  }
  // Hard floor clamp — nothing is ever allowed under the heightfield.
  const terrain = world && world.terrain;
  if (terrain && terrain.heightAt) {
    const h = terrain.heightAt(pos.x, pos.z);
    if (pos.y < h) { pos.y = h; _moveOut.grounded = true; }
    // Don't let a single step teleport up a cliff.
    if (pos.y - startY > stepHeight + Math.max(0, delta.y)) {
      pos.y = startY + stepHeight + Math.max(0, delta.y);
      if (pos.y < h) pos.y = h;
    }
  }
  _moveOut.blocked = blocked;
  return _moveOut;
}

/**
 * Nearest surface point below `pos` — the universal "put this thing on the
 * ground" query. Checks colliders (rooftops, crates) as well as terrain.
 * @returns {{y:number, normal:THREE.Vector3, material:string}}
 */
const _groundOut = { y: 0, normal: new THREE.Vector3(0, 1, 0), material: 'dirt' };
export function groundUnder(world, x, y, z, maxDrop = 40) {
  _seg0.set(x, y, z);
  _dir.set(0, -1, 0);
  let best = -Infinity;
  _groundOut.normal.set(0, 1, 0);
  _groundOut.material = 'dirt';
  const terrain = world && world.terrain;
  if (terrain && terrain.heightAt) {
    if (rayVsHeightfield(terrain, _seg0, _dir, maxDrop, _hit)) {
      best = _hit.point.y;
      _groundOut.normal.copy(_hit.normal);
      _groundOut.material = _hit.material;
    } else {
      best = terrain.heightAt(x, z);
    }
  }
  const cols = (world && world.colliders) || null;
  if (cols && cols.length && sweptSphereVsBoxes(_seg0, _dir, maxDrop, 0.001, cols, _hit)) {
    if (_hit.point.y > best) {
      best = _hit.point.y;
      _groundOut.normal.copy(_hit.normal);
      _groundOut.material = _hit.material;
    }
  }
  _groundOut.y = best === -Infinity ? 0 : best;
  return _groundOut;
}
