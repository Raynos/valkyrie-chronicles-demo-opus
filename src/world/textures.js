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
function toDetail(g, size, { strength = 0.3, contrast = 1.0 } = {}) {
  const img = g.getImageData(0, 0, size, size);
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

    const cfg = {
      oak: { lobes: 22, r: 0.20, spread: 0.30, elong: 1.0, tone: [92, 108, 62] },
      poplar: { lobes: 26, r: 0.13, spread: 0.20, elong: 2.1, tone: [104, 120, 66] },
      willow: { lobes: 30, r: 0.10, spread: 0.34, elong: 2.4, tone: [116, 130, 84] },
      bush: { lobes: 18, r: 0.22, spread: 0.30, elong: 0.9, tone: [86, 100, 56] },
    }[species] || { lobes: 20, r: 0.2, spread: 0.3, elong: 1, tone: [96, 112, 64] };

    for (let i = 0; i < cfg.lobes; i++) {
      const a = rng() * TAU;
      const rr = Math.pow(rng(), 0.6) * cfg.spread;
      const cx = S * (0.5 + Math.cos(a) * rr);
      const cy = S * (0.5 + (Math.sin(a) * rr) / cfg.elong);
      const rad = S * cfg.r * (0.55 + rng() * 0.75);
      // Depth shading inside the cluster: lower-inner dabs go violet-shadowed,
      // upper-outer dabs go straw-warm. This is the band split pre-baked.
      const up = clamp01(1 - cy / S);
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
    g.strokeStyle = 'rgba(58,47,51,0.30)';
    g.lineWidth = 1.4;
    for (let i = 0; i < 40; i++) {
      const x = rng() * S, y = rng() * S;
      const l = 5 + rng() * 13, a = -0.9 + rng() * 0.5;
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
      let half = wheat
        ? (v > 0.80 ? 0.20 * Math.sin((v - 0.80) / 0.20 * Math.PI) + 0.035 : 0.032)
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

/** Coursed rubble stone for bridge, walls and foundations. */
export function stoneTexture(seed = 31) {
  return cached(`stone:${seed}`, () => {
    const S = 256;
    const c = canvas(S);
    const g = c.getContext('2d');
    const rng = makeRng(seed * 1301 + 17);
    g.fillStyle = '#8a8188';
    g.fillRect(0, 0, S, S);
    const rows = 9;
    const rh = S / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rng() * 40;
      while (x < S) {
        const w = 18 + rng() * 34;
        const inset = 1.4;
        const tone = 0.72 + rng() * 0.46;
        const warm = rng() < 0.4;
        const R = (warm ? 152 : 136) * tone, G = (warm ? 140 : 134) * tone, B = (warm ? 126 : 140) * tone;
        g.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
        const y = r * rh + inset;
        const h = rh - inset * 2;
        g.beginPath();
        // slightly irregular quadrilateral block, not a rectangle
        g.moveTo(x + inset + rng() * 2, y + rng() * 2);
        g.lineTo(x + w - inset - rng() * 2, y + rng() * 2);
        g.lineTo(x + w - inset - rng() * 2, y + h - rng() * 2);
        g.lineTo(x + inset + rng() * 2, y + h - rng() * 2);
        g.closePath();
        g.fill();
        x += w;
      }
    }
    // mortar shadow + speckle
    const img = g.getImageData(0, 0, S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const n = valueNoise2(x * 0.55, y * 0.55, seed + 9) - 0.5;
        d[i] = clamp01(d[i] / 255 + n * 0.12) * 255;
        d[i + 1] = clamp01(d[i + 1] / 255 + n * 0.12) * 255;
        d[i + 2] = clamp01(d[i + 2] / 255 + n * 0.11) * 255;
      }
    }
    g.putImageData(img, 0, 0);
    toDetail(g, S, { strength: 0.40, contrast: 1.3 });
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
