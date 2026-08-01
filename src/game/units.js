// src/game/units.js — the VC class table, weapon table, potentials, and the Unit actor wrapper.
//
// A Unit is the *gameplay* representation of a soldier or tank. It owns HP/AP/ammo, the
// potentials (VC's situational perks), the per-bodypart hitbox layout used by the ballistics,
// and the downed/bleed-out lifecycle. It holds a reference to the visual actor
// (src/actors/character.js Character or src/actors/tank.js Tank) but never assumes anything
// about its internals beyond the ARCHITECTURE.md contract.

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { CFG } from '../core/config.js';
import { clamp01 } from '../core/math.js';
import { fbm2, makeRng, rngPick } from '../core/rng.js';

// ---------------------------------------------------------------------------
// World adapters.
//
// ARCHITECTURE.md gives us `navQuery(x,z)` and `coverAt(pos,dir)` but no foliage/flower
// queries, and potentials need them. bindWorldHooks() latches onto whatever the World
// actually exposes and otherwise falls back to a deterministic noise field seeded from
// CFG.seed, so "Nature Lover" fires correctly either way.
// ---------------------------------------------------------------------------

const _fallbackSeed = () => (CFG.seed | 0);

export const WorldHooks = {
  // Safe defaults so potentials still fire if bindWorldHooks was never called.
  grassAt: (x, z) => clamp01((fbm2(x * 0.045, z * 0.045, { octaves: 3, seed: _fallbackSeed() + 17 }) - 0.42) * 3.1),
  flowersAt: (x, z) => clamp01((fbm2(x * 0.09 + 41, z * 0.09 - 13, { octaves: 2, seed: _fallbackSeed() + 99 }) - 0.66) * 5.0),
  timeOfDay: () => 0.42,
  bound: false,
};

export function bindWorldHooks(world) {
  const seed = CFG.seed | 0;
  WorldHooks.grassAt =
    world?.concealmentAt?.bind(world) ||
    world?.grassAt?.bind(world) ||
    world?.vegetationAt?.bind(world) ||
    ((x, z) => clamp01((fbm2(x * 0.045, z * 0.045, { octaves: 3, seed: seed + 17 }) - 0.42) * 3.1));
  WorldHooks.flowersAt =
    world?.flowersAt?.bind(world) ||
    ((x, z) => clamp01((fbm2(x * 0.09 + 41, z * 0.09 - 13, { octaves: 2, seed: seed + 99 }) - 0.66) * 5.0));
  WorldHooks.timeOfDay = world?.timeOfDay?.bind(world) || (() => (world?.sunT ?? 0.42));
  WorldHooks.bound = true;
  return WorldHooks;
}

// ---------------------------------------------------------------------------
// Weapons
//
// `shots`      rounds loosed by one attack (VC bursts)
// `apDamage`   per-round damage vs infantry, before defence and hitzone
// `aaDamage`   per-round damage vs armour
// `spread`     1-sigma angular dispersion (radians) at FULL reticle bloom
// `settled`    fraction of `spread` remaining once the reticle has fully converged
// `settle`     seconds of holding still to converge
// `range`      metres at which accuracy is still 100%; falls off to 0.25 at maxRange
//
// CROSS-NAMESPACE IDs. Three modules name weapons and none of them agree, because
// none of them are naming the same thing: this table is the gameplay stat block, and
//   `ballistics` -> src/physics/ballistics.js WEAPON_BALLISTICS  (flight model: v0,
//                   drag, penetration, tracer, explosive payload)
//   `mesh`       -> src/actors/weapons.js WEAPONS                (geometry the soldier
//                   is actually holding; null where the actor carries no separate gun)
//   `sfx`        -> src/audio/sfx.js SFX                         (report)
// These three fields are the ONLY bridge; nothing renames anyone else's ids. Keep them
// in step with src/physics/index.js GAME_WEAPON_BALLISTICS.
// ---------------------------------------------------------------------------

export const WEAPONS = {
  // --- Gallian (player, team 0) --------------------------------------------
  ZM_KAR8: {
    id: 'ZM_KAR8', name: 'ZM Kar 8', kind: 'rifle',
    ballistics: 'rifle', mesh: 'gallianRifle',
    shots: 4, rpm: 430,
    apDamage: 27, aaDamage: 4, accuracy: 0.63, range: 26, maxRange: 46,
    spread: 0.0225, settled: 0.22, settle: 1.05, recoil: 0.0052, magAttacks: 5,
    tracer: 0.34, sfx: 'rifle', muzzleFlash: 0.9, canFireMoving: false, pierce: 0.0,
  },
  ZM_MP: {
    id: 'ZM_MP', name: 'ZM MP', kind: 'smg',
    ballistics: 'smg', mesh: 'smg',
    shots: 11, rpm: 780,
    apDamage: 15, aaDamage: 2, accuracy: 0.52, range: 15, maxRange: 30,
    spread: 0.041, settled: 0.34, settle: 0.75, recoil: 0.0031, magAttacks: 4,
    tracer: 0.28, sfx: 'smg', muzzleFlash: 0.7, canFireMoving: false, pierce: 0.0,
  },
  ZM_LANCE: {
    id: 'ZM_LANCE', name: 'ZM Lance 3', kind: 'lance',
    ballistics: 'lance', mesh: 'lance',
    shots: 1, rpm: 20,
    apDamage: 92, aaDamage: 330, accuracy: 0.55, range: 11, maxRange: 19,
    spread: 0.021, settled: 0.18, settle: 1.6, recoil: 0.02, magAttacks: 2,
    tracer: 1, sfx: 'lance', muzzleFlash: 2.2, canFireMoving: false, pierce: 1.0,
    splash: 3.2, splashPower: 46, backblast: true,
  },
  ZM_RIFLE_E: {
    id: 'ZM_RIFLE_E', name: 'ZM Kar 5', kind: 'rifle',
    ballistics: 'rifle', mesh: 'gallianRifleB',
    shots: 3, rpm: 380,
    apDamage: 21, aaDamage: 3, accuracy: 0.58, range: 22, maxRange: 38,
    spread: 0.026, settled: 0.26, settle: 1.0, recoil: 0.0048, magAttacks: 5,
    tracer: 0.3, sfx: 'rifle', muzzleFlash: 0.85, canFireMoving: false, pierce: 0.0,
  },
  ZM_SG: {
    id: 'ZM_SG', name: 'ZM SG', kind: 'sniper',
    ballistics: 'sniper', mesh: 'sniperRifle',
    shots: 1, rpm: 32,
    apDamage: 132, aaDamage: 22, accuracy: 0.88, range: 70, maxRange: 130,
    spread: 0.0125, settled: 0.055, settle: 2.1, recoil: 0.011, magAttacks: 3,
    tracer: 0.6, sfx: 'sniper', muzzleFlash: 1.3, canFireMoving: false, pierce: 0.35,
    scope: 4.2,
  },
  ZM_TANK_HE: {
    id: 'ZM_TANK_HE', name: '88mm HE', kind: 'cannon',
    ballistics: 'tankHE', mesh: null,
    shots: 1, rpm: 12,
    apDamage: 210, aaDamage: 190, accuracy: 0.74, range: 44, maxRange: 95,
    spread: 0.011, settled: 0.09, settle: 1.5, recoil: 0.03, magAttacks: 6,
    tracer: 1, sfx: 'tankGun', muzzleFlash: 3.4, canFireMoving: false, pierce: 0.6,
    splash: 5.2, splashPower: 120, arc: 0.055,
  },
  ZM_TANK_AP: {
    id: 'ZM_TANK_AP', name: '88mm AP', kind: 'cannon',
    ballistics: 'tankAP', mesh: null,
    shots: 1, rpm: 12,
    apDamage: 120, aaDamage: 340, accuracy: 0.78, range: 55, maxRange: 110,
    spread: 0.008, settled: 0.06, settle: 1.5, recoil: 0.03, magAttacks: 4,
    tracer: 1, sfx: 'tankGun', muzzleFlash: 3.0, canFireMoving: false, pierce: 1.0,
    splash: 2.0, splashPower: 40,
  },
  ZM_COAX: {
    id: 'ZM_COAX', name: 'Coaxial MG', kind: 'mg',
    ballistics: 'coax', mesh: null,
    shots: 14, rpm: 620,
    apDamage: 13, aaDamage: 1, accuracy: 0.56, range: 24, maxRange: 42,
    spread: 0.030, settled: 0.30, settle: 0.6, recoil: 0.002, magAttacks: 8,
    tracer: 0.4, sfx: 'mgFire', muzzleFlash: 0.8, canFireMoving: false, pierce: 0.0,
  },

  // --- Imperial (enemy, team 1) --------------------------------------------
  VB_GW: {
    id: 'VB_GW', name: 'VB Gew 2', kind: 'rifle',
    ballistics: 'rifle', mesh: 'gallianRifleB',
    shots: 4, rpm: 400,
    apDamage: 24, aaDamage: 4, accuracy: 0.60, range: 25, maxRange: 44,
    spread: 0.024, settled: 0.24, settle: 1.05, recoil: 0.005, magAttacks: 5,
    tracer: 0.34, sfx: 'rifle', muzzleFlash: 0.9, canFireMoving: false, pierce: 0.0,
  },
  VB_MP: {
    id: 'VB_MP', name: 'VB MP 3', kind: 'smg',
    ballistics: 'smg', mesh: 'smg',
    shots: 10, rpm: 730,
    apDamage: 14, aaDamage: 2, accuracy: 0.50, range: 14, maxRange: 28,
    spread: 0.044, settled: 0.36, settle: 0.75, recoil: 0.003, magAttacks: 4,
    tracer: 0.28, sfx: 'smg', muzzleFlash: 0.7, canFireMoving: false, pierce: 0.0,
  },
  VB_LANCE: {
    id: 'VB_LANCE', name: 'VB Lanze', kind: 'lance',
    ballistics: 'lance', mesh: 'lance',
    shots: 1, rpm: 20,
    apDamage: 86, aaDamage: 300, accuracy: 0.52, range: 10, maxRange: 18,
    spread: 0.023, settled: 0.2, settle: 1.6, recoil: 0.02, magAttacks: 2,
    tracer: 1, sfx: 'lance', muzzleFlash: 2.2, canFireMoving: false, pierce: 1.0,
    splash: 3.0, splashPower: 42, backblast: true,
  },
  VB_SG: {
    id: 'VB_SG', name: 'VB SG', kind: 'sniper',
    ballistics: 'sniper', mesh: 'sniperRifle',
    shots: 1, rpm: 30,
    apDamage: 118, aaDamage: 20, accuracy: 0.84, range: 62, maxRange: 120,
    spread: 0.014, settled: 0.06, settle: 2.2, recoil: 0.011, magAttacks: 3,
    tracer: 0.6, sfx: 'sniper', muzzleFlash: 1.3, canFireMoving: false, pierce: 0.35,
    scope: 4.0,
  },
  VB_TANK: {
    id: 'VB_TANK', name: '75mm KwK', kind: 'cannon',
    ballistics: 'tankHE', mesh: null,
    shots: 1, rpm: 11,
    apDamage: 190, aaDamage: 300, accuracy: 0.70, range: 42, maxRange: 90,
    spread: 0.013, settled: 0.1, settle: 1.6, recoil: 0.03, magAttacks: 6,
    tracer: 1, sfx: 'tankGun', muzzleFlash: 3.2, canFireMoving: false, pierce: 0.9,
    splash: 4.6, splashPower: 105, arc: 0.05,
  },
  VB_COAX: {
    id: 'VB_COAX', name: 'Hull MG', kind: 'mg',
    ballistics: 'coax', mesh: null,
    shots: 12, rpm: 600,
    apDamage: 12, aaDamage: 1, accuracy: 0.54, range: 22, maxRange: 40,
    spread: 0.032, settled: 0.32, settle: 0.6, recoil: 0.002, magAttacks: 8,
    tracer: 0.4, sfx: 'mgFire', muzzleFlash: 0.8, canFireMoving: false, pierce: 0.0,
  },
};

export const GRENADE = {
  id: 'GRENADE', name: 'Fragmentation Grenade', kind: 'grenade',
  ballistics: 'grenade', mesh: 'grenade',
  apDamage: 0, aaDamage: 0, splash: 4.4, splashPower: 88, aaSplashPower: 30,
  fuse: 3.2, throwSpeed: 15.5, sfx: 'grenadeThrow',
};

/**
 * The exterior-ballistics id for anything in this table (or GRENADE). This is the
 * lookup src/physics/index.js `ballisticsFor()` resolves against WEAPON_BALLISTICS —
 * without it a Unit's weapon can never select a flight model and every simulated
 * round falls back to the plain rifle profile.
 * @param {object|string} w  a WEAPONS entry or its id
 * @returns {string|null}
 */
export function weaponBallisticsId(w) {
  if (!w) return null;
  if (typeof w === 'string') {
    const e = WEAPONS[w] || (w === GRENADE.id ? GRENADE : null);
    return e ? e.ballistics || null : null;
  }
  return w.ballistics || null;
}

/** The src/actors/weapons.js mesh id for a weapon, or null if it has no held model. */
export function weaponMeshId(w) {
  if (!w) return null;
  if (typeof w === 'string') {
    const e = WEAPONS[w] || (w === GRENADE.id ? GRENADE : null);
    return e ? e.mesh || null : null;
  }
  return w.mesh || null;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export const CLASSES = {
  scout: {
    id: 'scout', name: 'Scout', role: 'recon',
    hp: 62, ap: CFG.gameplay.apScout, apPerMetre: 20,
    aim: 0.66, evasion: 0.18, defense: 0.13, armour: 0,
    weapon: 'ZM_KAR8', weaponImperial: 'VB_GW',
    sight: 36, interceptRange: 20, interceptCone: Math.PI * 0.55,
    grenades: 1, ammoAttacks: 5,
    speed: { walk: 3.3, run: 5.7, crouch: 1.6 },
    canCapture: true, canRepair: false, canRescue: true, canResupply: false, canDetectMines: false,
    profile: 1.0,
    desc: 'Huge movement range and vision. Captures camps, spots for the squad.',
  },
  shock: {
    id: 'shock', name: 'Shocktrooper', role: 'assault',
    hp: 96, ap: CFG.gameplay.apShock, apPerMetre: 20,
    aim: 0.56, evasion: 0.10, defense: 0.30, armour: 0.06,
    weapon: 'ZM_MP', weaponImperial: 'VB_MP',
    sight: 26, interceptRange: 17, interceptCone: Math.PI * 0.62,
    grenades: 2, ammoAttacks: 4,
    speed: { walk: 2.95, run: 4.7, crouch: 1.4 },
    canCapture: true, canRepair: false, canRescue: true, canResupply: false, canDetectMines: false,
    profile: 1.06,
    desc: 'Armoured front-line assault. Devastating inside 15 metres.',
  },
  lancer: {
    id: 'lancer', name: 'Lancer', role: 'anti-armour',
    hp: 84, ap: CFG.gameplay.apLancer, apPerMetre: 20,
    aim: 0.50, evasion: 0.06, defense: 0.34, armour: 0.10,
    weapon: 'ZM_LANCE', weaponImperial: 'VB_LANCE',
    sight: 22, interceptRange: 0, interceptCone: 0,      // lances never intercept
    grenades: 1, ammoAttacks: 2,
    speed: { walk: 2.5, run: 3.9, crouch: 1.2 },
    canCapture: false, canRepair: false, canRescue: true, canResupply: false, canDetectMines: false,
    profile: 1.12, immuneToIntercept: false,
    desc: 'Anti-tank lance. Slow, shrugs off rifle fire, cannot capture camps.',
  },
  engineer: {
    id: 'engineer', name: 'Engineer', role: 'support',
    hp: 60, ap: CFG.gameplay.apEngineer, apPerMetre: 20,
    aim: 0.60, evasion: 0.16, defense: 0.14, armour: 0,
    weapon: 'ZM_RIFLE_E', weaponImperial: 'VB_GW',
    sight: 30, interceptRange: 18, interceptCone: Math.PI * 0.5,
    grenades: 1, ammoAttacks: 5,
    speed: { walk: 3.1, run: 5.1, crouch: 1.5 },
    canCapture: true, canRepair: true, canRescue: true, canResupply: true, canDetectMines: true,
    profile: 1.0,
    desc: 'Repairs the tank and sandbags, resupplies ammo, defuses mines.',
  },
  sniper: {
    id: 'sniper', name: 'Sniper', role: 'marksman',
    hp: 48, ap: CFG.gameplay.apSniper, apPerMetre: 20,
    aim: 0.80, evasion: 0.12, defense: 0.10, armour: 0,
    weapon: 'ZM_SG', weaponImperial: 'VB_SG',
    sight: 62, interceptRange: 0, interceptCone: 0,      // snipers overwatch, never intercept
    grenades: 0, ammoAttacks: 3,
    speed: { walk: 2.85, run: 4.4, crouch: 1.35 },
    canCapture: false, canRepair: false, canRescue: true, canResupply: false, canDetectMines: false,
    profile: 0.94, overwatch: true,
    desc: 'One shot, one kill — at 70 metres. Glass. Keep it on a ridge.',
  },
  tank: {
    id: 'tank', name: 'Tank', role: 'armour',
    hp: 1250, ap: 420, apPerMetre: 17,
    aim: 0.70, evasion: 0.0, defense: 0.62, armour: 0.72,
    weapon: 'ZM_TANK_HE', weaponImperial: 'VB_TANK',
    secondary: 'ZM_COAX', secondaryImperial: 'VB_COAX',
    ammoAlt: 'ZM_TANK_AP',
    sight: 34, interceptRange: 26, interceptCone: Math.PI * 0.42,
    grenades: 0, ammoAttacks: 6,
    speed: { walk: 2.6, run: 4.3, crouch: 2.6 },
    canCapture: false, canRepair: false, canRescue: false, canResupply: false, canDetectMines: false,
    isVehicle: true, profile: 2.4,
    desc: 'Rolling fortress. The radiator on the rear grille is its heart — protect it.',
  },
};

export const CLASS_IDS = ['scout', 'shock', 'lancer', 'engineer', 'sniper', 'tank'];

// ---------------------------------------------------------------------------
// Hitboxes — capsules in unit-local space, feet at y = 0, facing +Z.
// `mult` scales the incoming damage; `crit` marks the head for the critical readout.
// ---------------------------------------------------------------------------

export const BODY_PARTS = [
  { id: 'head', label: 'HEAD', ax: 0, ay: 1.545, az: 0, bx: 0, by: 1.685, bz: 0, r: 0.113, mult: 3.4, crit: true },
  { id: 'torso', label: 'BODY', ax: 0, ay: 0.98, az: 0, bx: 0, by: 1.47, bz: 0, r: 0.235, mult: 1.0, crit: false },
  { id: 'armR', label: 'ARM', ax: -0.30, ay: 1.02, az: 0, bx: -0.24, by: 1.44, bz: 0.05, r: 0.098, mult: 0.55, crit: false },
  { id: 'armL', label: 'ARM', ax: 0.30, ay: 1.02, az: 0, bx: 0.24, by: 1.44, bz: 0.05, r: 0.098, mult: 0.55, crit: false },
  { id: 'legs', label: 'LEGS', ax: 0, ay: 0.08, az: 0, bx: 0, by: 0.94, bz: 0, r: 0.19, mult: 0.62, crit: false },
];

// Tank zones. Angles are the *facing* of the plate in local space; `arc` is the half-angle
// over which the hit is considered to land on that plate. `radiator` is the VC weak point.
export const TANK_PARTS = [
  { id: 'radiator', label: 'RADIATOR', ax: 0, ay: 1.05, az: -2.42, bx: 0, by: 1.62, bz: -2.28, r: 0.42, mult: 4.2, crit: true },
  { id: 'turret', label: 'TURRET', ax: 0, ay: 1.94, az: -0.15, bx: 0, by: 2.34, bz: 0.55, r: 0.86, mult: 1.15, crit: false },
  { id: 'hull', label: 'HULL', ax: 0, ay: 0.75, az: -2.3, bx: 0, by: 1.5, bz: 2.35, r: 1.22, mult: 1.0, crit: false },
  { id: 'trackL', label: 'TRACK', ax: 1.36, ay: 0.42, az: -2.3, bx: 1.36, by: 0.42, bz: 2.3, r: 0.44, mult: 0.55, crit: false, disables: 'move' },
  { id: 'trackR', label: 'TRACK', ax: -1.36, ay: 0.42, az: -2.3, bx: -1.36, by: 0.42, bz: 2.3, r: 0.44, mult: 0.55, crit: false, disables: 'move' },
];

// ---------------------------------------------------------------------------
// Potentials — VC's situational perks. Each `check(unit, ctx)` returns null or a
// modifier record; the Unit merges them and emits `potential` on the Bus the first
// frame each one becomes active so the HUD can flash the classic banner.
//
// mods:  acc  additive to hit-chance      dmg  multiplicative on damage dealt
//        def  multiplicative on damage TAKEN (so <1 is good)
//        eva  additive to evasion         ap   multiplicative on AP granted
//        aa   multiplicative anti-armour  crit additive crit chance
// ---------------------------------------------------------------------------

const M = (o) => Object.freeze(o);

export const POTENTIALS = {
  natureLover: {
    id: 'natureLover', name: 'Nature Lover', good: true,
    desc: 'Steadier aim standing in deep grass.',
    kinds: ['attack'],
    check(u, ctx) {
      return WorldHooks.grassAt(u.pos.x, u.pos.z) > 0.45 ? M({ acc: 0.15, eva: 0.06 }) : null;
    },
  },
  pollenAllergy: {
    id: 'pollenAllergy', name: 'Pollen Allergy', good: false,
    desc: 'Sneezing fits near flowers — guard drops.',
    kinds: ['attack', 'defend'],
    check(u) {
      return WorldHooks.flowersAt(u.pos.x, u.pos.z) > 0.35 ? M({ def: 1.24, acc: -0.10 }) : null;
    },
  },
  hardWorker: {
    id: 'hardWorker', name: 'Hard Worker', good: true,
    desc: 'First sortie of the turn comes with extra legs.',
    kinds: ['ap'],
    check(u) { return u.actionsThisTurn === 0 ? M({ ap: 1.18 }) : null; },
  },
  undertaker: {
    id: 'undertaker', name: 'Undertaker', good: true,
    desc: 'Fights harder while a comrade lies bleeding.',
    kinds: ['attack'],
    check(u, ctx) {
      const b = ctx.battle; if (!b) return null;
      for (let i = 0; i < b.units.length; i++) {
        const o = b.units[i];
        if (o.team === u.team && o.downed && o.alive) return M({ dmg: 1.28, acc: 0.06 });
      }
      return null;
    },
  },
  fancyFootwork: {
    id: 'fancyFootwork', name: 'Fancy Footwork', good: true,
    desc: 'Impossible to draw a bead on in the open.',
    kinds: ['defend'],
    check(u, ctx) { return (ctx.cover ?? 0) < 0.2 ? M({ eva: 0.22, def: 0.9 }) : null; },
  },
  loneWolf: {
    id: 'loneWolf', name: 'Lone Wolf', good: true,
    desc: 'Works best with nobody looking over the shoulder.',
    kinds: ['attack', 'defend'],
    check(u, ctx) {
      const b = ctx.battle; if (!b) return null;
      for (let i = 0; i < b.units.length; i++) {
        const o = b.units[i];
        if (o !== u && o.team === u.team && o.alive && !o.downed && o.pos.distanceToSquared(u.pos) < 100) return null;
      }
      return M({ acc: 0.12, def: 0.86 });
    },
  },
  tankHunter: {
    id: 'tankHunter', name: 'Tank Hunter', good: true,
    desc: 'Reads armour plate like a book.',
    kinds: ['attack'],
    check(u, ctx) { return ctx.target?.isVehicle ? M({ aa: 1.32, acc: 0.10 }) : null; },
  },
  mountainBorn: {
    id: 'mountainBorn', name: 'Mountain Born', good: true,
    desc: 'Grew up shooting downhill.',
    kinds: ['attack'],
    check(u, ctx) {
      const t = ctx.target; if (!t) return null;
      return u.pos.y - t.pos.y > 2.2 ? M({ acc: 0.14, dmg: 1.10 }) : null;
    },
  },
  nightOwl: {
    id: 'nightOwl', name: 'Night Owl', good: true,
    desc: 'Comes alive as the light fails.',
    kinds: ['attack', 'defend'],
    check() {
      const t = WorldHooks.timeOfDay ? WorldHooks.timeOfDay() : 0.5;
      return t > 0.72 || t < 0.15 ? M({ acc: 0.13, eva: 0.08 }) : null;
    },
  },
  vengeful: {
    id: 'vengeful', name: 'Vengeance', good: true,
    desc: 'Never forgets who drew first blood.',
    kinds: ['attack'],
    check(u, ctx) { return ctx.target && ctx.target === u.lastAttacker ? M({ acc: 0.20, dmg: 1.22 }) : null; },
  },
  braveHeart: {
    id: 'braveHeart', name: 'Brave Heart', good: true,
    desc: 'Walks through interception fire without flinching.',
    kinds: ['defend', 'suppress'],
    check(u, ctx) { return ctx.underFire ? M({ eva: 0.16, def: 0.88 }) : null; },
    immuneToSuppression: true,
  },
  fieldMedic: {
    id: 'fieldMedic', name: 'Field Medic', good: true,
    desc: 'Rescues cost less time and stabilise better.',
    kinds: ['rescue'],
    check() { return M({ rescueSpeed: 2.2, rescueHeal: 0.35 }); },
  },
  sharpshooter: {
    id: 'sharpshooter', name: 'Sharpshooter', good: true,
    desc: 'Aims for the gap under the helmet rim.',
    kinds: ['attack'],
    check(u, ctx) { return ctx.aimed ? M({ crit: 0.18, acc: 0.08 }) : null; },
  },
  pacifist: {
    id: 'pacifist', name: 'Pacifist', good: false,
    desc: 'Hesitates before firing on an unwounded man.',
    kinds: ['attack'],
    check(u, ctx) { const t = ctx.target; return t && t.hp >= t.maxHp ? M({ dmg: 0.84 }) : null; },
  },
  chronicPain: {
    id: 'chronicPain', name: 'Chronic Pain', good: false,
    desc: 'Old wound stiffens in the morning cold.',
    kinds: ['attack', 'ap'],
    check(u, ctx) { return (ctx.battle?.turn ?? 99) <= 3 ? M({ acc: -0.12, ap: 0.92 }) : null; },
  },
  ironWill: {
    id: 'ironWill', name: 'Iron Will', good: true,
    desc: 'Refuses to go down the first time. Once per battle.',
    kinds: ['lethal'],
    check(u) { return u._ironWillUsed ? null : M({ survive: true }); },
  },
  campDefender: {
    id: 'campDefender', name: 'Camp Defender', good: true,
    desc: 'Dug in on friendly ground.',
    kinds: ['attack', 'defend'],
    check(u, ctx) {
      const b = ctx.battle; if (!b?.camps) return null;
      for (let i = 0; i < b.camps.length; i++) {
        const c = b.camps[i];
        if (c.owner === u.team && c.pos.distanceToSquared(u.pos) < c.radius * c.radius) {
          return M({ def: 0.82, acc: 0.08 });
        }
      }
      return null;
    },
  },
  sniperKiller: {
    id: 'sniperKiller', name: 'Counter-Sniper', good: true,
    desc: 'Hunts marksmen by instinct.',
    kinds: ['attack'],
    check(u, ctx) { return ctx.target?.cls === 'sniper' ? M({ acc: 0.22, dmg: 1.2 }) : null; },
  },
};

export const POTENTIAL_IDS = Object.keys(POTENTIALS);

const GOOD_POTENTIALS = POTENTIAL_IDS.filter((k) => POTENTIALS[k].good && k !== 'ironWill');
const BAD_POTENTIALS = POTENTIAL_IDS.filter((k) => !POTENTIALS[k].good);

/** Deterministically roll a personality: 2-3 good, 0-1 bad. */
export function rollPotentials(seed, cls) {
  const rng = makeRng((seed | 0) * 2654435761 + 7);
  const picked = [];
  const pool = GOOD_POTENTIALS.slice();
  const nGood = cls === 'tank' ? 1 : 2 + (rng() < 0.42 ? 1 : 0);
  for (let i = 0; i < nGood && pool.length; i++) {
    const j = Math.floor(rng() * pool.length);
    picked.push(pool.splice(j, 1)[0]);
  }
  if (cls !== 'tank' && rng() < 0.55) picked.push(rngPick(rng, BAD_POTENTIALS));
  if (cls !== 'tank' && rng() < 0.2) picked.push('ironWill');
  return Array.from(new Set(picked));
}

// ---------------------------------------------------------------------------
// Stance
// ---------------------------------------------------------------------------

// HP of blast damage a brewing-up tank delivers at the epicentre — the `power`
// convention of the `explosion` Bus event (docs/ARCHITECTURE.md). Enough to kill an
// unarmoured soldier standing against the hull (scout hp 62) and to level the crates
// and drums around it, but a 480 HP sandbag revetment survives at the blast edge.
export const TANK_DEATH_POWER = 130;

export const STANCE = { STAND: 0, CROUCH: 1, PRONE: 2 };
const STANCE_HEIGHT = [1.0, 0.64, 0.34];
const STANCE_COVER_BONUS = [0, 0.22, 0.38];
const STANCE_ACC_BONUS = [0, 0.09, 0.15];

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

let _uid = 1;

// Hoisted accumulator so potential evaluation never allocates in the shot loop.
const _mods = {
  acc: 0, dmg: 1, def: 1, eva: 0, ap: 1, aa: 1, crit: 0,
  rescueSpeed: 1, rescueHeal: 0, survive: false,
};
function resetMods() {
  _mods.acc = 0; _mods.dmg = 1; _mods.def = 1; _mods.eva = 0;
  _mods.ap = 1; _mods.aa = 1; _mods.crit = 0;
  _mods.rescueSpeed = 1; _mods.rescueHeal = 0; _mods.survive = false;
  return _mods;
}

export class Unit {
  /**
   * @param {object} cfg
   *   { cls, team, name, seed, pos:THREE.Vector3|{x,y,z}, yaw, potentials:string[],
   *     actor, hpScale, aimScale, veteran }
   */
  constructor(cfg = {}) {
    const cls = CLASSES[cfg.cls] ? cfg.cls : 'scout';
    const C = CLASSES[cls];

    this.id = _uid++;
    this.cls = cls;
    this.classDef = C;
    this.team = cfg.team | 0;
    this.name = cfg.name || `${C.name} ${this.id}`;
    this.seed = cfg.seed ?? (this.id * 7919 + this.team * 104729);
    this.rng = makeRng(this.seed);

    const hpScale = cfg.hpScale ?? 1;
    this.maxHp = Math.round(C.hp * hpScale);
    this.hp = this.maxHp;
    this.maxAp = C.ap;
    this.ap = C.ap;
    this.apPerMetre = C.apPerMetre;

    this.aim = clamp01(C.aim * (cfg.aimScale ?? 1));
    this.evasion = C.evasion;
    this.defense = C.defense;
    this.defence = C.defense;              // spelling alias — both are read across the codebase
    this.armour = C.armour;
    this.isVehicle = !!C.isVehicle;
    this.profile = C.profile;
    this.sight = C.sight;

    const wid = this.team === 0 ? C.weapon : (C.weaponImperial || C.weapon);
    this.weapon = WEAPONS[wid];
    this.weaponId = wid;
    const sid = this.team === 0 ? C.secondary : (C.secondaryImperial || C.secondary);
    this.secondary = sid ? WEAPONS[sid] : null;
    this.altAmmo = C.ammoAlt ? WEAPONS[C.ammoAlt] : null;
    this.usingAlt = false;

    this.maxAmmo = C.ammoAttacks;
    this.ammo = C.ammoAttacks;
    this.maxGrenades = C.grenades;
    this.grenades = C.grenades;

    this.pos = cfg.pos instanceof THREE.Vector3
      ? cfg.pos.clone()
      : new THREE.Vector3(cfg.pos?.x || 0, cfg.pos?.y || 0, cfg.pos?.z || 0);
    this.yaw = cfg.yaw ?? 0;
    this.aimYaw = this.yaw;
    this.aimPitch = 0;
    this.velocity = new THREE.Vector3();
    this.speed = 0;                        // metres/second, current
    this.stance = STANCE.STAND;

    this.alive = true;
    this.downed = false;
    this.rescued = false;
    this.captured = false;
    this.bleedTurns = 0;
    this.deployed = true;

    this.hasActed = false;
    this.actionsThisTurn = 0;
    this._didAct = false;                  // see actionWasSpent
    this._actionSnap = null;
    this.attackUsed = false;               // VC: one attack per selection
    this.extraAttacks = 0;                 // granted by the Stormy Attack order
    this.freeAction = false;               // granted by Direct Command
    this.freshSortie = false;              // ...and the same order un-decays that sortie
    this.stealth = false;                  // granted by Caution
    this.movedThisAction = 0;              // metres
    this.suppression = 0;                  // 0..1, holds then decays — see applySuppression()
    this.suppressHold = 0;                 // seconds before suppression starts to bleed off
    this.lastAttacker = null;
    this.lastDamageTime = -99;
    this.tracksDisabled = false;

    // Fog of war bookkeeping (owned by Battle.refreshFog).
    this.spotted = this.team === 0;
    this.lastKnown = this.pos.clone();
    this.lastKnownTurn = -99;

    this.potentials = (cfg.potentials || rollPotentials(this.seed, cls)).filter((p) => POTENTIALS[p]);
    this._potActive = new Set();
    this._ironWillUsed = false;

    // Order buffs. Same modifier vocabulary as potentials so combat needs one code path.
    this.buffs = [];

    this.actor = cfg.actor || null;        // Character | Tank
    this.parts = this.isVehicle ? TANK_PARTS : BODY_PARTS;
    this._logicalOnly = false;             // see headPoint()

    // stats bookkeeping for the results screen
    this.stats = { kills: 0, damageDealt: 0, damageTaken: 0, shotsFired: 0, shotsHit: 0, metresMoved: 0, rescues: 0 };
  }

  get character() { return this.isVehicle ? null : this.actor; }
  get tank() { return this.isVehicle ? this.actor : null; }
  get root() { return this.actor?.root || null; }
  get isPlayer() { return this.team === 0; }
  get active() { return this.alive && !this.downed && this.deployed; }
  get eyeHeight() { return this.isVehicle ? 2.15 : 1.62 * STANCE_HEIGHT[this.stance]; }
  get stanceScale() { return this.isVehicle ? 1 : STANCE_HEIGHT[this.stance]; }
  get hpFrac() { return clamp01(this.hp / this.maxHp); }
  get apFrac() { return clamp01(this.ap / Math.max(1, this.maxAp)); }
  get canAttack() { return this.active && !this.attackUsed && this.ammo > 0; }
  get moveRange() { return this.ap / this.apPerMetre; }

  /**
   * World-space point of the head / turret ring — the aim target for other units.
   * When `_logicalOnly` is set (AI planning against a hypothetical stance) we ignore the
   * rigged actor and derive everything from `pos`, so a candidate position can be evaluated
   * without moving the mesh.
   */
  headPoint(out = new THREE.Vector3()) {
    if (!this._logicalOnly && this.actor?.headPoint) {
      const p = this.actor.headPoint();
      if (p) return out.copy(p);
    }
    return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
  }

  /** World-space centre of mass — what the AI actually shoots at. */
  centerPoint(out = new THREE.Vector3()) {
    const h = this.isVehicle ? 1.35 : 1.18 * this.stanceScale;
    return out.set(this.pos.x, this.pos.y + h, this.pos.z);
  }

  muzzlePoint(out = new THREE.Vector3()) {
    if (!this._logicalOnly && this.actor?.muzzlePoint) {
      const p = this.actor.muzzlePoint();
      if (p) return out.copy(p);
    }
    const h = this.isVehicle ? 1.95 : 1.42 * this.stanceScale;
    return out.set(
      this.pos.x + Math.sin(this.aimYaw) * 0.55,
      this.pos.y + h,
      this.pos.z + Math.cos(this.aimYaw) * 0.55,
    );
  }

  /** Radius of the target sphere used for the analytic hit-probability solve. */
  targetRadius() {
    return this.isVehicle ? 1.55 : 0.42 * (0.55 + 0.45 * this.stanceScale) * this.profile;
  }

  // -- potentials ----------------------------------------------------------

  /**
   * Evaluate every potential whose `kinds` includes `kind`.
   * @param {string} kind
   * @param {object} ctx
   * @param {boolean} silent  true for UI previews — suppresses the Bus banner
   * @returns the shared, hoisted mods object — read it immediately, do not retain.
   */
  evalPotentials(kind, ctx, silent = false) {
    const m = resetMods();
    for (let i = 0; i < this.potentials.length; i++) {
      const P = POTENTIALS[this.potentials[i]];
      if (!P || (P.kinds && P.kinds.indexOf(kind) < 0)) continue;
      let r = null;
      try { r = P.check(this, ctx || EMPTY_CTX); } catch { r = null; }
      const key = P.id + ':' + kind;
      if (!r) { this._potActive.delete(key); continue; }
      if (r.acc !== undefined) m.acc += r.acc;
      if (r.dmg !== undefined) m.dmg *= r.dmg;
      if (r.def !== undefined) m.def *= r.def;
      if (r.eva !== undefined) m.eva += r.eva;
      if (r.ap !== undefined) m.ap *= r.ap;
      if (r.aa !== undefined) m.aa *= r.aa;
      if (r.crit !== undefined) m.crit += r.crit;
      if (r.rescueSpeed !== undefined) m.rescueSpeed *= r.rescueSpeed;
      if (r.rescueHeal !== undefined) m.rescueHeal += r.rescueHeal;
      if (r.survive) m.survive = true;
      if (!silent && !this._potActive.has(key)) {
        this._potActive.add(key);
        Bus.emit('potential', { unit: this, id: P.id, name: P.name, desc: P.desc, good: P.good, kind });
        Bus.emit('sfx', { name: P.good ? 'potentialGood' : 'potentialBad', pos: this.pos });
      }
    }
    // Order buffs use the same vocabulary, so they fold into the same accumulator.
    for (let i = 0; i < this.buffs.length; i++) {
      const b = this.buffs[i];
      if (b.kinds && b.kinds.indexOf(kind) < 0) continue;
      const r = b.mods;
      if (r.acc !== undefined) m.acc += r.acc;
      if (r.dmg !== undefined) m.dmg *= r.dmg;
      if (r.def !== undefined) m.def *= r.def;
      if (r.eva !== undefined) m.eva += r.eva;
      if (r.ap !== undefined) m.ap *= r.ap;
      if (r.aa !== undefined) m.aa *= r.aa;
      if (r.crit !== undefined) m.crit += r.crit;
      if (r.survive) m.survive = true;
    }
    return m;
  }

  /** @param {{id:string,name?:string,turns:number,kinds?:string[],mods:object}} b */
  addBuff(b) {
    const existing = this.buffs.findIndex((x) => x.id === b.id);
    if (existing >= 0) this.buffs.splice(existing, 1);
    this.buffs.push({ turns: 1, kinds: null, mods: {}, ...b });
    Bus.emit('unit:buff', { unit: this, buff: b });
  }

  removeBuff(id) {
    const i = this.buffs.findIndex((x) => x.id === id);
    if (i >= 0) { const b = this.buffs.splice(i, 1)[0]; Bus.emit('unit:buffEnd', { unit: this, buff: b }); }
  }

  hasBuff(id) { return this.buffs.some((b) => b.id === id); }

  tickBuffs() {
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      if (--this.buffs[i].turns <= 0) {
        const b = this.buffs.splice(i, 1)[0];
        Bus.emit('unit:buffEnd', { unit: this, buff: b });
      }
    }
  }

  hasPotential(id) { return this.potentials.indexOf(id) >= 0; }

  get suppressionImmune() {
    for (let i = 0; i < this.potentials.length; i++) {
      if (POTENTIALS[this.potentials[i]]?.immuneToSuppression) return true;
    }
    return false;
  }

  // -- suppression ----------------------------------------------------------

  /**
   * PUT FIRE ON A MAN AND HE STOPS SHOOTING STRAIGHT.
   *
   * The number always existed and combat.js always read it (effectiveAccuracy -0.30 per point,
   * shotSigma x1.85 at full) — but it bled off at a flat 0.42/second, so a hit was forgotten
   * in two and a half seconds and interception.js never looked at it at all. Round 22's
   * playtest measured the consequence: fully suppressing the two guns covering the bridge
   * changed a crossing from 24.3 damage to 21.3. That is not a mechanic, it is a rounding
   * error, and it left the player with no answer to the crossing except walking into it.
   *
   * So suppression now HOLDS for `hold` seconds and then drains four times slower, and
   * interception.js throttles a suppressed shooter's rate, burst length and acquire time.
   * "Spend a Command Point shooting the man who covers the bridge, then cross" is now
   * mechanically the right play as well as the obvious one — which is the loop a playtester
   * pointed at and called the game.
   *
   * It does not last forever: beginTurn() still wipes 65% of it, so suppression buys the rest
   * of THIS turn and nothing more.
   *
   * @param {number} n     0..1 to add
   * @param {number} hold  seconds before it begins to bleed off
   * @param {number} cap   ceiling this source may raise it to (never lowers it)
   * @returns the amount actually added
   */
  applySuppression(n, hold = 2.5, cap = 1) {
    if (this.suppressionImmune || !(n > 0)) return 0;
    const before = this.suppression;
    this.suppression = Math.min(clamp01(before + n), Math.max(before, cap));
    this.suppressHold = Math.max(this.suppressHold, hold);
    if (before < SUPPRESSED_AT && this.suppression >= SUPPRESSED_AT) {
      Bus.emit('unit:suppressed', { unit: this, level: this.suppression });
    }
    return this.suppression - before;
  }

  /** Heavy enough to spoil this unit's aim and slow its interception fire. */
  get suppressed() { return this.suppression >= SUPPRESSED_AT; }

  // -- combat --------------------------------------------------------------

  /**
   * Apply already-mitigated damage.
   * @param {number} n      final HP to remove
   * @param {Unit|null} source
   * @param {object} opts   { crit, part, worldPos, kind }
   */
  takeDamage(n, source = null, opts = null) {
    if (!this.alive || n <= 0) return 0;
    if (this.downed) {
      // Downed units cannot be shot further — VC protects them until reached.
      return 0;
    }
    const amount = Math.max(1, Math.round(n));
    this.hp -= amount;
    this.stats.damageTaken += amount;
    if (source) { this.lastAttacker = source; source.stats.damageDealt += amount; }
    this.applySuppression(0.34, 3.0);

    const wp = opts?.worldPos || this.centerPoint(_wp);
    Bus.emit('unit:damaged', {
      unit: this, amount, crit: !!opts?.crit, source,
      worldPos: wp.clone ? wp.clone() : new THREE.Vector3(wp.x, wp.y, wp.z),
      part: opts?.part || null, kind: opts?.kind || 'bullet',
    });
    Bus.emit('sfx', { name: this.isVehicle ? 'hitArmour' : 'hitFlesh', pos: this.pos });

    if (this.hp <= 0) {
      const m = this.evalPotentials('lethal', EMPTY_CTX);
      if (m.survive && !this._ironWillUsed) {
        this._ironWillUsed = true;
        this.hp = 1;
        Bus.emit('potential', { unit: this, id: 'ironWill', name: 'Iron Will', desc: 'Refused to fall.', good: true, kind: 'lethal' });
      } else {
        this.hp = 0;
        this.goDown(source);
      }
    } else {
      this.actor?.play?.('hit', { once: true });
    }
    return amount;
  }

  heal(n) {
    if (!this.alive) return;
    this.hp = Math.min(this.maxHp, this.hp + Math.round(n));
    Bus.emit('unit:healed', { unit: this, amount: n });
  }

  /**
   * 0 HP: vehicles brew up immediately, infantry go DOWN and bleed for 3 turns.
   *
   * THE GAME LAYER IS THE SOLE OWNER of a unit's death events. The visual actor is
   * told to play its death animation and does the wreck/scorch/track-throwing that
   * goes with it, but it must not raise `unit:downed` or `explosion` of its own —
   * doing that gave every tank kill two death banners, two blasts, two impulses and
   * two area-damage passes (see src/actors/tank.js destroy()).
   */
  goDown(source = null) {
    if (this.downed || !this.alive) return;
    if (this.isVehicle) {
      this.alive = false;
      this.hp = 0;
      Bus.emit('unit:downed', { unit: this });
      Bus.emit('unit:dead', { unit: this, cause: 'destroyed', source });
      // `power` is HP of damage at the epicentre, falling to 0 at `radius`: a brewing-up
      // tank is lethal to infantry beside it and levels the light cover around it.
      Bus.emit('explosion', { pos: this.pos.clone(), radius: 7, power: TANK_DEATH_POWER, source });
      Bus.emit('sfx', { name: 'explosion', pos: this.pos, vol: 1 });
      this.actor?.play?.('death');
      // Only a hostile gets the credit. The results screen sums stats.kills into
      // "Enemies Routed", so an own-goal used to read as a rout with every Imperial
      // still standing (Round 19: "Enemies Routed 1", zero Imperials dead).
      if (source && source.team !== this.team) source.stats.kills++;
      return;
    }
    this.downed = true;
    this.bleedTurns = 3;
    this.attackUsed = true;
    this.ap = 0;
    this.stance = STANCE.PRONE;
    this.actor?.play?.('death');
    Bus.emit('unit:downed', { unit: this });
    Bus.emit('sfx', { name: 'downed', pos: this.pos });
    if (source && source.team !== this.team) source.stats.kills++;   // never credit an own-goal
  }

  /** Bleed-out tick, called once per owning-team turn start. */
  tickBleed() {
    if (!this.downed || !this.alive) return false;
    this.bleedTurns--;
    Bus.emit('unit:bleeding', { unit: this, turns: this.bleedTurns });
    if (this.bleedTurns <= 0) { this.die('bledOut'); return true; }
    return false;
  }

  die(cause = 'killed', source = null) {
    if (!this.alive) return;
    this.alive = false;
    this.downed = false;
    this.deployed = false;
    this.hp = 0;
    Bus.emit('unit:dead', { unit: this, cause, source });
    Bus.emit('sfx', { name: 'unitLost', pos: this.pos });
  }

  /** An ally reached the body: medic evac. The unit leaves the field but survives. */
  rescue(by = null) {
    if (!this.downed || !this.alive) return false;
    this.downed = false;
    this.rescued = true;
    this.deployed = false;
    this.bleedTurns = 0;
    const m = by ? by.evalPotentials('rescue', EMPTY_CTX) : null;
    this.hp = Math.max(1, Math.round(this.maxHp * (0.34 + (m?.rescueHeal || 0))));
    if (by) { by.stats.rescues++; by.markActed(); }
    Bus.emit('unit:rescued', { unit: this, by });
    Bus.emit('sfx', { name: 'rescue', pos: this.pos });
    return true;
  }

  /** An enemy reached the body first. */
  capture(by = null) {
    if (!this.downed || !this.alive) return false;
    this.captured = true;
    by?.markActed?.();
    this.die('captured', by);
    Bus.emit('unit:captured', { unit: this, by });
    return true;
  }

  resupply() {
    const before = this.ammo;
    this.ammo = this.maxAmmo;
    this.grenades = this.maxGrenades;
    Bus.emit('unit:resupplied', { unit: this, gained: this.ammo - before });
    Bus.emit('sfx', { name: 'resupply', pos: this.pos });
  }

  repair(n) {
    if (!this.isVehicle) return;
    this.hp = Math.min(this.maxHp, this.hp + n);
    this.tracksDisabled = false;
    Bus.emit('unit:repaired', { unit: this, amount: n });
    Bus.emit('sfx', { name: 'repair', pos: this.pos });
  }

  // -- turn / action lifecycle --------------------------------------------

  beginTurn() {
    this.actionsThisTurn = 0;
    this.hasActed = false;
    this.suppression *= 0.35;
    this.suppressHold = 0;
    this.tickBuffs();
  }

  /**
   * Grant AP for the nth selection this turn. VC decays it hard after the first.
   * @returns granted AP
   */
  beginAction() {
    this.ap = this.previewAp();
    this.freshSortie = false;              // consumed by the sortie it paid for
    this.attackUsed = false;
    this.movedThisAction = 0;
    this.hasActed = true;
    this.actionsThisTurn++;
    // Snapshot for "did this sortie actually DO anything?" — Battle.endAction() hands the
    // Command Point back when the answer is no. See Battle.refundEmptySortie().
    this._didAct = false;
    this._actionSnap = {
      shots: this.stats.shotsFired, rescues: this.stats.rescues, grenades: this.grenades,
    };
    return this.ap;
  }

  /** Something happened this sortie that a Command Point can fairly be charged for. */
  markActed() { this._didAct = true; }

  /**
   * Did this sortie do anything at all? Metres walked, a round fired, a grenade thrown, a
   * body reached — repair/resupply/rebuild all bill AP through spendMove(), so they show up
   * as metres. Anything else is a player who selected a soldier to find out whether the shot
   * existed, discovered it did not, and backed out.
   */
  get actionWasSpent() {
    if (this._didAct) return true;
    if (this.movedThisAction > MIN_SORTIE_METRES) return true;
    const s = this._actionSnap;
    if (!s) return true;                                  // no snapshot: assume it counted
    return this.stats.shotsFired > s.shots
      || this.stats.rescues > s.rescues
      || this.grenades < s.grenades;
  }

  /**
   * AP this unit WOULD receive if selected right now. Side-effect free.
   *
   * `freshSortie` (Direct Command) skips the nth-selection decay: the commander is putting a
   * soldier who has already gone back on his feet with a full tank, which is the only reading
   * of that order that is worth its three Command Points. See orders.js `directCommand`.
   */
  previewAp() {
    const decay = this.freshSortie
      ? AP_DECAY[0]
      : AP_DECAY[Math.min(AP_DECAY.length - 1, this.actionsThisTurn)];
    const m = this.evalPotentials('ap', { battle: this.battleRef || null }, true);
    return Math.round(this.maxAp * decay * m.ap);
  }

  endAction() {
    this.ap = 0;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.stealth = false;      // Caution only covers the sortie it was bought for
  }

  /** Charge AP for `metres` of travel. Returns the metres actually paid for. */
  spendMove(metres, mul = 1) {
    if (metres <= 0) return 0;
    const cost = metres * this.apPerMetre * mul;
    if (cost <= this.ap) {
      this.ap -= cost;
      this.movedThisAction += metres;
      this.stats.metresMoved += metres;
      return metres;
    }
    const afford = this.ap / (this.apPerMetre * mul);
    this.ap = 0;
    this.movedThisAction += afford;
    this.stats.metresMoved += afford;
    return afford;
  }

  setStance(s) {
    if (this.isVehicle) return;
    if (this.stance === s) return;
    this.stance = s;
    Bus.emit('unit:stance', { unit: this, stance: s });
  }

  /** Extra cover the stance itself provides on top of the world's geometry. */
  stanceCover() { return this.isVehicle ? 0 : STANCE_COVER_BONUS[this.stance]; }
  stanceAccuracy() { return this.isVehicle ? 0 : STANCE_ACC_BONUS[this.stance]; }

  update(dt) {
    if (this.suppression > 0) {
      // Hold, then bleed. See applySuppression() for why this is not a flat decay.
      if (this.suppressHold > 0) this.suppressHold = Math.max(0, this.suppressHold - dt);
      else this.suppression = Math.max(0, this.suppression - dt * SUPPRESS_DECAY);
    }
    this.actor?.update?.(dt);
  }

  /** Push gameplay pos/yaw into the visual actor. */
  syncActor() {
    const r = this.root;
    if (!r) return;
    r.position.copy(this.pos);
    r.rotation.y = this.yaw;
    r.visible = this.deployed && (this.alive || this.downed);
    if (this.actor?.setAimAngles) this.actor.setAimAngles(this.aimYaw - this.yaw, this.aimPitch);
  }

  dispose() { this.actor?.dispose?.(); this.actor = null; }
}

// nth-selection AP multipliers — VC punishes re-selecting the same soldier.
export const AP_DECAY = [1.0, 0.5, 0.32, 0.22, 0.16, 0.12];

// Suppression: how fast it bleeds off ONCE THE HOLD EXPIRES (it was a flat 0.42/s with no
// hold, which is why nobody could ever act on it), and the level at which a unit reads as
// suppressed to the HUD and to interception.js.
export const SUPPRESS_DECAY = 0.11;
export const SUPPRESSED_AT = 0.5;

// A sortie that walked less than this and did nothing else was not a sortie. See
// Unit.actionWasSpent and Battle.refundEmptySortie().
export const MIN_SORTIE_METRES = 0.75;

const EMPTY_CTX = Object.freeze({});
const _wp = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Geometry helpers used by ballistics + AI. Kept here because the hitbox layout
// lives here and nothing else should need to know its shape.
// ---------------------------------------------------------------------------

const _ab = new THREE.Vector3();
const _ao = new THREE.Vector3();

/**
 * Ray vs capsule(a,b,r). Returns entry distance along `dir` or -1.
 * Standard infinite-cylinder solve clipped to the segment, plus the two end spheres.
 */
export function rayCapsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r) {
  _ab.set(bx - ax, by - ay, bz - az);
  _ao.set(ox - ax, oy - ay, oz - az);
  const abab = _ab.dot(_ab);
  if (abab < 1e-9) return raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, r);
  const abd = _ab.x * dx + _ab.y * dy + _ab.z * dz;
  const abao = _ab.dot(_ao);
  const A = abab - abd * abd;
  const B = abab * (_ao.x * dx + _ao.y * dy + _ao.z * dz) - abao * abd;
  const C = abab * _ao.dot(_ao) - abao * abao - r * r * abab;

  let best = -1;
  if (Math.abs(A) > 1e-9) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / A;
      if (t >= 0) {
        const y = abao + t * abd;
        if (y >= 0 && y <= abab) best = t;
      }
    }
  }
  // End caps
  const t1 = raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, r);
  if (t1 >= 0 && (best < 0 || t1 < best)) best = t1;
  const t2 = raySphere(ox, oy, oz, dx, dy, dz, bx, by, bz, r);
  if (t2 >= 0 && (best < 0 || t2 < best)) best = t2;
  return best;
}

export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = -b - s;
  return t >= 0 ? t : (-b + s >= 0 ? 0 : -1);
}

/**
 * Per-bodypart hit test in world space.
 * @returns {null | { part, t, mult, crit, point:THREE.Vector3 }}   `point` is a shared scratch.
 */
const _hitPoint = new THREE.Vector3();
const _hitRes = { part: null, label: '', t: 0, mult: 1, crit: false, point: _hitPoint, unit: null };

export function rayHitUnit(ox, oy, oz, dx, dy, dz, unit, maxDist = 1e6) {
  if (!unit.alive || !unit.deployed) return null;
  const s = unit.stanceScale;
  const cy = Math.cos(unit.yaw), sy = Math.sin(unit.yaw);
  let best = -1, bestPart = null;
  const parts = unit.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    // local -> world: rotate about Y then translate. Vertical scale by stance.
    const wax = unit.pos.x + p.ax * cy + p.az * sy;
    const waz = unit.pos.z - p.ax * sy + p.az * cy;
    const wbx = unit.pos.x + p.bx * cy + p.bz * sy;
    const wbz = unit.pos.z - p.bx * sy + p.bz * cy;
    const way = unit.pos.y + p.ay * s;
    const wby = unit.pos.y + p.by * s;
    const t = rayCapsule(ox, oy, oz, dx, dy, dz, wax, way, waz, wbx, wby, wbz, p.r);
    if (t >= 0 && t <= maxDist && (best < 0 || t < best)) { best = t; bestPart = p; }
  }
  if (!bestPart) return null;
  _hitRes.part = bestPart.id;
  _hitRes.label = bestPart.label;
  _hitRes.t = best;
  _hitRes.mult = bestPart.mult;
  _hitRes.crit = !!bestPart.crit;
  _hitRes.unit = unit;
  _hitPoint.set(ox + dx * best, oy + dy * best, oz + dz * best);
  return _hitRes;
}

/** Broad-phase: bounding sphere of a unit, for early-out before the capsule loop. */
export function unitBoundRadius(u) { return u.isVehicle ? 3.4 : 1.05; }

/** Convenience factory used by mission.js. */
export function makeUnit(cfg) { return new Unit(cfg); }

export default Unit;
