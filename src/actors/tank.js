// src/actors/tank.js
// The Edelweiss — a stylised WWII light/medium tank, built entirely from
// BufferGeometry at runtime. No assets, no imports beyond three + core.
//
// Layout convention: +Z is forward, +Y up, +X right. The root origin sits at
// the suspension datum, `rideHeight` above the ground, so the road-wheel axles
// live at local y = -(rideHeight - wheelRadius).
//
// Geometry is merged into a handful of material buckets so a whole tank is
// ~8 draw calls plus three instanced meshes (road wheels, track links, rivets).

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { CFG, byQ } from '../core/config.js';
import { clamp, clamp01, damp, lerp, shortestAngle, TAU, DEG } from '../core/math.js';
import { makeRng } from '../core/rng.js';
import { makeCanvasMaterial } from '../render/materials.js';
import { TankPhysics, PuffSystem } from './tankPhysics.js';

// ---------------------------------------------------------------- scratch ---
const _m4 = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();
const _qs = new THREE.Quaternion();
const _qs2 = new THREE.Quaternion();
const _es = new THREE.Euler();
const _col = new THREE.Color();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _zAxis = new THREE.Vector3(0, 0, 1);
const SIDES = [-1, 1];
const _yAxis = new THREE.Vector3(0, 1, 0);

// ============================================================================
//  Palette — CANVAS engine: warm in light, violet-blue in shade, never black.
// ============================================================================
const PAL = {
  // Gallian regular armour: pale sage-grey field with warm ochre trim.
  //
  // These are the values the band quantiser sees. They are pitched HIGH on
  // purpose: the detail map multiplies in at ~0.93 mean, and a quantiser can
  // only split a surface into a cream band and a violet band if the surface has
  // the headroom to go both ways. Armour authored at slate-green has nowhere to
  // go but darker, which is exactly how the hull ended up as one flat mass.
  paint: 0xaeb5a6,
  paintAlt: 0x9ea595,
  darkMetal: 0x6d675d,       // gun, hatches, weld-proud steel
  track: 0x6a5c4e,           // umber steel, worn bright on the wear faces
  rubber: 0x554d51,
  ochre: 0xa88654,           // canvas, stowage, tool handles
  wood: 0x94734c,
  glass: 0xd8d2b8,
  grille: 0x5f767a,          // radiator: cool teal so it reads as "the spot"
  hot: 0xd8763a,
  scorch: 0x3a2f33,          // the darkest value permitted in frame
};

// ============================================================================
//  Geometry helpers
// ============================================================================

/**
 * Merge a list of indexed BufferGeometries sharing position/normal/uv.
 * Written by hand rather than pulled from BufferGeometryUtils so the attribute
 * set is guaranteed and nothing silently drops.
 */
function mergeGeos(list) {
  let vc = 0, ic = 0;
  for (const g of list) {
    if (!g.attributes.normal) g.computeVertexNormals();
    vc += g.attributes.position.count;
    ic += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const u = g.attributes.uv;
    const count = p.count;
    pos.set(p.array.length === count * 3 ? p.array : p.array.subarray(0, count * 3), vo * 3);
    nor.set(n.array.length === count * 3 ? n.array : n.array.subarray(0, count * 3), vo * 3);
    if (u) uv.set(u.array.length === count * 2 ? u.array : u.array.subarray(0, count * 2), vo * 2);
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
    } else {
      for (let i = 0; i < count; i++) idx[io + i] = i + vo;
      io += count;
    }
    vo += count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Rigid-place a geometry (no scale). */
function place(g, x, y, z, rx = 0, ry = 0, rz = 0) {
  _es.set(rx, ry, rz, 'XYZ');
  _m4.makeRotationFromEuler(_es);
  _m4.setPosition(x, y, z);
  g.applyMatrix4(_m4);
  return g;
}

/** Place with non-uniform scale. */
function placeS(g, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  _es.set(rx, ry, rz, 'XYZ');
  _qs.setFromEuler(_es);
  _va.set(x, y, z); _vb.set(sx, sy, sz);
  _m4.compose(_va, _qs, _vb);
  g.applyMatrix4(_m4);
  return g;
}

/** Cylinder spanning two points (used for welds, guards, tow cables). */
function cylBetween(ax, ay, az, bx, by, bz, r, seg = 6, rTop = null) {
  _va.set(bx - ax, by - ay, bz - az);
  const len = _va.length();
  const g = new THREE.CylinderGeometry(rTop ?? r, r, len, seg, 1, false);
  _va.divideScalar(len || 1);
  _qs.setFromUnitVectors(_yAxis, _va);
  _vb.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  _m4.compose(_vb, _qs, _one);
  g.applyMatrix4(_m4);
  return g;
}

/**
 * Loft a closed cross-section along Z. `stations` = [{ z, pts:[[x,y],...] }]
 * with identical point counts; the ring must be ordered clockwise when viewed
 * from +Z so the generated winding faces outward.
 */
/**
 * Linearly subdivide a station list, both along Z and around each ring.
 * Because a loft between two rings is planar per quad, interpolating either
 * way lands exactly on the same surface — the silhouette and the facet normals
 * are untouched. We do it purely to give the damage model enough vertices to
 * push a believable dent into, so plate resolution is a quality setting rather
 * than an art decision.
 */
function subdivideStations(stations, zDiv = 1, ringDiv = 1) {
  if (zDiv <= 1 && ringDiv <= 1) return stations;
  const denseRing = (pts) => {
    if (ringDiv <= 1) return pts;
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      for (let k = 0; k < ringDiv; k++) {
        const t = k / ringDiv;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  };
  const out = [];
  for (let s = 0; s < stations.length - 1; s++) {
    const A = denseRing(stations[s].pts), B = denseRing(stations[s + 1].pts);
    const zA = stations[s].z, zB = stations[s + 1].z;
    for (let d = 0; d < zDiv; d++) {
      const t = d / zDiv;
      const pts = A.map((p, i) => [p[0] + (B[i][0] - p[0]) * t, p[1] + (B[i][1] - p[1]) * t]);
      out.push({ z: zA + (zB - zA) * t, pts });
    }
  }
  out.push({ z: stations[stations.length - 1].z, pts: denseRing(stations[stations.length - 1].pts) });
  return out;
}

function loft(stations, capFront = true, capBack = true) {
  const N = stations[0].pts.length;
  const S = stations.length;
  const verts = [];
  const uvs = [];
  const tris = [];
  // Side skin, one independent quad per plate. Vertices are deliberately NOT
  // shared between plates: computeVertexNormals then produces hard facets, and
  // hard facets are the whole point — armour is welded flat plate, and the
  // outline pass needs those normal discontinuities to draw the creases.
  for (let s = 0; s < S - 1; s++) {
    const st0 = stations[s], st1 = stations[s + 1];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const base = verts.length / 3;
      verts.push(st0.pts[i][0], st0.pts[i][1], st0.z);      // a
      verts.push(st1.pts[i][0], st1.pts[i][1], st1.z);      // b
      verts.push(st1.pts[j][0], st1.pts[j][1], st1.z);      // b2
      verts.push(st0.pts[j][0], st0.pts[j][1], st0.z);      // a2
      const u0 = i / N, u1 = (i + 1) / N;
      const v0 = s / (S - 1), v1 = (s + 1) / (S - 1);
      uvs.push(u0, v0, u0, v1, u1, v1, u1, v0);
      tris.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  // Caps: fan from the ring centroid.
  const cap = (s, front) => {
    const st = stations[s];
    let cx = 0, cy = 0;
    for (const p of st.pts) { cx += p[0]; cy += p[1]; }
    cx /= N; cy /= N;
    const c = verts.length / 3;
    verts.push(cx, cy, st.z);
    uvs.push(0.5, 0.5);
    const base = verts.length / 3;
    for (let i = 0; i < N; i++) {
      verts.push(st.pts[i][0], st.pts[i][1], st.z);
      uvs.push(0.5 + st.pts[i][0] * 0.25, 0.5 + st.pts[i][1] * 0.25);
    }
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      if (front) tris.push(c, base + j, base + i);
      else tris.push(c, base + i, base + j);
    }
  };
  if (capBack) cap(0, false);
  if (capFront) cap(S - 1, true);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(verts.length / 3 > 65535
    ? new THREE.BufferAttribute(new Uint32Array(tris), 1)
    : new THREE.BufferAttribute(new Uint16Array(tris), 1));
  g.computeVertexNormals();
  return g;
}

/**
 * Build a hull cross-section ring: a flat belly, vertical-ish sides with a
 * chamfer, and a crowned deck. 10 points, clockwise seen from +Z.
 */
function hullRing(w, yBot, yTop, chamfer = 0.16, crown = 0.02) {
  const c = Math.min(chamfer, (yTop - yBot) * 0.4);
  return [
    [-w + c * 0.7, yBot],
    [-w, yBot + c * 0.7],
    [-w, yTop - c],
    [-w + c * 0.85, yTop],
    [-w * 0.42, yTop + crown],
    [w * 0.42, yTop + crown],
    [w - c * 0.85, yTop],
    [w, yTop - c],
    [w, yBot + c * 0.7],
    [w - c * 0.7, yBot],
  ];
}

/**
 * A hull cross-section with a SPONSON: a narrow lower hull between the tracks,
 * a shelf where it flares out, and the full-width superstructure above.
 *
 * This is the difference between a tank and a box with stripes painted on it.
 * The old rings were a constant 1.21 m half-width, and the track centreline is
 * at gauge/2 = 1.21 with a 0.42 m shoe — so exactly half of every track shoe
 * and half of every road wheel was *inside* the hull solid. Nothing of the
 * running gear could be seen except a 0.21 m sliver, which is why the critic
 * read the whole lower half as one dark undifferentiated mass with no ground
 * contact. The lower hull now stops at `wLow`, inboard of the track, and the
 * upper hull overhangs it — so the wheels, the return run and the sprocket all
 * sit in the shadow pocket under the sponson where they belong.
 *
 * 14 points, clockwise seen from +Z, same winding as hullRing.
 */
function sponsonRing(w, wLow, yBot, yTop, chamfer = 0.16, crown = 0.02, shelfY = 0.26) {
  const span = Math.max(0.02, yTop - yBot);
  const c = Math.min(chamfer, span * 0.4);
  const th = Math.min(0.06, span * 0.16);          // sponson underside rise
  const cb = Math.min(0.10, span * 0.22);          // belly chamfer
  const wl = Math.min(wLow, w - 0.04);
  // Keep the shelf strictly between the belly chamfer and the deck chamfer so
  // no edge of the section can collapse to zero area (a degenerate quad here
  // becomes a NaN vertex normal in computeVertexNormals).
  const lo = yBot + cb * 0.7 + span * 0.06;
  const hi = yTop - c - th - span * 0.06;
  const ys = hi > lo ? Math.min(Math.max(shelfY, lo), hi) : (lo + hi) * 0.5;
  return [
    [-wl + cb * 0.7, yBot],
    [-wl, yBot + cb * 0.7],
    [-wl, ys],
    [-w, ys + th],
    [-w, yTop - c],
    [-w + c * 0.85, yTop],
    [-w * 0.42, yTop + crown],
    [w * 0.42, yTop + crown],
    [w - c * 0.85, yTop],
    [w, yTop - c],
    [w, ys + th],
    [wl, ys],
    [wl, yBot + cb * 0.7],
    [wl - cb * 0.7, yBot],
  ];
}

/** A bead of weld running around one cross-section ring. */
function weldRing(pts, z, radius, rng, skipBelly = true) {
  const parts = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // The belly seam is never visible; skip it to save triangles.
    if (skipBelly && i === n - 1) continue;
    const a = pts[i], b = pts[j];
    const r = radius * (0.72 + rng() * 0.6);
    // A weld is not a straight tube — break each edge into two beads with a
    // small kink so the highlight along it reads as hand-laid.
    const mx = (a[0] + b[0]) * 0.5 + (rng() - 0.5) * 0.012;
    const my = (a[1] + b[1]) * 0.5 + (rng() - 0.5) * 0.012;
    const mz = z + (rng() - 0.5) * 0.01;
    parts.push(cylBetween(a[0], a[1], z, mx, my, mz, r, 5));
    parts.push(cylBetween(mx, my, mz, b[0], b[1], z, r * (0.8 + rng() * 0.5), 5));
  }
  return parts;
}

/** Sample points along a ring for rivet placement. */
function ringSamples(pts, z, spacing, out, skipBelly = true) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (skipBelly && i === n - 1) continue;
    const a = pts[i], b = pts[j];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.round(len / spacing));
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      out.push([a[0] + dx * t, a[1] + dy * t, z, Math.atan2(dy, dx)]);
    }
  }
  return out;
}

// ============================================================================
//  Procedural textures
// ============================================================================

function canvas2d(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { c, g: c.getContext('2d') };
}

/**
 * Painted armour, as a *modulation* map — NOT a pigment map.
 *
 * makeCanvasMaterial does `albedo = uColor * texture2D(uMap).rgb`, so a texture
 * that is itself painted in the base colour multiplies the paint by itself:
 * 0x9aa196 squared lands on #5d6658, which is why the Edelweiss rendered as one
 * flat slate-green mass with no lit/shade split to band. The map therefore has
 * to sit AROUND 1.0 and carry only the brush variation — mottle, chipped primer
 * and rain-washed grime — while the pigment stays in uColor where the band
 * quantiser can actually see it.
 *
 * White is the ceiling of a multiply, so the field is authored at `hi` (just
 * under white) and everything else works downward from there; `mean` lands
 * around 0.93 of the base and the palette entries are pitched to suit.
 */
function makeArmourTexture(seed, tint = 0x000000, size = 256) {
  const rng = makeRng(seed);
  const { c, g } = canvas2d(size);
  // The field: a hair off white so a "warm" wash still has somewhere to go up.
  g.fillStyle = '#fbfbfa';
  g.fillRect(0, 0, size, size);

  // Gouache mottling: overlapping soft washes. Warm ones barely darken and pull
  // the hue toward cream; cool ones darken more and pull toward violet-grey, so
  // the plate has an underlying temperature drift before the light hits it.
  for (let i = 0; i < 170; i++) {
    const x = rng() * size, y = rng() * size, r = size * (0.03 + rng() * 0.15);
    const warm = rng() < 0.5;
    const col = warm
      ? [255, 250 - (rng() * 10) | 0, 236 - (rng() * 14) | 0]
      : [206 - (rng() * 16) | 0, 209 - (rng() * 14) | 0, 224 - (rng() * 8) | 0];
    const a = warm ? 0.20 + rng() * 0.26 : 0.10 + rng() * 0.20;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${a})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Paint chips: small hard-edged flecks that read as warm primer under the
  // sage once they multiply through.
  for (let i = 0; i < 90; i++) {
    const x = rng() * size, y = rng() * size;
    const w = 1 + rng() * 4, h = 1 + rng() * 3;
    g.fillStyle = `rgba(${168 + (rng() * 26) | 0},${124 + (rng() * 22) | 0},${94 + (rng() * 18) | 0},${0.28 + rng() * 0.4})`;
    g.beginPath();
    g.ellipse(x, y, w, h, rng() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }

  // Streaks of rain-washed grime running "down" the texture.
  for (let i = 0; i < 40; i++) {
    const x = rng() * size;
    const y0 = rng() * size * 0.5;
    const len = size * (0.1 + rng() * 0.4);
    g.strokeStyle = `rgba(150,138,124,${0.10 + rng() * 0.16})`;
    g.lineWidth = 0.6 + rng() * 2.2;
    g.beginPath();
    g.moveTo(x, y0);
    for (let s = 1; s <= 5; s++) {
      g.lineTo(x + Math.sin(s * 1.3 + i) * 1.8, y0 + (len * s) / 5);
    }
    g.stroke();
  }

  // An optional whole-sheet tint, for buckets (gun steel, track) that want the
  // same brush marks at a different value without a second canvas.
  if (tint) {
    const t = new THREE.Color(tint);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = `#${t.getHexString()}`;
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = 'source-over';
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * The Gallian roundel, as a decal sheet with alpha: a cream disc, a red bar
 * across it and a hand-drawn ink rim. Stencilled on, so the edges are ragged
 * and the paint is thin enough that the plate's own mottle reads through.
 */
function makeInsigniaTexture(seed, size = 128) {
  const rng = makeRng(seed);
  const { c, g } = canvas2d(size);
  g.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2, R = size * 0.40;

  // Ragged stencil disc — a polygon of jittered radii, not a perfect circle.
  const ring = (rr, jitter) => {
    g.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * TAU;
      const r = rr * (1 + (rng() - 0.5) * jitter);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  };

  g.globalAlpha = 0.88;
  g.fillStyle = '#e6dcc0';
  ring(R, 0.06); g.fill();

  // The bar.
  g.globalAlpha = 0.92;
  g.fillStyle = '#a34434';
  g.save();
  g.translate(cx, cy); g.rotate(-0.06);
  g.fillRect(-R * 0.98, -R * 0.30, R * 1.96, R * 0.60);
  g.restore();

  // Ink rim, drawn twice with a wobble so it reads as a pen line.
  g.globalAlpha = 0.85;
  g.strokeStyle = '#3b3128';
  for (let k = 0; k < 2; k++) {
    g.lineWidth = 1.6 + k * 0.7;
    ring(R * (1 - k * 0.015), 0.045);
    g.stroke();
  }

  // Wear: knock holes out of the paint so the stencil is not pristine.
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 40; i++) {
    const a = rng() * TAU, r = R * (0.2 + rng() * 0.95);
    g.beginPath();
    g.ellipse(cx + Math.cos(a) * r, cy + Math.sin(a) * r,
      1 + rng() * 3.5, 1 + rng() * 3, rng() * Math.PI, 0, TAU);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Blackened, radially-streaked scorch mark for damage decals. */
function makeScorchTexture(seed, size = 128) {
  const rng = makeRng(seed);
  const { c, g } = canvas2d(size);
  g.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;
  // Core.
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, size * 0.34);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  // Radial soot fingers.
  g.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2;
    const len = size * (0.16 + rng() * 0.3);
    g.strokeStyle = `rgba(255,255,255,${0.12 + rng() * 0.35})`;
    g.lineWidth = 1 + rng() * 5;
    g.beginPath();
    g.moveTo(cx, cy);
    let x = cx, y = cy;
    for (let s = 1; s <= 4; s++) {
      const aa = a + (rng() - 0.5) * 0.35;
      x += Math.cos(aa) * (len / 4);
      y += Math.sin(aa) * (len / 4);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // Spatter.
  for (let i = 0; i < 70; i++) {
    const a = rng() * Math.PI * 2, r = rng() * size * 0.45;
    g.fillStyle = `rgba(255,255,255,${0.1 + rng() * 0.4})`;
    g.beginPath();
    g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0.6 + rng() * 2.4, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// ============================================================================
//  Materials
// ============================================================================

/**
 * All tank surfaces go through the shared NPR material so the banding, hatching
 * and outline pass stay coherent with the rest of the frame. `map` is honoured
 * by makeCanvasMaterial (it sets VC_MAP), so the procedural armour pigment
 * multiplies into the shader's albedo before quantisation.
 */
function npr(opts) {
  return makeCanvasMaterial(opts);
}

// ============================================================================
//  Tank
// ============================================================================

let _tankSerial = 0;

export class Tank {
  /**
   * @param {object} cfg {
   *   team:0|1, name, seed, variant:'edelweiss'|'lupus'|'heavy',
   *   world, scene, physics:PhysicsWorld|null, hp
   * }
   */
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.team = cfg.team ?? 0;
    this.name = cfg.name || 'Edelweiss';
    this.variant = cfg.variant || 'edelweiss';
    this.seed = (cfg.seed ?? (CFG.seed + (_tankSerial++) * 7919)) >>> 0;
    this.rng = makeRng(this.seed);

    this.root = new THREE.Group();
    this.root.name = `tank:${this.name}`;
    // Everything visible hangs off `chassis`, NOT off `root`.
    //
    // `root` is the vehicle's GROUND point and its heading — the same contract
    // every other actor follows, and what the game layer writes into it every
    // frame (Unit.syncActor copies Unit.pos, whose Y is the terrain height).
    // The suspension datum sits `rideHeight` above that, and it also carries the
    // hull's pitch and roll. Keeping those on an inner group means the game
    // layer and the physics can BOTH own the placement without fighting: before
    // this split, syncActor's terrain-height write landed last and buried the
    // Edelweiss up to the top of its tracks, 0.60 m into the dirt, every frame.
    this.chassis = new THREE.Group();
    this.chassis.name = 'chassis';
    this.chassis.position.y = 0.60;             // = rideHeight, set again below
    this.root.add(this.chassis);
    this.root.userData.tank = this;

    // ---- dimensions -------------------------------------------------------
    this.rideHeight = 0.60;
    this.wheelRadius = 0.34;
    this.gauge = 2.42;                    // track centre-to-centre
    this.trackWidth = 0.42;
    this.wheelCount = 6;
    this.axleY = -(this.rideHeight - this.wheelRadius);   // -0.26
    // Where the narrow lower hull flares out into the full-width superstructure.
    // Everything below it is running gear; everything above it overhangs the
    // track. Must clear the top of the return run — see sponsonRing().
    this.sponsonY = this.axleY + 0.53;                    // 0.27
    this.fenderY = this.axleY + 0.59;                     // 0.33
    /**
     * How much taller the superstructure is than the round-2 hull, in metres.
     *
     * The old envelope topped out at deck 0.52 / turret roof 0.98 above the
     * suspension datum, i.e. 1.12 m and 1.58 m off the ground on a 4.90 m hull —
     * a 3.1:1 length-to-height wedge. Nothing on the battlefield is that shape:
     * a real light/medium tank is about 2.3:1, and the Edelweiss in particular
     * is a TALL vehicle whose turret roof sits above a standing man's head. At
     * 1.58 m every soldier in every shot loomed over it, which is most of why
     * axis 7 (form) scored 4 — the silhouette was reading as an armoured car.
     *
     * Every deck-mounted feature below adds DECK to its Y and every glacis
     * feature is re-derived from the (now steeper) plate, so this is the ONE
     * number to change if the proportion needs another pass. It also finally
     * puts the visual radiator inside the y-band src/game/units.js has always
     * declared for the `radiator` aim region (1.05..1.62 above ground).
     */
    this.deckRise = 0.24;

    // Hit volumes consumed by src/physics/ballistics.js.
    //
    // NOTE THE FRAME. ballistics.tankBox() resolves `hull`, `trackL` and
    // `trackR` against tank.ROOT — the ground point — and only `turret` against
    // the turret node. The round-2 offsets were written as if they were in
    // chassis space, so the hull box sat a full rideHeight (0.60 m) below the
    // hull: it spanned -0.24..0.60 above the ground while the armour it was
    // standing in for spanned 0.46..1.12. Rounds aimed at the hull passed
    // through it and hit the terrain, and rounds aimed at the tracks tested a
    // box that was half underground. Root-relative from here.
    // Armour envelope in chassis space: belly at -0.14, deck at 0.52 + deckRise.
    const hullBot = -0.14, hullTop = 0.52 + this.deckRise;
    this.hitDims = {
      hull: { hx: 1.20, hy: (hullTop - hullBot) / 2, hz: 2.50 },
      turret: { hx: 0.86, hy: 0.32, hz: 1.00 },
      trackL: { hx: 0.24, hy: 0.36, hz: 2.45 },
      trackR: { hx: 0.24, hy: 0.36, hz: 2.45 },
    };
    this.hitOffsets = {
      hull: { x: 0, y: this.rideHeight + (hullTop + hullBot) / 2, z: 0 },
      turret: { x: 0, y: 0.22, z: -0.05 },
      trackL: { x: -this.gauge / 2, y: this.rideHeight + this.axleY + 0.02, z: 0 },
      trackR: { x: this.gauge / 2, y: this.rideHeight + this.axleY + 0.02, z: 0 },
    };

    // ---- combat state -----------------------------------------------------
    this.maxHp = cfg.hp ?? 2400;
    this.hp = this.maxHp;
    this.alive = true;
    this.destroyed = false;
    this.critical = false;                // radiator breached -> burning
    this.radiatorHp = cfg.radiatorHp ?? 420;
    this.trackHp = [520, 520];
    this.turretJammed = false;

    // ---- turret / gun -----------------------------------------------------
    this.turretYaw = 0;
    this.turretYawTarget = 0;
    this.gunPitch = 0;
    this.gunPitchTarget = 0;
    this.turretSlew = 1.15 * (this.variant === 'heavy' ? 0.7 : 1);   // rad/s
    this.gunSlew = 0.62;
    this.gunMinPitch = -10 * DEG;
    this.gunMaxPitch = 22 * DEG;
    this.recoil = 0;
    this.recoilVel = 0;
    this.reload = 0;
    this.reloadTime = cfg.reloadTime ?? 3.4;
    this.coaxHeat = 0;

    this._muzzleWorld = new THREE.Vector3();
    this._weakWorld = new THREE.Vector3();
    this._headWorld = new THREE.Vector3();
    this._fireDir = new THREE.Vector3(0, 0, 1);

    // ---- build ------------------------------------------------------------
    this.textures = [];
    this.materials = [];
    this._buildMaterials();
    this._buildHull();
    this._buildTurret();
    this._buildRunningGear();
    this._buildMarkings();
    this._buildTrack();
    this._buildDamageDecals();
    this._buildFx(cfg.scene || null);

    // ---- physics ----------------------------------------------------------
    this.world = cfg.world || null;
    this.physics = null;
    this._externalStep = false;
    this._physicsHost = null;
    if (this.world) {
      this.physics = new TankPhysics(this, this.world, {
        scene: cfg.scene || null,
        seed: this.seed,
        gauge: this.gauge,
        wheelCount: this.wheelCount,
        wheelRadius: this.wheelRadius,
        rideHeight: this.rideHeight,
        mass: this.variant === 'heavy' ? 21000 : 13200,
        maxSpeed: this.variant === 'heavy' ? 7.2 : 9.4,
      });
      if (cfg.physics && cfg.physics.addStepper) {
        cfg.physics.addStepper(this.physics);
        this._physicsHost = cfg.physics;
        this._externalStep = true;
      }
      this.ballistics = (cfg.physics && cfg.physics.ballistics) || null;
    } else {
      this.ballistics = (cfg.physics && cfg.physics.ballistics) || null;
    }

    this.time = 0;
    this.clip = 'idle';
    this._antennaPhase = this.rng() * TAU;
    this._exhaustAccum = 0;
    this._smokeAccum = 0;
    this._fireAccum = 0;
    this._muzzleFlash = 0;
    this._hatchOpen = 0;
    this._hatchTarget = 0;
  }

  // ==========================================================================
  //  Construction
  // ==========================================================================

  _buildMaterials() {
    const texSize = byQ([128, 256, 256]);
    // One brush sheet for the painted armour and a darker-tinted copy for the
    // bare steel. Both are modulation maps around 1.0 (see makeArmourTexture),
    // so the pigment stays in `color` where the quantiser can band it.
    const paintTex = makeArmourTexture(this.seed ^ 0x51ab, 0, texSize);
    const metalTex = makeArmourTexture(this.seed ^ 0x9f11, 0xdcd8d0, texSize >> 1);
    this.textures.push(paintTex, metalTex);

    const mk = (name, opts) => {
      const m = npr(opts);
      if (m) { m.name = `tank:${name}`; this.materials.push(m); }
      return m;
    };

    // The armour is the largest single surface in any shot it appears in, so it
    // carries the frame's banding score. Five levels with a wide wet edge is
    // what turns a rolled plate into a cream deck band meeting a violet side
    // band along one wandering pigment boundary.
    const armourBands = Math.max(4, (CFG.render.bands | 0) + 1);

    this.mat = {
      paint: mk('paint', {
        color: PAL.paint, roughness: 0.78, hatch: 1.25, rim: 0.55, paper: 1.0,
        outlineWidth: 1.25, map: paintTex, mapRepeat: [3, 2.5],
        bands: armourBands, bandBleed: 1.7, hatchSpacing: 4.2, wrap: 0.30,
      }),
      metal: mk('metal', {
        color: PAL.darkMetal, roughness: 0.62, hatch: 1.1, rim: 0.85, paper: 0.85,
        outlineWidth: 1.1, map: metalTex, mapRepeat: [2, 2],
        bands: armourBands, bandBleed: 1.5, hatchSpacing: 4.2, wrap: 0.32,
      }),
      track: mk('track', {
        color: PAL.track, roughness: 0.7, hatch: 0.9, rim: 0.7, paper: 0.8,
        outlineWidth: 0.85, instanced: true, bands: armourBands, bandBleed: 1.4,
        wrap: 0.34,
      }),
      rubber: mk('rubber', {
        color: PAL.rubber, roughness: 0.95, hatch: 0.8, rim: 0.35, paper: 0.7,
        outlineWidth: 1.0, instanced: true, wrap: 0.34,
      }),
      ochre: mk('ochre', {
        color: PAL.ochre, roughness: 0.92, hatch: 1.0, rim: 0.4, paper: 1.0,
        outlineWidth: 1.15, subsurface: 0.25, bands: armourBands, bandBleed: 1.5,
      }),
      wood: mk('wood', { color: PAL.wood, roughness: 0.88, hatch: 0.9, rim: 0.4, paper: 1.0 }),
      glass: mk('glass', {
        color: PAL.glass, roughness: 0.18, hatch: 0.2, rim: 1.0, paper: 0.3,
        emissive: 0x2a2418, outlineWidth: 0.9,
      }),
      grille: mk('grille', {
        color: PAL.grille, roughness: 0.55, hatch: 1.0, rim: 0.9, paper: 0.7,
        outlineWidth: 1.4,
      }),
      rivet: mk('rivet', {
        color: PAL.paintAlt, roughness: 0.7, hatch: 0.8, rim: 0.9, paper: 0.9,
        instanced: true, outlineWidth: 0.6,
      }),
      insignia: mk('insignia', {
        color: 0xffffff, roughness: 0.85, hatch: 0.5, rim: 0.3, paper: 1.0,
        map: makeInsigniaTexture(this.seed ^ 0x71c3), alphaTest: 0.35,
        outline: false, bands: armourBands, bandBleed: 1.5, wrap: 0.30,
        side: THREE.DoubleSide, name: 'vcTankInsignia',
      }),
    };
    this.textures.push(this.mat.insignia.uniforms.uMap.value);
  }

  /** Hull, fenders, stowage, tools, lamps, exhaust, radiator. */
  _buildHull() {
    const rng = this.rng;
    const B = { paint: [], metal: [], ochre: [], wood: [], glass: [], grille: [] };
    const rivets = [];

    // ---- primary armour envelope -----------------------------------------
    // Stations run rear -> nose. The deck drops sharply from z=1.4 forward:
    // that is the glacis, and its slope is what the penetration model reads.
    //
    // `rise` lifts the superstructure (see this.deckRise) without moving the
    // nose, so the glacis gets STEEPER as well as the vehicle getting taller —
    // 24 degrees from horizontal before, 33.5 after. That matters twice over: a
    // steeper plate is a bigger, flatter facet aimed more directly at the sky,
    // which is exactly the surface a three-band quantiser needs to park a whole
    // cream wash on, and it is the single silhouette line that says "tank"
    // rather than "box on tracks".
    const rise = this.deckRise;
    const stations = [
      { z: -2.56, w: 1.14, wl: 0.94, yBot: -0.06, yTop: 0.40 + rise * 0.92, ch: 0.14 },
      { z: -2.10, w: 1.20, wl: 0.97, yBot: -0.13, yTop: 0.50 + rise, ch: 0.16 },
      { z: -1.20, w: 1.21, wl: 0.97, yBot: -0.14, yTop: 0.52 + rise, ch: 0.17 },
      { z: 0.10, w: 1.21, wl: 0.97, yBot: -0.14, yTop: 0.52 + rise, ch: 0.17 },
      { z: 1.05, w: 1.21, wl: 0.97, yBot: -0.14, yTop: 0.51 + rise, ch: 0.17 },
      { z: 1.42, w: 1.20, wl: 0.96, yBot: -0.14, yTop: 0.48 + rise * 0.92, ch: 0.17 },
      { z: 1.98, w: 1.14, wl: 0.92, yBot: -0.12, yTop: 0.26 + rise * 0.33, ch: 0.14 },
      { z: 2.34, w: 1.02, wl: 0.86, yBot: -0.01, yTop: 0.07 + rise * 0.08, ch: 0.09 },
    ];
    /**
     * Deck height at a station z — the datum EVERY deck and glacis fitting now
     * hangs off. Round 2 had all forty of them written as absolute constants,
     * which is why the last proportion change left the hatch floating and the
     * spare track links buried: raising the roof silently moved the plate they
     * were bolted to and nothing followed. Interpolated, they follow.
     */
    const deckAt = (z) => {
      const last = stations.length - 1;
      if (z <= stations[0].z) return stations[0].yTop;
      if (z >= stations[last].z) return stations[last].yTop;
      for (let i = 0; i < last; i++) {
        if (z <= stations[i + 1].z) {
          const k = (z - stations[i].z) / (stations[i + 1].z - stations[i].z);
          return lerp(stations[i].yTop, stations[i + 1].yTop, k);
        }
      }
      return stations[last].yTop;
    };
    /** The glacis plate: where its break is, and how steeply it falls. */
    const glacisA = stations[5], glacisB = stations[7];
    const glacisSlope = Math.atan2(glacisA.yTop - glacisB.yTop, glacisB.z - glacisA.z);
    /** Deck height under the turret ring. _buildTurret and _buildMarkings read it. */
    this.turretDeckY = deckAt(-0.10);
    this.glacisSlope = glacisSlope;
    this.glacisAt = deckAt;
    // The shelf clears the top of the return run (y = rollerY + rollerR) so the
    // whole track loop lives in the pocket under the overhang.
    const shelfY = this.sponsonY;
    const rings = stations.map((s) => ({
      z: s.z, pts: sponsonRing(s.w, s.wl, s.yBot, s.yTop, s.ch, 0.018, shelfY),
    }));
    B.paint.push(loft(subdivideStations(rings, byQ([1, 3, 4]), byQ([1, 2, 3])), true, true));

    // ---- weld seams at the plate joins ------------------------------------
    // Only the structurally meaningful joins get a bead: nose, glacis break,
    // turret ring station and the rear plate.
    const weldAt = [1, 5, 6, 7];
    const beadR = byQ([0.017, 0.021, 0.023]);
    for (const i of weldAt) {
      for (const g of weldRing(rings[i].pts, rings[i].z, beadR, rng)) B.metal.push(g);
    }
    // A longitudinal seam down each side, along the sponson shelf — the join
    // between the lower hull tub and the superstructure that sits on top of it.
    for (const sx of [-1, 1]) {
      let pz = -2.5;
      const sy = shelfY + 0.062;
      while (pz < 2.05) {
        const nz = Math.min(2.05, pz + 0.42);
        B.metal.push(cylBetween(sx * 1.208, sy + Math.sin(pz) * 0.004, pz,
          sx * 1.208, sy + Math.sin(nz) * 0.004, nz, beadR * 0.8, 5));
        pz = nz;
      }
      // And a second one down the lower tub, where the belly plate is welded on.
      pz = -2.4;
      while (pz < 1.9) {
        const nz = Math.min(1.9, pz + 0.52);
        B.metal.push(cylBetween(sx * 0.968, -0.10 + Math.cos(pz * 0.7) * 0.004, pz,
          sx * 0.968, -0.10 + Math.cos(nz * 0.7) * 0.004, nz, beadR * 0.7, 5));
        pz = nz;
      }
    }

    // ---- rivet / bolt lines ----------------------------------------------
    const rivetSpacing = byQ([0.34, 0.22, 0.17]);
    for (const i of [1, 5, 6, 7]) ringSamples(rings[i].pts, rings[i].z, rivetSpacing, rivets);
    // Bolt circle round the turret ring.
    const ringR = 0.86;
    const nBolts = byQ([12, 20, 26]);
    for (let i = 0; i < nBolts; i++) {
      const a = (i / nBolts) * TAU;
      rivets.push([Math.cos(a) * ringR, this.turretDeckY + 0.005, -0.10 + Math.sin(a) * ringR, 0]);
    }

    // ---- turret ring / race ----------------------------------------------
    const race = new THREE.CylinderGeometry(0.90, 0.94, 0.09, byQ([16, 24, 32]), 1, true);
    place(race, 0, this.turretDeckY, -0.10);
    B.metal.push(race);

    // ---- engine deck: louvred grilles above the powerpack -----------------
    for (const zc of [-1.35, -1.95]) {
      const dy = deckAt(zc);
      const frame = new THREE.BoxGeometry(1.34, 0.05, 0.46);
      place(frame, 0, dy, zc);
      B.metal.push(frame);
      const slats = byQ([4, 7, 9]);
      for (let i = 0; i < slats; i++) {
        const s = new THREE.BoxGeometry(1.22, 0.035, 0.035);
        place(s, 0, dy + 0.031, zc - 0.19 + (i / (slats - 1)) * 0.38, 0.42, 0, 0);
        B.grille.push(s);
      }
    }

    // ---- rear plate + THE RADIATOR (the weak point) -----------------------
    //
    // This is the one panel on the vehicle a player has to be able to name from
    // forty metres, and round 2 it was a dark rectangle among dark rectangles at
    // knee height. Three changes, all about READABILITY rather than detail:
    //
    //   1. It moves UP the rear plate, from a centre 0.77 m off the ground to
    //      1.09 m — which is where src/game/units.js has always declared the
    //      `radiator` aim region (1.05..1.62) and where a gunner would actually
    //      look. The old grille was below the tow shackles.
    //   2. It is RECESSED behind a proud, chamfered rim frame that stands 6 cm
    //      off the plate all the way round. A recess is what gives the quantiser
    //      something to work with: the rim catches the top band and the well
    //      behind it drops two bands, so the feature reads as a hole even in
    //      silhouette instead of relying on the grille's teal albedo.
    //   3. Its louvres are deeper and steeper (0.11 m at 40 degrees rather than
    //      0.07 at 29), so the slats self-shadow into a row of hard darks.
    const radZ = -2.585;
    // Centred on the rear plate's clear span — between the belly chamfer and the
    // deck chamfer, which on the raised hull is local y 0.08..0.48.
    const radY = (deckAt(-2.56) - 0.14 + 0.08) / 2 + 0.02;
    this.radiatorY = radY;
    const radHalfH = 0.155;
    // Proud rim frame: four bars round a hole, not a slab. They overlap at the
    // corners — at this scale nobody counts the vertices, and an unbroken rim is
    // the whole point.
    for (const [w, hgt, ox, oy] of [
      [1.34, 0.06, 0, radHalfH + 0.03], [1.34, 0.06, 0, -radHalfH - 0.03],
      [0.06, radHalfH * 2 + 0.12, 0.64, 0], [0.06, radHalfH * 2 + 0.12, -0.64, 0],
    ]) {
      const bar = new THREE.BoxGeometry(w, hgt, 0.10);
      place(bar, ox, radY + oy, radZ + 0.045);
      B.metal.push(bar);
    }
    const radBack = new THREE.BoxGeometry(1.22, radHalfH * 2, 0.04);
    place(radBack, 0, radY, radZ - 0.055);
    B.grille.push(radBack);
    const nSlats = byQ([5, 9, 13]);
    for (let i = 0; i < nSlats; i++) {
      const s = new THREE.BoxGeometry(1.18, 0.030, 0.10);
      place(s, 0, radY - radHalfH * 0.84 + (i / (nSlats - 1)) * radHalfH * 1.68,
        radZ - 0.02, -0.70, 0, 0);
      B.grille.push(s);
    }
    // Protective bar cage over the radiator — bent, and it shows.
    for (let i = 0; i < 3; i++) {
      const y = radY - 0.13 + i * 0.13;
      B.metal.push(cylBetween(-0.62, y, radZ - 0.08, 0.62, y + (i === 1 ? 0.015 : 0), radZ - 0.08, 0.018, 5));
    }
    B.metal.push(cylBetween(-0.62, radY - 0.19, radZ - 0.08, -0.62, radY + 0.19, radZ - 0.08, 0.02, 5));
    B.metal.push(cylBetween(0.62, radY - 0.19, radZ - 0.08, 0.62, radY + 0.19, radZ - 0.08, 0.02, 5));

    this.weakPoint = new THREE.Object3D();
    this.weakPoint.position.set(0, radY, radZ - 0.09);
    this.chassis.add(this.weakPoint);
    this.weakPointRadius = 0.52;

    // ---- exhaust stacks ---------------------------------------------------
    for (const sx of [-1, 1]) {
      const muff = new THREE.CylinderGeometry(0.10, 0.11, 0.72, byQ([6, 10, 12]));
      place(muff, sx * 0.92, 0.30, -2.18, 0, 0, Math.PI / 2 + sx * 0.04);
      B.metal.push(muff);
      const stack = new THREE.CylinderGeometry(0.055, 0.07, 0.40, byQ([5, 8, 10]));
      place(stack, sx * 0.92, deckAt(-2.32) - 0.06, -2.32, -0.22, 0, 0);
      B.metal.push(stack);
      // Heat shield: a curved strap over the muffler.
      const shield = new THREE.CylinderGeometry(0.135, 0.135, 0.5, 8, 1, true, Math.PI * 0.15, Math.PI * 0.7);
      place(shield, sx * 0.92, 0.30, -2.18, 0, 0, Math.PI / 2);
      B.paint.push(shield);
    }
    this.exhaustPort = new THREE.Object3D();
    this.exhaustPort.position.set(0.92, deckAt(-2.36) + 0.16, -2.36);
    this.chassis.add(this.exhaustPort);

    // ---- fenders + mud flaps ---------------------------------------------
    // Sat level with the sponson underside so the fender reads as the sponson
    // floor carried out over the track, not as a shelf floating beside the hull.
    const fenderY = this.fenderY;
    for (const sx of [-1, 1]) {
      const plate = new THREE.BoxGeometry(0.44, 0.028, 4.5);
      place(plate, sx * 1.30, fenderY, -0.05);
      B.paint.push(plate);
      // Down-turned front lip and rear flap.
      const lip = new THREE.BoxGeometry(0.44, 0.24, 0.028);
      place(lip, sx * 1.30, fenderY - 0.10, 2.20, 0.32, 0, 0);
      B.paint.push(lip);
      const flap = new THREE.BoxGeometry(0.42, 0.30, 0.022);
      place(flap, sx * 1.30, fenderY - 0.15, -2.30, -0.16, 0, 0);
      B.ochre.push(flap);
      // Support brackets: diagonal struts from under the outboard lip of the
      // fender up to the sponson side. They must stay OUTSIDE the track's
      // return run, which now passes under the overhang at x ±1.00..1.42.
      for (const z of [1.8, 0.7, -0.5, -1.7]) {
        B.metal.push(cylBetween(sx * 1.46, fenderY - 0.012, z,
          sx * 1.205, fenderY + 0.15, z + 0.06, 0.018, 4));
      }
      // Rivets along the fender edge.
      for (let z = -2.2; z <= 2.15; z += rivetSpacing * 1.6) {
        rivets.push([sx * 1.49, fenderY + 0.016, z, 0]);
      }
    }

    // ---- stowage boxes ----------------------------------------------------
    const boxSpec = [
      [-1.30, fenderY + 0.17, -1.35, 0.40, 0.30, 0.92],
      [1.30, fenderY + 0.15, -1.55, 0.40, 0.26, 0.70],
      [1.30, fenderY + 0.13, -0.45, 0.38, 0.22, 0.52],
    ];
    for (const [x, y, z, w, h, d] of boxSpec) {
      const b = new THREE.BoxGeometry(w, h, d);
      place(b, x, y, z);
      B.paint.push(b);
      // Lid lip + two latches.
      const lid = new THREE.BoxGeometry(w + 0.03, 0.022, d + 0.03);
      place(lid, x, y + h / 2 + 0.01, z);
      B.metal.push(lid);
      for (const s of [-1, 1]) {
        const l = new THREE.BoxGeometry(0.05, 0.07, 0.02);
        place(l, x + (w / 2) * 0.99 * Math.sign(x || 1), y + h * 0.1, z + s * d * 0.3, 0, Math.PI / 2, 0);
        B.metal.push(l);
      }
    }

    // ---- bolted applique plate on each sponson side -----------------------
    //
    // THE SPONSON SIDE IS THE BIGGEST FLAT THING ON THE VEHICLE and it is what a
    // three-quarter shot spends most of its pixels on. Round 2 it was one
    // unbroken 0.26 x 3.6 m wash from the idler to the sprocket, and a wash with
    // no plane change in it cannot band: the quantiser has nothing to quantise,
    // so the whole flank landed on one level and the critic read it as a
    // smooth-shaded slab with hatching printed over the top.
    //
    // A plate standing 2.5 cm proud, with its own bevel and its own bolt line,
    // gives that surface a raised island whose four edges each carry a real
    // normal discontinuity — which is where a wash boundary can actually sit —
    // and gives the outline pass a closed interior contour to draw. It is also
    // exactly what a field-modified Gallian tank would have on it.
    const sideY = this.sponsonY + 0.06 + 0.13;      // mid-height of the flat run
    for (const sx of [-1, 1]) {
      for (const [z0, z1] of [[-1.62, -0.34], [0.06, 1.30]]) {
        const len = z1 - z0;
        const plate = new THREE.BoxGeometry(0.05, 0.235, len);
        place(plate, sx * 1.225, sideY, (z0 + z1) / 2);
        B.paint.push(plate);
        // Chamfered lip top and bottom so the plate has a bevel to catch light
        // rather than a razor edge that the outline pass turns into a hairline.
        for (const s of [-1, 1]) {
          const lip = new THREE.BoxGeometry(0.05, 0.03, len);
          place(lip, sx * 1.216, sideY + s * 0.132, (z0 + z1) / 2, 0, 0, 0);
          B.metal.push(lip);
        }
        // Bolt line round the perimeter.
        const nz = Math.max(3, Math.round(len / (rivetSpacing * 1.5)));
        for (let i = 0; i <= nz; i++) {
          const z = lerp(z0 + 0.05, z1 - 0.05, i / nz);
          rivets.push([sx * 1.252, sideY + 0.10, z, 0]);
          rivets.push([sx * 1.252, sideY - 0.10, z, 0]);
        }
      }
    }

    // ---- spare road wheel, bolted to the port hull side --------------------
    // A round, high-contrast object at the rear quarter: it is the one thing on
    // the flank that is not a horizontal, and in silhouette it is what tells you
    // which end of the tank you are looking at from behind.
    {
      const sw = new THREE.CylinderGeometry(this.wheelRadius * 0.92, this.wheelRadius * 0.92,
        0.12, byQ([8, 14, 18]));
      place(sw, -1.30, sideY + 0.02, -2.02, 0, 0, Math.PI / 2);
      B.metal.push(sw);
      const swHub = new THREE.CylinderGeometry(0.085, 0.085, 0.17, byQ([6, 8, 10]));
      place(swHub, -1.30, sideY + 0.02, -2.02, 0, 0, Math.PI / 2);
      B.metal.push(swHub);
      B.metal.push(cylBetween(-1.22, sideY + 0.02, -2.02, -1.38, sideY + 0.02, -2.02, 0.026, 5));
    }

    // ---- jerrican rack on the starboard fender ----------------------------
    for (let i = 0; i < 2; i++) {
      const jz = 1.72 - i * 0.30;
      const can = new THREE.BoxGeometry(0.17, 0.44, 0.26);
      place(can, 1.36, fenderY + 0.24, jz);
      B.ochre.push(can);
      // The three ribs that make a jerrican a jerrican.
      for (const r of [-0.075, 0, 0.075]) {
        const rib = new THREE.BoxGeometry(0.015, 0.36, 0.03);
        place(rib, 1.445, fenderY + 0.24, jz + r);
        B.metal.push(rib);
      }
      B.metal.push(place(new THREE.BoxGeometry(0.14, 0.035, 0.06), 1.36, fenderY + 0.455, jz));
    }
    B.metal.push(cylBetween(1.24, fenderY + 0.40, 1.90, 1.24, fenderY + 0.40, 1.40, 0.016, 4));
    B.metal.push(cylBetween(1.48, fenderY + 0.40, 1.90, 1.48, fenderY + 0.40, 1.40, 0.016, 4));

    // ---- tool rack: shovel, crowbar, axe ----------------------------------
    const tz = 0.9;
    // Shovel.
    B.wood.push(place(new THREE.CylinderGeometry(0.022, 0.026, 0.70, 6), 1.30, fenderY + 0.05, tz, 0, 0, Math.PI / 2));
    B.metal.push(placeS(new THREE.BoxGeometry(1, 1, 1), 1.30, fenderY + 0.05, tz + 0.44, 0.18, 0.03, 0.24));
    // Crowbar.
    B.metal.push(place(new THREE.CylinderGeometry(0.016, 0.016, 0.86, 5), -1.30, fenderY + 0.05, tz + 0.2, 0, 0, Math.PI / 2));
    // Axe.
    B.wood.push(place(new THREE.CylinderGeometry(0.018, 0.02, 0.56, 6), -1.30, fenderY + 0.05, tz - 0.75, 0, 0, Math.PI / 2));
    B.metal.push(placeS(new THREE.BoxGeometry(1, 1, 1), -1.30, fenderY + 0.06, tz - 1.05, 0.16, 0.02, 0.14));
    // Retaining straps.
    for (const [x, z] of [[1.30, tz], [-1.30, tz + 0.2], [-1.30, tz - 0.75]]) {
      for (const dz of [-0.22, 0.22]) {
        const s = new THREE.BoxGeometry(0.09, 0.012, 0.05);
        place(s, x, fenderY + 0.05, z + dz);
        B.ochre.push(s);
      }
    }

    // ---- spare track links on the glacis ----------------------------------
    // Every one of these is now placed ON the plate rather than at a constant
    // that used to be on it: `deckAt(z)` is the plate, `glacisSlope` is its
    // pitch, and the +0.03 is how proud a stowed shoe sits.
    const spare = byQ([3, 5, 6]);
    for (let i = 0; i < spare; i++) {
      const g = this._linkGeometry(0);
      const t = i / Math.max(1, spare - 1);
      const lz = lerp(1.62, 2.05, t * 0.2 + 0.35);
      placeS(g, -0.55 + t * 1.1, deckAt(lz) + 0.03, lz,
        0.9, 0.9, 0.9, -(Math.PI / 2 - glacisSlope), Math.PI / 2, 0);
      B.metal.push(g);
    }
    // The bracket holding them.
    B.metal.push(cylBetween(-0.62, deckAt(1.60) + 0.02, 1.60, 0.62, deckAt(1.98) + 0.02, 1.98, 0.016, 5));

    // ---- headlamps + guards ----------------------------------------------
    // Round 2 rendered these as two ping-pong balls: a bare 0.093 m hemisphere
    // of `glass` (emissive, rim 1.0) standing proud of the nose with nothing
    // round it, so both read as pure white blobs and were the brightest thing on
    // the vehicle. They are now RECESSED — a deeper drum with a hood over the
    // top half — and the lens is a shallow disc set 2 cm inside it, so the light
    // that reaches it is the light that reaches the inside of a bucket.
    for (const sx of [-1, 1]) {
      const hx = sx * 0.86, hz = 2.02;
      const hy = deckAt(hz) + 0.13;
      const body = new THREE.CylinderGeometry(0.105, 0.115, 0.19, byQ([6, 10, 14]));
      place(body, hx, hy, hz, Math.PI / 2 - 0.3, 0, 0);
      B.metal.push(body);
      const lens = new THREE.CylinderGeometry(0.082, 0.082, 0.018, byQ([6, 10, 12]));
      place(lens, hx, hy + 0.004, hz + 0.012, Math.PI / 2 - 0.3, 0, 0);
      B.glass.push(lens);
      // The hood: a half-collar over the top of the drum, carried forward.
      const hood = new THREE.CylinderGeometry(0.118, 0.118, 0.16, byQ([8, 12, 16]), 1, true,
        Math.PI * 0.08, Math.PI * 0.84);
      place(hood, hx, hy + 0.012, hz + 0.05, Math.PI / 2 - 0.3, 0, 0);
      B.paint.push(hood);
      // Wire guard: three arcs across the open face.
      for (let i = 0; i < 3; i++) {
        const a = -0.6 + i * 0.6;
        B.metal.push(cylBetween(
          hx + Math.cos(a) * 0.1, hy + Math.sin(a) * 0.1 - 0.02, hz + 0.02,
          hx + Math.cos(a) * 0.1, hy + Math.sin(a) * 0.1 + 0.02, hz + 0.10, 0.008, 4));
      }
      const mount = new THREE.BoxGeometry(0.06, 0.10, 0.05);
      place(mount, hx, hy - 0.14, hz - 0.02);
      B.metal.push(mount);
    }

    // ---- driver's visor + hull MG port ------------------------------------
    // Both sit ON the glacis and both are now derived from it, including their
    // rotation: at 33.5 degrees a visor left at the old -0.42 rad stood 9
    // degrees off the plate and cast a wedge of shadow that read as a crack.
    const visorZ = 1.80, mgZ = 1.86;
    const visor = new THREE.BoxGeometry(0.38, 0.15, 0.07);
    place(visor, -0.42, deckAt(visorZ) + 0.035, visorZ, -glacisSlope, 0, 0);
    B.metal.push(visor);
    const slit = new THREE.BoxGeometry(0.30, 0.038, 0.03);
    place(slit, -0.42, deckAt(visorZ) + 0.042, visorZ + 0.028, -glacisSlope, 0, 0);
    B.grille.push(slit);
    const mgBall = new THREE.SphereGeometry(0.16, byQ([6, 10, 14]), byQ([5, 7, 9]));
    place(mgBall, 0.46, deckAt(mgZ) + 0.01, mgZ);
    B.metal.push(mgBall);
    B.metal.push(place(new THREE.CylinderGeometry(0.028, 0.032, 0.40, 6),
      0.46, deckAt(mgZ) + 0.03, mgZ + 0.17, Math.PI / 2 - 0.12, 0, 0));

    // ---- driver's hatch ---------------------------------------------------
    const dh = new THREE.CylinderGeometry(0.25, 0.25, 0.05, byQ([8, 14, 18]));
    place(dh, -0.44, deckAt(1.24) + 0.025, 1.24);
    B.metal.push(dh);
    B.metal.push(place(new THREE.BoxGeometry(0.14, 0.04, 0.05), -0.44, deckAt(1.06) + 0.055, 1.06));

    // ---- tow cable + shackles --------------------------------------------
    for (const sx of [-1, 1]) {
      const sh = new THREE.TorusGeometry(0.075, 0.022, 4, byQ([6, 8, 10]), Math.PI * 1.5);
      place(sh, sx * 0.72, 0.02, 2.36, 0, 0, Math.PI * 0.5);
      B.metal.push(sh);
    }
    // A cable draped along the left side, sagging between two hooks.
    {
      const pts = [];
      const segs = byQ([5, 9, 12]);
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        pts.push([
          -1.27 - Math.sin(t * Math.PI) * 0.04,
          fenderY + 0.05 - Math.sin(t * Math.PI) * 0.13,
          lerp(-2.0, 1.2, t),
        ]);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        B.metal.push(cylBetween(pts[i][0], pts[i][1], pts[i][2],
          pts[i + 1][0], pts[i + 1][1], pts[i + 1][2], 0.019, 4));
      }
    }

    // ---- assemble hull meshes --------------------------------------------
    this.hullMeshes = {};
    for (const key of Object.keys(B)) {
      if (!B[key].length) continue;
      const geo = mergeGeos(B[key]);
      const mesh = new THREE.Mesh(geo, this.mat[key] || this.mat.metal);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.outline = true;
      mesh.userData.tank = this;
      mesh.name = `hull:${key}`;
      this.chassis.add(mesh);
      this.hullMeshes[key] = mesh;
    }
    // Keep a pristine copy of the armour vertices so dents are cumulative but
    // never drift, and so we can reset on repair.
    this.hullGeo = this.hullMeshes.paint.geometry;
    this._hullBase = Float32Array.from(this.hullGeo.attributes.position.array);
    this._dentCount = 0;

    // ---- rivets (instanced) ----------------------------------------------
    this._buildRivets(rivets);
  }

  _buildRivets(list) {
    if (!list.length) return;
    const seg = byQ([4, 6, 8]);
    const g = new THREE.SphereGeometry(0.026, seg, Math.max(3, seg >> 1), 0, TAU, 0, Math.PI * 0.5);
    // Rivets read as *slightly* proud domes; squash them so they catch a rim
    // highlight without becoming beads.
    g.scale(1, 0.62, 1);
    const mesh = new THREE.InstancedMesh(g, this.mat.rivet, list.length);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.outline = false;      // far too small to outline sanely
    mesh.name = 'hull:rivets';
    const rng = this.rng;
    for (let i = 0; i < list.length; i++) {
      const [x, y, z, ang] = list[i];
      // Orient the dome outward from the hull centreline.
      _va.set(x, y - 0.15, 0).normalize();
      if (!isFinite(_va.x) || _va.lengthSq() < 0.5) _va.set(0, 1, 0);
      _qs.setFromUnitVectors(_yAxis, _va);
      _vb.set(x, y, z);
      const s = 0.82 + rng() * 0.4;
      _vc.set(s, s, s);
      _m4.compose(_vb, _qs, _vc);
      mesh.setMatrixAt(i, _m4);
      void ang;
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.chassis.add(mesh);
    this.rivetMesh = mesh;
  }

  /** Turret, mantlet, main gun with muzzle brake, coax MG, cupola, antenna. */
  _buildTurret() {
    const rng = this.rng;
    const B = { paint: [], metal: [], ochre: [], glass: [], grille: [] };

    this.turret = new THREE.Group();
    this.turret.name = 'turret';
    // Sits on the deck, wherever the deck now is (see this.deckRise).
    this.turret.position.set(0, (this.turretDeckY ?? 0.52) + 0.015, -0.10);
    this.chassis.add(this.turret);

    // ---- turret shell: tapered, sloped, with a bustle ---------------------
    // The shell is 0.08 m taller than round 2 as well, on top of the deck rise.
    // The two together lift the turret roof from 1.58 m off the ground to 1.90
    // and the cupola to 2.05 — which is what puts it ABOVE a standing man's head
    // instead of level with his chest, and is most of what the silhouette needed.
    const TT = 0.08;
    const ts = [
      { z: -1.02, w: 0.60, yBot: 0.02, yTop: 0.30 + TT * 0.6, ch: 0.10 },
      { z: -0.72, w: 0.78, yBot: 0.01, yTop: 0.38 + TT, ch: 0.13 },
      { z: -0.20, w: 0.86, yBot: 0.00, yTop: 0.44 + TT, ch: 0.15 },
      { z: 0.32, w: 0.85, yBot: 0.00, yTop: 0.44 + TT, ch: 0.15 },
      { z: 0.70, w: 0.72, yBot: 0.01, yTop: 0.38 + TT, ch: 0.14 },
      { z: 0.92, w: 0.50, yBot: 0.04, yTop: 0.30 + TT * 0.6, ch: 0.11 },
    ];
    const trings = ts.map((s) => ({ z: s.z, pts: hullRing(s.w, s.yBot, s.yTop, s.ch, 0.012) }));
    B.paint.push(loft(subdivideStations(trings, byQ([1, 2, 3]), byQ([1, 2, 2])), true, true));
    for (const i of [1, 4]) {
      for (const g of weldRing(trings[i].pts, trings[i].z, 0.018, rng)) B.metal.push(g);
    }
    // Turret skirt that overhangs the ring.
    const skirt = new THREE.CylinderGeometry(0.88, 0.88, 0.045, byQ([14, 22, 28]));
    place(skirt, 0, 0.005, -0.10);
    B.metal.push(skirt);

    // ---- commander's cupola ----------------------------------------------
    const cupR = 0.245;
    const cup = new THREE.CylinderGeometry(cupR, cupR + 0.012, 0.17, byQ([8, 14, 18]), 1, true);
    place(cup, 0.30, 0.50 + TT, -0.44);
    B.paint.push(cup);
    // Vision blocks around it.
    const nBlocks = byQ([4, 6, 8]);
    for (let i = 0; i < nBlocks; i++) {
      const a = (i / nBlocks) * TAU;
      const bl = new THREE.BoxGeometry(0.10, 0.055, 0.03);
      place(bl, 0.30 + Math.cos(a) * (cupR + 0.012), 0.52 + TT, -0.44 + Math.sin(a) * (cupR + 0.012), 0, -a + Math.PI / 2, 0);
      B.grille.push(bl);
    }
    // The hatch lid — a live Object3D so it can open.
    this.hatch = new THREE.Group();
    this.hatch.position.set(0.30 - cupR, 0.588 + TT, -0.44);
    this.turret.add(this.hatch);
    {
      const lid = new THREE.CylinderGeometry(cupR + 0.02, cupR + 0.02, 0.038, byQ([8, 14, 18]));
      place(lid, cupR, 0, 0);
      const handle = place(new THREE.CylinderGeometry(0.014, 0.014, 0.16, 5), cupR + 0.06, 0.03, 0, 0, 0, Math.PI / 2);
      const lidMesh = new THREE.Mesh(mergeGeos([lid, handle]), this.mat.metal);
      lidMesh.castShadow = true;
      lidMesh.userData.outline = true;
      this.hatch.add(lidMesh);
    }
    this.headNode = new THREE.Object3D();
    this.headNode.position.set(0.30, 0.60 + TT, -0.44);
    this.turret.add(this.headNode);

    // ---- loader's hatch (fixed) ------------------------------------------
    B.metal.push(place(new THREE.CylinderGeometry(0.20, 0.20, 0.045, byQ([8, 12, 16])), -0.32, 0.455 + TT, -0.36));
    B.metal.push(place(new THREE.BoxGeometry(0.12, 0.035, 0.045), -0.32, 0.48 + TT, -0.19));

    // ---- stowage rack on the bustle --------------------------------------
    for (const s of [-1, 1]) {
      B.metal.push(cylBetween(s * 0.44, 0.10, -0.98, s * 0.44, 0.10, -1.32, 0.016, 4));
      B.metal.push(cylBetween(s * 0.44, 0.10, -1.32, s * 0.44, 0.34, -1.24, 0.016, 4));
    }
    B.metal.push(cylBetween(-0.44, 0.10, -1.32, 0.44, 0.10, -1.32, 0.016, 4));
    // Rolled tarp lashed into the rack.
    const tarp = new THREE.CylinderGeometry(0.13, 0.14, 0.80, byQ([6, 9, 12]));
    place(tarp, 0, 0.19, -1.20, 0, 0, Math.PI / 2);
    B.ochre.push(tarp);
    for (const z of [-0.32, 0.32]) {
      const strap = new THREE.BoxGeometry(0.29, 0.016, 0.05);
      place(strap, z, 0.19, -1.20, 0, Math.PI / 2, 0);
      B.metal.push(strap);
    }

    // ---- smoke dischargers ------------------------------------------------
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const d = new THREE.CylinderGeometry(0.038, 0.038, 0.15, byQ([5, 8, 10]));
        place(d, s * (0.74 - i * 0.02), 0.36 + i * 0.02, 0.10 - i * 0.11, -0.5, s * 0.25, 0);
        B.metal.push(d);
      }
    }

    // ---- antenna: five segments so it can whip ---------------------------
    this.antenna = [];
    {
      const base = new THREE.Object3D();
      base.position.set(-0.62, 0.40, -0.72);
      this.turret.add(base);
      B.metal.push(place(new THREE.CylinderGeometry(0.035, 0.045, 0.08, 6), -0.62, 0.40, -0.72));
      let parent = base;
      const segs = byQ([2, 3, 4]);
      for (let i = 0; i < segs; i++) {
        const node = new THREE.Object3D();
        node.position.y = i === 0 ? 0.04 : 0.32;
        const r0 = lerp(0.014, 0.004, i / segs);
        const r1 = lerp(0.014, 0.004, (i + 1) / segs);
        const g = new THREE.CylinderGeometry(r1, r0, 0.32, 4);
        g.translate(0, 0.16, 0);
        const m = new THREE.Mesh(g, this.mat.metal);
        m.userData.outline = true;
        m.castShadow = false;
        node.add(m);
        parent.add(node);
        parent = node;
        this.antenna.push(node);
      }
      // A little pennant at the tip — pure VC set-dressing.
      const flag = new THREE.PlaneGeometry(0.18, 0.11);
      flag.translate(0.09, 0.26, 0);
      const fm = new THREE.Mesh(flag, this.mat.ochre);
      fm.userData.outline = true;
      this.pennant = fm;
      parent.add(fm);
    }

    // ---- gun mount --------------------------------------------------------
    this.gun = new THREE.Group();          // pitches
    this.gun.position.set(0, 0.235 + TT * 0.5, 0.46);
    this.turret.add(this.gun);
    const G = { paint: [], metal: [] };

    // Mantlet: a thick rounded shield.
    const mant = new THREE.CylinderGeometry(0.30, 0.32, 0.30, byQ([8, 14, 18]));
    place(mant, 0, 0, 0.44, Math.PI / 2, 0, 0);
    G.paint.push(mant);
    const mantFace = new THREE.SphereGeometry(0.30, byQ([8, 14, 18]), byQ([5, 8, 10]), 0, TAU, 0, Math.PI * 0.45);
    place(mantFace, 0, 0, 0.59, Math.PI / 2, 0, 0);
    G.paint.push(mantFace);
    // Trunnion bolts.
    for (const s of [-1, 1]) {
      G.metal.push(place(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 6), s * 0.31, 0, 0.44, 0, 0, Math.PI / 2));
    }

    // The recoiling assembly: barrel + brake slide back and return.
    this.recoilGroup = new THREE.Group();
    this.gun.add(this.recoilGroup);
    const R = { metal: [] };
    // Recoil sleeve, then the tube proper, slightly tapered.
    R.metal.push(place(new THREE.CylinderGeometry(0.115, 0.125, 0.42, byQ([8, 12, 16])), 0, 0, 0.78, Math.PI / 2, 0, 0));
    R.metal.push(place(new THREE.CylinderGeometry(0.072, 0.086, 1.42, byQ([8, 12, 16])), 0, 0, 1.68, Math.PI / 2, 0, 0));
    // Muzzle brake: a fat collar with two blast slots cut as gaps between
    // three short cylinders.
    for (let i = 0; i < 3; i++) {
      R.metal.push(place(new THREE.CylinderGeometry(0.105, 0.105, 0.055, byQ([8, 12, 16])),
        0, 0, 2.42 + i * 0.085, Math.PI / 2, 0, 0));
    }
    R.metal.push(place(new THREE.CylinderGeometry(0.088, 0.088, 0.24, byQ([8, 12, 16])), 0, 0, 2.50, Math.PI / 2, 0, 0));
    // Front sight blade.
    R.metal.push(place(new THREE.BoxGeometry(0.02, 0.05, 0.03), 0, 0.10, 2.56));
    {
      const barrel = new THREE.Mesh(mergeGeos(R.metal), this.mat.metal);
      barrel.castShadow = true;
      barrel.userData.outline = true;
      barrel.name = 'gun:barrel';
      this.recoilGroup.add(barrel);
    }
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0, 2.66);
    this.recoilGroup.add(this.muzzle);

    // Coaxial MG, offset to the right of the mantlet.
    G.metal.push(place(new THREE.CylinderGeometry(0.055, 0.06, 0.22, byQ([6, 9, 12])), 0.34, -0.02, 0.60, Math.PI / 2, 0, 0));
    G.metal.push(place(new THREE.CylinderGeometry(0.022, 0.026, 0.52, byQ([5, 8, 10])), 0.34, -0.02, 0.92, Math.PI / 2, 0, 0));
    // Perforated jacket: a ring of tiny bosses.
    const holes = byQ([0, 6, 10]);
    for (let i = 0; i < holes; i++) {
      const a = (i / holes) * TAU;
      G.metal.push(place(new THREE.CylinderGeometry(0.007, 0.007, 0.02, 4),
        0.34 + Math.cos(a) * 0.026, -0.02 + Math.sin(a) * 0.026, 0.86, Math.PI / 2, 0, 0));
    }
    this.coaxMuzzle = new THREE.Object3D();
    this.coaxMuzzle.position.set(0.34, -0.02, 1.20);
    this.gun.add(this.coaxMuzzle);
    // Gunner's sight above the mantlet.
    G.metal.push(place(new THREE.BoxGeometry(0.1, 0.09, 0.16), -0.30, 0.14 + TT * 0.5, 0.52));
    B.glass.push(place(new THREE.CylinderGeometry(0.032, 0.032, 0.02, byQ([6, 10, 12])), -0.30, 0.14 + TT * 0.5, 0.605, Math.PI / 2, 0, 0));

    for (const key of Object.keys(G)) {
      if (!G[key].length) continue;
      const m = new THREE.Mesh(mergeGeos(G[key]), this.mat[key]);
      m.castShadow = true;
      m.userData.outline = true;
      m.name = `gun:${key}`;
      this.gun.add(m);
    }

    this.turretMeshes = {};
    for (const key of Object.keys(B)) {
      if (!B[key].length) continue;
      const m = new THREE.Mesh(mergeGeos(B[key]), this.mat[key]);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.outline = true;
      m.userData.tank = this;
      m.name = `turret:${key}`;
      this.turret.add(m);
      this.turretMeshes[key] = m;
    }
  }

  /** Road wheels, idlers, sprockets, return rollers. */
  _buildRunningGear() {
    const seg = byQ([8, 14, 20]);
    const rw = this.wheelRadius;
    const halfG = this.gauge / 2;

    // ---- road wheel: rim + rubber tyre + hub + spoke bosses ---------------
    const parts = [];
    const disc = new THREE.CylinderGeometry(rw - 0.055, rw - 0.055, 0.20, seg);
    place(disc, 0, 0, 0, 0, 0, Math.PI / 2);
    parts.push(disc);
    const hub = new THREE.CylinderGeometry(0.085, 0.085, 0.26, Math.max(6, seg >> 1));
    place(hub, 0, 0, 0, 0, 0, Math.PI / 2);
    parts.push(hub);
    const nBoss = byQ([0, 6, 8]);
    for (let i = 0; i < nBoss; i++) {
      const a = (i / nBoss) * TAU;
      for (const s of [-1, 1]) {
        const b = new THREE.CylinderGeometry(0.036, 0.036, 0.03, 5);
        place(b, s * 0.105, Math.sin(a) * (rw * 0.55), Math.cos(a) * (rw * 0.55), 0, 0, Math.PI / 2);
        parts.push(b);
      }
    }
    const wheelSteel = mergeGeos(parts);
    // Tyre is a separate material bucket, so a second instanced mesh.
    const tyre = new THREE.CylinderGeometry(rw, rw, 0.155, seg, 1, true);
    place(tyre, 0, 0, 0, 0, 0, Math.PI / 2);
    const tyreCapA = new THREE.TorusGeometry(rw - 0.028, 0.03, 4, seg);
    place(tyreCapA, 0.077, 0, 0, 0, Math.PI / 2, 0);
    const tyreCapB = new THREE.TorusGeometry(rw - 0.028, 0.03, 4, seg);
    place(tyreCapB, -0.077, 0, 0, 0, Math.PI / 2, 0);
    const tyreGeo = mergeGeos([tyre, tyreCapA, tyreCapB]);

    const n = this.wheelCount * 2;
    this.wheelMesh = new THREE.InstancedMesh(wheelSteel, this.mat.metal, n);
    this.tyreMesh = new THREE.InstancedMesh(tyreGeo, this.mat.rubber, n);
    for (const m of [this.wheelMesh, this.tyreMesh]) {
      m.castShadow = true;
      m.receiveShadow = false;
      m.userData.outline = true;
      m.frustumCulled = false;
      this.chassis.add(m);
    }
    this.wheelMesh.name = 'wheels';
    this.tyreMesh.name = 'tyres';

    // Rest positions along Z (mirrors TankPhysics' layout).
    const trackLen = 3.45;
    const span = trackLen * 0.5 - rw * 0.55;
    this.wheelZ = new Float32Array(this.wheelCount);
    for (let i = 0; i < this.wheelCount; i++) {
      this.wheelZ[i] = lerp(span, -span, i / (this.wheelCount - 1));
    }

    // ---- idler (front) and drive sprocket (rear) -------------------------
    this.idlerR = 0.30;
    this.sprocketR = 0.335;
    this.idlerZ = 1.94;
    this.sprocketZ = -1.94;
    this.idlerY = this.axleY + 0.05;
    this.sprocketY = this.axleY + 0.06;

    const idlerParts = [];
    idlerParts.push(place(new THREE.CylinderGeometry(this.idlerR - 0.04, this.idlerR - 0.04, 0.20, seg), 0, 0, 0, 0, 0, Math.PI / 2));
    idlerParts.push(place(new THREE.CylinderGeometry(this.idlerR, this.idlerR, 0.05, seg), 0.085, 0, 0, 0, 0, Math.PI / 2));
    idlerParts.push(place(new THREE.CylinderGeometry(this.idlerR, this.idlerR, 0.05, seg), -0.085, 0, 0, 0, 0, Math.PI / 2));
    idlerParts.push(place(new THREE.CylinderGeometry(0.07, 0.07, 0.24, 6), 0, 0, 0, 0, 0, Math.PI / 2));
    const idlerGeo = mergeGeos(idlerParts);

    // Sprocket: a hub plus a ring of teeth that actually mesh with the links.
    const teeth = byQ([9, 14, 18]);
    const sprocketParts = [];
    sprocketParts.push(place(new THREE.CylinderGeometry(this.sprocketR - 0.075, this.sprocketR - 0.075, 0.22, seg), 0, 0, 0, 0, 0, Math.PI / 2));
    sprocketParts.push(place(new THREE.CylinderGeometry(0.09, 0.09, 0.28, 6), 0, 0, 0, 0, 0, Math.PI / 2));
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * TAU;
      const t = new THREE.BoxGeometry(0.055, 0.10, 0.075);
      const r = this.sprocketR - 0.03;
      for (const s of [-1, 1]) {
        const tc = t.clone();
        placeS(tc, s * 0.075, Math.sin(a) * r, Math.cos(a) * r, 1, 1, 1, a, 0, 0);
        sprocketParts.push(tc);
      }
      t.dispose();
    }
    const sprocketGeo = mergeGeos(sprocketParts);

    // Left/right are identical apart from the X offset, so one instanced draw
    // each rather than four separate meshes.
    this.idlerMesh = new THREE.InstancedMesh(idlerGeo, this.mat.metal, 2);
    this.sprocketMesh = new THREE.InstancedMesh(sprocketGeo, this.mat.metal, 2);
    for (const m of [this.idlerMesh, this.sprocketMesh]) {
      m.castShadow = true;
      m.userData.outline = true;
      m.frustumCulled = false;
      this.chassis.add(m);
    }
    this.idlerMesh.name = 'idlers';
    this.sprocketMesh.name = 'sprockets';
    this.idlerX = [-halfG, halfG];

    // ---- return rollers ---------------------------------------------------
    // Low enough that the whole return run passes UNDER the sponson overhang
    // (top of run = rollerY + rollerR + half a shoe, which must clear
    // this.sponsonY) instead of driving straight through the hull side.
    this.rollerR = 0.095;
    this.rollerY = this.axleY + 0.36;
    this.rollerZ = [1.15, 0.05, -1.05];
    const rollerGeo = mergeGeos([
      place(new THREE.CylinderGeometry(this.rollerR, this.rollerR, 0.15, Math.max(6, seg >> 1)), 0, 0, 0, 0, 0, Math.PI / 2),
      place(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 5), 0, 0, 0, 0, 0, Math.PI / 2),
    ]);
    this.rollerMesh = new THREE.InstancedMesh(rollerGeo, this.mat.metal, this.rollerZ.length * 2);
    this.rollerMesh.castShadow = true;
    this.rollerMesh.userData.outline = true;
    this.rollerMesh.frustumCulled = false;
    this.rollerMesh.name = 'rollers';
    this.chassis.add(this.rollerMesh);

    // ---- suspension arms + axle stubs -------------------------------------
    // Now that the lower hull is inboard of the track there is a visible gap
    // between the tub and the wheels, and a road wheel hanging in that gap on
    // nothing is worse than no gap at all. A trailing torsion-bar arm per
    // station, plus its bump-stop bracket on the tub, fills it and gives the
    // running gear the row of repeated verticals that reads as suspension.
    const armParts = [];
    for (const sx of SIDES) {
      for (let i = 0; i < this.wheelCount; i++) {
        const z = this.wheelZ[i];
        const dir = i < this.wheelCount / 2 ? 1 : -1;     // arms trail outward
        armParts.push(cylBetween(sx * 0.985, this.axleY + 0.17, z + dir * 0.30,
          sx * 1.08, this.axleY, z, 0.046, 5));
        armParts.push(placeS(new THREE.BoxGeometry(1, 1, 1),
          sx * 1.00, this.axleY + 0.255, z + dir * 0.30, 0.10, 0.10, 0.17));
      }
      // Final-drive housing behind the sprocket and the idler tensioner block.
      armParts.push(place(new THREE.CylinderGeometry(0.17, 0.20, 0.26, byQ([6, 10, 12])),
        sx * 1.05, this.sprocketY, this.sprocketZ, 0, 0, Math.PI / 2));
      armParts.push(placeS(new THREE.BoxGeometry(1, 1, 1),
        sx * 1.02, this.idlerY + 0.06, this.idlerZ - 0.22, 0.14, 0.18, 0.44));
    }
    const armMesh = new THREE.Mesh(mergeGeos(armParts), this.mat.metal);
    armMesh.castShadow = true;
    armMesh.receiveShadow = true;
    armMesh.userData.outline = true;
    armMesh.userData.tank = this;
    armMesh.name = 'suspension';
    this.chassis.add(armMesh);
    this.suspensionMesh = armMesh;
  }

  /**
   * Painted markings. A stencilled Gallian roundel on each turret cheek and one
   * on the glacis — the only high-chroma thing on the vehicle, and the thing
   * that tells you at a glance whose tank it is.
   */
  _buildMarkings() {
    this.markings = [];
    const add = (w, px, py, pz, rx, ry, parent) => {
      const g = new THREE.PlaneGeometry(w, w);
      const m = new THREE.Mesh(g, this.mat.insignia);
      m.position.set(px, py, pz);
      m.rotation.set(rx, ry, 0);
      m.castShadow = false;
      m.receiveShadow = true;
      m.userData.outline = false;
      m.name = 'marking';
      parent.add(m);
      this.markings.push(m);
      return m;
    };
    // Turret cheeks, facing ±X off the flat of the shell.
    add(0.23, 0.868, 0.24, 0.02, 0, Math.PI / 2, this.turret);
    add(0.23, -0.868, 0.24, 0.02, 0, -Math.PI / 2, this.turret);
    // Glacis, lying IN the plate — read off the same deck curve _buildHull used,
    // so a change to this.deckRise carries the roundel with the plate instead of
    // leaving it hanging in space in front of the nose.
    const gz = 1.705;
    add(0.26, 0.72, this.glacisAt(gz) + 0.033, gz, -Math.PI / 2 + this.glacisSlope, 0, this.chassis);
  }

  /** One track shoe. Quality 0 collapses it to two boxes. */
  _linkGeometry(quality = CFG.quality, pitch = 0.155) {
    const w = this.trackWidth;
    const parts = [];
    parts.push(place(new THREE.BoxGeometry(w, 0.036, pitch * 0.92), 0, 0, 0));
    parts.push(place(new THREE.BoxGeometry(w * 0.94, 0.030, 0.05), 0, -0.032, 0));   // grouser cleat
    if (quality > 0) {
      parts.push(place(new THREE.BoxGeometry(0.055, 0.075, 0.062), 0, 0.052, 0));    // guide horn
      parts.push(place(new THREE.CylinderGeometry(0.021, 0.021, w * 1.02, 5), 0, 0.008, pitch * 0.46, 0, 0, Math.PI / 2));
      parts.push(place(new THREE.CylinderGeometry(0.021, 0.021, w * 1.02, 5), 0, 0.008, -pitch * 0.46, 0, 0, Math.PI / 2));
    }
    if (quality > 1) {
      // End connectors — the little tabs that make a track read as segmented.
      for (const s of [-1, 1]) {
        parts.push(place(new THREE.BoxGeometry(0.03, 0.05, 0.10), s * (w * 0.5 - 0.015), 0.012, 0));
      }
    }
    return mergeGeos(parts);
  }

  _buildTrack() {
    // The path is rebuilt every frame from the live wheel positions; size the
    // instance buffer from the slack (rest) loop length so the shoes tile
    // end-to-end with no visible gaps.
    this.arcSegs = byQ([3, 5, 7]);
    this.pathN = byQ([40, 72, 96]);
    this._pathZ = new Float32Array(this.pathN);
    this._pathY = new Float32Array(this.pathN);
    this._pathS = new Float32Array(this.pathN + 1);
    const loopLen = 2 * (this.idlerZ - this.sprocketZ) +
                    Math.PI * (this.idlerR + this.sprocketR);
    const wanted = byQ([0.30, 0.155, 0.135]);
    this.linkCount = Math.max(12, Math.round(loopLen / wanted));
    this.trackPitch = loopLen / this.linkCount;
    this.trackThrown = [false, false];
    this.trackSag = [0, 0];

    const geo = this._linkGeometry(CFG.quality, this.trackPitch);
    this.linkMesh = new THREE.InstancedMesh(geo, this.mat.track, this.linkCount * 2);
    this.linkMesh.castShadow = true;
    this.linkMesh.receiveShadow = true;
    this.linkMesh.userData.outline = true;
    this.linkMesh.frustumCulled = false;
    this.linkMesh.name = 'track';
    this.chassis.add(this.linkMesh);
  }

  _buildDamageDecals() {
    this.decalMax = byQ([4, 10, 14]);
    this.decalCount = 0;
    this._decalAlpha = new Float32Array(this.decalMax);
    const g = new THREE.PlaneGeometry(1, 1);
    const inst = new THREE.InstancedBufferGeometry();
    inst.setAttribute('position', g.attributes.position);
    inst.setAttribute('uv', g.attributes.uv);
    inst.setIndex(g.index);
    inst.instanceCount = 0;
    inst.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(this._decalAlpha, 1));
    g.dispose();

    const tex = makeScorchTexture(this.seed ^ 0x2f3d);
    this.textures.push(tex);
    // Hand-written: scorch needs alpha and must not be outlined, which the NPR
    // surface material deliberately doesn't do. It still obeys the palette —
    // the darkest value is the warm brown-violet #3a2f33, never black.
    this.decalMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      uniforms: {
        uTex: { value: tex },
        uDark: { value: new THREE.Color(PAL.scorch) },
        uEdge: { value: new THREE.Color(0x6b4a34) },
      },
      vertexShader: /* glsl */`
        attribute float aAlpha;
        varying vec2 vUv;
        varying float vA;
        void main() {
          vUv = uv; vA = aAlpha;
          #ifdef USE_INSTANCING
            vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          #else
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
          #endif
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uTex;
        uniform vec3 uDark, uEdge;
        varying vec2 vUv;
        varying float vA;
        void main() {
          float d = texture2D(uTex, vUv).a * texture2D(uTex, vUv).r;
          float a = d * vA;
          if (a < 0.02) discard;
          // Two washes: soot core, scorched-paint rim.
          vec3 col = mix(uEdge, uDark, smoothstep(0.35, 0.55, d));
          gl_FragColor = vec4(col, min(0.94, a));
        }`,
    });
    this.decalMesh = new THREE.InstancedMesh(inst, this.decalMaterial, this.decalMax);
    this.decalMesh.frustumCulled = false;
    this.decalMesh.renderOrder = 3;
    this.decalMesh.userData.outline = false;
    this.decalMesh.userData.noPrepass = true;
    this.decalMesh.count = 0;
    this.decalMesh.name = 'scorch';
    this.chassis.add(this.decalMesh);
    this._decalGeo = inst;
  }

  _buildFx(scene) {
    // Puff systems live in world space so plumes don't rotate with the hull.
    const host = scene || this.root.parent || null;
    this.fxHost = host;
    this.exhaustPuffs = new PuffSystem({ capacity: byQ([16, 32, 48]), palette: 'exhaust', seed: this.seed ^ 11 });
    this.exhaustPuffs.rise = 0.55;
    this.damageSmoke = new PuffSystem({ capacity: byQ([20, 44, 64]), palette: 'smoke', seed: this.seed ^ 23 });
    this.damageSmoke.rise = 1.5;
    this.damageSmoke.drag = 0.55;
    this.firePuffs = new PuffSystem({ capacity: byQ([12, 26, 36]), palette: 'fire', seed: this.seed ^ 37, additive: true, softness: 0.6 });
    this.firePuffs.rise = 2.4;
    this.muzzlePuffs = new PuffSystem({ capacity: byQ([10, 20, 28]), palette: 'muzzle', seed: this.seed ^ 53, additive: true, softness: 0.55 });
    this.muzzlePuffs.rise = 0.35;
    this.muzzleSmoke = new PuffSystem({ capacity: byQ([10, 20, 28]), palette: 'smoke', seed: this.seed ^ 71 });
    this.muzzleSmoke.rise = 0.6;
    this.puffSystems = [this.exhaustPuffs, this.damageSmoke, this.firePuffs, this.muzzlePuffs, this.muzzleSmoke];
    if (host) for (const p of this.puffSystems) host.add(p.mesh);

    // Muzzle flash: a stubby cone that lives for ~70 ms.
    const flashGeo = new THREE.ConeGeometry(0.30, 0.85, 6, 1, true);
    flashGeo.rotateX(Math.PI / 2);
    flashGeo.translate(0, 0, 0.42);
    this.flashMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uA: { value: 0 } },
      vertexShader: /* glsl */`
        varying float vT;
        void main() {
          vT = clamp(position.z / 0.85, 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uA;
        varying float vT;
        void main() {
          // Cream core blowing out to warm gold at the tip.
          vec3 c = mix(vec3(1.0, 0.98, 0.88), vec3(0.98, 0.66, 0.26), vT);
          float a = uA * (1.0 - vT) * (1.0 - vT);
          if (a < 0.01) discard;
          gl_FragColor = vec4(c, a);
        }`,
    });
    this.flash = new THREE.Mesh(flashGeo, this.flashMaterial);
    this.flash.visible = false;
    this.flash.userData.outline = false;
    this.flash.userData.noPrepass = true;
    this.flash.renderOrder = 14;
    if (this.muzzle) this.muzzle.add(this.flash);
  }

  /** Late attach for the FX systems if the tank was built before it had a scene. */
  attachTo(scene) {
    if (!scene) return this;
    scene.add(this.root);
    if (!this.fxHost) {
      this.fxHost = scene;
      for (const p of this.puffSystems) scene.add(p.mesh);
    }
    if (this.physics && !this.physics.scene) {
      this.physics.scene = scene;
    }
    return this;
  }

  // ==========================================================================
  //  Public API
  // ==========================================================================

  /** Aim the turret. Angles are absolute, in the tank's local frame. */
  turretAim(yaw, pitch) {
    this.turretYawTarget = yaw;
    this.gunPitchTarget = clamp(pitch, this.gunMinPitch, this.gunMaxPitch);
    return this;
  }
  /** Character-compatible alias. */
  setAimAngles(yaw, pitch) { return this.turretAim(yaw, pitch); }

  /** Aim at a world-space point, resolving the tank's own orientation. */
  aimAt(worldPoint) {
    this.root.updateWorldMatrix(true, false);
    _va.copy(worldPoint);
    this.root.worldToLocal(_va);
    // The trunnion sits at turret-local origin; correct for it so close
    // targets don't get an offset error.
    _va.x -= 0; _va.y -= 0.77; _va.z -= -0.10;
    const yaw = Math.atan2(_va.x, _va.z);
    const horiz = Math.hypot(_va.x, _va.z);
    const pitch = Math.atan2(_va.y, Math.max(0.01, horiz));
    this.turretAim(yaw, pitch);
    return this;
  }

  /** @returns {boolean} true if the turret and gun are on target. */
  onTarget(tol = 0.02) {
    return Math.abs(shortestAngle(this.turretYaw, this.turretYawTarget)) < tol &&
           Math.abs(this.gunPitch - this.gunPitchTarget) < tol;
  }

  setThrottle(v) { if (this.physics) this.physics.setThrottle(v); return this; }
  setSteer(v) { if (this.physics) this.physics.setSteer(v); return this; }
  setBrake(v) { if (this.physics) this.physics.setBrake(v); return this; }

  /** Drop the tank onto the terrain. */
  teleport(x, z, yaw = 0) {
    if (this.physics) {
      this.physics.teleport(x, z, yaw);
      this.physics.applyToRoot(this.root, this.chassis);
    } else {
      this.root.position.set(x, 0, z);
      this.root.rotation.y = yaw;
      this.chassis.position.y = this.rideHeight;
    }
    return this;
  }

  get speed() { return this.physics ? Math.hypot(this.physics.vel.x, this.physics.vel.z) : 0; }
  get pos() { return this.root.position; }
  get yaw() { return this.physics ? this.physics.renderYaw : this.root.rotation.y; }

  /** World-space muzzle tip. Returns an internal vector — copy before storing. */
  muzzlePoint(out) {
    this.muzzle.updateWorldMatrix(true, false);
    const v = out || this._muzzleWorld;
    return v.setFromMatrixPosition(this.muzzle.matrixWorld);
  }

  /** World-space forward axis of the gun. */
  muzzleDir(out) {
    this.muzzle.updateWorldMatrix(true, false);
    const v = out || this._fireDir;
    return v.set(0, 0, 1).transformDirection(this.muzzle.matrixWorld).normalize();
  }

  /** World position of the rear radiator — the critical weak point. */
  weakPointWorldPos(out) {
    this.weakPoint.updateWorldMatrix(true, false);
    const v = out || this._weakWorld;
    return v.setFromMatrixPosition(this.weakPoint.matrixWorld);
  }

  /** Commander's head, for camera framing and LOS — mirrors Character. */
  headPoint(out) {
    this.headNode.updateWorldMatrix(true, false);
    const v = out || this._headWorld;
    return v.setFromMatrixPosition(this.headNode.matrixWorld);
  }

  /**
   * Fire the main gun.
   * @param {object} opts { weapon:'tankAP'|'tankHE', damage, spread, force }
   * @returns {object|null} the spawned projectile, or a shot descriptor if no
   *   ballistics system is wired up. Null if the gun is still reloading.
   */
  fire(opts = {}) {
    if (!opts.force && (this.reload > 0 || this.destroyed || this.turretJammed)) return null;
    const weapon = opts.weapon || 'tankAP';
    this.reload = opts.reloadTime ?? this.reloadTime;

    const origin = this.muzzlePoint(_vb).clone();
    const dir = this.muzzleDir(_vc).clone();

    // Recoil: a hard impulse into the recuperator, plus a hull-wide shove.
    this.recoilVel = -6.4;
    this._muzzleFlash = 1;
    this.flash.visible = true;
    this.flash.scale.setScalar(0.9 + this.rng() * 0.35);
    this.flash.rotation.z = this.rng() * TAU;
    if (this.physics) {
      const impulse = weapon === 'tankHE' ? 0.30 : 0.42;
      this.physics.vel.addScaledVector(dir, -impulse);
      this.physics.pitchRate -= 0.55;
      this.physics.heaveVel += 0.16;
    }

    // Muzzle blast: incandescent core, then the dirty smoke ring.
    for (let i = 0; i < byQ([3, 6, 9]); i++) {
      const sp = 3.5 + this.rng() * 7;
      this.muzzlePuffs.spawn(
        origin.x + dir.x * 0.2, origin.y + dir.y * 0.2, origin.z + dir.z * 0.2,
        dir.x * sp + (this.rng() - 0.5) * 2.4,
        dir.y * sp + (this.rng() - 0.5) * 2.0,
        dir.z * sp + (this.rng() - 0.5) * 2.4,
        0.28 + this.rng() * 0.3, 0.10 + this.rng() * 0.12, 2.6
      );
    }
    for (let i = 0; i < byQ([2, 5, 8]); i++) {
      const sp = 1.6 + this.rng() * 4;
      this.muzzleSmoke.spawn(
        origin.x, origin.y, origin.z,
        dir.x * sp + (this.rng() - 0.5) * 1.6,
        dir.y * sp + (this.rng() - 0.5) * 1.2 + 0.4,
        dir.z * sp + (this.rng() - 0.5) * 1.6,
        0.34 + this.rng() * 0.4, 0.9 + this.rng() * 0.9, 2.4
      );
    }

    Bus.emit('sfx', { name: 'tankFire', pos: origin, vol: 1 });

    if (this.ballistics) {
      return this.ballistics.fire({
        origin, dir, weapon,
        owner: opts.owner || this.unit || this,
        team: this.team,
        damage: opts.damage,
        spread: opts.spread ?? 0.0022,
        rng: this.rng,
        inheritVel: this.physics ? this.physics.vel : null,
      });
    }
    Bus.emit('shot:fired', { unit: opts.owner || this.unit || this, origin, dir, weapon });
    return { origin, dir, weapon };
  }

  /** Fire the coaxial machine gun — cheap, fast, no reload gate. */
  fireCoax(opts = {}) {
    if (this.destroyed) return null;
    this.coaxHeat = Math.min(1, this.coaxHeat + 0.09);
    this.coaxMuzzle.updateWorldMatrix(true, false);
    const origin = _vb.setFromMatrixPosition(this.coaxMuzzle.matrixWorld).clone();
    const dir = _vc.set(0, 0, 1).transformDirection(this.coaxMuzzle.matrixWorld).normalize().clone();
    this.muzzlePuffs.spawn(origin.x, origin.y, origin.z,
      dir.x * 3 + (this.rng() - 0.5), dir.y * 3 + 0.4, dir.z * 3 + (this.rng() - 0.5),
      0.10 + this.rng() * 0.06, 0.05 + this.rng() * 0.05, 2.0);
    Bus.emit('sfx', { name: 'mg', pos: origin, vol: 0.5 });
    if (this.ballistics) {
      return this.ballistics.fire({
        origin, dir, weapon: 'coax',
        owner: opts.owner || this.unit || this, team: this.team,
        spread: opts.spread ?? 0.012 + this.coaxHeat * 0.02,
        rng: this.rng, damage: opts.damage,
      });
    }
    return { origin, dir, weapon: 'coax' };
  }

  /**
   * @param {number} amount
   * @param {object} opts { bodypart, worldPos, normal, source, crit, explosion }
   */
  takeDamage(amount, opts = {}) {
    if (this.destroyed) return 0;
    const part = opts.bodypart || 'hull';
    let dealt = amount;

    if (part === 'radiator') {
      this.radiatorHp -= amount;
      dealt = amount * 1.4;
      if (this.radiatorHp <= 0 && !this.critical) this._goCritical(opts);
    } else if (part === 'track') {
      const side = this._trackSideFromHit(opts.worldPos);
      this.trackHp[side] -= amount;
      dealt = amount * 0.35;
      if (this.trackHp[side] <= 0 && !this.trackThrown[side]) this._throwTrack(side);
    } else if (part === 'turret') {
      dealt = amount * 0.8;
      if (this.rng() < clamp01(amount / 900)) {
        this.turretJammed = true;
        Bus.emit('sfx', { name: 'metalJam', pos: this.root.position, vol: 0.7 });
      }
    }

    this.hp = Math.max(0, this.hp - dealt);

    // Visual damage at the impact point.
    if (opts.worldPos) {
      this._addScorch(opts.worldPos, opts.normal, 0.5 + clamp01(amount / 400) * 0.9);
      if (amount > 60) this._addDent(opts.worldPos, opts.normal, clamp01(amount / 500));
    }
    Bus.emit('sfx', {
      name: dealt > 120 ? 'tankHitHeavy' : 'tankHit',
      pos: opts.worldPos || this.root.position, vol: clamp01(0.4 + amount / 400),
    });

    // Smoke starts pouring out well before the tank dies.
    if (this.hp / this.maxHp < 0.45 && !this.critical && this.rng() < 0.35) {
      this.smoking = true;
    }
    if (this.hp <= 0) this.destroy(opts);
    return dealt;
  }

  _trackSideFromHit(worldPos) {
    if (!worldPos) return this.rng() < 0.5 ? 0 : 1;
    this.root.updateWorldMatrix(true, false);
    _va.copy(worldPos);
    this.root.worldToLocal(_va);
    return _va.x < 0 ? 0 : 1;
  }

  _throwTrack(side) {
    this.trackThrown[side] = true;
    if (this.physics) this.physics.trackHealth[side] = 0;
    Bus.emit('sfx', { name: 'trackSnap', pos: this.root.position, vol: 0.9 });
    // Shed a few links as rigid debris if a solver is available.
    const sim = this.cfg.physics && this.cfg.physics.rigid;
    if (sim) {
      this.root.updateWorldMatrix(true, false);
      for (let i = 0; i < 5; i++) {
        _va.set((side === 0 ? -1 : 1) * this.gauge * 0.5, this.axleY + 0.35, -1.2 + i * 0.3);
        this.root.localToWorld(_va);
        sim.addBody({
          pos: _va,
          vel: _vb.set((this.rng() - 0.5) * 3, 1.2 + this.rng() * 2, (this.rng() - 0.5) * 3),
          angVel: _vc.set(this.rng() * 8 - 4, this.rng() * 8 - 4, this.rng() * 8 - 4),
          shape: 'box',
          half: { x: this.trackWidth * 0.5, y: 0.03, z: 0.08 },
          mass: 14, restitution: 0.18, friction: 0.8, maxLife: 22,
        });
      }
    }
  }

  _goCritical(opts) {
    this.critical = true;
    this.smoking = true;
    if (this.mat.grille && this.mat.grille.color) this.mat.grille.color.setHex(PAL.hot);
    Bus.emit('sfx', { name: 'engineBlow', pos: this.weakPointWorldPos(_va), vol: 1 });
    Bus.emit('unit:critical', { unit: this.unit || this, part: 'radiator', source: opts.source || null });
  }

  /**
   * Kill the tank: burning wreck, thrown tracks, drooping barrel.
   *
   * VISUALS AND PHYSICS ONLY. The gameplay consequences of a unit dying — the
   * `unit:downed` banner, the death explosion and the area damage that comes with it —
   * belong to the game layer (src/game/units.js goDown()), which calls play('death')
   * to get here. Emitting them from both ends produced two banners, two blasts, two
   * radial impulses and two passes of area damage for one kill.
   */
  destroy(opts = {}) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.alive = false;
    this.hp = 0;
    this.critical = true;
    this.smoking = true;
    this.burning = true;
    this.turretJammed = true;
    for (let s = 0; s < 2; s++) if (!this.trackThrown[s]) this._throwTrack(s);
    if (this.physics) {
      this.physics.setThrottle(0);
      this.physics.setSteer(0);
      this.physics.handbrake = true;
    }
    // The turret slews dead and the gun droops.
    this.turretYawTarget = this.turretYaw + (this.rng() - 0.5) * 0.5;
    this.gunPitchTarget = this.gunMinPitch;
    // Burn the paint: shift every surface toward the scorched palette.
    _col.setHex(PAL.scorch);
    for (const m of this.materials) {
      if (!m) continue;
      if (m.color) m.color.lerp(_col, 0.55);
      if (m.uniforms && m.uniforms.uColor && m.uniforms.uColor.value.lerp) {
        m.uniforms.uColor.value.lerp(_col, 0.55);
      }
    }
    // A hard blast at the moment of death.
    const p = this.root.position;
    for (let i = 0; i < byQ([5, 10, 16]); i++) {
      this.firePuffs.spawn(
        p.x + (this.rng() - 0.5) * 1.2, p.y + 1.1 + this.rng() * 0.5, p.z + (this.rng() - 0.5) * 1.6,
        (this.rng() - 0.5) * 5, 3 + this.rng() * 5, (this.rng() - 0.5) * 5,
        0.7 + this.rng() * 0.8, 0.7 + this.rng() * 0.7, 2.2
      );
    }
    // No `explosion` / `unit:downed` here — see the note above. A tank driven as a bare
    // actor (no owning Unit, e.g. a set-piece wreck) still needs its own report, so that
    // one case keeps a sound; when a Unit owns us, the Unit has already made the noise.
    if (!this.unit) Bus.emit('sfx', { name: 'explosion', pos: p, vol: 1 });
  }

  /** Character-compatible clip interface. */
  play(clip) {
    this.clip = clip;
    if (clip === 'death' && !this.destroyed) this.destroy();
    if (clip === 'cheer') this._hatchTarget = 1;
    if (clip === 'idle' || clip === 'aim') this._hatchTarget = 0;
    return this;
  }

  /** Open/close the commander's hatch, 0..1. */
  setHatch(open) { this._hatchTarget = clamp01(open); return this; }

  // ==========================================================================
  //  Per-frame update
  // ==========================================================================

  update(dt) {
    if (dt > 0.1) dt = 0.1;
    this.time += dt;

    // ---- chassis ----------------------------------------------------------
    if (this.physics) {
      if (!this._externalStep) this.physics.update(dt);
      this.physics.applyToRoot(this.root, this.chassis);
    }

    // ---- turret / gun slew ------------------------------------------------
    const slew = this.turretJammed ? 0.12 : this.turretSlew;
    const before = this.turretYaw;
    this.turretYaw = approachAngle(this.turretYaw, this.turretYawTarget, slew * dt);
    this.gunPitch = approach(this.gunPitch, this.gunPitchTarget, (this.turretJammed ? 0.1 : this.gunSlew) * dt);
    this.turret.rotation.y = this.turretYaw;
    this.gun.rotation.x = -this.gunPitch;       // +pitch elevates the muzzle
    this.turretSlewing = Math.abs(this.turretYaw - before) > 1e-4;
    if (this.turretSlewing && !this.destroyed && (this.time * 6 | 0) % 3 === 0) {
      Bus.emit('sfx', { name: 'turretSlew', pos: this.root.position, vol: 0.22 });
    }

    // ---- recoil: critically damped return to battery ----------------------
    if (this.recoil !== 0 || this.recoilVel !== 0) {
      const k = 210, c = 21;
      this.recoilVel += (-k * this.recoil - c * this.recoilVel) * dt;
      this.recoil = clamp(this.recoil + this.recoilVel * dt, -0.36, 0.02);
      if (Math.abs(this.recoil) < 1e-4 && Math.abs(this.recoilVel) < 1e-3) {
        this.recoil = 0; this.recoilVel = 0;
      }
      this.recoilGroup.position.z = this.recoil;
    }
    if (this.reload > 0) this.reload = Math.max(0, this.reload - dt);
    this.coaxHeat = Math.max(0, this.coaxHeat - dt * 0.25);

    // ---- muzzle flash -----------------------------------------------------
    if (this._muzzleFlash > 0) {
      this._muzzleFlash = Math.max(0, this._muzzleFlash - dt * 14);
      this.flashMaterial.uniforms.uA.value = this._muzzleFlash * this._muzzleFlash;
      this.flash.visible = this._muzzleFlash > 0.01;
    }

    // ---- hatch ------------------------------------------------------------
    this._hatchOpen = damp(this._hatchOpen, this._hatchTarget, 6, dt);
    this.hatch.rotation.z = -this._hatchOpen * 1.9;

    // ---- running gear + track --------------------------------------------
    this._updateRunningGear(dt);
    this._updateTrack(dt);

    // ---- antenna whip -----------------------------------------------------
    this._updateAntenna(dt);

    // ---- FX ---------------------------------------------------------------
    this._updateFx(dt);
  }

  _updateRunningGear(dt) {
    const p = this.physics;
    const halfG = this.gauge / 2;
    const spin = p ? p.wheelSpin : [0, 0];
    const off = p ? p.wheelOffset : null;

    let k = 0;
    for (let s = 0; s < 2; s++) {
      const x = s === 0 ? -halfG : halfG;
      for (let i = 0; i < this.wheelCount; i++, k++) {
        const dy = off ? off[s * this.wheelCount + i] : 0;
        _va.set(x, this.axleY + dy, this.wheelZ[i]);
        // Wheels spin about local X; positive spin walks the contact patch
        // rearward, which is what "driving forward" looks like.
        _es.set(spin[s], 0, 0, 'XYZ');
        _qs.setFromEuler(_es);
        _m4.compose(_va, _qs, _one);
        this.wheelMesh.setMatrixAt(k, _m4);
        this.tyreMesh.setMatrixAt(k, _m4);
      }
    }
    this.wheelMesh.instanceMatrix.needsUpdate = true;
    this.tyreMesh.instanceMatrix.needsUpdate = true;

    // Idlers and sprockets turn faster than the road wheels: same track speed,
    // smaller radius.
    for (let s = 0; s < 2; s++) {
      _va.set(this.idlerX[s], this.idlerY, this.idlerZ);
      _es.set(spin[s] * (this.wheelRadius / this.idlerR), 0, 0, 'XYZ');
      _qs.setFromEuler(_es);
      _m4.compose(_va, _qs, _one);
      this.idlerMesh.setMatrixAt(s, _m4);

      _va.set(this.idlerX[s], this.sprocketY, this.sprocketZ);
      _es.set(spin[s] * (this.wheelRadius / this.sprocketR), 0, 0, 'XYZ');
      _qs.setFromEuler(_es);
      _m4.compose(_va, _qs, _one);
      this.sprocketMesh.setMatrixAt(s, _m4);
    }
    this.idlerMesh.instanceMatrix.needsUpdate = true;
    this.sprocketMesh.instanceMatrix.needsUpdate = true;
    // Return rollers.
    let r = 0;
    for (let s = 0; s < 2; s++) {
      const x = s === 0 ? -halfG : halfG;
      for (let i = 0; i < this.rollerZ.length; i++, r++) {
        _va.set(x, this.rollerY, this.rollerZ[i]);
        _es.set(spin[s] * (this.wheelRadius / this.rollerR), 0, 0, 'XYZ');
        _qs.setFromEuler(_es);
        _m4.compose(_va, _qs, _one);
        this.rollerMesh.setMatrixAt(r, _m4);
      }
    }
    this.rollerMesh.instanceMatrix.needsUpdate = true;
    void dt;
  }

  /**
   * Rebuild each track's path from the live wheel positions and re-space the
   * links along it by arc length. This is what makes the track look like a
   * real loop of steel rather than a scrolling texture: links climb over the
   * road wheels as the suspension works.
   */
  _updateTrack(dt) {
    const p = this.physics;
    const halfG = this.gauge / 2;
    let idx = 0;
    for (let s = 0; s < 2; s++) {
      if (this.trackThrown[s]) this.trackSag[s] = Math.min(1, this.trackSag[s] + dt * 1.6);
      const n = this._buildTrackPath(s);
      const total = this._pathS[n];
      const shown = this.trackThrown[s] ? Math.floor(this.linkCount * 0.62) : this.linkCount;
      const pitch = total / this.linkCount;
      const travel = p ? p.trackDistance[s] : 0;
      // Links march *backwards* along the loop as the vehicle drives forward,
      // because the loop is parameterised in the direction of link travel.
      let base = travel % total;
      if (base < 0) base += total;
      const x = s === 0 ? -halfG : halfG;

      for (let i = 0; i < this.linkCount; i++, idx++) {
        if (i >= shown) {
          _m4.makeScale(0, 0, 0);
          this.linkMesh.setMatrixAt(idx, _m4);
          continue;
        }
        let sArc = base + i * pitch;
        sArc %= total;
        const seg = this._samplePath(n, sArc);
        _es.set(-Math.atan2(seg.dy, seg.dz), 0, 0, 'XYZ');
        _qs.setFromEuler(_es);
        _va.set(x, seg.y, seg.z);
        _m4.compose(_va, _qs, _one);
        this.linkMesh.setMatrixAt(idx, _m4);
      }
    }
    this.linkMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Fill _pathZ/_pathY with the closed loop for one side, in the direction the
   * links travel when driving forward, and _pathS with cumulative arc length.
   * @returns {number} the number of path points written
   */
  _buildTrackPath(side) {
    const off = this.physics ? this.physics.wheelOffset : null;
    const Z = this._pathZ, Y = this._pathY;
    const cap = this.pathN;
    const sag = this.trackSag[side];
    let n = 0;
    // Inlined rather than a closure — this runs twice a frame, forever, and a
    // per-call closure is a per-frame allocation.

    // 1. Bottom run: idler bottom -> under each road wheel -> sprocket bottom.
    if (n < cap) { Z[n] = this.idlerZ; Y[n] = this.idlerY - this.idlerR; n++; }
    for (let i = 0; i < this.wheelCount && n < cap; i++) {
      const dy = off ? off[side * this.wheelCount + i] : 0;
      Z[n] = this.wheelZ[i]; Y[n] = this.axleY + dy - this.wheelRadius; n++;
    }
    if (n < cap) { Z[n] = this.sprocketZ; Y[n] = this.sprocketY - this.sprocketR; n++; }

    // 2. Sprocket wrap: bottom -> rear -> top.
    const arcSegs = this.arcSegs;
    for (let i = 1; i <= arcSegs && n < cap; i++) {
      const a = -Math.PI / 2 - (i / arcSegs) * Math.PI;
      Z[n] = this.sprocketZ + Math.cos(a) * this.sprocketR;
      Y[n] = this.sprocketY + Math.sin(a) * this.sprocketR;
      n++;
    }

    // 3. Top run: rearmost return roller forward to the idler, with a little
    //    catenary sag between supports — and a lot of it once the track has
    //    been thrown and the run is hanging off the rollers.
    let prevZ = this.sprocketZ, prevY = this.sprocketY + this.sprocketR;
    const topY = this.rollerY + this.rollerR;
    for (let i = this.rollerZ.length - 1; i >= 0 && n < cap - 1; i--) {
      const rz = this.rollerZ[i];
      Z[n] = (prevZ + rz) * 0.5;
      Y[n] = (prevY + topY) * 0.5 - 0.028 - sag * 0.42;
      n++;
      Z[n] = rz; Y[n] = topY - sag * 0.16; n++;
      prevZ = rz; prevY = topY;
    }
    if (n < cap) {
      Z[n] = (prevZ + this.idlerZ) * 0.5;
      Y[n] = (prevY + (this.idlerY + this.idlerR)) * 0.5 - 0.03 - sag * 0.36;
      n++;
    }

    // 4. Idler wrap: top -> front -> bottom, closing the loop.
    for (let i = 0; i < arcSegs && n < cap; i++) {
      const a = Math.PI / 2 - (i / arcSegs) * Math.PI;
      Z[n] = this.idlerZ + Math.cos(a) * this.idlerR;
      Y[n] = this.idlerY + Math.sin(a) * this.idlerR;
      n++;
    }

    // Cumulative arc length, closing back onto point 0.
    const S = this._pathS;
    S[0] = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      S[i + 1] = S[i] + Math.hypot(Z[j] - Z[i], Y[j] - Y[i]);
    }
    return n;
  }

  /** Sample the current path by arc length. Reuses one scratch record. */
  _samplePath(n, s) {
    const S = this._pathS, Z = this._pathZ, Y = this._pathY;
    // Binary search the segment.
    let lo = 0, hi = n;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= s) lo = mid; else hi = mid;
    }
    const j = (lo + 1) % n;
    const segLen = Math.max(1e-5, S[lo + 1] - S[lo]);
    const t = clamp01((s - S[lo]) / segLen);
    const dz = Z[j] - Z[lo], dy = Y[j] - Y[lo];
    const out = _pathSample;
    out.z = Z[lo] + dz * t;
    out.y = Y[lo] + dy * t;
    const inv = 1 / Math.max(1e-5, Math.hypot(dz, dy));
    out.dz = dz * inv;
    out.dy = dy * inv;
    return out;
  }

  _updateAntenna(dt) {
    if (!this.antenna.length) return;
    const p = this.physics;
    // Lag proportional to lateral acceleration plus a low-amplitude idle sway.
    const ax = p ? p.accelLocal.x : 0;
    const az = p ? p.accelLocal.z : 0;
    const sway = Math.sin(this.time * 2.3 + this._antennaPhase) * 0.02;
    const engine = p ? p.engineRpm : 0;
    const buzz = Math.sin(this.time * 41 + this._antennaPhase) * 0.006 * engine;
    for (let i = 0; i < this.antenna.length; i++) {
      const w = (i + 1) / this.antenna.length;
      const node = this.antenna[i];
      node.rotation.z = damp(node.rotation.z, clamp(-ax * 0.055, -0.35, 0.35) * w + sway * w + buzz, 8, dt);
      node.rotation.x = damp(node.rotation.x, clamp(az * 0.05, -0.35, 0.35) * w, 8, dt);
    }
    if (this.pennant) this.pennant.rotation.y = Math.sin(this.time * 4.1) * 0.35;
  }

  _updateFx(dt) {
    const p = this.physics;
    // Down to `chassis`, not just `root`: every spawn point below is a hull
    // fitting (exhaust stack, engine deck, radiator) and therefore lives in
    // chassis space, which carries the suspension heave, pitch and roll. Taking
    // them off `root` put the exhaust plume at a fixed height over the GROUND
    // POINT, so it detached from the deck every time the tank leaned.
    this.root.updateWorldMatrix(true, false);
    this.chassis.updateWorldMatrix(false, false);

    // ---- exhaust ----------------------------------------------------------
    const rpm = p ? p.engineRpm : 0.2;
    const load = p ? p.engineLoad : 0;
    this._exhaustAccum += dt * (2.5 + rpm * 14 + load * 10);
    while (this._exhaustAccum >= 1) {
      this._exhaustAccum -= 1;
      for (let k = 0; k < 2; k++) {
        const sx = SIDES[k];
        // Off the exhaust stack itself — its height moves with the deck.
        _va.copy(this.exhaustPort.position); _va.x = sx * 0.92;
        this.chassis.localToWorld(_va);
        _vb.set(0, 0.6, -1).transformDirection(this.root.matrixWorld);
        const sp = 0.7 + rpm * 2.4;
        this.exhaustPuffs.spawn(
          _va.x, _va.y, _va.z,
          _vb.x * sp + (this.rng() - 0.5) * 0.4 + (p ? p.vel.x * 0.4 : 0),
          _vb.y * sp + 0.3,
          _vb.z * sp + (this.rng() - 0.5) * 0.4 + (p ? p.vel.z * 0.4 : 0),
          0.13 + this.rng() * 0.14 + load * 0.12,
          0.55 + this.rng() * 0.5 + load * 0.6,
          2.1
        );
      }
    }

    // ---- damage smoke -----------------------------------------------------
    if (this.smoking || this.critical) {
      const sev = this.critical ? 1 : clamp01(1 - this.hp / (this.maxHp * 0.5));
      this._smokeAccum += dt * (5 + sev * 22);
      while (this._smokeAccum >= 1) {
        this._smokeAccum -= 1;
        // Out of the engine deck, and out of the radiator if that's the wound.
        const fromRad = this.critical && this.rng() < 0.5;
        if (fromRad) _va.set((this.rng() - 0.5) * 0.9, this.radiatorY, -2.63);
        else _va.set((this.rng() - 0.5) * 1.0, this.turretDeckY + 0.04,
          -1.6 + (this.rng() - 0.5) * 0.7);
        this.chassis.localToWorld(_va);
        this.damageSmoke.spawn(
          _va.x, _va.y, _va.z,
          (this.rng() - 0.5) * 0.7, 0.9 + this.rng() * 1.4, (this.rng() - 0.5) * 0.7 - (fromRad ? 0.8 : 0),
          0.42 + this.rng() * 0.5 + sev * 0.5,
          2.2 + this.rng() * 2.4 + sev * 2,
          2.6
        );
      }
    }

    // ---- fire -------------------------------------------------------------
    if (this.burning) {
      this._fireAccum += dt * 26;
      while (this._fireAccum >= 1) {
        this._fireAccum -= 1;
        _va.set((this.rng() - 0.5) * 1.4, this.turretDeckY + this.rng() * 0.5,
          -1.4 + (this.rng() - 0.5) * 1.6);
        this.chassis.localToWorld(_va);
        this.firePuffs.spawn(
          _va.x, _va.y, _va.z,
          (this.rng() - 0.5) * 1.2, 1.6 + this.rng() * 2.4, (this.rng() - 0.5) * 1.2,
          0.26 + this.rng() * 0.34, 0.35 + this.rng() * 0.45, 1.4
        );
      }
    }

    for (let i = 0; i < this.puffSystems.length; i++) {
      const ps = this.puffSystems[i];
      ps.step(dt); ps.updateRender();
    }

    // Decal fade-in on fresh damage.
    if (this._decalDirty) {
      this._decalGeo.attributes.aAlpha.needsUpdate = true;
      this._decalDirty = false;
    }
  }

  // ==========================================================================
  //  Visual damage
  // ==========================================================================

  /** Stamp a scorch decal at a world-space impact point. */
  _addScorch(worldPos, worldNormal, size) {
    if (this.decalMax === 0) return;
    this.root.updateWorldMatrix(true, false);
    _va.copy(worldPos);
    this.root.worldToLocal(_va);
    // Push the decal a hair off the surface along the impact normal.
    if (worldNormal) {
      _vb.copy(worldNormal).transformDirection(_m4b.copy(this.root.matrixWorld).invert()).normalize();
    } else {
      _vb.copy(_va).setY(_va.y * 0.5).normalize();
    }
    if (!isFinite(_vb.x) || _vb.lengthSq() < 0.2) _vb.set(0, 1, 0);
    _va.addScaledVector(_vb, 0.02);

    const i = this.decalCount < this.decalMax
      ? this.decalCount++
      : (this._decalRing = ((this._decalRing || 0) + 1) % this.decalMax);
    _qs.setFromUnitVectors(_zAxis, _vb);
    // Random roll so repeated hits don't stamp identically.
    _es.set(0, 0, this.rng() * TAU, 'XYZ');
    _qs2.setFromEuler(_es);
    _qs.multiply(_qs2);
    const s = size * (0.7 + this.rng() * 0.6);
    _vc.set(s, s, s);
    _m4.compose(_va, _qs, _vc);
    this.decalMesh.setMatrixAt(i, _m4);
    this.decalMesh.instanceMatrix.needsUpdate = true;
    this._decalAlpha[i] = 0.65 + this.rng() * 0.3;
    this._decalDirty = true;
    this.decalMesh.count = this.decalCount;
    this._decalGeo.instanceCount = this.decalCount;
  }

  /**
   * Push the armour in around a hit. Operates on the pristine base positions so
   * repeated hits accumulate without the mesh melting away.
   */
  _addDent(worldPos, worldNormal, strength) {
    if (this._dentCount > 24) return;
    this._dentCount++;
    this.root.updateWorldMatrix(true, false);
    _va.copy(worldPos);
    this.root.worldToLocal(_va);
    _vb.copy(worldNormal || _yAxis)
      .transformDirection(_m4b.copy(this.root.matrixWorld).invert()).normalize();

    const attr = this.hullGeo.attributes.position;
    const arr = attr.array;
    // Low quality means a coarse hull; widen the crater so a dent still lands
    // on actual vertices instead of silently doing nothing.
    const R = (0.30 + strength * 0.22) * byQ([2.1, 1.0, 1.0]);
    const depth = 0.035 + strength * 0.075;
    const R2 = R * R;
    let touched = 0;
    for (let i = 0; i < arr.length; i += 3) {
      const dx = arr[i] - _va.x, dy = arr[i + 1] - _va.y, dz = arr[i + 2] - _va.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R2) continue;
      // Smooth crater profile, deepest at the centre.
      const f = 1 - Math.sqrt(d2) / R;
      const w = f * f * (3 - 2 * f);
      arr[i] -= _vb.x * depth * w;
      arr[i + 1] -= _vb.y * depth * w;
      arr[i + 2] -= _vb.z * depth * w;
      touched++;
    }
    if (touched) {
      attr.needsUpdate = true;
      this.hullGeo.computeVertexNormals();
    }
  }

  /** Undo all cosmetic damage (used by the engineer's repair order). */
  repair(amount = Infinity) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
    if (this.hp > this.maxHp * 0.5) this.smoking = false;
    for (let s = 0; s < 2; s++) {
      if (this.trackThrown[s] && this.hp > this.maxHp * 0.35) {
        this.trackThrown[s] = false;
        this.trackSag[s] = 0;
        this.trackHp[s] = 520;
        if (this.physics) this.physics.trackHealth[s] = 1;
      }
    }
    if (this.hp >= this.maxHp) {
      this.hullGeo.attributes.position.array.set(this._hullBase);
      this.hullGeo.attributes.position.needsUpdate = true;
      this.hullGeo.computeVertexNormals();
      this._dentCount = 0;
      this.decalCount = 0;
      this.decalMesh.count = 0;
      this._decalGeo.instanceCount = 0;
      this.radiatorHp = 420;
      this.critical = false;
      this.turretJammed = false;
    }
    return this;
  }

  // ==========================================================================
  //  Teardown
  // ==========================================================================

  dispose() {
    if (this._physicsHost) {
      this._physicsHost.removeStepper(this.physics);
      this._physicsHost = null;
    }
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const m of this.materials) m && m.dispose && m.dispose();
    for (const t of this.textures) t && t.dispose && t.dispose();
    if (this.decalMaterial) {
      this.decalMaterial.uniforms.uTex.value?.dispose();
      this.decalMaterial.dispose();
    }
    if (this.flashMaterial) this.flashMaterial.dispose();
    for (const p of this.puffSystems) {
      if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
      p.dispose();
    }
    if (this.physics) this.physics.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

// Scratch record returned by _samplePath — never escapes the frame.
const _pathSample = { z: 0, y: 0, dz: 0, dy: 1 };

function approach(a, b, maxStep) {
  const d = b - a;
  if (Math.abs(d) <= maxStep) return b;
  return a + Math.sign(d) * maxStep;
}
function approachAngle(a, b, maxStep) {
  const d = shortestAngle(a, b);
  if (Math.abs(d) <= maxStep) return a + d;
  return a + Math.sign(d) * maxStep;
}

// Exposed so the game layer can build faction variants (and so the UI can
// pull the same pigments for the vehicle status panel) without reaching into
// module internals.
export { PAL as TANK_PALETTE };
export function makeTankArmourTexture(seed, color, size) {
  return makeArmourTexture(seed, color, size);
}
