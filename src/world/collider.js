// Collision / cover volumes for the battlefield, plus a uniform-grid broadphase.
//
// Collider shape (documented in docs/ARCHITECTURE.md as
//   { type:'box'|'sphere', ..., cover: 0..1, destructible }):
//
//   { type: 'box',
//     center: Vector3, half: Vector3, yaw: number,   // OBB about +Y
//     min: Vector3, max: Vector3,                    // world AABB (broadphase)
//     cover: 0..1,        // hard cover value granted when adjacent + in arc
//     conceal: 0..1,      // accuracy penalty granted without blocking bullets
//     solid: boolean,     // blocks movement AND bullets
//     blocksLos: boolean, // blocks line of sight / projectiles
//     destructible: boolean, hp: number, tag: string, owner: object|null }
//
//   { type: 'sphere', center, radius, ...same flags }

import * as THREE from 'three';
import { V0, V1, V2, clamp } from '../core/math.js';

let _nextId = 1;

export function makeBox(center, half, yaw = 0, opts = {}) {
  const c = new THREE.Vector3(center.x, center.y, center.z);
  const h = new THREE.Vector3(half.x, half.y, half.z);
  const col = {
    id: _nextId++,
    type: 'box',
    center: c,
    half: h,
    yaw,
    min: new THREE.Vector3(),
    max: new THREE.Vector3(),
    cover: opts.cover ?? 0,
    conceal: opts.conceal ?? 0,
    solid: opts.solid ?? true,
    blocksLos: opts.blocksLos ?? (opts.solid ?? true),
    destructible: opts.destructible ?? false,
    hp: opts.hp ?? 0,
    tag: opts.tag || 'prop',
    owner: opts.owner || null,
    crouchOnly: opts.crouchOnly ?? false,
  };
  refreshAABB(col);
  return col;
}

export function makeSphere(center, radius, opts = {}) {
  const col = {
    id: _nextId++,
    type: 'sphere',
    center: new THREE.Vector3(center.x, center.y, center.z),
    radius,
    min: new THREE.Vector3(),
    max: new THREE.Vector3(),
    cover: opts.cover ?? 0,
    conceal: opts.conceal ?? 0,
    solid: opts.solid ?? true,
    blocksLos: opts.blocksLos ?? (opts.solid ?? true),
    destructible: opts.destructible ?? false,
    hp: opts.hp ?? 0,
    tag: opts.tag || 'prop',
    owner: opts.owner || null,
    crouchOnly: opts.crouchOnly ?? false,
  };
  refreshAABB(col);
  return col;
}

export function refreshAABB(c) {
  if (c.type === 'sphere') {
    c.min.set(c.center.x - c.radius, c.center.y - c.radius, c.center.z - c.radius);
    c.max.set(c.center.x + c.radius, c.center.y + c.radius, c.center.z + c.radius);
    return c;
  }
  // Rotated-box world extent: |R| * half, with R a yaw rotation.
  const ca = Math.abs(Math.cos(c.yaw)), sa = Math.abs(Math.sin(c.yaw));
  const ex = c.half.x * ca + c.half.z * sa;
  const ez = c.half.x * sa + c.half.z * ca;
  c.min.set(c.center.x - ex, c.center.y - c.half.y, c.center.z - ez);
  c.max.set(c.center.x + ex, c.center.y + c.half.y, c.center.z + ez);
  return c;
}

// --- point / closest-point queries -----------------------------------------

/** World point -> collider local space (yaw only). */
function toLocal(c, x, y, z, out) {
  const dx = x - c.center.x, dz = z - c.center.z;
  const co = Math.cos(-c.yaw), si = Math.sin(-c.yaw);
  out.set(dx * co - dz * si, y - c.center.y, dx * si + dz * co);
  return out;
}
function toWorld(c, lx, ly, lz, out) {
  const co = Math.cos(c.yaw), si = Math.sin(c.yaw);
  out.set(c.center.x + lx * co - lz * si, c.center.y + ly, c.center.z + lx * si + lz * co);
  return out;
}

export function containsPoint(c, x, y, z) {
  if (c.type === 'sphere') {
    const dx = x - c.center.x, dy = y - c.center.y, dz = z - c.center.z;
    return dx * dx + dy * dy + dz * dz <= c.radius * c.radius;
  }
  toLocal(c, x, y, z, V0);
  return Math.abs(V0.x) <= c.half.x && Math.abs(V0.y) <= c.half.y && Math.abs(V0.z) <= c.half.z;
}

/** Closest point on the collider surface/volume to a world point. */
export function closestPoint(c, x, y, z, out) {
  if (c.type === 'sphere') {
    out.set(x - c.center.x, y - c.center.y, z - c.center.z);
    const l = out.length();
    if (l < 1e-6) return out.copy(c.center);
    return out.multiplyScalar(Math.min(1, c.radius / l)).add(c.center);
  }
  toLocal(c, x, y, z, V0);
  const lx = clamp(V0.x, -c.half.x, c.half.x);
  const ly = clamp(V0.y, -c.half.y, c.half.y);
  const lz = clamp(V0.z, -c.half.z, c.half.z);
  return toWorld(c, lx, ly, lz, out);
}

/** Horizontal distance from (x,z) to the collider footprint. 0 if inside. */
export function distanceXZ(c, x, z) {
  if (c.type === 'sphere') {
    const dx = x - c.center.x, dz = z - c.center.z;
    return Math.max(0, Math.hypot(dx, dz) - c.radius);
  }
  toLocal(c, x, c.center.y, z, V0);
  const dx = Math.max(0, Math.abs(V0.x) - c.half.x);
  const dz = Math.max(0, Math.abs(V0.z) - c.half.z);
  return Math.hypot(dx, dz);
}

// --- ray casts --------------------------------------------------------------

/**
 * Ray vs collider. Returns hit distance along `dir` (unit) or -1.
 * Boxes are treated as OBBs: transform the ray into local space and slab-test.
 */
export function rayCollider(c, ox, oy, oz, dx, dy, dz, maxDist) {
  if (c.type === 'sphere') {
    const mx = ox - c.center.x, my = oy - c.center.y, mz = oz - c.center.z;
    const b = mx * dx + my * dy + mz * dz;
    const cc = mx * mx + my * my + mz * mz - c.radius * c.radius;
    if (cc > 0 && b > 0) return -1;
    const disc = b * b - cc;
    if (disc < 0) return -1;
    let t = -b - Math.sqrt(disc);
    if (t < 0) t = 0;
    return t <= maxDist ? t : -1;
  }
  const co = Math.cos(-c.yaw), si = Math.sin(-c.yaw);
  const rx = ox - c.center.x, rz = oz - c.center.z;
  const lox = rx * co - rz * si, loz = rx * si + rz * co;
  const loy = oy - c.center.y;
  const ldx = dx * co - dz * si, ldz = dx * si + dz * co;
  const ldy = dy;
  let tmin = 0, tmax = maxDist;
  const o = [lox, loy, loz], d = [ldx, ldy, ldz], h = [c.half.x, c.half.y, c.half.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < -h[i] || o[i] > h[i]) return -1;
    } else {
      const inv = 1 / d[i];
      let t1 = (-h[i] - o[i]) * inv, t2 = (h[i] - o[i]) * inv;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

/** Surface normal of a box/sphere at a world point on (or near) its surface. */
export function colliderNormal(c, x, y, z, out) {
  if (c.type === 'sphere') {
    return out.set(x - c.center.x, y - c.center.y, z - c.center.z).normalize();
  }
  toLocal(c, x, y, z, V0);
  const ax = Math.abs(V0.x) / c.half.x;
  const ay = Math.abs(V0.y) / c.half.y;
  const az = Math.abs(V0.z) / c.half.z;
  let lx = 0, ly = 0, lz = 0;
  if (ax >= ay && ax >= az) lx = Math.sign(V0.x) || 1;
  else if (ay >= az) ly = Math.sign(V0.y) || 1;
  else lz = Math.sign(V0.z) || 1;
  const co = Math.cos(c.yaw), si = Math.sin(c.yaw);
  return out.set(lx * co - lz * si, ly, lx * si + lz * co).normalize();
}

// ---------------------------------------------------------------------------
// broadphase: uniform grid over the map footprint
// ---------------------------------------------------------------------------

export class ColliderGrid {
  /** @param {number} size map extent (metres, centred on origin) */
  constructor(size = 180, cell = 8) {
    this.size = size;
    this.cell = cell;
    this.n = Math.ceil(size / cell) + 2;
    this.origin = -size * 0.5 - cell;
    this.buckets = new Array(this.n * this.n);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
    this.all = [];
    this._stamp = 0;
    this._seen = new Map();
  }

  _ix(v) { return clamp(Math.floor((v - this.origin) / this.cell), 0, this.n - 1); }

  insert(c) {
    this.all.push(c);
    const i0 = this._ix(c.min.x), i1 = this._ix(c.max.x);
    const j0 = this._ix(c.min.z), j1 = this._ix(c.max.z);
    c._cells = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.n + i;
        this.buckets[k].push(c);
        c._cells.push(k);
      }
    }
    return c;
  }

  remove(c) {
    const i = this.all.indexOf(c);
    if (i >= 0) this.all.splice(i, 1);
    if (c._cells) {
      for (const k of c._cells) {
        const b = this.buckets[k];
        const j = b.indexOf(c);
        if (j >= 0) b.splice(j, 1);
      }
      c._cells = null;
    }
  }

  /** Re-bucket a collider after its transform changed. */
  update(c) {
    if (c._cells) {
      for (const k of c._cells) {
        const b = this.buckets[k];
        const j = b.indexOf(c);
        if (j >= 0) b.splice(j, 1);
      }
    }
    refreshAABB(c);
    const i0 = this._ix(c.min.x), i1 = this._ix(c.max.x);
    const j0 = this._ix(c.min.z), j1 = this._ix(c.max.z);
    c._cells = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.n + i;
        this.buckets[k].push(c);
        c._cells.push(k);
      }
    }
  }

  /**
   * Visit every collider whose AABB overlaps the XZ disc (x,z,r).
   * De-duplicates with a stamp map so a collider spanning many cells is
   * reported once. No allocation per call.
   */
  query(x, z, r, fn) {
    const stamp = ++this._stamp;
    const i0 = this._ix(x - r), i1 = this._ix(x + r);
    const j0 = this._ix(z - r), j1 = this._ix(z + r);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const b = this.buckets[j * this.n + i];
        for (let k = 0; k < b.length; k++) {
          const c = b[k];
          if (this._seen.get(c.id) === stamp) continue;
          this._seen.set(c.id, stamp);
          if (c.max.x < x - r || c.min.x > x + r || c.max.z < z - r || c.min.z > z + r) continue;
          fn(c);
        }
      }
    }
  }

  /**
   * Ray march the grid, returning the nearest hit.
   * `filter(c)` may reject colliders (e.g. non-LOS-blocking foliage).
   * Returns { collider, distance, point, normal } or null.
   */
  raycast(origin, dir, maxDist = 200, filter = null, out = null) {
    let bestT = maxDist, best = null;
    // A DDA over the grid would beat this, but the world has only a few hundred
    // colliders and the query is O(cells along the ray) either way; a segment
    // AABB sweep over the buckets the ray passes through is simpler and safe.
    const steps = Math.ceil(maxDist / this.cell) + 1;
    const stamp = ++this._stamp;
    for (let s = 0; s <= steps; s++) {
      const t = Math.min(maxDist, s * this.cell);
      const px = origin.x + dir.x * t, pz = origin.z + dir.z * t;
      const i0 = this._ix(px - this.cell), i1 = this._ix(px + this.cell);
      const j0 = this._ix(pz - this.cell), j1 = this._ix(pz + this.cell);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const b = this.buckets[j * this.n + i];
          for (let k = 0; k < b.length; k++) {
            const c = b[k];
            if (this._seen.get(c.id) === stamp) continue;
            this._seen.set(c.id, stamp);
            if (filter && !filter(c)) continue;
            const hit = rayCollider(c, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, bestT);
            if (hit >= 0 && hit < bestT) { bestT = hit; best = c; }
          }
        }
      }
      if (best && bestT < (s + 1) * this.cell) break;   // cannot be beaten further out
    }
    if (!best) return null;
    const res = out || { collider: null, distance: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };
    res.collider = best;
    res.distance = bestT;
    res.point.set(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT);
    colliderNormal(best, res.point.x, res.point.y, res.point.z, res.normal);
    return res;
  }

  /**
   * Push a capsule-ish agent (radius r, standing at y) out of solid colliders.
   * Mutates `pos`. Returns true if any correction was applied.
   */
  resolve(pos, r, height = 1.75) {
    let moved = false;
    const cy = pos.y + height * 0.5;
    this.query(pos.x, pos.z, r + 1.5, (c) => {
      if (!c.solid) return;
      if (c.max.y < pos.y + 0.25 || c.min.y > pos.y + height) return; // steppable / overhead
      closestPoint(c, pos.x, cy, pos.z, V1);
      V2.set(pos.x - V1.x, 0, pos.z - V1.z);
      const d = V2.length();
      if (d > r) return;
      if (d < 1e-4) {
        // dead centre: eject along the shortest AABB axis
        const ex = Math.min(pos.x - c.min.x, c.max.x - pos.x);
        const ez = Math.min(pos.z - c.min.z, c.max.z - pos.z);
        if (ex < ez) pos.x += (pos.x < c.center.x ? -1 : 1) * (ex + r);
        else pos.z += (pos.z < c.center.z ? -1 : 1) * (ez + r);
      } else {
        V2.multiplyScalar((r - d) / d);
        pos.x += V2.x;
        pos.z += V2.z;
      }
      moved = true;
    });
    return moved;
  }
}
