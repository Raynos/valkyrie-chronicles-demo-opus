// src/physics/collision.js
// Low-level collision primitives shared by ballistics, the rigid-body solver,
// explosions and the vehicle sim. Everything here is allocation-free at call
// time: results are written into caller-supplied (or module-scratch) objects.
//
// Collider shape assumed from the World contract:
//   { type:'box'|'sphere', ..., cover:0..1, destructible }
// The remaining fields are read tolerantly (see normalizeCollider) because
// src/world/ is authored by another agent; anything it plausibly names for a
// centre / half-extent / rotation is accepted.

import * as THREE from 'three';
import { clamp } from '../core/math.js';

// ---------------------------------------------------------------- scratch ---
// IMPORTANT: every function below owns its own scratch. These primitives call
// each other (capsuleVsWorld -> closestPointOnSegment -> ...) and several are
// invoked with a shared scratch vector as BOTH an input and the out-param, so
// a common scratch pool silently corrupts results. Each block is private and
// each function is written to read its inputs before writing its output.
const _sA = new THREE.Vector3();     // closestPointOnSegment
const _sB = new THREE.Vector3();     // closestPointOnBox
const _rsA = new THREE.Vector3();    // rayVsSphere
const _rbO = new THREE.Vector3();    // rayVsBox
const _rbD = new THREE.Vector3();
const _cA = new THREE.Vector3();     // rayVsCapsule
const _cB = new THREE.Vector3();
const _cC = new THREE.Vector3();
const _cD = new THREE.Vector3();
const _cE = new THREE.Vector3();
const _cF = new THREE.Vector3();
const _wA = new THREE.Vector3();     // sweptSphereVsBoxes
const _wB = new THREE.Vector3();
const _wC = new THREE.Vector3();
const _kA = new THREE.Vector3();     // capsuleVsWorld
const _kB = new THREE.Vector3();
const _kC = new THREE.Vector3();
const _kD = new THREE.Vector3();
const _kE = new THREE.Vector3();
const _lA = new THREE.Vector3();     // lineOfSight

/** Surface materials — consumed by FX (impact decals, sparks) and audio. */
export const SURFACE = {
  DIRT: 'dirt',
  GRASS: 'grass',
  STONE: 'stone',
  BRICK: 'brick',
  WOOD: 'wood',
  METAL: 'metal',
  SANDBAG: 'sandbag',
  WATER: 'water',
  FLESH: 'flesh',
};

/** Armour thickness (mm-ish, arbitrary but consistent) used for penetration. */
export const SURFACE_HARDNESS = {
  dirt: 18, grass: 8, stone: 90, brick: 55, wood: 22,
  metal: 70, sandbag: 40, water: 4, flesh: 6,
};

/** Rich hit record. Pooled — never hold one across frames without `clone()`. */
export class Hit {
  constructor() {
    this.point = new THREE.Vector3();
    this.normal = new THREE.Vector3(0, 1, 0);
    this.distance = Infinity;
    this.material = SURFACE.DIRT;
    this.collider = null;   // world collider that was struck (null for terrain)
    this.unit = null;       // game Unit struck, if any
    this.bodypart = null;   // 'head'|'torso'|'legs'|'hull'|'turret'|'track'|'radiator'
    this.penetrated = false;// did the projectile punch through cover?
    this.cover = 0;         // cover value of what was struck, 0..1
    this.kind = 'none';     // 'terrain'|'collider'|'unit'|'none'
  }
  reset() {
    this.distance = Infinity;
    this.material = SURFACE.DIRT;
    this.collider = null;
    this.unit = null;
    this.bodypart = null;
    this.penetrated = false;
    this.cover = 0;
    this.kind = 'none';
    return this;
  }
  copy(o) {
    this.point.copy(o.point); this.normal.copy(o.normal);
    this.distance = o.distance; this.material = o.material;
    this.collider = o.collider; this.unit = o.unit; this.bodypart = o.bodypart;
    this.penetrated = o.penetrated; this.cover = o.cover; this.kind = o.kind;
    return this;
  }
  clone() { return new Hit().copy(this); }
}

const _hitA = new Hit();
const _hitB = new Hit();

// ------------------------------------------------------- collider caching ---

// Normalised colliders live on the collider object itself under `__phys` so the
// world can keep authoring plain data. `collider.version` (optional) busts it.
export function normalizeCollider(c) {
  const ver = c.version | 0;
  let n = c.__phys;
  if (n && n.version === ver) return n;
  if (!n) {
    n = c.__phys = {
      version: -1,
      type: 'box',
      center: new THREE.Vector3(),
      half: new THREE.Vector3(0.5, 0.5, 0.5),
      radius: 0.5,
      quat: new THREE.Quaternion(),
      invQuat: new THREE.Quaternion(),
      axisAligned: true,
      boundRadius: 1,
      material: SURFACE.STONE,
      cover: 0,
      destructible: false,
      hardness: 90,
      ref: c,
    };
  }
  n.version = ver;
  n.type = c.type === 'sphere' ? 'sphere' : 'box';

  const ctr = c.center || c.pos || c.position;
  if (ctr) n.center.set(ctr.x || 0, ctr.y || 0, ctr.z || 0);
  else n.center.set(0, 0, 0);

  if (n.type === 'sphere') {
    n.radius = c.radius ?? c.r ?? 0.5;
    n.half.setScalar(n.radius);
    n.boundRadius = n.radius;
    n.axisAligned = true;
    n.quat.identity(); n.invQuat.identity();
  } else {
    const he = c.halfExtents || c.half || c.he;
    if (he) n.half.set(he.x, he.y, he.z);
    else if (c.size) n.half.set(c.size.x * 0.5, c.size.y * 0.5, c.size.z * 0.5);
    else n.half.set(c.hx ?? 0.5, c.hy ?? 0.5, c.hz ?? 0.5);
    const qq = c.quaternion || c.quat;
    if (qq) {
      n.quat.set(qq.x, qq.y, qq.z, qq.w);
      n.axisAligned = Math.abs(n.quat.x) + Math.abs(n.quat.z) < 1e-5 && Math.abs(n.quat.y) < 1e-5;
    } else if (c.yaw) {
      n.quat.setFromAxisAngle(UP, c.yaw);
      n.axisAligned = Math.abs(c.yaw) < 1e-5;
    } else {
      n.quat.identity();
      n.axisAligned = true;
    }
    n.invQuat.copy(n.quat).invert();
    n.boundRadius = n.half.length();
  }
  n.material = c.material || c.mat || SURFACE.STONE;
  n.cover = c.cover ?? 0;
  n.destructible = !!c.destructible;
  n.hardness = c.hardness ?? SURFACE_HARDNESS[n.material] ?? 60;
  return n;
}

export const UP = /*@__PURE__*/ new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------- primitives ---

/** Closest point on segment [p0,p1] to point q. Writes into `out`. */
export function closestPointOnSegment(p0, p1, q, out) {
  _a.subVectors(p1, p0);
  const len2 = _a.lengthSq();
  if (len2 < 1e-12) return out.copy(p0);
  let t = _b.subVectors(q, p0).dot(_a) / len2;
  t = clamp(t, 0, 1);
  return out.copy(p0).addScaledVector(_a, t);
}

/** Closest point on an (optionally rotated) box to world point q. */
export function closestPointOnBox(box, q, out) {
  _a.subVectors(q, box.center);
  if (!box.axisAligned) _a.applyQuaternion(box.invQuat);
  _a.set(
    clamp(_a.x, -box.half.x, box.half.x),
    clamp(_a.y, -box.half.y, box.half.y),
    clamp(_a.z, -box.half.z, box.half.z)
  );
  if (!box.axisAligned) _a.applyQuaternion(box.quat);
  return out.copy(box.center).add(_a);
}

/**
 * Ray vs oriented box. Returns entry distance or -1.
 * `outNormal` receives the world-space face normal.
 */
export function rayVsBox(origin, dir, maxDist, box, outNormal) {
  _ro.subVectors(origin, box.center);
  _rd.copy(dir);
  if (!box.axisAligned) {
    _ro.applyQuaternion(box.invQuat);
    _rd.applyQuaternion(box.invQuat);
  }
  let tmin = 0, tmax = maxDist;
  let axis = 0, sign = 1;
  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? _ro.x : i === 1 ? _ro.y : _ro.z;
    const d = i === 0 ? _rd.x : i === 1 ? _rd.y : _rd.z;
    const h = i === 0 ? box.half.x : i === 1 ? box.half.y : box.half.z;
    if (Math.abs(d) < 1e-8) {
      if (o < -h || o > h) return -1;
      continue;
    }
    const inv = 1 / d;
    let t1 = (-h - o) * inv;
    let t2 = (h - o) * inv;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (outNormal) {
    outNormal.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
    if (!box.axisAligned) outNormal.applyQuaternion(box.quat);
  }
  return tmin;
}

/** Ray vs sphere. Returns entry distance or -1. */
export function rayVsSphere(origin, dir, maxDist, center, radius, outNormal) {
  _a.subVectors(origin, center);
  const b = _a.dot(dir);
  const c = _a.lengthSq() - radius * radius;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0 || t > maxDist) return -1;
  if (outNormal) outNormal.copy(dir).multiplyScalar(t).add(origin).sub(center).divideScalar(radius);
  return t;
}

/** Ray vs capsule (segment p0..p1 with radius). Returns distance or -1. */
export function rayVsCapsule(origin, dir, maxDist, p0, p1, radius, outNormal) {
  // Solve against the infinite cylinder, then clamp to the segment and fall
  // back to the two end spheres. Cheap and exact enough for hitboxes.
  _a.subVectors(p1, p0);          // axis
  const axLen2 = _a.lengthSq();
  if (axLen2 < 1e-10) return rayVsSphere(origin, dir, maxDist, p0, radius, outNormal);
  _b.subVectors(origin, p0);
  const dA = dir.dot(_a), mA = _b.dot(_a);
  const A = axLen2 - dA * dA;
  const B = axLen2 * _b.dot(dir) - mA * dA;
  const C = axLen2 * _b.lengthSq() - mA * mA - radius * radius * axLen2;
  let best = -1;
  if (Math.abs(A) > 1e-8) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / A;
      if (t >= 0 && t <= maxDist) {
        const m = mA + t * dA;
        if (m >= 0 && m <= axLen2) {
          best = t;
          if (outNormal) {
            _c.copy(dir).multiplyScalar(t).add(origin);
            _d.copy(p0).addScaledVector(_a, m / axLen2);
            outNormal.subVectors(_c, _d).normalize();
          }
        }
      }
    }
  }
  if (best < 0) {
    const t0 = rayVsSphere(origin, dir, maxDist, p0, radius, _e);
    const t1 = rayVsSphere(origin, dir, maxDist, p1, radius, _f);
    if (t0 >= 0 && (t1 < 0 || t0 < t1)) { best = t0; if (outNormal) outNormal.copy(_e); }
    else if (t1 >= 0) { best = t1; if (outNormal) outNormal.copy(_f); }
  }
  return best;
}

// ------------------------------------------------------------- swept tests ---

/**
 * Swept sphere against a list of world colliders.
 * Boxes are Minkowski-expanded by the sphere radius (rounded corners are
 * approximated by the expanded box, which errs slightly conservative — exactly
 * what you want for a projectile).
 *
 * @param {THREE.Vector3} origin
 * @param {THREE.Vector3} dir        normalised
 * @param {number} maxDist
 * @param {number} radius
 * @param {Array}  colliders         raw world colliders
 * @param {Hit}    out               result (untouched if no hit)
 * @returns {boolean} true if something was hit
 */
export function sweptSphereVsBoxes(origin, dir, maxDist, radius, colliders, out = _hitA, filter = null) {
  let bestT = maxDist;
  let bestC = null;
  let hitAny = false;
  for (let i = 0; i < colliders.length; i++) {
    const raw = colliders[i];
    if (raw.disabled || raw.dead) continue;
    if (filter && !filter(raw)) continue;
    const box = normalizeCollider(raw);

    // Broad phase: distance from segment to collider centre.
    closestPointOnSegment(origin, _c.copy(origin).addScaledVector(dir, bestT), box.center, _d);
    if (_d.distanceToSquared(box.center) > (box.boundRadius + radius) * (box.boundRadius + radius)) continue;

    let t = -1;
    if (box.type === 'sphere') {
      t = rayVsSphere(origin, dir, bestT, box.center, box.radius + radius, _e);
    } else {
      const savedX = box.half.x, savedY = box.half.y, savedZ = box.half.z;
      box.half.set(savedX + radius, savedY + radius, savedZ + radius);
      t = rayVsBox(origin, dir, bestT, box, _e);
      box.half.set(savedX, savedY, savedZ);
    }
    if (t >= 0 && t < bestT) {
      bestT = t;
      bestC = box;
      hitAny = true;
      out.normal.copy(_e);
    }
  }
  if (hitAny) {
    out.distance = bestT;
    out.point.copy(origin).addScaledVector(dir, bestT);
    out.collider = bestC.ref;
    out.material = bestC.material;
    out.cover = bestC.cover;
    out.unit = null;
    out.bodypart = null;
    out.penetrated = false;
    out.kind = 'collider';
  }
  return hitAny;
}

/**
 * Ray vs terrain heightfield. Adaptive marching on f(t) = p.y - h(p.xz),
 * refined by bisection once the sign flips. Handles origins already below
 * ground (returns an immediate hit so projectiles can't tunnel out of a hill).
 *
 * @returns {boolean} true on hit, filling `out`.
 */
export function rayVsHeightfield(terrain, origin, dir, maxDist, out = _hitA, opts) {
  if (!terrain || !terrain.heightAt) return false;
  const minStep = (opts && opts.minStep) || 0.25;
  const maxStep = (opts && opts.maxStep) || 6.0;

  let t = 0;
  let px = origin.x, py = origin.y, pz = origin.z;
  let f = py - terrain.heightAt(px, pz);
  if (f <= 0) {
    out.distance = 0;
    out.point.set(px, py, pz);
    fillTerrainNormal(terrain, out, px, pz);
    out.kind = 'terrain'; out.collider = null; out.unit = null; out.bodypart = null;
    out.cover = 0; out.penetrated = false;
    out.material = terrainMaterial(terrain, px, pz);
    return true;
  }
  let prevT = 0, prevF = f;
  // Vertical closing rate bounds the safe step: steep terrain needs small steps,
  // so scale by the horizontal component of the ray as well.
  const horiz = Math.hypot(dir.x, dir.z);
  while (t < maxDist) {
    const step = clamp(f * 0.7 / Math.max(0.15, -dir.y + horiz * 0.9), minStep, maxStep);
    t = Math.min(t + step, maxDist);
    px = origin.x + dir.x * t; py = origin.y + dir.y * t; pz = origin.z + dir.z * t;
    f = py - terrain.heightAt(px, pz);
    if (f <= 0) {
      // Bisect between prevT (above) and t (below).
      let lo = prevT, hi = t, loF = prevF;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) * 0.5;
        const mx = origin.x + dir.x * mid, my = origin.y + dir.y * mid, mz = origin.z + dir.z * mid;
        const mf = my - terrain.heightAt(mx, mz);
        if (mf > 0) { lo = mid; loF = mf; } else hi = mid;
      }
      void loF;
      out.distance = hi;
      out.point.set(origin.x + dir.x * hi, origin.y + dir.y * hi, origin.z + dir.z * hi);
      fillTerrainNormal(terrain, out, out.point.x, out.point.z);
      out.kind = 'terrain'; out.collider = null; out.unit = null; out.bodypart = null;
      out.cover = 0; out.penetrated = false;
      out.material = terrainMaterial(terrain, out.point.x, out.point.z);
      return true;
    }
    prevT = t; prevF = f;
    if (t >= maxDist) break;
  }
  return false;
}

function fillTerrainNormal(terrain, out, x, z) {
  if (terrain.normalAt) {
    const n = terrain.normalAt(x, z);
    out.normal.set(n.x, n.y, n.z);
    if (out.normal.lengthSq() < 1e-6) out.normal.set(0, 1, 0);
  } else {
    const e = 0.5;
    const hL = terrain.heightAt(x - e, z), hR = terrain.heightAt(x + e, z);
    const hD = terrain.heightAt(x, z - e), hU = terrain.heightAt(x, z + e);
    out.normal.set(hL - hR, 2 * e, hD - hU).normalize();
  }
}

function terrainMaterial(terrain, x, z) {
  if (terrain.materialAt) return terrain.materialAt(x, z) || SURFACE.DIRT;
  const s = terrain.slopeAt ? terrain.slopeAt(x, z) : 0;
  return s > 0.62 ? SURFACE.STONE : SURFACE.GRASS;
}

/**
 * Resolve a vertical capsule (feet p0, head p1, radius r) against the whole
 * world: terrain floor + every collider. Accumulates a minimum-translation
 * vector into `out.mtv` and reports ground contact.
 *
 * @returns {{hit:boolean, mtv:THREE.Vector3, grounded:boolean,
 *            groundNormal:THREE.Vector3, groundHeight:number, contacts:number}}
 */
const _capOut = {
  hit: false,
  mtv: new THREE.Vector3(),
  grounded: false,
  groundNormal: new THREE.Vector3(0, 1, 0),
  groundHeight: 0,
  contacts: 0,
};
// fillTerrainNormal writes into `.normal`; keep a private holder so callers may
// pass any plain object as `out`.
const _nrm = { normal: new THREE.Vector3(0, 1, 0) };
export function capsuleVsWorld(p0, p1, radius, world, out = _capOut) {
  out.hit = false;
  out.mtv.set(0, 0, 0);
  out.grounded = false;
  out.contacts = 0;
  out.groundNormal.set(0, 1, 0);

  const terrain = world && world.terrain;
  if (terrain && terrain.heightAt) {
    const h = terrain.heightAt(p0.x, p0.z);
    out.groundHeight = h;
    const pen = h - (p0.y - radius);
    if (pen > 0) {
      out.hit = true;
      out.grounded = true;
      out.contacts++;
      fillTerrainNormal(terrain, _nrm, p0.x, p0.z);
      out.groundNormal.copy(_nrm.normal);
      out.mtv.y += pen;
    } else if (pen > -0.06) {
      out.grounded = true;
      fillTerrainNormal(terrain, _nrm, p0.x, p0.z);
      out.groundNormal.copy(_nrm.normal);
    }
  }

  const cols = (world && world.colliders) || null;
  if (cols) {
    for (let i = 0; i < cols.length; i++) {
      const raw = cols[i];
      if (raw.disabled || raw.dead || raw.noCollide) continue;
      const box = normalizeCollider(raw);
      // Closest point on the capsule axis to the collider, then on the collider.
      closestPointOnSegment(p0, p1, box.center, _a);
      if (box.type === 'sphere') {
        _b.copy(box.center);
        const dist = _a.distanceTo(_b);
        const pen = box.radius + radius - dist;
        if (pen > 0) {
          _c.subVectors(_a, _b);
          if (_c.lengthSq() < 1e-10) _c.set(0, 1, 0); else _c.normalize();
          out.mtv.addScaledVector(_c, pen);
          out.hit = true; out.contacts++;
        }
        continue;
      }
      closestPointOnBox(box, _a, _b);
      // Re-project once: improves accuracy on long capsules against big boxes.
      closestPointOnSegment(p0, p1, _b, _a);
      closestPointOnBox(box, _a, _b);
      _c.subVectors(_a, _b);
      const d2 = _c.lengthSq();
      if (d2 < radius * radius) {
        let pen, nx, ny, nz;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          pen = radius - d;
          nx = _c.x / d; ny = _c.y / d; nz = _c.z / d;
        } else {
          // Deep inside: push out along the shallowest box axis.
          _d.subVectors(_a, box.center);
          if (!box.axisAligned) _d.applyQuaternion(box.invQuat);
          const ox = box.half.x - Math.abs(_d.x);
          const oy = box.half.y - Math.abs(_d.y);
          const oz = box.half.z - Math.abs(_d.z);
          _e.set(0, 0, 0);
          if (ox <= oy && ox <= oz) { _e.x = Math.sign(_d.x) || 1; pen = ox + radius; }
          else if (oy <= oz) { _e.y = Math.sign(_d.y) || 1; pen = oy + radius; }
          else { _e.z = Math.sign(_d.z) || 1; pen = oz + radius; }
          if (!box.axisAligned) _e.applyQuaternion(box.quat);
          nx = _e.x; ny = _e.y; nz = _e.z;
        }
        out.mtv.x += nx * pen; out.mtv.y += ny * pen; out.mtv.z += nz * pen;
        out.hit = true; out.contacts++;
        if (ny > 0.65) { out.grounded = true; out.groundNormal.set(nx, ny, nz); }
      }
    }
  }
  return out;
}
/**
 * Line-of-sight test against world colliders + terrain.
 * @returns {number} 0 = fully blocked .. 1 = clear. Partial cover attenuates.
 */
export function lineOfSight(world, from, to, ignoreCollider = null) {
  _a.subVectors(to, from);
  const dist = _a.length();
  if (dist < 1e-4) return 1;
  _a.divideScalar(dist);
  let vis = 1;
  const cols = (world && world.colliders) || null;
  if (cols) {
    for (let i = 0; i < cols.length; i++) {
      const raw = cols[i];
      if (raw === ignoreCollider || raw.disabled || raw.dead || raw.noBlockLos) continue;
      const box = normalizeCollider(raw);
      let t;
      if (box.type === 'sphere') t = rayVsSphere(from, _a, dist, box.center, box.radius, null);
      else t = rayVsBox(from, _a, dist, box, null);
      // t ~ 0 means the ray *starts* inside this collider (a grenade landed on
      // the sandbag it is meant to be clearing). It cannot occlude itself.
      if (t > 0.06 && t < dist - 0.06) {
        // A half-cover wall lets fragments past; full cover stops them.
        vis *= 1 - clamp(box.cover > 0 ? box.cover : 0.85, 0, 1);
        if (vis <= 0.02) return 0;
      }
    }
  }
  if (world && world.terrain && rayVsHeightfield(world.terrain, from, _a, dist, _hitB)) {
    if (_hitB.distance < dist - 0.15) return 0;
  }
  return vis;
}

/** Shared scratch hits so callers can borrow one without allocating. */
export const SCRATCH_HIT = _hitA;
export const SCRATCH_HIT_B = _hitB;
