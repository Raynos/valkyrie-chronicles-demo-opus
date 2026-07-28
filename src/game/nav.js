// src/game/nav.js — navigation grid, A*, Dijkstra reachability, threat maps.
//
// Shared by commandMode.js (movement-range preview, threat overlay) and ai.js (pathing).
// The grid is built once from World.navQuery + Terrain and cached in typed arrays; nothing
// here allocates per frame.

import * as THREE from 'three';
import { clamp, clamp01 } from '../core/math.js';
import { colliderPush } from './combat.js';

const WALK = 1, BLOCK = 0;

/** Binary min-heap over int32 node ids keyed by a Float32Array of scores. */
class Heap {
  constructor(cap, keys) {
    this.a = new Int32Array(cap);
    this.n = 0;
    this.keys = keys;
  }
  clear() { this.n = 0; }
  push(v) {
    const a = this.a, k = this.keys;
    let i = this.n++;
    a[i] = v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[a[p]] <= k[a[i]]) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  }
  pop() {
    const a = this.a, k = this.keys;
    const top = a[0];
    const last = a[--this.n];
    if (this.n > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.n && k[a[l]] < k[a[m]]) m = l;
        if (r < this.n && k[a[r]] < k[a[m]]) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top;
  }
  get size() { return this.n; }
}

const _v = new THREE.Vector3();

export class NavGrid {
  /**
   * @param {object} world  World contract instance (navQuery / terrain)
   * @param {object} opts   { cell, minX, minZ, maxX, maxZ, maxSlope }
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.cell = opts.cell ?? 1.5;
    this.minX = opts.minX ?? -128;
    this.minZ = opts.minZ ?? -128;
    this.maxX = opts.maxX ?? 128;
    this.maxZ = opts.maxZ ?? 128;
    this.maxSlope = opts.maxSlope ?? 0.72;      // ~36 degrees
    this.w = Math.max(2, Math.ceil((this.maxX - this.minX) / this.cell));
    this.h = Math.max(2, Math.ceil((this.maxZ - this.minZ) / this.cell));
    const n = this.w * this.h;

    this.flags = new Uint8Array(n);
    this.cost = new Float32Array(n);            // multiplier >= 1
    this.cover = new Float32Array(n);
    this.height = new Float32Array(n);
    this.threat = new Float32Array(n);          // rebuilt per turn

    // A* / Dijkstra working sets, allocated once.
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Int32Array(n);
    this.closed = new Uint8Array(n);
    this._epoch = 1;
    this.heap = new Heap(n, this.f);
    this._path = [];
    this.built = false;
  }

  idx(ix, iz) { return iz * this.w + ix; }
  inBounds(ix, iz) { return ix >= 0 && iz >= 0 && ix < this.w && iz < this.h; }
  cellX(x) { return Math.floor((x - this.minX) / this.cell); }
  cellZ(z) { return Math.floor((z - this.minZ) / this.cell); }
  worldX(ix) { return this.minX + (ix + 0.5) * this.cell; }
  worldZ(iz) { return this.minZ + (iz + 0.5) * this.cell; }

  build() {
    const { w, h, world } = this;
    const terrain = world?.terrain;
    for (let iz = 0; iz < h; iz++) {
      for (let ix = 0; ix < w; ix++) {
        const i = iz * w + ix;
        const x = this.worldX(ix), z = this.worldZ(iz);
        let walk = true, cost = 1, cover = 0, y = 0, hadQuery = false;
        if (world?.navQuery) {
          let q = null;
          try { q = world.navQuery(x, z); } catch { q = null; }
          if (q) {
            walk = q.walkable !== false;
            cost = q.cost || 1;
            cover = q.cover || 0;
            // `height` is the standing height including bridge decks and rooftops.
            if (q.height !== undefined) y = q.height;
            else if (q.y !== undefined) y = q.y;
            hadQuery = true;
          }
        }
        if (!hadQuery) {
          if (world?.groundHeightAt) y = world.groundHeightAt(x, z);
          else if (terrain?.heightAt) y = terrain.heightAt(x, z);
        }
        if (terrain?.slopeAt) {
          const s = terrain.slopeAt(x, z);
          // Only veto on slope when the world has no opinion — otherwise the bridge deck,
          // which spans a gorge, would be marked impassable by the terrain underneath it.
          if (!hadQuery && s > this.maxSlope) walk = false;
          else cost *= 1 + s * 1.9;
        }
        this.flags[i] = walk ? WALK : BLOCK;
        this.cost[i] = Math.max(0.25, cost);
        this.cover[i] = clamp01(cover);
        this.height[i] = y;
      }
    }
    this.built = true;
    return this;
  }

  /** Refresh a rectangular patch — used when destructible cover collapses. */
  rebuildArea(cx, cz, radius) {
    const i0 = clamp(this.cellX(cx - radius), 0, this.w - 1);
    const i1 = clamp(this.cellX(cx + radius), 0, this.w - 1);
    const j0 = clamp(this.cellZ(cz - radius), 0, this.h - 1);
    const j1 = clamp(this.cellZ(cz + radius), 0, this.h - 1);
    for (let iz = j0; iz <= j1; iz++) {
      for (let ix = i0; ix <= i1; ix++) {
        const i = iz * this.w + ix;
        const x = this.worldX(ix), z = this.worldZ(iz);
        let q = null;
        try { q = this.world?.navQuery?.(x, z); } catch { q = null; }
        if (q) {
          this.flags[i] = q.walkable === false ? BLOCK : WALK;
          this.cost[i] = Math.max(0.25, q.cost || 1);
          this.cover[i] = clamp01(q.cover || 0);
        }
      }
    }
  }

  walkableAt(x, z) {
    const ix = this.cellX(x), iz = this.cellZ(z);
    if (!this.inBounds(ix, iz)) return false;
    return this.flags[this.idx(ix, iz)] === WALK;
  }

  coverAtCell(x, z) {
    const ix = this.cellX(x), iz = this.cellZ(z);
    if (!this.inBounds(ix, iz)) return 0;
    return this.cover[this.idx(ix, iz)];
  }

  heightAt(x, z) {
    // groundHeightAt includes walkable platforms (the bridge deck); terrain does not.
    if (this.world?.groundHeightAt) return this.world.groundHeightAt(x, z);
    if (this.world?.terrain?.heightAt) return this.world.terrain.heightAt(x, z);
    const ix = clamp(this.cellX(x), 0, this.w - 1), iz = clamp(this.cellZ(z), 0, this.h - 1);
    return this.height[this.idx(ix, iz)];
  }

  /** Nearest walkable cell index to a world point, searching outward in rings. */
  nearestWalkable(x, z, maxRings = 12) {
    let ix = clamp(this.cellX(x), 0, this.w - 1);
    let iz = clamp(this.cellZ(z), 0, this.h - 1);
    if (this.flags[this.idx(ix, iz)] === WALK) return this.idx(ix, iz);
    for (let r = 1; r <= maxRings; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const jx = ix + dx, jz = iz + dz;
          if (!this.inBounds(jx, jz)) continue;
          const i = this.idx(jx, jz);
          if (this.flags[i] === WALK) return i;
        }
      }
    }
    return -1;
  }

  // -- A* -----------------------------------------------------------------

  /**
   * @returns {THREE.Vector3[]|null} smoothed waypoints from `from` to `to`, world space.
   * opts: { threatWeight, maxNodes, arriveRadius }
   */
  findPath(from, to, opts = {}) {
    if (!this.built) this.build();
    const start = this.nearestWalkable(from.x, from.z);
    const goal = this.nearestWalkable(to.x, to.z);
    if (start < 0 || goal < 0) return null;
    if (start === goal) { this._path.length = 0; this._path.push(new THREE.Vector3(to.x, this.heightAt(to.x, to.z), to.z)); return this._path.slice(); }

    const epoch = ++this._epoch;
    const { w, h, cell, g, f, from: prev, stamp, closed, flags, cost, threat } = this;
    const tw = opts.threatWeight ?? 0;
    const maxNodes = opts.maxNodes ?? 24000;
    const gx = goal % w, gz = (goal / w) | 0;

    this.heap.clear();
    stamp[start] = epoch; closed[start] = 0; g[start] = 0;
    f[start] = this._heur(start % w, (start / w) | 0, gx, gz);
    prev[start] = -1;
    this.heap.push(start);

    let expanded = 0;
    let found = false;
    while (this.heap.size > 0) {
      const cur = this.heap.pop();
      if (closed[cur] === 1 && stamp[cur] === epoch) continue;
      closed[cur] = 1; stamp[cur] = epoch;
      if (cur === goal) { found = true; break; }
      if (++expanded > maxNodes) break;

      const cx = cur % w, cz = (cur / w) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + NX[k], nz = cz + NZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nz * w + nx;
        if (flags[ni] === BLOCK) continue;
        // No corner cutting through blocked diagonals.
        if (k >= 4) {
          if (flags[cz * w + nx] === BLOCK || flags[nz * w + cx] === BLOCK) continue;
        }
        const step = (k >= 4 ? 1.41421356 : 1) * cell * cost[ni];
        const dh = Math.abs(this.height[ni] - this.height[cur]);
        const climb = dh > cell * 1.4 ? 1e6 : dh * 2.2;    // can't scale cliffs
        const ng = g[cur] + step + climb + threat[ni] * tw;
        if (stamp[ni] !== epoch) { stamp[ni] = epoch; closed[ni] = 0; g[ni] = Infinity; }
        if (closed[ni] === 1) continue;
        if (ng < g[ni]) {
          g[ni] = ng;
          prev[ni] = cur;
          f[ni] = ng + this._heur(nx, nz, gx, gz);
          this.heap.push(ni);
        }
      }
    }
    if (!found) return null;

    // Reconstruct
    const raw = [];
    let n = goal;
    while (n >= 0) { raw.push(n); n = prev[n]; }
    raw.reverse();
    return this._smooth(raw, from, to, opts);
  }

  _heur(ax, az, bx, bz) {
    const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
    // Octile distance, slightly weighted to break ties toward straight lines.
    return (Math.max(dx, dz) + 0.41421356 * Math.min(dx, dz)) * this.cell * 1.001;
  }

  /** String-pull: drop waypoints the unit can walk straight past. */
  _smooth(cells, from, to, opts) {
    const out = this._path;
    out.length = 0;
    out.push(new THREE.Vector3(from.x, this.heightAt(from.x, from.z), from.z));
    for (let i = 1; i < cells.length; i++) {
      const ax = out[out.length - 1].x, az = out[out.length - 1].z;
      const c = cells[i];
      const cx = this.worldX(c % this.w), cz = this.worldZ((c / this.w) | 0);
      if (!this._clearLine(ax, az, cx, cz)) {
        // Anchor at the last cell we could still see and re-run from there.
        const p = cells[i - 1];
        out.push(new THREE.Vector3(this.worldX(p % this.w), 0, this.worldZ((p / this.w) | 0)));
      }
    }
    out.push(new THREE.Vector3(to.x, 0, to.z));
    for (let i = 0; i < out.length; i++) out[i].y = this.heightAt(out[i].x, out[i].z);
    // Copy out so callers can hold the result while we reuse _path.
    const res = new Array(out.length);
    for (let i = 0; i < out.length; i++) res[i] = out[i].clone();
    return res;
  }

  /** Bresenham-ish walkability sample along a straight segment. */
  _clearLine(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (this.cell * 0.6)));
    let prevY = this.heightAt(ax, az);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = ax + dx * t, z = az + dz * t;
      if (!this.walkableAt(x, z)) return false;
      const y = this.heightAt(x, z);
      if (Math.abs(y - prevY) > this.cell * 1.1) return false;
      prevY = y;
    }
    return true;
  }

  // -- Dijkstra reachability (movement-range preview) ----------------------

  /**
   * Flood the grid from `from` up to `maxDist` metres of *path* distance.
   * @returns { cells:Int32Array view, dist:Float32Array, count } — `dist` is indexed by cell id,
   *          valid only where stamp === epoch. Use `reachDist(i)`.
   */
  floodFill(from, maxDist, opts = {}) {
    if (!this.built) this.build();
    const start = this.nearestWalkable(from.x, from.z);
    const result = this._flood || (this._flood = { cells: [], epoch: 0, maxDist: 0 });
    result.cells.length = 0;
    if (start < 0) return result;

    const epoch = ++this._epoch;
    const { w, h, cell, g, f, stamp, closed, flags, cost } = this;
    this.heap.clear();
    stamp[start] = epoch; closed[start] = 0; g[start] = 0; f[start] = 0;
    this.heap.push(start);

    while (this.heap.size > 0) {
      const cur = this.heap.pop();
      if (closed[cur] === 1 && stamp[cur] === epoch) continue;
      closed[cur] = 1;
      if (g[cur] > maxDist) continue;
      result.cells.push(cur);
      const cx = cur % w, cz = (cur / w) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + NX[k], nz = cz + NZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const ni = nz * w + nx;
        if (flags[ni] === BLOCK) continue;
        if (k >= 4 && (flags[cz * w + nx] === BLOCK || flags[nz * w + cx] === BLOCK)) continue;
        const dh = Math.abs(this.height[ni] - this.height[cur]);
        if (dh > cell * 1.4) continue;
        const ng = g[cur] + (k >= 4 ? 1.41421356 : 1) * cell * cost[ni] + dh * 2.2;
        if (ng > maxDist) continue;
        if (stamp[ni] !== epoch) { stamp[ni] = epoch; closed[ni] = 0; g[ni] = Infinity; }
        if (closed[ni] === 1) continue;
        if (ng < g[ni]) { g[ni] = ng; f[ni] = ng; this.heap.push(ni); }
      }
    }
    result.epoch = epoch;
    result.maxDist = maxDist;
    return result;
  }

  reachDist(i) { return this.stamp[i] === this._epoch ? this.g[i] : Infinity; }

  // -- Threat map ----------------------------------------------------------

  /**
   * Rasterise every hostile unit's effective fire envelope into `threat`.
   * Values are roughly "expected damage per crossing" and are used both by the AI's
   * path weighting and by commandMode's danger overlay.
   */
  buildThreat(units, forTeam, opts = {}) {
    const { w, h, threat } = this;
    threat.fill(0);
    const losSamples = opts.losSamples ?? 1;
    for (let u = 0; u < units.length; u++) {
      const e = units[u];
      if (!e.active || e.team === forTeam) continue;
      const C = e.classDef;
      const range = Math.max(C.interceptRange || 0, e.weapon.range * (C.overwatch ? 1.0 : 0.75));
      if (range <= 0) continue;
      const dps = (e.weapon.apDamage * (e.weapon.shots || 1)) / 3;
      const i0 = clamp(this.cellX(e.pos.x - range), 0, w - 1);
      const i1 = clamp(this.cellX(e.pos.x + range), 0, w - 1);
      const j0 = clamp(this.cellZ(e.pos.z - range), 0, h - 1);
      const j1 = clamp(this.cellZ(e.pos.z + range), 0, h - 1);
      for (let iz = j0; iz <= j1; iz++) {
        for (let ix = i0; ix <= i1; ix++) {
          const i = iz * w + ix;
          if (this.flags[i] === BLOCK) continue;
          const x = this.worldX(ix), z = this.worldZ(iz);
          const d = Math.hypot(x - e.pos.x, z - e.pos.z);
          if (d > range) continue;
          const falloff = 1 - clamp01((d - e.weapon.range) / Math.max(1, e.weapon.maxRange - e.weapon.range));
          let v = dps * (0.35 + 0.65 * falloff);
          v *= 1 - this.cover[i] * 0.7;
          threat[i] += v;
        }
      }
    }
    if (losSamples > 0) this._occludeThreat(units, forTeam);
    return threat;
  }

  /** Cheap occlusion pass: cells with high local cover shed threat (real LOS is per-shot). */
  _occludeThreat() {
    const { w, h, threat, cover } = this;
    for (let i = 0, n = w * h; i < n; i++) {
      if (cover[i] > 0.75) threat[i] *= 0.25;
    }
  }

  threatAt(x, z) {
    const ix = this.cellX(x), iz = this.cellZ(z);
    if (!this.inBounds(ix, iz)) return 0;
    return this.threat[this.idx(ix, iz)];
  }

  /**
   * Score a candidate stopping position for the AI: cover, distance to objective,
   * threat, and elevation. Higher is better.
   */
  scorePosition(i, ctx) {
    const ix = i % this.w, iz = (i / this.w) | 0;
    const x = this.worldX(ix), z = this.worldZ(iz);
    let s = 0;
    s += this.cover[i] * (ctx.coverWeight ?? 26);
    s -= this.threat[i] * (ctx.threatWeight ?? 0.55);
    s += (this.height[i] - (ctx.baseHeight ?? 0)) * (ctx.heightWeight ?? 1.6);
    if (ctx.goal) {
      const d = Math.hypot(x - ctx.goal.x, z - ctx.goal.z);
      s -= d * (ctx.goalWeight ?? 1.0);
    }
    if (ctx.avoid) {
      for (let k = 0; k < ctx.avoid.length; k++) {
        const a = ctx.avoid[k];
        const d = Math.hypot(x - a.x, z - a.z);
        if (d < (ctx.avoidRadius ?? 8)) s -= ((ctx.avoidRadius ?? 8) - d) * (ctx.avoidWeight ?? 3);
      }
    }
    return s;
  }
}

// 4-neighbour then 4-diagonal ordering.
const NX = new Int8Array([1, -1, 0, 0, 1, 1, -1, -1]);
const NZ = new Int8Array([0, 0, 1, -1, 1, -1, 1, -1]);

const _push = new THREE.Vector3();

/**
 * Move `pos` by (dx,dz) with wall sliding: full move, then each axis alone, then a
 * penetration push-out. Snaps Y to the ground. Mutates and returns `pos`.
 * @returns metres actually travelled in XZ
 */
export function moveWithCollision(pos, dx, dz, radius, nav, world, height = 1.7) {
  const sx = pos.x, sz = pos.z;
  // Preferred path: the World has a grid broadphase and a penetration resolver that also
  // snaps to platform tops. Far cheaper than our linear collider scan in a built-up village.
  if (world?.resolvePosition) {
    const total = Math.hypot(dx, dz);
    const n = total > 0.4 ? Math.min(8, Math.ceil(total / 0.4)) : 1;
    for (let i = 0; i < n; i++) {
      const nx = pos.x + dx / n, nz = pos.z + dz / n;
      if (nav && !nav.walkableAt(nx, nz)) break;
      pos.x = nx; pos.z = nz;
      world.resolvePosition(pos, radius);
    }
    return Math.hypot(pos.x - sx, pos.z - sz);
  }
  // Sub-step so a single large frame delta can never tunnel past — or be rejected by —
  // a wall it would only have clipped. 0.25 m is well under any collider we author.
  const want = Math.hypot(dx, dz);
  const steps = want > 0.25 ? Math.min(12, Math.ceil(want / 0.25)) : 1;
  const ux = dx / steps, uz = dz / steps;
  for (let i = 0; i < steps; i++) {
    if (!stepMove(pos, ux, uz, radius, nav, world, height)) break;
  }
  if (nav) pos.y = nav.heightAt(pos.x, pos.z);
  return Math.hypot(pos.x - sx, pos.z - sz);
}

/** One collision-resolved micro-step. @returns false when fully blocked. */
function stepMove(pos, dx, dz, radius, nav, world, height) {
  const sx = pos.x, sz = pos.z;
  const ok = (x, z) => {
    if (nav && !nav.walkableAt(x, z)) return false;
    const y = nav ? nav.heightAt(x, z) : pos.y;
    return colliderPush(x, y, z, radius, height, _push, world) < 0.001;
  };
  if (ok(sx + dx, sz + dz)) { pos.x = sx + dx; pos.z = sz + dz; return true; }
  // Slide: keep whichever single axis is legal.
  if (ok(sx + dx, sz)) { pos.x = sx + dx; return true; }
  if (ok(sx, sz + dz)) { pos.z = sz + dz; return true; }
  // Wedged: push out of whatever we are inside so we never get stuck in a wall.
  const y = nav ? nav.heightAt(sx, sz) : pos.y;
  if (colliderPush(sx, y, sz, radius, height, _push, world) > 0.001) {
    pos.x += _push.x * 0.5;
    pos.z += _push.z * 0.5;
  }
  return false;
}

/** Total length of a polyline. */
export function pathLength(path) {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += path[i].distanceTo(path[i - 1]);
  return d;
}

/** Truncate a path so its length is at most `maxLen`; returns a new array. */
export function truncatePath(path, maxLen) {
  if (path.length < 2) return path.slice();
  const out = [path[0].clone()];
  let left = maxLen;
  for (let i = 1; i < path.length; i++) {
    const seg = path[i].distanceTo(path[i - 1]);
    if (seg <= left) { out.push(path[i].clone()); left -= seg; }
    else {
      const t = left / Math.max(1e-6, seg);
      out.push(_v.copy(path[i - 1]).lerp(path[i], t).clone());
      break;
    }
  }
  return out;
}
