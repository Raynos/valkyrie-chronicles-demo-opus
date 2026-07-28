// src/actors/character.js
// -----------------------------------------------------------------------------
// Character — a fully procedural Gallian militia soldier: seeded face, hair and
// body type, class-specific uniform and kit, verlet-simulated cloth, a weapon
// solved onto the hand from the actual aim pose, and a ragdoll-lite collapse on
// death so bodies fall down slopes instead of playing a canned floor animation.
//
// Public API is exactly the ARCHITECTURE.md contract:
//   new Character({ class, team, name, seed })
//   .root .play(clip, opts) .setAimAngles(yaw, pitch) .update(dt)
//   .muzzlePoint() .headPoint() .dispose()
// plus the integration extras the game layer needs: lodLevel, setGroundCallback,
// setLocomotion, setLookTarget, die, aimDirection.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { makeRng, rngRange, rngInt, rngPick } from '../core/rng.js';
import { clamp, clamp01, lerp, smoothstep, TAU } from '../core/math.js';
import {
  MeshBuilder, PALETTE, SKIN_TONES, HAIR_TONES, BODY_TYPES, BONE_GROUPS,
  makeRig, buildBody, buildHead, createSkinnedBody, actorBodyMaterial,
  actorGearMaterial, rgbLin, mixCol, seg,
} from './rig.js';
import { Animator, CLIP_META, CLIP_ALIASES, boneWorld, rotateBoneWorld } from './anim.js';
import { createWeapon, WEAPON_FOR_CLASS, WEAPONS } from './weapons.js';

const CLASSES = ['scout', 'shock', 'lancer', 'engineer', 'sniper'];
const CLASS_ALIAS = { shocktrooper: 'shock', trooper: 'shock', lance: 'lancer', eng: 'engineer', snip: 'sniper' };

// ---------------------------------------------------------------------------
// Wind — shared by every cloth strip in the scene.
// ---------------------------------------------------------------------------

const WIND = new THREE.Vector3(0.9, 0, 0.5);
let _windT = 0;
export function setWind(x, y, z) { WIND.set(x, y, z); }

// ---------------------------------------------------------------------------
// Seeded appearance
// ---------------------------------------------------------------------------

/**
 * Everything that makes one soldier not look like the next: proportions, face
 * geometry parameters, skin/hair tone, uniform wear and kit colour drift.
 */
export function makeAppearance(seed, cls, team) {
  const rng = makeRng((seed | 0) * 2654435761 >>> 0 || 12345);
  const feminine = rng() < 0.42;
  const bodyKeys = feminine ? ['petite', 'lean', 'medium'] : ['medium', 'lean', 'stocky', 'tall'];
  const bodyType = rngPick(rng, bodyKeys);
  const skin = SKIN_TONES[rngInt(rng, 0, SKIN_TONES.length - 1)];
  const hairColor = HAIR_TONES[rngInt(rng, 0, HAIR_TONES.length - 1)];
  const hairStyle = feminine
    ? rngPick(rng, ['bob', 'ponytail', 'bun', 'sidePart', 'swept'])
    : rngPick(rng, ['crop', 'crop', 'sidePart', 'swept', 'bob']);

  const face = {
    width: rngRange(rng, 0.94, 1.06) * (feminine ? 0.965 : 1),
    length: rngRange(rng, 0.95, 1.05) * (feminine ? 0.98 : 1),
    depth: rngRange(rng, 0.96, 1.04),
    jaw: feminine ? rngRange(rng, 0.28, 0.55) : rngRange(rng, 0.55, 0.95),
    chin: rngRange(rng, 0.35, 1.0),
    cranium: rngRange(rng, 0.7, 1.3),
    brow: feminine ? rngRange(rng, 0.25, 0.65) : rngRange(rng, 0.6, 1.25),
    cheek: rngRange(rng, 0.5, 1.3),
    nose: rngRange(rng, 0.8, 1.25),
    ear: rngRange(rng, 0.85, 1.15),
    eye: feminine ? rngRange(rng, 1.02, 1.14) : rngRange(rng, 0.92, 1.04),
    browHeight: rngRange(rng, -0.4, 0.6),
    hairColor,
    eyeColor: rngPick(rng, [
      rgbLin(0x3a5a6b), rgbLin(0x4a6b45), rgbLin(0x5a4430), rgbLin(0x33302c),
      rgbLin(0x6a5a3a), rgbLin(0x2f4a5c),
    ]),
  };

  const imperial = team === 1;
  const wear = rngRange(rng, 0.86, 1.06);          // sun-bleaching / field dirt
  const base = imperial
    ? { tunic: PALETTE.impTunic, tunicShade: PALETTE.impTunicShade, collar: PALETTE.impCollar, trouser: PALETTE.impTrouser, leather: PALETTE.impLeather, accent: PALETTE.impAccent, trim: PALETTE.impTrim }
    : { tunic: PALETTE.tunic, tunicShade: PALETTE.tunicShade, collar: PALETTE.collar, trouser: PALETTE.trouser, leather: PALETTE.leather, accent: PALETTE.accent, trim: PALETTE.trim };

  const tint = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  return {
    rng, feminine, bodyType, hairStyle, face, skin, hairColor,
    heightScale: rngRange(rng, 0.975, 1.03),
    girth: rngRange(rng, 0.95, 1.06) * BODY_TYPES[bodyType].girth,
    gloves: cls === 'shock' || cls === 'lancer' || (cls === 'engineer' && rng() < 0.6),
    tunic: tint(base.tunic, wear),
    tunicShade: tint(base.tunicShade, wear),
    collar: tint(base.collar, wear * 0.98),
    trouser: tint(base.trouser, wear * rngRange(rng, 0.95, 1.03)),
    trouserCuff: tint(base.trouser, wear * 0.88),
    leather: tint(base.leather, rngRange(rng, 0.9, 1.1)),
    belt: tint(PALETTE.belt, rngRange(rng, 0.9, 1.08)),
    boot: tint(PALETTE.boot, rngRange(rng, 0.88, 1.1)),
    bootSole: PALETTE.bootSole,
    glove: PALETTE.glove,
    brass: PALETTE.brass,
    metal: PALETTE.metal,
    accent: base.accent,
    trim: base.trim,
    canvas: mixCol(PALETTE.canvas, base.tunic, 0.35),
    scarf: mixCol(PALETTE.scarf, base.trim, 0.3),
  };
}

// ---------------------------------------------------------------------------
// Hair
// ---------------------------------------------------------------------------

/**
 * A displaced spherical cap that follows the skull. `phiMax` shapes the
 * hairline: high at the temples, low at the nape, receding over the brow.
 */
function buildHair(b, rig, o, head, style, coveredByHat) {
  const R = head.radius, C = head.center;
  const hc = o.hairColor;
  const thick = coveredByHat ? 1.008 : 1.035;
  b.setBones(BONE_GROUPS.HEAD).setColor(hc).setMottle(0.09);

  // u = 0 at +Z (face), 0.25 at +X (character's left), 0.5 at -Z (nape).
  const front = style === 'crop' ? 0.40 : style === 'sidePart' ? 0.44 : 0.47;
  const phiMax = (u) => {
    const a = u * TAU;
    const cz = Math.cos(a);                 // +1 facing forward
    const cx = Math.sin(a);
    // Forward hairline sits high, sides come down over the ears, nape lowest.
    let m = 0.52 + 0.20 * (1 - clamp01(cz)) + 0.10 * Math.abs(cx);
    m -= front * 0.30 * clamp01(cz) * clamp01(cz);
    if (style === 'sidePart') m += 0.06 * clamp01(cx) * clamp01(cz);
    if (style === 'bob' || style === 'swept') m += 0.16 * (1 - clamp01(cz));
    if (style === 'bun' || style === 'ponytail') m -= 0.05 * (1 - clamp01(cz));
    return clamp(m, 0.28, 0.94);
  };
  b.addEllipsoid({
    center: [C[0], C[1] + 0.004, C[2] - 0.004],
    radius: [R[0] * thick + 0.004, R[1] * thick + 0.005, R[2] * thick + 0.004],
    seg: seg(20), rings: seg(11), phiMax,
    displace: (dx, dy, dz, u, v) => {
      // Tufted silhouette: low-frequency lumps plus a wispy edge.
      const t = 1 + 0.030 * Math.sin(u * TAU * 5 + dy * 6) * (0.4 + v)
        + 0.018 * Math.sin(u * TAU * 11 + 1.7) * v;
      const edge = 1 - 0.10 * smoothstep(0.78, 1.0, v);
      return t * edge;
    },
  });

  if (coveredByHat) return;

  // Fringe: a few short strands over the brow.
  const strands = style === 'crop' ? 3 : 5;
  for (let i = 0; i < strands; i++) {
    const a = lerp(-0.55, 0.55, strands === 1 ? 0.5 : i / (strands - 1));
    const sx = Math.sin(a), sz = Math.cos(a);
    const drop = style === 'crop' ? 0.030 : 0.055;
    b.addTube([
      { p: [C[0] + sx * R[0] * 0.72, C[1] + R[1] * 0.66, C[2] + sz * R[2] * 0.70], rx: 0.016, rz: 0.011 },
      { p: [C[0] + sx * R[0] * 0.92, C[1] + R[1] * 0.30, C[2] + sz * R[2] * 0.92], rx: 0.017, rz: 0.012 },
      { p: [C[0] + sx * R[0] * 0.96, C[1] + R[1] * 0.30 - drop, C[2] + sz * R[2] * 0.95], rx: 0.011, rz: 0.008 },
    ], { seg: seg(7), capEnd: 'round' });
  }
  if (style === 'bun') {
    b.addEllipsoid({
      center: [C[0], C[1] + R[1] * 0.42, C[2] - R[2] * 1.06],
      radius: [0.044, 0.042, 0.040], seg: seg(11), rings: seg(8),
      displace: (dx, dy) => 1 + 0.07 * Math.sin(dx * 14 + dy * 9),
    });
  }
}

// ---------------------------------------------------------------------------
// Uniform kit
// ---------------------------------------------------------------------------

const _m4 = new THREE.Matrix4(), _m4b = new THREE.Matrix4();

/** Elliptical band around the body — a lathe under a non-uniform scale. */
function band(b, y, rx, rz, h, thick, color) {
  b.setColor(color);
  b.setTransform(_m4.makeTranslation(0, y, 0).multiply(_m4b.makeScale(rx, 1, rz)));
  b.addLathe([
    [1, -h], [1 + thick, -h * 0.72], [1 + thick, h * 0.72], [1, h],
  ], { seg: seg(16) });
  b.setTransform(null);
}

/** Belt, Y-straps, ammo pouches, canteen, shoulder crest — worn by everyone. */
function gearWebbing(b, rig, o, cls) {
  const g = o.girth;
  const hy = rig.restWorld.hips.pos.y, cy = rig.restWorld.spine3.pos.y;
  const beltY = hy - 0.035;
  b.setBones(BONE_GROUPS.TORSO).setMottle(0.05);

  band(b, beltY, 0.152 * g, 0.112 * g, 0.024, 0.030, o.belt);
  // Buckle.
  b.setColor(o.brass);
  b.addRoundedBox({ center: [0, beltY, 0.121 * g], size: [0.026, 0.020, 0.010], bevel: 0.004, div: 2 });

  // Y-straps: front lower -> over each shoulder -> back lower.
  b.setColor(o.leather);
  for (const side of [1, -1]) {
    b.addTube([
      { p: [side * 0.030, beltY + 0.008, 0.115 * g], rx: 0.018, rz: 0.006 },
      { p: [side * 0.048, lerp(beltY, cy, 0.55), 0.112 * g], rx: 0.018, rz: 0.006 },
      { p: [side * 0.070, cy + 0.045, 0.088 * g], rx: 0.019, rz: 0.006 },
      { p: [side * 0.098, cy + 0.098, 0.020 * g], rx: 0.020, rz: 0.007 },   // over the shoulder
      { p: [side * 0.086, cy + 0.055, -0.078 * g], rx: 0.019, rz: 0.006 },
      { p: [side * 0.056, lerp(beltY, cy, 0.5), -0.108 * g], rx: 0.018, rz: 0.006 },
      { p: [side * 0.034, beltY + 0.006, -0.112 * g], rx: 0.017, rz: 0.006 },
    ], { seg: seg(8), capStart: 'flat', capEnd: 'flat' });
  }

  // Ammo pouches on the belt front.
  const pouches = cls === 'shock' ? 3 : cls === 'lancer' ? 1 : 2;
  b.setColor(o.leather);
  for (let i = 0; i < pouches; i++) {
    const t = pouches === 1 ? 0 : (i / (pouches - 1)) * 2 - 1;
    const a = t * 0.62;
    b.addRoundedBox({
      center: [Math.sin(a) * 0.125 * g, beltY - 0.030, Math.cos(a) * 0.108 * g + 0.012],
      size: [0.032, 0.036, 0.020], bevel: 0.008, div: 2,
    });
    b.setColor(o.belt);
    b.addRoundedBox({
      center: [Math.sin(a) * 0.128 * g, beltY - 0.004, Math.cos(a) * 0.112 * g + 0.013],
      size: [0.033, 0.011, 0.021], bevel: 0.005, div: 2,
    });
    b.setColor(o.leather);
  }

  // Canteen on the right hip, bread bag on the left.
  b.setColor(mixCol(o.metal, o.canvas, 0.5));
  b.setTransform(_m4.makeTranslation(-0.128 * g, beltY - 0.072, -0.030));
  b.addRoundedBox({ size: [0.036, 0.048, 0.020], bevel: 0.014, div: 3 });
  b.setTransform(null);
  b.setColor(o.canvas);
  b.addRoundedBox({ center: [0.132 * g, beltY - 0.070, -0.044], size: [0.038, 0.046, 0.024], bevel: 0.010, div: 2 });

  // Squad 7 shoulder crest: a domed shield patch on the left upper arm.
  const sh = rig.restWorld.upperArmL.pos;
  b.setBones(BONE_GROUPS.ARM_L).setColor(o.accent).setMottle(0.04);
  b.setTransform(_m4.compose(
    new THREE.Vector3(sh.x + 0.052 * g, sh.y - 0.052, sh.z + 0.006),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 0.5, 0.1)),
    new THREE.Vector3(1, 1, 1)));
  b.addEllipsoid({ radius: [0.030, 0.040, 0.016], seg: seg(10), rings: seg(6), phiMax: () => 0.5 });
  b.setColor(o.trim);
  b.addEllipsoid({ center: [0, 0.004, 0.004], radius: [0.017, 0.023, 0.015], seg: seg(9), rings: seg(5), phiMax: () => 0.46 });
  b.setTransform(null);

  // Rank chevrons on the right sleeve.
  const shR = rig.restWorld.upperArmR.pos;
  b.setBones(BONE_GROUPS.ARM_R).setColor(o.trim);
  for (let i = 0; i < 2; i++) {
    b.addTube([
      { p: [shR.x - 0.030, shR.y - 0.070 - i * 0.016, shR.z + 0.036], rx: 0.005, rz: 0.0025 },
      { p: [shR.x - 0.048, shR.y - 0.062 - i * 0.016, shR.z + 0.006], rx: 0.005, rz: 0.0025 },
      { p: [shR.x - 0.034, shR.y - 0.070 - i * 0.016, shR.z - 0.026], rx: 0.005, rz: 0.0025 },
    ], { seg: seg(5), capStart: 'flat', capEnd: 'flat' });
  }
}

/** Class headgear. Returns true when hair should be suppressed on the crown. */
function gearHead(b, rig, o, head, cls) {
  const R = head.radius, C = head.center;
  b.setBones(BONE_GROUPS.HEAD).setMottle(0.05);

  if (cls === 'scout') {
    // Garrison side cap: a deep cap pinched into a ridge along the crown.
    b.setColor(o.tunic);
    b.addEllipsoid({
      center: [C[0], C[1] + 0.012, C[2] - 0.004],
      radius: [R[0] * 1.05, R[1] * 1.02, R[2] * 1.05], seg: seg(18), rings: seg(9),
      phiMax: () => 0.66,
      displace: (dx, dy) => [1 - 0.42 * clamp01(dy) * clamp01(dy), 1 + 0.05 * clamp01(dy), 1],
    });
    b.setColor(o.tunicShade);
    b.addEllipsoid({
      center: [C[0], C[1] + 0.006, C[2] - 0.004],
      radius: [R[0] * 1.07, R[1] * 0.98, R[2] * 1.07], seg: seg(18), rings: seg(4),
      phiMin: 0.44, phiMax: () => 0.68,
      displace: (dx, dy) => [1 - 0.40 * clamp01(dy) * clamp01(dy), 1, 1],
    });
    b.setColor(o.accent);
    b.addTube([
      { p: [C[0] - R[0] * 0.30, C[1] + R[1] * 0.66, C[2] + R[2] * 0.86], rx: 0.010, rz: 0.008 },
      { p: [C[0] + R[0] * 0.30, C[1] + R[1] * 0.66, C[2] + R[2] * 0.86], rx: 0.010, rz: 0.008 },
    ], { seg: seg(7), capStart: 'round', capEnd: 'round' });
    return false;
  }

  if (cls === 'shock' || cls === 'lancer') {
    // Stamped steel helmet: dome, rolled brim, rivets, chin strap.
    const hr = [R[0] * 1.20, R[1] * 1.06, R[2] * 1.16];
    b.setColor(mixCol(o.metal, o.tunicShade, 0.45));
    b.setTransform(_m4.makeTranslation(C[0], C[1] - 0.020, C[2] - 0.006).multiply(_m4b.makeScale(hr[0], 1, hr[2])));
    b.addLathe([
      [1.00, 0.006], [1.05, 0.010], [1.06, 0.026], [1.00, 0.034],
      [0.985, 0.052], [0.94, 0.082], [0.86, 0.106], [0.72, 0.126],
      [0.50, 0.140], [0.26, 0.147], [0, 0.149],
    ], { seg: seg(18) });
    b.setTransform(null);
    b.setColor(mixCol(o.metal, o.tunicShade, 0.25));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.4;
      b.addTube([
        { p: [C[0] + Math.sin(a) * hr[0] * 0.96, C[1] + 0.014, C[2] - 0.006 + Math.cos(a) * hr[2] * 0.96], rx: 0.007, rz: 0.007 },
        { p: [C[0] + Math.sin(a) * hr[0] * 1.02, C[1] + 0.014, C[2] - 0.006 + Math.cos(a) * hr[2] * 1.02], rx: 0.006, rz: 0.006 },
      ], { seg: seg(6), capEnd: 'round' });
    }
    b.setColor(o.leather);
    b.addTube([
      { p: [C[0] + hr[0] * 0.92, C[1] - 0.010, C[2] - 0.010], rx: 0.010, rz: 0.004 },
      { p: [C[0] + hr[0] * 0.72, C[1] - R[1] * 0.72, C[2] + R[2] * 0.30], rx: 0.010, rz: 0.004 },
      { p: [C[0], C[1] - R[1] * 0.92, C[2] + R[2] * 0.44], rx: 0.011, rz: 0.004 },
      { p: [C[0] - hr[0] * 0.72, C[1] - R[1] * 0.72, C[2] + R[2] * 0.30], rx: 0.010, rz: 0.004 },
      { p: [C[0] - hr[0] * 0.92, C[1] - 0.010, C[2] - 0.010], rx: 0.010, rz: 0.004 },
    ], { seg: seg(6), capStart: 'flat', capEnd: 'flat' });
    return true;
  }

  if (cls === 'engineer') {
    // Peaked service cap.
    b.setColor(o.tunic);
    b.setTransform(_m4.makeTranslation(C[0], C[1] + 0.006, C[2] - 0.004).multiply(_m4b.makeScale(R[0] * 1.10, 1, R[2] * 1.10)));
    b.addLathe([
      [1.00, 0.008], [1.06, 0.014], [1.06, 0.030], [1.02, 0.052],
      [0.96, 0.078], [0.80, 0.098], [0.44, 0.108], [0, 0.110],
    ], { seg: seg(16) });
    b.setTransform(null);
    b.setColor(o.collar);
    band(b, C[1] + 0.020, R[0] * 1.12, R[2] * 1.12, 0.013, 0.020, o.collar);
    // Visor.
    b.setColor(mixCol(o.leather, PALETTE.metalDark, 0.4));
    b.setTransform(_m4.compose(
      new THREE.Vector3(C[0], C[1] + 0.006, C[2] + R[2] * 0.52),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.30, 0, 0)),
      new THREE.Vector3(1, 1, 1)));
    b.addEllipsoid({
      radius: [R[0] * 1.05, 0.010, R[2] * 0.86], seg: seg(14), rings: seg(5),
      phiMax: (u) => (Math.cos(u * TAU) > 0 ? 1 : 0.5),
    });
    b.setTransform(null);
    b.setColor(o.brass);
    b.addRoundedBox({ center: [0, C[1] + 0.048, C[2] + R[2] * 1.02], size: [0.013, 0.012, 0.006], bevel: 0.003, div: 2 });
    return true;
  }

  // sniper: soft field cap, worn back off the brow
  b.setColor(mixCol(o.tunic, o.trouser, 0.45));
  b.addEllipsoid({
    center: [C[0], C[1] + 0.010, C[2] - 0.012],
    radius: [R[0] * 1.06, R[1] * 1.00, R[2] * 1.06], seg: seg(16), rings: seg(8),
    phiMax: () => 0.60,
    displace: (dx, dy, dz) => 1 + 0.04 * clamp01(-dz) * clamp01(dy),
  });
  b.setColor(mixCol(o.tunicShade, o.trouser, 0.45));
  b.setTransform(_m4.compose(
    new THREE.Vector3(C[0], C[1] + 0.018, C[2] + R[2] * 0.56),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.22, 0, 0)),
    new THREE.Vector3(1, 1, 1)));
  b.addEllipsoid({
    radius: [R[0] * 0.94, 0.008, R[2] * 0.70], seg: seg(12), rings: seg(4),
    phiMax: (u) => (Math.cos(u * TAU) > 0 ? 1 : 0.5),
  });
  b.setTransform(null);
  return true;
}

/** Per-class load-out that isn't the weapon itself. */
function gearClass(b, rig, o, cls) {
  const g = o.girth;
  const hy = rig.restWorld.hips.pos.y, cy = rig.restWorld.spine3.pos.y;
  b.setBones(BONE_GROUPS.TORSO).setMottle(0.05);

  if (cls === 'shock') {
    // Heavy chest rig + magazine bank + a slung entrenching tool.
    b.setColor(mixCol(o.leather, o.tunicShade, 0.35));
    b.addTube([
      { p: [0, cy - 0.055, 0.086 * g], rx: 0.108 * g, rz: 0.052 * g },
      { p: [0, cy + 0.030, 0.084 * g], rx: 0.116 * g, rz: 0.055 * g },
      { p: [0, cy + 0.072, 0.078 * g], rx: 0.104 * g, rz: 0.050 * g },
    ], { seg: seg(14), capStart: 'round', capEnd: 'round' });
    b.setColor(PALETTE.metalDark);
    for (let i = 0; i < 4; i++) {
      const x = (i - 1.5) * 0.042 * g;
      b.addRoundedBox({ center: [x, cy - 0.012, 0.118 * g], size: [0.017, 0.040, 0.014], bevel: 0.005, div: 2 });
    }
    b.setColor(o.canvas);
    b.addRoundedBox({ center: [0.052, hy + 0.06, -0.126 * g], size: [0.046, 0.062, 0.024], bevel: 0.012, div: 2 });
    return;
  }

  if (cls === 'lancer') {
    // Big pauldron over the right shoulder where the lance rides.
    const sh = rig.restWorld.upperArmR.pos;
    b.setBones(BONE_GROUPS.ARM_R).setColor(mixCol(o.metal, o.tunicShade, 0.4));
    b.setTransform(_m4.compose(
      new THREE.Vector3(sh.x - 0.010, sh.y + 0.030, sh.z + 0.002),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.22)),
      new THREE.Vector3(1, 1, 1)));
    b.addEllipsoid({
      radius: [0.098 * g, 0.086 * g, 0.098 * g], seg: seg(14), rings: seg(7),
      phiMax: () => 0.60,
      displace: (dx, dy, dz) => 1 + 0.05 * clamp01(dy) - 0.04 * clamp01(-dz),
    });
    b.setColor(mixCol(o.metal, PALETTE.metalDark, 0.5));
    b.addEllipsoid({
      center: [0, -0.030, 0], radius: [0.102 * g, 0.026, 0.102 * g],
      seg: seg(14), rings: seg(3), phiMin: 0.30, phiMax: () => 0.58,
    });
    b.setTransform(null);
    // Spare warhead tube on the back.
    b.setBones(BONE_GROUPS.TORSO).setColor(mixCol(o.metal, o.tunicShade, 0.3));
    b.addTube([
      { p: [-0.078, hy + 0.02, -0.120 * g], rx: 0.036, rz: 0.036 },
      { p: [0.070, cy + 0.05, -0.118 * g], rx: 0.036, rz: 0.036 },
    ], { seg: seg(10), capStart: 'flat', capEnd: 'flat' });
    b.setColor(o.accent);
    b.addTube([
      { p: [0.050, cy + 0.005, -0.118 * g], rx: 0.038, rz: 0.038 },
      { p: [0.070, cy + 0.05, -0.118 * g], rx: 0.030, rz: 0.030 },
    ], { seg: seg(10), capEnd: 'round' });
    return;
  }

  if (cls === 'engineer') {
    // Tool satchel on the back plus a hip pouch of spares.
    b.setColor(o.leather);
    b.addRoundedBox({ center: [0, lerp(hy, cy, 0.45), -0.128 * g], size: [0.086, 0.070, 0.032], bevel: 0.014, div: 3 });
    b.setColor(o.belt);
    for (const sx of [-0.05, 0.05]) {
      b.addTube([
        { p: [sx, lerp(hy, cy, 0.78), -0.118 * g], rx: 0.011, rz: 0.004 },
        { p: [sx, lerp(hy, cy, 0.30), -0.164 * g], rx: 0.011, rz: 0.004 },
      ], { seg: seg(6), capStart: 'flat', capEnd: 'flat' });
    }
    b.setColor(PALETTE.metal);
    b.addTube([
      { p: [0.046, lerp(hy, cy, 0.72), -0.150 * g], rx: 0.008, rz: 0.006 },
      { p: [0.056, lerp(hy, cy, 1.02), -0.144 * g], rx: 0.007, rz: 0.005 },
    ], { seg: seg(6), capStart: 'flat', capEnd: 'round' });
    b.setColor(o.canvas);
    b.addRoundedBox({ center: [0.126 * g, hy - 0.104, 0.012], size: [0.034, 0.042, 0.026], bevel: 0.010, div: 2 });
    return;
  }

  if (cls === 'sniper') {
    // Slim spotting-scope case on the left hip and a rolled cape at the waist.
    b.setColor(o.leather);
    b.addTube([
      { p: [0.118 * g, hy - 0.052, -0.026], rx: 0.024, rz: 0.024 },
      { p: [0.126 * g, hy - 0.148, -0.020], rx: 0.022, rz: 0.022 },
    ], { seg: seg(9), capStart: 'round', capEnd: 'round' });
    b.setColor(o.canvas);
    b.addTube([
      { p: [-0.088, hy - 0.062, -0.112 * g], rx: 0.030, rz: 0.030 },
      { p: [0.088, hy - 0.062, -0.112 * g], rx: 0.030, rz: 0.030 },
    ], { seg: seg(10), capStart: 'round', capEnd: 'round' });
    return;
  }

  // scout: light pack + map case
  b.setColor(o.canvas);
  b.addRoundedBox({ center: [0, lerp(hy, cy, 0.55), -0.126 * g], size: [0.070, 0.058, 0.028], bevel: 0.014, div: 2 });
  b.setColor(o.leather);
  b.addRoundedBox({ center: [0.118 * g, hy - 0.088, 0.030], size: [0.030, 0.038, 0.014], bevel: 0.008, div: 2 });
}

// ---------------------------------------------------------------------------
// Cloth — verlet strips for the tunic tail, the sniper's scarf and ponytails.
// ---------------------------------------------------------------------------

const _cv = new THREE.Vector3(), _cv2 = new THREE.Vector3(), _cv3 = new THREE.Vector3();
const _cn = new THREE.Vector3(), _ce1 = new THREE.Vector3(), _ce2 = new THREE.Vector3();

class ClothStrip {
  /**
   * @param o { bone, rows, cols, spacing, colSpacing, origin, dir, side,
   *            color, tipColor, gravity, drag, stiff, thickness, collide }
   */
  constructor(o) {
    this.bone = o.bone;
    this.rows = o.rows;
    this.cols = o.cols;
    this.spacing = o.spacing;
    this.stiff = o.stiff !== undefined ? o.stiff : 0.9;
    this.gravity = o.gravity !== undefined ? o.gravity : -9.2;
    this.drag = o.drag !== undefined ? o.drag : 0.982;
    this.windGain = o.windGain !== undefined ? o.windGain : 1;
    this.collide = o.collide !== false;
    this.thickness = o.thickness || 0.006;

    const n = this.rows * this.cols;
    this.p = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.rest = new Float32Array(n * 3);         // bone-local rest layout
    this.pinned = new Uint8Array(n);

    const O = o.origin, D = o.dir, S = o.side;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = (r * this.cols + c) * 3;
        const sc = (c - (this.cols - 1) / 2) * (o.colSpacing || this.spacing);
        this.rest[i] = O[0] + D[0] * this.spacing * r + S[0] * sc;
        this.rest[i + 1] = O[1] + D[1] * this.spacing * r + S[1] * sc;
        this.rest[i + 2] = O[2] + D[2] * this.spacing * r + S[2] * sc;
      }
    }
    for (let c = 0; c < this.cols; c++) this.pinned[c] = 1;

    // Constraint list: structural + shear, with the target rest length baked in.
    this.cons = [];
    const add = (a, bIdx) => {
      const ia = a * 3, ib = bIdx * 3;
      const d = Math.hypot(this.rest[ia] - this.rest[ib], this.rest[ia + 1] - this.rest[ib + 1], this.rest[ia + 2] - this.rest[ib + 2]);
      this.cons.push(a, bIdx, d);
    };
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        if (r + 1 < this.rows) add(i, i + this.cols);
        if (c + 1 < this.cols) add(i, i + 1);
        if (r + 1 < this.rows && c + 1 < this.cols) add(i, i + this.cols + 1);
        if (r + 1 < this.rows && c > 0) add(i, i + this.cols - 1);
      }
    }

    this.geom = this._buildGeometry(o.color, o.tipColor || o.color);
    this.mesh = new THREE.Mesh(this.geom, actorGearMaterial());
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.userData.outline = true;
    this._init = false;
  }

  /** Two shells (front + back) so a single-sided material still looks solid. */
  _buildGeometry(color, tipColor) {
    const R = this.rows, C = this.cols;
    const verts = R * C * 2;
    const pos = new Float32Array(verts * 3);
    const nor = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const idx = [];
    for (let s = 0; s < 2; s++) {
      const off = s * R * C;
      for (let r = 0; r < R; r++) {
        for (let c = 0; c < C; c++) {
          const i = off + r * C + c;
          const t = r / Math.max(1, R - 1);
          col[i * 3] = lerp(color[0], tipColor[0], t);
          col[i * 3 + 1] = lerp(color[1], tipColor[1], t);
          col[i * 3 + 2] = lerp(color[2], tipColor[2], t);
          uv[i * 2] = c / Math.max(1, C - 1);
          uv[i * 2 + 1] = t;
        }
      }
      for (let r = 0; r + 1 < R; r++) {
        for (let c = 0; c + 1 < C; c++) {
          const a = off + r * C + c, b2 = a + 1, d = a + C, e = d + 1;
          if (s === 0) idx.push(a, d, e, a, e, b2);
          else idx.push(a, e, d, a, b2, e);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.2);
    return g;
  }

  /** Snap the whole strip onto its rest layout (spawn / teleport). */
  reset() {
    this.bone.updateMatrixWorld(true);
    const n = this.rows * this.cols;
    for (let i = 0; i < n; i++) {
      _cv.set(this.rest[i * 3], this.rest[i * 3 + 1], this.rest[i * 3 + 2]).applyMatrix4(this.bone.matrixWorld);
      this.p[i * 3] = this.prev[i * 3] = _cv.x;
      this.p[i * 3 + 1] = this.prev[i * 3 + 1] = _cv.y;
      this.p[i * 3 + 2] = this.prev[i * 3 + 2] = _cv.z;
    }
    this._init = true;
  }

  /**
   * @param dt      seconds
   * @param invRoot inverse of the character root matrix (world -> local)
   * @param bodyA   world capsule start (hips) for collision
   * @param bodyB   world capsule end (neck)
   * @param bodyR   capsule radius
   */
  update(dt, invRoot, bodyA, bodyB, bodyR) {
    if (!this._init) this.reset();
    const n = this.rows * this.cols;
    const h = Math.min(dt, 1 / 45);
    const h2 = h * h;
    const gust = 0.6 + 0.4 * Math.sin(_windT * 1.7) * Math.sin(_windT * 0.63 + 1.1);
    const ax = WIND.x * gust * this.windGain;
    const ay = (WIND.y * gust + this.gravity) * 1;
    const az = WIND.z * gust * this.windGain;

    // Verlet integration.
    for (let i = 0; i < n; i++) {
      if (this.pinned[i]) continue;
      const k = i * 3;
      const px = this.p[k], py = this.p[k + 1], pz = this.p[k + 2];
      this.p[k] = px + (px - this.prev[k]) * this.drag + ax * h2;
      this.p[k + 1] = py + (py - this.prev[k + 1]) * this.drag + ay * h2;
      this.p[k + 2] = pz + (pz - this.prev[k + 2]) * this.drag + az * h2;
      this.prev[k] = px; this.prev[k + 1] = py; this.prev[k + 2] = pz;
    }

    // Re-pin the anchor row to the bone.
    for (let c = 0; c < this.cols; c++) {
      const k = c * 3;
      _cv.set(this.rest[k], this.rest[k + 1], this.rest[k + 2]).applyMatrix4(this.bone.matrixWorld);
      this.prev[k] = this.p[k]; this.prev[k + 1] = this.p[k + 1]; this.prev[k + 2] = this.p[k + 2];
      this.p[k] = _cv.x; this.p[k + 1] = _cv.y; this.p[k + 2] = _cv.z;
    }

    // Distance constraints.
    const cons = this.cons, cn = cons.length;
    for (let it = 0; it < 3; it++) {
      for (let ci = 0; ci < cn; ci += 3) {
        const a = cons[ci] * 3, b2 = cons[ci + 1] * 3, rest = cons[ci + 2];
        const dx = this.p[b2] - this.p[a], dy = this.p[b2 + 1] - this.p[a + 1], dz = this.p[b2 + 2] - this.p[a + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-6) continue;
        const diff = ((d - rest) / d) * 0.5 * this.stiff;
        const wa = this.pinned[cons[ci]] ? 0 : 1, wb = this.pinned[cons[ci + 1]] ? 0 : 1;
        const sum = wa + wb;
        if (sum === 0) continue;
        const fa = (wa / sum) * 2 * diff, fb = (wb / sum) * 2 * diff;
        this.p[a] += dx * fa; this.p[a + 1] += dy * fa; this.p[a + 2] += dz * fa;
        this.p[b2] -= dx * fb; this.p[b2 + 1] -= dy * fb; this.p[b2 + 2] -= dz * fb;
      }
      // Body collision: push out of the torso capsule.
      if (this.collide && bodyA) {
        _ce1.copy(bodyB).sub(bodyA);
        const ll = Math.max(1e-6, _ce1.lengthSq());
        for (let i = this.cols; i < n; i++) {
          const k = i * 3;
          _cv.set(this.p[k], this.p[k + 1], this.p[k + 2]).sub(bodyA);
          const t = clamp01(_cv.dot(_ce1) / ll);
          _cv2.copy(_ce1).multiplyScalar(t);
          _cv.sub(_cv2);
          const d = _cv.length();
          if (d < bodyR && d > 1e-6) {
            _cv.multiplyScalar((bodyR - d) / d);
            this.p[k] += _cv.x; this.p[k + 1] += _cv.y; this.p[k + 2] += _cv.z;
          }
        }
      }
    }

    // Write into the mesh (character-local space) and rebuild normals.
    const posAttr = this.geom.attributes.position, norAttr = this.geom.attributes.normal;
    const pa = posAttr.array, na = norAttr.array;
    const R = this.rows, C = this.cols, half = R * C;
    for (let i = 0; i < n; i++) {
      _cv.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]).applyMatrix4(invRoot);
      pa[i * 3] = _cv.x; pa[i * 3 + 1] = _cv.y; pa[i * 3 + 2] = _cv.z;
    }
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const i = r * C + c;
        const rn = Math.min(R - 1, r + 1), rp = Math.max(0, r - 1);
        const cn2 = Math.min(C - 1, c + 1), cp = Math.max(0, c - 1);
        const iA = (rn * C + c) * 3, iB = (rp * C + c) * 3;
        const iC = (r * C + cn2) * 3, iD = (r * C + cp) * 3;
        _ce1.set(pa[iA] - pa[iB], pa[iA + 1] - pa[iB + 1], pa[iA + 2] - pa[iB + 2]);
        _ce2.set(pa[iC] - pa[iD], pa[iC + 1] - pa[iD + 1], pa[iC + 2] - pa[iD + 2]);
        _cn.crossVectors(_ce2, _ce1);
        if (_cn.lengthSq() < 1e-12) _cn.set(0, 0, 1); else _cn.normalize();
        const t = this.thickness;
        na[i * 3] = _cn.x; na[i * 3 + 1] = _cn.y; na[i * 3 + 2] = _cn.z;
        const j = (half + i);
        na[j * 3] = -_cn.x; na[j * 3 + 1] = -_cn.y; na[j * 3 + 2] = -_cn.z;
        pa[i * 3] += _cn.x * t; pa[i * 3 + 1] += _cn.y * t; pa[i * 3 + 2] += _cn.z * t;
        pa[j * 3] = pa[i * 3] - _cn.x * 2 * t;
        pa[j * 3 + 1] = pa[i * 3 + 1] - _cn.y * 2 * t;
        pa[j * 3 + 2] = pa[i * 3 + 2] - _cn.z * 2 * t;
      }
    }
    posAttr.needsUpdate = true;
    norAttr.needsUpdate = true;
  }

  dispose() { this.geom.dispose(); }
}

// ---------------------------------------------------------------------------
// Ragdoll-lite
// ---------------------------------------------------------------------------

// Particles: 0 hips, 1 chest, 2 head, 3 handL, 4 handR, 5 kneeL, 6 kneeR,
//            7 footL, 8 footR.
const RD_BONES = ['hips', 'spine2', 'head', 'handL', 'handR', 'shinL', 'shinR', 'footL', 'footR'];
const RD_LINKS = [[0, 1], [1, 2], [1, 3], [1, 4], [0, 5], [0, 6], [5, 7], [6, 8], [0, 2], [5, 6], [3, 4]];
// Bones driven by aiming a rest direction at a particle pair.
const RD_AIM = [
  ['hips', 0, 1], ['spine1', 0, 1], ['spine2', 1, 2], ['neck', 1, 2],
  ['thighL', 0, 5], ['thighR', 0, 6], ['shinL', 5, 7], ['shinR', 6, 8],
  ['upperArmL', 1, 3], ['upperArmR', 1, 4],
];

const _rv = new THREE.Vector3(), _rv2 = new THREE.Vector3(), _rq = new THREE.Quaternion();

class Ragdoll {
  constructor(rig, charRoot) {
    this.rig = rig;
    this.charRoot = charRoot;
    this.n = RD_BONES.length;
    this.p = new Float32Array(this.n * 3);
    this.prev = new Float32Array(this.n * 3);
    this.len = new Float32Array(RD_LINKS.length);
    this.radius = [0.16, 0.17, 0.12, 0.06, 0.06, 0.09, 0.09, 0.07, 0.07];
    this.weight = 0;
    this.active = false;
    this.groundAt = null;
  }

  /** Capture the live pose and kick it with the killing impulse. */
  start(impulse, groundAt) {
    this.groundAt = groundAt;
    this.charRoot.updateMatrixWorld(true);
    for (let i = 0; i < this.n; i++) {
      boneWorld(this.rig.boneMap[RD_BONES[i]], _rv);
      this.p[i * 3] = _rv.x; this.p[i * 3 + 1] = _rv.y; this.p[i * 3 + 2] = _rv.z;
      // Encode the impulse as a backwards previous-position offset; upper
      // particles take more of it so the body rotates as it goes down.
      const share = (i === 2 ? 1.25 : i === 1 ? 1.0 : i === 0 ? 0.7 : i < 5 ? 0.9 : 0.25) / 60;
      this.prev[i * 3] = _rv.x - impulse.x * share;
      this.prev[i * 3 + 1] = _rv.y - impulse.y * share;
      this.prev[i * 3 + 2] = _rv.z - impulse.z * share;
    }
    for (let l = 0; l < RD_LINKS.length; l++) {
      const [a, b] = RD_LINKS[l];
      this.len[l] = Math.hypot(this.p[a * 3] - this.p[b * 3], this.p[a * 3 + 1] - this.p[b * 3 + 1], this.p[a * 3 + 2] - this.p[b * 3 + 2]);
    }
    this.weight = 0;
    this.active = true;
  }

  step(dt) {
    if (!this.active) return;
    this.weight = Math.min(1, this.weight + dt * 2.8);
    const h = Math.min(dt, 1 / 45), h2 = h * h;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      const px = this.p[k], py = this.p[k + 1], pz = this.p[k + 2];
      this.p[k] = px + (px - this.prev[k]) * 0.985;
      this.p[k + 1] = py + (py - this.prev[k + 1]) * 0.985 - 9.81 * h2;
      this.p[k + 2] = pz + (pz - this.prev[k + 2]) * 0.985;
      this.prev[k] = px; this.prev[k + 1] = py; this.prev[k + 2] = pz;
    }
    for (let it = 0; it < 4; it++) {
      for (let l = 0; l < RD_LINKS.length; l++) {
        const [a, b] = RD_LINKS[l];
        const ka = a * 3, kb = b * 3, rest = this.len[l];
        const dx = this.p[kb] - this.p[ka], dy = this.p[kb + 1] - this.p[ka + 1], dz = this.p[kb + 2] - this.p[ka + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-6) continue;
        const f = ((d - rest) / d) * 0.5;
        this.p[ka] += dx * f; this.p[ka + 1] += dy * f; this.p[ka + 2] += dz * f;
        this.p[kb] -= dx * f; this.p[kb + 1] -= dy * f; this.p[kb + 2] -= dz * f;
      }
      // Ground: resolve penetration and shed tangential speed (friction).
      for (let i = 0; i < this.n; i++) {
        const k = i * 3;
        const g = this.groundAt ? this.groundAt(this.p[k], this.p[k + 2]) : 0;
        const floor = g + this.radius[i] * 0.55;
        if (this.p[k + 1] < floor) {
          this.p[k + 1] = floor;
          this.prev[k] = lerp(this.prev[k], this.p[k], 0.45);
          this.prev[k + 2] = lerp(this.prev[k + 2], this.p[k + 2], 0.45);
          if (this.prev[k + 1] > this.p[k + 1]) this.prev[k + 1] = this.p[k + 1];
        }
      }
    }
  }

  /** Blend the simulated segment directions onto the animated skeleton. */
  apply(w) {
    const bm = this.rig.boneMap;
    for (const [name, a, b] of RD_AIM) {
      const bone = bm[name];
      if (!bone) continue;
      _rv.set(this.p[b * 3] - this.p[a * 3], this.p[b * 3 + 1] - this.p[a * 3 + 1], this.p[b * 3 + 2] - this.p[a * 3 + 2]);
      if (_rv.lengthSq() < 1e-8) continue;
      _rv.normalize();
      const e = bone.matrixWorld.elements;
      _rv2.set(e[4], e[5], e[6]).normalize();          // current world +Y (down the bone)
      const dot = clamp(_rv2.dot(_rv), -1, 1);
      const ang = Math.acos(dot);
      if (ang < 1e-4) continue;
      _rv2.cross(_rv);
      if (_rv2.lengthSq() < 1e-10) continue;
      _rv2.normalize();
      bone.parent.getWorldQuaternion(_rq);
      rotateBoneWorld(bone, _rq, _rv2, ang * w);
      bone.updateMatrixWorld(true);
    }
    // Hips translation follows particle 0 so the body actually settles.
    const hips = bm.hips;
    hips.parent.updateMatrixWorld(true);
    _rv.set(this.p[0], this.p[1], this.p[2]);
    _rv.applyMatrix4(_rq2Inv(hips.parent));
    hips.position.lerp(_rv, w);
    hips.updateMatrixWorld(true);
  }
}

const _invM = new THREE.Matrix4();
function _rq2Inv(obj) { return _invM.copy(obj.matrixWorld).invert(); }

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

let _uid = 0;

export class Character {
  /**
   * @param cfg { class:'scout'|'shock'|'lancer'|'engineer'|'sniper',
   *              team:0|1, name:string, seed:number,
   *              weapon?:string, ground?:(x,z)=>number, quality?:number }
   */
  constructor(cfg = {}) {
    const cls = CLASS_ALIAS[cfg.class] || cfg.class;
    this.cls = CLASSES.indexOf(cls) >= 0 ? cls : 'scout';
    this.team = cfg.team | 0;
    this.name = cfg.name || `${this.cls}-${++_uid}`;
    this.seed = cfg.seed !== undefined ? cfg.seed : (CFG.seed + _uid * 7919);

    this.root = new THREE.Group();
    this.root.name = `char_${this.name}`;

    // --- appearance + skeleton ---------------------------------------------
    const app = makeAppearance(this.seed, this.cls, this.team);
    this.appearance = app;
    this.rig = makeRig({ bodyType: app.bodyType, heightScale: app.heightScale });

    // --- geometry ----------------------------------------------------------
    const b = new MeshBuilder();
    const opts = {
      girth: app.girth,
      shoulder: this.cls === 'shock' || this.cls === 'lancer' ? 1.05 : 1.0,
      skin: app.skin, gloves: app.gloves,
      tunic: app.tunic, tunicShade: app.tunicShade, collar: app.collar,
      trouser: app.trouser, trouserCuff: app.trouserCuff,
      leather: app.leather, belt: app.belt, boot: app.boot, bootSole: app.bootSole,
      glove: app.glove, brass: app.brass, metal: app.metal,
      accent: app.accent, trim: app.trim, canvas: app.canvas,
      hairColor: app.hairColor,
    };
    buildBody(b, this.rig, opts);
    const head = buildHead(b, this.rig, opts, app.face);
    const covered = gearHead(b, this.rig, opts, head, this.cls);
    buildHair(b, this.rig, opts, head, app.hairStyle, covered);
    gearWebbing(b, this.rig, opts, this.cls);
    gearClass(b, this.rig, opts, this.cls);

    b.bakeAO({ res: CFG.quality >= 2 ? 48 : 36, strength: 0.52, radius: 0.10 });
    this.geometry = b.finish(this.rig);
    this.mesh = createSkinnedBody(this.geometry, this.rig, actorBodyMaterial());
    this.root.add(this.mesh);

    // --- weapon -------------------------------------------------------------
    const wname = cfg.weapon || WEAPON_FOR_CLASS[this.cls] || 'gallianRifle';
    this.weapon = createWeapon(wname);
    this.weaponStats = WEAPONS[this.weapon.userData.type];
    this.weaponAnchor = new THREE.Object3D();
    this.weaponAnchor.name = 'weaponAnchor';
    this.rig.boneMap.handR.add(this.weaponAnchor);
    this.weaponAnchor.add(this.weapon);

    // --- animation ----------------------------------------------------------
    this.animator = new Animator(this.rig, { charRoot: this.root });
    this._solveWeaponAnchor(head);

    // --- cloth --------------------------------------------------------------
    this.cloth = [];
    this._buildCloth(app, head);

    // --- state --------------------------------------------------------------
    this.alive = true;
    this.lodLevel = 0;
    this._lodTimer = 0;
    this._groundAt = cfg.ground || null;
    this.ragdoll = new Ragdoll(this.rig, this.root);
    this._recoil = 0;
    this._recoilVel = 0;
    this._boltT = -1;
    this._magT = -1;
    this._muzzleOut = new THREE.Vector3();
    this._headOut = new THREE.Vector3();
    this._dirOut = new THREE.Vector3();
    this._bodyA = new THREE.Vector3();
    this._bodyB = new THREE.Vector3();
    this._invRoot = new THREE.Matrix4();
    this._handTarget = new THREE.Vector3();

    this.root.scale.setScalar(this.rig.heightScale);
    if (this._groundAt) this.animator.setGroundCallback(this._groundAt);
    this.animator.play('idle', { fade: 0 });
    this.root.updateMatrixWorld(true);
  }

  // -- construction helpers -------------------------------------------------

  /**
   * Put the rig into the aimIdle pose and solve the hand->weapon transform so
   * the sights genuinely line up with the eye. Doing it from the real pose
   * means no hand-tuned offsets to re-tune when a pose changes.
   */
  _solveWeaponAnchor(head) {
    const rig = this.rig;
    const clip = this.animator.clips.aimIdle;
    if (!clip) return;
    for (const track of clip.tracks) {
      const dot = track.name.indexOf('.');
      const bone = rig.boneMap[track.name.slice(0, dot)];
      if (!bone) continue;
      if (track.name.endsWith('.quaternion')) bone.quaternion.fromArray(track.values, 0);
      else if (track.name.endsWith('.position')) bone.position.fromArray(track.values, 0);
    }
    this.root.updateMatrixWorld(true);

    const hand = rig.boneMap.handR;
    const ws = this.weapon.scale.x;
    const sightLocal = this.weapon.userData.sight.position.clone().multiplyScalar(ws);

    // Eye reference from the posed head, not the rest pose.
    boneWorld(rig.boneMap.head, _cv);
    const eyeY = _cv.y + head.radius[1] * 0.60;
    const kind = this.weaponStats ? this.weaponStats.kind : 'rifle';
    const relief = kind === 'sniper' ? 0.09 : kind === 'lance' ? 0.26 : 0.13;
    const lateral = kind === 'lance' ? -0.085 : -0.032;
    const drop = kind === 'lance' ? 0.02 : 0;

    const sightWorld = new THREE.Vector3(_cv.x + lateral, eyeY - drop, _cv.z + head.radius[2] * 0.9 + relief);
    const cant = kind === 'lance' ? -0.12 : -0.05;
    const wq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, cant));
    const wpos = sightWorld.clone().sub(sightLocal.clone().applyQuaternion(wq));
    const weaponWorld = new THREE.Matrix4().compose(wpos, wq, new THREE.Vector3(1, 1, 1));

    const local = new THREE.Matrix4().copy(hand.matrixWorld).invert().multiply(weaponWorld);
    local.decompose(this.weaponAnchor.position, this.weaponAnchor.quaternion, this.weaponAnchor.scale);

    // Restore the bind pose so the cloth anchors and AO reference stay honest.
    for (const n in rig.restLocal) {
      const bone = rig.boneMap[n];
      bone.position.copy(rig.restLocal[n].pos);
      bone.quaternion.copy(rig.restLocal[n].quat);
    }
    this.root.updateMatrixWorld(true);
  }

  _buildCloth(app, head) {
    const rig = this.rig;
    const inv = new THREE.Matrix4();
    const local = (boneName, worldish) => {
      inv.copy(rig.boneMap[boneName].matrixWorld).invert();
      return _cv.copy(worldish).applyMatrix4(inv).toArray();
    };
    const hy = rig.restWorld.hips.pos.y;
    const g = app.girth;

    // Tunic tail at the back of the hem — everybody has one.
    {
      const anchor = new THREE.Vector3(0, hy - 0.185, -0.128 * g);
      const o = local('hips', anchor);
      const dirW = new THREE.Vector3(0, -1, -0.12).normalize();
      const sideW = new THREE.Vector3(1, 0, 0);
      const q = new THREE.Quaternion();
      rig.boneMap.hips.getWorldQuaternion(q);
      q.invert();
      const strip = new ClothStrip({
        bone: rig.boneMap.hips, rows: 4, cols: 4,
        spacing: 0.052, colSpacing: 0.058,
        origin: o,
        dir: dirW.applyQuaternion(q).toArray(),
        side: sideW.applyQuaternion(q).toArray(),
        color: app.tunicShade, tipColor: mixCol(app.tunicShade, app.trouser, 0.35),
        stiff: 0.94, gravity: -11, drag: 0.972, windGain: 0.6, thickness: 0.005,
      });
      this.cloth.push(strip);
    }

    // Sniper scarf.
    if (this.cls === 'sniper') {
      const ny = rig.restWorld.neck.pos.y;
      const anchor = new THREE.Vector3(0.02, ny + 0.02, -0.055);
      const q = new THREE.Quaternion();
      rig.boneMap.neck.getWorldQuaternion(q); q.invert();
      this.cloth.push(new ClothStrip({
        bone: rig.boneMap.neck, rows: 6, cols: 3,
        spacing: 0.062, colSpacing: 0.042,
        origin: local('neck', anchor),
        dir: new THREE.Vector3(-0.15, -1, -0.30).normalize().applyQuaternion(q).toArray(),
        side: new THREE.Vector3(1, 0, -0.1).normalize().applyQuaternion(q).toArray(),
        color: app.scarf, tipColor: mixCol(app.scarf, app.accent, 0.25),
        stiff: 0.86, gravity: -7.5, drag: 0.986, windGain: 2.2, thickness: 0.004,
      }));
    }

    // Lancer coat tail: longer and heavier.
    if (this.cls === 'lancer') {
      const anchor = new THREE.Vector3(0.09 * g, hy - 0.19, -0.06);
      const q = new THREE.Quaternion();
      rig.boneMap.hips.getWorldQuaternion(q); q.invert();
      this.cloth.push(new ClothStrip({
        bone: rig.boneMap.hips, rows: 5, cols: 3,
        spacing: 0.062, colSpacing: 0.05,
        origin: local('hips', anchor),
        dir: new THREE.Vector3(0.1, -1, -0.1).normalize().applyQuaternion(q).toArray(),
        side: new THREE.Vector3(0.3, 0, -1).normalize().applyQuaternion(q).toArray(),
        color: app.tunicShade, tipColor: mixCol(app.tunicShade, PALETTE.metalDark, 0.25),
        stiff: 0.95, gravity: -12, drag: 0.968, windGain: 0.5, thickness: 0.006,
      }));
    }

    // Ponytail.
    if (app.hairStyle === 'ponytail') {
      const C = head.center, R = head.radius;
      const anchor = new THREE.Vector3(C[0], C[1] + R[1] * 0.30, C[2] - R[2] * 1.02);
      const q = new THREE.Quaternion();
      rig.boneMap.head.getWorldQuaternion(q); q.invert();
      this.cloth.push(new ClothStrip({
        bone: rig.boneMap.head, rows: 5, cols: 2,
        spacing: 0.046, colSpacing: 0.030,
        origin: local('head', anchor),
        dir: new THREE.Vector3(0, -0.75, -0.66).normalize().applyQuaternion(q).toArray(),
        side: new THREE.Vector3(1, 0, 0).applyQuaternion(q).toArray(),
        color: app.hairColor, tipColor: mixCol(app.hairColor, rgbLin(0x1d1712), 0.3),
        stiff: 0.92, gravity: -9, drag: 0.978, windGain: 1.1, thickness: 0.011,
        collide: false,
      }));
    }

    for (const c of this.cloth) { c.reset(); this.root.add(c.mesh); }
  }

  // -- public API -----------------------------------------------------------

  /** @param clip one of the ARCHITECTURE clip names or an alias. */
  play(clip, opts = {}) {
    if (!this.alive && clip !== 'death' && clip !== 'deathBack') return this;
    this.animator.play(clip, opts);
    const name = CLIP_ALIASES[clip] || clip;
    if (name === 'fire') this._kickRecoil();
    if (name === 'reload') { this._magT = 0; this._boltT = -1; }
    return this;
  }

  /** Additive upper-body aim, radians, relative to the character's facing. */
  setAimAngles(yaw, pitch) { this.animator.setAimAngles(yaw, pitch); return this; }
  clearAim() { this.animator.clearAim(); return this; }
  setLookTarget(v) { this.animator.setLookTarget(v); return this; }
  setLocomotion(speed, opts) { this.animator.setLocomotion(speed, opts); return this; }
  setGroundCallback(fn) { this._groundAt = fn; this.animator.setGroundCallback(fn); return this; }
  setStance(s) { this.animator.setLocomotion(this.animator.speed, { stance: s }); return this; }

  /** Muzzle flash / tracer origin, straight off the weapon bone transform. */
  muzzlePoint(out) {
    const t = out || this._muzzleOut;
    const m = this.weapon && this.weapon.userData.muzzle;
    if (m) { const e = m.matrixWorld.elements; return t.set(e[12], e[13], e[14]); }
    return this.headPoint(t);
  }

  /** Bore direction in world space (normalised). */
  aimDirection(out) {
    const t = out || this._dirOut;
    const m = this.weapon && this.weapon.userData.muzzle;
    if (m) { const e = m.matrixWorld.elements; return t.set(e[8], e[9], e[10]).normalize(); }
    return t.set(0, 0, 1).applyQuaternion(this.root.quaternion).normalize();
  }

  /** Eye-level head point — used for LOS checks and damage popups. */
  headPoint(out) {
    const t = out || this._headOut;
    const bone = this.rig.boneMap.head;
    const e = bone.matrixWorld.elements;
    const s = this.root.scale.y;
    return t.set(e[12] + e[4] * 0.085 * s, e[13] + e[5] * 0.085 * s, e[14] + e[6] * 0.085 * s);
  }

  /** Fire feedback: weapon kick + bolt cycle + a muzzle-relative impulse. */
  _kickRecoil() {
    const st = this.weaponStats;
    this._recoilVel += (st ? st.recoil : 0.03) * 34;
    this._boltT = 0;
  }
  fire() { this.play('fire'); return this.muzzlePoint(); }

  /**
   * Kill the character. `dir` is the incoming shot direction (world), `power`
   * scales the impulse; the ragdoll takes over from the death clip over ~0.4 s.
   */
  die(opts = {}) {
    if (!this.alive) return this;
    this.alive = false;
    const dir = opts.dir ? _cv.copy(opts.dir).normalize() : _cv.set(0, 0, 1).applyQuaternion(this.root.quaternion).negate();
    // Facing dot decides whether they pitch forward or are blown onto their back.
    _cv2.set(0, 0, 1).applyQuaternion(this.root.quaternion);
    const back = dir.dot(_cv2) < -0.15;
    this.animator.play(back ? 'deathBack' : 'death', { fade: 0.09 });
    this.animator.clearAim();
    this.animator.setLookTarget(null);
    this.animator.ikEnabled = false;
    const power = (opts.power !== undefined ? opts.power : 1) * 2.6;
    _cv3.copy(dir).multiplyScalar(power).add(_cv2.set(0, 1.1, 0));
    this.ragdoll.start(_cv3, this._groundAt || (() => this.root.position.y));
    return this;
  }

  revive() {
    this.alive = true;
    this.ragdoll.active = false;
    this.ragdoll.weight = 0;
    this.animator.ikEnabled = true;
    this.animator.play('idle', { fade: 0.2 });
    return this;
  }

  set lod(n) { this.lodLevel = n; }

  update(dt) {
    if (!this.root.visible) return;
    const lod = this.lodLevel | 0;
    this.animator.lodLevel = lod;

    // LOD 3 characters tick at 12 Hz with no procedural layers at all.
    if (lod >= 3) {
      this._lodTimer += dt;
      if (this._lodTimer < 1 / 12) return;
      dt = this._lodTimer;
      this._lodTimer = 0;
    }

    // Support hand snaps onto the foregrip whenever the pose calls for it.
    const hands = this.animator.handsMode;
    if (this.alive && lod < 2 && hands === 'weapon' && this.weapon) {
      const fg = this.weapon.userData.foreGrip;
      const e = fg.matrixWorld.elements;
      this._handTarget.set(e[12], e[13], e[14]);
      this.animator.setHandTarget(this._handTarget, 1);
    } else {
      this.animator.setHandTarget(null, 0);
    }

    this.animator.update(dt);

    // Ragdoll blends in over the death clip.
    if (this.ragdoll.active) {
      this.ragdoll.step(dt);
      this.ragdoll.apply(this.ragdoll.weight * 0.92);
      this.root.updateMatrixWorld(true);
    }

    this._updateWeapon(dt);

    if (lod < 1 && this.cloth.length) {
      _windT += dt;
      this._invRoot.copy(this.root.matrixWorld).invert();
      boneWorld(this.rig.boneMap.hips, this._bodyA);
      boneWorld(this.rig.boneMap.neck, this._bodyB);
      const r = 0.155 * this.appearance.girth * this.root.scale.y;
      for (const c of this.cloth) c.update(dt, this._invRoot, this._bodyA, this._bodyB, r);
    }
  }

  /** Recoil spring, bolt cycling and the reload magazine drop. */
  _updateWeapon(dt) {
    const w = this.weapon;
    if (!w) return;
    const ud = w.userData;

    if (this._recoil !== 0 || this._recoilVel !== 0) {
      // Critically-damped-ish spring back to zero.
      this._recoilVel += (-this._recoil * 900 - this._recoilVel * 46) * dt;
      this._recoil += this._recoilVel * dt;
      if (Math.abs(this._recoil) < 1e-4 && Math.abs(this._recoilVel) < 1e-3) { this._recoil = 0; this._recoilVel = 0; }
      w.position.z = -Math.abs(this._recoil) * 0.06;
      w.rotation.x = -this._recoil * 0.05;
    }

    if (ud.bolt && ud.boltThrow) {
      if (this._boltT >= 0) {
        this._boltT += dt;
        const t = this._boltT / 0.14;
        const s = t < 1 ? Math.sin(clamp01(t) * Math.PI) : 0;
        ud.bolt.position.z = ud.boltRest.z + ud.boltThrow * s;
        if (t >= 1) { this._boltT = -1; ud.bolt.position.copy(ud.boltRest); }
      }
    }

    if (ud.mag && this._magT >= 0) {
      this._magT += dt;
      const t = this._magT / (CLIP_META.reload.dur);
      // Out at 0.30, back in by 0.68 — matches the reload clip's hand timing.
      let drop = 0;
      if (t > 0.28 && t < 0.66) drop = smoothstep(0.28, 0.40, t) * (1 - smoothstep(0.54, 0.66, t));
      ud.mag.position.y = ud.magRest.y - drop * 0.20;
      ud.mag.position.z = ud.magRest.z - drop * 0.03;
      if (t >= 1) { this._magT = -1; ud.mag.position.copy(ud.magRest); }
    }
  }

  dispose() {
    this.animator.dispose();
    for (const c of this.cloth) { this.root.remove(c.mesh); c.dispose(); }
    this.cloth.length = 0;
    this.geometry.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
    this.mesh.skeleton.dispose?.();
    this.root.clear();
  }
}

/** Convenience: a full six-person Squad 7 line-up with no two alike. */
export function makeSquad(seed = CFG.seed, team = 0) {
  const rng = makeRng(seed);
  const roster = ['scout', 'scout', 'shock', 'shock', 'lancer', 'engineer', 'sniper'];
  const names = ['Alicia', 'Rosie', 'Largo', 'Edy', 'Zaka', 'Kreis', 'Marina', 'Susie', 'Vyse', 'Aika'];
  const out = [];
  for (let i = 0; i < roster.length; i++) {
    out.push(new Character({
      class: roster[i], team, name: names[i % names.length],
      seed: (seed + i * 7919 + Math.floor(rng() * 1000)) | 0,
    }));
  }
  return out;
}

export { CLASSES, WEAPONS };
