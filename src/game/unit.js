// src/game/unit.js — ARCHITECTURE.md names this file `unit.js`; the implementation lives in
// `units.js` (which also owns the CLASSES / WEAPONS / POTENTIALS tables). This module exists so
// `import { Unit } from './unit.js'` and `import { Unit } from './units.js'` both resolve.

export {
  Unit,
  Unit as default,
  CLASSES,
  CLASS_IDS,
  WEAPONS,
  GRENADE,
  POTENTIALS,
  POTENTIAL_IDS,
  BODY_PARTS,
  TANK_PARTS,
  STANCE,
  AP_DECAY,
  WorldHooks,
  bindWorldHooks,
  rollPotentials,
  makeUnit,
  rayHitUnit,
  rayCapsule,
  raySphere,
  unitBoundRadius,
} from './units.js';
