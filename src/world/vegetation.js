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
import { makeRng, rngRange, fbm2, valueNoise2 } from '../core/rng.js';
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
 * A grass blade as real geometry: a tapered strip with a baked forward curl.
 * Cheaper in fill than an alpha card and it gives the outline pass a crisp
 * silhouette to bite on.
 *
 * The vertex colour is VALUE ONLY (a slight root-to-tip lift). The pigment
 * itself comes from the material's root/tip ramp and the per-instance tint —
 * baking a green here as well would multiply three greens together and the
 * sward would come out almost black.
 */
function bladeGeometry(levels, width, curl) {
  const ys = [], ws = [], zs = [];
  for (let i = 0; i <= levels; i++) {
    const t = i / levels;
    ys.push(t);
    // Nearly parallel-sided for most of its length, then a fast taper to the
    // point. A blade that tapers linearly from the root is a spearhead, and a
    // meadow made of spearheads reads as foliage, not as grass.
    ws.push(width * Math.pow(1 - t, 0.34));
    zs.push(curl * t * t);
  }
  const pos = [], col = [], uv = [], nrm = [];
  const push = (x, y, z, t) => {
    pos.push(x, y, z);
    const v = 0.92 + t * 0.14;
    col.push(v, v, v);
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

// Envelope shape of the crown, sampled as a lobed ellipsoid. `lobes` are the
// discrete masses a painter would block in before drawing any leaves — the
// canopy is built by filling those, never by scattering cards along branches,
// which is what leaves gaps for the branch structure to show through.
const SPECIES = {
  // `lobeR` is deliberately ~0.6 of `rx`: any smaller and the lobes stop
  // overlapping, and a canopy you can see the sky through is a canopy you can
  // see the branch structure through.
  poplar: {
    height: [12, 17], trunkR: [0.17, 0.26], lean: 0.045,
    // crown: tall, narrow, starts low on the trunk (Lombardy habit)
    crown: { base: 0.34, top: 1.02, rx: 0.165, ry: 0.34, lobes: 7, lobeR: 0.145 },
    limbs: [3, 5], limbRise: 0.34, cards: [13, 17],
    bark: PALETTE.barkPale, leaf: PALETTE.leafPoplar, tex: 'poplar', droop: 0.02,
  },
  oak: {
    height: [8.5, 12.5], trunkR: [0.32, 0.50], lean: 0.11,
    // crown: broad, flattened dome sitting on a short bole
    crown: { base: 0.40, top: 1.0, rx: 0.40, ry: 0.28, lobes: 6, lobeR: 0.255 },
    limbs: [4, 6], limbRise: 0.22, cards: [13, 18],
    bark: PALETTE.bark, leaf: PALETTE.leafOak, tex: 'oak', droop: 0.05,
  },
  willow: {
    height: [7, 10.5], trunkR: [0.30, 0.46], lean: 0.26,
    // crown: weeping — wide, low-shouldered, skirts trail below the mass
    crown: { base: 0.36, top: 0.98, rx: 0.44, ry: 0.30, lobes: 6, lobeR: 0.27 },
    limbs: [4, 5], limbRise: 0.16, cards: [12, 16],
    bark: PALETTE.bark, leaf: PALETTE.leafWillow, tex: 'willow', droop: 0.22,
  },
};

/**
 * Grow one tree.
 *
 * Order matters: the CROWN is blocked in first as a set of lobes on a
 * species-specific envelope, and the limbs are then grown to REACH those lobes.
 * Doing it the other way round — scattering foliage at the ends of whatever
 * branches happened to grow — is what produces bare rods punching through thin
 * blobs of leaf.
 *
 * @returns {{geom, cards, height, radius, trunkR}} branch geometry in local
 *   space (y = 0 at the root flare) plus the foliage card transforms.
 */
function growTree(kind, rng) {
  const S = SPECIES[kind];
  const height = rngRange(rng, S.height[0], S.height[1]);
  const C = S.crown;
  const parts = [];
  const cards = [];
  let maxR = 0.6;

  const trunkR = rngRange(rng, S.trunkR[0], S.trunkR[1]);
  const leanA = rng() * TAU;
  const leanK = rngRange(rng, 0.25, 1) * S.lean;

  // --- crown envelope --------------------------------------------------------
  const crownYc = height * (C.base + C.top) * 0.5;
  const crownRy = height * (C.top - C.base) * 0.5;
  const crownRx = height * C.rx;
  const leanAt = (y) => {
    const t = clamp01(y / height);
    return { x: Math.cos(leanA) * leanK * height * t * t, z: Math.sin(leanA) * leanK * height * t * t };
  };

  // Lobe centres: spiralled around the envelope so the silhouette is a few
  // overlapping masses rather than one smooth ball.
  const lobes = [];
  const nL = C.lobes + ((rng() < 0.5) ? 1 : 0);
  for (let i = 0; i < nL; i++) {
    const t = (i + 0.5) / nL;
    const a = t * TAU * 2.4 + rng() * 0.9;
    // push the lobes toward the outside of the envelope, biased upward
    const rr = (0.30 + 0.70 * Math.sqrt(rng())) * rngRange(rng, 0.85, 1.1);
    const yy = (t - 0.5) * 1.7 + rngRange(rng, -0.22, 0.22);
    const sh = Math.sqrt(Math.max(0.05, 1 - clamp01(Math.abs(yy)) ** 2));
    const cy = crownYc + yy * crownRy;
    const l = leanAt(cy);
    lobes.push({
      x: l.x + Math.cos(a) * rr * crownRx * sh,
      y: cy,
      z: l.z + Math.sin(a) * rr * crownRx * sh,
      r: height * C.lobeR * rngRange(rng, 0.82, 1.22),
    });
  }
  // one dense lobe dead centre so the crown has no hole down its axis
  {
    const l = leanAt(crownYc);
    lobes.push({ x: l.x, y: crownYc + crownRy * 0.05, z: l.z, r: height * C.lobeR * 1.15 });
  }

  // --- trunk -----------------------------------------------------------------
  const trunkTop = height * (C.base + (C.top - C.base) * 0.55);
  {
    const rings = [];
    const segs = 9;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const y = trunkTop * t;
      const l = leanAt(y);
      // root flare, then a smooth taper; a little sway so it is never a pole
      const flare = 1 + 0.85 * Math.pow(1 - clamp01(y / (height * 0.16)), 2.4);
      const sway = Math.sin(t * 2.4 + leanA) * trunkR * 0.5 * t;
      rings.push({
        c: { x: l.x + sway, y: y - 0.25 * (1 - t) * (1 - t), z: l.z + sway * 0.6 },
        r: Math.max(0.05, trunkR * (1 - t * 0.72) * flare),
        rot: t * 0.5,
      });
    }
    parts.push(loft(rings, 8, false, true));
  }

  // --- limbs: one per lobe (plus a couple of decorative ones), each a curved,
  //     tapering loft that ENDS inside its lobe --------------------------------
  const nLimb = Math.min(lobes.length, Math.round(rngRange(rng, S.limbs[0], S.limbs[1])));
  const order = lobes.map((l, i) => i).sort(() => rng() - 0.5);
  for (let i = 0; i < nLimb; i++) {
    const L = lobes[order[i]];
    // spring point on the upper trunk
    const t0 = rngRange(rng, 0.42, 0.94);
    const y0 = trunkTop * t0;
    const o0 = leanAt(y0);
    const from = { x: o0.x, y: y0, z: o0.z };
    const to = { x: L.x, y: L.y - L.r * 0.25, z: L.z };
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const segs = 5;
    const rings = [];
    // Sideways bow + upward rise, so a limb sweeps rather than points. The rise
    // is capped against the lobe it is heading for: a limb whose arc crests
    // above its own foliage comes out of the top of the tree as a bare rod.
    const bowA = Math.atan2(dz, dx) + Math.PI * 0.5;
    const bow = rngRange(rng, -0.26, 0.26) * len;
    const rise = Math.min(S.limbRise * len, Math.max(0, L.y - from.y) * 0.45 + L.r * 0.3);
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const arc = Math.sin(t * Math.PI);
      rings.push({
        c: {
          x: from.x + dx * t + Math.cos(bowA) * bow * arc,
          y: from.y + dy * t + rise * arc - S.droop * len * t * t,
          z: from.z + dz * t + Math.sin(bowA) * bow * arc,
        },
        r: Math.max(0.028, trunkR * (0.52 - 0.40 * t) * rngRange(rng, 0.85, 1.15)),
        rot: t * 0.8,
      });
    }
    parts.push(loft(rings, 6, false, true));
    // a short secondary off the middle of the limb, dying inside the same lobe
    if (rng() < 0.65) {
      const m = 2 + ((rng() * 2) | 0);
      const a = rings[m].c;
      const sub = [];
      const tx2 = L.x + rngRange(rng, -0.6, 0.6) * L.r;
      const ty2 = L.y + rngRange(rng, -0.2, 0.5) * L.r;
      const tz2 = L.z + rngRange(rng, -0.6, 0.6) * L.r;
      for (let k = 0; k <= 3; k++) {
        const t = k / 3;
        sub.push({
          c: {
            x: a.x + (tx2 - a.x) * t,
            y: a.y + (ty2 - a.y) * t + Math.sin(t * Math.PI) * 0.25,
            z: a.z + (tz2 - a.z) * t,
          },
          r: Math.max(0.022, rings[m].r * (0.72 - 0.5 * t)),
        });
      }
      parts.push(loft(sub, 5, false, true));
    }
  }

  // --- foliage: fill every lobe until it is opaque ---------------------------
  for (const L of lobes) {
    const n = Math.round(rngRange(rng, S.cards[0], S.cards[1]) * (0.55 + 0.55 * (L.r / (height * C.lobeR))));
    for (let i = 0; i < n; i++) {
      // sample inside the lobe, biased to the shell so the mass is hollow-ish
      // and the cards are where the silhouette is
      const a = rng() * TAU;
      const u = rng() * 2 - 1;
      const sr = L.r * (0.28 + 0.62 * Math.cbrt(rng()));
      const sxy = Math.sqrt(Math.max(0, 1 - u * u));
      const px = L.x + Math.cos(a) * sxy * sr;
      const py = L.y + u * sr * 0.82;
      const pz = L.z + Math.sin(a) * sxy * sr;
      // Cards are sized off the LOBE, not off an absolute metre range: a
      // sapling's clusters have to shrink with it or it looks like a bush on a
      // stick, and a full-grown oak needs 3 m masses to read as painted foliage.
      const size = L.r * rngRange(rng, 0.72, 1.12);
      cards.push({
        x: px, y: py, z: pz,
        s: size,
        h: size * rngRange(rng, 0.74, 1.04),
        yaw: rng() * TAU,
        pitch: rngRange(rng, -0.3, 0.3),
      });
      maxR = Math.max(maxR, Math.hypot(px, pz) + size * 0.6);
    }
    // willows trail a skirt of hanging withies below the mass
    if (S.droop > 0.15 && L.y > crownYc) {
      for (let i = 0; i < 3; i++) {
        const a = rng() * TAU;
        const rr = L.r * rngRange(rng, 0.5, 1.0);
        cards.push({
          x: L.x + Math.cos(a) * rr,
          y: L.y - L.r * rngRange(rng, 0.9, 1.7),
          z: L.z + Math.sin(a) * rr,
          s: rngRange(rng, 0.7, 1.1),
          h: rngRange(rng, 1.6, 2.6),
          yaw: rng() * TAU,
          pitch: rngRange(rng, -0.12, 0.12),
        });
      }
    }
  }

  const geom = mergeGeoms(parts);
  setGeomColor(geom, S.bark, 0.09, rng);
  return { geom, cards, height, radius: Math.min(maxR, 7.5), trunkR };
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

  /**
   * NOTE on colour: foliage albedo is `mix(rootColor, tipColor) * uColor *
   * vertexColor * instanceColor * map`. Every one of those that carries a green
   * multiplies the others, so exactly ONE of them may hold pigment. Here the
   * root/tip ramp holds it; the maps are value-only detail (see
   * textures.toDetailCutout) and the instance colours are tints near 1.
   */
  _makeMaterials() {
    const q = this.quality;
    // Grass has to survive to the far bank, not stop 40 m out — the whole map is
    // only 180 m across and every wide shot looks straight over the fade.
    this.grassFade = q >= 2 ? [74, 106] : q === 1 ? [56, 82] : [34, 52];

    // Root-to-tip contrast is what makes individual blades legible against a
    // ground of the same hue: without it the sward dissolves into the terrain
    // colour and the meadow reads as a mown lawn.
    this.matGrass = makeFoliageMaterial({
      color: 0xffffff, vertexColors: true, instanced: true,
      rootColor: 0x32432a, tipColor: 0x7d8a49, variation: 0.28,
      windStrength: 0.13, windSpeed: 2.3, windHeight: 1.0, stiffness: 1.7,
      fadeStart: this.grassFade[0], fadeEnd: this.grassFade[1],
      alphaTest: 0.05, rim: 0.9, hatch: 0.22, subsurface: 0.9,
    });

    this.matReed = makeFoliageMaterial({
      color: 0xffffff, vertexColors: true, instanced: true,
      rootColor: 0x46592c, tipColor: PALETTE.reed, variation: 0.22,
      windStrength: 0.19, windSpeed: 1.8, windHeight: 1.0, stiffness: 1.5,
      fadeStart: 90, fadeEnd: 120, alphaTest: 0.05, rim: 1.0, hatch: 0.22,
    });

    this.matFlower = makeFoliageMaterial({
      // white ramp: the flower's own colour arrives per instance
      color: 0xffffff, vertexColors: true, instanced: true,
      rootColor: 0xdedede, tipColor: 0xffffff, variation: 0.12,
      windStrength: 0.10, windSpeed: 2.0, windHeight: 0.4, stiffness: 1.2,
      fadeStart: 34, fadeEnd: 52, alphaTest: 0.05, rim: 1.1, hatch: 0.1,
    });

    this.matWheat = makeFoliageMaterial({
      color: 0xffffff, vertexColors: true, instanced: true,
      rootColor: PALETTE.wheatDark, tipColor: PALETTE.wheat, variation: 0.24,
      map: bladeTexture('wheat', 3),
      windStrength: 0.20, windSpeed: 1.55, windHeight: 1.0, stiffness: 1.4,
      fadeStart: 78, fadeEnd: 105, alphaTest: 0.4, rim: 0.75, hatch: 0.25,
    });

    this.matLeaf = {};
    for (const k of Object.keys(SPECIES)) {
      this.matLeaf[k] = makeFoliageMaterial({
        color: 0xffffff, vertexColors: false, instanced: true,
        rootColor: PALETTE.leafDark, tipColor: SPECIES[k].leaf, variation: 0.32,
        map: leafClusterTexture(SPECIES[k].tex, 5 + Object.keys(SPECIES).indexOf(k)),
        // Cards are centred on their own pivot, so the useful sway range is
        // the upper half: windHeight 0.5 makes the top edge flutter fully.
        windStrength: 0.13, windSpeed: 1.15, windHeight: 0.5, stiffness: 1.0,
        fadeStart: 260, fadeEnd: 320, alphaTest: 0.46, rim: 0.7, hatch: 0.4,
        subsurface: 0.8,
      });
    }
    this.matBush = makeFoliageMaterial({
      color: 0xffffff, vertexColors: false, instanced: true,
      rootColor: PALETTE.leafDark, tipColor: PALETTE.leafOak, variation: 0.3,
      map: leafClusterTexture('bush', 9),
      windStrength: 0.09, windSpeed: 1.4, windHeight: 0.5, stiffness: 1.2,
      fadeStart: 160, fadeEnd: 210, alphaTest: 0.46, rim: 0.6, hatch: 0.45,
      subsurface: 0.7,
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
    const clumpsPerM2 = q >= 2 ? 1.25 : q === 1 ? 0.6 : 0.2;
    const perClump = q >= 2 ? 8 : q === 1 ? 6 : 4;

    const geo = bladeGeometry(4, 0.019, 0.13);
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
            const rr = Math.sqrt(rng()) * 0.34;
            const bx = cx + Math.cos(a) * rr;
            const bz = cz + Math.sin(a) * rr;
            const by = this.terrain.heightAt(bx, bz);
            const hgt = lerp(0.30, 0.76, tall) * rngRange(rng, 0.72, 1.3);
            _e.set(rngRange(rng, -0.24, 0.24), rng() * TAU, rngRange(rng, -0.24, 0.24), 'YXZ');
            _q.setFromEuler(_e);
            _p.set(bx, by - 0.03, bz);
            _s.set(rngRange(rng, 0.8, 1.45), hgt, 1);
            _m4.compose(_p, _q, _s);
            _m4.toArray(mat, count * 16);
            // Per-blade TINT — a modulation of the material's root/tip ramp,
            // never a second pigment. Sun-bleached and warmer on the rises,
            // cooler and deeper in the hollows the light does not reach.
            const ao = this.terrain.aoAt(bx, bz);
            const v = 0.86 + valueNoise2(bx * 3.1, bz * 3.1, this.seed + 3) * 0.34;
            const bleach = clamp01(tall * 0.5 + rng() * 0.5);
            _c.setRGB(
              v * (1.0 + bleach * 0.16),
              v * (1.0 + bleach * 0.07),
              v * (1.0 - bleach * 0.16)
            );
            _c.multiplyScalar(0.84 + ao * 0.28);
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
      const v = rngRange(rng, 0.84, 1.16);
      _c.setRGB(v, v * rngRange(rng, 0.96, 1.03), v * rngRange(rng, 0.90, 1.02));
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
    const geo = bladeGeometry(3, 0.034, 0.22);
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

    const im = new THREE.InstancedMesh(geo, this.matReed, list.length);
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const hgt = rngRange(rng, 0.95, 1.9);
      _e.set(rngRange(rng, -0.22, 0.22), rng() * TAU, rngRange(rng, -0.22, 0.22), 'YXZ');
      _q.setFromEuler(_e);
      _p.set(r.x, r.y - 0.05, r.z);
      _s.set(rngRange(rng, 0.9, 1.5), hgt, 1);
      _m4.compose(_p, _q, _s);
      im.setMatrixAt(i, _m4);
      const v = rngRange(rng, 0.84, 1.16);
      _c.setRGB(v, v * rngRange(rng, 0.95, 1.05), v * rngRange(rng, 0.9, 1.05));
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
    const n = this.quality >= 2 ? 4400 : this.quality === 1 ? 2000 : 700;
    const geo = quadCard(0.085, 0.105);
    ensureAttrs(geo);
    setGeomColor(geo, 0xffffff);
    // Mostly buttercup and poppy; the pale ox-eye is the rare one, because a
    // meadow full of white dots reads as litter rather than as flowers.
    const cols = [PALETTE.flowerA, PALETTE.flowerA, PALETTE.flowerB, PALETTE.flowerC];
    const half = this.terrain.size * 0.5 - 2;
    const items = [];
    // Wildflowers come in drifts, not as an even sprinkle: a slow noise field
    // decides where a patch of ox-eye or poppy has taken hold.
    for (let i = 0; i < n * 4 && items.length < n; i++) {
      const x = rngRange(rng, -half, half);
      const z = rngRange(rng, -half, half);
      const drift = fbm2(x * 0.06 + 41.2, z * 0.06 - 17.5, { octaves: 2, seed: this.seed + 613 });
      if (rng() > this.grassDensity(x, z) * clamp01((drift - 0.42) * 3.4)) continue;
      items.push({ x, z, c: cols[((drift * 7.3) | 0) % cols.length] });
    }
    if (!items.length) return;
    const im = new THREE.InstancedMesh(geo, this.matFlower, items.length);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const y = this.terrain.heightAt(it.x, it.z);
      _e.set(0, rng() * TAU, 0, 'YXZ');
      _q.setFromEuler(_e);
      _p.set(it.x, y + rngRange(rng, 0.07, 0.26), it.z);
      _s.set(1, rngRange(rng, 0.75, 1.2), 1);
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

    const bridge = this.layout.bridge;
    const tryPlace = (x, z, kind, force = false) => {
      if (Math.abs(x) > half || Math.abs(z) > half) return false;
      const h = this.terrain.heightAt(x, z);
      if (h < WATER_Y + 0.25) return false;
      if (this.terrain.slopeAt(x, z) > 0.55) return false;
      if (this.exclude(x, z)) return false;
      const road = this.layout.roadSDF(x, z);
      if (road.d < this.layout.roadHalfWidth(road.t) + 1.6 && !force) return false;
      // Keep the crossing itself clear. It is the objective and the focal point
      // of half the shots in the game; a full-grown oak standing in front of it
      // is a wall across the composition.
      if (!force && Math.hypot(x - bridge.x, z - bridge.z) < bridge.length * 0.72 + 7) return false;
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

    // 2. willows on the riverbank — sparse, and standing well back off the
    //    water so the channel and the crossing stay legible from the bank
    const riv = this.layout.river;
    for (let i = 2; i < riv.n - 2; i += 3) {
      if (rng() > 0.30) continue;
      const t = riv.cum[i] / riv.length;
      let tx = riv.x[i + 1] - riv.x[i - 1], tz = riv.z[i + 1] - riv.z[i - 1];
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;
      const side = rng() < 0.5 ? -1 : 1;
      const off = side * (this.layout.riverHalfWidth(t) + rngRange(rng, 8.0, 15.0));
      tryPlace(riv.x[i] + nx * off, riv.z[i] + nz * off, 'willow');
    }

    // 3. copses of oak scattered over the pasture, clustered by a noise field.
    //    Gallia is farmland, not forest: the trees group into copses and leave
    //    the fields between them open enough to fight across.
    for (let i = 0; i < 2600 && spots.length < 112; i++) {
      const x = rngRange(rng, -half, half);
      const z = rngRange(rng, -half, half);
      const woodland = fbm2(x * 0.017 + 21.3, z * 0.017 - 9.9, { octaves: 3, seed: this.seed + 1231 });
      if (woodland < 0.52) continue;
      if (rng() > (woodland - 0.48) * 2.6) continue;
      if (this.layout.fieldAt(x, z)) continue;
      if (this.layout.villageMask(x, z) > 0.25) continue;
      tryPlace(x, z, rng() < 0.76 ? 'oak' : 'poplar');
    }

    // 4. a shelter belt along the map edge, so the horizon is treed rather than
    //    a bare ridge line — this is what closes the composition at distance
    const edge = this.terrain.size * 0.5 - 8;
    for (let i = 0; i < 700 && spots.length < 168; i++) {
      const side = (rng() * 4) | 0;
      const t = rngRange(rng, -edge, edge);
      const jit = rngRange(rng, 0, 11);
      const x = side < 2 ? t : (side === 2 ? -edge + jit : edge - jit);
      const z = side === 0 ? -edge + jit : side === 1 ? edge - jit : t;
      tryPlace(x, z, rng() < 0.5 ? 'oak' : 'poplar');
    }
    return spots;
  }

  _buildTrees() {
    const rng = makeRng(this.seed ^ 0x1abc);
    // Five grown variants per species. At five, plus a random scale, yaw and a
    // per-tree colour tint, no two trees in a stand read as the same tree —
    // which is the whole point, because cloned trees are instantly obvious.
    const VARIANTS = 5;
    const variants = {};
    for (const kind of Object.keys(SPECIES)) {
      variants[kind] = [];
      for (let v = 0; v < VARIANTS; v++) variants[kind].push(growTree(kind, rng));
    }

    const spots = this._placeTrees();
    const byVariant = new Map();
    const cardsByKind = new Map();
    for (const k of Object.keys(SPECIES)) cardsByKind.set(k, []);

    for (const s of spots) {
      const vi = (rng() * VARIANTS) | 0;
      const v = variants[s.kind][vi];
      // age spread: saplings through full-grown standards
      const scale = rngRange(rng, 0.62, 1.3);
      const yaw = rng() * TAU;
      const key = `${s.kind}:${vi}`;
      if (!byVariant.has(key)) byVariant.set(key, { kind: s.kind, variant: v, list: [] });
      byVariant.get(key).list.push({ x: s.x, y: s.y, z: s.z, scale, yaw });

      // foliage cards are emitted into a per-species instanced mesh, with the
      // tree transform folded in on the CPU
      const cards = cardsByKind.get(s.kind);
      const co = Math.cos(yaw), si = Math.sin(yaw);
      // one tint per tree: some individuals have turned, some are still deep
      const tv = rngRange(rng, 0.86, 1.12);
      const tw = rngRange(rng, -0.06, 0.10);
      for (const c of v.cards) {
        const lx = c.x * scale, ly = c.y * scale, lz = c.z * scale;
        cards.push({
          x: s.x + lx * co - lz * si,
          y: s.y + ly,
          z: s.z + lx * si + lz * co,
          s: c.s * scale,
          h: c.h * scale,
          yaw: c.yaw + yaw,
          pitch: c.pitch,
          r: tv * (1 + tw), g: tv * (1 + tw * 0.35), b: tv * (1 - tw * 0.9),
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
          im.setMatrixAt(n, _m4);
          _c.setRGB(c.r, c.g, c.b);
          im.setColorAt(n, _c);
          n++;
        }
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
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
