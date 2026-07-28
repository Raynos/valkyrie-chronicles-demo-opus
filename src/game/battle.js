// src/game/battle.js — the BLiTZ state machine.
//
//   briefing -> deploy -> command <-> action -> enemy -> (loop) -> result
//
// Battle owns: the roster, Command Point economy, the turn counter, per-soldier action counting
// with AP decay, orders, base camps, reinforcement waves, fog-of-war truth, win/lose objectives,
// and the results screen with a VC-style A/B/C/D rank.
//
// Everything the UI needs is published on the Bus (see docs/ARCHITECTURE.md). The HUD never
// reaches in here.

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { CFG } from '../core/config.js';
import { clamp, damp } from '../core/math.js';
import { makeRng } from '../core/rng.js';

import { Character } from '../actors/character.js';
import { Tank } from '../actors/tank.js';

import { AP_DECAY, Unit, bindWorldHooks } from './units.js';
import { canSee, explode, setCombatContext } from './combat.js';
import { NavGrid } from './nav.js';
import { ORDERS } from './orders.js';
import { InterceptionSystem } from './interception.js';
import { ActionMode } from './actionMode.js';
import { CommandMode } from './commandMode.js';
import { EnemyAI } from './ai.js';
import { MISSION_VASEL } from './mission.js';

export const PHASES = ['briefing', 'deploy', 'command', 'action', 'enemy', 'result'];

export class Battle {
  /**
   * @param {object} world  src/world/world.js World
   * @param {THREE.Scene} scene
   * @param {object} opts   { camera, mission, seed, autoDeploy }
   */
  constructor(world, scene, opts = {}) {
    this.world = world;
    this.scene = scene;
    this.camera = opts.camera || null;
    this.mission = opts.mission || MISSION_VASEL;
    this.seed = opts.seed ?? CFG.seed;
    this.rng = makeRng(this.seed ^ 0x5bf03635);

    this.phase = 'briefing';
    this.turn = 0;
    this.team = 0;
    this.cp = { 0: 0, 1: 0 };
    this.units = [];
    this.camps = [];
    this.reconTurns = 0;
    this.timeScale = 1;
    this.over = false;
    this.victory = false;
    this.result = null;

    this.activeUnit = null;
    this.pendingDeploy = [];          // units awaiting placement
    this.deployment = new Map();      // unit -> slot
    this.barrages = [];
    this.waveIndex = 0;

    this.log = [];
    this.stats = {
      turns: 0, kills: 0, losses: 0, rescued: 0, captured: 0,
      damageDealt: 0, damageTaken: 0, campsTaken: 0, ordersUsed: 0, cpSpent: 0,
    };

    // Nav grid across the mission's play area.
    const B = this.mission.bounds || { minX: -110, maxX: 110, minZ: -110, maxZ: 110 };
    this.nav = new NavGrid(world, { cell: this.mission.navCell || 1.5, ...B });
    this.bounds = B;

    bindWorldHooks(world);
    setCombatContext({ world, units: this.units, battle: this, rng: this.rng });

    this.interception = new InterceptionSystem(this);
    this.ai = new EnemyAI(this, { team: 1 });
    this.actionMode = null;
    this.commandMode = null;

    this._transition = 0;
    this._pendingPhase = null;
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /** Build the nav grid, roster and camps. Safe to call once. */
  setup() {
    if (this._setup) return this;
    this._setup = true;
    this.nav.build();

    const M = this.mission;
    for (const c of M.camps) {
      this.camps.push({
        id: c.id, name: c.name,
        pos: new THREE.Vector3(c.pos[0], this.groundY(c.pos[0], c.pos[2] ?? c.pos[1]), c.pos[2] ?? c.pos[1]),
        radius: c.radius ?? 6.5,
        owner: c.owner ?? -1,
        deploy: c.deploy !== false,
        contested: false,
        captureT: 0,
      });
    }

    for (const spec of M.roster) this.addUnit(spec);
    for (const spec of M.enemies) this.addUnit(spec);

    this.refreshFog();
    Bus.emit('battle:ready', { battle: this, mission: M });
    return this;
  }

  /** Create the camera-dependent modes. Call after the Engine's camera exists. */
  attachCamera(camera) {
    this.camera = camera;
    this.actionMode = new ActionMode(this, camera, { scene: this.scene });
    this.commandMode = new CommandMode(this, camera, {
      scene: this.scene,
      bounds: this.bounds,
    });
    return this;
  }

  /**
   * @param {object} spec { cls, team, name, pos:[x,z], yaw, potentials, hpScale, commander, deployable }
   */
  addUnit(spec) {
    // Mission coordinates are authored against a schematic of the valley; snap them onto real
    // walkable ground so nobody spawns inside the river or a wall of the ruined mill.
    let sx = spec.pos ? spec.pos[0] : 0;
    let sz = spec.pos ? spec.pos[1] : 0;
    if (spec.pos && this.nav?.built) {
      const ci = this.nav.nearestWalkable(sx, sz, 16);
      if (ci >= 0) {
        const nx = this.nav.worldX(ci % this.nav.w);
        const nz = this.nav.worldZ((ci / this.nav.w) | 0);
        // Only accept the snap if it is a small correction — otherwise trust the author.
        if (Math.hypot(nx - sx, nz - sz) < 14) { sx = nx; sz = nz; }
      }
    }
    const y = this.groundY(sx, sz);
    const u = new Unit({
      cls: spec.cls,
      team: spec.team ?? 0,
      name: spec.name,
      seed: (this.seed ^ (this.units.length * 2654435761)) >>> 0,
      pos: { x: sx, y, z: sz },
      yaw: spec.yaw ?? 0,
      potentials: spec.potentials,
      hpScale: spec.hpScale,
      aimScale: spec.aimScale,
    });
    u.battleRef = this;
    u.commander = !!spec.commander;
    u.ace = !!spec.ace;
    u.deployable = spec.deployable !== false;
    u.deployed = spec.deployed !== false;
    u.actor = this.makeActor(u, spec);
    if (u.actor?.root) {
      this.scene?.add(u.actor.root);
      u.syncActor();
    }
    this.units.push(u);
    if (spec.team === 1 || u.team === 1) u.spotted = false;
    return u;
  }

  /**
   * Build the visual actor. Static `Battle.actorFactory` lets the integrator swap in a pooled
   * or LOD-aware factory without touching this file.
   */
  makeActor(u, spec = {}) {
    if (Battle.actorFactory) return Battle.actorFactory(u, spec);
    try {
      if (u.isVehicle) {
        return new Tank({
          team: u.team, name: u.name, seed: u.seed, variant: spec.variant,
          world: this.world, scene: this.scene, hp: u.maxHp,
        });
      }
      return new Character({
        class: u.cls, team: u.team, name: u.name, seed: u.seed,
        // Lets the rig foot-plant on the heightfield instead of floating over it.
        ground: (x, z) => this.groundY(x, z),
        quality: CFG.quality,
      });
    } catch (e) {
      console.warn('[battle] actor construction failed, using placeholder', e);
      const g = new THREE.Group();
      g.name = `${u.name}-placeholder`;
      return { root: g, play() {}, setAimAngles() {}, update() {}, dispose() {} };
    }
  }

  groundY(x, z) {
    if (this.world?.groundHeightAt) return this.world.groundHeightAt(x, z);
    if (this.world?.terrain?.heightAt) return this.world.terrain.heightAt(x, z);
    return 0;
  }

  // -------------------------------------------------------------------------
  // Phase machine
  // -------------------------------------------------------------------------

  setPhase(p) {
    if (this.phase === p) return;
    const from = this.phase;
    this.phase = p;
    // The tactical map overlay belongs to the two map phases and nothing else.
    // Taking it down here rather than at each call site means anything that
    // drives the machine into 'action'/'result' directly — the opening script,
    // the capture shots — cannot leave the threat wash painted across an
    // over-the-shoulder frame. CommandMode.exit() is idempotent.
    if (p !== 'command' && p !== 'enemy') this.commandMode?.exit();
    Bus.emit('phase:change', { from, to: p });
  }

  /** briefing -> deploy */
  startDeployment() {
    if (this.phase !== 'briefing') return;
    this.pendingDeploy = this.units.filter((u) => u.team === 0 && u.deployable);
    for (const u of this.pendingDeploy) u.deployed = false;
    this.deployment.clear();
    this.setPhase('deploy');
    Bus.emit('deploy:begin', {
      slots: this.deploySlots(), units: this.pendingDeploy.slice(),
      max: this.mission.deployMax ?? this.pendingDeploy.length,
    });
    if (this.mission.autoDeploy !== false) this.autoDeploy();
  }

  deploySlots() {
    const out = [];
    // The world author knows where the ground is flat and walkable; prefer its zone.
    if (this.world?.deployPositions && !this._deployDirty) {
      const n = (this.mission.deployMax ?? 6) + 3;
      let pts = null;
      try { pts = this.world.deployPositions(0, n, 2.7); } catch { pts = null; }
      if (pts && pts.length) {
        for (let i = 0; i < pts.length; i++) {
          out.push({ camp: this.camps[0]?.id ?? 'hq', index: i, pos: pts[i].clone ? pts[i].clone() : pts[i] });
        }
        return out;
      }
    }
    for (const c of this.camps) {
      if (!c.deploy || c.owner !== 0) continue;
      const n = this.mission.slotsPerCamp ?? 6;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.4;
        const r = c.radius * 0.62;
        const x = c.pos.x + Math.sin(a) * r;
        const z = c.pos.z + Math.cos(a) * r;
        out.push({ camp: c.id, index: out.length, pos: new THREE.Vector3(x, this.groundY(x, z), z) });
      }
    }
    return out;
  }

  /** Place a unit on a deployment slot. */
  deploy(unit, slot) {
    if (this.phase !== 'deploy') return false;
    if (!slot) return false;
    for (const [u, s] of this.deployment) if (s.index === slot.index && u !== unit) return false;
    this.deployment.set(unit, slot);
    unit.pos.copy(slot.pos);
    unit.deployed = true;
    unit.yaw = Math.atan2(-slot.pos.x, -slot.pos.z);
    unit.syncActor();
    Bus.emit('deploy:changed', { unit, slot, count: this.deployment.size });
    return true;
  }

  autoDeploy() {
    const slots = this.deploySlots();
    const max = Math.min(this.mission.deployMax ?? 99, slots.length);
    let i = 0;
    // Put the heavy classes closest to the front (largest z toward the objective).
    const order = this.pendingDeploy.slice().sort((a, b) => weightOf(b) - weightOf(a));
    for (const u of order) {
      if (i >= max) { u.deployed = false; continue; }
      this.deploy(u, slots[i++]);
    }
    // The tank always deploys.
    for (const u of this.units) {
      if (u.team === 0 && u.isVehicle) {
        u.deployed = true;
        if (!this.deployment.has(u) && slots.length) this.deploy(u, slots[Math.min(i, slots.length - 1)]);
      }
    }
  }

  confirmDeployment() {
    if (this.phase !== 'deploy') return;
    for (const u of this.units) {
      if (u.team === 0 && !this.deployment.has(u) && !u.isVehicle) u.deployed = false;
    }
    Bus.emit('deploy:end', { deployed: this.units.filter((u) => u.team === 0 && u.deployed).length });
    this.turn = 0;
    this.startTurn(0);
  }

  /** Skip straight into the fight — used by capture shots and by "quick start". */
  beginBattle() {
    if (this.phase === 'briefing') this.startDeployment();
    if (this.phase === 'deploy') this.confirmDeployment();
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  startTurn(team) {
    this.team = team;
    if (team === 0) {
      this.turn++;
      this.stats.turns = this.turn;
      if (this.reconTurns > 0) this.reconTurns--;
    }

    // Bleed-out ticks for this side's casualties.
    for (const u of this.units) {
      if (u.team !== team) continue;
      u.beginTurn();
      if (u.downed) u.tickBleed();
    }

    this.cp[team] = this.computeCp(team);
    Bus.emit('cp:changed', { team, cp: this.cp[team] });
    Bus.emit('turn:changed', { team, turn: this.turn });
    Bus.emit('sfx', { name: team === 0 ? 'turnPlayer' : 'turnEnemy' });

    this.spawnReinforcements(team);
    this.refreshFog();
    if (this.checkObjectives()) return;

    if (team === 0) {
      this.setPhase('command');
      this.commandMode?.enter();
      this.commandMode?.markDirty();
    } else {
      this.setPhase('enemy');
      this.commandMode?.enter();
      this.commandMode?.markDirty();
      this.ai.begin(1);
    }
  }

  computeCp(team) {
    const base = team === 0 ? (this.mission.cpPlayer ?? CFG.gameplay.cpPerTurn)
      : (this.mission.cpEnemy ?? CFG.gameplay.cpPerTurn);
    let bonus = 0;
    for (const c of this.camps) if (c.owner === team) bonus++;
    // The first camp is your HQ and is baked into the base value.
    bonus = Math.max(0, bonus - 1);
    const alive = this.units.filter((u) => u.team === team && u.active).length;
    return clamp(base + bonus, 1, Math.max(1, alive + 2));
  }

  endTurn() {
    if (this.over) return;
    this._pendingPhase = null;
    this._transition = 0;
    if (this.phase === 'action') this.endAction('turnEnded');
    const next = this.team === 0 ? 1 : 0;
    Bus.emit('turn:end', { team: this.team, turn: this.turn });
    this.startTurn(next);
  }

  // -------------------------------------------------------------------------
  // Selection / actions
  // -------------------------------------------------------------------------

  selectCost(unit) { return unit?.freeAction ? 0 : 1; }

  previewAp(unit) { return unit ? unit.previewAp() : 0; }

  canSelect(unit, team = 0) {
    if (!unit || unit.team !== team || !unit.active) return false;
    if (this.cp[team] < this.selectCost(unit)) return false;
    if (unit.actionsThisTurn >= AP_DECAY.length) return false;
    return true;
  }

  selectDenyReason(unit) {
    if (!unit) return 'No unit selected';
    if (!unit.active) return `${unit.name} is out of action`;
    if (this.cp[unit.team] < this.selectCost(unit)) return 'Not enough Command Points';
    if (unit.actionsThisTurn >= AP_DECAY.length) return `${unit.name} is exhausted`;
    return 'Unavailable';
  }

  /** Spend the CP for `unit` without entering Action Mode (used by the AI). */
  spendCpFor(unit, team = unit.team) {
    const cost = this.selectCost(unit);
    if (this.cp[team] < cost) return false;
    this.cp[team] -= cost;
    this.stats.cpSpent += cost;
    unit.freeAction = false;
    Bus.emit('cp:changed', { team, cp: this.cp[team] });
    return true;
  }

  /** Player-side selection: pay the CP, hand control to Action Mode. */
  selectUnit(unit) {
    if (this.phase !== 'command') return false;
    if (!this.canSelect(unit, 0)) {
      Bus.emit('command:denied', { unit, reason: this.selectDenyReason(unit) });
      return false;
    }
    if (!this.spendCpFor(unit, 0)) return false;

    this.activeUnit = unit;
    unit.beginAction();
    this.setPhase('action');
    this.commandMode?.exit();
    this.actionMode?.enter(unit);
    Bus.emit('unit:selected', { unit });
    return true;
  }

  /** Called by ActionMode when the soldier's sortie ends. */
  endAction(reason = 'manual') {
    const u = this.activeUnit;
    if (u) {
      u.endAction();
      this.onUnitActionEnd(u);
    }
    this.activeUnit = null;
    if (this.over) return;
    if (this.checkObjectives()) return;

    if (this.cp[0] <= 0 && this.team === 0) {
      this.setPhase('command');
      this.commandMode?.enter();
      // Give the player a beat to read the map before the Imperials move.
      this._pendingPhase = 'enemyTurn';
      this._transition = 1.1;
      Bus.emit('command:outOfCp', {});
      return;
    }
    this.setPhase('command');
    this.commandMode?.enter();
    this.commandMode?.markDirty();
  }

  /** Shared post-action housekeeping for both sides. */
  onUnitActionEnd(u) {
    this.updateCamps();
    this.refreshFog();
    this.commandMode?.markDirty();
    Bus.emit('unit:actionEnd', { unit: u, actions: u.actionsThisTurn });
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  useOrder(id, target) {
    const o = ORDERS[id];
    if (!o) return false;
    const team = this.team;
    if (this.cp[team] < o.cost) {
      Bus.emit('command:denied', { order: o, reason: 'Not enough Command Points' });
      return false;
    }
    if (o.target === 'unit' && (!target || !o.filter(target, this))) {
      Bus.emit('command:denied', { order: o, reason: 'Invalid target' });
      return false;
    }
    this.cp[team] -= o.cost;
    let ok = false;
    try { ok = o.apply(this, target, this) !== false; } catch (e) { console.error('[order]', id, e); ok = false; }
    if (!ok) {
      this.cp[team] += o.cost;                 // refund
      Bus.emit('command:denied', { order: o, reason: 'Order failed' });
      return false;
    }
    this.stats.ordersUsed++;
    this.stats.cpSpent += o.cost;
    Bus.emit('cp:changed', { team, cp: this.cp[team] });
    Bus.emit('order:used', { order: o, unit: o.target === 'unit' ? target : null });
    Bus.emit('sfx', { name: 'orderUse' });
    this.commandMode?.markDirty();
    return true;
  }

  /** Off-map artillery, walked across the ground over several seconds. */
  queueBarrage(pos, count = 4, radius = 6.5, power = 95) {
    const p = pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z);
    for (let i = 0; i < count; i++) {
      const a = this.rng() * Math.PI * 2;
      const r = (i / Math.max(1, count - 1)) * radius * 1.1;
      this.barrages.push({
        at: 0.55 + i * 0.42,
        pos: new THREE.Vector3(p.x + Math.sin(a) * r, 0, p.z + Math.cos(a) * r),
        radius, power,
      });
    }
    Bus.emit('barrage:incoming', { pos: p, count, radius });
    Bus.emit('sfx', { name: 'artilleryWhistle', pos: p });
  }

  updateBarrages(dt) {
    for (let i = this.barrages.length - 1; i >= 0; i--) {
      const b = this.barrages[i];
      b.at -= dt;
      if (b.at > 0) continue;
      b.pos.y = this.groundY(b.pos.x, b.pos.z);
      explode(b.pos, b.radius, b.power, {
        units: this.units, world: this.world, battle: this, aaPower: b.power * 0.55,
      });
      this.barrages.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // Camps
  // -------------------------------------------------------------------------

  campAt(pos) {
    for (let i = 0; i < this.camps.length; i++) {
      const c = this.camps[i];
      const dx = pos.x - c.pos.x, dz = pos.z - c.pos.z;
      if (dx * dx + dz * dz <= c.radius * c.radius) return c;
    }
    return null;
  }

  /**
   * A camp flips when a side has a capture-capable soldier inside it and the other side has
   * nobody in the ring. Contested camps just sit there, which is exactly the standoff VC wants.
   */
  updateCamps() {
    for (const c of this.camps) {
      let n0 = 0, n1 = 0, cap0 = 0, cap1 = 0;
      for (const u of this.units) {
        if (!u.active) continue;
        const dx = u.pos.x - c.pos.x, dz = u.pos.z - c.pos.z;
        if (dx * dx + dz * dz > c.radius * c.radius) continue;
        if (u.team === 0) { n0++; if (u.classDef.canCapture) cap0++; }
        else { n1++; if (u.classDef.canCapture) cap1++; }
      }
      c.contested = n0 > 0 && n1 > 0;
      if (c.contested) continue;
      if (cap0 > 0 && c.owner !== 0) {
        this.captureCamp(c, this.units.find((u) => u.team === 0 && u.active && this.inCamp(u, c)));
      } else if (cap1 > 0 && c.owner !== 1) {
        this.captureCamp(c, this.units.find((u) => u.team === 1 && u.active && this.inCamp(u, c)));
      }
    }
  }

  inCamp(u, c) {
    const dx = u.pos.x - c.pos.x, dz = u.pos.z - c.pos.z;
    return dx * dx + dz * dz <= c.radius * c.radius;
  }

  captureCamp(camp, by) {
    if (!camp || !by) return false;
    if (camp.owner === by.team) return false;
    for (const u of this.units) {
      if (!u.active || u.team === by.team) continue;
      if (this.inCamp(u, camp)) return false;             // still contested
    }
    const from = camp.owner;
    camp.owner = by.team;
    if (by.team === 0) this.stats.campsTaken++;
    Bus.emit('camp:captured', { camp, by, from });
    Bus.emit('sfx', { name: 'capture', pos: camp.pos });
    this.commandMode?.markDirty();
    this.checkObjectives();
    return true;
  }

  // -------------------------------------------------------------------------
  // Reinforcements
  // -------------------------------------------------------------------------

  spawnReinforcements(team) {
    const waves = this.mission.waves || [];
    for (const w of waves) {
      if (w._done) continue;
      if (w.team !== team) continue;
      if (w.turn > this.turn) continue;
      if (w.requiresCamp) {
        const c = this.camps.find((x) => x.id === w.requiresCamp);
        if (!c || c.owner !== team) continue;
      }
      w._done = true;
      const camp = this.camps.find((c) => c.id === w.camp) || this.camps.find((c) => c.owner === team);
      const spawned = [];
      for (let i = 0; i < w.units.length; i++) {
        const spec = w.units[i];
        let px = spec.pos ? spec.pos[0] : (camp ? camp.pos.x : 0);
        let pz = spec.pos ? spec.pos[1] : (camp ? camp.pos.z : 0);
        if (!spec.pos && camp) {
          const a = (i / w.units.length) * Math.PI * 2;
          px += Math.sin(a) * camp.radius * 0.6;
          pz += Math.cos(a) * camp.radius * 0.6;
        }
        spawned.push(this.addUnit({ ...spec, team: w.team, pos: [px, pz] }));
      }
      Bus.emit('reinforcements', { team: w.team, units: spawned, label: w.label || 'Reinforcements' });
      Bus.emit('sfx', { name: team === 0 ? 'reinforceFriendly' : 'reinforceEnemy' });
    }
  }

  // -------------------------------------------------------------------------
  // Fog of war
  // -------------------------------------------------------------------------

  refreshFog() {
    const recon = this.reconTurns > 0;
    for (const u of this.units) {
      if (u.team === 0) { u.spotted = true; continue; }
      if (!u.deployed || (!u.alive && !u.downed)) {
        if (u.spotted) Bus.emit('enemy:lost', { unit: u });
        u.spotted = false;
        if (u.root) u.root.visible = false;
        continue;
      }
      let seen = recon;
      if (!seen) {
        for (const p of this.units) {
          if (p.team !== 0 || !p.active) continue;
          if (canSee(p, u, this.world)) { seen = true; break; }
        }
      }
      if (seen) { u.lastKnown.copy(u.pos); u.lastKnownTurn = this.turn; }
      if (u.spotted !== seen) Bus.emit(seen ? 'enemy:spotted' : 'enemy:lost', { unit: u });
      u.spotted = seen;
      // During the enemy phase you watch them move even outside your line of sight —
      // VC does the same, otherwise the turn is an unreadable black box.
      if (u.root) u.root.visible = seen || this.phase === 'enemy';
    }
  }

  // -------------------------------------------------------------------------
  // Objectives
  // -------------------------------------------------------------------------

  /** @returns true if the mission has ended this call. */
  checkObjectives() {
    if (this.over) return true;
    const M = this.mission;
    // Failure conditions resolve first: losing the Edelweiss ends the mission even if you
    // stepped into their camp on the same frame.
    for (const o of M.objectives) {
      if (!o.fail) continue;
      if (this.evalObjective(o)) { this.finish(false, o); return true; }
    }
    for (const o of M.objectives) {
      if (o.fail || o.win === false) continue;
      if (this.evalObjective(o)) { this.finish(true, o); return true; }
    }
    return false;
  }

  evalObjective(o) {
    switch (o.type) {
      case 'captureCamp': {
        const c = this.camps.find((x) => x.id === o.campId);
        return !!c && c.owner === (o.team ?? 0);
      }
      case 'rout': {
        const team = o.team ?? 1;
        return !this.units.some((u) => u.team === team && (u.alive && u.deployed));
      }
      case 'commanderDown': {
        const cmd = this.commanderOf(o.team ?? 0);
        return !cmd || !cmd.alive || cmd.downed;
      }
      case 'unitLost': {
        const u = this.units.find((x) => x.name === o.unitName);
        return !!u && (!u.alive || u.captured);
      }
      case 'turnLimit':
        return this.turn > (o.turns ?? 20);
      case 'defendTurns':
        return this.turn > (o.turns ?? 10) && this.camps.some((c) => c.id === o.campId && c.owner === (o.team ?? 0));
      case 'tankDestroyed': {
        const t = this.units.find((x) => x.isVehicle && x.team === (o.team ?? 0));
        return !!t && !t.alive;
      }
      default:
        return false;
    }
  }

  commanderOf(team) {
    return this.units.find((u) => u.team === team && u.commander && u.alive) || null;
  }

  finish(victory, objective) {
    if (this.over) return;
    this.over = true;
    this.victory = victory;
    this.ai.abort();
    this.actionMode?.exit();
    this.interception.reset();
    this.setPhase('result');

    const M = this.mission;
    let kills = 0, losses = 0, dealt = 0, taken = 0, rescued = 0;
    const roster = [];
    for (const u of this.units) {
      dealt += u.team === 0 ? u.stats.damageDealt : 0;
      taken += u.team === 0 ? u.stats.damageTaken : 0;
      if (u.team === 0) {
        if (!u.alive) losses++;
        if (u.rescued) rescued++;
        kills += u.stats.kills;
        roster.push({
          name: u.name, cls: u.cls, alive: u.alive, downed: u.downed, rescued: u.rescued,
          hp: u.hp, maxHp: u.maxHp, ...u.stats,
        });
      }
    }
    const rank = victory ? this.computeRank(losses) : 'D';
    const dsePerTurn = M.dsePerTurn ?? 300;
    const exp = victory ? Math.max(0, Math.round((M.baseExp ?? 900) * rankMul(rank) - losses * 120)) : 120;
    const ducats = victory ? Math.max(0, Math.round((M.baseDucats ?? 4200) * rankMul(rank) - this.turn * dsePerTurn * 0.1)) : 400;

    this.result = {
      victory, rank, turns: this.turn, objective: objective?.id || objective?.type || null,
      kills, losses, rescued, damageDealt: dealt, damageTaken: taken,
      campsTaken: this.stats.campsTaken, ordersUsed: this.stats.ordersUsed,
      cpSpent: this.stats.cpSpent, exp, ducats, roster,
      mission: M.id, title: M.name,
    };
    Bus.emit('mission:end', { victory, turns: this.turn, stats: this.result });
    Bus.emit('sfx', { name: victory ? 'victory' : 'defeat' });
  }

  /** VC ranks on speed first, then on whether you brought everybody home. */
  computeRank(losses) {
    const R = this.mission.rankTurns || { A: 6, B: 10, C: 15 };
    let rank = this.turn <= R.A ? 'A' : this.turn <= R.B ? 'B' : this.turn <= R.C ? 'C' : 'D';
    if (losses >= 3 && rank === 'A') rank = 'B';
    if (losses >= 5 && rank === 'B') rank = 'C';
    return rank;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt) {
    if (this._transition > 0) {
      this._transition -= dt;
      if (this._transition <= 0 && this._pendingPhase === 'enemyTurn') {
        this._pendingPhase = null;
        this.endTurn();
      }
    }

    // Aim-mode dilation. Camera and input stay at real time; the world slows.
    const want = this.actionMode?.active ? this.actionMode.timeScale : 1;
    this.timeScale = damp(this.timeScale, want, 12, dt);
    const gdt = dt * this.timeScale;

    this.updateBarrages(gdt);

    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      u.update(gdt);
      if (u !== this.activeUnit) u.syncActor();
    }

    if (this.phase === 'action') {
      this.actionMode?.update(dt, gdt);
      this.interception.update(gdt);
    } else if (this.phase === 'enemy') {
      this.ai.update(gdt);
      this.interception.update(gdt);
      this.actionMode?.updateGrenades(gdt);
      this.commandMode?.update(dt);
      if (this.aiFocus) this.commandMode?.focusOn(this.aiFocus.pos);
    } else {
      this.commandMode?.update(dt);
      this.interception.update(gdt);
      // Grenades in flight when an action ends must still cook off.
      this.actionMode?.updateGrenades(gdt);
    }

    if (this.phase !== 'result') this.checkBodies(gdt);
  }

  /** An enemy who stands over a downed soldier for a beat takes them prisoner. */
  checkBodies(dt) {
    for (const u of this.units) {
      if (!u.downed || !u.alive) continue;
      for (const o of this.units) {
        if (!o.active || o.team === u.team) continue;
        if (o.pos.distanceToSquared(u.pos) < 2.25) {
          o._captureDwell = (o._captureDwell || 0) + dt;
          if (o._captureDwell > 0.8) { u.capture(o); o._captureDwell = 0; }
        } else if (o._captureDwell) o._captureDwell = 0;
      }
    }
  }

  // -------------------------------------------------------------------------

  dispose() {
    this.ai.dispose();
    this.interception.dispose();
    this.actionMode?.dispose();
    this.commandMode?.dispose();
    for (const u of this.units) {
      if (u.root) this.scene?.remove(u.root);
      u.dispose();
    }
    this.units.length = 0;
  }
}

/** Static override point: main.js may set Battle.actorFactory = (unit, spec) => actor. */
Battle.actorFactory = null;

function weightOf(u) {
  return u.isVehicle ? 100 : { lancer: 40, shock: 35, scout: 30, engineer: 20, sniper: 10 }[u.cls] || 15;
}
function rankMul(r) { return r === 'A' ? 1.5 : r === 'B' ? 1.2 : r === 'C' ? 1.0 : 0.7; }

export default Battle;
