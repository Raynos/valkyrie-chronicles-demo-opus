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

import { Ballistics, WEAPON_BALLISTICS } from './ballistics.js';
import { RigidBodySim } from './rigid.js';
import { Explosions } from './explosions.js';
import { rayVsHeightfield, sweptSphereVsBoxes, Hit } from './collision.js';

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
    // Register as the default for the module-level queries (raycast, etc.) so
    // callers that only hold the module — src/game/combat.js's setPhysics()
    // adapter — can trace without being handed a World reference.
    setPhysicsWorld(world);
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
const _dir = new THREE.Vector3();
const _hit = new Hit();
const _rayHit = new Hit();
const _rayColHit = new Hit();
const _rayDir = new THREE.Vector3();

// ------------------------------------------------------ module-level world ---
// The facade is imported as a module by systems that never see the PhysicsWorld
// instance (combat.js's setPhysics adapter takes `mod`, not an object). Keeping
// the active World here is what lets `raycast` below actually be a function of
// the world rather than a stub.

let _world = null;

/** @param {object} world  the src/world World (needs .terrain and .colliders) */
export function setPhysicsWorld(world) { _world = world || null; return _world; }
export function getPhysicsWorld() { return _world; }

/**
 * Game-weapon-id -> exterior-ballistics-id. src/game/units.js WEAPONS carries the
 * same mapping in its `ballistics` field and is the authority; this exists for
 * callers holding a bare id string. Keep the two in step.
 */
export const GAME_WEAPON_BALLISTICS = {
  ZM_KAR8: 'rifle', ZM_MP: 'smg', ZM_LANCE: 'lance', ZM_RIFLE_E: 'rifle',
  ZM_SG: 'sniper', ZM_TANK_HE: 'tankHE', ZM_TANK_AP: 'tankAP', ZM_COAX: 'coax',
  VB_GW: 'rifle', VB_MP: 'smg', VB_LANCE: 'lance', VB_SG: 'sniper',
  VB_TANK: 'tankHE', VB_COAX: 'coax', GRENADE: 'grenade',
};

/**
 * A round's-eye trace: terrain + everything that stops a BULLET.
 *
 * This is the query src/game/combat.js delegates to. It deliberately does NOT
 * use the line-of-sight filter: sandbags, crates, dragon's teeth and telegraph
 * poles stop rounds while being transparent to sight, and barbed wire is the
 * reverse of that (see src/world/collider.js).
 *
 * Units are NOT included — the game layer traces its own bodypart capsules and
 * calls this for the static world only.
 *
 * @param {THREE.Vector3} origin
 * @param {THREE.Vector3} dir      need not be normalised
 * @param {number} maxDist
 * @param {object} [opts] { world?, sight?:boolean, filter?, skipTerrain? }
 * @returns {Hit|null} shared scratch Hit — copy it if you need to keep it
 */
export function raycast(origin, dir, maxDist = 300, opts = null) {
  const world = (opts && opts.world) || _world;
  if (!world) return null;
  _rayDir.copy(dir);
  if (Math.abs(_rayDir.lengthSq() - 1) > 1e-6) _rayDir.normalize();

  let best = null;
  if (!(opts && opts.skipTerrain) && world.terrain &&
      rayVsHeightfield(world.terrain, origin, _rayDir, maxDist, _rayHit)) {
    best = _rayHit;
  }
  const cols = world.colliders;
  if (cols && cols.length) {
    const filter = (opts && opts.filter) ||
      (opts && opts.sight ? _sightFilter : _projectileFilter);
    if (sweptSphereVsBoxes(origin, _rayDir, best ? best.distance : maxDist,
      0.001, cols, _rayColHit, filter)) {
      best = _rayColHit;
    }
  }
  if (!best) return null;
  return best === _rayColHit ? _rayHit.copy(_rayColHit) : _rayHit;
}

// Colliders authored outside src/world/collider.js may not carry the flag, so
// fall back to the same rule that module defaults it to: mass stops rounds.
const _projectileFilter = (c) => !c.destroyed && (c.blocksProjectile !== undefined
  ? !!c.blocksProjectile
  : (c.solid !== false || c.blocksLos !== false));
const _sightFilter = (c) => !c.destroyed && c.blocksLos !== false;
const _solidFilter = (c) => !c.destroyed && c.solid !== false;

/**
 * Resolve anything that names a weapon to its exterior-ballistics profile.
 *
 * The three weapon namespaces do not overlap by design — src/game/units.js has
 * gameplay stat blocks (`ZM_KAR8`), src/actors/weapons.js has meshes
 * (`gallianRifle`) and this module has flight models (`rifle`). The bridge is
 * the `ballistics` field the game table now carries; this accepts either that
 * table's entry, its id, or a raw ballistics id.
 *
 * THIS FUNCTION IS THE BRIDGE AND IT IS NOT PLUGGED IN. src/game/combat.js
 * ballisticsSpec() returns `Physics.ballisticsFor ? ... : null`, and the only
 * caller of its setPhysics() — src/main.js — hands over `{ GRAVITY, groundUnder }`,
 * so `ballisticsFor` is always undefined there and every weapon in the game
 * resolves to a null profile. What that costs is real: structuralDamage() then
 * takes its `16 + 120 * pierce` fallback, which ranks cover damage by
 * ANTI-PERSONNEL pierce instead of by penetration — the exact inversion the
 * penetration-driven design exists to prevent. See the handoff in the r26 report;
 * the fix is one identifier in main.js's setPhysics call, not a change here.
 *
 * @param {string|object} w
 * @returns {object|null} entry of WEAPON_BALLISTICS
 */
export function ballisticsFor(w) {
  if (!w) return null;
  if (typeof w === 'string') {
    return WEAPON_BALLISTICS[w] || WEAPON_BALLISTICS[GAME_WEAPON_BALLISTICS[w]]
      || WEAPON_BALLISTICS[KIND_BALLISTICS[w]] || null;
  }
  if (w.ballistics && WEAPON_BALLISTICS[w.ballistics]) return WEAPON_BALLISTICS[w.ballistics];
  if (w.id && GAME_WEAPON_BALLISTICS[w.id]) return WEAPON_BALLISTICS[GAME_WEAPON_BALLISTICS[w.id]];
  if (w.kind && WEAPON_BALLISTICS[w.kind]) return WEAPON_BALLISTICS[w.kind];
  if (w.kind && KIND_BALLISTICS[w.kind]) return WEAPON_BALLISTICS[KIND_BALLISTICS[w.kind]];
  return null;
}

/**
 * Last-resort resolution by weapon CLASS, for the two `kind` values in
 * src/game/units.js that name no flight model of their own. Without this a tank
 * gun ('cannon') fell all the way through to null and was quoted a rifle's
 * muzzle velocity by the FX layer.
 */
const KIND_BALLISTICS = { cannon: 'tankAP', lance: 'lance', grenade: 'grenade' };

// NO `moveCapsule` HERE. It was a second, never-imported character-movement
// solver sitting next to the one the game uses: infantry move through
// src/game/actionMode.js moveWithCollision() and the tank through
// src/actors/tankPhysics.js, both of which call capsuleVsWorld() directly (still
// exported above). Two solvers with two different step-up rules is a divergence
// waiting to be found by a player, and this one had no callers to keep it honest.

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
  // A ground probe asks about SOLIDITY — what can I stand on — which is not the
  // question sweptSphereVsBoxes answers by default (that one is the bullet's).
  if (cols && cols.length && sweptSphereVsBoxes(_seg0, _dir, maxDrop, 0.001, cols, _hit, _solidFilter)) {
    if (_hit.point.y > best) {
      best = _hit.point.y;
      _groundOut.normal.copy(_hit.normal);
      _groundOut.material = _hit.material;
    }
  }
  _groundOut.y = best === -Infinity ? 0 : best;
  return _groundOut;
}
