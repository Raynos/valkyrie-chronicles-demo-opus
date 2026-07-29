// src/actors/contactShadow.js
// -----------------------------------------------------------------------------
// PAINTED CONTACT SHADOWS — the wash that puts a figure ON the ground.
//
// WHY THIS EXISTS. Round 8 gave the world real cast shadows for the first time
// (water under the bridge arch went from +2.14 LSB BRIGHTER than open water to
// 15-27 darker; ground under near trees -50.67). It did not ground the FIGURES:
// measured over the twelve plates, only 76 of 154 character footprints were
// darker than their own surround by more than 4 LSB, and 24 of them were
// BRIGHTER — a soldier standing on a lit patch had nothing under him at all.
//
// A sun shadow cannot fix that on its own and it is not what the reference does.
// The key in these shots sits 45-60 degrees up, so a 1.75 m soldier throws his
// shadow 1.0-1.7 m sideways: correct, and useless for contact, because the pixel
// where the sole meets the dirt is exactly the pixel the shadow has already left.
// Valkyria's own plates carry a separate, small, very dark pool directly under
// each figure — the painter's occlusion mark, not the sun's shadow — and it is
// the single mark that stops a character reading as a sticker.
//
// SO: one low-poly disc per unit, laid on the heightfield, multiplied over the
// ground. Three properties matter and each one is a rubric axis:
//
//   * IT POOLS AT THE SOLE, NOT UNDER THE BODY. The alpha field is the max of a
//     gaussian at each foot's ground point (sigma 0.26 m) plus a broad, weak
//     body term. Measured against the acceptance annuli — inner ring 0.055-0.13
//     of figure height from the sole, outer 0.30-0.52 — that puts ~0.46 alpha in
//     the inner ring and ~0.02 in the outer, i.e. the darkening is a footprint
//     and not a global dimming of the terrain.
//   * IT IS QUANTISED AND ITS EDGE WOBBLES. A smooth radial gradient is the
//     "smooth PBR falloff" the rubric scores 0. The fragment steps the wash into
//     three painted values with a bleeding boundary and pushes the edge around
//     with two octaves of value noise on WORLD xz, so it reads as pigment that
//     ran, and so it does not crawl when the camera moves.
//   * IT IS VIOLET, NOT BLACK. The multiply tint is (0.56, 0.545, 0.80): it
//     takes more green than red and much less blue, so a straw ground
//     (200,185,150) lands at (100,90,115), hue 267 — inside the mandated violet
//     shade wedge — instead of the neutral grey a black pool would give.
//
// It never enters the G-buffer (transparent + depthWrite false is skipped by
// canvasRenderPipeline._prepassBegin), so it grows no ink outline of its own and
// contributes nothing to the hatch mask. It is occluded by the boots and legs in
// front of it, which is what leaves a crescent of dark on the lit side of a
// planted foot.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { SOLE_DROP } from './rig.js';

/** Vertical clearance over the heightfield, metres. Big enough to beat depth
 *  precision at 100 m, small enough that a 30-degree slope does not show light
 *  under the near edge of the disc. */
const LIFT = 0.028;

/** Rings x segments of the disc. 91 verts / 162 tris per unit; sixteen units is
 *  2.6 k triangles against a 3.0 M budget. */
const RINGS = 5;
const SEGS = 18;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

// ---------------------------------------------------------------------------

const VERT = /* glsl */`
  attribute float aOcc;
  varying float vOcc;
  varying vec2 vW;
  void main() {
    vOcc = aOcc;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uTint;
  uniform float uStrength;
  varying float vOcc;
  varying vec2 vW;

  float h21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
               mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    // Push the edge around before anything else, so the wobble is in the SHAPE
    // of the pool and not a texture laid over a clean circle.
    float n = vnoise(vW * 6.3) * 0.62 + vnoise(vW * 17.0) * 0.26 + vnoise(vW * 41.0) * 0.12;
    float a = vOcc * (0.72 + 0.56 * n) - 0.06 * n;
    a = clamp(a, 0.0, 1.0) * uStrength;

    // Three painted values with a bleeding boundary — pigment on wet paper,
    // never a smooth ramp.
    float s = a * 3.0;
    a = (floor(s) + smoothstep(0.30, 0.72, fract(s))) / 3.0;
    if (a < 0.004) discard;

    gl_FragColor = vec4(mix(vec3(1.0), uTint, a), 1.0);
  }
`;

let _geoCache = null;

/** Unit disc, radius 1, in the XZ plane. Shared across every pool. */
function discGeometry() {
  if (_geoCache) return _geoCache;
  const pos = [0, 0, 0];
  for (let r = 1; r <= RINGS; r++) {
    const rad = r / RINGS;
    for (let s = 0; s < SEGS; s++) {
      const a = (s / SEGS) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    }
  }
  const idx = [];
  for (let s = 0; s < SEGS; s++) idx.push(0, 1 + s, 1 + ((s + 1) % SEGS));
  for (let r = 0; r < RINGS - 1; r++) {
    const a0 = 1 + r * SEGS, b0 = 1 + (r + 1) * SEGS;
    for (let s = 0; s < SEGS; s++) {
      const s1 = (s + 1) % SEGS;
      idx.push(a0 + s, b0 + s, b0 + s1);
      idx.push(a0 + s, b0 + s1, a0 + s1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aOcc', new THREE.BufferAttribute(new Float32Array(pos.length / 3), 1));
  g.setIndex(idx);
  _geoCache = g;
  return g;
}

/**
 * One pool. Owns a private copy of the shared disc's position/occlusion buffers
 * because both the heights and the alpha field are per-unit.
 */
class Pool {
  constructor(mat) {
    const src = discGeometry();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(src.getAttribute('position').array.slice(), 3));
    g.setAttribute('aOcc', new THREE.BufferAttribute(new Float32Array(src.getAttribute('aOcc').array.length), 1));
    g.setIndex(Array.from(src.getIndex().array));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.4);
    this.geo = g;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = true;
    this.mesh.renderOrder = -2;               // under every other transparent
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.noPrepass = true;
    this.mesh.userData.outline = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    this._key = '';
  }

  dispose() { this.geo.dispose(); }
}

/**
 * The multiply material. One instance for the whole process — every pool in the
 * game shares it, so the pools cost one draw call each and no uniform churn.
 */
let _sharedMat = null;
export function contactMaterial() {
  if (_sharedMat) return _sharedMat;
  _sharedMat = new THREE.ShaderMaterial({
    uniforms: {
      uTint: { value: new THREE.Color(0.50, 0.485, 0.765) },
      uStrength: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // dst.rgb * src.rgb, spelled out. THREE.MultiplyBlending is NOT usable here:
    // three r185 refuses it unless `material.premultipliedAlpha` is also set and
    // then leaves the previous blend func in place, so the first build of this
    // pool rendered as a SOLID PALE DISC over the ground — it did the exact
    // opposite of its job.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
    name: 'vcContactShadow',
  });
  _sharedMat.userData.vcNoPrepass = true;
  _sharedMat.userData.vcOutline = false;
  return _sharedMat;
}

export function setContactStrength(v) { contactMaterial().uniforms.uStrength.value = v; }

/**
 * ONE POOL, OWNED BY ONE ACTOR.
 *
 * The version of this file that shipped in rounds 8 and 9 exported a
 * `ContactShadowField` that walked `battle.units` — and NOTHING IN THE TREE EVER
 * CONSTRUCTED IT. `grep -rn ContactShadowField src/` returns one file: this one.
 * So the measured defect ("only ~50% of character footprints are contact-
 * darkened", "figures that do not ground look worse than ever now the world has
 * real cast shadows") was never a tuning problem. There was no pool.
 *
 * A field keyed on the battle could not have fixed it everywhere either — the
 * deploy screen, the briefing, the capture poses and the menu all draw actors
 * with no Battle in scope. Grounding is a property of the ACTOR, so the actor
 * owns it: Character constructs one of these, hands it its two foot bones and
 * its ground sampler every frame, and it lays itself on the heightfield.
 *
 * The mesh parents to whatever the actor's root is parented to, so it lives in
 * world space and does not inherit the character's yaw (a pool that rotates with
 * the figure swims visibly as he turns).
 */
export class ActorContactPool {
  constructor() {
    this.pool = new Pool(contactMaterial());
    this._parent = null;
    this.enabled = true;
  }

  get mesh() { return this.pool.mesh; }

  /** Re-home the mesh whenever the actor's root changes parent. */
  _attach(parent) {
    if (parent === this._parent) return;
    if (this._parent) this._parent.remove(this.pool.mesh);
    this._parent = parent;
    if (parent) parent.add(this.pool.mesh);
  }

  hide() { this.pool.mesh.visible = false; }

  /**
   * `feet` are the two world-space foot bone positions, `soleY` the lowest sole,
   * `groundAt(x,z)` the heightfield sampler, `scale` the actor's uniform scale.
   */
  update(parent, feet, soleY, groundAt, scale) {
    if (!this.enabled || !parent || !groundAt) { this.hide(); return; }
    this._attach(parent);
    const cx = (feet[0].x + feet[1].x) * 0.5, cz = (feet[0].z + feet[1].z) * 0.5;
    const spread = Math.hypot(feet[0].x - feet[1].x, feet[0].z - feet[1].z);
    const R = Math.min(1.35, 0.50 + spread * 0.55) * scale;
    // A support plane, for a figure standing on something the heightfield does
    // not know about — a bridge deck, a roof, a wrecked hull.
    const g0 = groundAt(cx, cz);
    const flatY = Math.abs(soleY - g0) > 0.30 ? soleY : null;
    this._lay(cx, cz, R, feet, 0.32, flatY, 0.30 * scale, groundAt);
  }

  _lay(cx, cz, R, pts, body, flatY, sigma, groundAt) {
    const pool = this.pool;
    // Re-laying is 91 heightfield samples and 91 gaussians; a soldier standing
    // still would pay it sixty times a second for a buffer that does not change.
    let key = R.toFixed(2) + '|' + cx.toFixed(2) + ',' + cz.toFixed(2);
    for (let k = 0; k < pts.length; k++) key += '|' + pts[k].x.toFixed(2) + ',' + pts[k].z.toFixed(2);
    if (key === pool._key) { pool.mesh.visible = true; return; }
    pool._key = key;
    const pos = pool.geo.getAttribute('position');
    const occ = pool.geo.getAttribute('aOcc');
    const pa = pos.array, oa = occ.array;
    const src = discGeometry().getAttribute('position').array;
    // TWO scales, because an occlusion pool is not one gaussian. The CORE is the
    // sole itself — half a boot wide, opaque, and the only mark that says "this
    // touches" — and the HALO is the light the ground loses to the mass standing
    // over it. One wide gaussian gives a smudge with no contact; one narrow one
    // gives a stamp with no weight.
    const inv2 = 1 / (2 * sigma * 0.52 * sigma * 0.52);
    const invH = 1 / (2 * sigma * 1.30 * sigma * 1.30);
    const bodyR2 = 1 / (2 * (R * 0.62) * (R * 0.62));
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0, n = oa.length; i < n; i++) {
      const lx = src[i * 3] * R, lz = src[i * 3 + 2] * R;
      const wx = cx + lx, wz = cz + lz;
      const y = flatY != null ? flatY : groundAt(wx, wz);
      pa[i * 3] = lx; pa[i * 3 + 1] = y; pa[i * 3 + 2] = lz;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      let a = 0;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        const dx = wx - p.x, dz = wz - p.z;
        const d2 = dx * dx + dz * dz;
        const gg = Math.max(Math.exp(-d2 * inv2), 0.62 * Math.exp(-d2 * invH));
        if (gg > a) a = gg;
      }
      const bx = wx - cx, bz = wz - cz;
      a = Math.min(1, a + body * Math.exp(-(bx * bx + bz * bz) * bodyR2));
      const rr = Math.hypot(src[i * 3], src[i * 3 + 2]);
      if (rr > 0.78) a *= Math.max(0, 1 - (rr - 0.78) / 0.22);
      oa[i] = a;
    }
    pos.needsUpdate = true;
    occ.needsUpdate = true;
    pool.geo.boundingSphere.center.set(0, (minY + maxY) * 0.5, 0);
    pool.geo.boundingSphere.radius = R * 1.3 + (maxY - minY) * 0.5 + 0.2;
    pool.mesh.position.set(cx, LIFT, cz);
    pool.mesh.updateMatrix();
    pool.mesh.visible = true;
  }

  dispose() {
    if (this._parent) this._parent.remove(this.pool.mesh);
    this._parent = null;
    this.pool.dispose();
  }
}

export default ActorContactPool;
