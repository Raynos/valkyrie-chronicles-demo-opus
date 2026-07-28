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
// NOTE ON VALUE SEPARATION: every zone here has to survive the NPR band shader,
// which quantises luminance to 3–4 steps. Two colours less than ~15% apart in
// luminance land in the SAME band and the soldier renders as one undifferentiated
// mannequin — which is exactly what the old tunic (0xbca77c, L≈0.66) did against
// bare skin (0xe8bd95, L≈0.78). Keep tunic/trouser a clear band below skin.
export const PALETTE = {
  tunic: rgbLin(0x9d8a5c),
  tunicShade: rgbLin(0x81714a),
  // Headgear is deliberately a clear step DARKER and greener than the tunic.
  // A cap in tunic colour sitting on a tan face reads as a bald head with a
  // stripe on it — which is exactly what the overview shot showed.
  cap: rgbLin(0x6f6a41),
  capShade: rgbLin(0x585534),
  collar: rgbLin(0x6d5c3c),
  trouser: rgbLin(0x77704a),
  trouserCuff: rgbLin(0x615c3d),
  leather: rgbLin(0x5b4531),
  belt: rgbLin(0x473527),
  boot: rgbLin(0x3d2d22),
  bootSole: rgbLin(0x2e2620),
  bootWelt: rgbLin(0x51392a),
  glove: rgbLin(0x6d5238),
  metal: rgbLin(0x6f6c64),
  metalDark: rgbLin(0x44413c),
  brass: rgbLin(0x9c7e47),
  trim: rgbLin(0xe8dec4),
  accent: rgbLin(0x8f3c2d),
  wood: rgbLin(0x7c5535),
  canvas: rgbLin(0x8e8460),
  scarf: rgbLin(0xd8ccab),
  // NOT paper-white. At 20 m the sclera is two pixels and a 0xefe8de lens under
  // the warm key blooms into a pair of glowing dots where the eyes should be —
  // the darker lash line has to be the thing that survives, not the white.
  eyeWhite: rgbLin(0xcfc6b6),
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

// Hair has to survive the palette-discipline rule as well as the band shader.
// The old auburn 0x9a4a2b measured HSV sat 0.72 and under the warm key + bloom
// it blew out to a saturated orange band across the back of every helmeted
// head — the "smeared red band" the overview critique named. Everything here
// now sits under sat 0.45.
export const HAIR_TONES = [
  rgbLin(0x2b2320), rgbLin(0x3a2b21), rgbLin(0x4b3a24), rgbLin(0x6a5133),
  rgbLin(0x87693e), rgbLin(0xa8905e), rgbLin(0x7a5236), rgbLin(0x6d6154),
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

// PROPORTION CONTRACT (canonical 'medium' soldier, metres):
//   sole 0.000 · hip 0.955 · shoulder 1.389 · chin 1.4985 · crown 1.737
// which is 7.28 heads tall with a 0.160 x 0.233 x 0.197 m skull — VC's
// stylised-realistic figure. The previous table put the shoulders at 1.362 and
// the head bone at 1.497 with a 0.195 x 0.252 x 0.228 skull: 6.4 heads, a head
// 22% too wide, and only 13 mm of throat between the collar and the jaw, which
// is why every soldier read as a balloon on a sack. Shoulders up 27 mm, neck
// bone up 42 mm, head bone up 52 mm, skull down 18% in width and 8% in height.
export const BONE_DEFS = [
  B('root', null, [0, 0, 0], { soft: 0.4, ws: 0.001, tail: [0, 0.2, 0] }),
  B('hips', 'root', [0, 0.955, 0], { soft: 0.06, ws: 1.15, axial: true, tail: [0, 1.060, 0] }),
  B('spine1', 'hips', [0, 1.060, 0], { soft: 0.045, axial: true }),
  B('spine2', 'spine1', [0, 1.168, 0.004], { soft: 0.045, axial: true }),
  B('spine3', 'spine2', [0, 1.288, 0.006], { soft: 0.05, axial: true, ws: 1.05 }),
  B('neck', 'spine3', [0, 1.450, 0.006], { soft: 0.03, axial: true }),
  B('head', 'neck', [0, 1.549, 0.006], { soft: 0.05, ws: 1.3, tail: [0, 1.700, 0.014] }),
  B('headTop', 'head', [0, 1.700, 0.014], { soft: 0.09, ws: 0.2, tail: [0, 1.82, 0.014] }),

  B('clavicleL', 'spine3', [0.038, 1.405, 0.016], { soft: 0.05, ws: 0.85 }),
  B('upperArmL', 'clavicleL', [0.181, 1.389, 0.004], { soft: 0.05 }),
  B('foreArmL', 'upperArmL', [0.203, 1.112, 0.012], { soft: 0.048 }),
  B('handL', 'foreArmL', [0.220, 0.859, 0.016], { soft: 0.028, ws: 1.1, tail: [0.226, 0.771, 0.022] }),
  B('fingersL', 'handL', [0.226, 0.771, 0.022], { soft: 0.02, tail: [0.228, 0.718, 0.027] }),
  B('thumbL', 'handL', [0.198, 0.813, 0.046], { soft: 0.018, ws: 0.9, tail: [0.190, 0.785, 0.073] }),

  B('clavicleR', 'spine3', [-0.038, 1.405, 0.016], { soft: 0.05, ws: 0.85 }),
  B('upperArmR', 'clavicleR', [-0.181, 1.389, 0.004], { soft: 0.05 }),
  B('foreArmR', 'upperArmR', [-0.203, 1.112, 0.012], { soft: 0.048 }),
  B('handR', 'foreArmR', [-0.220, 0.859, 0.016], { soft: 0.028, ws: 1.1, tail: [-0.226, 0.771, 0.022] }),
  B('fingersR', 'handR', [-0.226, 0.771, 0.022], { soft: 0.02, tail: [-0.228, 0.718, 0.027] }),
  B('thumbR', 'handR', [-0.198, 0.813, 0.046], { soft: 0.018, ws: 0.9, tail: [-0.190, 0.785, 0.073] }),

  B('thighL', 'hips', [0.095, 0.919, 0.002], { soft: 0.058 }),
  B('shinL', 'thighL', [0.100, 0.508, 0.013], { soft: 0.05 }),
  B('footL', 'shinL', [0.103, 0.082, -0.016], { soft: 0.035, ws: 1.1 }),
  B('toeL', 'footL', [0.103, 0.024, 0.112], { soft: 0.022, tail: [0.103, 0.020, 0.166] }),

  B('thighR', 'hips', [-0.095, 0.919, 0.002], { soft: 0.058 }),
  B('shinR', 'thighR', [-0.100, 0.508, 0.013], { soft: 0.05 }),
  B('footR', 'shinR', [-0.103, 0.082, -0.016], { soft: 0.035, ws: 1.1 }),
  B('toeR', 'footR', [-0.103, 0.024, 0.112], { soft: 0.022, tail: [-0.103, 0.020, 0.166] }),
];

export const BONE_NAMES = BONE_DEFS.map((b) => b.name);

/**
 * Body-type variants. A six-person squad picks from these so nobody looks cloned.
 *
 * `height` used to double up with `legs`/`torso`: the bone table was scaled by
 * legs+torso AND the whole group scaled again by height, so a `tall` soldier
 * came out 1.99 m and a `petite` one 1.61 m. It is now a small trim on top of
 * the table, and `head` stays inside +/-3% so no body type falls out of the
 * 7.0-7.5 heads window.
 */
export const BODY_TYPES = {
  medium: { height: 1.000, legs: 1.000, torso: 1.000, shoulder: 1.000, hip: 1.000, girth: 1.00, arm: 1.00, head: 1.000 },
  lean: { height: 1.005, legs: 1.030, torso: 0.990, shoulder: 0.955, hip: 0.960, girth: 0.90, arm: 1.03, head: 0.998 },
  stocky: { height: 0.985, legs: 0.965, torso: 1.015, shoulder: 1.070, hip: 1.055, girth: 1.15, arm: 0.97, head: 0.990 },
  tall: { height: 1.015, legs: 1.035, torso: 1.018, shoulder: 1.020, hip: 0.990, girth: 0.98, arm: 1.04, head: 1.005 },
  petite: { height: 0.968, legs: 0.960, torso: 0.978, shoulder: 0.905, hip: 1.015, girth: 0.88, arm: 0.95, head: 1.012 },
};

// Reference heights the body-type scaler pivots around. These MUST track the
// BONE_DEFS table above — they are the hip, shoulder and head-bone rows.
const HIP_Y = 0.955;
const SHOULDER_Y = 1.389;
const HEAD_Y = 1.549;

/**
 * Distance, in rig units, from the ankle bone down to the UNDERSIDE OF THE
 * SOLE. buildBoots() authors the whole boot against this number, and
 * anim.js's foot IK plants the ankle exactly this far above the terrain, so
 * the two must not drift apart. Change it here or the squad sinks.
 */
export const SOLE_DROP = 0.082;

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
      const sy = HIP_Y * P.legs + (SHOULDER_Y - HIP_Y) * P.torso;
      y = sy + (y - sy) * P.arm;
      if (d.name.startsWith('clavicle')) y = sy + (y - sy);
    } else if (isLeg) {
      x *= P.hip;
    } else if (/^(head|headTop)/.test(d.name)) {
      const ny = HIP_Y * P.legs + (HEAD_Y - HIP_Y) * P.torso;
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
      // hatch is deliberately LOW on skin and cloth. VC hatches its terrain and
      // its masonry; it does not scribble graphite across a face. At hatch 1.0
      // the screen-space stripe field rode straight over the cheek and the
      // throat of every closeup and turned the portrait into a woodcut.
      color: 0xffffff, roughness: 0.86, hatch: 0.34, rim: 0.5, paper: 0.9,
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
 * A partial ring: a tube swept along an elliptical arc about (0, y, zc).
 * Collars, cuffs and open plackets all need an arc rather than a closed lathe,
 * because the GAP is the thing that reads — a full band round the neck is a
 * pipe, an arc with an opening at the throat is a collar.
 */
function addArc(b, o) {
  const n = o.div || 9;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = lerp(o.a0, o.a1, t);
    pts.push({
      p: [Math.sin(a) * o.rx, o.y + (o.dy ? o.dy(t) : 0), o.zc + Math.cos(a) * o.rz],
      rx: o.tx * (o.taper ? o.taper(t) : 1),
      rz: o.tz * (o.taper ? o.taper(t) : 1),
    });
  }
  b.addTube(pts, { seg: o.seg || seg(8), capStart: o.cap || 'round', capEnd: o.cap || 'round' });
}

/**
 * Torso: tunic shell swept along the spine.
 *
 * The old section list ran 0.135 -> 0.176 over the whole trunk — a 30% swell
 * spread across 45 cm, i.e. a sack. VC's uniform silhouette is a WEDGE: a
 * narrow waist, a broad chest, and a hard shoulder shelf the deltoid sits on.
 * The waist is now 0.128 and the upper chest 0.178 (a 39% swell over 29 cm),
 * which both reads as a torso and gives the band quantiser a surface whose
 * normal actually sweeps through a terminator, instead of a near-cylinder that
 * lands entirely inside one band.
 */
function buildTorso(b, rig, o) {
  const g = o.girth, sh = o.shoulder;
  const hy = rig.restWorld.hips.pos.y, ny = rig.restWorld.neck.pos.y;
  const zc = 0.006;
  b.setBones(TORSO).setColor(o.tunic).setMottle(0.075);
  b.addTube([
    { p: [0, hy - 0.150, zc - 0.006], rx: 0.128 * g, rz: 0.095 * g },
    { p: [0, hy - 0.075, zc - 0.002], rx: 0.153 * g, rz: 0.113 * g },      // hip shelf
    { p: [0, hy - 0.010, zc], rx: 0.146 * g, rz: 0.106 * g },
    { p: [0, hy + 0.090, zc + 0.004], rx: 0.128 * g, rz: 0.095 * g },      // waist (narrowest)
    { p: [0, hy + 0.190, zc + 0.006], rx: 0.144 * g, rz: 0.101 * g },      // lower ribs
    { p: [0, hy + 0.300, zc + 0.008], rx: 0.163 * g * sh, rz: 0.112 * g }, // chest
    { p: [0, hy + 0.380, zc + 0.008], rx: 0.178 * g * sh, rz: 0.114 * g }, // upper chest
    { p: [0, hy + 0.445, zc + 0.004], rx: 0.172 * g * sh, rz: 0.106 * g }, // shoulder shelf
    { p: [0, ny - 0.038, zc], rx: 0.126 * g, rz: 0.090 * g },              // traps
    { p: [0, ny - 0.020, zc + 0.002], rx: 0.090 * g, rz: 0.074 * g },      // neck hole
  ], { seg: seg(18), capStart: 'round', capEnd: 'none' });

  // Pectoral planes — two shallow shields on the front of the chest. Without
  // them the chest is a smooth cylinder and the shading has nothing to bite on.
  b.setColor(o.tunic).setMottle(0.06);
  for (const side of [1, -1]) {
    b.addEllipsoid({
      center: [side * 0.062 * g, hy + 0.328, zc + 0.056 * g],
      radius: [0.074 * g, 0.072 * g, 0.062 * g],
      seg: seg(12), rings: seg(8),
      displace: (dx, dy, dz) => [1, 1, 0.52 + 0.48 * clamp01(dz)],
    });
  }

  // Tunic hem — a short skirt below the belt line. It starts at hy+0.030 (just
  // under the belt) rather than hy-0.040, where it used to swallow the belt
  // entirely: the skirt was 0.155*g and the belt only 0.143*g, so the one
  // horizontal accent that cuts the figure at the waist was buried inside the
  // cloth and every soldier read as an unbroken sack from collar to knee.
  const v0 = b.vertexCount;
  b.setColor(o.tunicShade);
  b.addTube([
    { p: [0, hy + 0.030, zc + 0.002], rx: 0.138 * g, rz: 0.100 * g },
    { p: [0, hy - 0.055, zc - 0.002], rx: 0.158 * g, rz: 0.117 * g },
    { p: [0, hy - 0.130, zc - 0.006], rx: 0.166 * g, rz: 0.122 * g },
    { p: [0, hy - 0.148, zc - 0.007], rx: 0.157 * g, rz: 0.114 * g },
  ], { seg: seg(18), capEnd: 'none' });
  b.tintRange(v0, b.vertexCount, 0.94);

  // --- Collar. An OPEN stand collar: two arcs sweeping from the throat round
  // to the nape, with the gap at the front. There is now 40 mm of visible neck
  // above it (chin 1.4985, collar top 1.462) where the old build left 13 mm.
  // The collar sits ON the tunic's neck hole (0.090*g) and stands ~0.018 proud
  // of it, so the whole arc is outside the shell. Placed any tighter it
  // disappears inside the trapezius cone and only the piping pokes through,
  // which reads as a couple of cream splinters sticking out of the shoulders.
  const colY = ny - 0.018;
  const colR = 0.098 * g, colD = 0.081 * g;
  for (const side of [1, -1]) {
    b.setColor(o.collar).setMottle(0.045);
    addArc(b, {
      y: colY, zc: zc - 0.002, rx: colR, rz: colD,
      a0: side * 0.44, a1: side * 2.76, tx: 0.015, tz: 0.012, div: 8,
      dy: (t) => 0.018 * smoothstep(0, 0.55, t), seg: seg(7),
    });
    // Cream piping along the collar's top edge — VC's uniforms are trimmed.
    b.setColor(o.trim).setMottle(0.02);
    addArc(b, {
      y: colY + 0.013, zc: zc - 0.002, rx: colR, rz: colD,
      a0: side * 0.47, a1: side * 2.73, tx: 0.0034, tz: 0.0030, div: 8,
      dy: (t) => 0.018 * smoothstep(0, 0.55, t), seg: seg(5),
    });
    // Lapel point: the collar corner folding down onto the chest.
    b.setColor(o.collar).setMottle(0.04);
    b.addTube([
      { p: [side * 0.040 * g, colY + 0.014, zc + 0.074 * g], rx: 0.016, rz: 0.008 },
      { p: [side * 0.062 * g, colY - 0.028, zc + 0.086 * g], rx: 0.018, rz: 0.009 },
      { p: [side * 0.068 * g, colY - 0.060, zc + 0.084 * g], rx: 0.010, rz: 0.006 },
    ], { seg: seg(7), capStart: 'flat', capEnd: 'round' });
  }

  // Shoulder yoke: a second layer of cloth over the shoulders with a piped
  // edge. This is the piece that makes the silhouette read as a UNIFORM rather
  // than a jumper, and its hard lower edge is a permanent ink line across the
  // chest no matter how the light falls.
  b.setColor(o.tunicShade).setMottle(0.055);
  b.addTube([
    { p: [0, hy + 0.442, zc + 0.004], rx: 0.180 * g * sh, rz: 0.111 * g },
    { p: [0, hy + 0.386, zc + 0.008], rx: 0.185 * g * sh, rz: 0.120 * g },
    { p: [0, hy + 0.332, zc + 0.008], rx: 0.173 * g * sh, rz: 0.119 * g },
    { p: [0, hy + 0.318, zc + 0.008], rx: 0.167 * g * sh, rz: 0.115 * g },
  ], { seg: seg(18), capEnd: 'none' });
  // Yoke piping. Kept to a MUTED ochre rather than the cream used on the
  // collar: a 2 mm pure-cream tube round the chest at 5 m renders as a single
  // blown-out pixel line and reads as a wire stretched across the soldier's
  // back, not as a piped seam.
  b.setColor(mixCol(o.trim, o.tunicShade, 0.55)).setMottle(0.03);
  b.addTube([
    { p: [0, hy + 0.328, zc + 0.008], rx: 0.1725 * g * sh, rz: 0.1190 * g },
    { p: [0, hy + 0.318, zc + 0.008], rx: 0.1735 * g * sh, rz: 0.1198 * g },
    { p: [0, hy + 0.310, zc + 0.008], rx: 0.1725 * g * sh, rz: 0.1190 * g },
  ], { seg: seg(18), capEnd: 'none' });

  // Chest placket + buttons: a raised strip down the front centre.
  b.setColor(o.tunicShade).setMottle(0.05);
  b.addTube([
    { p: [0, colY - 0.028, 0.084 * g], rx: 0.020, rz: 0.010 },
    { p: [0, hy + 0.300, 0.112 * g], rx: 0.023, rz: 0.012 },
    { p: [0, hy + 0.120, 0.106 * g], rx: 0.022, rz: 0.011 },
    { p: [0, hy - 0.040, 0.108 * g], rx: 0.020, rz: 0.010 },
  ], { seg: seg(8), capStart: 'round', capEnd: 'round' });
  b.setColor(o.brass);
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const y = lerp(hy + 0.300, hy + 0.000, t);
    b.setTransform(new THREE.Matrix4().makeTranslation(0, y, 0.121 * g));
    b.addLathe([[0, -0.006], [0.0085, -0.004], [0.0095, 0.002], [0.006, 0.005], [0, 0.006]], { seg: seg(8) });
    b.setTransform(null);
  }
}

/**
 * Deltoid caps hide the shoulder seam and give the tunic real shoulders.
 *
 * These were spheres of a fixed radius centred on the humerus head — read as
 * two detached balls stuck on the sides of the ribcage, the single loudest
 * "procedural mannequin" tell in the close shots. Now: pulled INBOARD so the
 * cap genuinely overlaps the chest tube, squashed vertically into a shoulder
 * shelf rather than a ball, and swept down the humerus so it blends into the
 * sleeve instead of ending in a hard equator.
 */
function buildShoulders(b, rig, o) {
  const g = o.girth;
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const p = rig.restWorld['upperArm' + s].pos;
    const cl = rig.restWorld['clavicle' + s].pos;
    // Sit the cap between the clavicle tip and the humerus head: that is where
    // an actual deltoid is, and it guarantees an overlap with the chest.
    const px = lerp(cl.x, p.x, 0.60), pz = lerp(cl.z, p.z, 0.70);
    b.setBones(side > 0 ? ARM_L : ARM_R).setColor(o.tunic).setMottle(0.07);
    b.addEllipsoid({
      center: [px, p.y + 0.014, pz + 0.002],
      radius: [0.092 * g, 0.078 * g, 0.086 * g],
      seg: seg(16), rings: seg(11),
      displace: (dx, dy, dz) => {
        // A deltoid is not a ball: flat shelf on top, a lateral head that bulges
        // OUTBOARD, and a taper into the armpit. The lateral bulge is what the
        // band terminator lands on — a smooth cap has no such landing.
        const up = clamp01(dy), dn = clamp01(-dy);
        const out = clamp01(dx * side);
        const lat = out * (1 - up * up) * (1 - dn * dn);
        return [
          1 - up * up * 0.14 + lat * 0.10,
          1 - up * up * 0.22 - dn * dn * 0.14,
          1 - up * up * 0.10 - clamp01(-dz) * 0.06,
        ];
      },
    });
    // Short sweep down the humerus so the cap dies into the sleeve.
    const el = rig.restWorld['foreArm' + s].pos;
    b.addTube([
      { p: [lerp(px, p.x, 0.7), p.y + 0.006, lerp(pz, p.z, 0.7)], rx: 0.064 * g, rz: 0.066 * g },
      { p: [lerp(p.x, el.x, 0.10), lerp(p.y, el.y, 0.10), lerp(p.z, el.z, 0.10)], rx: 0.059 * g, rz: 0.061 * g },
      { p: [lerp(p.x, el.x, 0.30), lerp(p.y, el.y, 0.30), lerp(p.z, el.z, 0.30)], rx: 0.051 * g, rz: 0.054 * g },
    ], { seg: seg(12) });

    // Armscye seam. A raised welt where the sleeve is set into the shoulder —
    // 3 mm of geometry, but it is a CREASE, so the outline pass draws a line
    // round the shoulder in every pose and at every light angle. Without it the
    // deltoid and the sleeve are one continuous surface and the arm reads as a
    // tube growing straight out of the ribcage.
    b.setColor(o.tunicShade).setMottle(0.05);
    const sx0 = lerp(px, p.x, 0.86), sz0 = lerp(pz, p.z, 0.86);
    b.addTube([
      { p: [sx0, p.y - 0.006, sz0], rx: 0.0625 * g, rz: 0.0645 * g },
      { p: [lerp(sx0, el.x, 0.055), lerp(p.y - 0.006, el.y, 0.055), lerp(sz0, el.z, 0.055)], rx: 0.0665 * g, rz: 0.0685 * g },
      { p: [lerp(sx0, el.x, 0.115), lerp(p.y - 0.006, el.y, 0.115), lerp(sz0, el.z, 0.115)], rx: 0.0605 * g, rz: 0.0625 * g },
    ], { seg: seg(12) });
    b.setColor(o.tunic);
  }
}

function buildArms(b, rig, o) {
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const grp = side > 0 ? ARM_L : ARM_R;
    const sh = bp(rig, 'upperArm' + s), el = bp(rig, 'foreArm' + s), wr = bp(rig, 'hand' + s);
    const g = o.girth;
    const at = (a, b2, t) => [lerp(a[0], b2[0], t), lerp(a[1], b2[1], t), lerp(a[2], b2[2], t)];
    b.setBones(grp).setColor(o.tunic).setMottle(0.07);
    // Upper arm: sleeve over a bicep belly. The swell at 0.40 and the pinch
    // above the elbow are deliberate — a straight taper is a cone, and a cone
    // gives the quantiser a single unbroken wash from shoulder to wrist.
    b.addTube([
      { p: at(sh, el, -0.12), rx: 0.057 * g, rz: 0.059 * g },
      { p: at(sh, el, 0.16), rx: 0.055 * g, rz: 0.058 * g },
      { p: at(sh, el, 0.40), rx: 0.052 * g, rz: 0.056 * g },   // bicep belly
      { p: at(sh, el, 0.72), rx: 0.044 * g, rz: 0.047 * g },
      { p: at(sh, el, 0.94), rx: 0.041 * g, rz: 0.045 * g },
      { p: el, rx: 0.043 * g, rz: 0.046 * g },                  // elbow
    ], { seg: seg(12) });

    // --- Rolled sleeve. The cuff stops at 45% of the forearm and the rest is
    // bare skin. Two things fall out of that: the sleeve's hard rolled edge is
    // a permanent ink line mid-forearm at any light angle, and the hand stops
    // being a tan blob on a tan sleeve — the arm now reads sleeve / skin / hand
    // as three separate values, which is why the extremity survives to 40 m.
    const rollT = 0.44;
    b.addTube([
      { p: el, rx: 0.043 * g, rz: 0.046 * g },
      { p: at(el, wr, 0.16), rx: 0.045 * g, rz: 0.047 * g },   // forearm belly
      { p: at(el, wr, rollT - 0.02), rx: 0.040 * g, rz: 0.042 * g },
    ], { seg: seg(12) });
    // The roll itself: a thicker band of doubled cloth.
    b.setColor(o.tunicShade);
    b.addTube([
      { p: at(el, wr, rollT - 0.04), rx: 0.043 * g, rz: 0.045 * g },
      { p: at(el, wr, rollT + 0.02), rx: 0.050 * g, rz: 0.052 * g },
      { p: at(el, wr, rollT + 0.09), rx: 0.048 * g, rz: 0.050 * g },
      { p: at(el, wr, rollT + 0.12), rx: 0.040 * g, rz: 0.042 * g },
    ], { seg: seg(12), capEnd: 'flat' });

    // Bare forearm + wrist, tapering into the hand.
    b.setBones(side > 0 ? HAND_L : HAND_R).setColor(o.skin).setMottle(0.035);
    b.addTube([
      { p: at(el, wr, rollT + 0.04), rx: 0.038, rz: 0.040 },
      { p: at(el, wr, 0.66), rx: 0.034, rz: 0.036 },
      { p: at(el, wr, 0.88), rx: 0.029, rz: 0.031 },
      { p: wr, rx: 0.027, rz: 0.030 },
    ], { seg: seg(11) });
  }
}

/**
 * Hands. A hand only reads at 10 m if it has an OUTLINE that is not the same
 * shape as the arm above it, so the priorities here are, in order: a palm that
 * is visibly wider than the wrist, a knuckle line, and four fingers with
 * different lengths and a visible gap between them. The previous build was a
 * bevelled lozenge with four identical parallel sausages — at range that is a
 * blunt tube end, which is exactly what the overview critique reported.
 */
function buildHands(b, rig, o) {
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const grp = side > 0 ? HAND_L : HAND_R;
    const wr = rig.restWorld['hand' + s].pos, fg = rig.restWorld['fingers' + s].pos;
    const col = o.gloves ? o.glove : o.skin;
    const q = new THREE.Quaternion().copy(rig.restWorld['hand' + s].quat);
    b.setBones(grp).setColor(col).setMottle(0.04);

    // Palm — flattened, and FLARED toward the knuckles: 0.084 across the
    // knuckle line against a 0.055 wrist. In hand-bone space local +Y runs
    // down the bone, local +Z is forward, local +X is lateral (thickness).
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(lerp(wr.x, fg.x, 0.44), lerp(wr.y, fg.y, 0.44), lerp(wr.z, fg.z, 0.44) + 0.003),
      q, new THREE.Vector3(1, 1, 1));
    b.setTransform(m);
    b.addRoundedBox({ size: [0.0148, 0.046, 0.0410], bevel: 0.0125, div: 3 });
    // Thenar pad — the muscle at the base of the thumb. Small, but it is the
    // difference between a hand and a paddle in silhouette.
    b.addEllipsoid({
      center: [0, 0.006, side > 0 ? 0.031 : 0.031], radius: [0.0135, 0.028, 0.017],
      seg: seg(9), rings: seg(6),
    });
    b.setTransform(null);

    // Knuckle ridge across the top of the palm.
    const dir = new THREE.Vector3().copy(fg).sub(wr).normalize();
    const kn = [fg.x + dir.x * 0.004, fg.y + dir.y * 0.004 + 0.024, fg.z + dir.z * 0.004];
    b.addTube([
      { p: [kn[0] - side * 0.006, kn[1], kn[2] - 0.030], rx: 0.0092, rz: 0.0080 },
      { p: [kn[0], kn[1] + 0.003, kn[2] - 0.004], rx: 0.0108, rz: 0.0092 },
      { p: [kn[0] + side * 0.004, kn[1] + 0.001, kn[2] + 0.026], rx: 0.0094, rz: 0.0082 },
    ], { seg: seg(8), capStart: 'round', capEnd: 'round' });

    // Fingers, built already CURLED. These hands spend essentially all of their
    // time closed around a rifle — there is no finger rig to close them — so a
    // straight splayed finger reads as an open hand floating next to the weapon
    // even when the wrist is perfectly placed on the grip. Curling the rest pose
    // costs nothing and makes every carry, aim and reload pose read as a hold.
    b.setBones([`fingers${s}`, `hand${s}`]);
    const palmF = 0.96;                        // curl direction: toward the palm (+Z)
    // index, middle, ring, little — real relative lengths, so the fingertip arc
    // is a curve rather than a straight cut.
    const FLEN = [0.058, 0.062, 0.057, 0.047];
    const FRAD = [0.0100, 0.0102, 0.0094, 0.0082];
    for (let f = 0; f < 4; f++) {
      const lat = (f - 1.5) * 0.0185;
      const len = FLEN[f], r0 = FRAD[f];
      const px = fg.x + side * lat * 0.22, pz = fg.z + lat * 0.98;
      const y0 = fg.y + 0.026;
      const at = (t, curl) => [
        px + dir.x * len * t - side * 0.004 * t * t,
        y0 + dir.y * len * t,
        pz + dir.z * len * t + palmF * curl,
      ];
      b.addTube([
        { p: at(0.00, 0.0000), rx: r0, rz: r0 * 0.92 },
        { p: at(0.34, 0.0042), rx: r0 * 1.02, rz: r0 * 0.94 },   // proximal knuckle
        { p: at(0.62, 0.0150), rx: r0 * 0.88, rz: r0 * 0.82 },
        { p: at(0.84, 0.0300), rx: r0 * 0.80, rz: r0 * 0.74 },
        { p: at(0.96, 0.0410), rx: r0 * 0.64, rz: r0 * 0.60 },
      ], { seg: seg(7), capStart: 'round', capEnd: 'round' });
    }
    // Thumb, laid across the closed fingers rather than sticking out sideways.
    b.setBones([`thumb${s}`, `hand${s}`]);
    const th = rig.restWorld['thumb' + s];
    b.addTube([
      { p: [th.pos.x, th.pos.y, th.pos.z], rx: 0.0122, rz: 0.0112 },
      { p: [lerp(th.pos.x, th.tail.x, 0.6) - side * 0.004, lerp(th.pos.y, th.tail.y, 0.7), lerp(th.pos.z, th.tail.z, 0.55) + 0.006], rx: 0.0104, rz: 0.0096 },
      { p: [th.tail.x - side * 0.015, th.tail.y - 0.009, th.tail.z - 0.005], rx: 0.0082, rz: 0.0077 },
    ], { seg: seg(7), capStart: 'round', capEnd: 'round' });
  }
}

function buildLegs(b, rig, o) {
  const g = o.girth;
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const grp = side > 0 ? LEG_L : LEG_R;
    const hp = bp(rig, 'thigh' + s), kn = bp(rig, 'shin' + s), an = bp(rig, 'foot' + s);
    const at = (a, b2, t) => [lerp(a[0], b2[0], t), lerp(a[1], b2[1], t), lerp(a[2], b2[2], t)];
    b.setBones(grp).setColor(o.trouser).setMottle(0.07);
    b.addTube([
      { p: [hp[0], hp[1] + 0.055, hp[2]], rx: 0.086 * g, rz: 0.090 * g },
      { p: at(hp, kn, 0.14), rx: 0.083 * g, rz: 0.088 * g },
      { p: at(hp, kn, 0.52), rx: 0.072 * g, rz: 0.077 * g },
      { p: at(hp, kn, 0.88), rx: 0.058 * g, rz: 0.062 * g },
      { p: kn, rx: 0.057 * g, rz: 0.060 * g },                  // knee
      { p: at(kn, an, 0.20), rx: 0.063 * g, rz: 0.068 * g },    // calf belly
      { p: at(kn, an, 0.42), rx: 0.055 * g, rz: 0.058 * g },
    ], { seg: seg(13), capStart: 'round' });
    // Trouser blousing gathered over the boot top.
    b.setColor(o.trouserCuff);
    b.addTube([
      { p: at(kn, an, 0.38), rx: 0.056 * g, rz: 0.059 * g },
      { p: at(kn, an, 0.50), rx: 0.068 * g, rz: 0.071 * g },
      { p: at(kn, an, 0.60), rx: 0.062 * g, rz: 0.065 * g },
      { p: at(kn, an, 0.64), rx: 0.052 * g, rz: 0.055 * g },
    ], { seg: seg(13), capEnd: 'flat' });
  }
}

/**
 * Boots. The old build tapered the foot to rz 0.026 at the toe and hid the sole
 * inside the upper, so from any distance the leg was a stick that came to a
 * point — the overview critique's "two tapered leg tubes with no boots or
 * ground contact". A boot has to do three things in silhouette: be WIDER than
 * the calf above it, project fore and aft of the ankle, and show a sole slab
 * that overhangs the upper so there is a hard horizontal line at the ground.
 * Length here is 0.265 m, width 0.098 m, and the welt stands 8 mm proud of the
 * upper all the way round.
 */
function buildBoots(b, rig, o) {
  const g = o.girth;
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const grp = side > 0 ? FOOT_L : FOOT_R;
    const kn = bp(rig, 'shin' + s), an = rig.restWorld['foot' + s].pos, to = rig.restWorld['toe' + s].pos;
    const fwd = new THREE.Vector3(to.x - an.x, 0, to.z - an.z).normalize();
    b.setBones(grp).setColor(o.boot).setMottle(0.05);
    // Shaft up the lower shin — a boot, so it is FATTER than the trouser cuff.
    b.addTube([
      { p: [lerp(kn[0], an.x, 0.56), lerp(kn[1], an.y, 0.56), lerp(kn[2], an.z, 0.56)], rx: 0.058 * g, rz: 0.062 * g },
      { p: [lerp(kn[0], an.x, 0.78), lerp(kn[1], an.y, 0.78), lerp(kn[2], an.z, 0.78)], rx: 0.052 * g, rz: 0.057 * g },
      { p: [an.x, an.y + 0.020, an.z + 0.002], rx: 0.048 * g, rz: 0.056 * g },
    ], { seg: seg(12), capStart: 'flat' });

    // Foot upper: heel counter, instep, toe box. NOTE the frames — this tube's
    // spine runs horizontally, so `rz` is the VERTICAL half-height and `rx` the
    // half-width, the opposite of the vertical shaft tube above.
    // Everything below is expressed against the ankle so that the underside of
    // the sole lands at exactly ankle - 0.082, which for the canonical skeleton
    // is world y = 0 — the plane the foot IK plants the ankle against. Get this
    // wrong by a centimetre and every soldier in the game sinks into the turf.
    const heelZ = -0.055, tipZ = 0.050;
    const A = an.y;
    const heel = new THREE.Vector3(an.x + fwd.x * heelZ, A, an.z + fwd.z * heelZ);
    const ball = new THREE.Vector3(to.x, A, to.z);
    const tip = new THREE.Vector3(to.x + fwd.x * tipZ, A, to.z + fwd.z * tipZ);
    b.addTube([
      { p: [heel.x, A - 0.028, heel.z], rx: 0.040, rz: 0.024 },                             // heel counter
      { p: [lerp(heel.x, an.x, 0.5), A - 0.024, lerp(heel.z, an.z, 0.5)], rx: 0.046, rz: 0.028 },
      { p: [an.x, A - 0.019, an.z], rx: 0.049, rz: 0.034 },                                 // instep
      { p: [lerp(an.x, ball.x, 0.55), A - 0.021, lerp(an.z, ball.z, 0.55)], rx: 0.050, rz: 0.032 },
      { p: [ball.x, A - 0.023, ball.z], rx: 0.048, rz: 0.030 },                             // ball
      { p: [tip.x, A - 0.028, tip.z], rx: 0.039, rz: 0.024 },                               // toe box
    ], { seg: seg(12), capStart: 'round', capEnd: 'round' });

    // Welt: a rand standing proud of the upper the whole way round. This is the
    // hard horizontal line that tells the eye a boot is SITTING on the ground
    // rather than a trouser tube fading into it.
    b.setColor(o.bootWelt).setMottle(0.035);
    b.addTube([
      { p: [heel.x, A - 0.061, heel.z], rx: 0.048, rz: 0.008 },
      { p: [an.x, A - 0.062, an.z], rx: 0.056, rz: 0.008 },
      { p: [ball.x, A - 0.062, ball.z], rx: 0.056, rz: 0.008 },
      { p: [tip.x, A - 0.061, tip.z], rx: 0.047, rz: 0.007 },
    ], { seg: seg(11), capStart: 'round', capEnd: 'round' });
    // Sole. Thicker under the heel (a stacked heel) than under the ball, with a
    // few millimetres of toe spring, so the profile is a boot and not a plank.
    b.setColor(o.bootSole).setMottle(0.03);
    b.addTube([
      { p: [heel.x, A - 0.073, heel.z], rx: 0.046, rz: 0.009 },
      { p: [lerp(heel.x, an.x, 0.7), A - 0.074, lerp(heel.z, an.z, 0.7)], rx: 0.053, rz: 0.008 },
      { p: [ball.x, A - 0.075, ball.z], rx: 0.053, rz: 0.007 },
      { p: [tip.x, A - 0.071, tip.z], rx: 0.044, rz: 0.006 },
    ], { seg: seg(11), capStart: 'round', capEnd: 'round' });
  }
}

/**
 * Neck. 100 mm of column between the collar and the jaw, thickening into the
 * trapezius at the base so the head is joined to the shoulders by a wedge
 * rather than balanced on a stalk.
 */
function buildNeck(b, rig, o) {
  const ny = rig.restWorld.neck.pos.y, hy = rig.restWorld.head.pos.y;
  b.setBones(NECK).setColor(o.skin).setMottle(0.03);
  b.addTube([
    { p: [0, ny - 0.052, 0.000], rx: 0.072, rz: 0.064 },   // trapezius root
    { p: [0, ny - 0.014, 0.004], rx: 0.056, rz: 0.052 },
    { p: [0, ny + 0.034, 0.007], rx: 0.048, rz: 0.046 },
    { p: [0, hy - 0.010, 0.009], rx: 0.046, rz: 0.045 },
    { p: [0, hy + 0.028, 0.006], rx: 0.051, rz: 0.050 },   // into the skull base
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
  // 0.160 x 0.233 x 0.197 m — a slightly-large but human skull, giving 7.28
  // heads to the figure. The previous 0.195 x 0.252 x 0.228 was 6.4 heads and
  // 22% over-wide, which is the whole of "the head is enormous and
  // balloon-shaped, roughly a third of the visible figure".
  const cx = 0, cy = hb.y + 0.066 * hs, cz = hb.z + 0.004;
  const R = [0.0800 * f.width * hs, 0.1165 * f.length * hs, 0.0985 * f.depth * hs];

  /**
   * The skull's radial displacement, factored out of addEllipsoid so the face
   * features can be placed ON the surface it actually produces. Placing them
   * against the undeformed ellipsoid is what buried the eyes: the brow ridge
   * and the socket recess move the skin by up to 5% of R, which is three times
   * an eyeball's protrusion, so a lens authored at a fixed 0.80·R sat *inside*
   * the head and the face rendered as a blank egg.
   */
  const gauss = (v, w) => Math.exp(-(v / w) * (v / w));
  const skull = (dx, dy, dz) => {
    let sx = 1, sy = 1, sz = 1;
    const front = clamp01(dz);
    const up = clamp01(dy), dn = clamp01(-dy);
    const ax = Math.abs(dx);

    // --- cranium: occipital bulge behind, parietal width above, flat crown so
    // headgear has somewhere to sit.
    sx += up * up * 0.032 * f.cranium;
    sz += 0.055 * f.cranium * smoothstep(-0.25, -0.90, dz);
    if (dy > 0.78) sy -= (dy - 0.78) * 0.13;
    // Temples: pinched above and behind the eyes.
    sx -= 0.055 * gauss(dy - 0.30, 0.24) * gauss(ax - 0.86, 0.30);

    // --- THE FACE PLANE. The single biggest "balloon" fix. A sphere shades as
    // one continuous gradient, which is precisely what the closeup critique
    // measured on the cheek (143,149,152,154,155 — 1 LSB per pixel, no
    // terminator anywhere). Flattening the front of the head from brow to chin
    // into a plane gives the quantiser a normal that swings hard at the edge of
    // that plane, so the band boundary has somewhere to land.
    const facePlane = smoothstep(0.28, 0.86, dz) * (1 - smoothstep(0.52, 1.0, ax));
    sz -= facePlane * 0.090;

    // --- brow ridge, and the socket recess under it.
    sz += gauss(dy - 0.30, 0.13) * front * 0.080 * f.brow;
    sz -= gauss(dy - 0.05, 0.13) * gauss(ax - 0.40, 0.26) * smoothstep(0.40, 0.88, dz) * 0.072;

    // --- cheekbone, then the hollow under it. This pair is the terminator VC
    // draws under every face: a lit plane above, a flat wash below, one hard
    // wobbling pigment edge between them.
    const zyg = gauss(dy + 0.10, 0.15) * gauss(ax - 0.62, 0.24) * clamp01(dz + 0.35);
    sx += zyg * 0.075 * f.cheek;
    sz += zyg * 0.045 * f.cheek;
    const hollow = gauss(dy + 0.34, 0.16) * gauss(ax - 0.52, 0.22) * front;
    sx -= hollow * 0.048;
    sz -= hollow * 0.038;

    // --- jaw: narrow the lower third, then put a gonial corner back into it so
    // there is an actual jaw ANGLE rather than an egg tapering to a point.
    const low = smoothstep(0.10, 0.92, dn);
    sx -= low * (0.30 - f.jaw * 0.14);
    sz -= low * 0.11;
    sx += gauss(dy + 0.52, 0.17) * gauss(ax - 0.66, 0.24) * (1 - smoothstep(0.10, 0.72, dz))
      * 0.105 * (0.5 + f.jaw * 0.6);
    // --- chin (mental protuberance).
    const chin = gauss(dy + 0.74, 0.20) * gauss(dx, 0.30) * smoothstep(0.08, 0.62, dz);
    sz += chin * 0.165 * (0.55 + f.chin * 0.50);
    sy -= chin * 0.045;

    return [clamp(sx, 0.5, 1.4), clamp(sy, 0.5, 1.4), clamp(sz, 0.5, 1.4)];
  };

  b.setBones(HEAD).setColor(o.skin).setMottle(0.03);
  b.addEllipsoid({ center: [cx, cy, cz], radius: R, seg: seg(22), rings: seg(16), displace: skull });

  /**
   * Point on the *displaced* skin for a direction, pushed out by `lift` metres.
   * Returns a FRESH array — several callers hold three of these at once to lay
   * out a tube spine, so a shared scratch would alias them all to the last one.
   */
  const surf = (dx, dy, dz, lift = 0) => {
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    const k = skull(dx, dy, dz);
    return [
      cx + dx * (R[0] * k[0] + lift),
      cy + dy * (R[1] * k[1] + lift),
      cz + dz * (R[2] * k[2] + lift),
    ];
  };
  /** Direction with the given lateral/vertical bias and the front hemisphere. */
  const face = (dx, dy, lift = 0) => surf(dx, dy, Math.sqrt(Math.max(0.04, 1 - dx * dx - dy * dy)), lift);

  // --- Nose. Built as three real pieces — bridge, ball, wings — because the
  // face plane above is now flat, so the nose is the ONLY thing casting a
  // shadow across the middle of the face. The old single wedge projected 9 mm
  // off a spherical face and vanished; this one stands 20 mm proud of the
  // plane and puts a hard vertical crease down the centre.
  {
    const nBridgeY = 0.235, nTipY = -0.115;
    const bridge = face(0, nBridgeY, 0);
    const tip = face(0, nTipY, 0);
    const nw = 0.0062 * f.width;
    const proj = 0.0125 * f.nose;                 // ball projection past the skin
    const midY = lerp(nBridgeY, nTipY, 0.55);
    const mid = face(0, midY, 0);
    b.addTube([
      { p: [0, bridge[1], bridge[2] - 0.006], rx: nw * 0.58, rz: 0.0045 },
      { p: [0, mid[1], mid[2] + proj * 0.42], rx: nw * 0.72, rz: proj * 0.60 },
      { p: [0, lerp(mid[1], tip[1], 0.62), lerp(mid[2], tip[2], 0.62) + proj * 0.90], rx: nw * 1.10, rz: proj * 0.94 },
      { p: [0, tip[1], tip[2] + proj * 0.80], rx: nw * 1.26, rz: proj * 0.86 },   // ball
      { p: [0, tip[1] - 0.0055, tip[2] + proj * 0.30], rx: nw * 1.20, rz: proj * 0.50 },
    ], { seg: seg(9), capEnd: 'round' });
    // Nostril wings.
    for (const side of [1, -1]) {
      b.addEllipsoid({
        center: [side * nw * 1.42, tip[1] - 0.0015, tip[2] + proj * 0.40],
        radius: [nw * 0.86, 0.0056, proj * 0.66], seg: seg(8), rings: seg(5),
      });
    }
  }

  // --- Ears, seated on the real skin so they are not swallowed by the temples.
  for (const side of [1, -1]) {
    const p = surf(side * 1, -0.03, -0.26, -0.004);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(p[0], p[1], p[2]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, side * 1.35, 0)),
      new THREE.Vector3(1, 1, 1));
    b.setTransform(m);
    b.addEllipsoid({
      radius: [0.0195, 0.0300 * f.ear, 0.0120], seg: seg(9), rings: seg(7),
      displace: (dx, dy, dz) => [1, 1, dz > 0 ? 1 - 0.45 * clamp01(1 - Math.hypot(dx, dy) * 1.5) : 1],
    });
    b.setTransform(null);
  }

  // --- Eyes. CANVAS-engine faces live or die on these: a large flat sclera
  // lens, a dark iris, and — the piece that actually reads at 40 m — a heavy
  // graphite upper lash line. Everything is placed relative to the displaced
  // socket and lifted clear of it, so nothing z-fights with the skin.
  const eDX = 0.42, eDY = 0.030;
  const eyeS = f.eye * (0.98 + 0.10 * clamp01(f.eye - 1));
  for (const side of [1, -1]) {
    const pe = face(side * eDX, eDY, 0);
    const p = [pe[0], pe[1], pe[2]];
    // Only a shallow outward splay: a big yaw turns the far eye edge-on and the
    // face reads cross-eyed in three-quarter view, which is the angle every
    // portrait shot uses.
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.05, side * 0.20, side * -0.05));
    const at = (dz) => new THREE.Matrix4().compose(
      new THREE.Vector3(p[0], p[1], p[2] + dz), rot, new THREE.Vector3(1, 1, 1));

    // Sclera: a FLAT lens, not a ball. CANVAS-engine eyes are drawn shapes on
    // the face, so keep the depth small and let the lash line carry the form.
    b.setColor(PALETTE.eyeWhite).setMottle(0);
    b.setTransform(at(-0.0022));
    b.addEllipsoid({ radius: [0.0168 * eyeS, 0.0112 * eyeS, 0.0055], seg: seg(11), rings: seg(7) });
    // Iris + pupil.
    b.setColor(f.eyeColor);
    b.setTransform(at(0.0015));
    b.addEllipsoid({ radius: [0.0086 * eyeS, 0.0094 * eyeS, 0.0036], seg: seg(10), rings: seg(6) });
    b.setColor(mixCol(f.eyeColor, [0.01, 0.01, 0.012], 0.75));
    b.setTransform(at(0.0031));
    b.addEllipsoid({ radius: [0.0040 * eyeS, 0.0044 * eyeS, 0.0024], seg: seg(8), rings: seg(5) });
    b.setTransform(null);

    // Upper lash line — the single strongest feature on a VC face.
    b.setColor(mixCol(f.hairColor, [0.02, 0.017, 0.016], 0.45)).setMottle(0.02);
    const lx = 0.0168 * eyeS, ly = 0.0114 * eyeS;
    b.addTube([
      { p: [p[0] - side * lx * 0.94, p[1] + ly * 0.30, p[2] + 0.0014], rx: 0.0026, rz: 0.0022 },
      { p: [p[0] - side * lx * 0.30, p[1] + ly * 0.92, p[2] + 0.0046], rx: 0.0036, rz: 0.0030 },
      { p: [p[0] + side * lx * 0.42, p[1] + ly * 0.88, p[2] + 0.0042], rx: 0.0034, rz: 0.0028 },
      { p: [p[0] + side * lx * 1.02, p[1] + ly * 0.34, p[2] + 0.0006], rx: 0.0022, rz: 0.0019 },
    ], { seg: seg(7), capStart: 'round', capEnd: 'round' });
    // Lower lid: a thin warm crease that stops the eye floating.
    b.setColor(mixCol(o.skin, PALETTE.lip, 0.35));
    b.addTube([
      { p: [p[0] - side * lx * 0.80, p[1] - ly * 0.62, p[2] + 0.0006], rx: 0.0018, rz: 0.0015 },
      { p: [p[0], p[1] - ly * 0.98, p[2] + 0.0034], rx: 0.0021, rz: 0.0017 },
      { p: [p[0] + side * lx * 0.80, p[1] - ly * 0.60, p[2] + 0.0004], rx: 0.0017, rz: 0.0014 },
    ], { seg: seg(6), capStart: 'round', capEnd: 'round' });
  }

  // --- Brows: thicker and darker than before, and lifted onto the brow ridge.
  b.setColor(mixCol(f.hairColor, [0.02, 0.016, 0.014], 0.25)).setMottle(0.03);
  for (const side of [1, -1]) {
    const bY = eDY + 0.190 + f.browHeight * 0.05;
    const p0 = face(side * (eDX - 0.13), bY - 0.02, 0.0022);
    const p1 = face(side * eDX, bY, 0.0026);
    const p2 = face(side * (eDX + 0.16), bY - 0.03, 0.0020);
    b.addTube([
      { p: [p0[0], p0[1], p0[2]], rx: 0.0048, rz: 0.0040 },
      { p: [p1[0], p1[1], p1[2]], rx: 0.0068, rz: 0.0054 },
      { p: [p2[0], p2[1], p2[2]], rx: 0.0046, rz: 0.0038 },
    ], { seg: seg(7), capStart: 'round', capEnd: 'round' });
  }

  // --- Mouth: a soft lip wedge on the surface, with a darker seam.
  {
    const mDY = -0.48;
    const c0 = face(-0.125 * f.width, mDY + 0.035, 0.0018);
    const c1 = face(0, mDY, 0.0030);
    const c2 = face(0.125 * f.width, mDY + 0.035, 0.0018);
    b.setColor(PALETTE.lip).setMottle(0.02);
    b.addTube([
      { p: [c0[0], c0[1], c0[2]], rx: 0.0040, rz: 0.0034 },
      { p: [c1[0], c1[1] + 0.0016, c1[2]], rx: 0.0075, rz: 0.0056 },
      { p: [c2[0], c2[1], c2[2]], rx: 0.0040, rz: 0.0034 },
    ], { seg: seg(7), capStart: 'round', capEnd: 'round' });
    b.setColor(mixCol(PALETTE.lip, [0.03, 0.02, 0.02], 0.55));
    b.addTube([
      { p: [c0[0], c0[1] + 0.0006, c0[2] + 0.0006], rx: 0.0021, rz: 0.0017 },
      { p: [c1[0], c1[1] + 0.0028, c1[2] + 0.0012], rx: 0.0027, rz: 0.0021 },
      { p: [c2[0], c2[1] + 0.0006, c2[2] + 0.0006], rx: 0.0021, rz: 0.0017 },
    ], { seg: seg(6), capStart: 'round', capEnd: 'round' });
  }

  b.setMottle(0.06);
  // `disp` is handed to character.js so hair and headgear can be built as
  // offset shells of the SAME surface. Anything that shells the raw ellipsoid
  // instead sinks into the cranium bulge and disappears.
  return { center: [cx, cy, cz], radius: R, disp: skull };
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
