// Geometry construction helpers for the procedural battlefield.
//
// Everything the world builds is BufferGeometry authored in code. The dominant
// pattern here is: build many small pieces, bake a colour into each piece's
// vertex-colour attribute, then merge them into ONE geometry so a whole
// farmhouse (walls + roof + shutters + chimney) is a single draw call with a
// single material.  That is why `setGeomColor` exists and why `mergeGeoms`
// always emits a `color` attribute.

import * as THREE from 'three';
import { valueNoise2 } from '../core/rng.js';
import { TAU } from '../core/math.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

// ---------------------------------------------------------------------------
// attribute hygiene
// ---------------------------------------------------------------------------

/** Guarantee position/normal/uv/color all exist so merges never mismatch. */
export function ensureAttrs(g) {
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) {
    const n = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!g.getAttribute('color')) {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    a.fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  }
  return g;
}

/**
 * Bake a colour into the geometry's vertex-colour attribute.
 * `variation` adds seeded per-vertex value jitter, which is what keeps
 * procedural stucco and tile from reading as flat plastic.
 */
export function setGeomColor(g, color, variation = 0, rng = null) {
  ensureAttrs(g);
  _c.set(color);
  const a = g.getAttribute('color');
  const p = g.getAttribute('position');
  for (let i = 0; i < a.count; i++) {
    let s = 1;
    if (variation > 0) {
      // Prefer spatial noise over pure rng: neighbouring vertices of the same
      // face should agree or the mesh sparkles.
      const n = rng
        ? rng()
        : valueNoise2(p.getX(i) * 1.7 + p.getY(i) * 0.9, p.getZ(i) * 1.7 - p.getY(i) * 0.6, 9137);
      s = 1 + (n - 0.5) * 2 * variation;
    }
    a.setXYZ(i, _c.r * s, _c.g * s, _c.b * s);
  }
  a.needsUpdate = true;
  return g;
}

/** Multiply an existing vertex-colour attribute (for weathering passes). */
export function tintGeom(g, fn) {
  ensureAttrs(g);
  const a = g.getAttribute('color');
  const p = g.getAttribute('position');
  for (let i = 0; i < a.count; i++) {
    _c.setRGB(a.getX(i), a.getY(i), a.getZ(i));
    fn(_c, p.getX(i), p.getY(i), p.getZ(i), i);
    a.setXYZ(i, _c.r, _c.g, _c.b);
  }
  a.needsUpdate = true;
  return g;
}

// ---------------------------------------------------------------------------
// transforms
// ---------------------------------------------------------------------------

/** In-place transform. opts: { x,y,z, rx,ry,rz, sx,sy,sz, s } */
export function tx(g, opts = {}) {
  const s = opts.s ?? 1;
  _e.set(opts.rx || 0, opts.ry || 0, opts.rz || 0, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(
    _v.set(opts.x || 0, opts.y || 0, opts.z || 0),
    _q,
    new THREE.Vector3(opts.sx ?? s, opts.sy ?? s, opts.sz ?? s)
  );
  g.applyMatrix4(_m);
  return g;
}

/**
 * Hand-drawn irregularity. Displaces vertices along a low-frequency 3D-ish
 * noise field so that nothing in the world is machine-perfect — the CANVAS
 * look depends on walls that are a couple of centimetres out of true.
 */
export function wobble(g, amp = 0.02, freq = 0.6, seed = 17) {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const nx = valueNoise2(x * freq + z * 0.31, y * freq, seed) - 0.5;
    const ny = valueNoise2(y * freq + x * 0.27, z * freq, seed + 71) - 0.5;
    const nz = valueNoise2(z * freq + y * 0.19, x * freq, seed + 143) - 0.5;
    p.setXYZ(i, x + nx * amp * 2, y + ny * amp * 2, z + nz * amp * 2);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/**
 * Merge a list of geometries into one non-indexed geometry carrying
 * position/normal/uv/color. Non-indexed keeps this simple and robust; the
 * vertex counts involved (a few thousand per building) do not justify the
 * complexity of index remapping.
 */
export function mergeGeoms(list) {
  const parts = [];
  let total = 0;
  for (const g0 of list) {
    if (!g0) continue;
    ensureAttrs(g0);
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (g !== g0) ensureAttrs(g);
    parts.push(g);
    total += g.getAttribute('position').count;
  }
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    const t = g.getAttribute('uv'), c = g.getAttribute('color');
    const cnt = p.count;
    pos.set(p.array.subarray(0, cnt * 3), o * 3);
    nrm.set(n.array.subarray(0, cnt * 3), o * 3);
    uv.set(t.array.subarray(0, cnt * 2), o * 2);
    col.set(c.array.subarray(0, cnt * 3), o * 3);
    o += cnt;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  for (const g of parts) if (!list.includes(g)) g.dispose();
  return out;
}

// ---------------------------------------------------------------------------
// primitive builders (thin wrappers that also colour the result)
// ---------------------------------------------------------------------------

export function box(w, h, d, color, opts) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (color !== undefined) setGeomColor(g, color, opts?.variation ?? 0);
  if (opts) tx(g, opts);
  return g;
}

export function cyl(rTop, rBot, h, seg = 10, color, opts) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, opts?.hSeg ?? 1, opts?.open ?? false);
  if (color !== undefined) setGeomColor(g, color, opts?.variation ?? 0);
  if (opts) tx(g, opts);
  return g;
}

export function sphere(r, seg, color, opts) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(3, seg >> 1));
  if (color !== undefined) setGeomColor(g, color, opts?.variation ?? 0);
  if (opts) tx(g, opts);
  return g;
}

export function quadCard(w, h) {
  // Pivot at the bottom edge so foliage cards and grass blades rotate about
  // their base.
  const g = new THREE.PlaneGeometry(w, h, 1, 1);
  g.translate(0, h * 0.5, 0);
  return g;
}

// ---------------------------------------------------------------------------
// swept / lofted shapes
// ---------------------------------------------------------------------------

/**
 * Loft a closed polygon cross-section along a list of rings.
 * rings: [{ c: Vector3-ish {x,y,z}, r: number, rot: number, sx, sz }]
 * Used for branches, chimneys, tower shafts, barrels — anything tapered and
 * bent that a plain CylinderGeometry cannot express.
 */
export function loft(rings, sides = 7, capStart = true, capEnd = true) {
  const n = rings.length;
  const verts = new Float32Array(n * sides * 3);
  for (let i = 0; i < n; i++) {
    const r = rings[i];
    const rot = r.rot || 0;
    const sx = (r.sx ?? 1) * r.r, sz = (r.sz ?? 1) * r.r;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * TAU + rot;
      const o = (i * sides + s) * 3;
      verts[o] = r.c.x + Math.cos(a) * sx;
      verts[o + 1] = r.c.y;
      verts[o + 2] = r.c.z + Math.sin(a) * sz;
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      const a = i * sides + s, b = i * sides + s2;
      const c = (i + 1) * sides + s2, d = (i + 1) * sides + s;
      idx.push(a, b, c, a, c, d);
    }
  }
  const pos = Array.from(verts);
  if (capStart) {
    const base = pos.length / 3;
    pos.push(rings[0].c.x, rings[0].c.y, rings[0].c.z);
    for (let s = 0; s < sides; s++) idx.push(base, (s + 1) % sides, s);
  }
  if (capEnd) {
    const base = pos.length / 3;
    const last = rings[n - 1];
    pos.push(last.c.x, last.c.y, last.c.z);
    const off = (n - 1) * sides;
    for (let s = 0; s < sides; s++) idx.push(base, off + s, off + ((s + 1) % sides));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Straight tapered branch between two points. */
export function branchGeom(from, to, r0, r1, sides = 6, bend = null, segs = 3) {
  const rings = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const c = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    };
    if (bend) {
      const s = Math.sin(t * Math.PI);
      c.x += bend.x * s; c.y += bend.y * s; c.z += bend.z * s;
    }
    rings.push({ c, r: r0 + (r1 - r0) * t });
  }
  return loft(rings, sides, true, true);
}

/**
 * Extrude a 2D polyline (in XZ) into a vertical wall slab of given thickness
 * and height. Used for stone walls, parapets and hedgerow cores.
 */
export function ribbonWall(pts, y0, y1, thickness) {
  const half = thickness * 0.5;
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    left.push({ x: p.x - dz * half, z: p.z + dx * half, y0: p.y0 ?? y0, y1: p.y1 ?? y1 });
    right.push({ x: p.x + dz * half, z: p.z - dx * half, y0: p.y0 ?? y0, y1: p.y1 ?? y1 });
  }
  const pos = [];
  const push = (a, b, c) => { pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); };
  for (let i = 0; i < pts.length - 1; i++) {
    const l0 = left[i], l1 = left[i + 1], r0 = right[i], r1 = right[i + 1];
    const L0b = { x: l0.x, y: l0.y0, z: l0.z }, L0t = { x: l0.x, y: l0.y1, z: l0.z };
    const L1b = { x: l1.x, y: l1.y0, z: l1.z }, L1t = { x: l1.x, y: l1.y1, z: l1.z };
    const R0b = { x: r0.x, y: r0.y0, z: r0.z }, R0t = { x: r0.x, y: r0.y1, z: r0.z };
    const R1b = { x: r1.x, y: r1.y0, z: r1.z }, R1t = { x: r1.x, y: r1.y1, z: r1.z };
    push(L0b, L1b, L1t); push(L0b, L1t, L0t);           // left face
    push(R1b, R0b, R0t); push(R1b, R0t, R1t);           // right face
    push(L0t, L1t, R1t); push(L0t, R1t, R0t);           // top
  }
  // end caps
  const capA = [left[0], right[0]], capB = [right[pts.length - 1], left[pts.length - 1]];
  for (const [a, b] of [capA, capB]) {
    const Ab = { x: a.x, y: a.y0, z: a.z }, At = { x: a.x, y: a.y1, z: a.z };
    const Bb = { x: b.x, y: b.y0, z: b.z }, Bt = { x: b.x, y: b.y1, z: b.z };
    push(Ab, Bb, Bt); push(Ab, Bt, At);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * Catenary sag between two anchors — telegraph wires. Returns a thin
 * triangular prism strip (cheap, still catches the outline pass).
 */
export function catenaryGeom(a, b, sag, segs = 14, radius = 0.035) {
  const rings = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // cosh-shaped droop normalised to 0 at both ends, 1 at centre
    const k = 2.6;
    const droop = (Math.cosh(k * (t - 0.5)) - Math.cosh(k * 0.5)) / (1 - Math.cosh(k * 0.5));
    rings.push({
      c: {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t - sag * droop,
        z: a.z + (b.z - a.z) * t,
      },
      r: radius,
    });
  }
  return loft(rings, 3, false, false);
}

// ---------------------------------------------------------------------------
// roofs
// ---------------------------------------------------------------------------

/**
 * A hipped roof with real corrugated tile geometry.
 *
 * The roof is built as four trapezoid planes (two long, two hipped ends) that
 * are subdivided into a tile grid; every tile row is displaced along the plane
 * normal by a half-cosine so the surface physically undulates like laid pantile,
 * and every tile gets its own colour jitter. At 25–40 cm tiles on a 7 m span
 * that is ~600 quads per roof — cheap, and it reads unmistakably as tile under
 * the banded lighting.
 */
export function hipRoof(w, d, h, overhang, rng, colorA, colorB) {
  const W = w * 0.5 + overhang, D = d * 0.5 + overhang;
  const ridgeLen = Math.max(0.001, w - d) * 0.5; // hipped: ridge shorter than plan
  const pieces = [];

  // corner points of the eave rectangle and of the ridge line
  const e = [
    { x: -W, z: -D }, { x: W, z: -D }, { x: W, z: D }, { x: -W, z: D },
  ];
  const r0 = { x: -ridgeLen, z: 0 }, r1 = { x: ridgeLen, z: 0 };

  // four faces: [eaveA, eaveB, ridgeA, ridgeB]
  const faces = [
    [e[0], e[1], r1, r0],   // north slope
    [e[2], e[3], r0, r1],   // south slope
    [e[1], e[2], r1, r1],   // east hip (triangle, degenerate ridge)
    [e[3], e[0], r0, r0],   // west hip
  ];

  const tile = 0.34;
  for (let f = 0; f < faces.length; f++) {
    const [a, b, c, dd] = faces[f];
    // bilinear patch: (u along eave, v up-slope)
    const nu = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / tile));
    const nv = Math.max(2, Math.round(Math.hypot(c.x - b.x, c.z - b.z, h) / tile));
    const pos = [];
    const col = [];
    const P = (u, v) => {
      const p0x = a.x + (b.x - a.x) * u, p0z = a.z + (b.z - a.z) * u;
      const p1x = dd.x + (c.x - dd.x) * u, p1z = dd.z + (c.z - dd.z) * u;
      const x = p0x + (p1x - p0x) * v, z = p0z + (p1z - p0z) * v;
      // corrugation: ripple across the slope direction (u), sag along v rows
      const ripple = Math.cos(u * nu * TAU) * 0.022;
      const step = (Math.floor(v * nv) % 2) * 0.012;
      return { x, y: h * v + ripple + step, z };
    };
    const pushTri = (p, q, s, cc) => {
      pos.push(p.x, p.y, p.z, q.x, q.y, q.z, s.x, s.y, s.z);
      for (let k = 0; k < 3; k++) col.push(cc.r, cc.g, cc.b);
    };
    for (let iv = 0; iv < nv; iv++) {
      for (let iu = 0; iu < nu; iu++) {
        const u0 = iu / nu, u1 = (iu + 1) / nu, v0 = iv / nv, v1 = (iv + 1) / nv;
        const p00 = P(u0, v0), p10 = P(u1, v0), p11 = P(u1, v1), p01 = P(u0, v1);
        // per-tile colour: weathered pantile ranges from red-ochre to sun-bleached
        const t = rng();
        _c.set(colorA).lerp(_c.clone().set(colorB), t * t);
        const shade = 0.86 + rng() * 0.28;
        _c.multiplyScalar(shade);
        pushTri(p00, p11, p10, _c);
        pushTri(p00, p01, p11, _c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    pieces.push(g);
  }

  // ridge capping — a row of half-round tiles along the ridge
  const capRings = [];
  const capSegs = Math.max(2, Math.round((ridgeLen * 2) / 0.4));
  for (let i = 0; i <= capSegs; i++) {
    const t = i / capSegs;
    capRings.push({
      c: { x: -ridgeLen + 2 * ridgeLen * t, y: h + 0.06, z: 0 },
      r: 0.13 + Math.sin(t * capSegs * Math.PI) * 0.015,
      sz: 0.75,
    });
  }
  if (ridgeLen > 0.05) {
    const capG = loft(capRings, 6, true, true);
    setGeomColor(capG, colorB, 0.07, rng);
    pieces.push(capG);
  }
  return mergeGeoms(pieces);
}

/** Simple gable roof (two planes) for sheds and lean-tos. */
export function gableRoof(w, d, h, overhang, rng, colorA, colorB) {
  return hipRoof(w, d, h, overhang, rng, colorA, colorB);
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

/**
 * Triplanar world-space UVs. Merged architecture has no usable UV layout, so
 * we project each vertex on its dominant normal axis. Detail maps then tile
 * seamlessly across walls, roofs and rubble with no seams and no authoring.
 */
export function worldUV(g, scale = 0.4) {
  ensureAttrs(g);
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (ay >= ax && ay >= az) uv.setXY(i, x * scale, z * scale);
    else if (ax >= az) uv.setXY(i, z * scale, y * scale);
    else uv.setXY(i, x * scale, y * scale);
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * Destructive carve: drop every triangle whose centroid fails `keep`.
 * This is how shelled buildings get their blown-out roofs and walls — the
 * intact geometry is generated first, then bitten into, so the ragged opening
 * always lines up with the structure it belongs to.
 */
export function carveGeometry(g, keep) {
  const src = g.index ? g.toNonIndexed() : g;
  ensureAttrs(src);
  const p = src.getAttribute('position');
  const nAttr = src.getAttribute('normal');
  const uvA = src.getAttribute('uv');
  const cA = src.getAttribute('color');
  const tris = p.count / 3;
  const pos = [], nrm = [], uv = [], col = [];
  for (let t = 0; t < tris; t++) {
    const i0 = t * 3;
    const cx = (p.getX(i0) + p.getX(i0 + 1) + p.getX(i0 + 2)) / 3;
    const cy = (p.getY(i0) + p.getY(i0 + 1) + p.getY(i0 + 2)) / 3;
    const cz = (p.getZ(i0) + p.getZ(i0 + 1) + p.getZ(i0 + 2)) / 3;
    if (!keep(cx, cy, cz)) continue;
    for (let k = 0; k < 3; k++) {
      const i = i0 + k;
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(nAttr.getX(i), nAttr.getY(i), nAttr.getZ(i));
      uv.push(uvA.getX(i), uvA.getY(i));
      col.push(cA.getX(i), cA.getY(i), cA.getZ(i));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (src !== g) src.dispose();
  return out;
}

/** Multiply vertex colours by a scorch factor falling off from a blast point. */
export function scorch(g, cx, cy, cz, radius, strength = 0.55) {
  return tintGeom(g, (c, x, y, z) => {
    const d = Math.hypot(x - cx, y - cy, z - cz);
    const f = Math.max(0, 1 - d / radius);
    const k = 1 - f * f * strength;
    c.setRGB(c.r * k, c.g * k * 0.96, c.b * k * 0.99);
  });
}

/** Irregular rubble pile: a heap of jittered low-poly rocks. */
export function rubblePile(rng, radius, height, count, colors) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * radius;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const fall = 1 - (rr / radius) * (rr / radius);
    const s = 0.11 + rng() * 0.26;
    const g = new THREE.IcosahedronGeometry(s, 0);
    wobble(g, s * 0.34, 6.0, (i * 37) | 0);
    tx(g, {
      x, y: height * fall * rng() * 0.9 + s * 0.4, z,
      rx: rng() * TAU, ry: rng() * TAU, rz: rng() * TAU,
      sy: 0.72,
    });
    setGeomColor(g, colors[(rng() * colors.length) | 0], 0.1, rng);
    parts.push(g);
  }
  return mergeGeoms(parts);
}

/** Ragged blown-out wall edge: returns a list of brick stubs along a break line. */
export function raggedEdge(rng, from, to, y, depth, thickness, colors) {
  const parts = [];
  const len = Math.hypot(to.x - from.x, to.z - from.z);
  const n = Math.max(3, Math.round(len / 0.28));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const px = from.x + (to.x - from.x) * t;
    const pz = from.z + (to.z - from.z) * t;
    const jag = Math.abs(valueNoise2(t * 9.3, 0.5, 4231) - 0.5) * 2;
    const hgt = depth * (0.15 + jag * 0.95);
    const g = new THREE.BoxGeometry(0.26, hgt, thickness * (0.7 + rng() * 0.4));
    tx(g, { x: px, y: y - hgt * 0.5, z: pz, ry: (rng() - 0.5) * 0.28, rz: (rng() - 0.5) * 0.16 });
    setGeomColor(g, colors[(rng() * colors.length) | 0], 0.12, rng);
    parts.push(g);
  }
  return parts;
}

export { _c as scratchColor };
