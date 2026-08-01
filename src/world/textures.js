// Procedurally generated textures for the world. ZERO external assets:
// every map here is painted into an offscreen canvas or packed into a
// DataTexture at runtime, seeded from rng.js so the battlefield is identical
// on every load.

import * as THREE from 'three';
import { makeRng, valueNoise2, fbm2 } from '../core/rng.js';
import { TAU, clamp01 } from '../core/math.js';

const cache = new Map();
function cached(key, fn) {
  let t = cache.get(key);
  if (!t) { t = fn(); cache.set(key, t); }
  return t;
}

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/**
 * Convert a painted canvas into a near-white DETAIL map.
 *
 * Every architectural surface in the world gets its hue from baked vertex
 * colours, so the maps must only modulate value — otherwise the map colour and
 * the vertex colour multiply together and the whole village goes muddy. This
 * takes whatever was painted, reduces it to luminance, re-centres it on the
 * image mean and compresses it into [1-strength, 1].
 */
function toDetail(g, size, { strength = 0.3, contrast = 1.0 } = {}, img = null) {
  // `img` lets a caller that has ALREADY read the canvas back hand the pixels
  // straight over. Two getImageData calls on one context is what makes chromium
  // print "Canvas2D: Multiple readback operations ... willReadFrequently" on
  // every page load — and the attribute is NOT the fix: measured, it switches
  // chromium to the software rasteriser, which antialiases differently (the
  // pencil-hatch map came back with 92551 differing bytes, max delta 143). One
  // readback instead of two is free and changes nothing.
  if (!img) img = g.getImageData(0, 0, size, size);
  const d = img.data;
  let mean = 0;
  const lum = new Float32Array(size * size);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    lum[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    mean += lum[p];
  }
  mean = Math.max(1e-4, mean / lum.length);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let v = 1 + (lum[p] / mean - 1) * contrast;
    v = Math.max(1 - strength, Math.min(1, v));
    const b = (v * 255) | 0;
    d[i] = d[i + 1] = d[i + 2] = b;
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

/**
 * Same idea as `toDetail`, but for a CUT-OUT map: the alpha channel is the
 * silhouette and must survive untouched, and the mean is weighted by alpha so
 * the transparent surround does not drag it to black.
 *
 * This is load-bearing. Foliage albedo is `mix(rootColor, tipColor) * map`, so a
 * map that carries its own green multiplies one leaf colour by another and the
 * canopy comes out four times too dark — which is exactly how a stand of oaks
 * turns into a cluster of black blobs.
 */
function toDetailCutout(g, size, { strength = 0.32, contrast = 1.0, lift = 0.12 } = {}) {
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  const lum = new Float32Array(size * size);
  let mean = 0, wsum = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    lum[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    const a = d[i + 3] / 255;
    mean += lum[p] * a; wsum += a;
  }
  mean = wsum > 1e-3 ? Math.max(1e-4, mean / wsum) : 0.5;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let v = 1 + (lum[p] / mean - 1) * contrast;
    v = Math.max(1 - strength, Math.min(1 + lift, v));
    const b = Math.min(255, (v * 255) | 0);
    d[i] = d[i + 1] = d[i + 2] = b;
  }
  g.putImageData(img, 0, 0);
}

function finish(c, { repeat = 1, aniso = 8, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// foliage
// ---------------------------------------------------------------------------

/**
 * Leaf-cluster card: a soft mass of overlapping leaf strokes with a hard
 * alpha edge. Painted as gouache dabs, not photo leaves — the silhouette is
 * lobed and irregular so the outline pass draws something interesting.
 */
export function leafClusterTexture(species = 'oak', seed = 5) {
  return cached(`leaf:${species}:${seed}`, () => {
    const S = 256;
    const c = canvas(S);
    const g = c.getContext('2d');
    const rng = makeRng(seed * 7919 + 13);
    g.clearRect(0, 0, S, S);

    // ROUND 25 — LOBE COUNT UP ~3x, DAB RADIUS DOWN ~2.5x, at constant covered
    // area. `r: 0.20` put an oak dab at 51 px radius on a 256 px card, i.e. 40%
    // of the card's width; a card is ~1.5 m, so a single painted "leaf" was
    // 0.6 m across. That is the literal cabbage. Measured against
    // docs/reference/vc-072.jpg: a canopy there spans ~400 px and its largest
    // individual leaf stroke is 12-16 px, about 3.5% of the crown — a card is
    // roughly a quarter of a crown, so a dab should be ~12-14% of the card, not
    // 40%. The per-card two-tone that r24 blamed for the 'legible discs' read
    // is fixed separately (uHeightShade, materials.js); this is the other half
    // of the same complaint and it lives in the texture, not the geometry.
    const cfg = {
      oak: { lobes: 70, r: 0.075, spread: 0.33, elong: 1.0, tone: [92, 108, 62] },
      poplar: { lobes: 84, r: 0.052, spread: 0.24, elong: 2.1, tone: [104, 120, 66] },
      willow: { lobes: 96, r: 0.044, spread: 0.36, elong: 2.4, tone: [116, 130, 84] },
      bush: { lobes: 58, r: 0.088, spread: 0.32, elong: 0.9, tone: [86, 100, 56] },
    }[species] || { lobes: 64, r: 0.08, spread: 0.32, elong: 1, tone: [96, 112, 64] };

    for (let i = 0; i < cfg.lobes; i++) {
      const a = rng() * TAU;
      const rr = Math.pow(rng(), 0.6) * cfg.spread;
      const cx = S * (0.5 + Math.cos(a) * rr);
      const cy = S * (0.5 + (Math.sin(a) * rr) / cfg.elong);
      const rad = S * cfg.r * (0.55 + rng() * 0.75);
      // Depth shading inside the cluster: lower-inner dabs go violet-shadowed,
      // upper-outer dabs go straw-warm. This is the band split pre-baked.
      //
      // ROUND 25 — mostly RANDOM per dab now rather than purely the dab's
      // height in the card. Keyed on cy alone this baked a top-light/
      // bottom-dark ramp into every card, which is the same defect as the
      // shader's per-card height ramp, printed into the texture instead. A
      // third of it survives so the mass still has some internal order.
      const up = clamp01(0.34 * (1 - cy / S) + 0.66 * rng());
      const shade = 0.62 + up * 0.66;
      const r = Math.min(255, cfg.tone[0] * shade + 26 * up);
      const gg = Math.min(255, cfg.tone[1] * shade + 22 * up);
      const b = Math.min(255, cfg.tone[2] * shade * 0.92 + 34 * (1 - up));
      const grad = g.createRadialGradient(cx, cy, rad * 0.1, cx, cy, rad);
      grad.addColorStop(0, `rgba(${r | 0},${gg | 0},${b | 0},1)`);
      grad.addColorStop(0.68, `rgba(${(r * 0.9) | 0},${(gg * 0.9) | 0},${(b * 0.95) | 0},0.96)`);
      grad.addColorStop(1, `rgba(${(r * 0.8) | 0},${(gg * 0.8) | 0},${(b * 0.9) | 0},0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(cx, cy, rad, rad / (cfg.elong * 0.55 + 0.45), rng() * TAU, 0, TAU);
      g.fill();
    }

    // A few alpha holes so light reads through the canopy — but only a few, and
    // biased to the OUTSIDE of the cluster. Holes punched through the middle of
    // the mass show sky where there should be leaf, and a canopy full of those
    // is exactly what makes a tree read as scrub.
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 14; i++) {
      const a = rng() * TAU;
      const rr = 0.26 + rng() * 0.26;
      const cx = S * (0.5 + Math.cos(a) * rr);
      const cy = S * (0.5 + Math.sin(a) * rr);
      const rad = S * (0.010 + rng() * 0.030);
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
      grad.addColorStop(0, 'rgba(0,0,0,0.9)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }
    g.globalCompositeOperation = 'source-over';

    // pencil strokes over the mass — a few graphite ticks suggesting leaves
    // ROUND 25 — more, shorter ticks to match the smaller dabs above. At
    // 5-18 px against a 20 px leaf they were as long as the leaves themselves.
    g.strokeStyle = 'rgba(58,47,51,0.30)';
    g.lineWidth = 1.2;
    for (let i = 0; i < 78; i++) {
      const x = rng() * S, y = rng() * S;
      const l = 3 + rng() * 7, a = -0.9 + rng() * 0.5;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }

    // Value-only: the leaf HUE belongs to the material's root/tip ramp.
    toDetailCutout(g, S, { strength: 0.34, contrast: 1.15, lift: 0.16 });
    const t = finish(c, { repeat: 1 });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Single grass blade / wheat head silhouette with a soft tip. */
export function bladeTexture(kind = 'grass', seed = 3) {
  return cached(`blade:${kind}:${seed}`, () => {
    const S = 64;
    const c = canvas(S);
    const g = c.getContext('2d');
    const rng = makeRng(seed * 331 + 7);
    g.clearRect(0, 0, S, S);
    const wheat = kind === 'wheat';
    for (let y = 0; y < S; y++) {
      const v = 1 - y / S;                    // 1 at tip
      // The EAR is the top fifth of a wheat stem, not the top two thirds: a
      // long fat head reads as a leaf, and a field of leaves is not a crop.
      // The stem has to survive to a pixel or the ear reads as a yellow
      // teardrop hanging in mid-air with nothing under it — which is exactly
      // what a 2 px stem on a 64 px map does at 15 m.
      let half = wheat
        ? (v > 0.80 ? 0.20 * Math.sin((v - 0.80) / 0.20 * Math.PI) + 0.055 : 0.055)
        : 0.19 * Math.pow(1 - v, 0.55) + 0.012;
      half *= S;
      const cx = S * 0.5;
      const base = wheat ? [186, 158, 88] : [104, 122, 66];
      const tip = wheat ? [222, 196, 122] : [148, 162, 92];
      const t = v;
      const r = base[0] + (tip[0] - base[0]) * t;
      const gg = base[1] + (tip[1] - base[1]) * t;
      const b = base[2] + (tip[2] - base[2]) * t;
      g.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
      g.fillRect(cx - half, y, half * 2, 1);
    }
    if (wheat) {
      // awns: the bristles standing off the ear
      g.strokeStyle = 'rgba(212,188,120,0.85)';
      g.lineWidth = 1;
      for (let i = 0; i < 11; i++) {
        const y = 2 + rng() * 9;
        g.beginPath();
        g.moveTo(S * 0.5, y + 6);
        g.lineTo(S * 0.5 + (rng() - 0.5) * 17, y);
        g.stroke();
      }
    }
    toDetailCutout(g, S, { strength: 0.26, contrast: 1.0, lift: 0.14 });
    const t = finish(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/**
 * Wildflower: a drawn stem with a lobed rosette at the top, cut out on alpha.
 *
 * Round 1 gave matFlower no map at all, so `alphaTest: 0.05` was a no-op and
 * every buttercup rendered as an opaque axis-aligned RECTANGLE — literal
 * coloured squares hanging over the meadow. The silhouette has to come from
 * somewhere, and this is it. Value-only, like every other foliage map: the
 * pigment arrives per instance.
 */
export function blossomTexture(kind = 'a', seed = 5) {
  return cached(`blossom:${kind}:${seed}`, () => {
    const S = 64;
    const c = canvas(S);
    const g = c.getContext('2d');
    const rng = makeRng(seed * 613 + 11);
    g.clearRect(0, 0, S, S);

    // stem: a wobbling line from the bottom edge up to the head
    const headY = S * 0.30;
    g.strokeStyle = 'rgba(96,110,64,0.95)';
    g.lineWidth = 2.0;
    g.beginPath();
    g.moveTo(S * 0.5, S);
    for (let i = 1; i <= 6; i++) {
      const t = i / 6;
      g.lineTo(S * (0.5 + Math.sin(t * 2.1) * 0.045), S - t * (S - headY));
    }
    g.stroke();
    // a leaf off the stem
    g.fillStyle = 'rgba(104,118,70,0.92)';
    g.beginPath();
    g.ellipse(S * 0.40, S * 0.72, S * 0.11, S * 0.045, -0.5, 0, TAU);
    g.fill();

    // head: five to seven petals round a dark eye
    const petals = kind === 'c' ? 12 : 5 + ((rng() * 3) | 0);
    const R = S * (kind === 'b' ? 0.30 : 0.26);
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * TAU + rng() * 0.2;
      const px = S * 0.5 + Math.cos(a) * R * 0.52;
      const py = headY + Math.sin(a) * R * 0.52;
      const grad = g.createRadialGradient(px, py, 1, px, py, R * 0.62);
      grad.addColorStop(0, 'rgba(246,238,206,1)');
      grad.addColorStop(0.75, 'rgba(226,214,176,0.98)');
      grad.addColorStop(1, 'rgba(200,188,152,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(px, py, R * 0.50, R * 0.34, a, 0, TAU);
      g.fill();
    }
    // eye
    g.fillStyle = 'rgba(120,100,60,0.9)';
    g.beginPath();
    g.arc(S * 0.5, headY, R * 0.20, 0, TAU);
    g.fill();

    toDetailCutout(g, S, { strength: 0.30, contrast: 1.0, lift: 0.18 });
    const t = finish(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

// ---------------------------------------------------------------------------
// surfaces
// ---------------------------------------------------------------------------

/** Rough bark: vertical fibrous streaks, warm umber with violet crevices. */
export function barkTexture(seed = 11) {
  return cached(`bark:${seed}`, () => {
    const S = 256;
    const c = canvas(S);
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        // strongly anisotropic noise -> vertical fibres
        const n = fbm2(x * 0.16, y * 0.022, { octaves: 4, seed });
        const crack = Math.pow(1 - Math.abs(n * 2 - 1), 3);
        const v = 0.55 + n * 0.5 - crack * 0.55;
        const i = (y * S + x) * 4;
        d[i] = clamp01(v * 0.62 + 0.10) * 255;
        d[i + 1] = clamp01(v * 0.54 + 0.085) * 255;
        d[i + 2] = clamp01(v * 0.48 + 0.105) * 255;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    toDetail(g, S, { strength: 0.34, contrast: 1.15 });
    return finish(c, { repeat: 1 });
  });
}

/**
 * Clay pantile roof: horizontal courses of overlapping tiles.
 *
 * The `tile` material shipped with NO map at all, which is why every roof in
 * the game measured as "a flat brick-red gradient with zero tile courses" — a
 * 12 m expanse of one value is the most obviously untextured primitive in the
 * frame. The map is value-only (see toDetail): the brick-red pigment stays in
 * the baked vertex colour, and this only carves the courses, the roll of each
 * pantile, the shadow under every lap and a per-tile value jitter.
 *
 * Authored so that at uvScale 0.5 (one texture per 2 m of roof) the courses
 * land at ~0.14 m, which is what a real pantile gauge is.
 */
export function roofTileTexture(seed = 37) {
  return cached(`rooftile:${seed}`, () => {
    const S = 256;
    const c = canvas(S);
    const g = c.getContext('2d');
    const rows = 14;             // -> 0.143 m courses at a 2 m tile
    const cols = 11;
    const rh = S / rows, cw = S / cols;
    const rng = makeRng(seed);
    // per-tile value jitter, +/-8%
    const jitter = new Float32Array(rows * cols);
    for (let i = 0; i < jitter.length; i++) jitter[i] = 0.92 + rng() * 0.16;

    g.fillStyle = '#8a8a8a';
    g.fillRect(0, 0, S, S);
    for (let r = 0; r < rows; r++) {
      const y0 = r * rh;
      // Alternate courses are offset half a tile, the way pantiles are laid.
      const off = (r & 1) ? cw * 0.5 : 0;
      for (let k = -1; k <= cols; k++) {
        const x0 = k * cw + off;
        const j = jitter[r * cols + ((k + cols) % cols)];
        // the barrel of the tile: bright on the roll, dark in the pan
        const grd = g.createLinearGradient(x0, 0, x0 + cw, 0);
        grd.addColorStop(0.00, `rgb(${(96 * j) | 0},${(96 * j) | 0},${(96 * j) | 0})`);
        grd.addColorStop(0.30, `rgb(${(178 * j) | 0},${(178 * j) | 0},${(178 * j) | 0})`);
        grd.addColorStop(0.62, `rgb(${(138 * j) | 0},${(138 * j) | 0},${(138 * j) | 0})`);
        grd.addColorStop(1.00, `rgb(${(104 * j) | 0},${(104 * j) | 0},${(104 * j) | 0})`);
        g.fillStyle = grd;
        // a slightly wavy course line — hand-laid clay is never ruled
        const sag = (valueNoise2(k * 1.7, r * 2.3, seed) - 0.5) * rh * 0.16;
        g.fillRect(x0, y0 + sag, cw + 0.6, rh * 0.96);
      }
      // the shadow the course above casts on the head of this one
      g.fillStyle = 'rgba(0,0,0,0.42)';
      g.fillRect(0, y0, S, Math.max(1, rh * 0.16));
    }
    // weathering: lichen blotches and damp streaks running down the pitch
    const img = g.getImageData(0, 0, S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const blotch = fbm2(x * 0.028, y * 0.028, { octaves: 4, seed: seed + 5 });
        const streak = fbm2(x * 0.22, y * 0.012, { octaves: 3, seed: seed + 11 });
        const m = 0.86 + blotch * 0.26 + (streak - 0.5) * 0.14;
        const i = (y * S + x) * 4;
        d[i] = clamp01(d[i] / 255 * m) * 255;
        d[i + 1] = clamp01(d[i + 1] / 255 * m) * 255;
        d[i + 2] = clamp01(d[i + 2] / 255 * m) * 255;
      }
    }
    toDetail(g, S, { strength: 0.40, contrast: 1.25 }, img);
    return finish(c, { repeat: 1 });
  });
}

/** Hand-troweled stucco: mottled cream with trowel sweeps and damp staining. */
export function stuccoTexture(seed = 23, base = [214, 202, 176]) {
  return cached(`stucco:${seed}:${base.join(',')}`, () => {
    const S = 256;
    const c = canvas(S);
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n = fbm2(x * 0.045, y * 0.045, { octaves: 5, seed });
        const grain = valueNoise2(x * 0.9, y * 0.9, seed + 3) - 0.5;
        const v = 0.82 + (n - 0.5) * 0.38 + grain * 0.07;
        const i = (y * S + x) * 4;
        d[i] = clamp01((base[0] / 255) * v) * 255;
        d[i + 1] = clamp01((base[1] / 255) * v) * 255;
        d[i + 2] = clamp01((base[2] / 255) * v * 1.01) * 255;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // trowel arcs
    const rng = makeRng(seed * 977 + 5);
    g.globalAlpha = 0.10;
    g.strokeStyle = '#6d5f63';
    for (let i = 0; i < 26; i++) {
      const x = rng() * S, y = rng() * S, r = 20 + rng() * 70;
      g.lineWidth = 1 + rng() * 3;
      g.beginPath();
      g.arc(x, y, r, rng() * TAU, rng() * TAU);
      g.stroke();
    }
    g.globalAlpha = 1;
    toDetail(g, S, { strength: 0.26, contrast: 1.0 });
    return finish(c, { repeat: 1 });
  });
}

/**
 * Coursed rubble stone for bridge, walls and foundations.
 *
 * The old version laid a regular 9 x N grid of same-size rectangles with
 * aligned vertical joints, which tiled visibly across a 45 m bridge deck as an
 * obvious checkerboard — an automatic rejection. Every dimension here is now
 * jittered: course heights vary +/-35%, each course's joint phase is hashed
 * independently so joints never line up between neighbours, one block in six is
 * a long stretcher, and each block carries its own value. A recessed mortar
 * shadow is drawn into every joint so the coursing reads as depth, not as a
 * pattern printed on a flat card.
 */
export function stoneTexture(seed = 31) {
  return cached(`stone:${seed}`, () => {
    const S = 512;
    const c = canvas(S);
    const g = c.getContext('2d');
    const rng = makeRng(seed * 1301 + 17);

    // mortar bed
    g.fillStyle = '#726a70';
    g.fillRect(0, 0, S, S);

    // Course heights that sum to exactly S, so the map still tiles vertically.
    const nRows = 11;
    const raw = [];
    let sum = 0;
    for (let r = 0; r < nRows; r++) { const v = 0.65 + rng() * 0.70; raw.push(v); sum += v; }
    const rowY = [0];
    for (let r = 0; r < nRows; r++) rowY.push(rowY[r] + (raw[r] / sum) * S);

    for (let r = 0; r < nRows; r++) {
      const y0 = rowY[r], h = rowY[r + 1] - rowY[r];
      // independent joint phase per course — never aligned with its neighbour
      let x = -rng() * 70;
      const wide = 26 + rng() * 22;
      while (x < S + 8) {
        // ~1 in 6 blocks is a long stretcher
        const w = (rng() < 0.17 ? wide * 1.9 : wide) * (0.62 + rng() * 0.78);
        const inset = 1.1 + rng() * 1.1;
        const tone = 0.74 + rng() * 0.44;
        const warm = rng() < 0.42;
        const R = (warm ? 158 : 138) * tone, G = (warm ? 145 : 136) * tone, B = (warm ? 128 : 144) * tone;
        const bx0 = x + inset, bx1 = x + w - inset;
        const by0 = y0 + inset, by1 = y0 + h - inset;
        if (bx1 > bx0 + 3 && by1 > by0 + 2) {
          // block face
          g.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
          g.beginPath();
          g.moveTo(bx0 + rng() * 2.2, by0 + rng() * 2.0);
          g.lineTo(bx1 - rng() * 2.2, by0 + rng() * 2.0);
          g.lineTo(bx1 - rng() * 2.2, by1 - rng() * 2.0);
          g.lineTo(bx0 + rng() * 2.2, by1 - rng() * 2.0);
          g.closePath();
          g.fill();
          // AO into the recessed joint: a dark rake along the bottom + one side
          const grad = g.createLinearGradient(0, by0, 0, by1);
          grad.addColorStop(0, 'rgba(255,255,255,0.10)');
          grad.addColorStop(0.62, 'rgba(0,0,0,0)');
          grad.addColorStop(1, 'rgba(40,32,38,0.34)');
          g.fillStyle = grad;
          g.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
        }
        x += w;
      }
    }

    // fine speckle + a broad blotch so no two square metres of wall match
    const img = g.getImageData(0, 0, S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const n = valueNoise2(x * 0.55, y * 0.55, seed + 9) - 0.5;
        const blot = fbm2(x * 0.012, y * 0.012, { octaves: 3, seed: seed + 77 }) - 0.5;
        const k = n * 0.10 + blot * 0.20;
        d[i] = clamp01(d[i] / 255 + k) * 255;
        d[i + 1] = clamp01(d[i + 1] / 255 + k) * 255;
        d[i + 2] = clamp01(d[i + 2] / 255 + k * 0.92) * 255;
      }
    }
    toDetail(g, S, { strength: 0.44, contrast: 1.25 }, img);
    return finish(c, { repeat: 1 });
  });
}

/** Rough sawn timber, for shutters, carts, fences and rafters. */
export function woodTexture(seed = 41, base = [128, 96, 62]) {
  return cached(`wood:${seed}:${base.join(',')}`, () => {
    const S = 128;
    const c = canvas(S);
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const ring = Math.sin((x * 0.35 + fbm2(x * 0.05, y * 0.012, { octaves: 3, seed }) * 9) * 2.2);
        const v = 0.86 + ring * 0.11 + (valueNoise2(x * 1.3, y * 0.2, seed + 4) - 0.5) * 0.1;
        const i = (y * S + x) * 4;
        d[i] = clamp01((base[0] / 255) * v) * 255;
        d[i + 1] = clamp01((base[1] / 255) * v) * 255;
        d[i + 2] = clamp01((base[2] / 255) * v) * 255;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    toDetail(g, S, { strength: 0.30, contrast: 1.2 });
    return finish(c, { repeat: 1 });
  });
}

/** Hessian sandbag weave. */
export function burlapTexture(seed = 53) {
  return cached(`burlap:${seed}`, () => {
    const S = 128;
    const c = canvas(S);
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const weave = (Math.sin(x * 1.6) * Math.sin(y * 1.6)) * 0.5 + 0.5;
        const n = valueNoise2(x * 0.12, y * 0.12, seed);
        const v = 0.74 + weave * 0.2 + (n - 0.5) * 0.24;
        const i = (y * S + x) * 4;
        d[i] = clamp01(v * 0.80) * 255;
        d[i + 1] = clamp01(v * 0.72) * 255;
        d[i + 2] = clamp01(v * 0.55) * 255;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    toDetail(g, S, { strength: 0.32, contrast: 1.1 });
    return finish(c, { repeat: 1 });
  });
}

// ---------------------------------------------------------------------------
// data textures for shaders
// ---------------------------------------------------------------------------

/**
 * Tiling RGBA value-noise used by the water shader for flow distortion.
 * R,G = a 2D gradient-ish pair, B = fbm mass, A = a second decorrelated fbm.
 */
export function flowNoiseTexture(size = 256, seed = 61) {
  return cached(`flow:${size}:${seed}`, () => {
    const d = new Uint8Array(size * size * 4);
    const F = 8; // integer frequency => the noise tiles seamlessly
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x / size) * F, v = (y / size) * F;
        // wrap by sampling the periodic lattice manually
        const n1 = fbm2(u, v, { octaves: 4, seed });
        const n2 = fbm2(u + 13.7, v - 7.1, { octaves: 4, seed: seed + 101 });
        const n3 = fbm2(u * 2.1 - 4.3, v * 2.1 + 2.9, { octaves: 3, seed: seed + 202 });
        const i = (y * size + x) * 4;
        d[i] = n1 * 255;
        d[i + 1] = n2 * 255;
        d[i + 2] = n3 * 255;
        d[i + 3] = (1 - Math.abs(n1 * 2 - 1)) * 255;
      }
    }
    const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  });
}

/**
 * Cold-press paper fibre, used by the world's fallback NPR material when the
 * render module's paper texture is unavailable. Luminance only.
 */
export function paperTexture(size = 512, seed = 77) {
  return cached(`paper:${size}:${seed}`, () => {
    const d = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x / size) * 22, v = (y / size) * 22;
        // two octaves of fine tooth + a broad cockle
        const tooth = valueNoise2(u * 5.3, v * 5.3, seed) * 0.55 + valueNoise2(u * 11.1, v * 11.1, seed + 3) * 0.45;
        const cockle = fbm2(u * 0.35, v * 0.35, { octaves: 3, seed: seed + 9 });
        const val = clamp01(0.5 + (tooth - 0.5) * 0.85 + (cockle - 0.5) * 0.4);
        const i = (y * size + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = val * 255;
        d[i + 3] = 255;
      }
    }
    const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  });
}

/** Barbed-wire strand: alpha strip with regular barbs. */
export function barbedWireTexture(seed = 83) {
  return cached(`barb:${seed}`, () => {
    const S = 128;
    const c = canvas(S);
    const g = c.getContext('2d');
    g.clearRect(0, 0, S, S);
    g.strokeStyle = '#4a4149';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, S * 0.5);
    for (let x = 0; x <= S; x += 4) g.lineTo(x, S * 0.5 + Math.sin(x * 0.28) * 2.0);
    g.stroke();
    g.lineWidth = 2.4;
    for (let i = 0; i < 6; i++) {
      const x = (i + 0.5) * (S / 6);
      g.beginPath();
      g.moveTo(x - 6, S * 0.5 - 7);
      g.lineTo(x + 6, S * 0.5 + 7);
      g.moveTo(x + 6, S * 0.5 - 7);
      g.lineTo(x - 6, S * 0.5 + 7);
      g.stroke();
    }
    const t = finish(c);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

export function disposeTextures() {
  for (const t of cache.values()) t.dispose?.();
  cache.clear();
}
