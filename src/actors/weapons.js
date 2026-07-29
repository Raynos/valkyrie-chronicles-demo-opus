// src/actors/weapons.js
// -----------------------------------------------------------------------------
// Procedural Gallian/Imperial small arms + the stats table the game layer tunes
// against.  Every weapon is built from the same swept-surface toolkit as the
// characters, in "weapon space":
//
//     origin  = the centre of the firing hand's grip
//     +Z      = down the bore (forward)
//     +Y      = up (sights)
//     +X      = the shooter's right
//
// A weapon Group exposes attachment nodes in userData so animation and VFX can
// hang off real transforms rather than magic numbers:
//   muzzle    Object3D at the bore exit, +Z along the bore
//   foreGrip  where the support hand goes (left-arm IK target)
//   eject     brass ejection port
//   mag       the magazine mesh (animated during reload)
//   bolt      the reciprocating part (cycled on fire)
//   sight     rear sight, used to line the weapon up in aim poses
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { MeshBuilder, PALETTE, actorWeaponMaterial, seg, rgbLin, mixCol } from './rig.js';
import { TAU } from '../core/math.js';

// ---------------------------------------------------------------------------
// Stats — tuned to Valkyria Chronicles' feel.
// ---------------------------------------------------------------------------
//   shots        rounds released per attack order (VC rifles burst 3, SMGs ~9)
//   dmg          damage per round vs infantry
//   dmgArmor     damage per round vs armour (0 = cannot hurt tanks)
//   accuracy     0..1 base hit probability at `range` with a settled reticle
//   range        metres at which `accuracy` holds; falls off past it
//   rpm          cadence within the burst
//   spread       cone half-angle in radians once the reticle has settled
//   bloom        extra spread per shot within a burst
//   recoil       vertical muzzle kick per shot, radians
//   aimTime      seconds for the reticle to shrink to `spread`
//   reload       seconds
//   ap           action-point cost multiplier when firing
//   pierce       armour penetration in mm-equivalent
//   splash       explosion radius, metres (0 = kinetic)
// ---------------------------------------------------------------------------

export const WEAPONS = {
  gallianRifle: {
    name: 'Gallian-1', cls: 'scout', kind: 'rifle',
    shots: 3, dmg: 32, dmgArmor: 0, accuracy: 0.74, range: 26, rpm: 210,
    spread: 0.0125, bloom: 0.006, recoil: 0.032, aimTime: 0.55, reload: 2.1,
    magSize: 9, ap: 1, pierce: 0, splash: 0, muzzleFlash: 0.9, sound: 'rifle',
    interceptCone: 0.62, tracer: 0.15,
  },
  gallianRifleB: {
    name: 'Gallian-2', cls: 'engineer', kind: 'rifle',
    shots: 3, dmg: 27, dmgArmor: 0, accuracy: 0.70, range: 24, rpm: 200,
    spread: 0.0145, bloom: 0.0065, recoil: 0.030, aimTime: 0.58, reload: 2.2,
    magSize: 9, ap: 1, pierce: 0, splash: 0, muzzleFlash: 0.85, sound: 'rifle',
    interceptCone: 0.60, tracer: 0.15,
  },
  smg: {
    name: 'ZM MP1', cls: 'shock', kind: 'smg',
    shots: 9, dmg: 15, dmgArmor: 0, accuracy: 0.55, range: 14, rpm: 620,
    spread: 0.028, bloom: 0.0042, recoil: 0.018, aimTime: 0.30, reload: 2.4,
    magSize: 36, ap: 1, pierce: 0, splash: 0, muzzleFlash: 1.15, sound: 'smg',
    interceptCone: 0.85, tracer: 0.10,
  },
  lance: {
    name: 'Lance VB', cls: 'lancer', kind: 'lance',
    shots: 1, dmg: 120, dmgArmor: 320, accuracy: 0.62, range: 13, rpm: 40,
    spread: 0.020, bloom: 0, recoil: 0.16, aimTime: 1.15, reload: 3.4,
    magSize: 1, ap: 1.6, pierce: 90, splash: 2.6, muzzleFlash: 2.6, sound: 'lance',
    interceptCone: 0.35, tracer: 0.4, projectileSpeed: 62, backblast: true,
  },
  sniperRifle: {
    name: 'Gallian-S', cls: 'sniper', kind: 'sniper',
    shots: 1, dmg: 190, dmgArmor: 12, accuracy: 0.95, range: 70, rpm: 35,
    spread: 0.0016, bloom: 0, recoil: 0.055, aimTime: 1.5, reload: 2.9,
    magSize: 5, ap: 1.35, pierce: 6, splash: 0, muzzleFlash: 1.1, sound: 'sniper',
    interceptCone: 0.22, tracer: 0.2, scope: 5.5,
  },
  pistol: {
    name: 'ZM Kar', cls: 'any', kind: 'pistol',
    shots: 3, dmg: 18, dmgArmor: 0, accuracy: 0.58, range: 11, rpm: 300,
    spread: 0.026, bloom: 0.005, recoil: 0.026, aimTime: 0.28, reload: 1.8,
    magSize: 8, ap: 0.8, pierce: 0, splash: 0, muzzleFlash: 0.8, sound: 'pistol',
    interceptCone: 0.7, tracer: 0.1,
  },
  grenade: {
    name: 'Fragmentation', cls: 'any', kind: 'thrown',
    shots: 1, dmg: 90, dmgArmor: 25, accuracy: 0.7, range: 16, rpm: 20,
    spread: 0.05, bloom: 0, recoil: 0, aimTime: 0.7, reload: 1.2,
    magSize: 1, ap: 1.2, pierce: 8, splash: 3.4, muzzleFlash: 0, sound: 'throw',
    interceptCone: 0, tracer: 0, fuse: 2.6,
  },
  toolkit: {
    name: 'Repair Kit', cls: 'engineer', kind: 'tool',
    shots: 0, dmg: 0, dmgArmor: 0, accuracy: 1, range: 2.2, rpm: 0,
    spread: 0, bloom: 0, recoil: 0, aimTime: 0, reload: 0,
    magSize: 0, ap: 1, pierce: 0, splash: 0, muzzleFlash: 0, sound: 'tool',
    interceptCone: 0, tracer: 0, repair: 45, resupply: true,
  },
};

/** Primary weapon per class. */
export const WEAPON_FOR_CLASS = {
  scout: 'gallianRifle',
  shock: 'smg',
  lancer: 'lance',
  engineer: 'gallianRifleB',
  sniper: 'sniperRifle',
};

// ---------------------------------------------------------------------------
// Shared geometry cache — every scout in the squad points at the same buffers.
// ---------------------------------------------------------------------------

const _geoCache = new Map();

function cached(key, build) {
  let g = _geoCache.get(key);
  if (!g) { g = build(); _geoCache.set(key, g); }
  return g;
}

const WOOD = PALETTE.wood;
const WOOD_DK = mixCol(PALETTE.wood, rgbLin(0x2c1c12), 0.35);
const STEEL = PALETTE.metal;
const STEEL_DK = PALETTE.metalDark;
const LEATH = PALETTE.leather;

/** Trigger guard: a flattened tube bent into a loop under the receiver. */
function triggerGuard(b, z0, z1, y) {
  b.setColor(STEEL_DK);
  b.addTube([
    { p: [0, y, z0], rx: 0.006, rz: 0.004 },
    { p: [0, y - 0.020, z0 + 0.010], rx: 0.005, rz: 0.0035 },
    { p: [0, y - 0.030, (z0 + z1) * 0.5], rx: 0.005, rz: 0.0035 },
    { p: [0, y - 0.020, z1 - 0.010], rx: 0.005, rz: 0.0035 },
    { p: [0, y, z1], rx: 0.006, rz: 0.004 },
  ], { seg: seg(7) });
  // Trigger blade.
  b.addTube([
    { p: [0, y - 0.004, (z0 + z1) * 0.5 + 0.006], rx: 0.004, rz: 0.0022 },
    { p: [0, y - 0.020, (z0 + z1) * 0.5 + 0.001], rx: 0.0035, rz: 0.002 },
  ], { seg: seg(6), capEnd: 'round' });
}

/** Iron sights: a blade up front, a notch or aperture at the rear. */
function ironSights(b, frontZ, rearZ, y) {
  b.setColor(STEEL_DK);
  b.addTube([
    { p: [0, y, frontZ], rx: 0.008, rz: 0.006 },
    { p: [0, y + 0.016, frontZ], rx: 0.0035, rz: 0.0035 },
  ], { seg: seg(7), capEnd: 'round' });
  b.addRoundedBox({ center: [0, y + 0.006, rearZ], size: [0.012, 0.006, 0.006], bevel: 0.002, div: 2 });
  b.addRoundedBox({ center: [0.0075, y + 0.014, rearZ], size: [0.004, 0.008, 0.005], bevel: 0.0015, div: 2 });
  b.addRoundedBox({ center: [-0.0075, y + 0.014, rearZ], size: [0.004, 0.008, 0.005], bevel: 0.0015, div: 2 });
}

/** Leather sling running from a forward band back to the butt swivel. */
function sling(b, front, rear, sag) {
  b.setColor(LEATH);
  b.addTube([
    { p: front, rx: 0.011, rz: 0.0028 },
    { p: [(front[0] + rear[0]) * 0.5 + 0.004, (front[1] + rear[1]) * 0.5 - sag, (front[2] + rear[2]) * 0.5], rx: 0.012, rz: 0.003, roll: 0.4 },
    { p: rear, rx: 0.011, rz: 0.0028 },
  ], { seg: seg(6), capStart: 'flat', capEnd: 'flat' });
}

// ---------------------------------------------------------------------------
// Gallian rifle — long wooden stock, exposed barrel, box magazine.
// ---------------------------------------------------------------------------

function buildGallianRifle(variant) {
  const bodyB = new MeshBuilder();
  const magB = new MeshBuilder();
  const boltB = new MeshBuilder();
  const b = bodyB;
  b.setMottle(0.05);

  const gz = 0;                 // grip is the origin
  const recvZ0 = gz + 0.02, recvZ1 = gz + 0.20;

  // --- butt stock: comb, wrist, toe ---------------------------------------
  b.setColor(WOOD);
  b.addTube([
    { p: [0, -0.012, gz - 0.30], rx: 0.020, rz: 0.048 },     // butt plate
    { p: [0, -0.008, gz - 0.28], rx: 0.023, rz: 0.052 },
    { p: [0, -0.004, gz - 0.22], rx: 0.024, rz: 0.048 },
    { p: [0, 0.000, gz - 0.15], rx: 0.024, rz: 0.041 },      // comb
    { p: [0, 0.000, gz - 0.09], rx: 0.023, rz: 0.036 },
    { p: [0, -0.004, gz - 0.03], rx: 0.021, rz: 0.034 },     // wrist
    { p: [0, -0.004, gz + 0.02], rx: 0.022, rz: 0.038 },
  ], { seg: seg(12), capStart: 'round' });
  // Steel butt plate, canted like a real rifle's heel.
  b.setColor(STEEL_DK);
  b.setTransform(new THREE.Matrix4().makeTranslation(0, -0.010, gz - 0.309));
  b.addRoundedBox({ size: [0.021, 0.050, 0.006], bevel: 0.005, div: 2 });
  b.setTransform(null);

  // Pistol wrist swell under the trigger hand.
  b.setColor(WOOD);
  b.addTube([
    { p: [0, -0.012, gz - 0.02], rx: 0.019, rz: 0.028 },
    { p: [0, -0.048, gz - 0.028], rx: 0.020, rz: 0.026 },
    { p: [0, -0.078, gz - 0.040], rx: 0.017, rz: 0.022 },
  ], { seg: seg(10), capEnd: 'round' });

  // --- receiver -----------------------------------------------------------
  b.setColor(STEEL);
  b.addRoundedBox({ center: [0, 0.006, (recvZ0 + recvZ1) * 0.5], size: [0.019, 0.024, (recvZ1 - recvZ0) * 0.5], bevel: 0.007, div: 3 });
  // Ejection port cut, faked with a darker recessed plate.
  b.setColor(STEEL_DK);
  b.addRoundedBox({ center: [0.019, 0.012, recvZ0 + 0.075], size: [0.004, 0.011, 0.030], bevel: 0.002, div: 2 });

  // --- forend + barrel ----------------------------------------------------
  b.setColor(WOOD);
  b.addTube([
    { p: [0, -0.004, recvZ1 - 0.005], rx: 0.022, rz: 0.026 },
    { p: [0, -0.005, recvZ1 + 0.10], rx: 0.021, rz: 0.024 },
    { p: [0, -0.006, recvZ1 + 0.24], rx: 0.019, rz: 0.021 },
    { p: [0, -0.006, recvZ1 + 0.30], rx: 0.017, rz: 0.019 },
  ], { seg: seg(11), capEnd: 'round' });
  b.setColor(STEEL);
  b.addTube([
    { p: [0, 0.006, recvZ1 - 0.01], rx: 0.0115, rz: 0.0115 },
    { p: [0, 0.006, recvZ1 + 0.28], rx: 0.0092, rz: 0.0092 },
    { p: [0, 0.006, recvZ1 + 0.40], rx: 0.0082, rz: 0.0082 },
    { p: [0, 0.006, recvZ1 + 0.425], rx: 0.0095, rz: 0.0095 },   // muzzle crown
  ], { seg: seg(10), capEnd: 'flat' });
  // Barrel bands.
  b.setColor(STEEL_DK);
  for (const z of [recvZ1 + 0.18, recvZ1 + 0.30]) {
    b.addTube([
      { p: [0, 0.001, z - 0.006], rx: 0.023, rz: 0.024 },
      { p: [0, 0.001, z + 0.006], rx: 0.023, rz: 0.024 },
    ], { seg: seg(10), capStart: 'flat', capEnd: 'flat' });
  }

  ironSights(b, recvZ1 + 0.395, recvZ0 + 0.155, 0.019);
  triggerGuard(b, gz - 0.012, gz + 0.030, -0.014);
  sling(b, [0, -0.018, recvZ1 + 0.30], [0, -0.020, gz - 0.26], 0.055);

  // --- magazine (separate mesh: the reload clip drops and reseats it) ------
  magB.setMottle(0.04).setColor(STEEL_DK);
  magB.addRoundedBox({ center: [0, -0.040, recvZ0 + 0.055], size: [0.014, 0.030, 0.026], bevel: 0.005, div: 2 });
  magB.setColor(STEEL);
  magB.addRoundedBox({ center: [0, -0.014, recvZ0 + 0.055], size: [0.016, 0.010, 0.028], bevel: 0.004, div: 2 });

  // --- bolt handle (cycles on fire) ---------------------------------------
  boltB.setMottle(0.03).setColor(STEEL);
  boltB.addTube([
    { p: [0.016, 0.014, recvZ0 + 0.105], rx: 0.006, rz: 0.006 },
    { p: [0.040, 0.006, recvZ0 + 0.105], rx: 0.005, rz: 0.005 },
  ], { seg: seg(8), capStart: 'flat' });
  boltB.setTransform(new THREE.Matrix4()
    .makeTranslation(0.042, 0.006, recvZ0 + 0.105)
    .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)));
  boltB.addLathe([[0, -0.010], [0.009, -0.008], [0.010, 0.006], [0, 0.010]], { seg: seg(8) });
  boltB.setTransform(null);

  const scale = variant === 'B' ? 0.96 : 1;
  return {
    body: bodyB.finishStatic(), mag: magB.finishStatic(), bolt: boltB.finishStatic(),
    // foreGrip sits at the REAR of the handguard, 0.275 m ahead of the trigger
    // grip. It used to be 0.345 m out at the mid-handguard, which is where you
    // hold a rifle when it is shouldered — but the low-ready solver places the
    // whole weapon from this node, and every extra centimetre forward here
    // throws the butt plate another centimetre outboard behind the shooter.
    muzzle: [0, 0.006, recvZ1 + 0.428], foreGrip: [0, -0.004, recvZ1 + 0.075],
    eject: [0.024, 0.014, recvZ0 + 0.085], sight: [0, 0.027, recvZ0 + 0.155],
    boltPivot: [0.016, 0.014, recvZ0 + 0.105], boltThrow: -0.055, scale,
  };
}

// ---------------------------------------------------------------------------
// SMG — stubby, shrouded barrel, side magazine well, folding stock.
// ---------------------------------------------------------------------------

function buildSMG() {
  const b = new MeshBuilder(), magB = new MeshBuilder(), boltB = new MeshBuilder();
  b.setMottle(0.045);
  const gz = 0, recvZ0 = gz - 0.03, recvZ1 = gz + 0.19;

  // Receiver tube.
  b.setColor(STEEL);
  b.addTube([
    { p: [0, 0.012, recvZ0 - 0.005], rx: 0.023, rz: 0.023 },
    { p: [0, 0.012, recvZ0 + 0.05], rx: 0.024, rz: 0.024 },
    { p: [0, 0.012, recvZ1 - 0.03], rx: 0.023, rz: 0.023 },
    { p: [0, 0.012, recvZ1], rx: 0.021, rz: 0.021 },
  ], { seg: seg(12), capStart: 'round' });

  // Perforated barrel shroud — alternating rings read as cooling holes.
  b.setColor(STEEL_DK);
  for (let i = 0; i < 5; i++) {
    const z = recvZ1 + 0.012 + i * 0.028;
    b.addTube([
      { p: [0, 0.012, z], rx: 0.0175, rz: 0.0175 },
      { p: [0, 0.012, z + 0.016], rx: 0.0175, rz: 0.0175 },
    ], { seg: seg(10), capStart: 'flat', capEnd: 'flat' });
  }
  b.setColor(STEEL);
  b.addTube([
    { p: [0, 0.012, recvZ1], rx: 0.0088, rz: 0.0088 },
    { p: [0, 0.012, recvZ1 + 0.152], rx: 0.0080, rz: 0.0080 },
    { p: [0, 0.012, recvZ1 + 0.166], rx: 0.0100, rz: 0.0100 },
  ], { seg: seg(9), capEnd: 'flat' });

  // Pistol grip + trigger group.
  b.setColor(mixCol(WOOD, STEEL_DK, 0.35));
  b.addTube([
    { p: [0, -0.006, gz + 0.004], rx: 0.019, rz: 0.026 },
    { p: [0, -0.048, gz - 0.014], rx: 0.020, rz: 0.024 },
    { p: [0, -0.082, gz - 0.028], rx: 0.017, rz: 0.021 },
  ], { seg: seg(10), capEnd: 'round' });
  triggerGuard(b, gz + 0.012, gz + 0.052, -0.010);

  // Folding wire stock.
  b.setColor(STEEL_DK);
  for (const sx of [-1, 1]) {
    b.addTube([
      { p: [sx * 0.020, 0.006, recvZ0], rx: 0.005, rz: 0.005 },
      { p: [sx * 0.036, -0.010, recvZ0 - 0.10], rx: 0.0045, rz: 0.0045 },
      { p: [sx * 0.036, -0.012, recvZ0 - 0.20], rx: 0.0045, rz: 0.0045 },
    ], { seg: seg(7), capStart: 'round' });
  }
  b.addTube([
    { p: [-0.036, -0.012, recvZ0 - 0.20], rx: 0.006, rz: 0.010 },
    { p: [0.036, -0.012, recvZ0 - 0.20], rx: 0.006, rz: 0.010 },
  ], { seg: seg(8), capStart: 'round', capEnd: 'round' });

  ironSights(b, recvZ1 + 0.14, recvZ0 + 0.03, 0.034);
  sling(b, [0, -0.010, recvZ1 + 0.10], [0, -0.012, recvZ0 - 0.14], 0.05);

  // Long stick magazine feeding from below.
  magB.setMottle(0.035).setColor(STEEL_DK);
  magB.addRoundedBox({ center: [0, -0.085, gz + 0.085], size: [0.013, 0.070, 0.021], bevel: 0.005, div: 3 });
  magB.setColor(STEEL);
  magB.addRoundedBox({ center: [0, -0.012, gz + 0.085], size: [0.016, 0.014, 0.024], bevel: 0.004, div: 2 });

  boltB.setMottle(0.03).setColor(STEEL);
  boltB.addTube([
    { p: [0.021, 0.020, recvZ0 + 0.055], rx: 0.006, rz: 0.006 },
    { p: [0.042, 0.020, recvZ0 + 0.055], rx: 0.006, rz: 0.006 },
  ], { seg: seg(8), capStart: 'flat', capEnd: 'round' });

  return {
    body: b.finishStatic(), mag: magB.finishStatic(), bolt: boltB.finishStatic(),
    muzzle: [0, 0.012, recvZ1 + 0.170], foreGrip: [0, -0.006, recvZ1 + 0.06],
    eject: [0.026, 0.020, recvZ0 + 0.07], sight: [0, 0.042, recvZ0 + 0.03],
    boltPivot: [0.021, 0.020, recvZ0 + 0.055], boltThrow: -0.045, scale: 1,
  };
}

// ---------------------------------------------------------------------------
// Anti-tank lance — a shoulder-fired tube with a huge shaped-charge head.
// ---------------------------------------------------------------------------

function buildLance() {
  const b = new MeshBuilder(), magB = new MeshBuilder(), boltB = new MeshBuilder();
  b.setMottle(0.05);
  const gz = 0, tubeBack = gz - 0.52, tubeFront = gz + 0.62;

  // Launch tube with a flared venturi at the rear.
  b.setColor(STEEL);
  b.addTube([
    { p: [0, 0.03, tubeBack - 0.06], rx: 0.052, rz: 0.052 },
    { p: [0, 0.03, tubeBack - 0.005], rx: 0.040, rz: 0.040 },
    { p: [0, 0.03, tubeBack + 0.08], rx: 0.036, rz: 0.036 },
    { p: [0, 0.03, gz], rx: 0.036, rz: 0.036 },
    { p: [0, 0.03, tubeFront - 0.10], rx: 0.036, rz: 0.036 },
    { p: [0, 0.03, tubeFront], rx: 0.038, rz: 0.038 },
  ], { seg: seg(14), capStart: 'flat', capEnd: 'flat' });

  // Reinforcing bands + heat shield along the top.
  b.setColor(STEEL_DK);
  for (const z of [tubeBack + 0.16, gz - 0.14, gz + 0.24, tubeFront - 0.14]) {
    b.addTube([
      { p: [0, 0.03, z - 0.008], rx: 0.042, rz: 0.042 },
      { p: [0, 0.03, z + 0.008], rx: 0.042, rz: 0.042 },
    ], { seg: seg(12), capStart: 'flat', capEnd: 'flat' });
  }

  // Warhead: a fat ogive on the muzzle.
  b.setColor(PALETTE.accent);
  b.addTube([
    { p: [0, 0.03, tubeFront - 0.01], rx: 0.038, rz: 0.038 },
    { p: [0, 0.03, tubeFront + 0.02], rx: 0.058, rz: 0.058 },
    { p: [0, 0.03, tubeFront + 0.10], rx: 0.062, rz: 0.062 },
    { p: [0, 0.03, tubeFront + 0.17], rx: 0.052, rz: 0.052 },
    { p: [0, 0.03, tubeFront + 0.23], rx: 0.028, rz: 0.028 },
    { p: [0, 0.03, tubeFront + 0.26], rx: 0.010, rz: 0.010 },
  ], { seg: seg(14), capEnd: 'round' });
  b.setColor(STEEL_DK);
  b.addTube([
    { p: [0, 0.03, tubeFront + 0.165], rx: 0.053, rz: 0.053 },
    { p: [0, 0.03, tubeFront + 0.180], rx: 0.053, rz: 0.053 },
  ], { seg: seg(12), capStart: 'flat', capEnd: 'flat' });

  // Grip + trigger housing hanging under the tube.
  b.setColor(mixCol(WOOD, STEEL_DK, 0.5));
  b.addTube([
    { p: [0, -0.006, gz], rx: 0.021, rz: 0.028 },
    { p: [0, -0.050, gz - 0.016], rx: 0.021, rz: 0.026 },
    { p: [0, -0.086, gz - 0.030], rx: 0.018, rz: 0.022 },
  ], { seg: seg(10), capEnd: 'round' });
  triggerGuard(b, gz + 0.012, gz + 0.056, -0.012);
  // Forward support grip.
  b.addTube([
    { p: [0, -0.004, gz + 0.30], rx: 0.019, rz: 0.024 },
    { p: [0, -0.052, gz + 0.30], rx: 0.019, rz: 0.023 },
    { p: [0, -0.082, gz + 0.298], rx: 0.017, rz: 0.021 },
  ], { seg: seg(10), capEnd: 'round' });

  // Shoulder rest + padded cheek plate.
  b.setColor(LEATH);
  b.addRoundedBox({ center: [0, -0.012, tubeBack + 0.10], size: [0.030, 0.030, 0.055], bevel: 0.012, div: 3 });
  // Sight bracket.
  b.setColor(STEEL_DK);
  b.addRoundedBox({ center: [-0.052, 0.062, gz + 0.10], size: [0.006, 0.030, 0.055], bevel: 0.003, div: 2 });
  b.addTube([
    { p: [-0.052, 0.086, gz + 0.06], rx: 0.014, rz: 0.014 },
    { p: [-0.052, 0.086, gz + 0.15], rx: 0.014, rz: 0.014 },
  ], { seg: seg(9), capStart: 'flat', capEnd: 'flat' });
  sling(b, [0, -0.012, tubeFront - 0.16], [0, -0.020, tubeBack + 0.14], 0.07);

  // "Magazine" = the breech loading cap that swings clear on reload.
  magB.setMottle(0.04).setColor(STEEL_DK);
  magB.setTransform(new THREE.Matrix4()
    .makeTranslation(0, 0.03, tubeBack - 0.055)
    .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
  magB.addLathe([[0, -0.012], [0.040, -0.014], [0.044, 0.004], [0.030, 0.014], [0, 0.016]], { seg: seg(12) });
  magB.setTransform(null);
  boltB.setMottle(0.03).setColor(STEEL);
  boltB.addTube([
    { p: [0.036, 0.03, gz - 0.20], rx: 0.007, rz: 0.007 },
    { p: [0.062, 0.03, gz - 0.20], rx: 0.006, rz: 0.006 },
  ], { seg: seg(8), capStart: 'flat', capEnd: 'round' });

  return {
    body: b.finishStatic(), mag: magB.finishStatic(), bolt: boltB.finishStatic(),
    magPos: [0, 0.03, tubeBack - 0.02], magRotAxis: [0, 1, 0],
    muzzle: [0, 0.03, tubeFront + 0.27], foreGrip: [0, -0.052, gz + 0.30],
    eject: [0, 0.03, tubeBack - 0.08], sight: [-0.052, 0.086, gz + 0.10],
    boltPivot: [0.036, 0.03, gz - 0.20], boltThrow: 0, scale: 1, backblast: [0, 0.03, tubeBack - 0.08],
  };
}

// ---------------------------------------------------------------------------
// Sniper rifle — long heavy barrel, cheek riser, big glass.
// ---------------------------------------------------------------------------

function buildSniper() {
  const b = new MeshBuilder(), magB = new MeshBuilder(), boltB = new MeshBuilder();
  b.setMottle(0.05);
  const gz = 0, recvZ0 = gz + 0.015, recvZ1 = gz + 0.235;

  b.setColor(WOOD);
  b.addTube([
    { p: [0, -0.020, gz - 0.345], rx: 0.021, rz: 0.050 },
    { p: [0, -0.014, gz - 0.320], rx: 0.024, rz: 0.055 },
    { p: [0, -0.006, gz - 0.245], rx: 0.026, rz: 0.052 },
    { p: [0, 0.004, gz - 0.170], rx: 0.026, rz: 0.048 },     // cheek riser
    { p: [0, 0.002, gz - 0.100], rx: 0.024, rz: 0.040 },
    { p: [0, -0.004, gz - 0.035], rx: 0.022, rz: 0.035 },
    { p: [0, -0.004, gz + 0.020], rx: 0.023, rz: 0.039 },
  ], { seg: seg(12), capStart: 'round' });
  // Thumbhole wrist.
  b.addTube([
    { p: [0, -0.014, gz - 0.016], rx: 0.019, rz: 0.028 },
    { p: [0, -0.052, gz - 0.026], rx: 0.020, rz: 0.026 },
    { p: [0, -0.086, gz - 0.038], rx: 0.017, rz: 0.022 },
  ], { seg: seg(10), capEnd: 'round' });

  b.setColor(STEEL);
  b.addRoundedBox({ center: [0, 0.008, (recvZ0 + recvZ1) * 0.5], size: [0.020, 0.026, (recvZ1 - recvZ0) * 0.5], bevel: 0.007, div: 3 });

  // Free-floated heavy barrel.
  b.setColor(WOOD);
  b.addTube([
    { p: [0, -0.006, recvZ1 - 0.01], rx: 0.024, rz: 0.028 },
    { p: [0, -0.007, recvZ1 + 0.14], rx: 0.021, rz: 0.024 },
    { p: [0, -0.008, recvZ1 + 0.24], rx: 0.019, rz: 0.021 },
  ], { seg: seg(11), capEnd: 'round' });
  b.setColor(STEEL_DK);
  b.addTube([
    { p: [0, 0.008, recvZ1 - 0.01], rx: 0.0135, rz: 0.0135 },
    { p: [0, 0.008, recvZ1 + 0.30], rx: 0.0110, rz: 0.0110 },
    { p: [0, 0.008, recvZ1 + 0.50], rx: 0.0100, rz: 0.0100 },
    { p: [0, 0.008, recvZ1 + 0.545], rx: 0.0135, rz: 0.0135 },   // muzzle brake
    { p: [0, 0.008, recvZ1 + 0.575], rx: 0.0130, rz: 0.0130 },
  ], { seg: seg(10), capEnd: 'flat' });

  // Scope: tube, bells, turrets, rings.
  const scZ = recvZ0 + 0.11, scY = 0.062;
  b.setColor(STEEL_DK);
  b.addTube([
    { p: [0, scY, scZ - 0.115], rx: 0.020, rz: 0.020 },
    { p: [0, scY, scZ - 0.085], rx: 0.020, rz: 0.020 },
    { p: [0, scY, scZ - 0.070], rx: 0.014, rz: 0.014 },
    { p: [0, scY, scZ + 0.075], rx: 0.014, rz: 0.014 },
    { p: [0, scY, scZ + 0.092], rx: 0.023, rz: 0.023 },
    { p: [0, scY, scZ + 0.130], rx: 0.023, rz: 0.023 },
  ], { seg: seg(13), capStart: 'flat', capEnd: 'none' });
  // Objective glass — a dark disc that catches the rim light.
  b.setColor(mixCol(rgbLin(0x24313a), STEEL_DK, 0.3));
  b.setTransform(new THREE.Matrix4()
    .makeTranslation(0, scY, scZ + 0.129)
    .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
  b.addLathe([[0, 0], [0.0215, 0.0005], [0.0215, 0.0035], [0, 0.004]], { seg: seg(12) });
  b.setTransform(null);
  b.setColor(STEEL);
  for (const z of [scZ - 0.052, scZ + 0.055]) {
    b.addTube([
      { p: [0, scY, z - 0.008], rx: 0.018, rz: 0.018 },
      { p: [0, scY, z + 0.008], rx: 0.018, rz: 0.018 },
    ], { seg: seg(11), capStart: 'flat', capEnd: 'flat' });
    b.addRoundedBox({ center: [0, scY - 0.026, z], size: [0.008, 0.020, 0.010], bevel: 0.003, div: 2 });
  }
  // Elevation + windage turrets.
  b.addTube([
    { p: [0, scY + 0.010, scZ + 0.010], rx: 0.011, rz: 0.011 },
    { p: [0, scY + 0.026, scZ + 0.010], rx: 0.010, rz: 0.010 },
  ], { seg: seg(9), capEnd: 'flat' });
  b.addTube([
    { p: [0.010, scY, scZ + 0.010], rx: 0.010, rz: 0.010 },
    { p: [0.026, scY, scZ + 0.010], rx: 0.009, rz: 0.009 },
  ], { seg: seg(9), capEnd: 'flat' });

  triggerGuard(b, gz - 0.002, gz + 0.042, -0.016);
  sling(b, [0, -0.020, recvZ1 + 0.20], [0, -0.024, gz - 0.30], 0.06);

  magB.setMottle(0.035).setColor(STEEL_DK);
  magB.addRoundedBox({ center: [0, -0.034, recvZ0 + 0.062], size: [0.013, 0.024, 0.030], bevel: 0.005, div: 2 });

  boltB.setMottle(0.03).setColor(STEEL);
  boltB.addTube([
    { p: [0.018, 0.014, recvZ0 + 0.165], rx: 0.0065, rz: 0.0065 },
    { p: [0.048, 0.000, recvZ0 + 0.168], rx: 0.0055, rz: 0.0055 },
  ], { seg: seg(8), capStart: 'flat' });
  boltB.setTransform(new THREE.Matrix4()
    .makeTranslation(0.050, 0.000, recvZ0 + 0.168)
    .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)));
  boltB.addLathe([[0, -0.011], [0.010, -0.009], [0.011, 0.007], [0, 0.011]], { seg: seg(9) });
  boltB.setTransform(null);

  return {
    body: b.finishStatic(), mag: magB.finishStatic(), bolt: boltB.finishStatic(),
    muzzle: [0, 0.008, recvZ1 + 0.578], foreGrip: [0, -0.008, recvZ1 + 0.070],
    eject: [0.024, 0.016, recvZ0 + 0.14], sight: [0, scY, scZ - 0.10],
    boltPivot: [0.018, 0.014, recvZ0 + 0.165], boltThrow: -0.06, scale: 1,
  };
}

// ---------------------------------------------------------------------------
// Sidearm.
// ---------------------------------------------------------------------------

function buildPistol() {
  const b = new MeshBuilder(), magB = new MeshBuilder(), boltB = new MeshBuilder();
  b.setMottle(0.04);
  const gz = 0;

  b.setColor(mixCol(WOOD, STEEL_DK, 0.55));
  b.addTube([
    { p: [0, -0.004, gz + 0.004], rx: 0.017, rz: 0.024 },
    { p: [0, -0.042, gz - 0.012], rx: 0.017, rz: 0.022 },
    { p: [0, -0.070, gz - 0.023], rx: 0.015, rz: 0.019 },
  ], { seg: seg(9), capEnd: 'round' });
  b.setColor(STEEL);
  b.addRoundedBox({ center: [0, 0.004, gz + 0.036], size: [0.013, 0.014, 0.048], bevel: 0.005, div: 2 });
  triggerGuard(b, gz + 0.010, gz + 0.044, -0.010);
  ironSights(b, gz + 0.086, gz + 0.002, 0.019);

  boltB.setMottle(0.03).setColor(STEEL_DK);
  boltB.addRoundedBox({ center: [0, 0.022, gz + 0.040], size: [0.014, 0.013, 0.056], bevel: 0.005, div: 2 });
  boltB.setColor(STEEL);
  boltB.addTube([
    { p: [0, 0.022, gz + 0.090], rx: 0.006, rz: 0.006 },
    { p: [0, 0.022, gz + 0.100], rx: 0.007, rz: 0.007 },
  ], { seg: seg(8), capEnd: 'flat' });

  magB.setMottle(0.03).setColor(STEEL_DK);
  magB.addRoundedBox({ center: [0, -0.074, gz - 0.024], size: [0.011, 0.010, 0.017], bevel: 0.003, div: 2 });

  return {
    body: b.finishStatic(), mag: magB.finishStatic(), bolt: boltB.finishStatic(),
    muzzle: [0, 0.022, gz + 0.103], foreGrip: [0, -0.030, gz + 0.010],
    eject: [0.016, 0.028, gz + 0.030], sight: [0, 0.033, gz + 0.002],
    boltPivot: [0, 0.022, gz + 0.040], boltThrow: -0.022, scale: 1,
  };
}

// ---------------------------------------------------------------------------
// Grenade + engineer toolkit.
// ---------------------------------------------------------------------------

function buildGrenade() {
  const b = new MeshBuilder();
  b.setMottle(0.05).setColor(mixCol(PALETTE.metalDark, rgbLin(0x4c5340), 0.55));
  // Segmented body, the classic pineapple silhouette.
  b.addLathe([
    [0, -0.042], [0.020, -0.040], [0.029, -0.030], [0.032, -0.014],
    [0.032, 0.010], [0.028, 0.024], [0.019, 0.034], [0.013, 0.040], [0, 0.041],
  ], { seg: seg(12) });
  // Fluting: shallow vertical ribs.
  const ribs = 6;
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * TAU;
    b.addTube([
      { p: [Math.cos(a) * 0.031, -0.026, Math.sin(a) * 0.031], rx: 0.004, rz: 0.004 },
      { p: [Math.cos(a) * 0.033, 0.004, Math.sin(a) * 0.033], rx: 0.005, rz: 0.005 },
      { p: [Math.cos(a) * 0.028, 0.026, Math.sin(a) * 0.028], rx: 0.004, rz: 0.004 },
    ], { seg: seg(6) });
  }
  b.setColor(PALETTE.metal);
  b.addLathe([[0, 0.040], [0.011, 0.042], [0.012, 0.052], [0.008, 0.056], [0, 0.057]], { seg: seg(10) });
  // Spoon + pin ring.
  b.setColor(PALETTE.metalDark);
  b.addTube([
    { p: [0.011, 0.050, 0], rx: 0.006, rz: 0.003 },
    { p: [0.032, 0.030, 0], rx: 0.007, rz: 0.003 },
    { p: [0.034, -0.006, 0], rx: 0.007, rz: 0.003 },
  ], { seg: seg(6), capStart: 'flat', capEnd: 'round' });
  b.setColor(PALETTE.brass);
  b.addTube([
    { p: [-0.014, 0.050, 0.006], rx: 0.004, rz: 0.004 },
    { p: [-0.024, 0.050, 0.006], rx: 0.003, rz: 0.003 },
  ], { seg: seg(6), capEnd: 'round' });
  return {
    body: b.finishStatic(), mag: null, bolt: null,
    muzzle: [0, 0, 0], foreGrip: [0, 0, 0], eject: [0, 0, 0], sight: [0, 0.05, 0],
    boltPivot: [0, 0, 0], boltThrow: 0, scale: 1,
  };
}

function buildToolkit() {
  const b = new MeshBuilder(), boltB = new MeshBuilder();
  b.setMottle(0.055).setColor(LEATH);
  b.addRoundedBox({ center: [0, 0, 0], size: [0.075, 0.062, 0.045], bevel: 0.014, div: 3 });
  b.setColor(mixCol(LEATH, rgbLin(0x2b2018), 0.45));
  b.addRoundedBox({ center: [0, 0.052, 0.004], size: [0.078, 0.016, 0.048], bevel: 0.010, div: 2 });
  // Buckle straps.
  b.setColor(PALETTE.belt);
  for (const sx of [-0.036, 0.036]) {
    b.addTube([
      { p: [sx, 0.066, -0.030], rx: 0.010, rz: 0.004 },
      { p: [sx, 0.058, 0.048], rx: 0.010, rz: 0.004 },
      { p: [sx, -0.020, 0.049], rx: 0.010, rz: 0.004 },
    ], { seg: seg(6), capStart: 'flat', capEnd: 'round' });
  }
  b.setColor(PALETTE.brass);
  for (const sx of [-0.036, 0.036]) {
    b.addTube([
      { p: [sx, 0.014, 0.052], rx: 0.011, rz: 0.006 },
      { p: [sx, 0.002, 0.052], rx: 0.011, rz: 0.006 },
    ], { seg: seg(8), capStart: 'flat', capEnd: 'flat' });
  }
  // A wrench poking out of the top flap.
  boltB.setMottle(0.03).setColor(STEEL);
  boltB.addTube([
    { p: [0.02, 0.055, 0.01], rx: 0.007, rz: 0.005 },
    { p: [0.026, 0.135, 0.012], rx: 0.006, rz: 0.0045 },
  ], { seg: seg(7), capStart: 'flat' });
  boltB.setTransform(new THREE.Matrix4()
    .makeTranslation(0.026, 0.132, 0.012)
    .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)));
  boltB.addLathe([[0, -0.008], [0.016, -0.006], [0.016, 0.006], [0.010, 0.010], [0, 0.010]], { seg: seg(8) });
  boltB.setTransform(null);

  return {
    body: b.finishStatic(), mag: null, bolt: boltB.finishStatic(),
    muzzle: [0, 0.08, 0.02], foreGrip: [0, 0, 0.05], eject: [0, 0, 0], sight: [0, 0.05, 0],
    boltPivot: [0, 0, 0], boltThrow: 0, scale: 1,
  };
}

const BUILDERS = {
  gallianRifle: () => buildGallianRifle('A'),
  gallianRifleB: () => buildGallianRifle('B'),
  smg: buildSMG,
  lance: buildLance,
  sniperRifle: buildSniper,
  pistol: buildPistol,
  grenade: buildGrenade,
  toolkit: buildToolkit,
};

function node(name, p) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(p[0], p[1], p[2]);
  return o;
}

/**
 * Instantiate a weapon.
 * @param {string} type key into WEAPONS
 * @param {object} opts { material }
 * @returns {THREE.Group} with userData { type, stats, muzzle, foreGrip, eject,
 *                                        mag, bolt, sight, boltRest, boltThrow }
 */
export function createWeapon(type, opts = {}) {
  const key = BUILDERS[type] ? type : 'gallianRifle';
  const parts = cached(key, BUILDERS[key]);
  const mat = opts.material || actorWeaponMaterial();

  const g = new THREE.Group();
  g.name = 'weapon_' + key;

  const body = new THREE.Mesh(parts.body, mat);
  body.castShadow = true;
  body.receiveShadow = false;
  body.userData.outline = true;
  body.frustumCulled = true;
  g.add(body);

  let mag = null, bolt = null;
  if (parts.mag) {
    mag = new THREE.Mesh(parts.mag, mat);
    mag.castShadow = true;
    mag.userData.outline = true;
    mag.frustumCulled = true;
    g.add(mag);
  }
  if (parts.bolt) {
    bolt = new THREE.Mesh(parts.bolt, mat);
    bolt.castShadow = true;
    bolt.userData.outline = true;
    bolt.frustumCulled = true;
    g.add(bolt);
  }

  const muzzle = node('muzzle', parts.muzzle);
  const foreGrip = node('foreGrip', parts.foreGrip);
  const eject = node('eject', parts.eject);
  const sight = node('sight', parts.sight);
  g.add(muzzle, foreGrip, eject, sight);

  if (parts.scale !== 1) g.scale.setScalar(parts.scale);

  g.userData = {
    type: key,
    stats: WEAPONS[key] || WEAPONS.gallianRifle,
    muzzle, foreGrip, eject, sight, mag, bolt, body,
    boltRest: bolt ? bolt.position.clone() : null,
    boltThrow: parts.boltThrow || 0,
    magRest: mag ? mag.position.clone() : null,
    backblast: parts.backblast || null,
  };
  return g;
}

/** Free the shared weapon geometry (call once at teardown, not per character). */
export function disposeWeaponCache() {
  for (const parts of _geoCache.values()) {
    parts.body?.dispose();
    parts.mag?.dispose();
    parts.bolt?.dispose();
  }
  _geoCache.clear();
}
