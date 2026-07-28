// src/actors/rig.js
// -----------------------------------------------------------------------------
// Procedural humanoid rig + skinned body geometry for the Gallian militia.
//
// Everything here is generated in code: a 28-bone THREE.Skeleton with a proper
// rest pose, a small swept-surface mesh toolkit, an analytic skin-weight solver
// (distance-to-bone-segment with smooth falloff, so elbows and knees blend with
// no seams), a voxel ambient-occlusion bake, and the body/head mesh assembly.
//
// Conventions (shared with anim.js, character.js, weapons.js):
//   * 1 unit = 1 metre, +Y up, character FACES +Z (three.js Object3D forward).
//   * Every bone's rest orientation puts its local +Y down the bone toward its
//     child and its local +Z as close to world +Z as possible. Animation clips
//     are therefore authored as *deltas from rest*, which makes 0,0,0 the
//     A-pose for every bone regardless of which way the bone actually points.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { fbm2, valueNoise2 } from '../core/rng.js';
import { clamp, clamp01, lerp, smoothstep, TAU } from '../core/math.js';
import { makeCanvasMaterial } from '../render/materials.js';

// ---------------------------------------------------------------------------
// Colour: authored in sRGB hex, stored linear so the NPR shader bands correctly.
// ---------------------------------------------------------------------------

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** sRGB hex -> linear [r,g,b] triple. */
export function rgbLin(hex) {
  return [s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255)];
}

/** Mix two linear triples into a fresh triple. */
export function mixCol(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Squad 7 / Gallian militia palette. Warm tan tunic, dark brown webbing,
// cream trim, red-brown accents — plus the Imperial grey-green counterpart.
export const PALETTE = {
  tunic: rgbLin(0xbca77c),
  tunicShade: rgbLin(0xa38e66),
  collar: rgbLin(0x8d7854),
  trouser: rgbLin(0x93885f),
  trouserCuff: rgbLin(0x7d7452),
  leather: rgbLin(0x5b4531),
  belt: rgbLin(0x473527),
  boot: rgbLin(0x3d2d22),
  bootSole: rgbLin(0x2e2620),
  glove: rgbLin(0x6d5238),
  metal: rgbLin(0x6f6c64),
  metalDark: rgbLin(0x44413c),
  brass: rgbLin(0x9c7e47),
  trim: rgbLin(0xe8dec4),
  accent: rgbLin(0x8f3c2d),
  wood: rgbLin(0x7c5535),
  canvas: rgbLin(0xa79a76),
  scarf: rgbLin(0xd8ccab),
  eyeWhite: rgbLin(0xefe8de),
  lip: rgbLin(0xb07a68),
  brow: rgbLin(0x4a3526),
  // Imperial (team 1)
  impTunic: rgbLin(0x707263),
  impTunicShade: rgbLin(0x5d6053),
  impCollar: rgbLin(0x4c4e44),
  impTrouser: rgbLin(0x5c5e52),
  impLeather: rgbLin(0x3e392f),
  impAccent: rgbLin(0x7c2c23),
  impTrim: rgbLin(0xb6b29b),
};

export const SKIN_TONES = [
  rgbLin(0xf2cca8), rgbLin(0xe8bd95), rgbLin(0xdbab80),
  rgbLin(0xc7946a), rgbLin(0xa87a55), rgbLin(0x82593f), rgbLin(0x60412e),
];

export const HAIR_TONES = [
  rgbLin(0x2b2320), rgbLin(0x3a2b21), rgbLin(0x50381f), rgbLin(0x6f5031),
  rgbLin(0x8d6a3a), rgbLin(0xbd9a5a), rgbLin(0x9a4a2b), rgbLin(0x6d6154),
];

// ---------------------------------------------------------------------------
// Skeleton definition
// ---------------------------------------------------------------------------
//
// Positions are WORLD-space rest positions for a canonical 1.72 m soldier
// standing at y = 0 facing +Z.  `tail` (when absent) is taken from the first
// child, so bone directions fall out of the table automatically.
//
//   soft  – added to the point/segment distance before the falloff power. Wide
//           values give a broad, soft blend across the joint; small values keep
//           small bones (fingers, toes) crisp.
//   ws    – weight scale, biases a bone against its neighbours.
//   axial – measure distance only along the bone axis, ignoring radial offset.
//           Essential for the spine: a chest vertex is 0.13 m off the spine
//           axis, so a radial metric would smear it across three bones.

const B = (name, parent, pos, o = {}) => ({ name, parent, pos, soft: 0.05, ws: 1, axial: false, tail: null, ...o });

export const BONE_DEFS = [
  B('root', null, [0, 0, 0], { soft: 0.4, ws: 0.001, tail: [0, 0.2, 0] }),
  B('hips', 'root', [0, 0.955, 0], { soft: 0.06, ws: 1.15, axial: true, tail: [0, 1.055, 0] }),
  B('spine1', 'hips', [0, 1.055, 0], { soft: 0.045, axial: true }),
  B('spine2', 'spine1', [0, 1.155, 0.004], { soft: 0.045, axial: true }),
  B('spine3', 'spine2', [0, 1.265, 0.006], { soft: 0.05, axial: true, ws: 1.05 }),
  B('neck', 'spine3', [0, 1.408, 0.004], { soft: 0.03, axial: true }),
  B('head', 'neck', [0, 1.497, 0.004], { soft: 0.05, ws: 1.3, tail: [0, 1.66, 0.012] }),
  B('headTop', 'head', [0, 1.66, 0.012], { soft: 0.09, ws: 0.2, tail: [0, 1.78, 0.012] }),

  B('clavicleL', 'spine3', [0.036, 1.376, 0.014], { soft: 0.05, ws: 0.85 }),
  B('upperArmL', 'clavicleL', [0.176, 1.362, 0.004], { soft: 0.05 }),
  B('foreArmL', 'upperArmL', [0.199, 1.092, 0.011], { soft: 0.048 }),
  B('handL', 'foreArmL', [0.216, 0.845, 0.015], { soft: 0.028, ws: 1.1, tail: [0.222, 0.757, 0.021] }),
  B('fingersL', 'handL', [0.222, 0.757, 0.021], { soft: 0.02, tail: [0.224, 0.706, 0.026] }),
  B('thumbL', 'handL', [0.194, 0.799, 0.045], { soft: 0.018, ws: 0.9, tail: [0.186, 0.771, 0.072] }),

  B('clavicleR', 'spine3', [-0.036, 1.376, 0.014], { soft: 0.05, ws: 0.85 }),
  B('upperArmR', 'clavicleR', [-0.176, 1.362, 0.004], { soft: 0.05 }),
  B('foreArmR', 'upperArmR', [-0.199, 1.092, 0.011], { soft: 0.048 }),
  B('handR', 'foreArmR', [-0.216, 0.845, 0.015], { soft: 0.028, ws: 1.1, tail: [-0.222, 0.757, 0.021] }),
  B('fingersR', 'handR', [-0.222, 0.757, 0.021], { soft: 0.02, tail: [-0.224, 0.706, 0.026] }),
  B('thumbR', 'handR', [-0.194, 0.799, 0.045], { soft: 0.018, ws: 0.9, tail: [-0.186, 0.771, 0.072] }),

  B('thighL', 'hips', [0.094, 0.921, 0.002], { soft: 0.058 }),
  B('shinL', 'thighL', [0.099, 0.512, 0.013], { soft: 0.05 }),
  B('footL', 'shinL', [0.102, 0.088, -0.014], { soft: 0.035, ws: 1.1 }),
  B('toeL', 'footL', [0.102, 0.026, 0.108], { soft: 0.022, tail: [0.102, 0.022, 0.16] }),

  B('thighR', 'hips', [-0.094, 0.921, 0.002], { soft: 0.058 }),
  B('shinR', 'thighR', [-0.099, 0.512, 0.013], { soft: 0.05 }),
  B('footR', 'shinR', [-0.102, 0.088, -0.014], { soft: 0.035, ws: 1.1 }),
  B('toeR', 'footR', [-0.102, 0.026, 0.108], { soft: 0.022, tail: [-0.102, 0.022, 0.16] }),
];

export const BONE_NAMES = BONE_DEFS.map((b) => b.name);

/** Body-type variants. A six-person squad picks from these so nobody looks cloned. */
export const BODY_TYPES = {
  medium: { height: 1.00, legs: 1.00, torso: 1.00, shoulder: 1.00, hip: 1.00, girth: 1.00, arm: 1.00, head: 1.00 },
  lean: { height: 1.02, legs: 1.035, torso: 0.985, shoulder: 0.945, hip: 0.955, girth: 0.90, arm: 1.03, head: 0.98 },
  stocky: { height: 0.965, legs: 0.955, torso: 1.015, shoulder: 1.075, hip: 1.06, girth: 1.16, arm: 0.97, head: 1.02 },
  tall: { height: 1.055, legs: 1.06, torso: 1.03, shoulder: 1.02, hip: 0.99, girth: 0.98, arm: 1.05, head: 0.955 },
  petite: { height: 0.935, legs: 0.955, torso: 0.975, shoulder: 0.90, hip: 1.02, girth: 0.88, arm: 0.95, head: 1.055 },
};

const HIP_Y = 0.955;

// ---------------------------------------------------------------------------
// Rest-basis construction
// ---------------------------------------------------------------------------

const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
const _bm = new THREE.Matrix4();
const REF_FWD = new THREE.Vector3(0, 0, 1);

/**
 * Orientation whose local +Y is `dir` and whose local +Z is as close to world
 * +Z as possible. Deterministic (no shortest-arc degeneracy) which matters:
 * every clip in anim.js is expressed relative to these frames.
 */
function basisQuat(dir, out) {
  _by.copy(dir).normalize();
  let d = REF_FWD.dot(_by);
  if (Math.abs(d) > 0.999) {
    // Bone points along Z (feet, thumbs) — fall back to world +Y as reference.
    _bz.set(0, 1, 0).addScaledVector(_by, -_by.y).normalize();
  } else {
    _bz.copy(REF_FWD).addScaledVector(_by, -d).normalize();
  }
  _bx.crossVectors(_by, _bz);
  _bm.makeBasis(_bx, _by, _bz);
  return out.setFromRotationMatrix(_bm);
}

/**
 * Build the rig: bone hierarchy, rest transforms and a bound THREE.Skeleton.
 * The returned `root` bone must be added to the character group *before* the
 * SkinnedMesh is bound (see createSkinnedBody).
 */
export function makeRig(opts = {}) {
  const bodyType = opts.bodyType && BODY_TYPES[opts.bodyType] ? opts.bodyType : 'medium';
  const P = BODY_TYPES[bodyType];
  const extra = opts.heightScale || 1;

  // --- scale the canonical table into this body's proportions -------------
  const worldPos = new Map();
  for (const d of BONE_DEFS) {
    let [x, y, z] = d.pos;
    const isArm = /^(clavicle|upperArm|foreArm|hand|fingers|thumb)/.test(d.name);
    const isLeg = /^(thigh|shin|foot|toe)/.test(d.name);
    // Vertical: legs scale below the hip, torso above it.
    if (y <= HIP_Y) y = y * P.legs;
    else y = HIP_Y * P.legs + (y - HIP_Y) * P.torso;
    if (isArm) {
      x *= P.shoulder;
      // Arm length scales about the shoulder height.
      const sy = HIP_Y * P.legs + (1.362 - HIP_Y) * P.torso;
      y = sy + (y - sy) * P.arm;
      if (d.name.startsWith('clavicle')) y = sy + (y - sy);
    } else if (isLeg) {
      x *= P.hip;
    } else if (/^(head|headTop)/.test(d.name)) {
      const ny = HIP_Y * P.legs + (1.497 - HIP_Y) * P.torso;
      y = ny + (y - ny) * P.head;
    }
    worldPos.set(d.name, new THREE.Vector3(x, y, z));
  }

  // --- tails / directions -------------------------------------------------
  const childOf = new Map();
  for (const d of BONE_DEFS) if (d.parent) { if (!childOf.has(d.parent)) childOf.set(d.parent, []); childOf.get(d.parent).push(d.name); }

  const tail = new Map();
  for (const d of BONE_DEFS) {
    if (d.tail) {
      let [x, y, z] = d.tail;
      const p = worldPos.get(d.name);
      const base = BONE_DEFS.find((q) => q.name === d.name).pos;
      // Keep the authored tail offset but move it with the (possibly scaled) head.
      tail.set(d.name, new THREE.Vector3(p.x + (x - base[0]), p.y + (y - base[1]), p.z + (z - base[2])));
    } else {
      const kids = childOf.get(d.name);
      const t = new THREE.Vector3();
      if (kids && kids.length) {
        // Average the children (clavicle-bearing spine3 uses its true child chain).
        const pick = kids.filter((k) => !/^clavicle|^thigh/.test(k));
        const use = pick.length ? pick : kids;
        for (const k of use) t.add(worldPos.get(k));
        t.multiplyScalar(1 / use.length);
      } else {
        t.copy(worldPos.get(d.name)).add(new THREE.Vector3(0, -0.05, 0));
      }
      tail.set(d.name, t);
    }
  }

  // --- bones --------------------------------------------------------------
  const bones = [];
  const boneMap = Object.create(null);
  const restWorld = Object.create(null);
  const dirV = new THREE.Vector3();

  for (const d of BONE_DEFS) {
    const bone = new THREE.Bone();
    bone.name = d.name;
    bones.push(bone);
    boneMap[d.name] = bone;

    const p = worldPos.get(d.name);
    const t = tail.get(d.name);
    dirV.copy(t).sub(p);
    const len = dirV.length() || 0.05;
    dirV.multiplyScalar(1 / len);
    const q = basisQuat(dirV, new THREE.Quaternion());
    restWorld[d.name] = {
      pos: p.clone(),
      quat: q,
      dir: dirV.clone(),
      tail: t.clone(),
      len,
      soft: d.soft,
      ws: d.ws,
      axial: d.axial,
    };
  }

  // --- local rest transforms ---------------------------------------------
  const restLocal = Object.create(null);
  const invQ = new THREE.Quaternion();
  for (const d of BONE_DEFS) {
    const rw = restWorld[d.name];
    const bone = boneMap[d.name];
    if (d.parent) {
      const pr = restWorld[d.parent];
      invQ.copy(pr.quat).invert();
      const lp = rw.pos.clone().sub(pr.pos).applyQuaternion(invQ);
      const lq = invQ.clone().multiply(rw.quat);
      bone.position.copy(lp);
      bone.quaternion.copy(lq);
      boneMap[d.parent].add(bone);
      restLocal[d.name] = { pos: lp.clone(), quat: lq.clone() };
    } else {
      bone.position.copy(rw.pos);
      bone.quaternion.copy(rw.quat);
      restLocal[d.name] = { pos: rw.pos.clone(), quat: rw.quat.clone() };
    }
    bone.updateMatrix();
  }

  // NOTE: height variation is applied by the caller to the character Group,
  // never to the root bone — scaling a bone would be cancelled out by the
  // bind-pose inverses and have no visible effect.
  const root = boneMap.root;
  root.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(bones);

  return {
    root,
    bones,
    boneMap,
    restWorld,
    restLocal,
    skeleton,
    proportions: P,
    bodyType,
    heightScale: P.height * extra,
    variantKey: `${bodyType}`,
    index: BONE_NAMES.reduce((a, n, i) => ((a[n] = i), a), Object.create(null)),
  };
}

// ---------------------------------------------------------------------------
// Mesh toolkit
// ---------------------------------------------------------------------------
//
// A tiny swept-surface library. Four primitives cover every piece of a soldier
// and their kit: generalised tapered tubes (limbs, straps, barrels), lathes
// (helmets, canteens, muzzles), rounded boxes (pouches, receivers, boots) and
// shaped ellipsoids (skull, deltoids, hair). All of them emit analytic normals
// so the mesh smooth-shades without a welding pass.

const SEGQ = () => [0.62, 0.85, 1.0][clamp(CFG.quality | 0, 0, 2)];

/** Segment count helper — scales with quality, always even and >= 4. */
export function seg(base) {
  return Math.max(4, Math.round(base * SEGQ() * 0.5) * 2);
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.vgroup = [];          // per-vertex index into this.groups
    this.groups = [];          // arrays of candidate bone names
    this._groupKey = new Map();
    this._g = 0;
    this._c = [1, 1, 1];
    this._mottle = 0.06;
    this._xf = null;
    this._nmat = null;
  }

  get vertexCount() { return this.pos.length / 3; }

  /** Candidate bones for every vertex pushed from now on. */
  setBones(names) {
    const key = names.join(',');
    let g = this._groupKey.get(key);
    if (g === undefined) { g = this.groups.length; this.groups.push(names.slice()); this._groupKey.set(key, g); }
    this._g = g;
    return this;
  }

  setColor(c) { this._c = c; return this; }
  setMottle(m) { this._mottle = m; return this; }
  /**
   * Optional Matrix4 applied to every subsequent primitive. The matching
   * inverse-transpose is cached here so non-uniform scales (elliptical belts,
   * squashed helmets) still get correct normals.
   */
  setTransform(m) {
    this._xf = m || null;
    if (m) { if (!this._nmat) this._nmat = new THREE.Matrix3(); this._nmat.getNormalMatrix(m); }
    return this;
  }

  vert(px, py, pz, nx, ny, nz, u, vv, c) {
    if (this._xf) {
      _v.set(px, py, pz).applyMatrix4(this._xf);
      px = _v.x; py = _v.y; pz = _v.z;
      _n.set(nx, ny, nz).applyMatrix3(this._nmat).normalize();
      nx = _n.x; ny = _n.y; nz = _n.z;
    }
    this.pos.push(px, py, pz);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, vv);
    const col = c || this._c;
    // Gouache mottling — uneven pigment load, invisible at range, alive up close.
    let m = 1;
    if (this._mottle > 0) {
      const n1 = fbm2(px * 7.3 + pz * 2.1, py * 7.9, { octaves: 3, seed: 77 });
      const n2 = valueNoise2(px * 23.0 + py * 4.0, pz * 23.0 - py * 3.0, 131);
      m = 1 + (n1 - 0.5) * this._mottle * 1.6 + (n2 - 0.5) * this._mottle * 0.7;
    }
    this.col.push(col[0] * m, col[1] * m, col[2] * m);
    this.vgroup.push(this._g);
    return this.pos.length / 3 - 1;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  /**
   * Generalised swept tube.
   * @param spine array of { p:[x,y,z], r|rx, rz, roll } — rings along the bone.
   * @param o     { seg, capStart, capEnd, color, uvScale, vOffset }
   *              caps: 'round' | 'flat' | 'none'
   */
  addTube(spine, o = {}) {
    const N = spine.length;
    if (N < 2) return;
    const segs = o.seg !== undefined ? o.seg : seg(12);
    const capS = o.capStart || 'none';
    const capE = o.capEnd || 'none';
    const col = o.color || this._c;

    const P = new Array(N), RX = new Float32Array(N), RZ = new Float32Array(N), RL = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const s = spine[i];
      P[i] = new THREE.Vector3(s.p[0], s.p[1], s.p[2]);
      RX[i] = s.rx !== undefined ? s.rx : s.r;
      RZ[i] = s.rz !== undefined ? s.rz : s.r;
      RL[i] = s.roll || 0;
    }

    // Tangents + rotation-minimising (parallel transport) frames.
    const T = new Array(N), NR = new Array(N), BR = new Array(N);
    for (let i = 0; i < N; i++) {
      const t = new THREE.Vector3();
      if (i === 0) t.copy(P[1]).sub(P[0]);
      else if (i === N - 1) t.copy(P[N - 1]).sub(P[N - 2]);
      else t.copy(P[i + 1]).sub(P[i - 1]);
      if (t.lengthSq() < 1e-12) t.set(0, 1, 0);
      T[i] = t.normalize();
    }
    {
      const n0 = new THREE.Vector3(1, 0, 0);
      if (Math.abs(T[0].x) > 0.9) n0.set(0, 0, 1);
      n0.addScaledVector(T[0], -T[0].dot(n0)).normalize();
      NR[0] = n0;
      for (let i = 1; i < N; i++) {
        const n = NR[i - 1].clone();
        n.addScaledVector(T[i], -T[i].dot(n));
        if (n.lengthSq() < 1e-10) { n.set(1, 0, 0).addScaledVector(T[i], -T[i].x); }
        NR[i] = n.normalize();
      }
      for (let i = 0; i < N; i++) BR[i] = NR[i].clone().cross(T[i]).normalize();
      // Optional per-ring roll about the tangent (used to orient flat straps).
      for (let i = 0; i < N; i++) {
        if (!RL[i]) continue;
        const cr = Math.cos(RL[i]), sr = Math.sin(RL[i]);
        const nx = NR[i].x * cr + BR[i].x * sr, ny = NR[i].y * cr + BR[i].y * sr, nz = NR[i].z * cr + BR[i].z * sr;
        const bx = BR[i].x * cr - NR[i].x * sr, by = BR[i].y * cr - NR[i].y * sr, bz = BR[i].z * cr - NR[i].z * sr;
        NR[i].set(nx, ny, nz); BR[i].set(bx, by, bz);
      }
    }

    // Arc length for V coordinate.
    const S = new Float32Array(N);
    for (let i = 1; i < N; i++) S[i] = S[i - 1] + P[i].distanceTo(P[i - 1]);
    const total = S[N - 1] || 1;

    // Radius derivative along arc — tilts the normal on tapered sections.
    const DR = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
      const ds = Math.max(1e-5, S[b] - S[a]);
      DR[i] = ((RX[b] + RZ[b]) * 0.5 - (RX[a] + RZ[a]) * 0.5) / ds;
    }

    const capSN = capS === 'round' ? Math.max(2, segs >> 2) : 0;
    const capEN = capE === 'round' ? Math.max(2, segs >> 2) : 0;
    const rows = capSN + N + capEN;
    const base = this.vertexCount;
    const uvs = o.uvScale || 1;
    const vOff = o.vOffset || 0;

    // capCos scales the ring laterally (1 on the body, ->0 at a cap pole);
    // capAxial is the signed axial component of the cap normal.
    const pushRing = (center, nrm, bin, tan, rx, rz, drds, capCos, capAxial, vv) => {
      for (let j = 0; j <= segs; j++) {
        const th = (j / segs) * TAU;
        const ct = Math.cos(th), st = Math.sin(th);
        _v.copy(center)
          .addScaledVector(nrm, rx * ct * capCos)
          .addScaledVector(bin, rz * st * capCos);
        // Elliptical surface normal: (rz cos, rx sin) in the (N,B) frame.
        _n.set(0, 0, 0).addScaledVector(nrm, rz * ct).addScaledVector(bin, rx * st);
        if (_n.lengthSq() < 1e-12) _n.copy(nrm);
        _n.normalize();
        if (capAxial !== 0) _n.multiplyScalar(capCos).addScaledVector(tan, capAxial).normalize();
        else if (drds !== 0) _n.addScaledVector(tan, -drds).normalize();
        this.vert(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, (j / segs) * uvs, vv * uvs + vOff, col);
      }
    };

    // start cap: rings run from the pole back to the body so ∂i stays along +T
    for (let k = capSN; k >= 1; k--) {
      const ph = (k / capSN) * Math.PI * 0.5;
      const rMean = (RX[0] + RZ[0]) * 0.5;
      _v3.copy(P[0]).addScaledVector(T[0], -rMean * Math.sin(ph));
      pushRing(_v3, NR[0], BR[0], T[0], RX[0], RZ[0], 0, Math.cos(ph), -Math.sin(ph), -0.02 * k);
    }
    for (let i = 0; i < N; i++) {
      pushRing(P[i], NR[i], BR[i], T[i], RX[i], RZ[i], DR[i], 1, 0, S[i] / total);
    }
    for (let k = 1; k <= capEN; k++) {
      const ph = (k / capEN) * Math.PI * 0.5;
      const rMean = (RX[N - 1] + RZ[N - 1]) * 0.5;
      _v3.copy(P[N - 1]).addScaledVector(T[N - 1], rMean * Math.sin(ph));
      pushRing(_v3, NR[N - 1], BR[N - 1], T[N - 1], RX[N - 1], RZ[N - 1], 0, Math.cos(ph), Math.sin(ph), 1 + 0.02 * k);
    }

    const stride = segs + 1;
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < segs; j++) {
        const a = base + i * stride + j;
        this.quad(a, a + stride, a + stride + 1, a + 1);
      }
    }
    // Flat caps close the ends with a fan.
    if (capS === 'flat') this._flatCap(base, segs, P[0], T[0], -1);
    if (capE === 'flat') this._flatCap(base + (rows - 1) * stride, segs, P[N - 1], T[N - 1], 1);
  }

  _flatCap(ringBase, segs, center, tan, sign) {
    // The ring vertices already carry this._xf, so bake the transform into the
    // fan centre by hand and disable it while the cap is emitted.
    const xf = this._xf;
    let cx = center.x, cy = center.y, cz = center.z;
    let nx = tan.x * sign, ny = tan.y * sign, nz = tan.z * sign;
    if (xf) {
      _v.copy(center).applyMatrix4(xf); cx = _v.x; cy = _v.y; cz = _v.z;
      _nm.setFromMatrix4(xf);
      _n.set(nx, ny, nz).applyMatrix3(_nm).normalize(); nx = _n.x; ny = _n.y; nz = _n.z;
    }
    this._xf = null;
    const c = this.vert(cx, cy, cz, nx, ny, nz, 0.5, 0.5);
    // Re-emit the ring with the cap normal so the rim stays a hard edge.
    const ring = [];
    for (let j = 0; j <= segs; j++) {
      const k = (ringBase + j) * 3;
      ring.push(this.vert(this.pos[k], this.pos[k + 1], this.pos[k + 2], nx, ny, nz, 0.5, 0.5));
    }
    for (let j = 0; j < segs; j++) {
      if (sign > 0) this.tri(c, ring[j + 1], ring[j]);
      else this.tri(c, ring[j], ring[j + 1]);
    }
    this._xf = xf;
  }

  /**
   * Surface of revolution around local +Y.
   * @param profile array of [radius, y] from bottom to top.
   */
  addLathe(profile, o = {}) {
    const segs = o.seg !== undefined ? o.seg : seg(14);
    const col = o.color || this._c;
    const M = profile.length;
    const base = this.vertexCount;
    for (let i = 0; i < M; i++) {
      const [r, y] = profile[i];
      const a = profile[Math.max(0, i - 1)], b = profile[Math.min(M - 1, i + 1)];
      let dr = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dr, dy) || 1;
      dr /= l; dy /= l;
      for (let j = 0; j <= segs; j++) {
        const th = (j / segs) * TAU + (o.phase || 0);
        const ct = Math.cos(th), st = Math.sin(th);
        _n.set(dy * ct, -dr, dy * st);
        if (_n.lengthSq() < 1e-12) _n.set(ct, 0, st);
        _n.normalize();
        this.vert(r * ct, y, r * st, _n.x, _n.y, _n.z, j / segs, i / (M - 1), col);
      }
    }
    const stride = segs + 1;
    for (let i = 0; i < M - 1; i++) {
      for (let j = 0; j < segs; j++) {
        const a = base + i * stride + j;
        this.quad(a, a + stride, a + stride + 1, a + 1);
      }
    }
  }

  /**
   * Rounded box via SDF projection: sample a subdivided cube, then project each
   * point onto the rounded-box surface. Gives exact normals and a clean bevel.
   * @param o { size:[x,y,z] half-extents, bevel, div, color, center }
   */
  addRoundedBox(o = {}) {
    const hx = o.size[0], hy = o.size[1], hz = o.size[2];
    const bv = Math.min(o.bevel !== undefined ? o.bevel : 0.012, hx * 0.92, hy * 0.92, hz * 0.92);
    const div = o.div || Math.max(2, seg(6) >> 1);
    const col = o.color || this._c;
    const cx = o.center ? o.center[0] : 0, cy = o.center ? o.center[1] : 0, cz = o.center ? o.center[2] : 0;
    const ex = hx - bv, ey = hy - bv, ez = hz - bv;

    // Six faces, each a (div+1)^2 grid in cube space.
    const faces = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    ];
    for (const [ax, u1, u2] of faces) {
      const base = this.vertexCount;
      for (let i = 0; i <= div; i++) {
        for (let j = 0; j <= div; j++) {
          const a = (i / div) * 2 - 1, b = (j / div) * 2 - 1;
          // Each axis-aligned component picks up its own half-extent.
          const px = (ax[0] + u1[0] * a + u2[0] * b) * hx;
          const py = (ax[1] + u1[1] * a + u2[1] * b) * hy;
          const pz = (ax[2] + u1[2] * a + u2[2] * b) * hz;
          const qx = clamp(px, -ex, ex), qy = clamp(py, -ey, ey), qz = clamp(pz, -ez, ez);
          let dx = px - qx, dy = py - qy, dz = pz - qz;
          const dl = Math.hypot(dx, dy, dz);
          if (dl > 1e-9) { dx /= dl; dy /= dl; dz /= dl; }
          else { dx = ax[0]; dy = ax[1]; dz = ax[2]; }
          this.vert(cx + qx + dx * bv, cy + qy + dy * bv, cz + qz + dz * bv, dx, dy, dz, i / div, j / div, col);
        }
      }
      const stride = div + 1;
      for (let i = 0; i < div; i++) {
        for (let j = 0; j < div; j++) {
          const a = base + i * stride + j;
          this.quad(a, a + stride, a + stride + 1, a + 1);
        }
      }
    }
  }

  /**
   * Shaped ellipsoid — the workhorse for skulls, deltoids and hair caps.
   * @param o { radius:[x,y,z], center, seg, rings, displace(dir,u,v)->scale,
   *            phiMax(u)->0..1, phiMin, color }
   * Normals are recovered by finite differences on the parametric surface, so
   * an arbitrary displacement function still shades smoothly.
   */
  addEllipsoid(o = {}) {
    const segs = o.seg !== undefined ? o.seg : seg(18);
    const rings = o.rings !== undefined ? o.rings : seg(14);
    const R = o.radius;
    const cx = o.center ? o.center[0] : 0, cy = o.center ? o.center[1] : 0, cz = o.center ? o.center[2] : 0;
    const disp = o.displace || null;
    const phiMax = o.phiMax || null;
    const phiMin = o.phiMin || 0;
    const col = o.color || this._c;
    const base = this.vertexCount;

    const evalP = (u, v, out) => {
      const th = u * TAU;
      const uw = u - Math.floor(u);                  // theta wraps; keep u in [0,1)
      const pmax = phiMax ? phiMax(uw) : 1;
      const ph = phiMin * Math.PI + v * (pmax - phiMin) * Math.PI;
      const sp = Math.sin(ph), cp = Math.cos(ph);
      const dx = sp * Math.sin(th), dy = cp, dz = sp * Math.cos(th);
      const k = disp ? disp(dx, dy, dz, uw, v) : 1;
      const sx = typeof k === 'number' ? k : k[0];
      const sy = typeof k === 'number' ? k : k[1];
      const sz = typeof k === 'number' ? k : k[2];
      out.set(cx + dx * R[0] * sx, cy + dy * R[1] * sy, cz + dz * R[2] * sz);
      return out;
    };

    const eps = 0.004;
    for (let i = 0; i <= rings; i++) {
      const v = i / rings;
      for (let j = 0; j <= segs; j++) {
        const u = j / segs;
        evalP(u, v, _v);
        evalP(u + eps, v, _v2).sub(_v);
        if (v > 1 - eps) evalP(u, v - eps, _v3).sub(_v).multiplyScalar(-1);
        else evalP(u, v + eps, _v3).sub(_v);
        _n.crossVectors(_v3, _v2);
        if (_n.lengthSq() < 1e-14) _n.set(_v.x - cx, _v.y - cy, _v.z - cz);
        _n.normalize();
        this.vert(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, u, v, col);
      }
    }
    const stride = segs + 1;
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = base + i * stride + j;
        this.quad(a, a + stride, a + stride + 1, a + 1);
      }
    }
  }

  /** Multiply a vertex-colour range by a factor (used for wear + dirt passes). */
  tintRange(v0, v1, f) {
    for (let i = v0 * 3; i < v1 * 3; i++) this.col[i] *= f;
  }

  /**
   * Voxel ambient occlusion. Rasterises vertices into an occupancy grid then
   * marches a short cosine-weighted bundle of rays per vertex. Baking AO into
   * the vertex colour is what gives the character painted creases under the
   * NPR band shader instead of flat gouache.
   */
  bakeAO(o = {}) {
    const n = this.vertexCount;
    if (n === 0) return;
    const res = o.res || 44;
    const strength = o.strength !== undefined ? o.strength : 0.55;
    const radius = o.radius !== undefined ? o.radius : 0.11;

    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = this.pos[i * 3], y = this.pos[i * 3 + 1], z = this.pos[i * 3 + 2];
      if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z;
      if (x > maxx) maxx = x; if (y > maxy) maxy = y; if (z > maxz) maxz = z;
    }
    const pad = 0.02;
    minx -= pad; miny -= pad; minz -= pad; maxx += pad; maxy += pad; maxz += pad;
    const sx = res / (maxx - minx), sy = res / (maxy - miny), sz = res / (maxz - minz);
    const grid = new Uint8Array(res * res * res);
    const cell = (x, y, z) => {
      const gx = ((x - minx) * sx) | 0, gy = ((y - miny) * sy) | 0, gz = ((z - minz) * sz) | 0;
      if (gx < 0 || gy < 0 || gz < 0 || gx >= res || gy >= res || gz >= res) return -1;
      return (gz * res + gy) * res + gx;
    };
    for (let i = 0; i < n; i++) {
      const c = cell(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      if (c >= 0) grid[c] = 1;
    }
    // Also mark triangle centroids so large flat panels occlude properly.
    for (let i = 0; i < this.idx.length; i += 3) {
      const a = this.idx[i] * 3, b = this.idx[i + 1] * 3, c2 = this.idx[i + 2] * 3;
      const c = cell((this.pos[a] + this.pos[b] + this.pos[c2]) / 3,
        (this.pos[a + 1] + this.pos[b + 1] + this.pos[c2 + 1]) / 3,
        (this.pos[a + 2] + this.pos[b + 2] + this.pos[c2 + 2]) / 3);
      if (c >= 0) grid[c] = 1;
    }

    // Fixed cosine-ish hemisphere kernel (in tangent space).
    const K = [
      [0, 0, 1], [0.75, 0, 0.66], [-0.75, 0, 0.66], [0, 0.75, 0.66], [0, -0.75, 0.66],
      [0.53, 0.53, 0.66], [-0.53, 0.53, 0.66], [0.53, -0.53, 0.66], [-0.53, -0.53, 0.66],
    ];
    const steps = 4;
    const tx = new THREE.Vector3(), ty = new THREE.Vector3(), nz = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      nz.set(this.nor[i * 3], this.nor[i * 3 + 1], this.nor[i * 3 + 2]);
      if (Math.abs(nz.y) < 0.9) tx.set(0, 1, 0).cross(nz).normalize();
      else tx.set(1, 0, 0).cross(nz).normalize();
      ty.crossVectors(nz, tx);
      const ox = this.pos[i * 3] + nz.x * 0.012, oy = this.pos[i * 3 + 1] + nz.y * 0.012, oz = this.pos[i * 3 + 2] + nz.z * 0.012;
      let occ = 0;
      for (let k = 0; k < K.length; k++) {
        const dx = tx.x * K[k][0] + ty.x * K[k][1] + nz.x * K[k][2];
        const dy = tx.y * K[k][0] + ty.y * K[k][1] + nz.y * K[k][2];
        const dz = tx.z * K[k][0] + ty.z * K[k][1] + nz.z * K[k][2];
        for (let s = 1; s <= steps; s++) {
          const d = (s / steps) * radius;
          const c = cell(ox + dx * d, oy + dy * d, oz + dz * d);
          if (c >= 0 && grid[c]) { occ += 1 - (s - 1) / steps; break; }
        }
      }
      const ao = 1 - clamp01(occ / K.length) * strength;
      this.col[i * 3] *= ao; this.col[i * 3 + 1] *= ao; this.col[i * 3 + 2] *= ao;
    }
  }

  /**
   * Resolve skin weights and produce the final BufferGeometry.
   * Weight = ws / (d + soft)^p over the primitive's candidate bones only, which
   * keeps the left hand from ever picking up the right thigh.
   */
  finish(rig, o = {}) {
    const n = this.vertexCount;
    const p = o.power !== undefined ? o.power : 4.0;
    const maxInf = 4;
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);

    // Pre-resolve group bone data.
    const resolved = this.groups.map((names) => names.map((nm) => {
      const rw = rig.restWorld[nm];
      return { i: rig.index[nm], head: rw.pos, tail: rw.tail, soft: rw.soft, ws: rw.ws, axial: rw.axial, dir: rw.dir, len: rw.len };
    }));

    const wbuf = new Float32Array(16);
    const ibuf = new Int32Array(16);
    const seg0 = new THREE.Vector3(), segd = new THREE.Vector3(), pv = new THREE.Vector3();

    for (let vi = 0; vi < n; vi++) {
      const cand = resolved[this.vgroup[vi]];
      pv.set(this.pos[vi * 3], this.pos[vi * 3 + 1], this.pos[vi * 3 + 2]);
      let cnt = 0, best = 0;
      for (let k = 0; k < cand.length && k < 16; k++) {
        const c = cand[k];
        let d;
        if (c.axial) {
          // Distance along the bone axis to the [head, tail] span only.
          seg0.copy(pv).sub(c.head);
          const t = seg0.dot(c.dir);
          d = t < 0 ? -t : t > c.len ? t - c.len : 0;
        } else {
          segd.copy(c.tail).sub(c.head);
          const ll = segd.lengthSq() || 1e-9;
          seg0.copy(pv).sub(c.head);
          const t = clamp01(seg0.dot(segd) / ll);
          seg0.addScaledVector(segd, -t);
          d = seg0.length();
        }
        const w = c.ws / Math.pow(d + c.soft, p);
        wbuf[cnt] = w; ibuf[cnt] = c.i; cnt++;
        if (w > best) best = w;
      }
      // Cull negligible influences, then keep the strongest four.
      const cut = best * 0.045;
      for (let k = 0; k < cnt; k++) if (wbuf[k] < cut) wbuf[k] = 0;
      for (let slot = 0; slot < maxInf; slot++) {
        let bi = -1, bw = 0;
        for (let k = 0; k < cnt; k++) if (wbuf[k] > bw) { bw = wbuf[k]; bi = k; }
        if (bi < 0) { si[vi * 4 + slot] = 0; sw[vi * 4 + slot] = 0; continue; }
        si[vi * 4 + slot] = ibuf[bi];
        sw[vi * 4 + slot] = bw;
        wbuf[bi] = 0;
      }
      let tot = sw[vi * 4] + sw[vi * 4 + 1] + sw[vi * 4 + 2] + sw[vi * 4 + 3];
      if (tot <= 0) { sw[vi * 4] = 1; tot = 1; si[vi * 4] = 1; }
      const inv = 1 / tot;
      sw[vi * 4] *= inv; sw[vi * 4 + 1] *= inv; sw[vi * 4 + 2] *= inv; sw[vi * 4 + 3] *= inv;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    // Generous bounds: the bind pose is far tighter than a sprint or a ragdoll.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.65);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-1.2, -0.3, -1.2), new THREE.Vector3(1.2, 2.1, 1.2));
    return g;
  }

  /** Non-skinned geometry (weapons, props). */
  finishStatic() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

let _bodyMat = null, _gearMat = null;

function buildMat(opts, fallbackColor) {
  let m = null;
  try {
    m = makeCanvasMaterial(opts);
  } catch (e) {
    console.warn('[actors] makeCanvasMaterial failed, using fallback', e);
  }
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: fallbackColor, roughness: opts.roughness ?? 0.85, metalness: 0 });
  }
  m.vertexColors = true;              // uniform zones live in the colour attribute
  m.side = THREE.FrontSide;
  m.needsUpdate = true;
  return m;
}

/**
 * The single skinned material every character body shares — one material and
 * one draw call per soldier, all zone colour coming from vertex colours.
 */
export function actorBodyMaterial() {
  if (!_bodyMat) {
    _bodyMat = buildMat({
      color: 0xffffff, roughness: 0.86, hatch: 1.0, rim: 0.5, paper: 0.9,
      skinning: true, vertexColors: true, subsurface: 0.22, outlineWidth: 1.15,
    }, 0xbca77c);
    _bodyMat.name = 'actorBody';
  }
  return _bodyMat;
}

/** Shared non-skinned material for weapons, packs and hard kit. */
export function actorGearMaterial() {
  if (!_gearMat) {
    _gearMat = buildMat({
      color: 0xffffff, roughness: 0.58, hatch: 0.85, rim: 0.85, paper: 0.7,
      skinning: false, vertexColors: true, subsurface: 0.0, outlineWidth: 0.9,
    }, 0x6f6c64);
    _gearMat.name = 'actorGear';
  }
  return _gearMat;
}

// ---------------------------------------------------------------------------
// Body geometry
// ---------------------------------------------------------------------------

const ARM_L = ['clavicleL', 'upperArmL', 'foreArmL', 'handL', 'spine3'];
const ARM_R = ['clavicleR', 'upperArmR', 'foreArmR', 'handR', 'spine3'];
const HAND_L = ['handL', 'fingersL', 'thumbL', 'foreArmL'];
const HAND_R = ['handR', 'fingersR', 'thumbR', 'foreArmR'];
const LEG_L = ['hips', 'thighL', 'shinL', 'footL'];
const LEG_R = ['hips', 'thighR', 'shinR', 'footR'];
const FOOT_L = ['shinL', 'footL', 'toeL'];
const FOOT_R = ['shinR', 'footR', 'toeR'];
const TORSO = ['hips', 'spine1', 'spine2', 'spine3', 'clavicleL', 'clavicleR'];
const NECK = ['spine3', 'neck', 'head'];
const HEAD = ['head', 'headTop', 'neck'];

export const BONE_GROUPS = { ARM_L, ARM_R, HAND_L, HAND_R, LEG_L, LEG_R, FOOT_L, FOOT_R, TORSO, NECK, HEAD };

/** Position of a rest bone, as a plain array (build-time convenience). */
const bp = (rig, name) => {
  const p = rig.restWorld[name].pos;
  return [p.x, p.y, p.z];
};

/**
 * Torso: tunic shell swept along the spine with an elliptical section that
 * narrows at the waist and broadens across the chest, plus a flared hem.
 */
function buildTorso(b, rig, o) {
  const g = o.girth, sh = o.shoulder;
  const hy = rig.restWorld.hips.pos.y, cy = rig.restWorld.spine3.pos.y, ny = rig.restWorld.neck.pos.y;
  const zc = 0.006;
  b.setBones(TORSO).setColor(o.tunic).setMottle(0.075);
  b.addTube([
    { p: [0, hy - 0.135, zc - 0.004], rx: 0.135 * g, rz: 0.098 * g },
    { p: [0, hy - 0.075, zc], rx: 0.155 * g, rz: 0.111 * g },
    { p: [0, hy - 0.005, zc], rx: 0.148 * g, rz: 0.104 * g },
    { p: [0, lerp(hy, cy, 0.32), zc + 0.002], rx: 0.134 * g, rz: 0.096 * g },   // waist
    { p: [0, lerp(hy, cy, 0.62), zc + 0.004], rx: 0.146 * g, rz: 0.101 * g },
    { p: [0, cy - 0.03, zc + 0.006], rx: 0.168 * g * sh, rz: 0.112 * g },       // chest
    { p: [0, cy + 0.055, zc + 0.006], rx: 0.176 * g * sh, rz: 0.114 * g },
    { p: [0, cy + 0.105, zc + 0.004], rx: 0.163 * g * sh, rz: 0.106 * g },      // shoulder shelf
    { p: [0, ny - 0.012, zc], rx: 0.112 * g, rz: 0.083 * g },                    // traps
    { p: [0, ny + 0.012, zc], rx: 0.082 * g, rz: 0.066 * g },
  ], { seg: seg(18), capStart: 'round', capEnd: 'none' });

  // Tunic hem — a short flared skirt that reads as heavy wool.
  const v0 = b.vertexCount;
  b.setColor(o.tunicShade);
  b.addTube([
    { p: [0, hy - 0.055, zc], rx: 0.157 * g, rz: 0.113 * g },
    { p: [0, hy - 0.135, zc - 0.004], rx: 0.171 * g, rz: 0.124 * g },
    { p: [0, hy - 0.185, zc - 0.008], rx: 0.176 * g, rz: 0.129 * g },
    { p: [0, hy - 0.196, zc - 0.009], rx: 0.170 * g, rz: 0.123 * g },
  ], { seg: seg(18), capEnd: 'none' });
  b.tintRange(v0, b.vertexCount, 0.94);

  // Collar.
  b.setColor(o.collar).setMottle(0.05);
  b.addTube([
    { p: [0, ny - 0.014, zc - 0.002], rx: 0.098 * g, rz: 0.079 * g },
    { p: [0, ny + 0.044, zc - 0.002], rx: 0.086 * g, rz: 0.072 * g },
    { p: [0, ny + 0.058, zc - 0.002], rx: 0.080 * g, rz: 0.068 * g },
  ], { seg: seg(16) });

  // Chest placket + buttons: a raised strip down the front centre.
  b.setColor(o.tunicShade);
  b.addTube([
    { p: [0, cy + 0.09, 0.108 * g], rx: 0.021, rz: 0.011 },
    { p: [0, cy - 0.06, 0.116 * g], rx: 0.023, rz: 0.012 },
    { p: [0, hy + 0.03, 0.107 * g], rx: 0.022, rz: 0.011 },
    { p: [0, hy - 0.09, 0.101 * g], rx: 0.020, rz: 0.010 },
  ], { seg: seg(8), capStart: 'round', capEnd: 'round' });
  b.setColor(o.brass);
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const y = lerp(cy + 0.06, hy - 0.055, t);
    b.setTransform(new THREE.Matrix4().makeTranslation(0, y, 0.121 * g));
    b.addLathe([[0, -0.006], [0.0085, -0.004], [0.0095, 0.002], [0.006, 0.005], [0, 0.006]], { seg: seg(8) });
    b.setTransform(null);
  }
}

/** Deltoid caps hide the shoulder seam and give the tunic real shoulders. */
function buildShoulders(b, rig, o) {
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const p = rig.restWorld['upperArm' + s].pos;
    b.setBones(side > 0 ? ARM_L : ARM_R).setColor(o.tunic).setMottle(0.07);
    b.addEllipsoid({
      center: [p.x + side * 0.004, p.y + 0.026, p.z + 0.004],
      radius: [0.073 * o.girth, 0.086 * o.girth, 0.079 * o.girth],
      seg: seg(14), rings: seg(10),
      displace: (dx, dy) => (dy > 0 ? 1 + dy * 0.1 : 1 - dy * dy * 0.16),
    });
  }
}

function buildArms(b, rig, o) {
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const grp = side > 0 ? ARM_L : ARM_R;
    const sh = bp(rig, 'upperArm' + s), el = bp(rig, 'foreArm' + s), wr = bp(rig, 'hand' + s);
    const g = o.girth;
    b.setBones(grp).setColor(o.tunic).setMottle(0.07);
    // Upper arm: sleeve, thickest at the deltoid insertion.
    b.addTube([
      { p: [lerp(sh[0], el[0], -0.12), lerp(sh[1], el[1], -0.12), lerp(sh[2], el[2], -0.12)], rx: 0.056 * g, rz: 0.058 * g },
      { p: [lerp(sh[0], el[0], 0.18), lerp(sh[1], el[1], 0.18), lerp(sh[2], el[2], 0.18)], rx: 0.052 * g, rz: 0.055 * g },
      { p: [lerp(sh[0], el[0], 0.58), lerp(sh[1], el[1], 0.58), lerp(sh[2], el[2], 0.58)], rx: 0.045 * g, rz: 0.048 * g },
      { p: [lerp(sh[0], el[0], 0.94), lerp(sh[1], el[1], 0.94), lerp(sh[2], el[2], 0.94)], rx: 0.042 * g, rz: 0.045 * g },
      { p: el, rx: 0.043 * g, rz: 0.046 * g },
    ], { seg: seg(12) });
    // Forearm: sleeve swelling at the belly of the muscle, cuff at the wrist.
    b.addTube([
      { p: el, rx: 0.043 * g, rz: 0.046 * g },
      { p: [lerp(el[0], wr[0], 0.22), lerp(el[1], wr[1], 0.22), lerp(el[2], wr[2], 0.22)], rx: 0.045 * g, rz: 0.047 * g },
      { p: [lerp(el[0], wr[0], 0.62), lerp(el[1], wr[1], 0.62), lerp(el[2], wr[2], 0.62)], rx: 0.036 * g, rz: 0.038 * g },
      { p: [lerp(el[0], wr[0], 0.86), lerp(el[1], wr[1], 0.86), lerp(el[2], wr[2], 0.86)], rx: 0.031 * g, rz: 0.033 * g },
    ], { seg: seg(12) });
    b.setColor(o.collar);
    b.addTube([
      { p: [lerp(el[0], wr[0], 0.83), lerp(el[1], wr[1], 0.83), lerp(el[2], wr[2], 0.83)], rx: 0.034 * g, rz: 0.036 * g },
      { p: [lerp(el[0], wr[0], 0.99), lerp(el[1], wr[1], 0.99), lerp(el[2], wr[2], 0.99)], rx: 0.031 * g, rz: 0.033 * g },
    ], { seg: seg(12), capEnd: 'none' });
    // Bare wrist.
    b.setBones(side > 0 ? HAND_L : HAND_R).setColor(o.skin).setMottle(0.035);
    b.addTube([
      { p: [lerp(el[0], wr[0], 0.97), lerp(el[1], wr[1], 0.97), lerp(el[2], wr[2], 0.97)], rx: 0.029, rz: 0.031 },
      { p: wr, rx: 0.028, rz: 0.030 },
    ], { seg: seg(10) });
  }
}

function buildHands(b, rig, o) {
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const grp = side > 0 ? HAND_L : HAND_R;
    const wr = rig.restWorld['hand' + s].pos, fg = rig.restWorld['fingers' + s].pos;
    const col = o.gloves ? o.glove : o.skin;
    b.setBones(grp).setColor(col).setMottle(0.04);
    // Palm — a flattened rounded box aligned with the forearm.
    const q = new THREE.Quaternion().copy(rig.restWorld['hand' + s].quat);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(lerp(wr.x, fg.x, 0.42), lerp(wr.y, fg.y, 0.42), lerp(wr.z, fg.z, 0.42) + 0.002), q, new THREE.Vector3(1, 1, 1));
    b.setTransform(m);
    b.addRoundedBox({ size: [0.017, 0.045, 0.037], bevel: 0.014, div: 3 });
    b.setTransform(null);
    // Fingers: three merged blocks + a separate index so a trigger grip reads.
    b.setBones([`fingers${s}`, `hand${s}`]);
    const dir = new THREE.Vector3().copy(fg).sub(wr).normalize();
    for (let f = 0; f < 4; f++) {
      const lat = (f - 1.5) * 0.017;
      const len = 0.052 - Math.abs(f - 1.2) * 0.006;
      const px = fg.x - side * 0.0 + side * lat * 0.25, pz = fg.z + lat * 0.95;
      b.addTube([
        { p: [px - side * 0.001, fg.y + 0.028, pz], rx: 0.0095, rz: 0.0088 },
        { p: [px + dir.x * len * 0.5, fg.y + 0.028 + dir.y * len * 0.5, pz + dir.z * len * 0.5], rx: 0.0092, rz: 0.0085 },
        { p: [px + dir.x * len, fg.y + 0.028 + dir.y * len, pz + dir.z * len], rx: 0.0072, rz: 0.0068 },
      ], { seg: seg(7), capStart: 'round', capEnd: 'round' });
    }
    // Thumb.
    b.setBones([`thumb${s}`, `hand${s}`]);
    const th = rig.restWorld['thumb' + s];
    b.addTube([
      { p: [th.pos.x, th.pos.y, th.pos.z], rx: 0.0115, rz: 0.0105 },
      { p: [th.tail.x, th.tail.y, th.tail.z], rx: 0.0085, rz: 0.0080 },
    ], { seg: seg(7), capStart: 'round', capEnd: 'round' });
  }
}

function buildLegs(b, rig, o) {
  const g = o.girth;
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const grp = side > 0 ? LEG_L : LEG_R;
    const hp = bp(rig, 'thigh' + s), kn = bp(rig, 'shin' + s), an = bp(rig, 'foot' + s);
    b.setBones(grp).setColor(o.trouser).setMottle(0.07);
    b.addTube([
      { p: [hp[0], hp[1] + 0.055, hp[2]], rx: 0.085 * g, rz: 0.088 * g },
      { p: [lerp(hp[0], kn[0], 0.14), lerp(hp[1], kn[1], 0.14), lerp(hp[2], kn[2], 0.14)], rx: 0.082 * g, rz: 0.086 * g },
      { p: [lerp(hp[0], kn[0], 0.52), lerp(hp[1], kn[1], 0.52), lerp(hp[2], kn[2], 0.52)], rx: 0.071 * g, rz: 0.076 * g },
      { p: [lerp(hp[0], kn[0], 0.9), lerp(hp[1], kn[1], 0.9), lerp(hp[2], kn[2], 0.9)], rx: 0.059 * g, rz: 0.062 * g },
      { p: kn, rx: 0.058 * g, rz: 0.061 * g },
      { p: [lerp(kn[0], an[0], 0.18), lerp(kn[1], an[1], 0.18), lerp(kn[2], an[2], 0.18)], rx: 0.062 * g, rz: 0.067 * g }, // calf
      { p: [lerp(kn[0], an[0], 0.42), lerp(kn[1], an[1], 0.42), lerp(kn[2], an[2], 0.42)], rx: 0.056 * g, rz: 0.059 * g },
    ], { seg: seg(13), capStart: 'round' });
    // Trouser blousing over the boot top.
    b.setColor(o.trouserCuff);
    b.addTube([
      { p: [lerp(kn[0], an[0], 0.40), lerp(kn[1], an[1], 0.40), lerp(kn[2], an[2], 0.40)], rx: 0.058 * g, rz: 0.061 * g },
      { p: [lerp(kn[0], an[0], 0.52), lerp(kn[1], an[1], 0.52), lerp(kn[2], an[2], 0.52)], rx: 0.064 * g, rz: 0.067 * g },
      { p: [lerp(kn[0], an[0], 0.60), lerp(kn[1], an[1], 0.60), lerp(kn[2], an[2], 0.60)], rx: 0.058 * g, rz: 0.061 * g },
    ], { seg: seg(13) });
  }
}

function buildBoots(b, rig, o) {
  const g = o.girth;
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const grp = side > 0 ? FOOT_L : FOOT_R;
    const kn = bp(rig, 'shin' + s), an = rig.restWorld['foot' + s].pos, to = rig.restWorld['toe' + s].pos;
    b.setBones(grp).setColor(o.boot).setMottle(0.05);
    // Shaft up the lower shin.
    b.addTube([
      { p: [lerp(kn[0], an.x, 0.52), lerp(kn[1], an.y, 0.52), lerp(kn[2], an.z, 0.52)], rx: 0.055 * g, rz: 0.058 * g },
      { p: [lerp(kn[0], an.x, 0.74), lerp(kn[1], an.y, 0.74), lerp(kn[2], an.z, 0.74)], rx: 0.049 * g, rz: 0.053 * g },
      { p: [an.x, an.y + 0.012, an.z + 0.004], rx: 0.046 * g, rz: 0.052 * g },
    ], { seg: seg(12), capStart: 'flat' });
    // Foot: heel block, instep and rounded toe cap.
    const fwd = new THREE.Vector3(to.x - an.x, 0, to.z - an.z).normalize();
    const heel = new THREE.Vector3(an.x - fwd.x * 0.055, an.y - 0.05, an.z - fwd.z * 0.055);
    const ball = new THREE.Vector3(to.x, an.y - 0.058, to.z);
    const tip = new THREE.Vector3(to.x + fwd.x * 0.055, an.y - 0.052, to.z + fwd.z * 0.055);
    b.addTube([
      { p: [heel.x, heel.y + 0.014, heel.z], rx: 0.041, rz: 0.030 },
      { p: [an.x, an.y - 0.022, an.z], rx: 0.046, rz: 0.042 },
      { p: [lerp(an.x, ball.x, 0.5), an.y - 0.04, lerp(an.z, ball.z, 0.5)], rx: 0.048, rz: 0.044 },
      { p: [ball.x, ball.y + 0.014, ball.z], rx: 0.046, rz: 0.038 },
      { p: [tip.x, tip.y + 0.012, tip.z], rx: 0.036, rz: 0.026 },
    ], { seg: seg(12), capStart: 'round', capEnd: 'round' });
    // Sole slab.
    b.setColor(o.bootSole);
    b.addTube([
      { p: [heel.x, an.y - 0.062, heel.z], rx: 0.042, rz: 0.012 },
      { p: [an.x, an.y - 0.070, an.z], rx: 0.047, rz: 0.013 },
      { p: [ball.x, an.y - 0.072, ball.z], rx: 0.047, rz: 0.013 },
      { p: [tip.x, an.y - 0.068, tip.z], rx: 0.036, rz: 0.011 },
    ], { seg: seg(10), capStart: 'round', capEnd: 'round' });
  }
}

function buildNeck(b, rig, o) {
  const ny = rig.restWorld.neck.pos.y, hy = rig.restWorld.head.pos.y;
  b.setBones(NECK).setColor(o.skin).setMottle(0.035);
  b.addTube([
    { p: [0, ny - 0.02, 0.002], rx: 0.058, rz: 0.054 },
    { p: [0, ny + 0.03, 0.004], rx: 0.050, rz: 0.047 },
    { p: [0, hy + 0.005, 0.006], rx: 0.047, rz: 0.046 },
  ], { seg: seg(12) });
}

/**
 * Head. A displaced ellipsoid drives the skull, jaw, brow and cheeks from a
 * seeded parameter set; nose, ears, brows, eyes and mouth are separate pieces
 * so they survive at low ring counts.
 * @param f face parameters, see character.js makeFaceParams()
 */
export function buildHead(b, rig, o, f) {
  const hb = rig.restWorld.head.pos;
  const hs = rig.proportions.head;
  // Deliberately oversized: VC's stylised-realistic proportion is ~6.9 heads
  // tall, not the ~8 heads a strictly anatomical skull on this skeleton gives.
  const cx = 0, cy = hb.y + 0.074 * hs, cz = hb.z + 0.004;
  const R = [0.100 * f.width * hs, 0.132 * f.length * hs, 0.118 * f.depth * hs];

  b.setBones(HEAD).setColor(o.skin).setMottle(0.03);
  b.addEllipsoid({
    center: [cx, cy, cz], radius: R, seg: seg(22), rings: seg(16),
    displace: (dx, dy, dz) => {
      let sx = 1, sy = 1, sz = 1;
      const front = clamp01(dz);
      // Jaw + chin: narrow the lower third, push the chin forward.
      const low = clamp01((-dy - 0.05) / 0.85);
      sx -= low * (0.24 - f.jaw * 0.16);
      sz -= low * 0.06 * (1 - f.chin);
      if (dy < -0.35 && dz > 0.25) sz += (f.chin * 0.10) * smoothstep(0.25, 0.8, dz) * smoothstep(-0.35, -0.75, dy);
      // Cranium: slightly boxy at the back, tapered at the temples.
      const up = clamp01(dy);
      sx += up * up * 0.045 * f.cranium;
      if (dz < -0.3) sz += 0.045 * f.cranium * smoothstep(-0.3, -0.9, dz);
      // Brow ridge.
      const brow = smoothstep(0.05, 0.32, dy) * (1 - smoothstep(0.32, 0.62, dy)) * front;
      sz += brow * 0.05 * f.brow;
      // Eye sockets — a shallow recess so the eye pieces sit in shadow.
      const eye = smoothstep(0.55, 0.95, front) * Math.exp(-Math.pow((dy - 0.03) / 0.16, 2)) * Math.exp(-Math.pow((Math.abs(dx) - 0.42) / 0.26, 2));
      sz -= eye * 0.045;
      // Cheekbones.
      const cheek = Math.exp(-Math.pow((dy + 0.16) / 0.2, 2)) * Math.exp(-Math.pow((Math.abs(dx) - 0.6) / 0.3, 2)) * clamp01(dz + 0.2);
      sx += cheek * 0.055 * f.cheek;
      sz += cheek * 0.02 * f.cheek;
      // Temples pinch.
      const temple = Math.exp(-Math.pow((dy - 0.28) / 0.2, 2)) * Math.exp(-Math.pow((Math.abs(dx) - 0.85) / 0.3, 2));
      sx -= temple * 0.035;
      // Flatten the very top a touch — helmets have to sit somewhere.
      if (dy > 0.8) sy -= (dy - 0.8) * 0.09;
      return [sx, sy, sz];
    },
  });

  // Nose.
  const nz = cz + R[2] * 0.92, nyTop = cy + R[1] * 0.10;
  b.addTube([
    { p: [0, nyTop, nz - 0.014], rx: 0.013, rz: 0.012 },
    { p: [0, nyTop - 0.034 * f.length, nz + 0.005 * f.nose], rx: 0.0125, rz: 0.014 * f.nose },
    { p: [0, nyTop - 0.060 * f.length, nz + 0.013 * f.nose], rx: 0.0162, rz: 0.019 * f.nose },
    { p: [0, nyTop - 0.074 * f.length, nz + 0.007 * f.nose], rx: 0.0174, rz: 0.014 * f.nose },
  ], { seg: seg(9), capEnd: 'round' });

  // Ears.
  for (const side of [1, -1]) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(side * R[0] * 0.94, cy - 0.004, cz - R[2] * 0.30),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, side * 1.35, 0)),
      new THREE.Vector3(1, 1, 1));
    b.setTransform(m);
    b.addEllipsoid({
      radius: [0.024, 0.036 * f.ear, 0.013], seg: seg(9), rings: seg(7),
      displace: (dx, dy, dz) => [1, 1, dz > 0 ? 1 - 0.45 * clamp01(1 - Math.hypot(dx, dy) * 1.5) : 1],
    });
    b.setTransform(null);
  }

  // Eyes — sclera lens plus a dark iris disc, VC's flat graphic eye.
  const eyeY = cy + R[1] * 0.05, eyeX = R[0] * 0.44, eyeZ = cz + R[2] * 0.80;
  for (const side of [1, -1]) {
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.06, side * 0.30, side * -0.06));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(side * eyeX, eyeY, eyeZ), rot, new THREE.Vector3(1, 1, 1));
    b.setTransform(m);
    b.setColor(PALETTE.eyeWhite).setMottle(0);
    b.addEllipsoid({ radius: [0.0172 * f.eye, 0.0112 * f.eye, 0.007], seg: seg(10), rings: seg(6) });
    b.setColor(f.eyeColor);
    b.setTransform(new THREE.Matrix4().compose(new THREE.Vector3(side * eyeX, eyeY, eyeZ + 0.0035), rot, new THREE.Vector3(1, 1, 1)));
    b.addEllipsoid({ radius: [0.0080 * f.eye, 0.0088 * f.eye, 0.0042], seg: seg(9), rings: seg(5) });
    b.setTransform(null);
  }

  // Brows.
  b.setColor(f.hairColor).setMottle(0.03);
  for (const side of [1, -1]) {
    const y = cy + R[1] * (0.155 + f.browHeight * 0.05);
    b.addTube([
      { p: [side * (eyeX - 0.014), y - 0.002, eyeZ + 0.0008], rx: 0.005, rz: 0.0044 },
      { p: [side * eyeX, y + 0.0044, eyeZ + 0.0020], rx: 0.0060, rz: 0.005 },
      { p: [side * (eyeX + 0.016), y + 0.001, eyeZ - 0.004], rx: 0.0045, rz: 0.0038 },
    ], { seg: seg(6), capStart: 'round', capEnd: 'round' });
  }

  // Mouth line.
  b.setColor(PALETTE.lip).setMottle(0.02);
  const my = cy - R[1] * 0.53;
  b.addTube([
    { p: [-0.016 * f.width, my + 0.002, cz + R[2] * 0.68], rx: 0.0044, rz: 0.0038 },
    { p: [0, my, cz + R[2] * 0.80], rx: 0.0062, rz: 0.0052 },
    { p: [0.016 * f.width, my + 0.002, cz + R[2] * 0.68], rx: 0.0044, rz: 0.0038 },
  ], { seg: seg(6), capStart: 'round', capEnd: 'round' });

  b.setMottle(0.06);
  return { center: [cx, cy, cz], radius: R };
}

/**
 * Assemble the full soldier body (no class gear — character.js adds that into
 * the same builder before finish()).
 */
export function buildBody(b, rig, o) {
  buildTorso(b, rig, o);
  buildShoulders(b, rig, o);
  buildArms(b, rig, o);
  buildHands(b, rig, o);
  buildLegs(b, rig, o);
  buildBoots(b, rig, o);
  buildNeck(b, rig, o);
}

/**
 * Bind a finished geometry to the rig. The character group MUST still be at
 * the identity transform when this runs: Skeleton inverses are captured from
 * the bones' current world matrices and the bind matrix is identity.
 */
export function createSkinnedBody(geometry, rig, material) {
  const mesh = new THREE.SkinnedMesh(geometry, material || actorBodyMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  mesh.userData.outline = true;
  mesh.add(rig.root);
  rig.root.updateMatrixWorld(true);
  mesh.bind(rig.skeleton, new THREE.Matrix4());
  return mesh;
}
