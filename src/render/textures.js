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

function finish(tex, { repeat = true, mips = true, aniso = 8 } = {}) {
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = mips;
  tex.anisotropy = aniso;
  tex.colorSpace = THREE.NoColorSpace;   // all of these are data, not colour
  tex.needsUpdate = true;
  return tex;
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
// Cold-press watercolour paper. Three superimposed signals:
//   * "tooth"  — the irregular hill-and-valley surface that catches pigment
//   * "fibre"  — anisotropic pulp strands, stretched ~4:1 on two crossing axes
//   * "cockle" — the very low frequency buckle of a wetted sheet
// R: tooth+fibre luminance (this is what multiplies the frame)
// G: fibre-only, used for directional bias in the grade pass
// B: cockle (large-scale, drives the luminance ripple)
// A: fine speckle, used to keep the grain alive under magnification

export function getPaperTexture() {
  return cached('paper', () => {
    const S = 512;
    const seed = (CFG.seed ^ 0x51ab) >>> 0;
    const tex = dataTex(S, (u, v, out) => {
      // pulp strands: two crossing anisotropic fbms
      const f1 = tfbm(u * 4.0, v * 0.55, 16, 4, 0.55, seed + 11);
      const f2 = tfbm(u * 0.5, v * 3.6, 16, 4, 0.55, seed + 29);
      const fibre = (f1 * 0.55 + f2 * 0.45);

      // tooth: sharpened mid-frequency noise, biased so peaks are rare
      const t0 = tfbm(u, v, 32, 4, 0.52, seed + 71);
      const t1 = tridge(u, v, 64, 3, 0.5, seed + 97);
      let tooth = mix(t0, t1, 0.42);
      tooth = sstep(0.24, 0.86, tooth);

      // deposit: pigment sinks into valleys -> slight inversion in the darks
      const grain = tnoise(u * 256, v * 256, 256, seed + 131);

      const cockle = tfbm(u, v, 3, 3, 0.6, seed + 211);

      const lum = sat(0.60 + (tooth - 0.5) * 0.40 + (fibre - 0.5) * 0.30 + (grain - 0.5) * 0.10);

      out[0] = lum;
      out[1] = sat(0.5 + (fibre - 0.5) * 1.25);
      out[2] = cockle;
      out[3] = grain;
    });
    return finish(tex);
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

    const tex = dataTex(S, (u, v, out, x, y) => {
      const d = at(x, y);
      const gx = at(x + 1, y) - at(x - 1, y);
      const gy = at(x, y + 1) - at(x, y - 1);
      const grad = Math.sqrt(gx * gx + gy * gy) * S * 0.06;
      const pool = sstep(0.18, 0.85, grad);
      const gran = tfbm(u, v, 48, 3, 0.5, seed + 313);
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
    const tex = dataTex(S, (u, v, out) => {
      const grass = mix(
        tfbm(u * 1.6, v * 0.42, 32, 4, 0.55, seed + 7),
        tridge(u * 0.5, v * 2.2, 24, 3, 0.5, seed + 19), 0.45);
      const grit = tfbm(u, v, 64, 3, 0.45, seed + 31);
      const pebble = sstep(0.68, 0.9, tfbm(u, v, 40, 2, 0.5, seed + 53));
      const rock = tridge(u, v, 12, 5, 0.55, seed + 67);
      const mud = tfbm(u, v, 6, 4, 0.6, seed + 83);
      out[0] = sat(grass);
      out[1] = sat(grit * 0.7 + pebble * 0.55);
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
