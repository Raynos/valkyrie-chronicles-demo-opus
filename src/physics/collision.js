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
const _lB = new THREE.Vector3();

/** Surface materials — consumed by FX (impact decals, sparks) and audio. */
export const SURFACE = {
  DIRT: 'dirt',
  GRASS: 'grass',
  ROCK: 'rock',
  MUD: 'mud',
  STONE: 'stone',
  BRICK: 'brick',
  WOOD: 'wood',
  METAL: 'metal',
  SANDBAG: 'sandbag',
  WATER: 'water',
  FLESH: 'flesh',
};

/**
 * Maps a world collider's `tag` to an impact surface. The world module tags
 * colliders semantically rather than by material, so this is the bridge.
 */
export const TAG_SURFACE = {
  sandbag: SURFACE.SANDBAG,
  building: SURFACE.BRICK,
  wall: SURFACE.BRICK,
  rubble: SURFACE.STONE,
  wire: SURFACE.METAL,
  crate: SURFACE.WOOD,
  fence: SURFACE.WOOD,
  tree: SURFACE.WOOD,
  hedgehog: SURFACE.METAL,
  barrel: SURFACE.METAL,
  vehicle: SURFACE.METAL,
  rock: SURFACE.STONE,

  // THE OTHER ELEVEN TAGS THE MAP ACTUALLY EMITS.
  //
  // normalizeCollider falls back to SURFACE.STONE (hardness 90) for any tag not
  // listed here, so hay bales, hedges and telegraph poles were all as hard as
  // ashlar — which is both the wrong impact FX and the wrong penetration answer.
  // This list is the complete set of `tag:` literals in src/world and src/game;
  // if you add a collider tag, add it here too or it silently becomes granite.
  hay: SURFACE.GRASS,        // straw: soft, and a round goes through it
  hedge: SURFACE.GRASS,
  bush: SURFACE.GRASS,
  cart: SURFACE.WOOD,
  crates: SURFACE.WOOD,      // the plural tag; `crate` above is the singular one
  pole: SURFACE.WOOD,        // telegraph poles
  sign: SURFACE.WOOD,
  drum: SURFACE.METAL,
  wreck: SURFACE.METAL,
  parapet: SURFACE.STONE,    // the bridge's masonry parapet
  bridge: SURFACE.STONE,
  well: SURFACE.STONE,
  windmill: SURFACE.STONE,
  tooth: SURFACE.STONE,      // concrete anti-tank teeth
};

/** Armour thickness (mm-ish, arbitrary but consistent) used for penetration. */
export const SURFACE_HARDNESS = {
  dirt: 18, grass: 8, rock: 95, mud: 14, stone: 90, brick: 55, wood: 22,
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
  if (n && n.version === ver) {
    // These flip at runtime as a prop is shot to pieces (a sandbag revetment
    // sheds cover long before it dies), so refresh them unconditionally.
    n.solid = c.solid !== false;
    n.blocksLos = c.blocksLos !== false;
    n.blocksProjectile = c.blocksProjectile !== undefined
      ? !!c.blocksProjectile : (n.solid || n.blocksLos);
    n.destroyed = !!c.destroyed;
    n.cover = c.cover ?? 0;
    return n;
  }
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
      solid: true,
      blocksLos: true,
      blocksProjectile: true,
      destroyed: false,
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
  n.material = c.material || c.mat || TAG_SURFACE[c.tag] || SURFACE.STONE;
  n.cover = c.cover ?? 0;
  // The world module's own semantics (src/world/collider.js): `solid` gates
  // BODIES, `blocksLos` gates SIGHT, `blocksProjectile` gates BULLETS — three
  // independent questions. `destroyed` is the single switch that clears all of
  // them; a destroyed prop keeps its record so it can be rebuilt.
  n.solid = c.solid !== false;
  n.blocksLos = c.blocksLos !== false;
  n.blocksProjectile = c.blocksProjectile !== undefined
    ? !!c.blocksProjectile : (n.solid || n.blocksLos);
  n.destroyed = !!c.destroyed;
  n.destructible = !!c.destructible;
  n.hardness = c.hardness ?? SURFACE_HARDNESS[n.material] ?? 60;
  return n;
}

export const UP = /*@__PURE__*/ new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------- primitives ---

/** Closest point on segment [p0,p1] to point q. Alias-safe: `out` may be `q`. */
export function closestPointOnSegment(p0, p1, q, out) {
  _sA.subVectors(p1, p0);
  const len2 = _sA.lengthSq();
  if (len2 < 1e-12) return out.copy(p0);
  const t = clamp(
    ((q.x - p0.x) * _sA.x + (q.y - p0.y) * _sA.y + (q.z - p0.z) * _sA.z) / len2, 0, 1);
  return out.set(p0.x + _sA.x * t, p0.y + _sA.y * t, p0.z + _sA.z * t);
}

/** Closest point on an (optionally rotated) box to world point q. Alias-safe. */
export function closestPointOnBox(box, q, out) {
  _sB.subVectors(q, box.center);
  if (!box.axisAligned) _sB.applyQuaternion(box.invQuat);
  _sB.set(
    clamp(_sB.x, -box.half.x, box.half.x),
    clamp(_sB.y, -box.half.y, box.half.y),
    clamp(_sB.z, -box.half.z, box.half.z)
  );
  if (!box.axisAligned) _sB.applyQuaternion(box.quat);
  return out.copy(box.center).add(_sB);
}

/**
 * Ray vs oriented box. Returns entry distance or -1.
 * `outNormal` receives the world-space face normal.
 */
export function rayVsBox(origin, dir, maxDist, box, outNormal) {
  _rbO.subVectors(origin, box.center);
  _rbD.copy(dir);
  if (!box.axisAligned) {
    _rbO.applyQuaternion(box.invQuat);
    _rbD.applyQuaternion(box.invQuat);
  }
  let tmin = 0, tmax = maxDist;
  let axis = 0, sign = 1;
  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? _rbO.x : i === 1 ? _rbO.y : _rbO.z;
    const d = i === 0 ? _rbD.x : i === 1 ? _rbD.y : _rbD.z;
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
  _rsA.subVectors(origin, center);
  const b = _rsA.dot(dir);
  const c = _rsA.lengthSq() - radius * radius;
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
  _cA.subVectors(p1, p0);          // axis
  const axLen2 = _cA.lengthSq();
  if (axLen2 < 1e-10) return rayVsSphere(origin, dir, maxDist, p0, radius, outNormal);
  _cB.subVectors(origin, p0);
  const dA = dir.dot(_cA), mA = _cB.dot(_cA);
  const A = axLen2 - dA * dA;
  const B = axLen2 * _cB.dot(dir) - mA * dA;
  const C = axLen2 * _cB.lengthSq() - mA * mA - radius * radius * axLen2;
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
            _cC.copy(dir).multiplyScalar(t).add(origin);
            _cD.copy(p0).addScaledVector(_cA, m / axLen2);
            outNormal.subVectors(_cC, _cD).normalize();
          }
        }
      }
    }
  }
  if (best < 0) {
    const t0 = rayVsSphere(origin, dir, maxDist, p0, radius, _cE);
    const t1 = rayVsSphere(origin, dir, maxDist, p1, radius, _cF);
    if (t0 >= 0 && (t1 < 0 || t0 < t1)) { best = t0; if (outNormal) outNormal.copy(_cE); }
    else if (t1 >= 0) { best = t1; if (outNormal) outNormal.copy(_cF); }
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
 * @param {?function} filter         when supplied it OWNS the accept/reject
 *   decision. THE DEFAULT GATE IS `blocksProjectile`, not `solid`: this test is
 *   the projectile sweep (that is what the Minkowski expansion above is for),
 *   and a bullet's question is not a body's question — barbed wire stops a man
 *   and not a round. Callers doing a physical probe (where can I stand?) must
 *   pass a `solid` filter; see groundUnder() in ./index.js.
 * @returns {boolean} true if something was hit
 */
export function sweptSphereVsBoxes(origin, dir, maxDist, radius, colliders, out = _hitA, filter = null) {
  let bestT = maxDist;
  let bestC = null;
  let hitAny = false;
  for (let i = 0; i < colliders.length; i++) {
    const raw = colliders[i];
    if (raw.disabled || raw.dead || raw.destroyed) continue;
    if (filter && !filter(raw)) continue;
    const box = normalizeCollider(raw);
    if (!filter && !box.blocksProjectile) continue;   // wire, foliage, destroyed props

    // Broad phase: distance from segment to collider centre.
    closestPointOnSegment(origin, _wB.copy(origin).addScaledVector(dir, bestT), box.center, _wC);
    if (_wC.distanceToSquared(box.center) > (box.boundRadius + radius) * (box.boundRadius + radius)) continue;

    let t = -1;
    if (box.type === 'sphere') {
      t = rayVsSphere(origin, dir, bestT, box.center, box.radius + radius, _wA);
    } else {
      const savedX = box.half.x, savedY = box.half.y, savedZ = box.half.z;
      box.half.set(savedX + radius, savedY + radius, savedZ + radius);
      t = rayVsBox(origin, dir, bestT, box, _wA);
      box.half.set(savedX, savedY, savedZ);
    }
    if (t >= 0 && t < bestT) {
      bestT = t;
      bestC = box;
      hitAny = true;
      out.normal.copy(_wA);
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
    // Terrain.normalAt(x, z, out) fills the out-param, which keeps this
    // allocation-free on the projectile hot path. The ARCHITECTURE contract
    // only promises `normalAt(x, z): Vector3` though, so also accept an
    // implementation that ignores the out-param and returns a fresh vector.
    const n = terrain.normalAt(x, z, out.normal);
    if (n && n !== out.normal) out.normal.set(n.x, n.y, n.z);
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
  // Terrain.slopeAt returns radians from vertical; ~35 deg reads as bare rock.
  const s = terrain.slopeAt ? terrain.slopeAt(x, z) : 0;
  return s > 0.62 ? SURFACE.ROCK : SURFACE.GRASS;
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
      if (raw.disabled || raw.dead || raw.noCollide || raw.destroyed) continue;
      const box = normalizeCollider(raw);
      if (!box.solid) continue;
      // Closest point on the capsule axis to the collider, then on the collider.
      closestPointOnSegment(p0, p1, box.center, _kA);
      if (box.type === 'sphere') {
        _kB.copy(box.center);
        const dist = _kA.distanceTo(_kB);
        const pen = box.radius + radius - dist;
        if (pen > 0) {
          _kC.subVectors(_kA, _kB);
          if (_kC.lengthSq() < 1e-10) _kC.set(0, 1, 0); else _kC.normalize();
          out.mtv.addScaledVector(_kC, pen);
          out.hit = true; out.contacts++;
        }
        continue;
      }
      closestPointOnBox(box, _kA, _kB);
      // Re-project once: improves accuracy on long capsules against big boxes.
      closestPointOnSegment(p0, p1, _kB, _kA);
      closestPointOnBox(box, _kA, _kB);
      _kC.subVectors(_kA, _kB);
      const d2 = _kC.lengthSq();
      if (d2 < radius * radius) {
        let pen, nx, ny, nz;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          pen = radius - d;
          nx = _kC.x / d; ny = _kC.y / d; nz = _kC.z / d;
        } else {
          // Deep inside: push out along the shallowest box axis — but NEVER
          // downwards. A body that has ended up inside a solid volume came in
          // from the side or the top; the floor the volume stands on is the one
          // direction it cannot leave through. Measured before this guard: a
          // 0.35 m capsule in the village wall cluster got an mtv of
          // (-0.24, -1.77, 0.60) — 1.8 m straight into the terrain — and the
          // tank's hull capsule half inside a building got (0, -2.07, 0), which
          // TankPhysics._collide discards as "the ride model owns Y", leaving
          // the Edelweiss parked inside the house with zero push-out.
          _kD.subVectors(_kA, box.center);
          if (!box.axisAligned) _kD.applyQuaternion(box.invQuat);
          const ox = box.half.x - Math.abs(_kD.x);
          const oy = box.half.y - Math.abs(_kD.y);
          const oz = box.half.z - Math.abs(_kD.z);
          // Only consider the Y escape when it points up out of the volume.
          const oyUp = _kD.y >= 0 ? oy : Infinity;
          _kE.set(0, 0, 0);
          if (ox <= oyUp && ox <= oz) { _kE.x = Math.sign(_kD.x) || 1; pen = ox + radius; }
          else if (oyUp <= oz) { _kE.y = 1; pen = oy + radius; }
          else { _kE.z = Math.sign(_kD.z) || 1; pen = oz + radius; }
          if (!box.axisAligned) _kE.applyQuaternion(box.quat);
          nx = _kE.x; ny = _kE.y; nz = _kE.z;
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
 * How far a ray origin sitting on (or a hair under) the heightfield is lifted
 * before the terrain occlusion test runs. See lineOfSight.
 *
 * rayVsHeightfield deliberately reports an origin at or below ground as an
 * immediate hit at t = 0 so a projectile cannot tunnel out of a hill. For a
 * SIGHT ray that rule is wrong, and it was silently quartering every explosion
 * in the game: `Ballistics._detonate` passes `hit.point`, and a terrain hit
 * point comes out of the bisection on the *below* side of the surface, so
 * `p.y - heightAt(p.xz)` is exactly 0 or a hair negative for every shell and
 * grenade that lands on the ground. lineOfSight therefore returned 0 — fully
 * blocked — for a blast standing in the open, and Explosions.detonate scales by
 * `0.25 + 0.75 * los`. Measured: los 1.0 at 2 cm above the surface, 0.0 at the
 * real detonation point.
 *
 * A quarter of a metre is under every wall, parapet and sandbag line on the
 * map, so lifting by it cannot see over cover, and a blast on the far side of a
 * crest still reads as blocked because the lifted ray still marches into the
 * crest. Anything more than LOS_BURIED_DEPTH under the surface is genuinely
 * inside a hill and keeps the old behaviour.
 */
export const LOS_GROUND_LIFT = 0.25;
/** Deeper than this under the heightfield is genuinely inside a hill: no lift. */
export const LOS_BURIED_DEPTH = 1.0;

/**
 * Line-of-sight test against world colliders + terrain.
 * @returns {number} 0 = fully blocked .. 1 = clear. Partial cover attenuates.
 */
export function lineOfSight(world, from, to, ignoreCollider = null) {
  const terrain = (world && world.terrain) || null;
  // Lift an origin that is sitting on the ground out of the surface first — see
  // LOS_GROUND_LIFT. Everything below traces from `start`, not `from`.
  let start = from;
  if (terrain && terrain.heightAt) {
    const gh = terrain.heightAt(from.x, from.z);
    if (from.y < gh + LOS_GROUND_LIFT && from.y > gh - LOS_BURIED_DEPTH) {
      start = _lB.set(from.x, gh + LOS_GROUND_LIFT, from.z);
    }
  }
  _lA.subVectors(to, start);
  const dist = _lA.length();
  if (dist < 1e-4) return 1;
  _lA.divideScalar(dist);
  let vis = 1;
  const cols = (world && world.colliders) || null;
  if (cols) {
    for (let i = 0; i < cols.length; i++) {
      const raw = cols[i];
      if (raw === ignoreCollider || raw.disabled || raw.dead ||
          raw.noBlockLos || raw.destroyed) continue;
      const box = normalizeCollider(raw);
      if (!box.blocksLos) continue;
      let t;
      if (box.type === 'sphere') t = rayVsSphere(start, _lA, dist, box.center, box.radius, null);
      else t = rayVsBox(start, _lA, dist, box, null);
      // t ~ 0 means the ray *starts* inside this collider (a grenade landed on
      // the sandbag it is meant to be clearing). It cannot occlude itself.
      if (t > 0.06 && t < dist - 0.06) {
        // A half-cover wall lets fragments past; full cover stops them.
        vis *= 1 - clamp(box.cover > 0 ? box.cover : 0.85, 0, 1);
        if (vis <= 0.02) return 0;
      }
    }
  }
  if (terrain && rayVsHeightfield(terrain, start, _lA, dist, _hitB)) {
    if (_hitB.distance < dist - 0.15) return 0;
  }
  return vis;
}

/** Shared scratch hits so callers can borrow one without allocating. */
export const SCRATCH_HIT = _hitA;
export const SCRATCH_HIT_B = _hitB;
