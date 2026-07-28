// Vegetation: instanced grass, procedural trees, hedgerows, wheat, reeds and
// wildflowers.
//
// Density comes from the terrain's own material splat, so grass grows exactly
// where the ground is painted as pasture and stops dead at the road metal and
// the mud line — the two systems can never disagree because they read the same
// array.
//
// Everything is instanced. Grass is bucketed into 30 m tiles that are toggled
// by camera distance and additionally fade out in the vertex shader by
// collapsing each blade into its own root, so there is no popping at the edge
// of the draw distance.

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { makeRng, rngRange, rngPick, fbm2, valueNoise2 } from '../core/rng.js';
import { clamp01, smoothstep, lerp, TAU } from '../core/math.js';
import { makeFoliageMaterial, makeSurfaceMaterial, PALETTE } from './worldMaterials.js';
import { leafClusterTexture, bladeTexture, barkTexture } from './textures.js';
import { loft, mergeGeoms, setGeomColor, quadCard, ensureAttrs } from './geoutil.js';
import { makeBox } from './collider.js';
import { WATER_Y } from './layout.js';

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

const TILE = 30;

// ---------------------------------------------------------------------------
// blade geometry
// ---------------------------------------------------------------------------

/**
 * A grass blade as real geometry: a 4-level tapered strip with a baked forward
 * curl and a base-to-tip colour ramp. Cheaper in fill than an alpha card and it
 * gives the outline pass a crisp silhouette to bite on.
 */
function bladeGeometry(levels, width, curl, colBase, colTip) {
  const ys = [], ws = [], zs = [];
  for (let i = 0; i <= levels; i++) {
    const t = i / levels;
    ys.push(t);
    ws.push(width * Math.pow(1 - t, 0.72));
    zs.push(curl * t * t);
  }
  const pos = [], col = [], uv = [], nrm = [];
  const cb = new THREE.Color(colBase), ct = new THREE.Color(colTip);
  const push = (x, y, z, t) => {
    pos.push(x, y, z);
    _c.copy(cb).lerp(ct, t);
    col.push(_c.r, _c.g, _c.b);
    uv.push(x > 0 ? 1 : 0, t);
    nrm.push(0, 0.3, 1);
  };
  for (let i = 0; i < levels; i++) {
    const t0 = i / levels, t1 = (i + 1) / levels;
    const w0 = ws[i], w1 = ws[i + 1];
    // last segment tapers to a point
    if (i === levels - 1) {
      push(-w0, ys[i], zs[i], t0);
      push(w0, ys[i], zs[i], t0);
      push(0, ys[i + 1], zs[i + 1], t1);
    } else {
      push(-w0, ys[i], zs[i], t0);
      push(w0, ys[i], zs[i], t0);
      push(w1, ys[i + 1], zs[i + 1], t1);
      push(-w0, ys[i], zs[i], t0);
      push(w1, ys[i + 1], zs[i + 1], t1);
      push(-w1, ys[i + 1], zs[i + 1], t1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// procedural trees
// ---------------------------------------------------------------------------

const SPECIES = {
  poplar: {
    height: [11, 16], trunkR: [0.20, 0.30], lean: 0.05,
    splits: 2, splitAngle: 0.30, splitDrop: 0.62, depth: 3,
    cardsPerTip: 3, cardSize: [1.5, 3.4], crownSpread: 0.28,
    bark: PALETTE.barkPale, leaf: PALETTE.leafPoplar, tex: 'poplar',
  },
  oak: {
    height: [7.5, 11], trunkR: [0.34, 0.52], lean: 0.14,
    splits: 3, splitAngle: 0.72, splitDrop: 0.66, depth: 3,
    cardsPerTip: 3, cardSize: [2.6, 2.2], crownSpread: 1.0,
    bark: PALETTE.bark, leaf: PALETTE.leafOak, tex: 'oak',
  },
  willow: {
    height: [6.5, 9.5], trunkR: [0.30, 0.44], lean: 0.30,
    splits: 3, splitAngle: 0.95, splitDrop: 0.60, depth: 3,
    cardsPerTip: 4, cardSize: [2.4, 3.0], crownSpread: 1.15,
    bark: PALETTE.bark, leaf: PALETTE.leafWillow, tex: 'willow',
  },
};

/**
 * Grow one tree. Returns merged branch geometry (bark-coloured, tapered,
 * slightly curved lofts) plus the local transforms for its foliage cards.
 */
function growTree(kind, rng) {
  const S = SPECIES[kind];
  const height = rngRange(rng, S.height[0], S.height[1]);
  const parts = [];
  const cards = [];
  let maxR = 0.5;

  const grow = (origin, dir, len, rad, depth) => {
    // curved loft: the branch drifts and droops as it thins
    const segs = depth === S.depth ? 6 : 3;
    const rings = [];
    const cur = origin.clone();
    const d = dir.clone().normalize();
    const drift = new THREE.Vector3(
      rngRange(rng, -0.22, 0.22), 0, rngRange(rng, -0.22, 0.22)
    );
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      rings.push({
        c: { x: cur.x, y: cur.y, z: cur.z },
        r: Math.max(0.018, rad * (1 - t * 0.62)),
        rot: t * 0.4,
      });
      if (i === segs) break;
      const step = len / segs;
      cur.addScaledVector(d, step);
      cur.addScaledVector(drift, step * 0.32);
      // gravity droop grows with distance from the trunk
      d.y -= (kind === 'willow' ? 0.10 : 0.035) * (S.depth - depth + 1) * t;
      d.normalize();
      maxR = Math.max(maxR, Math.hypot(cur.x, cur.z) + 0.4);
    }
    parts.push(loft(rings, depth > 1 ? 7 : 5, false, true));

    if (depth <= 1) {
      // Terminal: hang foliage clusters along the last third of the limb.
      const n = S.cardsPerTip;
      for (let i = 0; i < n; i++) {
        const t = 0.45 + (i / n) * 0.75;
        const px = origin.x + (cur.x - origin.x) * t + rngRange(rng, -0.45, 0.45);
        const py = origin.y + (cur.y - origin.y) * t + rngRange(rng, -0.3, 0.45);
        const pz = origin.z + (cur.z - origin.z) * t + rngRange(rng, -0.45, 0.45);
        cards.push({
          x: px, y: py, z: pz,
          s: rngRange(rng, 0.78, 1.35),
          yaw: rng() * TAU,
          pitch: rngRange(rng, -0.22, 0.22),
        });
        maxR = Math.max(maxR, Math.hypot(px, pz) + 1.6);
      }
      return;
    }

    const nSplit = S.splits + (rng() < 0.35 ? 1 : 0);
    const base = Math.atan2(d.z, d.x);
    for (let i = 0; i < nSplit; i++) {
      const a = base + (i / nSplit) * TAU + rngRange(rng, -0.5, 0.5);
      const tilt = S.splitAngle * rngRange(rng, 0.65, 1.35);
      const nd = new THREE.Vector3(
        d.x + Math.cos(a) * tilt,
        d.y + rngRange(rng, -0.12, 0.20),
        d.z + Math.sin(a) * tilt
      ).normalize();
      grow(cur.clone(), nd, len * S.splitDrop * rngRange(rng, 0.85, 1.12),
        rad * 0.60, depth - 1);
    }
  };

  const trunkR = rngRange(rng, S.trunkR[0], S.trunkR[1]);
  const start = new THREE.Vector3(0, 0, 0);
  const up = new THREE.Vector3(rngRange(rng, -S.lean, S.lean), 1, rngRange(rng, -S.lean, S.lean)).normalize();
  grow(start, up, height * 0.52, trunkR, S.depth);

  const geom = mergeGeoms(parts);
  setGeomColor(geom, S.bark, 0.09, rng);
  // Root flare: a squat cone where the trunk meets the ground.
  return { geom, cards, height, radius: Math.min(maxR, 6.5), trunkR };
}

// ---------------------------------------------------------------------------

export class Vegetation {
  /**
   * @param {THREE.Scene|THREE.Object3D} parent
   * @param {Terrain} terrain
   * @param {MissionLayout} layout
   * @param {object} opts { seed, quality, exclude(x,z):boolean }
   */
  constructor(parent, terrain, layout, opts = {}) {
    this.terrain = terrain;
    this.layout = layout;
    this.seed = opts.seed ?? CFG.seed;
    this.quality = opts.quality ?? CFG.quality;
    this.exclude = opts.exclude || (() => false);
    this.rng = makeRng(this.seed ^ 0x5eed);
    this.colliders = [];
    this.time = 0;

    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    parent.add(this.group);

    this._makeMaterials();
    this._buildGrass();
    this._buildWheat();
    this._buildReeds();
    this._buildFlowers();
    this._buildTrees();
    this._buildHedges();
  }

  // -----------------------------------------------------------------------

  _makeMaterials() {
    const q = this.quality;
    this.grassFade = q >= 2 ? [40, 56] : q === 1 ? [30, 44] : [20, 32];

    this.matGrass = makeFoliageMaterial({
      color: 0xffffff, vertexColors: true, instanced: true,
      rootColor: PALETTE.grassDark, tipColor: PALETTE.grassDry,
      windStrength: 0.13, windSpeed: 2.3, windHeight: 1.0, stiffness: 1.7,
      fadeStart: this.grassFade[0], fadeEnd: this.grassFade[1],
      alphaTest: 0.05, rim: 0.9, hatch: 0.22,
    });

    this.matWheat = makeFoliageMaterial({
      color: 0xffffff, vertexColors: true, instanced: true,
      rootColor: PALETTE.wheatDark, tipColor: PALETTE.wheat,
      map: bladeTexture('wheat', 3),
      windStrength: 0.20, windSpeed: 1.55, windHeight: 1.0, stiffness: 1.4,
      fadeStart: 78, fadeEnd: 105, alphaTest: 0.4, rim: 0.75, hatch: 0.25,
    });

    this.matLeaf = {};
    for (const k of Object.keys(SPECIES)) {
      this.matLeaf[k] = makeFoliageMaterial({
        color: SPECIES[k].leaf, vertexColors: false, instanced: true,
        rootColor: PALETTE.grassDark, tipColor: SPECIES[k].leaf, variation: 0.3,
        map: leafClusterTexture(SPECIES[k].tex, 5 + Object.keys(SPECIES).indexOf(k)),
        // Cards are centred on their own pivot, so the useful sway range is
        // the upper half: windHeight 0.5 makes the top edge flutter fully.
        windStrength: 0.16, windSpeed: 1.15, windHeight: 0.5, stiffness: 1.0,
        fadeStart: 240, fadeEnd: 300, alphaTest: 0.42, rim: 0.7, hatch: 0.4,
      });
    }
    this.matBush = makeFoliageMaterial({
      color: PALETTE.leafOak, vertexColors: false, instanced: true,
      rootColor: PALETTE.grassDark, tipColor: PALETTE.leafOak, variation: 0.28,
      map: leafClusterTexture('bush', 9),
      windStrength: 0.09, windSpeed: 1.4, windHeight: 0.5, stiffness: 1.2,
      fadeStart: 150, fadeEnd: 200, alphaTest: 0.42, rim: 0.6, hatch: 0.45,
    });

    this.matBark = makeSurfaceMaterial({
      color: 0xffffff, vertexColors: true, instanced: true,
      map: barkTexture(11), roughness: 1, rim: 0.35,
    });
  }

  // -----------------------------------------------------------------------
  // density masks
  // -----------------------------------------------------------------------

  /** 0..1 pasture density at a point, from splat + slope + exclusions. */
  grassDensity(x, z) {
    const t = this.terrain;
    if (!t.inBounds(x, z)) return 0;
    const h = t.heightAt(x, z);
    if (h < WATER_Y + 0.12) return 0;
    const sp = t.splatAt(x, z, this._sp || (this._sp = [0, 0, 0, 0]));
    let d = sp[0] * 1.0 + sp[3] * 0.18;          // grass, a little on mud
    d *= 1 - smoothstep(0.34, 0.62, t.slopeAt(x, z));
    // large-scale patchiness: grazed patches, richer hollows
    const patch = fbm2(x * 0.026 + 3.1, z * 0.026 - 5.4, { octaves: 3, seed: this.seed + 811 });
    d *= 0.42 + patch * 1.05;
    if (this.exclude(x, z)) d = 0;
    return clamp01(d);
  }

  /**
   * Tall-grass concealment 0..1 — the same field that makes the blades tall,
   * so what the player sees is exactly what the accuracy penalty uses.
   */
  concealmentAt(x, z) {
    const f = this.layout.fieldAt(x, z);
    if (f && f.type === 'wheat') return 0.62 + clamp01(f._edge) * 0.18;
    const d = this.grassDensity(x, z);
    if (d < 0.25) return 0;
    const tall = fbm2(x * 0.045 - 12.7, z * 0.045 + 8.3, { octaves: 3, seed: this.seed + 977 });
    return clamp01((tall - 0.54) * 3.4) * clamp01(d * 1.3) * 0.55;
  }

  _tallness(x, z) {
    const tall = fbm2(x * 0.045 - 12.7, z * 0.045 + 8.3, { octaves: 3, seed: this.seed + 977 });
    return clamp01((tall - 0.44) * 2.6);
  }

  // -----------------------------------------------------------------------
  // grass
  // -----------------------------------------------------------------------

  _buildGrass() {
    const q = this.quality;
    const clumpsPerM2 = q >= 2 ? 0.42 : q === 1 ? 0.26 : 0.13;
    const perClump = q >= 2 ? 7 : q === 1 ? 5 : 4;

    const geo = bladeGeometry(3, 0.026, 0.10, PALETTE.grassDark, PALETTE.grassDry);
    this.grassGeo = geo;

    const nT = Math.ceil(this.terrain.size / TILE);
    const half = this.terrain.size * 0.5;
    this.grassTiles = [];
    const rng = makeRng(this.seed ^ 0x17a1);

    for (let tj = 0; tj < nT; tj++) {
      for (let ti = 0; ti < nT; ti++) {
        const x0 = -half + ti * TILE, z0 = -half + tj * TILE;
        const budget = Math.ceil(TILE * TILE * clumpsPerM2) * perClump;
        const mat = new Float32Array(budget * 16);
        const colArr = new Float32Array(budget * 3);
        let count = 0;

        const nClump = Math.ceil(TILE * TILE * clumpsPerM2);
        for (let c = 0; c < nClump && count + perClump <= budget; c++) {
          const cx = x0 + rng() * TILE;
          const cz = z0 + rng() * TILE;
          const dens = this.grassDensity(cx, cz);
          if (rng() > dens) continue;
          const tall = this._tallness(cx, cz);
          const nBlades = 3 + Math.floor(rng() * (perClump - 2));
          for (let b = 0; b < nBlades; b++) {
            const a = rng() * TAU;
            const rr = Math.sqrt(rng()) * 0.32;
            const bx = cx + Math.cos(a) * rr;
            const bz = cz + Math.sin(a) * rr;
            const by = this.terrain.heightAt(bx, bz);
            const hgt = lerp(0.26, 0.78, tall) * rngRange(rng, 0.72, 1.32);
            _e.set(rngRange(rng, -0.18, 0.18), rng() * TAU, rngRange(rng, -0.18, 0.18), 'YXZ');
            _q.setFromEuler(_e);
            _p.set(bx, by - 0.03, bz);
            _s.set(rngRange(rng, 0.8, 1.35), hgt, 1);
            _m4.compose(_p, _q, _s);
            _m4.toArray(mat, count * 16);
            // per-blade colour: sun-bleached on the rises, deeper in hollows
            const ao = this.terrain.aoAt(bx, bz);
            const v = 0.80 + valueNoise2(bx * 3.1, bz * 3.1, this.seed + 3) * 0.42;
            _c.set(PALETTE.grass).lerp(_c.clone().set(PALETTE.grassDry), clamp01(tall * 0.7 + rng() * 0.4));
            _c.multiplyScalar(v * (0.72 + ao * 0.4));
            colArr[count * 3] = _c.r;
            colArr[count * 3 + 1] = _c.g;
            colArr[count * 3 + 2] = _c.b;
            count++;
            if (count >= budget) break;
          }
        }
        if (count === 0) continue;

        const im = new THREE.InstancedMesh(geo, this.matGrass, count);
        im.instanceMatrix.array.set(mat.subarray(0, count * 16));
        im.instanceMatrix.needsUpdate = true;
        im.instanceColor = new THREE.InstancedBufferAttribute(colArr.subarray(0, count * 3), 3);
        im.instanceColor.needsUpdate = true;
        im.castShadow = false;
        im.receiveShadow = false;
        im.userData.outline = false;
        im.frustumCulled = true;
        im.computeBoundingSphere();
        im.matrixAutoUpdate = false;
        this.group.add(im);
        this.grassTiles.push({ mesh: im, cx: x0 + TILE * 0.5, cz: z0 + TILE * 0.5 });
      }
    }
  }

  // -----------------------------------------------------------------------
  // wheat
  // -----------------------------------------------------------------------

  _buildWheat() {
    const q = this.quality;
    const perM2 = q >= 2 ? 1.5 : q === 1 ? 0.9 : 0.5;
    const rng = makeRng(this.seed ^ 0x2b1d);
    const geo = quadCard(0.20, 1.0);
    ensureAttrs(geo);
    setGeomColor(geo, 0xffffff);
    this.wheatGeo = geo;

    const rows = [];
    for (const f of this.layout.fields) {
      if (f.type !== 'wheat') continue;
      const n = Math.ceil(Math.PI * f.rx * f.rz * perM2);
      const co = Math.cos(f.rot), si = Math.sin(f.rot);
      // Sown in rows: the drill lines are a big part of why a wheat field
      // reads as cultivated rather than as tall grass.
      for (let i = 0; i < n; i++) {
        const a = rng() * TAU, rr = Math.sqrt(rng());
        let lx = Math.cos(a) * rr * f.rx;
        let lz = Math.sin(a) * rr * f.rz;
        lz = Math.round(lz / 0.55) * 0.55 + rngRange(rng, -0.09, 0.09);
        const x = f.x + lx * co - lz * si;
        const z = f.z + lx * si + lz * co;
        if (!this.terrain.inBounds(x, z)) continue;
        if (this.exclude(x, z)) continue;
        if (this.terrain.slopeAt(x, z) > 0.45) continue;
        if (this.terrain.heightAt(x, z) < WATER_Y + 0.4) continue;
        const road = this.layout.roadSDF(x, z);
        if (road.d < this.layout.roadHalfWidth(road.t) + 1.4) continue;
        rows.push({ x, z, edge: rr });
      }
    }
    if (!rows.length) return;

    const im = new THREE.InstancedMesh(geo, this.matWheat, rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const y = this.terrain.heightAt(r.x, r.z);
      const h = rngRange(rng, 0.95, 1.45) * lerp(1.0, 0.72, clamp01(r.edge * r.edge));
      _e.set(rngRange(rng, -0.1, 0.1), rng() * TAU, rngRange(rng, -0.1, 0.1), 'YXZ');
      _q.setFromEuler(_e);
      _p.set(r.x, y - 0.05, r.z);
      _s.set(rngRange(rng, 0.85, 1.2), h, 1);
      _m4.compose(_p, _q, _s);
      im.setMatrixAt(i, _m4);
      _c.set(PALETTE.wheat).lerp(_c.clone().set(PALETTE.wheatDark), rng() * 0.75);
      im.setColorAt(i, _c);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = false;
    im.receiveShadow = false;
    im.userData.outline = false;
    im.computeBoundingSphere();
    im.matrixAutoUpdate = false;
    this.group.add(im);
    this.wheat = im;
  }

  // -----------------------------------------------------------------------
  // reeds along the waterline
  // -----------------------------------------------------------------------

  _buildReeds() {
    const rng = makeRng(this.seed ^ 0x9e11);
    const geo = bladeGeometry(3, 0.030, 0.22, 0x5f6b3e, PALETTE.reed);
    const poly = this.layout.river;
    const list = [];
    const q = this.quality;
    const perMetre = q >= 2 ? 7 : q === 1 ? 4 : 2;

    for (let i = 0; i < poly.n - 1; i++) {
      const segLen = Math.hypot(poly.x[i + 1] - poly.x[i], poly.z[i + 1] - poly.z[i]);
      const n = Math.ceil(segLen * perMetre);
      for (let k = 0; k < n; k++) {
        const f = k / n;
        const px = poly.x[i] + (poly.x[i + 1] - poly.x[i]) * f;
        const pz = poly.z[i] + (poly.z[i + 1] - poly.z[i]) * f;
        let tx = poly.x[i + 1] - poly.x[i], tz = poly.z[i + 1] - poly.z[i];
        const tl = Math.hypot(tx, tz) || 1;
        const nx = -tz / tl, nz = tx / tl;
        const t = poly.cum[i] / poly.length;
        const w = this.layout.riverHalfWidth(t);
        const side = rng() < 0.5 ? -1 : 1;
        // Reeds want their feet in 0–0.4 m of water: search outward from the
        // nominal edge for that band.
        const off = side * (w + rngRange(rng, -1.6, 2.2));
        const x = px + nx * off, z = pz + nz * off;
        if (!this.terrain.inBounds(x, z)) continue;
        const h = this.terrain.heightAt(x, z);
        const depth = WATER_Y - h;
        if (depth < -0.25 || depth > 0.55) continue;
        if (this.exclude(x, z)) continue;
        list.push({ x, z, y: h, depth });
      }
    }
    if (!list.length) return;

    const im = new THREE.InstancedMesh(geo, this.matGrass, list.length);
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const hgt = rngRange(rng, 0.85, 1.75);
      _e.set(rngRange(rng, -0.22, 0.22), rng() * TAU, rngRange(rng, -0.22, 0.22), 'YXZ');
      _q.setFromEuler(_e);
      _p.set(r.x, r.y - 0.05, r.z);
      _s.set(rngRange(rng, 0.9, 1.4), hgt, 1);
      _m4.compose(_p, _q, _s);
      im.setMatrixAt(i, _m4);
      _c.set(PALETTE.reed).multiplyScalar(rngRange(rng, 0.82, 1.14));
      im.setColorAt(i, _c);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.userData.outline = false;
    im.castShadow = false;
    im.computeBoundingSphere();
    im.matrixAutoUpdate = false;
    this.group.add(im);
    this.reeds = im;
  }

  // -----------------------------------------------------------------------
  // wildflowers
  // -----------------------------------------------------------------------

  _buildFlowers() {
    const rng = makeRng(this.seed ^ 0x77c3);
    const n = this.quality >= 2 ? 4200 : this.quality === 1 ? 2000 : 800;
    const geo = quadCard(0.10, 0.13);
    ensureAttrs(geo);
    setGeomColor(geo, 0xffffff);
    const cols = [PALETTE.flowerA, PALETTE.flowerB, PALETTE.flowerC];
    const half = this.terrain.size * 0.5 - 2;
    const items = [];
    for (let i = 0; i < n * 3 && items.length < n; i++) {
      const x = rngRange(rng, -half, half);
      const z = rngRange(rng, -half, half);
      if (rng() > this.grassDensity(x, z) * 0.55) continue;
      items.push({ x, z, c: rngPick(rng, cols) });
    }
    if (!items.length) return;
    const im = new THREE.InstancedMesh(geo, this.matGrass, items.length);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const y = this.terrain.heightAt(it.x, it.z);
      _e.set(0, rng() * TAU, 0, 'YXZ');
      _q.setFromEuler(_e);
      _p.set(it.x, y + rngRange(rng, 0.10, 0.34), it.z);
      _s.set(1, rngRange(rng, 0.8, 1.3), 1);
      _m4.compose(_p, _q, _s);
      im.setMatrixAt(i, _m4);
      _c.set(it.c).multiplyScalar(rngRange(rng, 0.85, 1.12));
      im.setColorAt(i, _c);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.userData.outline = false;
    im.castShadow = false;
    im.computeBoundingSphere();
    im.matrixAutoUpdate = false;
    this.group.add(im);
    this.flowers = im;
  }

  // -----------------------------------------------------------------------
  // trees
  // -----------------------------------------------------------------------

  _placeTrees() {
    const rng = makeRng(this.seed ^ 0x3f0d);
    const half = this.terrain.size * 0.5 - 6;
    const spots = [];
    const minGap = 4.2;

    const tryPlace = (x, z, kind, force = false) => {
      if (Math.abs(x) > half || Math.abs(z) > half) return false;
      const h = this.terrain.heightAt(x, z);
      if (h < WATER_Y + 0.25) return false;
      if (this.terrain.slopeAt(x, z) > 0.55) return false;
      if (this.exclude(x, z)) return false;
      const road = this.layout.roadSDF(x, z);
      if (road.d < this.layout.roadHalfWidth(road.t) + 1.6 && !force) return false;
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        if ((s.x - x) ** 2 + (s.z - z) ** 2 < minGap * minGap) return false;
      }
      spots.push({ x, z, y: h, kind });
      return true;
    };

    // 1. an avenue of poplars flanking the road on the southern approach
    const road = this.layout.road;
    for (let i = 4; i < road.n - 4; i += 3) {
      const t = road.cum[i] / road.length;
      if (t < 0.28 || t > 0.52) continue;
      let tx = road.x[i + 1] - road.x[i - 1], tz = road.z[i + 1] - road.z[i - 1];
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;
      for (const side of [-1, 1]) {
        const off = side * (this.layout.roadHalfWidth(t) + rngRange(rng, 1.9, 3.0));
        tryPlace(road.x[i] + nx * off, road.z[i] + nz * off, 'poplar', true);
      }
    }

    // 2. willows on the riverbank
    const riv = this.layout.river;
    for (let i = 2; i < riv.n - 2; i += 2) {
      if (rng() > 0.42) continue;
      const t = riv.cum[i] / riv.length;
      let tx = riv.x[i + 1] - riv.x[i - 1], tz = riv.z[i + 1] - riv.z[i - 1];
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;
      const side = rng() < 0.5 ? -1 : 1;
      const off = side * (this.layout.riverHalfWidth(t) + rngRange(rng, 4.5, 9.5));
      tryPlace(riv.x[i] + nx * off, riv.z[i] + nz * off, 'willow');
    }

    // 3. copses of oak scattered over the pasture, clustered by a noise field
    for (let i = 0; i < 900 && spots.length < 150; i++) {
      const x = rngRange(rng, -half, half);
      const z = rngRange(rng, -half, half);
      const woodland = fbm2(x * 0.017 + 21.3, z * 0.017 - 9.9, { octaves: 3, seed: this.seed + 1231 });
      if (woodland < 0.56) continue;
      if (rng() > (woodland - 0.5) * 2.4) continue;
      if (this.layout.fieldAt(x, z)) continue;
      if (this.layout.villageMask(x, z) > 0.25) continue;
      tryPlace(x, z, rng() < 0.78 ? 'oak' : 'poplar');
    }
    return spots;
  }

  _buildTrees() {
    const rng = makeRng(this.seed ^ 0x1abc);
    // Three grown variants per species; every placed tree picks one and gets a
    // random scale and yaw, which is enough variety at this camera distance.
    const variants = {};
    for (const kind of Object.keys(SPECIES)) {
      variants[kind] = [];
      for (let v = 0; v < 3; v++) variants[kind].push(growTree(kind, rng));
    }

    const spots = this._placeTrees();
    const byVariant = new Map();
    const cardsByKind = new Map();
    for (const k of Object.keys(SPECIES)) cardsByKind.set(k, []);

    for (const s of spots) {
      const vi = (rng() * 3) | 0;
      const v = variants[s.kind][vi];
      const scale = rngRange(rng, 0.82, 1.24);
      const yaw = rng() * TAU;
      const key = `${s.kind}:${vi}`;
      if (!byVariant.has(key)) byVariant.set(key, { kind: s.kind, variant: v, list: [] });
      byVariant.get(key).list.push({ x: s.x, y: s.y, z: s.z, scale, yaw });

      // foliage cards are emitted into a per-species instanced mesh, with the
      // tree transform folded in on the CPU
      const cards = cardsByKind.get(s.kind);
      const co = Math.cos(yaw), si = Math.sin(yaw);
      for (const c of v.cards) {
        const lx = c.x * scale, ly = c.y * scale, lz = c.z * scale;
        cards.push({
          x: s.x + lx * co - lz * si,
          y: s.y + ly,
          z: s.z + lx * si + lz * co,
          s: c.s * scale * SPECIES[s.kind].cardSize[0],
          h: c.s * scale * SPECIES[s.kind].cardSize[1],
          yaw: c.yaw + yaw,
          pitch: c.pitch,
        });
      }

      // trunk collider — thin, partial cover, blocks line of sight
      const r = Math.max(0.24, v.trunkR * scale);
      this.colliders.push(makeBox(
        { x: s.x, y: s.y + v.height * scale * 0.5, z: s.z },
        { x: r, y: v.height * scale * 0.5, z: r },
        yaw,
        { cover: 0.5, conceal: 0.3, solid: true, blocksLos: true, tag: 'tree', destructible: false }
      ));
    }

    // --- trunk instanced meshes
    this.treeMeshes = [];
    for (const { kind, variant, list } of byVariant.values()) {
      const geo = variant.geom;
      const im = new THREE.InstancedMesh(geo, this.matBark, list.length);
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        _e.set(0, t.yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _p.set(t.x, t.y - 0.15, t.z);
        _s.set(t.scale, t.scale, t.scale);
        _m4.compose(_p, _q, _s);
        im.setMatrixAt(i, _m4);
      }
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      im.userData.outline = true;
      im.computeBoundingSphere();
      im.matrixAutoUpdate = false;
      im.name = `trunks:${kind}`;
      this.group.add(im);
      this.treeMeshes.push(im);
    }

    // --- foliage cards: two crossed quads per cluster so the canopy has volume
    this.foliageMeshes = [];
    for (const [kind, cards] of cardsByKind) {
      if (!cards.length) continue;
      const geo = quadCard(1, 1);
      geo.translate(0, -0.5, 0);           // pivot at the cluster centre
      ensureAttrs(geo);
      setGeomColor(geo, 0xffffff);
      const im = new THREE.InstancedMesh(geo, this.matLeaf[kind], cards.length * 2);
      let n = 0;
      for (const c of cards) {
        for (let k = 0; k < 2; k++) {
          _e.set(c.pitch, c.yaw + k * Math.PI * 0.5, 0, 'YXZ');
          _q.setFromEuler(_e);
          _p.set(c.x, c.y, c.z);
          _s.set(c.s, c.h, c.s);
          _m4.compose(_p, _q, _s);
          im.setMatrixAt(n++, _m4);
        }
      }
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = false;
      im.userData.outline = false;
      im.computeBoundingSphere();
      im.matrixAutoUpdate = false;
      this.group.add(im);
      this.foliageMeshes.push(im);
    }
  }

  // -----------------------------------------------------------------------
  // hedgerows
  // -----------------------------------------------------------------------

  _buildHedges() {
    const rng = makeRng(this.seed ^ 0x6ba7);
    const cards = [];
    for (const line of this.layout.hedges) {
      // resample the polyline at ~0.8 m
      const pts = [];
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i], b = line[i + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const n = Math.max(1, Math.round(len / 0.8));
        for (let k = 0; k < n; k++) {
          const f = k / n;
          pts.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f });
        }
      }
      let runStart = null;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const ok = this.terrain.inBounds(p.x, p.z) &&
          this.terrain.heightAt(p.x, p.z) > WATER_Y + 0.35 &&
          !this.exclude(p.x, p.z);
        // a hedge is not continuous — gates and gaps where the road cuts it
        const road = this.layout.roadSDF(p.x, p.z);
        const gap = road.d < this.layout.roadHalfWidth(road.t) + 1.8 ||
          valueNoise2(p.x * 0.4, p.z * 0.4, this.seed + 31) > 0.86;
        if (!ok || gap) {
          if (runStart !== null) { this._hedgeRun(pts, runStart, i - 1, rng); runStart = null; }
          continue;
        }
        if (runStart === null) runStart = i;
        const y = this.terrain.heightAt(p.x, p.z);
        const height = rngRange(rng, 1.5, 2.1);
        for (let c = 0; c < 3; c++) {
          cards.push({
            x: p.x + rngRange(rng, -0.55, 0.55),
            y: y + height * rngRange(rng, 0.35, 0.85),
            z: p.z + rngRange(rng, -0.55, 0.55),
            s: rngRange(rng, 1.5, 2.4),
            yaw: rng() * TAU,
            pitch: rngRange(rng, -0.2, 0.2),
          });
        }
      }
      if (runStart !== null) this._hedgeRun(pts, runStart, pts.length - 1, rng);
    }

    // scattered standalone bushes
    const half = this.terrain.size * 0.5 - 5;
    for (let i = 0; i < 220; i++) {
      const x = rngRange(rng, -half, half), z = rngRange(rng, -half, half);
      if (rng() > this.grassDensity(x, z) * 0.35) continue;
      if (this.layout.fieldAt(x, z)) continue;
      const y = this.terrain.heightAt(x, z);
      const s = rngRange(rng, 0.9, 1.9);
      for (let c = 0; c < 3; c++) {
        cards.push({
          x: x + rngRange(rng, -0.4, 0.4) * s,
          y: y + rngRange(rng, 0.35, 0.95) * s,
          z: z + rngRange(rng, -0.4, 0.4) * s,
          s: s * rngRange(rng, 1.1, 1.7),
          yaw: rng() * TAU,
          pitch: rngRange(rng, -0.25, 0.25),
        });
      }
      this.colliders.push(makeBox(
        { x, y: y + s * 0.45, z }, { x: s * 0.7, y: s * 0.45, z: s * 0.7 }, 0,
        { cover: 0.35, conceal: 0.5, solid: false, blocksLos: false, tag: 'bush' }
      ));
    }

    if (!cards.length) return;
    const geo = quadCard(1, 1);
    geo.translate(0, -0.5, 0);
    ensureAttrs(geo);
    setGeomColor(geo, 0xffffff);
    const im = new THREE.InstancedMesh(geo, this.matBush, cards.length * 2);
    let n = 0;
    for (const c of cards) {
      for (let k = 0; k < 2; k++) {
        _e.set(c.pitch, c.yaw + k * Math.PI * 0.5, 0, 'YXZ');
        _q.setFromEuler(_e);
        _p.set(c.x, c.y, c.z);
        _s.set(c.s, c.s * 0.92, c.s);
        _m4.compose(_p, _q, _s);
        im.setMatrixAt(n++, _m4);
      }
    }
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true;
    im.receiveShadow = false;
    im.userData.outline = false;
    im.computeBoundingSphere();
    im.matrixAutoUpdate = false;
    this.group.add(im);
    this.bushes = im;
  }

  /** One unbroken stretch of hedge becomes a chain of cover boxes. */
  _hedgeRun(pts, i0, i1, rng) {
    const step = 3;
    for (let i = i0; i < i1; i += step) {
      const a = pts[i], b = pts[Math.min(i1, i + step)];
      const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.4) continue;
      const y = this.terrain.heightAt(mx, mz);
      const h = rngRange(rng, 1.45, 1.9);
      this.colliders.push(makeBox(
        { x: mx, y: y + h * 0.5, z: mz },
        { x: len * 0.5 + 0.2, y: h * 0.5, z: 0.65 },
        Math.atan2(b.z - a.z, b.x - a.x),
        { cover: 0.7, conceal: 0.6, solid: true, blocksLos: true, tag: 'hedge', destructible: true, hp: 60 }
      ));
    }
  }

  // -----------------------------------------------------------------------

  update(dt, camera) {
    this.time += dt;
    if (!camera) return;
    // Grass tiles beyond the fade end are switched off entirely; inside it the
    // shader handles the taper, so nothing pops.
    const cut = this.grassFade[1] + TILE * 0.75;
    const cx = camera.position.x, cz = camera.position.z;
    for (let i = 0; i < this.grassTiles.length; i++) {
      const t = this.grassTiles[i];
      const dx = t.cx - cx, dz = t.cz - cz;
      t.mesh.visible = dx * dx + dz * dz < cut * cut;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) { o.geometry?.dispose?.(); }
    });
    this.group.parent?.remove(this.group);
    this.matGrass.dispose();
    this.matWheat.dispose();
    this.matBush.dispose();
    this.matBark.dispose();
    for (const k of Object.keys(this.matLeaf)) this.matLeaf[k].dispose();
  }
}
