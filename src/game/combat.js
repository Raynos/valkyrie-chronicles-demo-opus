// src/game/combat.js — ballistics, line of sight, hit probability, damage resolution.
//
// One model for everything: a shot is ALWAYS a real ray with angular dispersion. The AI, the
// interception fire and the player's free-aim all go through fireRound()/fireBurst(), so the
// hit-% readout the player sees is the analytic prediction of the same dispersion that is
// actually simulated. No hidden dice, no "AI always hits" fudge.
//
// Adapter note: ARCHITECTURE.md does not specify src/physics. If the integrator calls
// setPhysics(mod) with anything exposing `raycast(origin, dir, maxDist, opts)` we delegate world
// tracing to it; otherwise we trace terrain + World.colliders ourselves.
//
// Bullets ask a different question of the world than eyes do. Everything here traces with the
// PROJECTILE filter: a sandbag revetment or a crate stack stops a round while being transparent
// to line of sight (you shoot over the parapet you are crouched behind), and barbed wire is the
// exact reverse. See src/world/collider.js for the three-flag vocabulary.

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { CFG } from '../core/config.js';
import { clamp, clamp01, lerp } from '../core/math.js';
import { rayHitUnit, unitBoundRadius, GRENADE } from './units.js';

// ---------------------------------------------------------------------------
// Physics adapter
// ---------------------------------------------------------------------------

export const Physics = {
  impl: null,
  raycast: null,          // (origin, dir, maxDist, opts) -> { point, normal, distance, material } | null
  lineOfSight: null,      // (world, from, to, ignore) -> 0..1 visibility
  groundUnder: null,      // (world, x, y, z, maxDrop) -> { y, normal, material }
  ballisticsFor: null,    // (weapon|id) -> exterior-ballistics profile | null
  gravity: 9.81,
};

// Reused options bag for the physics raycast — one per module, never per shot.
const _physOpts = { world: null, projectile: true, sight: false };

export function setPhysics(mod) {
  Physics.impl = mod || null;
  const fn = typeof mod?.raycast === 'function' ? mod.raycast : null;
  Physics.raycast = fn;
  // src/physics exposes `lineOfSight(world, from, to, ignore)` returning a 0..1 visibility.
  Physics.lineOfSight = typeof mod?.lineOfSight === 'function' ? mod.lineOfSight : null;
  Physics.groundUnder = typeof mod?.groundUnder === 'function' ? mod.groundUnder : null;
  // Bridge between the three weapon namespaces (game stat block / mesh / flight model).
  Physics.ballisticsFor = typeof mod?.ballisticsFor === 'function' ? mod.ballisticsFor : null;
  if (typeof mod?.GRAVITY === 'number') Physics.gravity = mod.GRAVITY;
  else if (typeof mod?.gravity === 'number') Physics.gravity = mod.gravity;
  // Hand the physics module the world it is supposed to be tracing against; without
  // this its module-level queries have nothing to trace and silently return null.
  if (Ctx.world && typeof mod?.setPhysicsWorld === 'function') mod.setPhysicsWorld(Ctx.world);
  return Physics;
}

/** The exterior-ballistics profile for a weapon, or null if physics is not wired. */
export function ballisticsSpec(weapon) {
  return Physics.ballisticsFor ? Physics.ballisticsFor(weapon) : null;
}

// ---------------------------------------------------------------------------
// Combat context. Battle installs itself here so any module can trace without
// threading `world`/`units` through a dozen call sites.
// ---------------------------------------------------------------------------

export const Ctx = {
  world: null,
  units: [],
  battle: null,
  rng: Math.random,
};

/**
 * `silent` suppresses the Bus banners that potentials normally raise. The AI turns it on while
 * it is scoring hypothetical firing positions, otherwise the HUD would strobe with potential
 * pop-ups for shots nobody ever takes.
 */
export const CombatFlags = { silent: false };

export function setCombatContext({ world, units, battle, rng }) {
  if (world !== undefined) Ctx.world = world;
  if (units !== undefined) Ctx.units = units;
  if (battle !== undefined) Ctx.battle = battle;
  if (rng !== undefined) Ctx.rng = rng;
  // Keep the physics module's idea of the world in step, whichever order the
  // integrator calls setPhysics() and setCombatContext() in.
  if (world !== undefined && typeof Physics.impl?.setPhysicsWorld === 'function') {
    Physics.impl.setPhysicsWorld(world);
  }
  return Ctx;
}

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _o = new THREE.Vector3();
const _dir = new THREE.Vector3();

const worldHit = {
  t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0,
  material: 'dirt', collider: null, cover: 0, destructible: false,
};

/** Frozen options for World.raycast. Hoisted: one per module, not one per shot. */
const _worldRayOpts = Object.freeze({ projectile: true });
const _worldSightOpts = Object.freeze({ projectile: false });

const sceneHit = {
  t: 0, kind: 'none', point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
  material: 'dirt', unit: null, part: null, partLabel: '', mult: 1, crit: false, collider: null,
};

// ---------------------------------------------------------------------------
// Collider readers — tolerant of whatever shape src/world hands us.
// ---------------------------------------------------------------------------

function colCenter(c, out) {
  const p = c.center || c.pos || c.position;
  if (p) return out.set(p.x, p.y, p.z);
  return out.set(c.x || 0, c.y || 0, c.z || 0);
}

function colHalf(c, out) {
  const h = c.half || c.halfExtents || c.he;
  if (h) return out.set(h.x, h.y, h.z);
  const s = c.size || c.dim;
  if (s) return out.set(s.x * 0.5, s.y * 0.5, s.z * 0.5);
  if (c.hx !== undefined) return out.set(c.hx, c.hy ?? c.hx, c.hz ?? c.hx);
  const r = c.radius || c.r || 0.5;
  return out.set(r, c.height ? c.height * 0.5 : r, r);
}

/** World colliders may carry a yaw OR a quaternion; both reduce to a Y rotation here. */
function colYaw(c) {
  if (c.yaw !== undefined) return c.yaw;
  if (c.rotY !== undefined) return c.rotY;
  if (c.rotationY !== undefined) return c.rotationY;
  const q = c.quaternion || c.quat;
  if (q) return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
  return 0;
}

/**
 * Anything the world has switched off, blown up, or marked as not blocking.
 * `destroyed` is src/world/collider.js's single destruction switch — setting it
 * also clears solid/blocksLos/blocksProjectile/cover, so every subsystem agrees.
 */
function colInert(c) { return c.noBlock || c.destroyed || c.disabled || c.dead; }

/** Does this collider stop a bullet? Tolerant of colliders authored elsewhere. */
function colStopsRound(c) {
  if (c.blocksProjectile !== undefined) return !!c.blocksProjectile;
  return c.solid !== false || c.blocksLos !== false;
}

/** Ray vs oriented box. Slab test in the box's local frame. Returns t or -1. */
function rayBox(ox, oy, oz, dx, dy, dz, c, maxDist) {
  colCenter(c, _a);
  colHalf(c, _b);
  const yaw = colYaw(c);
  let lx = ox - _a.x, ly = oy - _a.y, lz = oz - _a.z;
  let vx = dx, vy = dy, vz = dz;
  if (yaw !== 0) {
    const cs = Math.cos(-yaw), sn = Math.sin(-yaw);
    const nx = lx * cs - lz * sn, nz = lx * sn + lz * cs;
    lx = nx; lz = nz;
    const wx = vx * cs - vz * sn, wz = vx * sn + vz * cs;
    vx = wx; vz = wz;
  }
  let tmin = 0, tmax = maxDist;
  // X
  if (Math.abs(vx) < 1e-8) { if (Math.abs(lx) > _b.x) return -1; }
  else {
    let t1 = (-_b.x - lx) / vx, t2 = (_b.x - lx) / vx;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (Math.abs(vy) < 1e-8) { if (Math.abs(ly) > _b.y) return -1; }
  else {
    let t1 = (-_b.y - ly) / vy, t2 = (_b.y - ly) / vy;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (Math.abs(vz) < 1e-8) { if (Math.abs(lz) > _b.z) return -1; }
  else {
    let t1 = (-_b.z - lz) / vz, t2 = (_b.z - lz) / vz;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

function boxNormal(c, px, py, pz, out) {
  colCenter(c, _c);
  colHalf(c, _d);
  const yaw = colYaw(c);
  let lx = px - _c.x, ly = py - _c.y, lz = pz - _c.z;
  if (yaw !== 0) {
    const cs = Math.cos(-yaw), sn = Math.sin(-yaw);
    const nx = lx * cs - lz * sn, nz = lx * sn + lz * cs;
    lx = nx; lz = nz;
  }
  const ex = Math.abs(lx) / Math.max(1e-6, _d.x);
  const ey = Math.abs(ly) / Math.max(1e-6, _d.y);
  const ez = Math.abs(lz) / Math.max(1e-6, _d.z);
  if (ex > ey && ex > ez) out.set(Math.sign(lx), 0, 0);
  else if (ey > ez) out.set(0, Math.sign(ly), 0);
  else out.set(0, 0, Math.sign(lz));
  if (yaw !== 0) {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const nx = out.x * cs - out.z * sn, nz = out.x * sn + out.z * cs;
    out.set(nx, out.y, nz);
  }
  return out;
}

function raySphereT(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const cc = lx * lx + ly * ly + lz * lz - r * r;
  if (cc > 0 && b > 0) return -1;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = -b - s;
  return t >= 0 ? t : -1;
}

// ---------------------------------------------------------------------------
// World tracing
// ---------------------------------------------------------------------------

/**
 * Trace terrain + static colliders. Returns the shared `worldHit` record or null.
 * Terrain is marched at 0.5 m and refined with 8 bisections — plenty for 1 m grid cells.
 *
 * @param {boolean} [sight] ask the LINE-OF-SIGHT question instead of the bullet one.
 *   Only the eyes-vs-bullets distinction differs: a sandbag parapet stops the round
 *   and not the look, tall grass stops neither.
 */
export function traceWorld(ox, oy, oz, dx, dy, dz, maxDist, world = Ctx.world, sight = false) {
  let best = -1;
  let bestCollider = null;
  let bestMat = 'dirt';

  // src/physics is authoritative when it is wired AND has a world to trace: it is the
  // same swept test the projectiles themselves use, so a hitscan round and a simulated
  // round cannot disagree about what stopped them.
  if (Physics.raycast && world) {
    _o.set(ox, oy, oz); _dir.set(dx, dy, dz);
    _physOpts.world = world;
    _physOpts.sight = sight;
    _physOpts.projectile = !sight;
    const h = Physics.raycast(_o, _dir, maxDist, _physOpts);
    if (h) {
      const t = h.distance ?? h.t ?? (h.point ? _o.distanceTo(h.point) : -1);
      if (t >= 0) {
        worldHit.t = t;
        worldHit.x = h.point?.x ?? ox + dx * t;
        worldHit.y = h.point?.y ?? oy + dy * t;
        worldHit.z = h.point?.z ?? oz + dz * t;
        worldHit.nx = h.normal?.x ?? 0; worldHit.ny = h.normal?.y ?? 1; worldHit.nz = h.normal?.z ?? 0;
        worldHit.material = h.material || 'dirt';
        worldHit.collider = h.collider || null;
        worldHit.cover = h.collider?.cover ?? 1;
        worldHit.destructible = !!h.collider?.destructible;
        return worldHit;
      }
    }
    return null;
  }

  // The World keeps a uniform-grid broadphase; use it in preference to our own linear
  // scan whenever it exists. It also knows about the bridge deck and other platforms.
  // `projectile: true` is what makes it answer the bullet question rather than the
  // line-of-sight one — without it, rounds pass straight through 95 solid colliders.
  if (world?.raycast) {
    _o.set(ox, oy, oz); _dir.set(dx, dy, dz);
    let h = null;
    try { h = world.raycast(_o, _dir, maxDist, sight ? _worldSightOpts : _worldRayOpts); } catch { h = null; }
    if (!h) return null;
    const t = h.distance ?? _o.distanceTo(h.point);
    worldHit.t = t;
    worldHit.x = h.point.x; worldHit.y = h.point.y; worldHit.z = h.point.z;
    worldHit.nx = h.normal?.x ?? 0; worldHit.ny = h.normal?.y ?? 1; worldHit.nz = h.normal?.z ?? 0;
    worldHit.material = h.material || 'dirt';
    worldHit.collider = h.collider || null;
    worldHit.cover = h.collider?.cover ?? 1;
    worldHit.destructible = !!h.collider?.destructible;
    return worldHit;
  }

  const colliders = world?.colliders;
  if (colliders) {
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (colInert(c)) continue;
      if (sight ? c.blocksLos === false : !colStopsRound(c)) continue;
      let t = -1;
      if (c.type === 'sphere') {
        colCenter(c, _a);
        t = raySphereT(ox, oy, oz, dx, dy, dz, _a.x, _a.y, _a.z, c.radius ?? c.r ?? 0.5);
      } else {
        t = rayBox(ox, oy, oz, dx, dy, dz, c, maxDist);
      }
      if (t >= 0 && t <= maxDist && (best < 0 || t < best)) {
        best = t; bestCollider = c; bestMat = c.material || 'wood';
      }
    }
  }

  // Terrain march. Sphere-traced: the step is a fraction of the current clearance above the
  // heightfield, so a 130 m sniper ray costs ~30 samples instead of 260 and the tail of a
  // near-miss over open ground is nearly free. Refined with 8 bisections at the crossing.
  const terrain = world?.terrain;
  if (terrain?.heightAt) {
    const limit = best >= 0 ? best : maxDist;
    let t = 0;
    let prevT = 0;
    let clearance = oy - terrain.heightAt(ox, oz);
    if (clearance < 0) clearance = 0.001;         // started underground: do not self-hit
    for (let iter = 0; iter < 256 && t < limit; iter++) {
      const step = clamp(clearance * 0.72, 0.3, 8);
      const nt = Math.min(t + step, limit);
      const px = ox + dx * nt, py = oy + dy * nt, pz = oz + dz * nt;
      const above = py - terrain.heightAt(px, pz);
      if (above <= 0) {
        let lo = prevT, hi = nt;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = ox + dx * mid, my = oy + dy * mid, mz = oz + dz * mid;
          if (my - terrain.heightAt(mx, mz) <= 0) hi = mid; else lo = mid;
        }
        if (best < 0 || hi < best) { best = hi; bestCollider = null; bestMat = 'dirt'; }
        break;
      }
      prevT = nt;
      t = nt;
      clearance = above;
    }
  }

  if (best < 0) return null;
  worldHit.t = best;
  worldHit.x = ox + dx * best; worldHit.y = oy + dy * best; worldHit.z = oz + dz * best;
  if (bestCollider) {
    if (bestCollider.type === 'sphere') {
      colCenter(bestCollider, _a);
      _n.set(worldHit.x - _a.x, worldHit.y - _a.y, worldHit.z - _a.z).normalize();
    } else {
      boxNormal(bestCollider, worldHit.x, worldHit.y, worldHit.z, _n);
    }
  } else if (world?.terrain?.normalAt) {
    const nrm = world.terrain.normalAt(worldHit.x, worldHit.z);
    _n.set(nrm.x, nrm.y, nrm.z);
  } else _n.set(0, 1, 0);
  worldHit.nx = _n.x; worldHit.ny = _n.y; worldHit.nz = _n.z;
  worldHit.material = bestMat;
  worldHit.collider = bestCollider;
  worldHit.cover = bestCollider?.cover ?? 1;
  worldHit.destructible = !!bestCollider?.destructible;
  return worldHit;
}

/**
 * Full scene trace: world geometry + every live unit's bodypart capsules.
 * @returns shared `sceneHit` or null. `kind` is 'world' | 'unit'.
 */
export function traceScene(origin, dir, maxDist, opts = null) {
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const dx = dir.x, dy = dir.y, dz = dir.z;
  const ignore = opts?.ignore || null;
  const units = opts?.units || Ctx.units;
  const world = opts?.world || Ctx.world;

  let bestT = maxDist;
  let hitUnit = null, hitPart = null, hitLabel = '', hitMult = 1, hitCrit = false;

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u === ignore || !u.alive || !u.deployed) continue;
    if (u.downed && !opts?.hitDowned) continue;
    if (opts?.ignoreTeam !== undefined && u.team === opts.ignoreTeam) continue;
    // broad phase: distance from unit centre to the ray
    const cx = u.pos.x - ox, cy = u.pos.y + 1.0 - oy, cz = u.pos.z - oz;
    const proj = cx * dx + cy * dy + cz * dz;
    if (proj < -2 || proj > bestT + 3) continue;
    const perp2 = cx * cx + cy * cy + cz * cz - proj * proj;
    const br = unitBoundRadius(u) + 0.4;
    if (perp2 > br * br) continue;
    const h = rayHitUnit(ox, oy, oz, dx, dy, dz, u, bestT);
    if (h && h.t < bestT) {
      bestT = h.t; hitUnit = u; hitPart = h.part; hitLabel = h.label; hitMult = h.mult; hitCrit = h.crit;
    }
  }

  const wh = traceWorld(ox, oy, oz, dx, dy, dz, bestT, world);
  if (wh && wh.t < bestT) {
    sceneHit.t = wh.t; sceneHit.kind = 'world';
    sceneHit.point.set(wh.x, wh.y, wh.z);
    sceneHit.normal.set(wh.nx, wh.ny, wh.nz);
    sceneHit.material = wh.material;
    sceneHit.collider = wh.collider;
    sceneHit.unit = null; sceneHit.part = null; sceneHit.partLabel = ''; sceneHit.mult = 1; sceneHit.crit = false;
    return sceneHit;
  }
  if (hitUnit) {
    sceneHit.t = bestT; sceneHit.kind = 'unit';
    sceneHit.point.set(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
    sceneHit.normal.set(-dx, -dy, -dz);
    sceneHit.material = hitUnit.isVehicle ? 'metal' : 'flesh';
    sceneHit.unit = hitUnit; sceneHit.part = hitPart; sceneHit.partLabel = hitLabel;
    sceneHit.mult = hitMult; sceneHit.crit = hitCrit; sceneHit.collider = null;
    return sceneHit;
  }
  return null;
}

/** True if nothing static blocks the segment a->b (unit bodies do NOT block LOS). */
export function hasLOS(ax, ay, az, bx, by, bz, world = Ctx.world) {
  if (Physics.lineOfSight) {
    _a.set(ax, ay, az); _b.set(bx, by, bz);
    return Physics.lineOfSight(world, _a, _b, null) > 0.35;
  }
  if (world?.lineOfSight) {
    _a.set(ax, ay, az); _b.set(bx, by, bz);
    return !!world.lineOfSight(_a, _b);
  }
  _dir.set(bx - ax, by - ay, bz - az);
  const dist = _dir.length();
  if (dist < 0.001) return true;
  _dir.multiplyScalar(1 / dist);
  const h = traceWorld(ax, ay, az, _dir.x, _dir.y, _dir.z, dist - 0.15, world, true);
  return !h;
}

/**
 * True if a ROUND can get from a to b — the projectile question, not the eyes'.
 *
 * `hasLOS` above is the eyes': it runs the LOS filter, so a sandbag parapet
 * (blocksLos:false, blocksProjectile:true — 47 of this map's colliders are that
 * shape) is invisible to it. Predicting a shot with the sight trace is how the
 * HUD came to advertise 99% on a burst that buried every round in the parapet
 * 7 m short of the target. Anything that predicts a hit must use THIS.
 */
export function hasFireLane(ax, ay, az, bx, by, bz, world = Ctx.world) {
  _dir.set(bx - ax, by - ay, bz - az);
  const dist = _dir.length();
  if (dist < 0.001) return true;
  _dir.multiplyScalar(1 / dist);
  // Stop short of the target's own surface so the body being shot at is not
  // mistaken for the thing blocking the shot.
  const h = traceWorld(ax, ay, az, _dir.x, _dir.y, _dir.z, dist - 0.15, world, false);
  return !h;
}

/** LOS between two units' natural sight/target points. */
export function unitsHaveLOS(a, b, world = Ctx.world) {
  a.headPoint(_a);
  b.centerPoint(_b);
  return hasLOS(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, world);
}

/**
 * Is one of `shooter`'s own side standing in the shot? Cheap capsule-free test: project each
 * friendly onto the ray and compare the perpendicular miss distance against its body radius.
 *
 * Rounds no longer DAMAGE a friendly (see fireRound), but a tracer stitching through your
 * own sergeant's head still reads as broken, so the shooter should hold fire instead. This is
 * the check for "do I have a lane", not a damage check.
 *
 * @param {Unit} shooter
 * @param {THREE.Vector3} origin  muzzle
 * @param {THREE.Vector3} aimPoint  where the shot is going
 * @param {Unit[]} units
 * @param {number} pad extra clearance in metres
 * @returns {Unit|null} the friendly in the way, nearest first, or null
 */
export function friendlyInLine(shooter, origin, aimPoint, units = Ctx.units, pad = 0.45) {
  _dir.subVectors(aimPoint, origin);
  const dist = _dir.length();
  if (dist < 0.2) return null;
  _dir.multiplyScalar(1 / dist);
  let best = null, bestT = Infinity;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u === shooter || u.team !== shooter.team) continue;
    if (!u.alive || !u.deployed || u.downed) continue;
    u.centerPoint(_a);
    _b.subVectors(_a, origin);
    const t = _b.dot(_dir);
    // Behind the muzzle, or further away than the thing being shot at: not in the way.
    if (t < 0.5 || t > dist - 0.3) continue;
    const perp2 = _b.lengthSq() - t * t;
    const r = (u.targetRadius ? u.targetRadius() : 0.45) + pad;
    if (perp2 > r * r) continue;
    if (t < bestT) { bestT = t; best = u; }
  }
  return best;
}

/** Can `observer` detect `target` right now? Distance + LOS; no vision cone (VC is 360°). */
export function canSee(observer, target, world = Ctx.world) {
  if (!observer.active || !target.alive || !target.deployed) return false;
  const d2 = observer.pos.distanceToSquared(target.pos);
  const r = observer.sight * (target.stance === 2 ? 0.65 : target.stance === 1 ? 0.85 : 1);
  if (d2 > r * r) return false;
  return unitsHaveLOS(observer, target, world);
}

/** Cover fraction 0..1 protecting `target` from `fromPos`. Combines world cover + stance. */
export function coverFor(target, fromX, fromY, fromZ, world = Ctx.world) {
  let cov = 0;
  if (world?.coverAt) {
    // World.coverAt's `fromDir` points FROM the covered unit TOWARD the threat
    // (src/world/world.js): it runs a +-70 degree bearing test and only counts
    // volumes lying that way. This used to pass (target - shooter), i.e. the
    // exact opposite, so every unit was credited with whatever happened to be
    // standing BEHIND him and got nothing from the wall he was hiding behind.
    _dir.set(fromX - target.pos.x, 0, fromZ - target.pos.z);
    if (_dir.lengthSq() > 1e-6) _dir.normalize();
    try { cov = world.coverAt(target.pos, _dir) || 0; } catch { cov = 0; }
  }
  // A crouched/prone soldier gets more out of the same wall.
  cov = clamp01(cov * (1 + target.stanceCover()) + target.stanceCover() * 0.5);
  return target.isVehicle ? cov * 0.35 : cov;
}

// ---------------------------------------------------------------------------
// Accuracy model
// ---------------------------------------------------------------------------

/**
 * Effective marksmanship 0..1 for this shot, before dispersion is derived from it.
 * ctx: { aimed, range, cover, targetSpeed, battle, target, underFire }
 */
export function effectiveAccuracy(shooter, weapon, ctx) {
  let a = weapon.accuracy * (0.58 + 0.72 * shooter.aim);
  a += shooter.stanceAccuracy();
  if (ctx.aimed) a += 0.10;
  a -= shooter.suppression * 0.30;
  // Range falloff: perfect up to weapon.range, degrading to 0.28 at maxRange, then hard off.
  const r = ctx.range || 0;
  if (r > weapon.range) {
    const f = clamp01((r - weapon.range) / Math.max(1, weapon.maxRange - weapon.range));
    a *= lerp(1, 0.28, f * f);
  }
  // Very close range with a long gun is awkward.
  if (weapon.kind === 'sniper' && r < 8) a *= 0.55;
  const m = shooter.evalPotentials('attack', ctx, CombatFlags.silent);
  a += m.acc;
  return clamp(a, 0.03, 0.99);
}

/**
 * 1-sigma angular dispersion in radians.
 * `bloom` is 1 when the reticle is wide open and `weapon.settled` when fully converged.
 */
export function shotSigma(shooter, weapon, accuracy, bloom = 1, moving = 0) {
  const base = weapon.spread * bloom;
  // Poor marksmen open the group up; great ones close it.
  const skill = lerp(1.85, 0.42, accuracy);
  const move = 1 + clamp01(moving / 5) * 1.35;
  const sup = 1 + shooter.suppression * 0.85;
  return base * skill * move * sup;
}

/** Reticle bloom 0..1 -> weapon.settled..1 given seconds held still. */
export function bloomFor(weapon, holdSeconds, movedRecently = 0) {
  const t = clamp01(holdSeconds / Math.max(0.01, weapon.settle));
  const conv = lerp(1, weapon.settled, t * t * (3 - 2 * t));
  return clamp(conv + movedRecently * 0.55, weapon.settled, 1.6);
}

/**
 * Analytic hit probability for ONE round. Rayleigh CDF of a circular 2-D Gaussian against a
 * disc of angular radius theta:  P = 1 - exp(-theta^2 / (2 sigma^2)).
 * Returns { p, sigma, theta, range, cover, accuracy }.
 */
const _hp = { p: 0, sigma: 0, theta: 0, range: 0, cover: 0, accuracy: 0, blocked: false };
export function hitProbability(shooter, target, opts = {}) {
  const weapon = opts.weapon || (shooter.usingAlt && shooter.altAmmo ? shooter.altAmmo : shooter.weapon);
  shooter.muzzlePoint(_a);
  target.centerPoint(_b);
  const range = _a.distanceTo(_b);
  const cover = opts.cover !== undefined ? opts.cover : coverFor(target, _a.x, _a.y, _a.z, opts.world);

  const ctx = _accCtx;
  ctx.aimed = !!opts.aimed; ctx.range = range; ctx.cover = cover;
  ctx.target = target; ctx.battle = opts.battle || Ctx.battle;
  ctx.underFire = !!opts.underFire; ctx.targetSpeed = target.speed;
  const acc = effectiveAccuracy(shooter, weapon, ctx);

  const dctx = _defCtx;
  dctx.cover = cover; dctx.battle = ctx.battle; dctx.underFire = true; dctx.attacker = shooter;
  const dm = target.evalPotentials('defend', dctx, CombatFlags.silent);
  const eva = clamp01(target.evasion + dm.eva + clamp01(target.speed / 6) * 0.20);

  const sigma = shotSigma(shooter, weapon, acc, opts.bloom ?? weapon.settled, shooter.speed) * (1 + eva * 1.7);
  // Exposed silhouette: cover eats the disc.
  const rr = target.targetRadius() * (1 - cover * 0.82);
  const theta = Math.atan2(Math.max(0.02, rr), Math.max(0.5, range));
  let p = 1 - Math.exp(-(theta * theta) / (2 * sigma * sigma));
  if (range > weapon.maxRange) p = 0;

  _hp.p = clamp(p, 0, 0.99);
  _hp.sigma = sigma; _hp.theta = theta; _hp.range = range; _hp.cover = cover; _hp.accuracy = acc;
  // The muzzle/centre components must be read out BEFORE the trace: traceWorld
  // reuses _a.._d as collider scratch.
  const ax = _a.x, ay = _a.y, az = _a.z, bx = _b.x, by = _b.y, bz = _b.z;
  _hp.blocked = !hasFireLane(ax, ay, az, bx, by, bz, opts.world);
  if (_hp.blocked) _hp.p *= 0.12;
  return _hp;
}

const _accCtx = { aimed: false, range: 0, cover: 0, target: null, battle: null, underFire: false, targetSpeed: 0 };
const _defCtx = { cover: 0, battle: null, underFire: false, attacker: null };

/** Whole-attack expectation used by the HUD readout and the AI's expected-value sort. */
export function attackForecast(shooter, target, opts = {}) {
  const weapon = opts.weapon || (shooter.usingAlt && shooter.altAmmo ? shooter.altAmmo : shooter.weapon);
  const hp = hitProbability(shooter, target, opts);
  const perShot = expectedDamage(shooter, target, weapon, opts);
  const shots = weapon.shots || 1;
  const expHits = hp.p * shots;
  const expDmg = expHits * perShot;
  return {
    chance: hp.p, shots, expectedHits: expHits, expectedDamage: expDmg,
    range: hp.range, cover: hp.cover, accuracy: hp.accuracy, sigma: hp.sigma,
    lethal: expDmg >= target.hp, blocked: hp.blocked, weapon,
  };
}

/** Mean damage of a single connecting round, averaged over the hitzone distribution. */
export function expectedDamage(shooter, target, weapon, opts = {}) {
  const raw = target.isVehicle ? weapon.aaDamage : weapon.apDamage;
  const ctx = _accCtx;
  ctx.target = target; ctx.battle = opts.battle || Ctx.battle; ctx.aimed = !!opts.aimed;
  ctx.range = opts.range || 0; ctx.cover = opts.cover || 0;
  const am = shooter.evalPotentials('attack', ctx, CombatFlags.silent);
  _defCtx.cover = opts.cover || 0; _defCtx.battle = ctx.battle;
  _defCtx.underFire = true; _defCtx.attacker = shooter;
  const dm = target.evalPotentials('defend', _defCtx, CombatFlags.silent);
  const zone = target.isVehicle ? 1.05 : 1.12;   // mean of the part multipliers weighted by area
  const mit = mitigation(target, weapon);
  return raw * zone * am.dmg * (target.isVehicle ? am.aa : 1) * mit * dm.def;
}

/**
 * HP of structural damage ONE round does to destructible cover, on the same scale as
 * the `explosion` event's `power` and the props' HP.
 *
 * Driven by PENETRATION, not by anti-personnel damage: what a crate cares about is the
 * round's energy, not how badly it hurts a man. That is what keeps a sniper rifle — 132
 * damage to a soldier — from flattening a four-course sandbag revetment in five shots,
 * while a lance or a tank shell goes through cover like it should. `spec` is the
 * exterior-ballistics profile (src/physics); the fallback reconstructs a plausible
 * penetration from the weapon's `pierce` when physics is not wired.
 */
const STRUCTURAL_PER_PEN = 0.35;
function structuralDamage(weapon, spec) {
  const pen = spec ? spec.pen : (16 + 120 * clamp01(weapon.pierce || 0));
  return pen * STRUCTURAL_PER_PEN;
}

function mitigation(target, weapon) {
  const pierce = clamp01(weapon.pierce || 0);
  const def = clamp01(target.defense * (1 - pierce * 0.85));
  let m = 1 - def;
  if (target.isVehicle) m *= 1 - clamp01(target.armour * (1 - pierce));
  return clamp(m, 0.06, 1);
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

const _jd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upl = new THREE.Vector3();

/** Perturb `dir` by a 2-D Gaussian of 1-sigma `sigma` radians. Writes into `out`. */
export function jitterDirection(dir, sigma, rng, out) {
  // Box-Muller once, reused for both axes.
  const u1 = Math.max(1e-7, rng());
  const u2 = rng();
  const mag = sigma * Math.sqrt(-2 * Math.log(u1));
  const ang = u2 * Math.PI * 2;
  const ax = mag * Math.cos(ang);
  const ay = mag * Math.sin(ang);
  _right.set(dir.z, 0, -dir.x);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
  _right.normalize();
  _upl.crossVectors(_right, dir).normalize();
  out.copy(dir).addScaledVector(_right, ax).addScaledVector(_upl, ay).normalize();
  return out;
}

/**
 * Fire one round from `shooter` along `dir`. Traces the scene, applies damage, emits events.
 * @returns { hit, unit, part, crit, damage, point, material, distance }
 */
const _shotRes = {
  hit: false, unit: null, part: null, partLabel: '', crit: false, damage: 0,
  point: new THREE.Vector3(), normal: new THREE.Vector3(), material: 'air', distance: 0,
};

export function fireRound(shooter, origin, dir, opts = {}) {
  const weapon = opts.weapon || (shooter.usingAlt && shooter.altAmmo ? shooter.altAmmo : shooter.weapon);
  const maxDist = opts.maxDist || weapon.maxRange * 1.5;
  const rng = opts.rng || Ctx.rng;

  _shotRes.hit = false; _shotRes.unit = null; _shotRes.part = null; _shotRes.partLabel = '';
  _shotRes.crit = false; _shotRes.damage = 0; _shotRes.material = 'air'; _shotRes.distance = maxDist;
  _shotRes.point.copy(origin).addScaledVector(dir, maxDist);
  _shotRes.normal.set(0, 1, 0);

  shooter.stats.shotsFired++;
  // `ballistics` carries the exterior-ballistics profile this weapon maps to, so the FX
  // layer draws a tracer at the right muzzle velocity instead of guessing (three weapon
  // namespaces, one bridge — see WEAPONS[].ballistics in ./units.js).
  const bspec = ballisticsSpec(weapon);
  Bus.emit('shot:fired', {
    unit: shooter, origin: _o.copy(origin).clone(), dir: _dir.copy(dir).clone(),
    weapon, ballistics: weapon.ballistics || null, speed: bspec?.v0 ?? null,
    tracer: (opts.tracerForce ?? (rng() < (weapon.tracer || 0))),
  });
  Bus.emit('sfx', { name: weapon.sfx, pos: origin });

  // FRIENDLY FIRE IS NOT A FEATURE. No caller of this function has ever wanted a bullet
  // to stop on a squadmate: not the player's aimed fire, not the AI's, and least of all
  // interception, where a scout walking between his own shocktrooper and an Imperial got
  // hosed with the burst meant for the Imperial (Round 19: Rosie Stark put 66 HP into Edy
  // Nelson and downed her, and it was scored as an enemy routed).
  //
  // The trace has supported `ignoreTeam` for a long time — nobody passed it, and this
  // function did not forward it either, so passing it from the caller alone would still
  // have hit the squadmate. Default it to the shooter's own team, and let a caller opt
  // back in with `friendlyFire: true` if the game ever grows a reason to.
  const ignoreTeam = opts.ignoreTeam !== undefined ? opts.ignoreTeam
    : (opts.friendlyFire === true ? undefined : shooter.team);
  const h = traceScene(origin, dir, maxDist, {
    ignore: shooter, ignoreTeam, units: opts.units || Ctx.units, world: opts.world || Ctx.world,
  });
  if (!h) return _shotRes;

  _shotRes.point.copy(h.point);
  _shotRes.normal.copy(h.normal);
  _shotRes.material = h.material;
  _shotRes.distance = h.t;

  if (h.kind === 'unit' && h.unit) {
    const target = h.unit;
    const raw = target.isVehicle ? weapon.aaDamage : weapon.apDamage;
    const ctx = _accCtx;
    ctx.target = target; ctx.battle = opts.battle || Ctx.battle; ctx.aimed = !!opts.aimed;
    ctx.range = h.t; ctx.cover = 0;
    const am = shooter.evalPotentials('attack', ctx);
    _defCtx.cover = 0; _defCtx.battle = ctx.battle; _defCtx.underFire = true; _defCtx.attacker = shooter;
    const dm = target.evalPotentials('defend', _defCtx);

    let crit = h.crit;
    if (!crit && am.crit > 0 && rng() < am.crit) crit = true;

    let dmg = raw * h.mult * am.dmg * (target.isVehicle ? am.aa : 1) * mitigation(target, weapon) * dm.def;
    if (crit && !h.crit) dmg *= 1.6;
    // Long-range rounds shed a little energy.
    if (h.t > weapon.range) dmg *= lerp(1, 0.72, clamp01((h.t - weapon.range) / Math.max(1, weapon.maxRange - weapon.range)));

    const applied = target.takeDamage(dmg, shooter, { crit, part: h.part, worldPos: h.point, kind: 'bullet' });
    if (applied > 0) shooter.stats.shotsHit++;
    if (h.part === 'trackL' || h.part === 'trackR') target.tracksDisabled = true;

    _shotRes.hit = true; _shotRes.unit = target; _shotRes.part = h.part; _shotRes.partLabel = h.partLabel;
    _shotRes.crit = crit; _shotRes.damage = applied;

    Bus.emit('shot:hit', {
      point: h.point.clone(), normal: h.normal.clone(), material: h.material,
      unit: target, part: h.part, crit, damage: applied, shooter,
    });
  } else {
    Bus.emit('shot:hit', {
      point: h.point.clone(), normal: h.normal.clone(), material: h.material,
      unit: null, part: null, crit: false, damage: 0, shooter,
    });
    // Shooting cover wears it down. World.damage() is the single funnel: it applies HP,
    // flips the collider's `destroyed` switch and raises `cover:destroyed` exactly once,
    // on the transition — so this no longer announces a wall as destroyed while it is
    // still standing, and a rifle can now saw through a crate stack it used to ignore.
    if (h.collider?.destructible) {
      const world = opts.world || Ctx.world;
      world?.damage?.(h.collider, structuralDamage(weapon, bspec));
    }
  }

  if (weapon.splash) {
    explode(_shotRes.point, weapon.splash, weapon.splashPower, {
      source: shooter, aaPower: weapon.splashPower * 0.6, kind: 'shell',
    });
  }
  return _shotRes;
}

/**
 * Fire a whole attack (weapon.shots rounds) at an aim direction.
 * Returns a summary; the caller is responsible for spending ammo and setting attackUsed.
 */
export function fireBurst(shooter, origin, aimDir, opts = {}) {
  const weapon = opts.weapon || (shooter.usingAlt && shooter.altAmmo ? shooter.altAmmo : shooter.weapon);
  const rng = opts.rng || Ctx.rng;
  const shots = opts.shots ?? weapon.shots ?? 1;
  const sigma = opts.sigma ?? shotSigma(
    shooter, weapon,
    effectiveAccuracy(shooter, weapon, { aimed: !!opts.aimed, range: opts.range || 20, cover: 0, target: opts.target, battle: opts.battle }),
    opts.bloom ?? weapon.settled, shooter.speed,
  );
  const summary = { hits: 0, damage: 0, kills: 0, crits: 0, target: null };
  for (let i = 0; i < shots; i++) {
    jitterDirection(aimDir, sigma * (1 + i * (weapon.recoil || 0) * 8), rng, _jd);
    const r = fireRound(shooter, origin, _jd, opts);
    if (r.hit) {
      summary.hits++;
      summary.damage += r.damage;
      summary.target = r.unit;
      if (r.crit) summary.crits++;
      if (r.unit && (!r.unit.alive || r.unit.downed)) summary.kills++;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Explosions
// ---------------------------------------------------------------------------

/**
 * Radial damage with inverse-square-ish falloff and LOS occlusion from the blast centre.
 *
 * `power` is HP of damage AT THE EPICENTRE, falling to 0 at `radius` — the same number
 * the `explosion` Bus event carries (docs/ARCHITECTURE.md). Destructible cover is on the
 * same HP scale and is destroyed by exactly one owner: src/world/World listens for that
 * event and runs damageArea(). This function used to ALSO flatten every destructible in
 * radius itself, which both double-applied the blast and left structure meshes visible
 * with their colliders switched off.
 *
 * @param {THREE.Vector3} pos
 */
export function explode(pos, radius, power, opts = {}) {
  const units = opts.units || Ctx.units;
  const world = opts.world || Ctx.world;
  const source = opts.source || null;
  const aaPower = opts.aaPower ?? power * 0.5;
  Bus.emit('explosion', { pos: pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z), radius, power });
  Bus.emit('sfx', { name: 'explosion', pos });

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (!u.alive || !u.deployed || u.downed) continue;
    u.centerPoint(_b);
    const d = _b.distanceTo(pos);
    if (d > radius) continue;
    const f = 1 - clamp01(d / radius);
    let amt = (u.isVehicle ? aaPower : power) * (f * f * 0.7 + f * 0.3);
    // Walls between you and the blast really help.
    if (!hasLOS(pos.x, pos.y + 0.4, pos.z, _b.x, _b.y, _b.z, world)) amt *= 0.3;
    amt *= 1 - clamp01(u.defense * 0.5);
    if (u.isVehicle) amt *= 1 - clamp01(u.armour * 0.8);
    _defCtx.cover = 0; _defCtx.battle = opts.battle || Ctx.battle; _defCtx.underFire = true; _defCtx.attacker = source;
    amt *= u.evalPotentials('defend', _defCtx).def;
    if (amt >= 1) u.takeDamage(amt, source, { crit: false, part: 'blast', worldPos: _b, kind: 'blast' });
  }
  // Cover destruction is NOT done here — see the note above. If the integrator ever runs
  // this without a World on the Bus, `opts.destroyCover` forces the fallback.
  if (opts.destroyCover === true && world?.damageArea) {
    world.damageArea(pos, radius, power);
  }
}

// ---------------------------------------------------------------------------
// Grenade ballistics — solved arc, and the predicted path the HUD draws.
// ---------------------------------------------------------------------------

/**
 * Launch velocity to land a projectile at `target` from `origin` with speed `v`.
 * Picks the low arc; falls back to a 45° lob when out of range.
 * @returns {THREE.Vector3|null} velocity (shared scratch — copy it)
 */
const _lv = new THREE.Vector3();
export function solveArc(origin, target, v, g = Physics.gravity) {
  const dx = target.x - origin.x, dy = target.y - origin.y, dz = target.z - origin.z;
  const flat = Math.sqrt(dx * dx + dz * dz);
  if (flat < 1e-4) return _lv.set(0, v, 0);
  const v2 = v * v, v4 = v2 * v2;
  const disc = v4 - g * (g * flat * flat + 2 * dy * v2);
  let theta;
  if (disc < 0) theta = Math.PI / 4;                       // out of range: max-distance lob
  else theta = Math.atan((v2 - Math.sqrt(disc)) / (g * flat));
  const cs = Math.cos(theta), sn = Math.sin(theta);
  return _lv.set((dx / flat) * v * cs, v * sn, (dz / flat) * v * cs);
}

/**
 * Integrate a grenade path, stopping at the first world hit. Fills `out` with Vector3s
 * (reused across calls — the caller owns the array).
 * @returns number of valid points
 */
export function predictArc(origin, vel, out, maxPoints = 48, dt = 0.06, world = Ctx.world) {
  let px = origin.x, py = origin.y, pz = origin.z;
  let vx = vel.x, vy = vel.y, vz = vel.z;
  const g = Physics.gravity;
  let n = 0;
  for (let i = 0; i < maxPoints; i++) {
    const nx = px + vx * dt, ny = py + vy * dt - 0.5 * g * dt * dt, nz = pz + vz * dt;
    vy -= g * dt;
    const seg = Math.sqrt((nx - px) ** 2 + (ny - py) ** 2 + (nz - pz) ** 2);
    if (seg > 1e-5) {
      const h = traceWorld(px, py, pz, (nx - px) / seg, (ny - py) / seg, (nz - pz) / seg, seg, world);
      if (h) {
        if (!out[n]) out[n] = new THREE.Vector3();
        out[n++].set(h.x, h.y, h.z);
        return n;
      }
    }
    px = nx; py = ny; pz = nz;
    if (!out[n]) out[n] = new THREE.Vector3();
    out[n++].set(px, py, pz);
    if (py < -50) break;
  }
  return n;
}

export { GRENADE };

// ---------------------------------------------------------------------------
// Static-geometry overlap, used by the movement resolvers in nav.js
// ---------------------------------------------------------------------------

/**
 * Is a vertical capsule of radius `r` at (x,y,z) intersecting solid world geometry?
 * Returns the penetration vector in `outPush` (world XZ) and the depth, or 0.
 */
export function colliderPush(x, y, z, r, height, outPush, world = Ctx.world) {
  const cols = world?.colliders;
  outPush.set(0, 0, 0);
  if (!cols) return 0;
  let depth = 0;
  const yTop = y + height;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (colInert(c) || c.walkOver) continue;
    if (c.type === 'sphere') {
      colCenter(c, _a);
      const rad = (c.radius ?? c.r ?? 0.5) + r;
      const dx = x - _a.x, dz = z - _a.z;
      if (_a.y > yTop || _a.y + (c.radius ?? 0.5) < y) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rad * rad || d2 < 1e-9) continue;
      const d = Math.sqrt(d2);
      const pen = rad - d;
      outPush.x += (dx / d) * pen; outPush.z += (dz / d) * pen;
      if (pen > depth) depth = pen;
    } else {
      colCenter(c, _a);
      colHalf(c, _b);
      if (_a.y - _b.y > yTop || _a.y + _b.y < y + 0.12) continue;   // step over low kerbs
      const yaw = colYaw(c);
      let lx = x - _a.x, lz = z - _a.z;
      if (yaw !== 0) {
        const cs = Math.cos(-yaw), sn = Math.sin(-yaw);
        const nx = lx * cs - lz * sn, nz = lx * sn + lz * cs;
        lx = nx; lz = nz;
      }
      const ex = _b.x + r, ez = _b.z + r;
      if (Math.abs(lx) >= ex || Math.abs(lz) >= ez) continue;
      const px = ex - Math.abs(lx), pz = ez - Math.abs(lz);
      let ox = 0, oz = 0;
      if (px < pz) { ox = Math.sign(lx || 1) * px; if (px > depth) depth = px; }
      else { oz = Math.sign(lz || 1) * pz; if (pz > depth) depth = pz; }
      if (yaw !== 0) {
        const cs = Math.cos(yaw), sn = Math.sin(yaw);
        const nx = ox * cs - oz * sn, nz = ox * sn + oz * cs;
        ox = nx; oz = nz;
      }
      outPush.x += ox; outPush.z += oz;
    }
  }
  return depth;
}

/** Height of the top face of the nearest collider under (x,z), or -Infinity. */
export function colliderTopAt(x, z, world = Ctx.world) {
  const cols = world?.colliders;
  if (!cols) return -Infinity;
  let top = -Infinity;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (colInert(c)) continue;
    colCenter(c, _a);
    colHalf(c, _b);
    const yaw = colYaw(c);
    let lx = x - _a.x, lz = z - _a.z;
    if (yaw !== 0) {
      const cs = Math.cos(-yaw), sn = Math.sin(-yaw);
      const nx = lx * cs - lz * sn, nz = lx * sn + lz * cs;
      lx = nx; lz = nz;
    }
    if (Math.abs(lx) <= _b.x && Math.abs(lz) <= _b.z) {
      const t = _a.y + _b.y;
      if (t > top) top = t;
    }
  }
  return top;
}

// ---------------------------------------------------------------------------
// Small helpers shared by ai.js / interception.js
// ---------------------------------------------------------------------------

/** Signed angle from a unit's facing to a world point, in [-PI, PI]. */
export function angleTo(unit, x, z) {
  const a = Math.atan2(x - unit.pos.x, z - unit.pos.z);
  let d = a - unit.yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Is `target` inside `unit`'s interception arc and range? */
export function inFireArc(unit, target) {
  const C = unit.classDef;
  const range = C.interceptRange || 0;
  if (range <= 0) return false;
  const d2 = unit.pos.distanceToSquared(target.pos);
  if (d2 > range * range) return false;
  const half = (C.interceptCone || CFG.gameplay.interceptCone) * 0.5;
  return Math.abs(angleTo(unit, target.pos.x, target.pos.z)) <= half;
}
