// Terrain: the Gallian river valley heightfield.
//
// Pipeline
//   pass A   fbm hills + landform bumps + shell craters + river channel carve
//   derive   village pad elevation, road elevation profile (incl. bridge ramps)
//   pass B   pad + road corridor flattening with smooth influence masks
//   derive   analytic normals (central differences on the field, not per-face
//            averaging), horizon-sampled ambient occlusion, 4-way material splat
//   build    a 6x6 grid of tiles, each with 3 LOD meshes and a drop skirt
//
// Everything gameplay touches — heightAt / normalAt / slopeAt / raycast —
// reads the same Float32Array the LOD0 mesh was built from, with the *same*
// triangle split, so a unit's feet are never above or below the visible ground.

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { fbm2, ridged2, valueNoise2 } from '../core/rng.js';
import { clamp, clamp01, smoothstep, lerp } from '../core/math.js';
import { MissionLayout, MAP_SIZE, WATER_Y } from './layout.js';
import { makeTerrainSurfaceMaterial, PALETTE } from './worldMaterials.js';

// Material indices into the splat vector.
export const SPLAT = { GRASS: 0, DIRT: 1, ROCK: 2, MUD: 3 };

const _col = new THREE.Color();
const _colB = new THREE.Color();
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, terrain: true };

/** Smooth maximum — keeps the ground above the waterline without a hard crease. */
function smoothMax(a, b, k) {
  return 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + k * k)) - k * 0.5;
}

/** Binary search a cumulative-length array for the sample index at arclength s. */
function indexAtArc(cum, n, s) {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < s) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class Terrain {
  /**
   * @param {object} opts { size, seed, resolution, layout, quality }
   */
  constructor(opts = {}) {
    this.size = opts.size ?? MAP_SIZE;
    this.seed = opts.seed ?? CFG.seed;
    // Sampling resolution is deliberately NOT quality-dependent: gameplay must
    // stand on the same ground at every setting. Only the mesh LOD varies.
    this.N = opts.resolution ?? 289;               // nodes per side
    this.cells = this.N - 1;                       // 288 = 6 tiles x 48 cells
    this.cell = this.size / this.cells;
    this.half = this.size * 0.5;
    this.layout = opts.layout || new MissionLayout(this.seed);
    this.quality = opts.quality ?? CFG.quality;

    const n2 = this.N * this.N;
    this.H = new Float32Array(n2);
    this.NX = new Float32Array(n2);
    this.NY = new Float32Array(n2);
    this.NZ = new Float32Array(n2);
    this.AO = new Float32Array(n2);
    this.SP = new Float32Array(n2 * 4);
    this.CR = new Float32Array(n2 * 3);            // baked vertex colour

    this._buildField();
    this._buildDerived();
    this._buildMesh();
  }

  // =========================================================================
  // field construction
  // =========================================================================

  /** Natural landform before any road/village flattening. */
  _naturalHeight(x, z) {
    const L = this.layout;
    const s = this.seed;
    // Rolling pasture: two fbm scales plus a ridged component for the low
    // spines that hedgerows follow.
    const broad = fbm2(x * 0.0068 + 11.3, z * 0.0068 - 4.7, { octaves: 5, seed: s });
    const mid = fbm2(x * 0.021 - 3.1, z * 0.021 + 6.5, { octaves: 4, seed: s + 91 });
    const fine = fbm2(x * 0.085, z * 0.085, { octaves: 3, seed: s + 211 });
    const spine = ridged2(x * 0.013 + 2.2, z * 0.013 - 1.4, { octaves: 3, seed: s + 307 });

    let h = 2.6
      + broad * 9.4
      + (mid - 0.5) * 3.1
      + (fine - 0.5) * 0.62
      + Math.pow(spine, 2.2) * 2.4;

    h += L.hillDelta(x, z);
    return h;
  }

  _buildField() {
    const { N, cell, half, layout } = this;
    const HA = new Float32Array(N * N);

    // ---- pass A: nature, craters, river ---------------------------------
    for (let j = 0; j < N; j++) {
      const z = -half + j * cell;
      for (let i = 0; i < N; i++) {
        const x = -half + i * cell;
        let h = this._naturalHeight(x, z);

        // Keep every non-channel square metre above the waterline, smoothly.
        h = smoothMax(h, WATER_Y + 0.62, 1.1);

        // Shelling.
        h += layout.craterDelta(x, z);
        h = smoothMax(h, WATER_Y + 0.28, 0.55);

        // River channel.
        const r = layout.riverSDF(x, z);
        let hw = layout.riverHalfWidth(r.t);
        // Irregular shoreline — a river edge is never a smooth offset curve.
        hw += (fbm2(x * 0.055, z * 0.055, { octaves: 3, seed: this.seed + 17 }) - 0.5) * 2.6;
        hw = Math.max(2.6, hw);
        const bank = hw + 8.5;
        if (r.d < bank * 1.45) {
          const bedY = WATER_Y - 2.25
            - (fbm2(x * 0.09, z * 0.09, { octaves: 3, seed: this.seed + 53 }) - 0.5) * 0.8;
          const bankTopY = WATER_Y + 1.42;
          const u = clamp01(r.d / bank);
          const P = u * u * (3 - 2 * u);
          const prof = bedY + (bankTopY - bedY) * P;
          const infl = 1 - smoothstep(bank * 0.78, bank * 1.42, r.d);
          h = lerp(h, prof, infl);
        }
        HA[j * N + i] = h;
      }
    }

    // ---- derive: village pad elevation ----------------------------------
    let padSum = 0, padW = 0;
    const V = layout.village;
    const i0 = this._ix(V.x - V.r), i1 = this._ix(V.x + V.r);
    const j0 = this._ix(V.z - V.r), j1 = this._ix(V.z + V.r);
    for (let j = j0; j <= j1; j++) {
      const z = -half + j * cell;
      for (let i = i0; i <= i1; i++) {
        const x = -half + i * cell;
        const w = layout.villageMask(x, z);
        if (w <= 0) continue;
        padSum += HA[j * N + i] * w;
        padW += w;
      }
    }
    const padY = padW > 0 ? padSum / padW : WATER_Y + 4;
    V.y = padY;

    // ---- derive: road elevation profile ---------------------------------
    this.roadProfile = this._buildRoadProfile(HA, layout.road, true);
    this.trackProfile = this._buildRoadProfile(HA, layout.track, false);

    // ---- pass B: flattening ---------------------------------------------
    const H = this.H;
    for (let j = 0; j < N; j++) {
      const z = -half + j * cell;
      for (let i = 0; i < N; i++) {
        const x = -half + i * cell;
        let h = HA[j * N + i];

        // village terrace: 85% flat, 15% of the original relief kept so the
        // pad still breathes and shells still read as craters inside it
        const vm = layout.villageMask(x, z);
        if (vm > 0) {
          const target = padY + (h - padY) * 0.16;
          h = lerp(h, target, vm * 0.92);
        }

        // river influence mask — never carve the road through the channel;
        // the bridge spans it.
        const rr = layout.riverSDF(x, z);
        const chanW = layout.riverHalfWidth(rr.t) + 7.0;
        const overChannel = 1 - smoothstep(chanW * 0.7, chanW * 1.25, rr.d);

        // main road corridor
        const road = layout.roadSDF(x, z);
        const rw = layout.roadHalfWidth(road.t);
        if (road.d < rw + 6.5) {
          const ry = this._profileAt(layout.road, this.roadProfile, road.t);
          const infl = (1 - smoothstep(rw * 0.85, rw + 6.0, road.d)) * (1 - overChannel * 0.92);
          h = lerp(h, ry, infl);
        }

        // farm track — softer, keeps more of the natural profile
        const tr = layout.trackSDF(x, z);
        if (tr.d < 8.0) {
          const ty = this._profileAt(layout.track, this.trackProfile, tr.t);
          const infl = (1 - smoothstep(2.0, 7.0, tr.d)) * 0.72;
          h = lerp(h, ty, infl);
        }

        H[j * N + i] = h;
      }
    }

    // The bridge deck sits on the road profile at the crossing.
    const b = layout.bridge;
    const bt = this._nearestT(layout.road, b.x, b.z);
    b.deckY = this._profileAt(layout.road, this.roadProfile, bt);
  }

  /**
   * Sample the pass-A field along a route, smooth it heavily (a road does not
   * follow every hummock), and for the main road force a level deck across the
   * river with ramped approaches.
   */
  _buildRoadProfile(HA, poly, isBridgeRoad) {
    const n = poly.n;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      raw[i] = this._bilinearFrom(HA, poly.x[i], poly.z[i]);
    }
    // wide box smoothing, run twice ~= gaussian
    const smoothed = new Float32Array(n);
    const R = 7;
    for (let pass = 0; pass < 2; pass++) {
      const src = pass === 0 ? raw : smoothed.slice();
      for (let i = 0; i < n; i++) {
        let s = 0, w = 0;
        for (let k = -R; k <= R; k++) {
          const idx = clamp(i + k, 0, n - 1);
          s += src[idx]; w++;
        }
        smoothed[i] = s / w;
      }
    }
    if (!isBridgeRoad) return smoothed;

    // Locate the span: road samples that fall inside the open water.
    const L = this.layout;
    let s0 = -1, s1 = -1;
    for (let i = 0; i < n; i++) {
      const r = L.riverSDF(poly.x[i], poly.z[i]);
      const w = L.riverHalfWidth(r.t) + 2.0;
      if (r.d < w) { if (s0 < 0) s0 = i; s1 = i; }
    }
    if (s0 < 0) return smoothed;

    const abutA = clamp(s0 - 3, 0, n - 1);
    const abutB = clamp(s1 + 3, 0, n - 1);
    // Deck height is set from the WATERLINE, not from the tops of the banks:
    // a village bridge sits a headroom above the river and the road is cut
    // down through the bank to meet it, rather than the road being carried up
    // onto a viaduct.
    const deckY = Math.max(
      this._bilinearFrom(HA, poly.x[abutA], poly.z[abutA]),
      this._bilinearFrom(HA, poly.x[abutB], poly.z[abutB]),
      WATER_Y + 2.6
    ) + 1.35;
    this.layout.bridge.spanIndex = [s0, s1];

    const ramp = 16;
    for (let i = 0; i < n; i++) {
      if (i >= s0 && i <= s1) { smoothed[i] = deckY; continue; }
      const d = i < s0 ? s0 - i : i - s1;
      if (d < ramp) {
        const t = smoothstep(0, 1, 1 - d / ramp);
        smoothed[i] = lerp(smoothed[i], deckY, t);
      }
    }
    // measure the actual span so the bridge geometry matches the carved gap
    const sx = poly.x[abutA], sz = poly.z[abutA];
    const ex = poly.x[abutB], ez = poly.z[abutB];
    this.layout.bridge.length = clamp(Math.hypot(ex - sx, ez - sz) + 4.0, 20, 40);
    this.layout.bridge.x = (sx + ex) * 0.5;
    this.layout.bridge.z = (sz + ez) * 0.5;
    this.layout.bridge.yaw = Math.atan2(ex - sx, ez - sz);
    return smoothed;
  }

  _profileAt(poly, prof, t) {
    const s = clamp01(t) * poly.length;
    const i = indexAtArc(poly.cum, poly.n, s);
    const i0 = Math.max(0, i - 1);
    const seg = poly.cum[i] - poly.cum[i0];
    const f = seg > 1e-6 ? (s - poly.cum[i0]) / seg : 0;
    return lerp(prof[i0], prof[i], f);
  }

  _nearestT(poly, x, z) {
    let best = Infinity, bi = 0;
    for (let i = 0; i < poly.n; i++) {
      const d = (poly.x[i] - x) ** 2 + (poly.z[i] - z) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    return poly.cum[bi] / poly.length;
  }

  // =========================================================================
  // normals, AO, splat
  // =========================================================================

  _buildDerived() {
    const { N, cell, H, NX, NY, NZ, AO, SP, CR, half, layout } = this;
    const inv2c = 1 / (2 * cell);

    // --- analytic normals from the field's central differences
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const xm = H[j * N + Math.max(0, i - 1)];
        const xp = H[j * N + Math.min(N - 1, i + 1)];
        const zm = H[Math.max(0, j - 1) * N + i];
        const zp = H[Math.min(N - 1, j + 1) * N + i];
        let nx = (xm - xp) * inv2c;
        let nz = (zm - zp) * inv2c;
        const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        NX[k] = nx * inv; NY[k] = inv; NZ[k] = nz * inv;
      }
    }

    // --- horizon-sampled ambient occlusion.
    // For 8 compass directions, march outward and record the steepest rise;
    // that maximum elevation angle is the horizon, and the average across
    // directions is the sky visibility. Cheap, and it correctly darkens the
    // river channel, crater bowls and the lee of every hill.
    const dirs = [];
    for (let a = 0; a < 8; a++) dirs.push([Math.cos(a * Math.PI / 4), Math.sin(a * Math.PI / 4)]);
    const radii = [1.2, 2.8, 5.5, 9.5, 15.0];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const h0 = H[k];
        let occ = 0;
        for (let d = 0; d < 8; d++) {
          const dx = dirs[d][0], dz = dirs[d][1];
          let maxTan = 0;
          for (let s = 0; s < radii.length; s++) {
            const r = radii[s];
            const si = clamp(Math.round(i + (dx * r) / cell), 0, N - 1);
            const sj = clamp(Math.round(j + (dz * r) / cell), 0, N - 1);
            const dh = H[sj * N + si] - h0;
            if (dh > 0) {
              const tan = dh / r;
              if (tan > maxTan) maxTan = tan;
            }
          }
          // horizon elevation -> fraction of that direction's sky blocked
          occ += Math.atan(maxTan) / (Math.PI * 0.5);
        }
        occ /= 8;
        AO[k] = clamp01(1 - occ * 0.92);
      }
    }

    // --- material splat + baked vertex colour
    const cGrass = new THREE.Color(PALETTE.grass);
    const cGrassDry = new THREE.Color(PALETTE.grassDry);
    const cGrassDark = new THREE.Color(PALETTE.grassDark);
    const cGrassLush = new THREE.Color(PALETTE.grassLush);
    const cDirt = new THREE.Color(PALETTE.dirt);
    const cDirtDark = new THREE.Color(PALETTE.dirtDark);
    const cRock = new THREE.Color(PALETTE.rock);
    const cMud = new THREE.Color(PALETTE.mud);
    const cSand = new THREE.Color(PALETTE.sand);
    const shadeTint = new THREE.Color(PALETTE.shadowViolet);

    for (let j = 0; j < N; j++) {
      const z = -half + j * cell;
      for (let i = 0; i < N; i++) {
        const x = -half + i * cell;
        const k = j * N + i;
        const h = H[k];
        const slope = 1 - NY[k];                    // 0 flat, ~0.5 at 45deg

        const river = layout.riverSDF(x, z);
        const hw = layout.riverHalfWidth(river.t);
        const road = layout.roadSDF(x, z);
        const rw = layout.roadHalfWidth(road.t);
        const track = layout.trackSDF(x, z);
        const vm = layout.villageMask(x, z);

        // Three noise scales, each doing a different job:
        //   field  ~90 m — which pasture this is (grazed, hay, rough)
        //   mottle ~29 m — variation inside one field
        //   clump  ~5 m  — the tufting you see from standing height
        const field = fbm2(x * 0.011, z * 0.011, { octaves: 3, seed: this.seed + 733 });
        const mottle = fbm2(x * 0.035, z * 0.035, { octaves: 4, seed: this.seed + 401 });
        const clump = fbm2(x * 0.19, z * 0.19, { octaves: 2, seed: this.seed + 877 });
        const tuft = valueNoise2(x * 0.62, z * 0.62, this.seed + 1471);

        // rock only on genuinely steep faces — a rolling pasture is not scree
        let rock = smoothstep(0.22, 0.50, slope) * (0.5 + mottle * 0.9);
        // Mud hugs the waterline: a narrow shingle margin, not a broad beach.
        // The carved bank rises very gently, so a height-based wet test with any
        // width at all paints eight metres of bare sand up both banks.
        const shore = 1 - smoothstep(hw + 0.3, hw + 2.2, river.d);
        const wet = 1 - smoothstep(WATER_Y + 0.05, WATER_Y + 0.42, h);
        let mud = clamp01(Math.max(shore * 0.8, wet) * (0.55 + mottle * 0.7));
        // Dirt on the road, the track, the village pad and heavy footfall.
        // A country road is not a uniform ribbon of bare earth: it is two wheel
        // RUTS with a grassed crown between them and grass creeping in from the
        // verges, and painting that is most of what makes it read as a cart
        // track rather than as a strip of desert laid over a meadow.
        const rd = road.d / Math.max(0.8, rw);
        const rut = Math.exp(-Math.pow((rd - 0.55) / 0.34, 2));
        const roadM = (1 - smoothstep(0.88, 1.35, rd)) * (0.34 + 0.66 * rut);
        const td = track.d / 2.4;
        const trut = Math.exp(-Math.pow((td - 0.55) / 0.38, 2));
        const trackM = (1 - smoothstep(0.9, 1.5, td)) * (0.28 + 0.6 * trut) * 0.9;
        let dirt = clamp01(Math.max(roadM, trackM) * (0.85 + mottle * 0.3) + vm * 0.13);
        // crater scorch => bare, burnt earth
        let burn = 0;
        for (let c = 0; c < layout.craters.length; c++) {
          const cr = layout.craters[c];
          const dd = Math.hypot(x - cr.x, z - cr.z);
          if (dd >= cr.r * 1.35) continue;
          const f = 1 - smoothstep(cr.r * 0.45, cr.r * 1.2, dd);
          dirt = Math.max(dirt, f);
          // ragged burn edge rather than a clean disc
          burn = Math.max(burn, f * (0.65 + 0.6 * valueNoise2(x * 0.9, z * 0.9, cr.seed)));
        }

        rock = clamp01(rock);
        mud = clamp01(mud * (1 - dirt * 0.5));
        dirt = clamp01(dirt * (1 - mud * 0.4));
        const grass = clamp01(1 - Math.max(rock, Math.max(mud, dirt)));

        const sum = grass + dirt + rock + mud || 1;
        const g = grass / sum, d2 = dirt / sum, r2 = rock / sum, m2 = mud / sum;
        SP[k * 4] = g; SP[k * 4 + 1] = d2; SP[k * 4 + 2] = r2; SP[k * 4 + 3] = m2;

        const ao = AO[k];

        // --- bake the albedo.
        // Pasture first, as a patchwork of three greens: deep and blue-green in
        // the damp hollows the water runs to, ordinary sage over most of it, and
        // sun-bleached straw only on the dry crests. Dryness is driven by real
        // terrain facts (height above the valley floor, convexity, sky exposure)
        // rather than by noise alone, so the fields read as land rather than as
        // a texture.
        const dry = clamp01(
          (field - 0.54) * 2.1
          + (h - 8.0) * 0.035
          + (ao - 0.90) * 1.3
          + (mottle - 0.5) * 0.5
        );
        const damp = clamp01((0.48 - field) * 1.6 + (0.84 - ao) * 1.2 + (5.0 - h) * 0.05);
        _col.copy(cGrass);
        _col.lerp(cGrassLush, damp * 0.9);
        _col.lerp(cGrassDry, dry * 0.80);
        // Tufting: value break-up at the two scales a soldier actually sees —
        // 5 m patches of richer and poorer grazing, and 1.6 m tussocks inside
        // them. Without this the pasture is a billiard cloth.
        _col.multiplyScalar(0.86 + clump * 0.30);
        _col.lerp(cGrassLush, clamp01(tuft - 0.55) * 0.55);
        _col.multiplyScalar(0.95 + tuft * 0.11);
        // shaded hollows deepen toward the darkest green rather than to grey
        _col.lerp(cGrassDark, clamp01(0.62 - ao) * 1.35);

        // Road metal: dry ochre in the wheel ruts, damp umber at the edges.
        // Kept well off `sand` — this is a cart track worn into pasture, and a
        // bright sand ribbon through a green valley reads as a beach.
        _colB.copy(cDirt).lerp(cSand, clamp01(mottle * 0.34 + roadM * 0.22));
        _colB.lerp(cDirtDark, clamp01(0.62 - mottle) * 0.85);
        _col.lerp(_colB, d2 * 0.95);
        _col.lerp(cRock, r2 * 0.92);
        _col.lerp(cMud, m2 * 0.9);

        // grain: fine value variation so the wash is never flat
        const grain = 0.94 + valueNoise2(x * 1.4, z * 1.4, this.seed + 5) * 0.14;
        _col.multiplyScalar(grain);

        // scorching from the shelling — toward the warm brown-violet floor,
        // never toward black
        if (burn > 0.001) _col.lerp(_colB.set(PALETTE.darkest), clamp01(burn) * 0.58);

        // bake AO as a violet-shifted darkening, not a grey multiply. Kept
        // lighter than a physical AO would be: the NPR pass bands the result,
        // and a heavy bake pushes whole hillsides down a band at once.
        _col.lerp(shadeTint, (1 - ao) * 0.40);
        _col.multiplyScalar(0.82 + ao * 0.22);

        CR[k * 3] = _col.r; CR[k * 3 + 1] = _col.g; CR[k * 3 + 2] = _col.b;
      }
    }
  }

  // =========================================================================
  // mesh + LOD
  // =========================================================================

  _buildMesh() {
    this.material = makeTerrainSurfaceMaterial({});
    this.material.userData.terrain = true;

    // A zero-draw root Mesh keeps `terrain.mesh` a THREE.Mesh (per the contract)
    // and exposes `.material`, while the LOD tiles hang off it as children.
    const rootGeom = new THREE.BufferGeometry();
    rootGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    rootGeom.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(rootGeom, this.material);
    this.mesh.name = 'terrain';
    this.mesh.frustumCulled = false;
    this.mesh.userData.outline = false;
    this.mesh.matrixAutoUpdate = false;

    const q = this.quality;
    this.steps = q <= 0 ? [2, 4, 8] : [1, 2, 4];
    this.lodDist = q >= 2 ? [56, 118] : q === 1 ? [44, 96] : [34, 78];

    this.tilesPerSide = 6;
    const tc = this.cells / this.tilesPerSide;     // 48 cells per tile
    this.tiles = [];
    for (let tj = 0; tj < this.tilesPerSide; tj++) {
      for (let ti = 0; ti < this.tilesPerSide; ti++) {
        const lods = this.steps.map((s) => {
          const g = this._buildTileGeometry(ti * tc, tj * tc, tc, s);
          const m = new THREE.Mesh(g, this.material);
          m.castShadow = false;
          m.receiveShadow = true;
          m.userData.outline = false;
          m.matrixAutoUpdate = false;
          m.visible = false;
          this.mesh.add(m);
          return m;
        });
        lods[0].visible = true;
        const cx = -this.half + (ti + 0.5) * tc * this.cell;
        const cz = -this.half + (tj + 0.5) * tc * this.cell;
        this.tiles.push({ ti, tj, cx, cz, lods, active: 0 });
      }
    }
  }

  /**
   * One LOD tile. Positions are world-space (the root has identity transform),
   * so no per-tile matrix maths at runtime and the frustum culler works on the
   * tile's own bounding sphere.
   *
   * The border ring is extruded downward into a skirt: adjacent tiles at
   * different LODs disagree along the seam by up to a few centimetres, and the
   * skirt hides that gap without any stitching bookkeeping.
   */
  _buildTileGeometry(i0, j0, cells, step) {
    const { N, cell, half, H, NX, NY, NZ, AO, CR } = this;
    const n = Math.floor(cells / step) + 1;
    const vcount = n * n;
    const skirtCount = n * 4;
    const total = vcount + skirtCount;

    // `color` carries the finished per-vertex ALBEDO (splat mix + field
    // patchwork + scorch + horizon AO), which is what the terrain shader reads
    // under VC_VCOL_ALBEDO. The raw splat weights stay on the CPU in `SP` —
    // gameplay and vegetation density read them through splatAt(), and the
    // shader derives its own detail weights from slope and noise.
    const pos = new Float32Array(total * 3);
    const nrm = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const col = new Float32Array(total * 3);
    const ao = new Float32Array(total);

    const put = (vi, gi, gj, drop) => {
      const k = gj * N + gi;
      const x = -half + gi * cell;
      const z = -half + gj * cell;
      pos[vi * 3] = x;
      pos[vi * 3 + 1] = H[k] - drop;
      pos[vi * 3 + 2] = z;
      nrm[vi * 3] = NX[k]; nrm[vi * 3 + 1] = NY[k]; nrm[vi * 3 + 2] = NZ[k];
      uv[vi * 2] = (x + half) / this.size;
      uv[vi * 2 + 1] = (z + half) / this.size;
      col[vi * 3] = CR[k * 3]; col[vi * 3 + 1] = CR[k * 3 + 1]; col[vi * 3 + 2] = CR[k * 3 + 2];
      ao[vi] = AO[k];
    };

    for (let jj = 0; jj < n; jj++) {
      for (let ii = 0; ii < n; ii++) {
        put(jj * n + ii, Math.min(N - 1, i0 + ii * step), Math.min(N - 1, j0 + jj * step), 0);
      }
    }

    const idx = [];
    for (let jj = 0; jj < n - 1; jj++) {
      for (let ii = 0; ii < n - 1; ii++) {
        const a = jj * n + ii, b = jj * n + ii + 1;
        const c = (jj + 1) * n + ii + 1, d = (jj + 1) * n + ii;
        // Split along the a-c diagonal, matching heightAt()'s interpolation.
        idx.push(a, c, b, a, d, c);
      }
    }

    // Skirt ring: one dropped vertex per border vertex, quads between them.
    // Both windings are emitted — the skirt is only ever seen edge-on through a
    // LOD seam, and 4 extra triangles per border segment is cheaper than being
    // wrong about which way it faces.
    const SKIRT = 2.2;
    let sv = vcount;
    const ringIndex = [
      (e) => e,                                   // north  (jj = 0)
      (e) => (n - 1) * n + e,                     // south  (jj = n-1)
      (e) => e * n,                               // west   (ii = 0)
      (e) => e * n + (n - 1),                     // east   (ii = n-1)
    ];
    const ringGrid = [
      (e) => [i0 + e * step, j0],
      (e) => [i0 + e * step, j0 + (n - 1) * step],
      (e) => [i0, j0 + e * step],
      (e) => [i0 + (n - 1) * step, j0 + e * step],
    ];
    for (let side = 0; side < 4; side++) {
      const base = sv;
      for (let e = 0; e < n; e++) {
        const [gi, gj] = ringGrid[side](e);
        put(sv++, Math.min(N - 1, gi), Math.min(N - 1, gj), SKIRT);
      }
      for (let e = 0; e < n - 1; e++) {
        const a = ringIndex[side](e), b = ringIndex[side](e + 1);
        const sa = base + e, sb = base + e + 1;
        idx.push(a, sa, sb, a, sb, b);
        idx.push(a, sb, sa, a, b, sb);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** Pick a LOD per tile from camera distance. Called from World.update. */
  update(dt, camera) {
    if (!camera) return;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const [d0, d1] = this.lodDist;
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      const dx = t.cx - cx, dz = t.cz - cz;
      // Height matters: a top-down command camera should not force LOD0 on
      // every tile just because it is 60 m up.
      const d = Math.sqrt(dx * dx + dz * dz + cy * cy * 0.35);
      const want = d < d0 ? 0 : d < d1 ? 1 : 2;
      if (want !== t.active) {
        t.lods[t.active].visible = false;
        t.lods[want].visible = true;
        t.active = want;
      }
    }
  }

  // =========================================================================
  // sampling
  // =========================================================================

  _ix(v) { return clamp(Math.floor((v + this.half) / this.cell), 0, this.N - 1); }

  _bilinearFrom(arr, x, z) {
    const { N, cell, half } = this;
    const fx = clamp((x + half) / cell, 0, N - 1.0001);
    const fz = clamp((z + half) / cell, 0, N - 1.0001);
    const i = fx | 0, j = fz | 0;
    const u = fx - i, v = fz - j;
    const a = arr[j * N + i], b = arr[j * N + i + 1];
    const c = arr[(j + 1) * N + i], d = arr[(j + 1) * N + i + 1];
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  }

  /**
   * Exact ground height. Interpolates over the SAME triangle split the LOD0
   * mesh uses (a-c diagonal, i.e. (i,j)-(i+1,j+1)), so a unit's feet sit
   * precisely on the rendered surface rather than a bilinear approximation of it.
   */
  heightAt(x, z) {
    const { N, cell, half, H } = this;
    const fx = clamp((x + half) / cell, 0, N - 1.0001);
    const fz = clamp((z + half) / cell, 0, N - 1.0001);
    const i = fx | 0, j = fz | 0;
    const u = fx - i, v = fz - j;
    const h00 = H[j * N + i];
    const h10 = H[j * N + i + 1];
    const h01 = H[(j + 1) * N + i];
    const h11 = H[(j + 1) * N + i + 1];
    // Triangle A: (00, 10, 11) when u >= v; Triangle B: (00, 11, 01) otherwise.
    return u >= v
      ? h00 + (h10 - h00) * u + (h11 - h10) * v
      : h00 + (h11 - h01) * u + (h01 - h00) * v;
  }

  /** Smoothly interpolated surface normal. Pass `out` to avoid allocating. */
  normalAt(x, z, out = new THREE.Vector3()) {
    out.set(
      this._bilinearFrom(this.NX, x, z),
      this._bilinearFrom(this.NY, x, z),
      this._bilinearFrom(this.NZ, x, z)
    );
    return out.normalize();
  }

  /** Slope in radians from vertical (0 = flat ground). */
  slopeAt(x, z) {
    const ny = clamp01(this._bilinearFrom(this.NY, x, z));
    return Math.acos(ny);
  }

  /** Baked sky visibility 0..1. */
  aoAt(x, z) { return this._bilinearFrom(this.AO, x, z); }

  /** Material weights [grass, dirt, rock, mud] into `out`. */
  splatAt(x, z, out = [0, 0, 0, 0]) {
    const { N, cell, half, SP } = this;
    const fx = clamp((x + half) / cell, 0, N - 1.0001);
    const fz = clamp((z + half) / cell, 0, N - 1.0001);
    const i = fx | 0, j = fz | 0;
    const u = fx - i, v = fz - j;
    for (let c = 0; c < 4; c++) {
      const a = SP[(j * N + i) * 4 + c], b = SP[(j * N + i + 1) * 4 + c];
      const p = SP[((j + 1) * N + i) * 4 + c], q = SP[((j + 1) * N + i + 1) * 4 + c];
      out[c] = (a + (b - a) * u) * (1 - v) + (p + (q - p) * u) * v;
    }
    return out;
  }

  /** Dominant material name at a point — used by impact VFX and footstep SFX. */
  materialAt(x, z) {
    const s = this.splatAt(x, z, this._sp || (this._sp = [0, 0, 0, 0]));
    if (this.heightAt(x, z) < WATER_Y - 0.02) return 'water';
    let best = 0, bi = 0;
    for (let i = 0; i < 4; i++) if (s[i] > best) { best = s[i]; bi = i; }
    return ['grass', 'dirt', 'rock', 'mud'][bi];
  }

  isWater(x, z) { return this.heightAt(x, z) < WATER_Y - 0.02; }

  inBounds(x, z) {
    return x > -this.half && x < this.half && z > -this.half && z < this.half;
  }

  /**
   * Ray-march the heightfield. Marches in grid-sized steps to bracket the
   * crossing, then bisects — far faster and far more robust than raycasting
   * 200k triangles, and it works against the analytic field rather than a LOD.
   *
   * NOTE: returns a shared scratch record unless `out` is supplied — copy the
   * fields if you need to keep them across calls.
   *
   * @returns {{point:THREE.Vector3, normal:THREE.Vector3, distance:number}|null}
   */
  raycast(origin, dir, maxDist = 400, out = _hit) {
    const step = this.cell * 1.5;
    let t = 0;
    let px = origin.x, py = origin.y, pz = origin.z;
    let prevDiff = py - this.heightAt(px, pz);
    if (prevDiff < 0) {
      // Started underground: report the surface directly above the origin.
      out.point.set(origin.x, this.heightAt(origin.x, origin.z), origin.z);
      this.normalAt(origin.x, origin.z, out.normal);
      out.distance = 0;
      return out;
    }
    const invLen = 1 / (Math.hypot(dir.x, dir.y, dir.z) || 1);
    const dx = dir.x * invLen, dy = dir.y * invLen, dz = dir.z * invLen;

    while (t < maxDist) {
      // Adaptive stride: far from the surface we can leap, near it we creep.
      const stride = Math.max(step, Math.min(prevDiff * 0.85, 12));
      const nt = Math.min(maxDist, t + stride);
      const nx = origin.x + dx * nt, ny = origin.y + dy * nt, nz = origin.z + dz * nt;
      if (!this.inBounds(nx, nz) && !this.inBounds(px, pz)) {
        if (nt >= maxDist) return null;
        t = nt; px = nx; py = ny; pz = nz;
        prevDiff = 1e3;
        continue;
      }
      const diff = ny - this.heightAt(nx, nz);
      if (diff <= 0) {
        // bisect the bracket [t, nt]
        let lo = t, hi = nt;
        for (let k = 0; k < 18; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = origin.x + dx * mid, my = origin.y + dy * mid, mz = origin.z + dz * mid;
          if (my - this.heightAt(mx, mz) > 0) lo = mid; else hi = mid;
        }
        const ht = (lo + hi) * 0.5;
        out.point.set(origin.x + dx * ht, origin.y + dy * ht, origin.z + dz * ht);
        out.point.y = this.heightAt(out.point.x, out.point.z);
        this.normalAt(out.point.x, out.point.z, out.normal);
        out.distance = ht;
        return out;
      }
      t = nt; px = nx; py = ny; pz = nz;
      prevDiff = diff;
      if (nt >= maxDist) break;
    }
    return null;
  }

  /**
   * Drop a point onto the ground. Convenience for every other system that
   * places something on the terrain.
   */
  place(v) { v.y = this.heightAt(v.x, v.z); return v; }

  /** Steepest slope within `r` — used by nav to reject cliff edges. */
  maxSlopeNear(x, z, r = 0.5) {
    let m = this.slopeAt(x, z);
    for (let a = 0; a < 4; a++) {
      const ang = a * Math.PI * 0.5;
      m = Math.max(m, this.slopeAt(x + Math.cos(ang) * r, z + Math.sin(ang) * r));
    }
    return m;
  }

  dispose() {
    for (const t of this.tiles) for (const m of t.lods) m.geometry.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.clear();
  }
}

export { WATER_Y };
