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
        // PROPS. navQuery knows terrain and building footprints; it does not know that a
        // chevaux-de-frise is parked on this cell. A router that plans through solid props
        // sends soldiers into them (and the range preview promises ground nobody can reach).
        if (walk) {
          const pen = this._propPen(x, z, y);
          if (pen > 0.5) walk = false;                 // cell centre is inside the prop
          else if (pen > 0.02) cost *= 2.2;            // clipped: passable, but not the lane
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

  /**
   * Penetration depth of a standing soldier-sized body at this cell centre against SOLID
   * props (the collider set), or 0. Uses the World's broadphase when it has one — the linear
   * fallback is O(colliders) and this runs once per cell at build.
   */
  _propPen(x, z, y, r = 0.36, height = 1.75) {
    const grid = this.world?.grid;
    const yTop = y + height;
    let depth = 0;
    // `solid` is the flag that gates BODIES (src/world/collider.js). It is NOT the same as
    // blocksLos or blocksProjectile: tall grass and bushes are collider volumes a man walks
    // straight through, and treating them as obstacles here would block half the map.
    const test = (c) => {
      if (c.solid === false || c.destroyed || c.walkOver || c.noBlock) return;
      const half = c.half || c.halfExtents;
      if (c.type === 'sphere') {
        const rad = (c.radius ?? 0.5) + r;
        if (c.center.y > yTop || c.center.y + (c.radius ?? 0.5) < y + 0.12) return;
        const d = Math.hypot(x - c.center.x, z - c.center.z);
        if (d < rad) depth = Math.max(depth, rad - d);
        return;
      }
      if (!half) return;
      if (c.center.y - half.y > yTop || c.center.y + half.y < y + 0.12) return;  // kerb / overhead
      let lx = x - c.center.x, lz = z - c.center.z;
      const yaw = c.yaw || 0;
      if (yaw !== 0) {
        const cs = Math.cos(-yaw), sn = Math.sin(-yaw);
        const nx = lx * cs - lz * sn; lz = lx * sn + lz * cs; lx = nx;
      }
      const ex = half.x + r, ez = half.z + r;
      const ax = Math.abs(lx), az = Math.abs(lz);
      if (ax >= ex || az >= ez) return;
      depth = Math.max(depth, Math.min(ex - ax, ez - az));
    };
    if (grid?.query) grid.query(x, z, r + 2.5, test);
    else if (Array.isArray(this.world?.colliders)) for (const c of this.world.colliders) test(c);
    return depth;
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
          let walk = q.walkable !== false;
          let cost = Math.max(0.25, q.cost || 1);
          if (walk) {
            // Same prop test as build(): blowing a barricade open must OPEN the lane, and
            // dropping a wall into it must close it.
            const pen = this._propPen(x, z, this.height[i]);
            if (pen > 0.5) walk = false;
            else if (pen > 0.02) cost *= 2.2;
          }
          this.flags[i] = walk ? WALK : BLOCK;
          this.cost[i] = cost;
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

  /**
   * Nearest cell that is walkable, cheap to stand on, AND has all eight neighbours walkable —
   * i.e. ground you can actually walk OFF in any direction.
   *
   * `nearestWalkable` answers "can a body exist here", which is not the same question. A cell
   * on a shell-crater rim or in the mouth of a ruin passes it while being a pocket: every
   * heading out of it is blocked, so a soldier placed there holds W and travels 0.00 m. That
   * pocket is what "a third of the squad cannot leave the staging post" looked like from the
   * outside. Anything that PLACES a unit — deployment slots, spawns — wants this one.
   */
  nearestOpen(x, z, maxRings = 12, maxCost = 2.6) {
    const open = (jx, jz) => {
      if (!this.inBounds(jx, jz)) return false;
      const i = this.idx(jx, jz);
      if (this.flags[i] !== WALK || this.cost[i] > maxCost) return false;
      for (let k = 0; k < 8; k++) {
        const nx = jx + NX[k], nz = jz + NZ[k];
        if (!this.inBounds(nx, nz) || this.flags[this.idx(nx, nz)] !== WALK) return false;
      }
      return true;
    };
    const ix = clamp(this.cellX(x), 0, this.w - 1);
    const iz = clamp(this.cellZ(z), 0, this.h - 1);
    if (open(ix, iz)) return this.idx(ix, iz);
    for (let r = 1; r <= maxRings; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          if (open(ix + dx, iz + dz)) return this.idx(ix + dx, iz + dz);
        }
      }
    }
    return this.nearestWalkable(x, z, maxRings);
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
 * Move `pos` by (dx,dz) with wall sliding: full move, then a slide along the surface we
 * actually hit, then each axis alone. Snaps Y to the ground. Mutates `pos`.
 *
 * @returns metres to CHARGE for — see `billMove`. This is the number every caller feeds to
 *          `Unit.spendMove`, so it must be ground the man has actually covered.
 */
export function moveWithCollision(pos, dx, dz, radius, nav, world, height = 1.7) {
  const sx = pos.x, sz = pos.z;
  const want = Math.hypot(dx, dz);
  // Preferred path: the World has a grid broadphase and a penetration resolver that also
  // snaps to platform tops. Far cheaper than our linear collider scan in a built-up village.
  if (world?.resolvePosition) {
    const n = want > 0.4 ? Math.min(8, Math.ceil(want / 0.4)) : 1;
    const ux = dx / n, uz = dz / n;
    const len = want / n;
    for (let i = 0; i < n; i++) {
      if (!subStep(pos, ux, uz, len, radius, nav, world)) break;
    }
    return billMove(pos, sx, sz, want);
  }
  // Sub-step so a single large frame delta can never tunnel past — or be rejected by —
  // a wall it would only have clipped. 0.25 m is well under any collider we author.
  const steps = want > 0.25 ? Math.min(12, Math.ceil(want / 0.25)) : 1;
  const ux = dx / steps, uz = dz / steps;
  for (let i = 0; i < steps; i++) {
    if (!stepMove(pos, ux, uz, radius, nav, world, height)) break;
  }
  if (nav) pos.y = nav.heightAt(pos.x, pos.z);
  return billMove(pos, sx, sz, want);
}

/**
 * ONE collision-resolved sub-step on the fast path. @returns false when wedged.
 *
 * THE NAV GRID AND THE COLLIDER SET DISAGREE, AND THIS IS WHERE THAT COST THE PLAYER HIS SQUAD.
 *
 * The grid is built from `World.navQuery`, which knows about water, cliffs and building
 * footprints — it knows NOTHING about props. A chevaux-de-frise, a wrecked cart, a sandbag
 * revetment are colliders only. So `nav.walkableAt` said yes, the body stepped into the beam,
 * `resolvePosition` ejected it back out along the surface normal, and the next frame did the
 * same thing forever: the two axis fallbacks below could never fire, because the cell was never
 * nav-blocked in the first place. Measured live, four different soldiers walking north off the
 * bridge came to rest at the SAME coordinate (7.58, -11.46) — the eject from the hedgehog at
 * (8.5, -12.3) exactly cancelling their intent — with seven metres of clear ground two metres to
 * their left, and were billed 4 m of AP for 0.13 m over the following 25 seconds.
 *
 * So: when the step is eaten, slide along the surface we HIT — using the resolver's own push-out
 * as the contact normal for props, and the local gradient of blockedness for nav cells (a body
 * walking square north into a blocked row has NO x component for the old axis fallback to
 * salvage, so it stopped dead there too). That is the funnel behaviour a barricade belt needs: a
 * body pressed into a beam walks sideways off it and through the gap.
 *
 * A head-on hit still stops: the tangent of an intent parallel to the normal is zero. You cannot
 * slide along a wall you are facing squarely, and you never pass through one.
 */
function subStep(pos, ux, uz, len, radius, nav, world) {
  const bx = pos.x, bz = pos.z;
  // A body standing on ground the grid calls blocked is DIGGING OUT: nav cannot be allowed to
  // veto its escape (see the note below). `gate` is nav wherever nav is entitled to an opinion.
  const gate = !nav || nav.walkableAt(bx, bz) ? nav : null;
  let dx = ux, dz = uz;
  if (gate) {
    // LOOK AHEAD A BODY WIDTH, NOT ONE SUB-STEP.
    //
    // The grid quantises to 1.5 m cells and a sub-step at walking pace is 5 cm, so a veto on
    // "is the cell 5 cm ahead walkable" can never be escaped: every deflection lands in the
    // SAME blocked cell and is rejected in turn. Measured on the deck barricade at z=-4.5 (a
    // 2.9 m sandbag revetment with a clear lane beside it): the soldier stopped 4 m into the
    // crossing and held there, 26 m short of the north bank, because his 3 cm sidestep could
    // not reach the free cell. Probing at radius+0.12 m and then steering the whole sub-step
    // along the chosen heading is what accumulates the lateral metres that get him round it.
    const probe = Math.max(len, radius + 0.12);
    const ihx = ux / len, ihz = uz / len;
    if (!gate.walkableAt(bx + ihx * probe, bz + ihz * probe)) {
      // Fan out to either side, nearest heading first. Capped at 67.5 deg so a body that walks
      // SQUARE into a wall still stops dead instead of skating along it — the tester's
      // "walked into a wall and lost the sortie" must not become "walked into a wall and got
      // steered somewhere I never asked to go".
      let found = false;
      for (let k = 1; k <= 3 && !found; k++) {
        const a = k * 0.3927;                       // 22.5 deg steps
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let sgn = -1; sgn <= 1 && !found; sgn += 2) {
          const cx2 = ihx * ca - ihz * sa * sgn, cz2 = ihx * sa * sgn + ihz * ca;
          if (gate.walkableAt(bx + cx2 * probe, bz + cz2 * probe)) {
            dx = cx2 * len; dz = cz2 * len; found = true;
          }
        }
      }
      if (!found) return false;
    }
  }
  pos.x = bx + dx; pos.z = bz + dz;
  const cx = pos.x, cz = pos.z;
  world.resolvePosition(pos, radius);
  if (((pos.x - bx) * dx + (pos.z - bz) * dz) / len >= len * 0.35) return true;

  // Blocked by geometry the grid has no opinion about. The eject IS the contact normal.
  if (slide(pos, bx, bz, dx, dz, len, pos.x - cx, pos.z - cz, radius, gate, world)) return true;
  // Genuinely wedged (walked square into a wall). Stay put — and, because we bill realised
  // displacement, stay put for free.
  pos.x = bx; pos.z = bz;
  world.resolvePosition(pos, radius);
  return false;
}

/**
 * Try the sub-step again with the component INTO the contact removed, at unchanged speed.
 * `(nx,nz)` need not be normalised. @returns true if it bought real ground.
 */
function slide(pos, bx, bz, ux, uz, len, nx, nz, radius, nav, world) {
  const nl = Math.hypot(nx, nz);
  if (nl < 1e-5) return false;
  const inx = nx / nl, inz = nz / nl;
  const dot = ux * inx + uz * inz;
  let sx = ux - inx * dot, sz = uz - inz * dot;
  const sl = Math.hypot(sx, sz);
  if (sl < 0.12 * len) return false;          // facing it squarely — stop, do not skate
  const probe = Math.max(len, radius + 0.12) / sl;
  if (nav && !nav.walkableAt(bx + sx * probe, bz + sz * probe)) return false;
  sx = sx / sl * len; sz = sz / sl * len;
  pos.x = bx + sx; pos.z = bz + sz;
  world.resolvePosition(pos, radius);
  if (Math.hypot(pos.x - bx, pos.z - bz) > len * 0.2) return true;
  pos.x = bx; pos.z = bz;
  return false;
}

// --- movement billing -------------------------------------------------------
//
// DO NOT CHARGE FOR DISTANCE NOT TRAVELLED. This is a rule, not a per-obstacle patch.
//
// `spendMove` used to be handed the per-frame |Δpos|, which is not the same quantity as ground
// covered: a body grinding into a collider is ejected out and shoved back in every frame, so it
// bills 0.16 m/s of AP while its net position never changes. Measured live: 450 AP bought 10.1 m
// through the barricade belt, 131 AP bought 2.4 m, against 20 AP/m on open ground; the Edelweiss
// returned 0.0 m for 210 AP three sorties running while the HUD counted 16 m of march down to 6.
//
// The rule: you pay for displacement from an anchor, the anchor advances every 1.5 m (one nav
// cell) of progress, and scuffling inside a chunk is allowed 0.4 m of slack. Consequences,
// stated plainly because both directions are a real failure:
//   - walking straight bills exactly the path length (net == raw), so nothing gets cheaper;
//   - RUBBING along a wall bills full price, because lateral displacement is real travel;
//   - GRINDING into a wall is nearly free — capped at 0.4 m (~8 AP) no matter how long you hold
//     W. That is the failure I chose. The alternative (bill the push-out) is what robbed four
//     soldiers of a whole sortie at one coordinate, and a body that cannot be blocked at all
//     would walk through walls — the resolver above still stops it dead.
//   - a body can shuttle back and forth inside a 1.5 m chunk for less than list price. Nothing
//     tactical fits in 1.5 m, so that is a fair trade for not robbing the player.
const BILL_CHUNK = 1.5;      // re-anchor after this much billed progress (one nav cell)
const BILL_SLACK = 0.4;      // scuffling allowance per chunk
const _ledgers = new WeakMap();

function billMove(pos, sx, sz, want) {
  let L = _ledgers.get(pos);
  if (!L) { L = { ax: sx, az: sz, px: sx, pz: sz, billed: 0, raw: 0 }; _ledgers.set(pos, L); }
  // Anything that moved the body other than us — deploy, spawn, a snap-back, a new turn —
  // invalidates the anchor. Re-anchor rather than bill the jump.
  if (Math.abs(sx - L.px) > 0.5 || Math.abs(sz - L.pz) > 0.5) {
    L.ax = sx; L.az = sz; L.billed = 0; L.raw = 0;
  }
  const raw = Math.hypot(pos.x - sx, pos.z - sz);
  L.raw += raw;
  const net = Math.hypot(pos.x - L.ax, pos.z - L.az);
  let bill = Math.min(L.raw, net + BILL_SLACK) - L.billed;
  if (bill < 0) bill = 0;
  if (bill > want + 0.05) bill = want + 0.05;      // never charge more than was asked for
  L.billed += bill;
  L.px = pos.x; L.pz = pos.z;
  if (net >= BILL_CHUNK) { L.ax = pos.x; L.az = pos.z; L.billed = 0; L.raw = 0; }
  return bill;
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
