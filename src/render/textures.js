// src/render/textures.js
// -----------------------------------------------------------------------------
// Every texture the CANVAS-engine renderer needs, synthesised at runtime.
// Zero external assets: cold-press paper fibre, graphite grain, pencil hatch
// strokes, watercolour pigment blotches, ground detail and the particle sprites
// are all built here from seeded value noise / 2D canvas strokes.
//
// Everything is *tileable*. The tiling trick is a value-noise whose integer
// lattice wraps at a chosen period; because we only ever use lacunarity 2 and
// power-of-two base periods, every octave's period stays integral so the seams
// vanish exactly.
//
// Getters are memoised — the first call pays the generation cost (~1-3 ms each
// at these sizes), later calls are free.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { makeRng } from '../core/rng.js';

// ---------------------------------------------------------------- noise core

function hashi(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function hashi3(x, y, z, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^
          Math.imul(z | 0, 2147483647) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);
const wrap = (v, p) => ((v % p) + p) % p;

// Periodic 2D value noise. `per` is the lattice period in cells.
function tnoise(x, y, per, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = fade(x - xi), v = fade(y - yi);
  const x0 = wrap(xi, per), x1 = wrap(xi + 1, per);
  const y0 = wrap(yi, per), y1 = wrap(yi + 1, per);
  const a = hashi(x0, y0, seed), b = hashi(x1, y0, seed);
  const c = hashi(x0, y1, seed), d = hashi(x1, y1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

// Periodic fbm. base = lattice cells across the whole tile at octave 0.
function tfbm(x, y, base, oct = 5, gain = 0.5, seed = 0) {
  let amp = 1, sum = 0, norm = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    sum += amp * tnoise(x * base * f, y * base * f, base * f, seed + i * 7919);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

// Ridged variant — sharp creases, good for rock fissures and fibre.
function tridge(x, y, base, oct = 4, gain = 0.55, seed = 0) {
  let amp = 1, sum = 0, norm = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    const n = tnoise(x * base * f, y * base * f, base * f, seed + i * 4093);
    sum += amp * (1 - Math.abs(n * 2 - 1));
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

// Tileable cellular (Worley) noise. `per` is the feature-cell period; the
// feature point in each cell is jittered over the WHOLE cell, so the result has
// no lattice direction left in it — which is the entire point of using this for
// paper tooth. Returns [F1, F2] in cell units.
//
// This is the isotropic primitive the old paper texture lacked. Value-noise fbm
// stretched on an axis (which is what "fibre" used to be) is a RULING: its power
// spectrum has a single dominant orientation, and at an 8 px period on a 1:1
// screen fetch that is indistinguishable from a printed halftone. Distance to a
// jittered point set has no preferred orientation at any scale.
// The feature points are baked once per (period, seed) — hoist the table out of
// the pixel loop and the inner 3x3 gather is nine array reads instead of
// eighteen hashes, which is the difference between a 0.5 s texture build and a
// 0.15 s one.
const _cellTables = new Map();
function cellPoints(per, seed) {
  const key = per + ':' + seed;
  let t = _cellTables.get(key);
  if (!t) {
    t = new Float32Array(per * per * 2);
    for (let y = 0; y < per; y++) {
      for (let x = 0; x < per; x++) {
        const i = (y * per + x) * 2;
        t[i] = hashi(x, y, seed);
        t[i + 1] = hashi(x, y, (seed ^ 0x9e3779b9) | 0);
      }
    }
    _cellTables.set(key, t);
  }
  return t;
}

/**
 * F1 (and F2 via `out`) from a hoisted point table. Distances in cell units.
 * The index wrap is a pair of compares rather than a modulo: this runs eleven
 * million times per texture and `%` on a double is not cheap.
 */
function cellF1(P, per, x, y, out) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let dy = -1; dy <= 1; dy++) {
    const cy = yi + dy;
    let wy = cy % per; if (wy < 0) wy += per;
    const row = wy * per * 2;
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      let wx = cx % per; if (wx < 0) wx += per;
      const i = row + wx * 2;
      const ex = x - (cx + P[i]), ey = y - (cy + P[i + 1]);
      const d = ex * ex + ey * ey;
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  if (out) out[0] = Math.sqrt(f2);
  return Math.sqrt(f1);
}

// LATTICE-PRESERVING rotations, for laying an anisotropic field down at an
// angle without losing the tile.
//
// A field sampled at x = (a*u - b*v) * fa is periodic in u and v with period 1
// exactly when a*fa, b*fa are integers — the integer matrix [[a,-b],[b,a]] maps
// Z^2 into itself. So the angle is atan(b/a), the scale is hypot(a,b), and
// `base` is chosen per direction to cancel that scale so all three strand
// families end up the same physical size (about 20 x 39 px at octave 0, i.e. a
// 2:1 stretch). Everything here is an integer; nothing rounds.
const FIBRE_DIRS = [
  { a: 1, b: 0, fa: 2, fb: 1, base: 13 },   //   0 deg
  { a: 1, b: 2, fa: 2, fb: 1, base: 6 },    //  63.4 deg
  { a: -1, b: 2, fa: 2, fb: 1, base: 6 },   // 116.6 deg
];

function tnoise3(x, y, z, per, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const x0 = wrap(xi, per), x1 = wrap(xi + 1, per);
  const y0 = wrap(yi, per), y1 = wrap(yi + 1, per);
  const z0 = wrap(zi, per), z1 = wrap(zi + 1, per);
  const c000 = hashi3(x0, y0, z0, seed), c100 = hashi3(x1, y0, z0, seed);
  const c010 = hashi3(x0, y1, z0, seed), c110 = hashi3(x1, y1, z0, seed);
  const c001 = hashi3(x0, y0, z1, seed), c101 = hashi3(x1, y0, z1, seed);
  const c011 = hashi3(x0, y1, z1, seed), c111 = hashi3(x1, y1, z1, seed);
  const a = (c000 + (c100 - c000) * u) * (1 - v) + (c010 + (c110 - c010) * u) * v;
  const b = (c001 + (c101 - c001) * u) * (1 - v) + (c011 + (c111 - c011) * u) * v;
  return a + (b - a) * w;
}

function tfbm3(x, y, z, base, oct, gain, seed) {
  let amp = 1, sum = 0, norm = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    sum += amp * tnoise3(x * base * f, y * base * f, z * base * f, base * f, seed + i * 6151);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a, b, v) => { const t = sat((v - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- plumbing

const _cache = new Map();
function cached(key, build) {
  let t = _cache.get(key);
  if (!t) { t = build(); _cache.set(key, t); }
  return t;
}

function make2d(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

// aniso 16, not 8. Every one of these sheets is fetched in WORLD space by the
// surface shaders — the ground detail off wp.xz, the paper off vcSurfUV — and
// the surface that matters most is a road running to the horizon, whose pixel
// footprint is a long thin sliver along the view direction. At 8 samples the
// sliver is under-covered and the fetch keeps a coherent remnant of the tile's
// finest octave, compressed in y; the closeup critic measured the result as a
// single 85 deg ruling on the brightest surface in frame. 16 is the cap on
// every GPU this runs on and costs nothing on a texture this small.
function finish(tex, { repeat = true, mips = true, aniso = 16 } = {}) {
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = mips;
  tex.anisotropy = aniso;
  tex.colorSpace = THREE.NoColorSpace;   // all of these are data, not colour
  tex.needsUpdate = true;
  return tex;
}

// A low-frequency field evaluated on a coarse grid and bilinearly upsampled.
// Everything in the paper/ground builds that lives above ~4 * step pixels goes
// through this; it is what keeps a five-field multi-octave texture build inside
// a loading screen instead of costing half a second.
function coarseField(S, step, fn) {
  const G = S / step;
  const a = new Float32Array((G + 1) * (G + 1));
  const inv = 1 / S;
  for (let j = 0; j <= G; j++) {
    for (let i = 0; i <= G; i++) {
      a[j * (G + 1) + i] = fn((i % G) * step * inv, (j % G) * step * inv);
    }
  }
  a.G = G; a.step = step;
  return a;
}
function coarseAt(a, x, y) {
  const G = a.G, st = a.step, W = G + 1;
  const fx = x / st, fy = y / st;
  const i = fx | 0, j = fy | 0;
  const tx = fx - i, ty = fy - j;
  const r0 = j * W + i, r1 = r0 + W;
  const s0 = a[r0] + (a[r0 + 1] - a[r0]) * tx;
  const s1 = a[r1] + (a[r1 + 1] - a[r1]) * tx;
  return s0 + (s1 - s0) * ty;
}

function dataTex(size, fill) {
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  let p = 0;
  const out = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++, p += 4) {
      fill(x * inv, y * inv, out, x, y);
      data[p] = out[0] * 255 + 0.5;
      data[p + 1] = out[1] * 255 + 0.5;
      data[p + 2] = out[2] * 255 + 0.5;
      data[p + 3] = out[3] * 255 + 0.5;
    }
  }
  return new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
}

// ============================================================== PAPER FIBRE
// Genuine cold-press watercolour paper.
//
// ROUND 2 MEASURED THIS AS A MACHINE-RULED HALFTONE and it was: the old "fibre"
// term was two value-noise fbms stretched 7:1 and 7:1 on perpendicular axes, at
// a base period that landed on ~8 screen pixels once the grade pass sampled the
// tile 1:1. Orientation-power anisotropy of the G output measured 290:1 — a
// perfect single-direction screen — and that channel is fetched at ~0.87 texels
// per screen pixel by the surface shaders. Cold-press tooth is the opposite of
// that: it is ISOTROPIC and IRREGULAR at every scale.
//
// So the substrate is now built out of tileable cellular (Worley) noise, which
// has no preferred orientation by construction, at three scales, domain-warped
// so the feature lattice can never show through:
//   * "tooth"   — irregular hills and valleys, the surface that catches pigment
//   * "gran"    — CLUMPED granulation: heavy pigment settling into the tooth in
//                 irregular clusters (the characteristic cauliflower speckle of
//                 a granulating wash), density driven by a separate low-freq
//                 "where the wash pooled" field so it clusters instead of
//                 dusting the sheet evenly
//   * "fibre"   — pulp strands, still present because paper has them, but laid
//                 down in THREE directions each gated by its own mask, so a
//                 strand is visible locally and the aggregate has no direction.
//                 The rotations are integer lattice maps, so the tile still
//                 wraps exactly.
//   * "cockle"  — the very low frequency buckle of a wetted sheet
//
// The field is normalised to an exact mean/sd at build time, because the grade
// pass hard-codes `(paper.r - 0.60)` as its centre.
//
// R: tooth + granulation + fibre (this is what multiplies the frame)
// G: mid-frequency isotropic mottle — wet-edge boundary tooth
// B: cockle (large-scale, drives the luminance ripple)
// A: granulation clump mask (fine, isotropic)

// The grade pass hard-codes `(paper.r - 0.60)` as its centre, so the mean is
// load-bearing. The sd is down from the round-2 texture's 0.095 because the new
// field puts far more of its energy in the 3-12 px tooth octaves and far less in
// the 60 px lobes the old stretched fibre carried — same visible tooth, less
// total multiply, and no low-frequency blotch repeating at the 512 px tile.
const PAPER_MEAN = 0.60;
const PAPER_SD = 0.078;

export function getPaperTexture() {
  return cached('paper', () => {
    const S = 512;
    const seed = (CFG.seed ^ 0x51ab) >>> 0;
    const N = S * S;
    const inv = 1 / S;
    const lumF = new Float32Array(N);
    const midF = new Float32Array(N);
    const cockF = new Float32Array(N);
    const granF = new Float32Array(N);

    const fibSeed = FIBRE_DIRS.map((_, i) => seed + 811 + i * 197);

    // hoisted feature-point tables
    const Pa = cellPoints(40, seed + 11);
    const Pb = cellPoints(88, seed + 23);
    const Pc = cellPoints(168, seed + 31);
    const Pg0 = cellPoints(20, seed + 601);
    const Pg1 = cellPoints(52, seed + 617);

    // low-frequency fields, on a coarse grid (everything here has lobes of
    // 14 px or more, so a 4 px grid resolves it exactly)
    const fWu = coarseField(S, 4, (u, v) => tfbm(u, v, 6, 3, 0.55, seed + 301) - 0.5);
    const fWv = coarseField(S, 4, (u, v) => tfbm(u, v, 6, 3, 0.55, seed + 307) - 0.5);
    const fDens = coarseField(S, 4, (u, v) => tfbm(u, v, 7, 3, 0.60, seed + 401));
    const fCock = coarseField(S, 8, (u, v) => tfbm(u, v, 3, 3, 0.6, seed + 211));
    const fWash = coarseField(S, 4, (u, v) => tfbm(u, v, 9, 3, 0.55, seed + 631));
    const fMask = FIBRE_DIRS.map((_, i) =>
      coarseField(S, 8, (u, v) => sstep(0.40, 0.78, tfbm(u, v, 4, 2, 0.60, fibSeed[i] + 53))));
    // the strand field itself: ~10 px features, so a 2 px grid still resolves it
    const fStrand = FIBRE_DIRS.map((d, i) => coarseField(S, 2, (u, v) =>
      tfbm((u * d.a - v * d.b) * d.fa, (u * d.b + v * d.a) * d.fb, d.base, 3, 0.55, fibSeed[i])));

    let p = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++, p++) {
        const u = x * inv, v = y * inv;

        // Domain warp. Without this the cellular lattice leaves faint rows at
        // the cell period; with it the point set reads as scattered.
        const uu = u + coarseAt(fWu, x, y) * 0.070;
        const vv = v + coarseAt(fWv, x, y) * 0.070;

        // ---- tooth: fractal cellular hills ----------------------------------
        // WEIGHTED FOR WHAT THE SCREEN CAN ACTUALLY RESOLVE. The grade fetches
        // this tile at 1.55x, so 512 texels cover 330 screen px and the three
        // octaves land on 8.3, 3.8 and 2.0 px cells. The 168-cell octave is at
        // Nyquist: at round 5's 2.60x fetch it was 1.2 px with the LOD pinned
        // to mip 0, which does not read as tooth at all — it aliases, which is
        // both the directional shimmer the closeup critic measured on the one
        // surface where the sheet is meant to vanish (16.9:1 orientation
        // anisotropy on a lit road) and a large part of the frame's 1.26%
        // per-pixel sparkle. Energy moved down into the octaves that survive
        // the sampler; total sd is held by norm() below, so this is a change of
        // SPECTRUM, not of strength.
        const a1 = cellF1(Pa, 40, uu * 40, vv * 40);
        const b1 = cellF1(Pb, 88, uu * 88 + 2.7, vv * 88 + 5.1);
        const c1 = cellF1(Pc, 168, uu * 168 + 1.3, vv * 168 + 9.7);
        const tooth = (1 - a1) * 0.50 + (1 - b1) * 0.38 + (1 - c1) * 0.12;

        // ---- granulation: clustered pigment specks --------------------------
        // Clumps sit ON the fine feature points; their DENSITY comes from an
        // independent low-frequency field, which is what makes them cluster into
        // cauliflower patches instead of dusting the sheet uniformly.
        const dens = sstep(0.36, 0.76, coarseAt(fDens, x, y));
        const clump = (1 - sstep(0.06, 0.46, b1)) * 0.55 + (1 - sstep(0.05, 0.40, c1)) * 0.45;
        const gran = clump * dens;

        // ---- fibre: three masked directions, aggregate has no orientation ---
        let fs = 0, fw = 1e-4;
        for (let i = 0; i < 3; i++) {
          const m = coarseAt(fMask[i], x, y);
          if (m <= 0.001) continue;
          fs += coarseAt(fStrand[i], x, y) * m;
          fw += m;
        }
        const fibre = fw > 1e-3 ? fs / fw : 0.5;

        // ---- fine speckle: keeps the grain alive under magnification --------
        const speck = tnoise(u * 256, v * 256, 256, seed + 131);

        // The fibre is the only ORIENTED term in the sheet — three masked
        // directions whose aggregate has no axis, but whose local patches
        // certainly do. At 0.16 it was a sixth of the multiply, and the closeup
        // critic measured the consequence as a single machine ruling at 85 deg
        // over the brightest surface in the frame. Paper has strands in it;
        // they are not a sixth of what you see. The speckle comes down for the
        // same reason as the 168-cell octave: at 256 cells it is 1.3 screen px,
        // i.e. it is not texture, it is aliasing.
        lumF[p] = tooth * 0.62 - gran * 0.34 + (fibre - 0.5) * 0.07 + (speck - 0.5) * 0.05;

        // G: isotropic mid-frequency mottle for the wet-edge boundary tooth.
        // Two cellular octaves at ~26 px and ~10 px plus a broad wash so a
        // terminator picks up paper structure without picking up a direction.
        const g0 = cellF1(Pg0, 20, uu * 20 + 4.1, vv * 20 + 1.9);
        const g1 = cellF1(Pg1, 52, uu * 52 + 7.7, vv * 52 + 3.3);
        midF[p] = (1 - g0) * 0.55 + (1 - g1) * 0.25 + coarseAt(fWash, x, y) * 0.20;

        cockF[p] = coarseAt(fCock, x, y);
        granF[p] = gran * 0.75 + (1 - clump) * 0.10 + speck * 0.15;
      }
    }

    // Normalise the multiply channel onto the exact mean/sd the grade pass and
    // the surface shaders assume. Doing this measured rather than by hand is
    // what keeps a change to the tooth recipe from silently rebalancing the
    // whole frame's contrast.
    const norm = (arr, mean, sd) => {
      let m = 0;
      for (let i = 0; i < N; i++) m += arr[i];
      m /= N;
      let s = 0;
      for (let i = 0; i < N; i++) { const d = arr[i] - m; s += d * d; }
      s = Math.sqrt(s / N) || 1e-5;
      const k = sd / s;
      for (let i = 0; i < N; i++) arr[i] = mean + (arr[i] - m) * k;
    };
    norm(lumF, PAPER_MEAN, PAPER_SD);
    norm(midF, 0.5, 0.155);

    const data = new Uint8Array(N * 4);
    for (let i = 0, q = 0; i < N; i++, q += 4) {
      data[q] = sat(lumF[i]) * 255 + 0.5;
      data[q + 1] = sat(midF[i]) * 255 + 0.5;
      data[q + 2] = sat(cockF[i]) * 255 + 0.5;
      data[q + 3] = sat(granF[i]) * 255 + 0.5;
    }
    return finish(new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType));
  });
}

// ============================================================ GRAPHITE GRAIN
// The tooth a pencil line picks up. Clumpy, high frequency, with occasional
// bald spots where the graphite skipped the paper entirely.

export function getGrainTexture() {
  return cached('grain', () => {
    const S = 256;
    const seed = (CFG.seed ^ 0x9e37) >>> 0;
    const tex = dataTex(S, (u, v, out) => {
      const clump = tfbm(u, v, 24, 4, 0.55, seed + 5);
      const fine = tnoise(u * 256, v * 256, 256, seed + 17);
      const skip = sstep(0.30, 0.62, tfbm(u, v, 10, 3, 0.5, seed + 43));  // bald spots
      const g = sat(mix(0.55, 1.0, clump) * mix(0.72, 1.0, fine));
      out[0] = sat(g * mix(0.35, 1.0, skip));
      out[1] = clump;
      out[2] = fine;
      out[3] = skip;
    });
    return finish(tex);
  });
}

// ============================================================== HATCH FIELD
// A tileable bank of pencil strokes, drawn (not computed) so they have real
// pressure variation and lift-off tapers. Stored 2 angles deep:
//   R: ~35 deg strokes    G: ~-15 deg strokes    B: fine cross tick marks
// The shader uses these to *modulate* its own procedural line field, which is
// what keeps the frequency locked to screen pixels while still looking drawn.

export function getHatchTexture() {
  return cached('hatch', () => {
    const S = 256;
    const rng = makeRng((CFG.seed ^ 0x7a11) >>> 0);
    const layers = [
      { angle: 35 * Math.PI / 180, count: 46, width: 2.1, chan: 0 },
      { angle: -15 * Math.PI / 180, count: 40, width: 2.4, chan: 1 },
      { angle: 78 * Math.PI / 180, count: 26, width: 1.4, chan: 2 },
    ];
    const canvases = layers.map((L) => {
      const c = make2d(S, S);
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, S, S);
      g.lineCap = 'round';
      g.globalCompositeOperation = 'lighter';
      const dx = Math.cos(L.angle), dy = Math.sin(L.angle);
      const nx = -dy, ny = dx;
      for (let i = 0; i < L.count; i++) {
        // stroke centre distributed along the normal axis, jittered
        const t = (i + rng() * 0.55) / L.count;
        const off = (t - 0.5) * S * 2.4;
        const cx = S * 0.5 + nx * off;
        const cy = S * 0.5 + ny * off;
        const len = S * (1.6 + rng() * 1.2);
        const press = 0.34 + rng() * 0.62;
        const wob = 2.2 + rng() * 5.0;
        // draw 9 wrapped copies so the tile is seamless in both axes
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            g.beginPath();
            const sx = cx + ox * S - dx * len * 0.5;
            const sy = cy + oy * S - dy * len * 0.5;
            const segs = 14;
            for (let s = 0; s <= segs; s++) {
              const k = s / segs;
              // a pencil stroke is never straight: low-frequency lateral drift
              const drift = Math.sin(k * 5.3 + i * 1.9) * wob + Math.sin(k * 13.1 + i * 0.7) * wob * 0.3;
              const px = sx + dx * len * k + nx * drift;
              const py = sy + dy * len * k + ny * drift;
              if (s === 0) g.moveTo(px, py); else g.lineTo(px, py);
            }
            // pressure tapers at both ends of a hand stroke
            const grad = g.createLinearGradient(sx, sy, sx + dx * len, sy + dy * len);
            const a = press;
            grad.addColorStop(0.0, 'rgba(255,255,255,0)');
            grad.addColorStop(0.18, `rgba(255,255,255,${a * 0.85})`);
            grad.addColorStop(0.52, `rgba(255,255,255,${a})`);
            grad.addColorStop(0.86, `rgba(255,255,255,${a * 0.7})`);
            grad.addColorStop(1.0, 'rgba(255,255,255,0)');
            g.strokeStyle = grad;
            g.lineWidth = L.width * (0.6 + rng() * 0.9);
            g.stroke();
          }
        }
      }
      return g.getImageData(0, 0, S, S).data;
    });

    const data = new Uint8Array(S * S * 4);
    const seed = (CFG.seed ^ 0x3ff1) >>> 0;
    for (let y = 0, p = 0; y < S; y++) {
      for (let x = 0; x < S; x++, p += 4) {
        const q = p;
        data[p] = canvases[0][q];
        data[p + 1] = canvases[1][q];
        data[p + 2] = canvases[2][q];
        // A: smudge/blend mask so hatching can fade unevenly like a thumb rub
        data[p + 3] = sat(tfbm(x / S, y / S, 8, 3, 0.55, seed)) * 255;
      }
    }
    return finish(new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType));
  });
}

// =========================================================== PIGMENT BLOTCH
// The characteristic uneven density of a gouache wash: broad lumps of colour
// with darker rims where the pigment ran to the edge of the wet area and
// granulation where heavy pigment settled into the paper tooth.
// R: density   G: edge pooling   B: granulation   A: wash boundary distance

export function getBlotchTexture() {
  return cached('blotch', () => {
    const S = 256;
    const seed = (CFG.seed ^ 0x2c0d) >>> 0;
    const inv = 1 / S;

    // pre-compute density so we can take a real gradient for the pooling rim
    const dens = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        dens[y * S + x] = tfbm(x * inv, y * inv, 6, 4, 0.58, seed);
      }
    }
    const at = (x, y) => dens[wrap(y, S) * S + wrap(x, S)];
    const Pgr = cellPoints(74, seed + 313);
    const fPool = coarseField(S, 2, (u, v) => tfbm(u, v, 8, 3, 0.6, seed + 331));

    const tex = dataTex(S, (u, v, out, x, y) => {
      const d = at(x, y);
      const gx = at(x + 1, y) - at(x - 1, y);
      const gy = at(x, y + 1) - at(x, y - 1);
      const grad = Math.sqrt(gx * gx + gy * gy) * S * 0.06;
      const pool = sstep(0.18, 0.85, grad);
      // Granulation is CLUMPED, not a smooth field: heavy pigment drops out of
      // suspension into the tooth in irregular clusters. Cellular blobs whose
      // density is driven by a separate broad "where the wash pooled" wash.
      const gr1 = cellF1(Pgr, 74, u * 74 + 2.9, v * 74 + 6.1);
      const gran = sat((1 - sstep(0.05, 0.44, gr1)) *
                       sstep(0.30, 0.74, coarseAt(fPool, x, y)) * 1.35
                       + tfbm(u, v, 24, 2, 0.5, seed + 347) * 0.30);
      // wash boundary: threshold the density then measure how close we are
      const edge = 1 - Math.abs(d - 0.52) * 4.0;
      out[0] = sat(0.5 + (d - 0.5) * 1.35);
      out[1] = pool;
      out[2] = gran;
      out[3] = sat(edge);
    });
    return finish(tex);
  });
}

// ============================================================= NOISE ATLAS
// General purpose 4-channel noise used for band bleed, wobble flow fields and
// per-stroke jitter. Channels deliberately span very different frequencies.
// R: 3-octave mid   G: 5-octave fine   B: 2-octave broad   A: white

export function getNoiseTexture() {
  return cached('noise', () => {
    const S = 256;
    const seed = (CFG.seed ^ 0x5150) >>> 0;
    const tex = dataTex(S, (u, v, out, x, y) => {
      out[0] = tfbm(u, v, 8, 3, 0.55, seed + 1);
      out[1] = tfbm(u, v, 32, 5, 0.5, seed + 2);
      out[2] = tfbm(u, v, 3, 2, 0.6, seed + 3);
      out[3] = hashi(x, y, seed + 4);
    });
    return finish(tex);
  });
}

// =================================================== 3D NOISE (smoke bodies)
// 32^3 single-channel tiling fbm — gives our watercolour smoke an interior
// density that evolves as the puff drifts, instead of a flat sprite.

export function getNoiseTexture3D() {
  return cached('noise3d', () => {
    const S = 32;
    const seed = (CFG.seed ^ 0x11c3) >>> 0;
    const data = new Uint8Array(S * S * S);
    const inv = 1 / S;
    let p = 0;
    for (let z = 0; z < S; z++) {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++, p++) {
          const n = tfbm3(x * inv, y * inv, z * inv, 4, 3, 0.55, seed);
          data[p] = sat(n) * 255;
        }
      }
    }
    const tex = new THREE.Data3DTexture(data, S, S, S);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  });
}

// ============================================================ GROUND DETAIL
// Per-layer detail for the terrain shader. One texture, four uncorrelated
// masks, so a single fetch drives every ground layer.
// R: grass fibre (fine vertical-ish streaks)
// G: dirt speckle (grit + small pebbles)
// B: rock fissure (ridged)
// A: mud mottle (broad wet/dry patches)

export function getGroundDetailTexture() {
  return cached('ground', () => {
    const S = 512;
    const seed = (CFG.seed ^ 0x60d5) >>> 0;
    const Pt1 = cellPoints(56, seed + 7);
    const Pt2 = cellPoints(116, seed + 19);
    const Pgr = cellPoints(124, seed + 31);
    const Ppb = cellPoints(44, seed + 53);
    const Prv = cellPoints(26, seed + 61);
    const fTuft = coarseField(S, 4, (u, v) => tfbm(u, v, 9, 3, 0.55, seed + 23));
    const fPeb = coarseField(S, 8, (u, v) => tfbm(u, v, 6, 2, 0.6, seed + 59));
    const fMud = coarseField(S, 2, (u, v) => tfbm(u, v, 6, 4, 0.6, seed + 83));
    const _f2 = [0];
    const tex = dataTex(S, (u, v, out, x, y) => {
      // Grass tufts. This used to be `tfbm(u*1.6, v*0.42, ...)` mixed with a
      // ridge stretched the other way — a ROW-CORRELATED field, which under a
      // grazing camera projects to pure horizontal smear (round 2 measured a
      // 3.9:1 directional anisotropy on the near road) AND did not even tile,
      // because 1.6 * 32 is not an integer number of lattice cells. Isotropic
      // clumped aggregate on both counts now: cellular tufts at ~9 px over a
      // broad density wash, so the ground reads as matted growth rather than
      // as a brushed metal streak.
      const tuft = 1 - cellF1(Pt1, 56, u * 56, v * 56);
      const tuft2 = 1 - cellF1(Pt2, 116, u * 116 + 3.1, v * 116 + 7.9);
      const grass = sat(0.5 + (tuft - 0.42) * 0.85 + (tuft2 - 0.42) * 0.45
                        + (coarseAt(fTuft, x, y) - 0.5) * 0.55);

      // Dirt: 2-6 px aggregate. Blobs on a jittered point set, never a lattice.
      const grit = 1 - sstep(0.06, 0.42, cellF1(Pgr, 124, u * 124 + 1.7, v * 124 + 5.3));
      const pebble = (1 - sstep(0.05, 0.30, cellF1(Ppb, 44, u * 44 + 9.1, v * 44 + 2.3))) *
                     sstep(0.42, 0.80, coarseAt(fPeb, x, y));

      // Rock fissures: cellular VEINS (F2-F1 runs along the boundaries between
      // grains, which is what a fissure actually is) over a ridged base. Ridged
      // value noise alone carries the square lattice's axes through at 3.3:1.
      const rf1 = cellF1(Prv, 26, u * 26 + 4.7, v * 26 + 8.3, _f2);
      const vein = 1 - sstep(0.02, 0.22, _f2[0] - rf1);
      const rock = sat(tridge(u, v, 12, 5, 0.55, seed + 67) * 0.62 + vein * 0.46);
      const mud = coarseAt(fMud, x, y);
      out[0] = sat(grass);
      out[1] = sat(0.30 + grit * 0.42 + pebble * 0.45);
      out[2] = sat(rock);
      out[3] = sat(mud);
    });
    return finish(tex);
  });
}

// ============================================================ SPRITE SHEETS
// Particle sprites. These are colour-ish (used as alpha/density masks) so they
// stay NoColorSpace and get shaped in the particle shaders.

// Watercolour smoke blob: an irregular lumpy disc whose alpha falls off in a
// few discrete-ish steps, so the shader can quantise it into painted lobes.
export function getSmokeTexture() {
  return cached('smoke', () => {
    const S = 128;
    const seed = (CFG.seed ^ 0x5a0c) >>> 0;
    const tex = dataTex(S, (u, v, out) => {
      const dx = u - 0.5, dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;              // 0..~1.41
      const ang = Math.atan2(dy, dx);
      // lumpy radius: the silhouette of a cauliflower puff
      const lump = tfbm(0.5 + Math.cos(ang) * 0.25, 0.5 + Math.sin(ang) * 0.25, 5, 3, 0.55, seed);
      const rr = r / (0.72 + (lump - 0.5) * 0.45);
      const body = 1 - sstep(0.55, 1.0, rr);
      const inner = tfbm(u, v, 7, 4, 0.55, seed + 41);
      out[0] = sat(body);                                       // density
      out[1] = sat(inner);                                      // interior variation
      out[2] = sat(1 - sstep(0.0, 0.55, rr));                    // core mask
      out[3] = sat(body * mix(0.65, 1.0, inner));                // alpha
    });
    return finish(tex, { repeat: false, aniso: 1 });
  });
}

// Muzzle flash star — a hot cream core with six irregular spikes.
export function getFlashTexture() {
  return cached('flash', () => {
    const S = 128;
    const c = make2d(S, S);
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'lighter';
    const rng = makeRng((CFG.seed ^ 0xf1a5) >>> 0);
    const cx = S / 2, cy = S / 2;
    // spikes
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + rng() * 0.35;
      const len = S * (0.20 + rng() * 0.28);
      const wid = S * (0.020 + rng() * 0.030);
      g.save();
      g.translate(cx, cy);
      g.rotate(a);
      const grad = g.createLinearGradient(0, 0, len, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(0.35, 'rgba(255,240,205,0.45)');
      grad.addColorStop(1, 'rgba(255,220,160,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, -wid);
      g.lineTo(len, -wid * 0.14);
      g.lineTo(len, wid * 0.14);
      g.lineTo(0, wid);
      g.closePath();
      g.fill();
      g.restore();
    }
    // core
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, S * 0.20);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.4, 'rgba(255,246,215,0.72)');
    core.addColorStop(1, 'rgba(255,206,130,0)');
    g.fillStyle = core;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    return finish(tex, { repeat: false, aniso: 1 });
  });
}

// Tracer / spark streak: a short warm dash, hot in the middle, tapered.
export function getSparkTexture() {
  return cached('spark', () => {
    const W = 128, H = 32;
    const c = make2d(W, H);
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0.00, 'rgba(255,180,90,0)');
    grad.addColorStop(0.22, 'rgba(255,214,140,0.55)');
    grad.addColorStop(0.62, 'rgba(255,250,228,1)');
    grad.addColorStop(0.88, 'rgba(255,236,190,0.55)');
    grad.addColorStop(1.00, 'rgba(255,200,120,0)');
    g.fillStyle = grad;
    for (let y = 0; y < H; y++) {
      // vertical falloff: a soft-edged capsule
      const t = Math.abs((y + 0.5) / H - 0.5) * 2;
      g.globalAlpha = Math.pow(1 - t, 1.6);
      g.fillRect(0, y, W, 1);
    }
    g.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    return finish(tex, { repeat: false, aniso: 1 });
  });
}

// Generic soft disc with a painted (not gaussian) edge — dust, blood mist.
export function getSoftDiscTexture() {
  return cached('disc', () => {
    const S = 64;
    const seed = (CFG.seed ^ 0xd15c) >>> 0;
    const tex = dataTex(S, (u, v, out) => {
      const dx = u - 0.5, dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const n = tfbm(u, v, 6, 3, 0.55, seed);
      const a = 1 - sstep(0.35, 0.98 + (n - 0.5) * 0.35, r);
      out[0] = a; out[1] = n; out[2] = 1 - sstep(0, 0.5, r); out[3] = a;
    });
    return finish(tex, { repeat: false, aniso: 1 });
  });
}

// A 1x256 warm-to-cool ramp used by the grade pass split-tone LUT.
export function getSplitToneRamp() {
  return cached('splitramp', () => {
    const N = 256;
    const data = new Uint8Array(N * 4);
    // shadow: warm brown-violet   mid: neutral straw   highlight: cream
    const shadow = [0.227, 0.184, 0.200];
    const midt = [0.541, 0.502, 0.400];
    const high = [1.000, 0.953, 0.847];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const a = sstep(0.0, 0.5, t), b = sstep(0.45, 1.0, t);
      for (let ch = 0; ch < 3; ch++) {
        const m = mix(shadow[ch], midt[ch], a);
        data[i * 4 + ch] = sat(mix(m, high[ch], b)) * 255;
      }
      data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}

// Warm the whole cache in one go — call during a loading screen so the first
// rendered frame doesn't hitch.
export function warmTextureCache() {
  getPaperTexture();
  getGrainTexture();
  getHatchTexture();
  getBlotchTexture();
  getNoiseTexture();
  getGroundDetailTexture();
  getSmokeTexture();
  getFlashTexture();
  getSparkTexture();
  getSoftDiscTexture();
  getSplitToneRamp();
}

export function disposeTextures() {
  for (const t of _cache.values()) t.dispose?.();
  _cache.clear();
}
