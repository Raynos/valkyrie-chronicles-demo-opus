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
    bootWelt: PALETTE.bootWelt,
    cap: tint(imperial ? base.collar : PALETTE.cap, wear),
    capShade: tint(imperial ? PALETTE.impLeather : PALETTE.capShade, wear),
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
  // Shell OFFSET, applied on top of the skull's own displacement (head.disp).
  // A flat 1.035·R shell measured off the undisplaced ellipsoid ends up *inside*
  // the cranium — the skull bulges by up to 5.8% at the crown — which is why
  // hair was invisible on every soldier.
  // 1.016 was a 1.9 mm shell over the skull. That is inside the depth buffer's
  // resolving power at 30 m (near 0.15 / far 900), so on `overview` the skull
  // won the depth test across the whole back of the head and every distant
  // soldier rendered as a bare pale egg with a thin dark ring of hair round the
  // silhouette — the "balloon" read, caused not by proportion but by z-fighting.
  // 1.034 is ~4 mm and still well inside the scout cap's 1.085 shell and the
  // helmet's 1.16, so nothing pokes through.
  const thick = coveredByHat ? 1.034 : 1.062;
  const D = head.disp || (() => [1, 1, 1]);
  b.setBones(BONE_GROUPS.HEAD).setColor(hc).setMottle(0.09);

  // u = 0 at +Z (face), 0.25 at +X (character's left), 0.5 at -Z (nape).
  const front = style === 'crop' ? 0.40 : style === 'sidePart' ? 0.44 : 0.47;
  // phiMax is measured from the CROWN in half-turns, so it is how far DOWN the
  // scalp cap reaches: 0.5 is the equator (ear-top height), and dy = cos(phi*PI).
  //
  // Round 2 evaluated to 0.82 at the sides — dy = cos(148 deg) = -0.85, which is
  // BELOW THE JAW. That is the entire explanation for the closeup critique's
  // "dark irregular paint-splat plastered across the MIDDLE of the near cheek
  // with a second detached blob on the jaw": the scalp cap was being swept down
  // over the cheekbone and the mandible, on both sides, on every soldier. The
  // hairline is now clamped so it can never pass the ear line on the sides
  // (0.545, dy = -0.14) and never reaches the cheek plane at all; only the nape,
  // where hair genuinely does hang below the ear, is allowed past it.
  const phiMax = (u) => {
    const a = u * TAU;
    const cz = Math.cos(a);                 // +1 facing forward
    const cx = Math.sin(a);
    const backness = clamp01(-cz);          // 0 at the face, 1 at the nape
    // Forward hairline sits high, sides come down to the ear line, nape lowest.
    let m = 0.455 + 0.075 * (1 - clamp01(cz)) + 0.155 * backness;
    m -= front * 0.30 * clamp01(cz) * clamp01(cz);
    if (style === 'sidePart') m += 0.05 * clamp01(cx) * clamp01(cz);
    if (style === 'bob' || style === 'swept') m += 0.20 * backness + 0.055 * Math.abs(cx);
    if (style === 'bun' || style === 'ponytail') m -= 0.04 * backness;
    // HARD CEILING, independent of style: everything forward of the ear axis is
    // capped at the ear line (phi 0.50 = the equator = dy 0). Only the rear
    // third may hang lower. At 0.545 the cap still reached dy -0.14, i.e. 17 mm
    // below the eye line onto the cheek, which is what made every soldier read
    // as wearing a dark helmet of hair.
    let ceiling = 0.500 + 0.345 * smoothstep(0.15, 0.85, backness);
    // UNDER HEADGEAR the ceiling is far tighter, and this is the one that was
    // doing real damage. The shocktrooper helmet's front edge sits at phi 0.300
    // (dy +0.59, high on the forehead) while the hairline ran to 0.425 and the
    // wisp band under it to 0.425 as well, so 22 degrees of arc — the entire
    // forehead from the helmet brim down to the eyebrow — rendered as bare hair.
    // On `squad` that measured (114,72,74), hue 357, sat 0.37: a saturated brick
    // -red block sitting exactly where the soldier's face should be, and by far
    // the loudest thing on him. Capping the front at 0.345 leaves an 8-degree
    // fringe under the tightest brim and nothing at all under a garrison cap,
    // which is correct: a cap sits ON the crown and what shows is nape and
    // sideburn, not a full band across the brow.
    if (coveredByHat) ceiling = Math.min(ceiling, 0.345 + 0.285 * backness);
    return clamp(Math.min(m, ceiling), 0.26, 0.86);
  };
  b.addEllipsoid({
    center: [C[0], C[1] + 0.004, C[2] - 0.004],
    radius: [R[0], R[1], R[2]],
    seg: seg(20), rings: seg(11), phiMax,
    displace: (dx, dy, dz, u, v) => {
      // Tufted silhouette: low-frequency lumps plus a wispy edge.
      const t = 1 + 0.030 * Math.sin(u * TAU * 5 + dy * 6) * (0.4 + v)
        + 0.018 * Math.sin(u * TAU * 11 + 1.7) * v;
      const edge = 1 - 0.06 * smoothstep(0.82, 1.0, v);
      const k = D(dx, dy, dz);
      const s = thick * t * edge;
      return [k[0] * s, k[1] * s, k[2] * s];
    },
  });

  if (coveredByHat) {
    // A cap or a helmet still leaves the nape and the sideburns showing — that
    // band of hair under the brim is most of what tells one soldier's head from
    // the next, and without it every capped soldier reads as a bare egg.
    //
    // The band must tuck UNDER the cap at the front (or it draws across the
    // brow) and swing low at the sides and the nape.
    b.addEllipsoid({
      center: [C[0], C[1] - 0.002, C[2] - 0.006],
      radius: [R[0], R[1], R[2]],
      seg: seg(20), rings: seg(7),
      // Tracks the same ceiling as the scalp cap above (0.345 at the brow,
      // 0.630 at the nape) so the wisp band cannot reintroduce the forehead
      // block the cap was just clamped out of. phiMin drops to 0.28 so the band
      // still has a body at the front where phiMax is now tight.
      phiMin: 0.28,
      phiMax: (u) => 0.345 + 0.285 * clamp01(-Math.cos(u * TAU)),
      displace: (dx, dy, dz, u, v) => {
        const k = D(dx, dy, dz);
        const s = 1.038 * (1 + 0.022 * Math.sin(u * TAU * 6 + 0.7) * v)
          * (1 - 0.05 * smoothstep(0.85, 1.0, v));
        return [k[0] * s, k[1] * s, k[2] * s];
      },
    });
    // Sideburn wisps in front of each ear so the hairline is not a clean arc.
    for (const side of [1, -1]) {
      b.addTube([
        { p: [side * R[0] * 0.88, C[1] + R[1] * 0.26, C[2] + R[2] * 0.32], rx: 0.008, rz: 0.007 },
        { p: [side * R[0] * 0.95, C[1] + R[1] * 0.04, C[2] + R[2] * 0.27], rx: 0.009, rz: 0.008 },
        { p: [side * R[0] * 0.93, C[1] - R[1] * 0.14, C[2] + R[2] * 0.20], rx: 0.006, rz: 0.005 },
      ], { seg: seg(7), capStart: 'flat', capEnd: 'round' });
    }
    return;
  }

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

/** Belt, cross-brace webbing, pouches, canteen, shoulder crest — worn by everyone. */
function gearWebbing(b, rig, o, cls) {
  const g = o.girth;
  const hy = rig.restWorld.hips.pos.y;
  // The belt rides the NATURAL WAIST (hy+0.045), which is the narrowest section
  // of the torso (0.128*g) and just above the tunic skirt. Sitting on the hip
  // at hy-0.030 it was inside the 0.155*g skirt and invisible.
  const beltY = hy + 0.045;
  b.setBones(BONE_GROUPS.TORSO).setMottle(0.05);

  // Belt: wide, and standing ~17 mm proud of the waist so it cuts the figure at
  // the narrowest point. That single horizontal break is most of what turns a
  // sack into a uniform.
  band(b, beltY, 0.144 * g, 0.107 * g, 0.030, 0.036, o.belt);
  b.setColor(o.brass);
  b.addRoundedBox({ center: [0, beltY, 0.120 * g], size: [0.030, 0.024, 0.012], bevel: 0.004, div: 2 });

  // --- Cross-brace. Two straps that CROSS on the sternum, run over opposite
  // shoulders and down the back to the belt. The old routing put both straps
  // near-vertical at x = +/-0.03..0.09 on the front, so they read as two faint
  // parallel stripes; an X reads as harness at any distance and at any angle,
  // and it is what Gallian militia webbing actually looks like.
  b.setColor(o.leather).setMottle(0.045);
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const ua = rig.restWorld['upperArm' + s].pos, cl = rig.restWorld['clavicle' + s].pos;
    const apexX = Math.abs(lerp(cl.x, ua.x, 0.50));
    const apexY = ua.y + 0.082 * g;
    const chestY = hy + 0.310;
    b.addTube([
      // front: opposite hip -> across the sternum -> this shoulder
      { p: [-side * 0.076 * g, beltY + 0.010, 0.102 * g], rx: 0.024, rz: 0.008 },
      { p: [-side * 0.030 * g, hy + 0.150, 0.118 * g], rx: 0.024, rz: 0.008 },
      { p: [side * 0.028 * g, chestY - 0.030, 0.122 * g], rx: 0.025, rz: 0.008 },
      { p: [side * 0.088 * g, chestY + 0.052, 0.104 * g], rx: 0.025, rz: 0.008 },
      { p: [side * apexX * 0.94, apexY - 0.020, 0.056 * g], rx: 0.025, rz: 0.008 },
      { p: [side * apexX, apexY, 0.004 * g], rx: 0.026, rz: 0.009 },        // over the shoulder
      { p: [side * apexX * 0.94, apexY - 0.026, -0.050 * g], rx: 0.025, rz: 0.008 },
      { p: [side * 0.092 * g, chestY + 0.055, -0.086 * g], rx: 0.023, rz: 0.008 },
      { p: [side * 0.056 * g, hy + 0.170, -0.110 * g], rx: 0.022, rz: 0.007 },
      { p: [side * 0.034 * g, beltY + 0.008, -0.112 * g], rx: 0.021, rz: 0.007 },
    ], { seg: seg(8), capStart: 'flat', capEnd: 'flat' });
  }
  // Brass D-ring where the straps cross.
  b.setColor(o.brass);
  b.addRoundedBox({ center: [0, hy + 0.250, 0.126 * g], size: [0.017, 0.014, 0.007], bevel: 0.003, div: 2 });

  // Ammo pouches on the belt front — bigger and squarer than before, with a
  // buckled flap, so they survive as shapes rather than smudges.
  const pouches = cls === 'shock' ? 3 : cls === 'lancer' ? 1 : 2;
  for (let i = 0; i < pouches; i++) {
    const t = pouches === 1 ? 0 : (i / (pouches - 1)) * 2 - 1;
    const a = t * 0.66;
    const px = Math.sin(a) * 0.132 * g, pz = Math.cos(a) * 0.114 * g + 0.014;
    b.setColor(o.leather);
    b.addRoundedBox({ center: [px, beltY - 0.042, pz], size: [0.036, 0.042, 0.023], bevel: 0.008, div: 2 });
    b.setColor(o.belt);
    b.addRoundedBox({ center: [px * 1.02, beltY - 0.010, pz * 1.03], size: [0.037, 0.014, 0.024], bevel: 0.005, div: 2 });
    b.setColor(o.brass);
    b.addRoundedBox({ center: [px * 1.04, beltY - 0.026, pz * 1.06], size: [0.006, 0.008, 0.004], bevel: 0.002, div: 1 });
  }

  // Canteen on the right hip, bread bag on the left.
  b.setColor(mixCol(o.metal, o.canvas, 0.5));
  b.setTransform(_m4.makeTranslation(-0.140 * g, beltY - 0.088, -0.030));
  b.addRoundedBox({ size: [0.036, 0.048, 0.020], bevel: 0.014, div: 3 });
  b.setTransform(null);
  b.setColor(o.canvas);
  b.addRoundedBox({ center: [0.144 * g, beltY - 0.086, -0.044], size: [0.038, 0.046, 0.024], bevel: 0.010, div: 2 });

  // Squad 7 shoulder crest: a domed shield patch on the left upper arm, with a
  // cream border so it reads as an insignia and not as a wound.
  const sh = rig.restWorld.upperArmL.pos;
  b.setBones(BONE_GROUPS.ARM_L).setMottle(0.04);
  b.setTransform(_m4.compose(
    new THREE.Vector3(sh.x + 0.050 * g, sh.y - 0.050, sh.z + 0.006),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 0.5, 0.1)),
    new THREE.Vector3(1, 1, 1)));
  b.setColor(mixCol(o.trim, o.tunicShade, 0.42));
  b.addEllipsoid({ radius: [0.031, 0.041, 0.015], seg: seg(10), rings: seg(6), phiMax: () => 0.5 });
  b.setColor(o.accent);
  b.addEllipsoid({ center: [0, 0.002, 0.003], radius: [0.025, 0.034, 0.016], seg: seg(10), rings: seg(6), phiMax: () => 0.48 });
  b.setColor(mixCol(o.trim, o.accent, 0.30));
  b.addEllipsoid({ center: [0, 0.004, 0.006], radius: [0.011, 0.016, 0.014], seg: seg(9), rings: seg(5), phiMax: () => 0.44 });
  b.setTransform(null);

  // Rank chevrons on the right sleeve.
  const shR = rig.restWorld.upperArmR.pos;
  b.setBones(BONE_GROUPS.ARM_R).setColor(o.trim);
  for (let i = 0; i < 2; i++) {
    b.addTube([
      { p: [shR.x - 0.030, shR.y - 0.072 - i * 0.017, shR.z + 0.038], rx: 0.005, rz: 0.0026 },
      { p: [shR.x - 0.050, shR.y - 0.063 - i * 0.017, shR.z + 0.006], rx: 0.005, rz: 0.0026 },
      { p: [shR.x - 0.034, shR.y - 0.072 - i * 0.017, shR.z - 0.028], rx: 0.005, rz: 0.0026 },
    ], { seg: seg(5), capStart: 'flat', capEnd: 'flat' });
  }
}

/** Class headgear. Returns true when hair should be suppressed on the crown. */
function gearHead(b, rig, o, head, cls) {
  const R = head.radius, C = head.center;
  // Every shell here is measured off the SAME displaced skull the skin uses
  // (see buildHead's `disp`), otherwise the cranium bulge swallows it.
  const D = head.disp || (() => [1, 1, 1]);
  const shell = (k, extra) => (dx, dy, dz) => {
    const d = D(dx, dy, dz);
    const s = typeof extra === 'function' ? extra(dx, dy, dz) : 1;
    const sx = typeof s === 'number' ? s : s[0];
    const sy = typeof s === 'number' ? s : s[1];
    const sz = typeof s === 'number' ? s : s[2];
    return [d[0] * k * sx, d[1] * k * sy, d[2] * k * sz];
  };
  b.setBones(BONE_GROUPS.HEAD).setMottle(0.05);

  if (cls === 'scout') {
    // Garrison side cap: a deep cap pinched into a fore-and-aft ridge, sitting
    // on the crown with a clear brim edge above the ear.
    //
    // phiMax is measured from the crown, so it decides how far DOWN the cap
    // reaches. It has to stop above the brow at the front (dy ≈ +0.31) and dip
    // over the ears and nape — a constant value large enough to look like a cap
    // from the side reaches past the eyes at the front and renders the face as
    // a blank shell.
    const capEdge = (u) => {
      const cz = Math.cos(u * TAU);              // +1 face, -1 nape
      return 0.455 - 0.075 * clamp01(cz) + 0.085 * clamp01(-cz);
    };
    b.setColor(o.cap);
    b.addEllipsoid({
      center: [C[0], C[1] + 0.010, C[2] - 0.004],
      radius: R, seg: seg(20), rings: seg(9),
      phiMax: capEdge,
      displace: shell(1.085, (dx, dy) => [1 - 0.34 * clamp01(dy) * clamp01(dy), 1 + 0.06 * clamp01(dy), 1]),
    });
    // Turn-up band around the cap's lower edge.
    b.setColor(o.capShade);
    b.addEllipsoid({
      center: [C[0], C[1] + 0.006, C[2] - 0.004],
      radius: R, seg: seg(20), rings: seg(3),
      phiMin: 0.34, phiMax: (u) => capEdge(u) + 0.038,
      displace: shell(1.112, (dx, dy) => [1 - 0.20 * clamp01(dy) * clamp01(dy), 1, 1]),
    });
    // Regimental piping along the crown fold, front to back — not a band across
    // the brow, which is where it used to sit and read as a headband.
    b.setColor(o.accent);
    b.addTube([
      { p: [C[0], C[1] + R[1] * 0.62, C[2] + R[2] * 0.78], rx: 0.0062, rz: 0.0052 },
      { p: [C[0], C[1] + R[1] * 1.02, C[2] + R[2] * 0.18], rx: 0.0072, rz: 0.0058 },
      { p: [C[0], C[1] + R[1] * 0.94, C[2] - R[2] * 0.52], rx: 0.0068, rz: 0.0054 },
      { p: [C[0], C[1] + R[1] * 0.60, C[2] - R[2] * 0.88], rx: 0.0055, rz: 0.0046 },
    ], { seg: seg(7), capStart: 'round', capEnd: 'round' });
    return true;
  }

  if (cls === 'shock' || cls === 'lancer') {
    // Stamped steel helmet. Built as an offset SHELL of the skull with an
    // angle-varying edge, not as a lathe: a lathe's rim is a horizontal circle,
    // so to clear the ears at the side it had to sit below the brow at the
    // front — which is exactly why the second soldier in the closeup shot had
    // "no face, a blank tan oval with a flat crimson strip across the eye
    // line". The edge now stops at dy >= +0.30 across the front (above the
    // brow) and swings down over the ears and the nape.
    const helmEdge = (u) => {
      const cz = Math.cos(u * TAU);              // +1 face, -1 nape
      return 0.400 - 0.100 * clamp01(cz) + 0.145 * clamp01(-cz);
    };
    b.setColor(mixCol(o.metal, o.tunicShade, 0.45));
    b.addEllipsoid({
      center: [C[0], C[1] + 0.004, C[2] - 0.008],
      radius: R, seg: seg(20), rings: seg(10),
      phiMax: helmEdge,
      displace: shell(1.16, (dx, dy) => [1 + 0.04 * clamp01(-dy), 1 - 0.10 * clamp01(dy) * clamp01(dy), 1 + 0.03 * clamp01(-dy)]),
    });
    // Rolled brim, flared outboard — this is the silhouette that says
    // "shocktrooper" from 60 m away.
    b.setColor(mixCol(o.metal, PALETTE.metalDark, 0.35));
    b.addEllipsoid({
      center: [C[0], C[1] + 0.002, C[2] - 0.008],
      radius: R, seg: seg(20), rings: seg(3),
      phiMin: 0.30, phiMax: (u) => helmEdge(u) + 0.055,
      displace: shell(1.235, (dx, dy) => [1, 1 - 0.16 * clamp01(dy), 1]),
    });
    // Rivets round the brim line.
    b.setColor(mixCol(o.metal, o.tunicShade, 0.15));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.4;
      const rr = R[0] * 1.20, rd = R[2] * 1.20;
      b.addTube([
        { p: [C[0] + Math.sin(a) * rr * 0.94, C[1] + 0.012, C[2] - 0.008 + Math.cos(a) * rd * 0.94], rx: 0.0062, rz: 0.0062 },
        { p: [C[0] + Math.sin(a) * rr * 1.02, C[1] + 0.012, C[2] - 0.008 + Math.cos(a) * rd * 1.02], rx: 0.0052, rz: 0.0052 },
      ], { seg: seg(6), capEnd: 'round' });
    }
    // Chin strap, hanging clear of the jaw.
    b.setColor(o.leather);
    b.addTube([
      { p: [C[0] + R[0] * 1.14, C[1] - 0.014, C[2] - 0.014], rx: 0.009, rz: 0.0038 },
      { p: [C[0] + R[0] * 0.92, C[1] - R[1] * 0.74, C[2] + R[2] * 0.26], rx: 0.009, rz: 0.0038 },
      { p: [C[0], C[1] - R[1] * 1.00, C[2] + R[2] * 0.40], rx: 0.010, rz: 0.0038 },
      { p: [C[0] - R[0] * 0.92, C[1] - R[1] * 0.74, C[2] + R[2] * 0.26], rx: 0.009, rz: 0.0038 },
      { p: [C[0] - R[0] * 1.14, C[1] - 0.014, C[2] - 0.014], rx: 0.009, rz: 0.0038 },
    ], { seg: seg(6), capStart: 'flat', capEnd: 'flat' });
    return true;
  }

  if (cls === 'engineer') {
    // Peaked service cap: a flat-topped crown on a band, with a long visor.
    const capEdge = (u) => {
      const cz = Math.cos(u * TAU);
      return 0.410 - 0.070 * clamp01(cz) + 0.115 * clamp01(-cz);
    };
    b.setColor(o.cap);
    b.addEllipsoid({
      center: [C[0], C[1] + 0.016, C[2] - 0.004],
      radius: R, seg: seg(18), rings: seg(8),
      phiMax: capEdge,
      // Flat top, flared out at the front — a service cap, not a beanie.
      displace: shell(1.10, (dx, dy, dz) => [
        1 + 0.10 * clamp01(dy) * clamp01(dz), 1 - 0.30 * clamp01(dy) * clamp01(dy), 1 + 0.12 * clamp01(dy) * clamp01(dz),
      ]),
    });
    b.setColor(o.capShade);
    b.addEllipsoid({
      center: [C[0], C[1] + 0.008, C[2] - 0.004],
      radius: R, seg: seg(18), rings: seg(3),
      phiMin: 0.30, phiMax: (u) => capEdge(u) + 0.060,
      displace: shell(1.115),
    });
    // Visor.
    b.setColor(mixCol(o.leather, PALETTE.metalDark, 0.4));
    b.setTransform(_m4.compose(
      new THREE.Vector3(C[0], C[1] + 0.026, C[2] + R[2] * 0.60),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.34, 0, 0)),
      new THREE.Vector3(1, 1, 1)));
    b.addEllipsoid({
      radius: [R[0] * 1.06, 0.008, R[2] * 0.90], seg: seg(14), rings: seg(5),
      phiMax: (u) => (Math.cos(u * TAU) > 0 ? 1 : 0.5),
    });
    b.setTransform(null);
    b.setColor(o.brass);
    b.addRoundedBox({ center: [0, C[1] + 0.052, C[2] + R[2] * 1.06], size: [0.012, 0.011, 0.005], bevel: 0.003, div: 2 });
    return true;
  }

  // sniper: soft field cap with a long bill, worn back off the brow
  b.setColor(mixCol(o.cap, o.trouser, 0.35));
  b.addEllipsoid({
    center: [C[0], C[1] + 0.010, C[2] - 0.012],
    radius: R, seg: seg(16), rings: seg(7),
    phiMax: (u) => {
      const cz = Math.cos(u * TAU);
      return 0.430 - 0.070 * clamp01(cz) + 0.100 * clamp01(-cz);
    },
    displace: shell(1.080, (dx, dy, dz) => 1 + 0.05 * clamp01(-dz) * clamp01(dy)),
  });
  b.setColor(mixCol(o.capShade, o.trouser, 0.35));
  b.setTransform(_m4.compose(
    new THREE.Vector3(C[0], C[1] + 0.030, C[2] + R[2] * 0.62),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.26, 0, 0)),
    new THREE.Vector3(1, 1, 1)));
  b.addEllipsoid({
    radius: [R[0] * 0.98, 0.007, R[2] * 0.84], seg: seg(12), rings: seg(4),
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

  // scout: light pack + map case. The pack gets a buckled flap and two straps
  // so it is a piece of kit rather than a pale card taped to the shoulders.
  const py = lerp(hy, cy, 0.52);
  b.setColor(o.canvas);
  b.addRoundedBox({ center: [0, py, -0.128 * g], size: [0.072, 0.056, 0.030], bevel: 0.016, div: 3 });
  b.setColor(mixCol(o.canvas, o.leather, 0.45));
  b.addRoundedBox({ center: [0, py + 0.040, -0.132 * g], size: [0.074, 0.020, 0.033], bevel: 0.010, div: 2 });
  b.setColor(o.belt);
  for (const sx of [-0.040, 0.040]) {
    b.addTube([
      { p: [sx, py + 0.058, -0.116 * g], rx: 0.009, rz: 0.004 },
      { p: [sx, py + 0.020, -0.164 * g], rx: 0.009, rz: 0.004 },
      { p: [sx, py - 0.030, -0.160 * g], rx: 0.009, rz: 0.004 },
    ], { seg: seg(6), capStart: 'flat', capEnd: 'round' });
  }
  b.setColor(o.leather);
  b.addRoundedBox({ center: [0.126 * g, hy - 0.092, 0.030], size: [0.030, 0.038, 0.014], bevel: 0.008, div: 2 });
}

// ---------------------------------------------------------------------------
// Cloth — verlet strips for the tunic tail, the sniper's scarf and ponytails.
// ---------------------------------------------------------------------------

const _cv = new THREE.Vector3(), _cv2 = new THREE.Vector3(), _cv3 = new THREE.Vector3();
const _carryQ = new THREE.Quaternion();
const _cFwd = new THREE.Vector3(), _cUp = new THREE.Vector3(), _cLeft = new THREE.Vector3();
const _cA = new THREE.Vector3(), _cB = new THREE.Vector3();
const _cGoal = new THREE.Vector3(), _cPole = new THREE.Vector3();
const _cBore = new THREE.Vector3(), _cFore = new THREE.Vector3(), _cAxis = new THREE.Vector3();
const _cShHand = new THREE.Vector3();
const _cWQ = new THREE.Quaternion();
// Low-ready bore, in character space: 37 degrees across the body, 21 degrees
// down, with the foregrip 0.24 m forward and 0.38 m below the shoulder line.
//
// These five numbers are a solved constraint, not taste. A rifle is 0.65 m from
// its foregrip back to its butt plate, so given a bore direction the butt lands
// wherever it lands — and with the previous 14/26 hold and a foregrip only
// 0.205 m below the shoulders, it landed at (-0.14, 1.53, -0.18): INSIDE the
// upper chest, with the trigger hand itself buried in the ribs. That is the
// closeup shot's rifle growing out of the shoulder. Solved by sweeping
// (yaw, pitch, forward, down, lateral) for the pose that keeps the whole
// grip->butt segment of all four weapon lengths outside an elliptical torso
// model by >= 1.35 radii while the support hand stays inside 0.47 m of the
// left shoulder and the muzzle still points at the ground.
const CARRY_YAW = 0.58, CARRY_PITCH = -0.34;
const CARRY_FWD = 0.240, CARRY_DOWN = -0.380, CARRY_LAT = -0.010;
/** Exponential smoothing that is stable at any frame rate. */
const damp = (cur, tgt, rate, dt) => tgt + (cur - tgt) * Math.exp(-rate * dt);
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
      bootWelt: app.bootWelt, cap: app.cap, capShade: app.capShade,
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

    // Radius tightened with the smaller skull: at 0.10 m the AO probe reached
    // right across a 0.16 m-wide face and pooled soot in the eye sockets and
    // under the cheekbone, which fought the band terminator that is supposed to
    // draw that edge.
    b.bakeAO({ res: CFG.quality >= 2 ? 48 : 36, strength: 0.48, radius: 0.082 });
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
    this._wSync = { px: NaN, py: NaN, pz: NaN, qx: NaN, qy: NaN, qz: NaN, qw: NaN, sx: NaN, sy: NaN, sz: NaN };

    this.root.scale.setScalar(this.rig.heightScale);
    if (this._groundAt) this.animator.setGroundCallback(this._groundAt);
    this._carryW = 0;
    this._carryF = 1;
    // How far in front of the eye the rear sight sits when shouldered.
    {
      const k = this.weaponStats ? this.weaponStats.kind : 'rifle';
      this._eyeRelief = k === 'sniper' ? 0.10 : k === 'lance' ? 0.24 : 0.14;
    }
    this.animator.setWeaponSolver((dt, carry, shoulder) => this._solveWeaponHold(dt, carry, shoulder));
    this.animator.play('idle', { fade: 0 });
    this.root.updateMatrixWorld(true);
  }

  /**
   * Hold the rifle at a believable low ready whenever it is NOT shouldered.
   *
   * The hand->weapon transform is solved once, from the shouldered pose, so the
   * sights line up with the eye (see _solveWeaponAnchor). That is right for
   * aiming and badly wrong for everything else: with the right hand down at the
   * hip the same transform threw the bore 65 degrees across the body and 44
   * degrees down, which put the foregrip 65 cm out from the left shoulder — a
   * 52 cm arm cannot reach that, so the support arm rendered bolt-straight with
   * an open hand hanging 8 cm short of the wood.
   *
   * Rather than hand-tune every carry pose until the numbers happen to work,
   * aim the gun hand: rotate handR in world space until the bore matches a
   * target direction in character space. Fixes idle, walk, run, crouch and
   * reload at once, and cannot drift out of the support arm's reach because the
   * foregrip always ends up in front of the chest.
   */
  _solveWeaponHold(dt, carry, shoulder) {
    const w = this.weapon;
    if (!w || !this.alive) return;
    const hold = clamp01(carry + shoulder);
    const frac = carry + shoulder > 1e-4 ? carry / (carry + shoulder) : 1;
    this._carryW = damp(this._carryW, hold, 10, dt);
    this._carryF = damp(this._carryF, frac, 10, dt);
    const cw = this._carryW, cf = this._carryF;
    if (cw < 0.02) return;
    const muzzle = w.userData.muzzle, fore = w.userData.foreGrip, sight = w.userData.sight;
    if (!muzzle) return;

    const bm = this.rig.boneMap;
    const hand = bm.handR;
    const s = this.root.scale.y || 1;
    this.root.getWorldQuaternion(_carryQ);
    _cFwd.set(0, 0, 1).applyQuaternion(_carryQ);
    _cUp.set(0, 1, 0).applyQuaternion(_carryQ);
    _cLeft.set(1, 0, 0).applyQuaternion(_carryQ);

    // Desired bore. Shouldered: straight down the body's facing — the aim layer
    // has already twisted the spine to the commanded yaw/pitch, so "forward" is
    // the right answer. Carried: 26 degrees down, 14 degrees across the body.
    const yaw = CARRY_YAW * cf, pitch = CARRY_PITCH * cf;
    _cBore.copy(_cFwd).multiplyScalar(Math.cos(yaw) * Math.cos(pitch))
      .addScaledVector(_cLeft, Math.sin(yaw) * Math.cos(pitch))
      .addScaledVector(_cUp, Math.sin(pitch))
      .normalize();

    // Desired foregrip, blended between the two holds.
    //
    // Carried: in front of the chest, anchored to the LIVE shoulders so crouching
    // and the spine's aim twist take the weapon with them, and so the grip is
    // always inside the support arm's 52 cm reach.
    boneWorld(bm.upperArmL, _cA);
    boneWorld(bm.upperArmR, _cB);
    _cFore.addVectors(_cA, _cB).multiplyScalar(0.5)
      .addScaledVector(_cFwd, CARRY_FWD * s)
      .addScaledVector(_cUp, CARRY_DOWN * s)
      .addScaledVector(_cLeft, CARRY_LAT * s);

    // Shouldered: target the TRIGGER HAND, not the handguard. The weapon's own
    // origin is the firing grip, so putting the hand under the cheek and pointing
    // the bore forward gives the cheek weld for free. Deriving the pose from the
    // sight instead makes the target depend on where each weapon happens to put
    // its sight node, and a rifle whose sight sits forward of the receiver drags
    // the whole gun — and both arms with it — up over the character's head.
    if (cf < 0.995) {
      boneWorld(bm.head, _cShHand);
      _cShHand
        .addScaledVector(_cUp, -0.062 * s)
        .addScaledVector(_cLeft, -0.058 * s)
        .addScaledVector(_cFwd, 0.022 * s);
    }

    _cPole.copy(_cFwd).multiplyScalar(0.55).addScaledVector(_cUp, -0.75)
      .addScaledVector(_cLeft, -0.35 - 0.30 * (1 - cf)).normalize();

    /** Roll the wrist until the bore sits on `_cBore`. Returns the angle used. */
    const align = () => {
      const e = muzzle.matrixWorld.elements;
      _cA.set(e[8], e[9], e[10]).normalize();
      const ang = Math.acos(clamp(_cA.dot(_cBore), -1, 1)) * cw;
      if (ang < 1e-4) return 0;
      _cAxis.crossVectors(_cA, _cBore);
      if (_cAxis.lengthSq() < 1e-12) return 0;
      _cAxis.normalize();
      hand.parent.getWorldQuaternion(_carryQ);
      rotateBoneWorld(hand, _carryQ, _cAxis, ang);
      hand.updateMatrixWorld(true);
      return ang;
    };

    /** Drive the gun arm so the (already oriented) foregrip lands on `_cFore`. */
    const place = () => {
      hand.getWorldQuaternion(_cWQ);                 // orientation to preserve
      boneWorld(hand, _cA);
      const fe = fore.matrixWorld.elements;
      _cB.set(fe[12], fe[13], fe[14]).sub(_cA);      // live grip -> foregrip
      _cGoal.copy(_cFore).sub(_cB);
      if (cf < 0.999) _cGoal.lerp(_cShHand, 1 - cf);
      this.animator.solveArm(bm.upperArmR, bm.foreArmR, hand, _cGoal, _cPole, cw);
      // Put the hand's WORLD orientation back. The two-bone solve rotates the
      // humerus and the ulna, and the hand rides along — up to 40 degrees — which
      // would swing the 35 cm handguard straight off the point we just placed it
      // on. Pinning the orientation decouples the two solves completely, so
      // align-then-place is exact in a single pass instead of an iteration that
      // never quite converges.
      hand.parent.getWorldQuaternion(_carryQ);
      hand.quaternion.copy(_carryQ.invert()).multiply(_cWQ);
      hand.updateMatrixWorld(true);
    };

    // Orientation first (align), then position (place) — in that order the two
    // are independent and one pass lands both exactly.
    align();
    if (fore) place();
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
    const kind = this.weaponStats ? this.weaponStats.kind : 'rifle';

    // The weapon's own origin IS the centre of the firing grip (see weapons.js),
    // so the anchor's job is simply to put that origin in the closed fist and
    // point the bore down the hand.
    //
    // The previous solve instead translated the weapon until its SIGHT sat at
    // the eye, which pinned the sight picture but left the grip wherever it
    // fell — up to 20 cm clear of the palm — so in every pose but the shouldered
    // one the rifle visibly floated beside a hand that was gripping thin air.
    // The sight picture is now the job of _solveWeaponHold, which drives the arm.
    // Palm centre, expressed in handR's own bone space (via the bone's REST
    // world frame, which is what the local offset has to be measured against).
    const wr = rig.restWorld.handR.pos, fg = rig.restWorld.fingersR.pos;
    const palm = new THREE.Vector3(
      lerp(wr.x, fg.x, 0.46), lerp(wr.y, fg.y, 0.46), lerp(wr.z, fg.z, 0.46) + 0.016);
    const restHand = new THREE.Matrix4()
      .compose(rig.restWorld.handR.pos, rig.restWorld.handR.quat, new THREE.Vector3(1, 1, 1))
      .invert();
    palm.applyMatrix4(restHand);

    const cant = kind === 'lance' ? -0.12 : -0.05;
    const roll = kind === 'lance' ? 0.10 : 0.0;
    this.weaponAnchor.position.copy(palm);
    // Bore down the hand's rest forward, plus the usual wrist cant.
    this.weaponAnchor.quaternion.setFromEuler(new THREE.Euler(roll, 0, cant));
    this.weaponAnchor.scale.set(1, 1, 1);

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

  /**
   * Refresh the world matrices if the group was moved since they were last
   * built. The game layer sets `root.position`/`rotation` (Unit.syncActor) and
   * then immediately asks for muzzlePoint()/headPoint() in the SAME tick, before
   * the renderer has walked the graph — without this, every query answers with
   * last frame's placement. That is invisible in a moving battle but it aims the
   * scripted capture cameras at empty air and it puts tracers a frame behind the
   * gun. The compare is seven floats; the walk only runs when it must.
   */
  _syncWorld() {
    const r = this.root, c = this._wSync;
    const p = r.position, q = r.quaternion, s = r.scale;
    if (c.px === p.x && c.py === p.y && c.pz === p.z
      && c.qx === q.x && c.qy === q.y && c.qz === q.z && c.qw === q.w
      && c.sx === s.x && c.sy === s.y && c.sz === s.z) return;
    r.updateMatrixWorld(true);
    c.px = p.x; c.py = p.y; c.pz = p.z;
    c.qx = q.x; c.qy = q.y; c.qz = q.z; c.qw = q.w;
    c.sx = s.x; c.sy = s.y; c.sz = s.z;
  }

  /** Muzzle flash / tracer origin, straight off the weapon bone transform. */
  muzzlePoint(out) {
    const t = out || this._muzzleOut;
    this._syncWorld();
    const m = this.weapon && this.weapon.userData.muzzle;
    if (m) { const e = m.matrixWorld.elements; return t.set(e[12], e[13], e[14]); }
    return this.headPoint(t);
  }

  /** Bore direction in world space (normalised). */
  aimDirection(out) {
    const t = out || this._dirOut;
    this._syncWorld();
    const m = this.weapon && this.weapon.userData.muzzle;
    if (m) { const e = m.matrixWorld.elements; return t.set(e[8], e[9], e[10]).normalize(); }
    return t.set(0, 0, 1).applyQuaternion(this.root.quaternion).normalize();
  }

  /** Eye-level head point — used for LOS checks and damage popups. */
  headPoint(out) {
    const t = out || this._headOut;
    this._syncWorld();
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

    // The animator already walked the graph — record that so the first
    // muzzlePoint()/headPoint() of the frame is free.
    const c = this._wSync, p = this.root.position, q = this.root.quaternion, s = this.root.scale;
    c.px = p.x; c.py = p.y; c.pz = p.z;
    c.qx = q.x; c.qy = q.y; c.qz = q.z; c.qw = q.w;
    c.sx = s.x; c.sy = s.y; c.sz = s.z;
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
