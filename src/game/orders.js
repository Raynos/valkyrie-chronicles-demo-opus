// src/game/orders.js — the CP-purchasable command menu.
//
// Orders share the modifier vocabulary of potentials (Unit.addBuff), so nothing in the combat
// path has to know an order exists. `apply` returns false to refuse (bad target, no LOS to the
// commander, etc.) and the Battle refunds the CP.

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { clamp01 } from '../core/math.js';
import { explode } from './combat.js';

const _v = new THREE.Vector3();

export const ORDERS = {
  resupply: {
    id: 'resupply', name: 'Resupply', cost: 2, target: 'unit', icon: 'R',
    desc: 'Restock one soldier\'s ammunition and grenades.',
    filter: (u) => u.active && (u.ammo < u.maxAmmo || u.grenades < u.maxGrenades),
    apply(battle, u) { u.resupply(); return true; },
  },

  attackBoost: {
    id: 'attackBoost', name: 'Attack Boost', cost: 2, target: 'unit', icon: 'A',
    desc: '+45% weapon power for one turn.',
    filter: (u) => u.active,
    apply(battle, u) {
      u.addBuff({ id: 'attackBoost', name: 'Attack Boost', turns: 2, kinds: ['attack'], mods: { dmg: 1.45, acc: 0.06 } });
      return true;
    },
  },

  defenseBoost: {
    id: 'defenseBoost', name: 'Defence Boost', cost: 2, target: 'unit', icon: 'D',
    desc: 'Take 35% less damage for one turn.',
    filter: (u) => u.active,
    apply(battle, u) {
      u.addBuff({ id: 'defenseBoost', name: 'Defence Boost', turns: 2, kinds: ['defend'], mods: { def: 0.65 } });
      return true;
    },
  },

  demolitionBoost: {
    id: 'demolitionBoost', name: 'Demolition Boost', cost: 2, target: 'unit', icon: 'X',
    desc: '+70% anti-armour damage for one turn.',
    filter: (u) => u.active && (u.cls === 'lancer' || u.isVehicle),
    apply(battle, u) {
      u.addBuff({ id: 'demolitionBoost', name: 'Demolition Boost', turns: 2, kinds: ['attack'], mods: { aa: 1.7 } });
      return true;
    },
  },

  doubleMovement: {
    id: 'doubleMovement', name: 'Double Movement', cost: 3, target: 'unit', icon: '>>',
    desc: 'The next sortie is made on double AP.',
    filter: (u) => u.active,
    apply(battle, u) {
      u.addBuff({ id: 'doubleMovement', name: 'Double Movement', turns: 2, kinds: ['ap'], mods: { ap: 2.0 } });
      return true;
    },
  },

  caution: {
    id: 'caution', name: 'Caution', cost: 1, target: 'unit', icon: 'C',
    desc: 'Move low and quiet — enemies acquire far more slowly.',
    filter: (u) => u.active && !u.isVehicle,
    apply(battle, u) {
      u.addBuff({ id: 'caution', name: 'Caution', turns: 2, kinds: ['defend'], mods: { eva: 0.3, def: 0.85 } });
      u.stealth = true;
      return true;
    },
  },

  awakenPotential: {
    id: 'awakenPotential', name: 'Awaken Potential', cost: 4, target: 'unit', icon: '!',
    desc: 'Every good potential fires regardless of circumstance for one turn.',
    filter: (u) => u.active && !u.isVehicle,
    apply(battle, u) {
      u.addBuff({
        id: 'awakenPotential', name: 'Awakened', turns: 2, kinds: ['attack', 'defend', 'ap'],
        mods: { acc: 0.2, dmg: 1.3, def: 0.75, eva: 0.12, ap: 1.25 },
      });
      Bus.emit('order:awaken', { unit: u });
      return true;
    },
  },

  medicalKit: {
    id: 'medicalKit', name: 'Medical Kit', cost: 2, target: 'unit', icon: '+',
    desc: 'Field dressing — restores 45% of maximum HP.',
    filter: (u) => u.active && u.hp < u.maxHp && !u.isVehicle,
    apply(battle, u) { u.heal(u.maxHp * 0.45); return true; },
  },

  enemyRecon: {
    id: 'enemyRecon', name: 'Enemy Recon', cost: 2, target: 'none', icon: 'O',
    desc: 'Every enemy position is marked for one turn.',
    filter: () => true,
    apply(battle) {
      battle.reconTurns = 2;
      for (const u of battle.units) if (u.team === 1) { u.spotted = true; u.lastKnown.copy(u.pos); }
      Bus.emit('recon:full', { turns: 2 });
      return true;
    },
  },

  fireSupport: {
    id: 'fireSupport', name: 'Fire Support', cost: 3, target: 'area', icon: '*',
    desc: 'Off-map battery walks four shells across the marked ground.',
    filter: () => true,
    apply(battle, target, opts) {
      const pos = target?.isVector3 ? target : (target?.pos || _v.set(0, 0, 0));
      battle.queueBarrage(pos, 4, 6.5, 95);
      return true;
    },
  },

  directCommand: {
    id: 'directCommand', name: 'Direct Command', cost: 3, target: 'unit', icon: 'DC',
    desc: 'The commander orders a soldier forward — the next sortie is free.',
    filter: (u, battle) => {
      const cmd = battle.commanderOf(u.team);
      return u.active && cmd && cmd !== u && cmd.pos.distanceTo(u.pos) < 22;
    },
    apply(battle, u) { u.freeAction = true; Bus.emit('order:freeAction', { unit: u }); return true; },
  },

  stormyAttack: {
    id: 'stormyAttack', name: 'Stormy Attack', cost: 3, target: 'unit', icon: '2x',
    desc: 'The soldier may fire twice on the next sortie.',
    filter: (u) => u.active && !u.isVehicle,
    apply(battle, u) { u.extraAttacks = (u.extraAttacks || 0) + 1; return true; },
  },

  repairKit: {
    id: 'repairKit', name: 'Field Repair', cost: 3, target: 'unit', icon: 'W',
    desc: 'Crew patch the tank in the field — restores 35% of hull integrity.',
    filter: (u) => u.isVehicle && u.alive && u.hp < u.maxHp,
    apply(battle, u) { u.repair(u.maxHp * 0.35); return true; },
  },
};

export const ORDER_IDS = Object.keys(ORDERS);

/** Orders the given team can afford and legally use right now. */
export function availableOrders(battle, team) {
  const out = [];
  for (let i = 0; i < ORDER_IDS.length; i++) {
    const o = ORDERS[ORDER_IDS[i]];
    if (battle.cp[team] < o.cost) continue;
    if (o.target === 'unit') {
      let any = false;
      for (const u of battle.units) if (u.team === team && o.filter(u, battle)) { any = true; break; }
      if (!any) continue;
    } else if (!o.filter(null, battle)) continue;
    out.push(o);
  }
  return out;
}

export default ORDERS;
