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
import { makeBox } from '../world/collider.js';

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

/**
 * The failure condition no mission declares, because it is true of all of them.
 *
 * Round 22's playtest lost all six soldiers and the mission cheerfully offered EIGHTEEN more
 * turns of one immobile tank, with the objective panel still reading "Twenty turns". The tank
 * cannot capture a camp (CLASSES.tank.canCapture === false) and cannot rescue a body
 * (canRescue === false), so at that point there was no way left to win and no way left to
 * lose. A mission that cannot be won must end. See Battle.squadWiped().
 */
export const SQUAD_LOST = Object.freeze({
  id: 'squad-lost', type: 'squadLost', fail: true, label: 'The squad must not be wiped out',
});

/**
 * The same rule as SQUAD_LOST, one notch earlier — because SQUAD_LOST was written too narrow.
 *
 * Round 25's playtest lost the two scouts, the engineer and the shocktrooper by turn 2. Largo
 * (lancer) and Marina (sniper) both have `canCapture: false`, so infantryStanding(0) was still
 * 2 and squadWiped() stayed false — and the mission ran turns 3 through 21 with the objective
 * panel still promising twenty turns, then ended on 'timeout'. Nobody left could ever stand on
 * the flag, and a downed capturer never comes back: rescue() sets `deployed = false` (units.js
 * :931) and a bleed-out kills them outright.
 *
 * The theoretical escape is the 'rout' win — the Edelweiss alone killing every Imperial — so
 * this only fires while Imperials are still on the field. In practice one tank against a
 * garrison with a tankHunter lancer is not a win path, but the guard costs nothing and keeps
 * the rule true rather than merely usually-true.
 */
export const NO_CAPTURERS = Object.freeze({
  id: 'no-capturers', type: 'noCapturers', fail: true, label: 'Someone has to reach their flag',
});

/**
 * SQUAD_LOST'S HONEST TWIN: the field is empty because everyone was CARRIED OFF IT.
 *
 * rescue() is a success — the casualty lives — but it clears `deployed`, so a squad that was
 * downed and then fully evacuated reads identically to a squad that was killed:
 * infantryStanding(0) === 0. Measured in the r26 sim audit: down all six, rescue all six, and
 * the mission ends with the banner "SQUAD WIPED OUT" and a results screen listing ZERO
 * casualties. The ending is still correct — nobody left on the field can take the flag, so the
 * mission cannot be won and must end — but blaming the player for six deaths that did not
 * happen is a lie the results screen then contradicts.
 *
 * So the loss stays and only the NAME changes. See squadEvacuated().
 */
export const SQUAD_WITHDRAWN = Object.freeze({
  id: 'squad-withdrawn', type: 'squadWithdrawn', fail: true,
  label: 'Someone has to stay on the field',
});

// Beat between the last soldier falling and the results screen, so the fall reads.
const WIPE_GRACE = 1.5;

// Near-miss suppression: radius squared, amount per round, and the ceiling misses alone can
// reach. See Battle.onNearMiss().
const NEAR_MISS_R2 = 1.7 * 1.7;
const NEAR_MISS_SUP = 0.11;
const NEAR_MISS_CAP = 0.8;

// ---------------------------------------------------------------------------
// Camp capture geometry — the reason this mission was unwinnable for 20 rounds.
//
// A camp has TWO radii and they mean different things:
//
//   radius         the camp FOOTPRINT: deployment slots, the campDefender bonus, the
//                  ground the AI walks to. 9 m at Vasel — wide enough to hold a
//                  garrison, a tank and a supply dump.
//   captureRadius  the FLAG RING: the few metres around the pole you must stand on to
//                  raise your own colours, and the only ground an Imperial can stand on
//                  to stop you.
//
// Contesting on the FOOTPRINT is what broke the game. Three Imperials live permanently
// inside Vasel's 9 m footprint (2.3 m, 7.8 m and 8.2 m from the flag) and mission
// aggression keeps the garrison sat on its own ground, so `contested` was true from the
// first frame to the last: a scout could stand on the flag all mission and updateCamps()
// returned {contested:true, over:false} forever. Contest the pole, not the parish —
// which is what VC itself does.
const FLAG_RING = 3.6;

// Imperial-phase pacing, in WALL-CLOCK seconds. Measured before this change: 36.2 s for
// turn 1 and 53.3 s for turn 2, with 11 of 12 activations happening on units the player
// could not see. A turn is now paced by what is worth WATCHING.
const ENEMY_PACE = {
  fast: 10,       // sim frames per rendered frame while nobody the player can see is acting
  press: 3.5,     // from here on, compress even the soldiers you can see
  budget: 8.0,    // from here on, everything runs at flush speed
  hard: 10.0,     // absolute cap: drain what is left, then hand the turn back regardless
  flush: 40,
  drainMs: 90,    // compute we will spend per frame on the drain (so it costs frames, not a freeze)
};

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
    // The Imperial soldier currently acting, published for the camera. Set every frame of
    // the enemy phase from ai.actor and cleared the moment the phase ends, so a follow
    // camera can never latch onto a corpse or a stale unit (see paceEnemy()).
    this.aiFocus = null;
    this._aiActor = null;
    this._enemyT = 0;                 // wall-clock seconds spent in the current enemy phase
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
    this._wipeT = 0;                  // seconds the squad has been wiped out (see update())
    this._noCapT = 0;                 // seconds with no capture-capable soldier (NO_CAPTURERS)
    this._sawCapturers = false;       // a capturer was on the field at least once
    this._actionCharge = null;        // what the current sortie cost (see refundEmptySortie())

    // NEAR MISSES SUPPRESS. Without this, "shoot the man covering the bridge" only worked if
    // you HIT him, and a miss at 40 m bought nothing at all — so the counterplay the crossing
    // needs would have been a coin flip. A round that cracks past a soldier's head puts a
    // little suppression on him; takeDamage() handles the ones that land.
    this._offShotHit = Bus.on('shot:hit', (p) => this.onNearMiss(p));
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
        // See FLAG_RING: capture is decided on the pole, not on the whole footprint.
        captureRadius: Math.min(c.captureRadius ?? FLAG_RING, c.radius ?? 6.5),
        owner: c.owner ?? -1,
        deploy: c.deploy !== false,
        contested: false,
        captureT: 0,
        ring: { mine: 0, theirs: 0, capMine: 0, capTheirs: 0 },
      });
    }

    for (const spec of M.roster) this.addUnit(spec);
    for (const spec of M.enemies) this.addUnit(spec);

    this.refreshFog();
    this.updateCamps();
    // addUnit() registers a vehicle collider at the position the roster was authored with;
    // deployment then moves the vehicle. Place them before anything queries cover or walks,
    // rather than leaving them 20 m stale until the first update() frame.
    this.syncVehicleColliders();
    Bus.emit('battle:ready', { battle: this, mission: M });
    // After battle:ready, so the live objective text wins over the static mission list.
    this.publishObjectives();
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
    if (u.isVehicle) this.registerVehicleCollider(u);
    return u;
  }

  /**
   * A TANK IS A BUILDING THAT MOVES, AND THE WORLD DID NOT KNOW IT WAS THERE.
   *
   * World.colliders was built from structures + props + vegetation and nothing else, so the
   * Edelweiss — the 5 m vehicle the whole mission is written around — was a pure rendering.
   * Measured in the r26 sim audit: a 0.35 m body walked clean through the hull without the
   * resolver noticing, and `World.coverAt` (which only queries the collider grid) returned 0
   * for a soldier standing behind it. The single largest piece of hard cover on the map
   * granted none.
   *
   * THE THREE BLOCKING FLAGS ARE SET DELIBERATELY AND THEY ARE NOT ALL TRUE:
   *
   *   solid: true             — bodies stop. This is the whole point. combat.colliderPush()
   *                             does not consult `solid`, but every other reader does, and it
   *                             is the physical truth.
   *   blocksProjectile: false — the tank's BALLISTIC presence is already its unit hitboxes
   *                             (units.js TANK_PARTS). combat.traceScene() prefers the nearest
   *                             hit and a box drawn round the vehicle is always nearer than
   *                             the capsules inside it, so a `true` here would swallow every
   *                             round aimed AT the tank and make it invulnerable to gunfire.
   *   blocksLos: false        — same trap one level up: canSee() traces to the target, so a
   *                             sight-blocking volume centred on the tank would make the tank
   *                             permanently unspottable. Unit bodies never block LOS here.
   *
   * `cover` is what the fix is FOR, and cover is read from the collider independently of all
   * three flags (World.coverAt), so it works.
   *
   * REGISTERED AFTER nav.build(). The nav grid is baked once in setup() from the collider
   * grid; a vehicle collider present at bake time would carve a permanent hole in the walkable
   * set at the tank's START position and never fill it back in when the tank drove away.
   * addUnit() runs after nav.build(), so the bake never sees these. Verified with the standing
   * gate: nav.findPath(start, imperial camp) is still non-null.
   */
  registerVehicleCollider(u) {
    const grid = this.world?.grid;
    const list = this.world?.colliders;
    if (!grid?.insert || !Array.isArray(list)) return null;
    // Armour envelope from src/actors/tank.js `hitDims.hull` + fenders, in world metres with
    // the feet at y = 0: 2.42 wide over the tracks, 5.0 long, belly 0.46 to deck 1.36.
    const col = makeBox(
      { x: u.pos.x, y: u.pos.y + 0.91, z: u.pos.z },
      { x: 1.24, y: 0.68, z: 2.52 },
      u.yaw,
      {
        cover: 0.85, conceal: 0.2,
        solid: true, blocksLos: false, blocksProjectile: false,
        destructible: false, tag: 'vehicle', owner: u,
      },
    );
    col.material = 'metal';
    list.push(col);
    grid.insert(col);
    u.collider = col;
    (this._vehicleColliders || (this._vehicleColliders = [])).push({ unit: u, col });
    return col;
  }

  /**
   * Keep each vehicle collider under its vehicle, and switch it off while that vehicle is the
   * one being driven.
   *
   * NEITHER BODY RESOLVER TAKES AN "IGNORE THIS VOLUME" ARGUMENT, and they are two different
   * resolvers reading two different flags:
   *
   *   World.resolvePosition -> ColliderGrid.resolve  skips only `!c.solid`
   *   nav.stepMove          -> combat.colliderPush   skips `colInert` (noBlock/destroyed/
   *                                                  disabled/dead) and `walkOver`
   *
   * A vehicle sits dead-centre inside its own volume, so a live one would eject the tank
   * along the shortest axis every frame and it could never drive. The game is turn-based —
   * exactly one unit moves at a time — so the acting vehicle's own volume is switched off for
   * the length of its sortie, and it has to be switched off in BOTH vocabularies or the fast
   * path (which is the one that actually runs) ignores the other one.
   */
  syncVehicleColliders() {
    const v = this._vehicleColliders;
    if (!v || !v.length) return;
    const driving = this.activeUnit || this.ai?.actor || null;
    for (let i = 0; i < v.length; i++) {
      const { unit, col } = v[i];
      const off = unit === driving || !unit.alive || !unit.deployed;
      col.disabled = off;                     // combat.colInert()
      col.solid = !off;                       // ColliderGrid.resolve()
      const moved = Math.abs(col.center.x - unit.pos.x) > 1e-3
        || Math.abs(col.center.z - unit.pos.z) > 1e-3
        || Math.abs(col.center.y - (unit.pos.y + 0.91)) > 1e-3
        || Math.abs((col.yaw || 0) - unit.yaw) > 1e-3;
      if (!moved) continue;
      col.center.set(unit.pos.x, unit.pos.y + 0.91, unit.pos.z);
      col.yaw = unit.yaw;
      this.world.grid.update(col);            // re-buckets and refreshes the AABB
    }
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
    const off = this.startLineOffset();
    const used = new Set();
    // The world author knows where the ground is flat and walkable; prefer its zone.
    if (this.world?.deployPositions && !this._deployDirty) {
      const n = (this.mission.deployMax ?? 6) + 3;
      let pts = null;
      try { pts = this.world.deployPositions(0, n, 2.7); } catch { pts = null; }
      if (pts && pts.length) {
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i].clone ? pts[i].clone() : new THREE.Vector3(pts[i].x, pts[i].y, pts[i].z);
          out.push({ camp: this.camps[0]?.id ?? 'hq', index: i, pos: this.snapSlot(p.add(off), used) });
        }
        return this.orderSlotsByDepth(out, off);
      }
    }
    for (const c of this.camps) {
      if (!c.deploy || c.owner !== 0) continue;
      const n = this.mission.slotsPerCamp ?? 6;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.4;
        const r = c.radius * 0.62;
        const x = c.pos.x + Math.sin(a) * r + off.x;
        const z = c.pos.z + Math.cos(a) * r + off.z;
        out.push({ camp: c.id, index: out.length, pos: this.snapSlot(new THREE.Vector3(x, 0, z), used) });
      }
    }
    return this.orderSlotsByDepth(out, off);
  }

  /**
   * Front-to-back, along the axis the squad is actually attacking down.
   *
   * autoDeploy() sorts the roster by weightOf() so "the heavy classes get the low slot
   * indices" (see its comment), but the slots themselves came out of world.deployPositions()
   * in whatever order the sampler happened to produce, so the index meant nothing about
   * depth. Measured on the shipped seed: Isara — engineer, 60 HP, the squishiest infantry in
   * the squad — landed at (13.25, 17.75), the single most forward and most exposed slot, with
   * Rosie (shocktrooper, 96 HP) 15 m BEHIND her. The start line read as random on the exact
   * frame the opening cinematic ends on.
   *
   * The attack axis is startLineOffset(): the vector the whole squad was already slid along,
   * i.e. the first leg of the real nav path from the staging post to the Imperial flag. Sort
   * descending along it, so slot 0 is genuinely the closest to the enemy. Falls back to -Z
   * (map north, the objective side) if the advance is zero.
   */
  orderSlotsByDepth(slots, off) {
    if (slots.length < 2) return slots;
    let fx = off?.x || 0, fz = off?.z || 0;
    const len = Math.hypot(fx, fz);
    if (len < 1e-4) { fx = 0; fz = -1; } else { fx /= len; fz /= len; }
    slots.sort((a, b) => (b.pos.x * fx + b.pos.z * fz) - (a.pos.x * fx + a.pos.z * fz));
    // Re-index so `index` still identifies the slot — deploy() dedupes on it.
    for (let i = 0; i < slots.length; i++) slots[i].index = i;
    return slots;
  }

  /**
   * Put a start-line slot on ground a soldier can walk OFF, and back on the terrain.
   *
   * `nearestOpen`, not `nearestWalkable`: the Vasel approach is peppered with shell craters and
   * a walkable cell on a crater rim is a pocket a soldier cannot leave — held W buys 0.00 m,
   * which is precisely the symptom that got reported as "a third of the squad is stuck at the
   * staging post". Deployment is the one place in the game where the engine, not the player,
   * chooses where a body stands, so it owes the player open ground.
   */
  snapSlot(p, used) {
    const nav = this.nav;
    if (nav?.built) {
      // Snapping quantises to the 1.5 m cell grid, so two slots that were 2.7 m apart can land
      // on the same cell and stack two soldiers in one place. Walk a short spiral off the first
      // choice until we find open ground nobody else has claimed.
      for (let k = 0; k < 12; k++) {
        const a = k * 2.39996;                            // golden-angle spiral
        const r = k === 0 ? 0 : 1.6 * Math.sqrt(k);
        const ci = nav.nearestOpen(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, 14);
        if (ci < 0) continue;
        if (used && used.has(ci) && k < 11) continue;
        p.x = nav.worldX(ci % nav.w);
        p.z = nav.worldZ((ci / nav.w) | 0);
        used?.add(ci);
        break;
      }
    }
    p.y = this.groundY(p.x, p.z);
    return p;
  }

  /**
   * THE START LINE — the offset from the authored deployment zone to where Squad 7 actually
   * forms up, measured along the real route to the objective.
   *
   * WHY THIS EXISTS. Measured in a played session: the nav path from the authored Gallian zone
   * to the Imperial flag is 116-130 m. A scout's ENTIRE first sortie is 1062 AP at 20 AP per
   * metre = 53 m, and over that ground a soldier averages 2.6 m/s, so one sortie is 21 seconds
   * of held W — and it stops 10 m SHORT OF THE RIVER. The nearest Imperial is 76 m from the
   * zone and no enemy on the map has a sight radius over 62 m, so nothing was visible and
   * nothing was shootable for two entire sorties. That was the demo's first ninety seconds:
   * holding W across an empty pasture.
   *
   * The fix is the start line, not the AP. Advancing the whole zone 22 m along the route puts
   * the bridge inside the first sortie and the far bank in contact at the end of it, and leaves
   * every other number in the economy exactly where it was — AP, AP_DECAY, CP, walk speed. The
   * CAMP does not move: the flag, its capture ring, the minimap marker, the campDefender bonus
   * and the reinforcement spawn all stay where the mission authored them. Only where the squad
   * is standing when the mission opens moves.
   *
   * Walking the nav PATH rather than lerping toward the objective matters: the river is
   * crossable only at the bridge, and a straight line toward the flag puts the start line in
   * the water.
   *
   * WHY 22 m AND NOT MORE. 32 m was tried and measured first: it puts the squad 19-20 m from
   * the Imperial Späher across the river with FIVE Imperials already spotted before the player
   * has pressed a key, which hands the garrison a free opening volley and re-creates the
   * turn-1 wipe by geometry instead of by bug. At 22 m the front rank sits 28-31 m out — past
   * every Sturmtruppe's 26 m sight, inside only the enemy scout's 36 m — so the squad opens the
   * mission SEEN but not yet shot at, with the bridge in the near field, and the player still
   * chooses the moment of contact. That is the trade: keep the crossing, delete the pasture.
   */
  startLineOffset() {
    if (this._startOffset) return this._startOffset;
    const off = new THREE.Vector3();
    this._startOffset = off;
    const advance = this.mission.startLineAdvance ?? 22;
    if (!(advance > 0) || !this.nav?.built) return off;
    const home = this.camps.find((c) => c.deploy && c.owner === 0) || this.camps[0];
    const goal = this.camps.find((c) => c.owner === 1);
    if (!home || !goal) return off;
    const path = this.nav.findPath(home.pos, goal.pos, {});
    if (!path || path.length < 2) return off;
    let left = advance;
    for (let i = 1; i < path.length; i++) {
      const seg = path[i].distanceTo(path[i - 1]);
      if (seg >= left) {
        off.copy(path[i - 1]).lerp(path[i], left / Math.max(1e-6, seg)).sub(home.pos);
        off.y = 0;
        break;
      }
      left -= seg;
    }
    return off;
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
    this.syncVehicleColliders();          // deployment just moved the tank — see setup()
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
    this._enemyT = 0;
    this.aiFocus = null;
    this._aiActor = null;
    // A player turn never starts with the Imperial plan still in flight. Nothing should be
    // able to leave the AI running across a boundary any more (see
    // CommandMode.readSelectionInput), but a half-executed Imperial plan surviving into the
    // player's turn is the kind of state that produces a soldier walking on his own during a
    // command phase, so refuse it here. (team 1 needs no abort: ai.begin() resets everything.)
    if (team === 0 && this.ai?.running) this.ai.abort();
    if (this.over) return;
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
    // "Was ever on the field", stamped after the wave so reinforcements count from the turn
    // they arrive. die() and rescue() both clear `deployed`, so it cannot be recovered later.
    // See infantryTotal().
    for (const u of this.units) if (u.deployed) u._wasOnField = true;
    this.refreshFog();
    this.updateCamps();
    this.publishObjectives();
    if (this.checkObjectives()) return;

    // OPEN EVERY TURN ON THE PLAYER'S SQUAD.
    //
    // The Imperial phase drags the map camera after whichever soldier is acting, and
    // CommandMode.enter() only framed the team ONCE per session, so a turn used to open
    // wherever the last Imperial left the lens: round 21 captured a command frame that is a
    // close-up of two village roofs with the entire roster off-screen. A turn you cannot read
    // is a turn you cannot play, so both phases now re-frame the squad and fit it in shot.
    this.setPhase(team === 0 ? 'command' : 'enemy');
    this.commandMode?.enter();
    this.commandMode?.frameTeam(0, false, true);
    this.commandMode?.markDirty();
    if (team !== 0) this.ai.begin(1);
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

  /** Is a soldier of `team` still holding an unspent free sortie? See endAction(). */
  hasPendingFreeAction(team = 0) {
    for (const u of this.units) {
      if (u.team === team && u.freeAction && this.canSelect(u, team)) return true;
    }
    return false;
  }

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

  /**
   * Spend the CP for `unit` without entering Action Mode (used by the AI).
   *
   * `stats.cpSpent` IS THE PLAYER'S BILL, NOT THE WORLD'S. This counter goes straight to the
   * results screen next to a three-turn player budget, and it used to increment for whichever
   * side was spending — including every Imperial sortie. Measured in the r26 audit: the player
   * took ONE sortie (cpSpent 1) and one Imperial phase later the same counter read 7. The
   * winning run's screen billed the player 32 points against a budget of 21, which is a number
   * no player can reconcile with anything they did.
   */
  spendCpFor(unit, team = unit.team) {
    const cost = this.selectCost(unit);
    if (this.cp[team] < cost) return false;
    this.cp[team] -= cost;
    if (team === 0) this.stats.cpSpent += cost;
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
    const cost = this.selectCost(unit);
    if (!this.spendCpFor(unit, 0)) return false;
    // Remember the price so an empty sortie can hand it back, and WHERE HE WAS STANDING when
    // it was paid, so the refund can put him back. See refundEmptySortie().
    this._actionCharge = { unit, cost, x: unit.pos.x, z: unit.pos.z };

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
      this.refundEmptySortie(u, reason);
      u.endAction();
      this.onUnitActionEnd(u);
    }
    this.activeUnit = null;
    if (this.over) return;
    if (this.checkObjectives()) return;

    // A PENDING FREE SORTIE IS NOT "OUT OF COMMAND POINTS".
    //
    // Direct Command costs 3 CP and grants one soldier a sortie that costs 0. Buy it with your
    // last points and the very next `endAction()` saw cp 0 and posted the enemy-turn
    // transition — so the thing you just paid three points for was thrown away before you
    // could spend it. The turn is only over when there is nothing left to do.
    if (this.cp[0] <= 0 && this.team === 0 && !this.hasPendingFreeAction(0)) {
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
    // Come back out of the sortie looking at where the soldier ENDED. CommandMode keeps its own
    // camera target across the action phase, so without this the map snaps back to the ground
    // he started from and the player loses the one thing they just spent a Command Point on.
    if (u?.active) this.commandMode?.focusOn(u.pos);
    this.commandMode?.markDirty();
  }

  /**
   * A SORTIE THAT DID NOTHING COSTS NOTHING.
   *
   * Selecting a soldier is the only way to find out whether the shot you wanted even exists:
   * the range readout, the target dossier and the hit dial all live inside Action Mode.
   * Round 22's playtest spent 4 of 7 Command Points finding that out — one sortie for a
   * target 88 m away behind a building, then trigger pulls on an empty magazine — and the
   * game charged full price for every one of them. A demo must not bill the player for an
   * action it then refuses to perform.
   *
   * So: no metres walked, no round fired, no grenade, no rescue, no capture => the point goes
   * back and the AP-decay counter does not tick. Backing out is free. Acting is not, and
   * acting badly is still your problem.
   *
   * @returns true if a refund was made.
   */
  refundEmptySortie(u, reason) {
    const charge = this._actionCharge;
    this._actionCharge = null;
    if (!charge || charge.unit !== u) return false;
    if (this.over || reason === 'turnEnded' || reason === 'downed') return false;
    if (!u.active || u.actionWasSpent) return false;

    /**
     * A REFUND IS A REWIND, NOT A DISCOUNT.
     *
     * `actionWasSpent` is false below MIN_SORTIE_METRES (0.75 m), and the refund hands the
     * point back AND un-ticks the AP-decay counter. Measured in the r26 audit: that is an
     * unlimited free-movement engine — select, shuffle 0.7 m, end, repeat, and a soldier
     * crosses the whole map on nothing at all, arriving with every sortie still in hand.
     *
     * The hole is that the refund undid the PRICE but not the MOVE. Undo both: a sortie that
     * "took no action" leaves the soldier exactly where he started. At under 0.75 m this is
     * invisible — it is the same shuffle the game has already decided did not happen — and it
     * removes the exploit at the mechanism rather than by tightening a threshold that would
     * then just be shuffled up to.
     */
    if (charge.x !== undefined && (u.pos.x !== charge.x || u.pos.z !== charge.z)) {
      u.pos.x = charge.x;
      u.pos.z = charge.z;
      u.pos.y = this.groundY(charge.x, charge.z);
      u.movedThisAction = 0;
      u.syncActor?.();
    }

    if (u.actionsThisTurn > 0) u.actionsThisTurn--;
    if (u.actionsThisTurn === 0) u.hasActed = false;
    if (charge.cost > 0) {
      this.cp[0] += charge.cost;
      this.stats.cpSpent = Math.max(0, this.stats.cpSpent - charge.cost);
      Bus.emit('cp:changed', { team: 0, cp: this.cp[0] });
    } else {
      // A free action spent on nothing is still free — and Direct Command's full-AP half has
      // to come back with it, or backing out of a commanded sortie silently downgrades it to
      // an ordinary decayed one.
      u.freeAction = true;
      u.freshSortie = true;
    }
    Bus.emit('cp:refunded', { unit: u, cp: charge.cost, team: 0, reason: 'noAction' });
    Bus.emit('ui:alert', {
      text: 'NO ACTION TAKEN',
      sub: charge.cost > 0 ? 'Command Point refunded' : 'free action kept',
    });
    return true;
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

    // ORDERS ARE A COMMAND-PHASE ACTION OF THE SIDE WHOSE PHASE IT IS.
    //
    // There was no guard here at all, and `team` is read off `this.team` while the TARGET is
    // whatever the caller passed. Measured headless: with the battle in the Imperial phase,
    // `useOrder('attackBoost', alicia)` took TWO COMMAND POINTS OFF THE IMPERIALS (6 -> 4) and
    // put the buff on a Gallian scout. The HUD hides the deck outside 'command' so a mouse
    // cannot reach it today, but `ui:order` is a public Bus channel and main.js pipes it
    // straight in — one stray emit and the player is buying orders with the enemy's budget.
    // The same hole let an order be bought mid-sortie ('action') and after the mission ended.
    if (this.over || (this.phase !== 'command' && this.phase !== 'enemy')) {
      Bus.emit('command:denied', { order: o, reason: 'Not in command' });
      return false;
    }
    if (this.cp[team] < o.cost) {
      Bus.emit('command:denied', { order: o, reason: 'Not enough Command Points' });
      return false;
    }
    // ...and you may only order your OWN soldiers. No order filter checks the team, so
    // `attackBoost` on a hostile passed cheerfully and spent your point buffing him.
    if (o.target === 'unit' && (!target || target.team !== team || !o.filter(target, this))) {
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
    // Both of these are read straight off the results screen, so both are the PLAYER's tally.
    // See spendCpFor(): an Imperial order used to appear on the player's bill.
    if (team === 0) { this.stats.ordersUsed++; this.stats.cpSpent += o.cost; }
    Bus.emit('cp:changed', { team, cp: this.cp[team] });
    Bus.emit('order:used', { order: o, unit: o.target === 'unit' ? target : null });
    Bus.emit('sfx', { name: 'orderUse' });
    this.commandMode?.markDirty();
    return true;
  }

  /**
   * WHERE THE OFF-MAP BATTERY IS ALLOWED TO DROP, for a barrage `team` is calling in.
   *
   * ORDERS.fireSupport is `target: 'area'` and there has never been an area-picking UI. The
   * order deck passes `{ unit: selectedUnit }` like every other card, so `apply()` took the
   * SELECTED SOLDIER'S POSITION as the aim point and walked four 95-power shells across it.
   * Measured in the r26 playtest: 4 of 6 squadmates hit, Alicia downed, zero Imperials
   * touched, 3 CP spent. The deck was masked at the time; it is not any more.
   *
   * Until an area picker exists the order aims itself, and the rule is a HARD GUARANTEE
   * rather than a heuristic: it will not fire at all unless there is a spotted enemy cluster
   * with no friendly inside the danger footprint.
   *
   * THE FOOTPRINT IS BIGGER THAN THE BLAST RADIUS. queueBarrage() scatters each shell up to
   * `radius * 1.1` from the aim point and each shell's blast reaches `radius`, so a shell can
   * reach `radius * 2.1` — 13.65 m at the default 6.5. That, not 6.5, is the clearance every
   * friendly (standing, downed, and the tank) must have. It is a large exclusion and it makes
   * the card unavailable in a close-quarters fight. That is the conservative choice on
   * purpose: a card that sometimes cannot fire beats a card that sometimes wipes your squad.
   *
   * @returns {THREE.Vector3|null} the aim point, or null if there is no safe cluster.
   */
  barrageAimPoint(team = 0, radius = 6.5) {
    const danger = radius * 2.1;
    const foes = [];
    for (const u of this.units) {
      if (u.team === team || !u.active) continue;
      // Team 0 may only shell what it can SEE (`spotted` is only maintained for team 1; the
      // AI is allowed the same courtesy against a player it has acquired).
      if (team === 0 && !u.spotted) continue;
      foes.push(u);
    }
    if (!foes.length) return null;

    let best = null, bestScore = 0;
    for (const c of foes) {
      let safe = true;
      for (const f of this.units) {
        if (f.team !== team || !f.alive || !f.deployed) continue;
        const dx = f.pos.x - c.pos.x, dz = f.pos.z - c.pos.z;
        if (dx * dx + dz * dz < danger * danger) { safe = false; break; }
      }
      if (!safe) continue;
      let n = 0;
      for (const o of foes) {
        const dx = o.pos.x - c.pos.x, dz = o.pos.z - c.pos.z;
        if (dx * dx + dz * dz <= radius * radius) n++;
      }
      // Deterministic tie-break: densest cluster, then the northernmost (closest to the
      // Imperial end of the valley), then by name, so the same board always aims the same way.
      if (!best || n > bestScore || (n === bestScore && c.pos.z < best.pos.z)) {
        best = c; bestScore = n;
      }
    }
    return best ? best.pos.clone() : null;
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

  /**
   * The camp whose FLAG RING contains `pos` — i.e. "am I standing on a flag". Both capture
   * call sites outside this file (ActionMode's arrival check and the AI's) want exactly that
   * question, so this is the ring. For the footprint, use campFootprintAt().
   */
  campAt(pos) {
    for (let i = 0; i < this.camps.length; i++) {
      const c = this.camps[i];
      const dx = pos.x - c.pos.x, dz = pos.z - c.pos.z;
      if (dx * dx + dz * dz <= c.captureRadius * c.captureRadius) return c;
    }
    return null;
  }

  /** The camp whose footprint contains `pos`: deployment, defence bonuses, AI approach. */
  campFootprintAt(pos) {
    for (let i = 0; i < this.camps.length; i++) {
      const c = this.camps[i];
      const dx = pos.x - c.pos.x, dz = pos.z - c.pos.z;
      if (dx * dx + dz * dz <= c.radius * c.radius) return c;
    }
    return null;
  }

  /**
   * A camp flips when a side has a capture-capable soldier standing in the FLAG RING and the
   * other side has nobody in it. Imperials elsewhere in the camp do not stop the capture —
   * they shoot at you, which is the fight this mission is supposed to be. See FLAG_RING.
   */
  updateCamps() {
    for (const c of this.camps) {
      const rr = c.captureRadius * c.captureRadius;
      let mine = 0, theirs = 0, capMine = 0, capTheirs = 0;
      for (const u of this.units) {
        if (!u.active) continue;
        const dx = u.pos.x - c.pos.x, dz = u.pos.z - c.pos.z;
        if (dx * dx + dz * dz > rr) continue;
        if (u.team === 0) { mine++; if (u.classDef.canCapture) capMine++; }
        else { theirs++; if (u.classDef.canCapture) capTheirs++; }
      }
      c.contested = mine > 0 && theirs > 0;
      c.ring = { mine, theirs, capMine, capTheirs };
      // What the HUD's ring draws: 1 = held outright, 0.6 = someone is on a flag they do
      // not own yet, and the HUD makes a contested ring breathe on its own.
      c.captureT = c.contested ? 0
        : ((capMine > 0 && c.owner !== 0) || (capTheirs > 0 && c.owner !== 1)) ? 0.6
          : c.owner >= 0 ? 1 : 0;
      if (!c.contested) {
        if (capMine > 0 && c.owner !== 0) {
          this.captureCamp(c, this.units.find((u) => u.team === 0 && u.active
            && u.classDef.canCapture && this.onFlag(u, c)));
        } else if (capTheirs > 0 && c.owner !== 1) {
          this.captureCamp(c, this.units.find((u) => u.team === 1 && u.active
            && u.classDef.canCapture && this.onFlag(u, c)));
        }
      }
      this.publishCampState(c);
    }
  }

  /** Standing on the flag: the only ground that captures, and the only ground that blocks. */
  onFlag(u, c) {
    const dx = u.pos.x - c.pos.x, dz = u.pos.z - c.pos.z;
    return dx * dx + dz * dz <= c.captureRadius * c.captureRadius;
  }

  /** Inside the camp footprint. */
  inCamp(u, c) {
    const dx = u.pos.x - c.pos.x, dz = u.pos.z - c.pos.z;
    return dx * dx + dz * dz <= c.radius * c.radius;
  }

  /**
   * Make the blocked state READABLE. Before this, the only feedback that the game was
   * refusing to let you capture was the word CONTESTED on a 13-pixel minimap blip — which is
   * how twenty rounds went by without anyone noticing the mission could not be completed.
   *
   * Everything here goes out on Bus channels the HUD ALREADY listens to (`ui:objectives`,
   * `ui:alert`), plus a new `camp:state` for anyone who wants the numbers. The HUD is another
   * agent's file this round and needs no change: it already draws a capture ring per camp off
   * `camp.contested`, which now means "an Imperial is standing on the pole" instead of
   * "an Imperial is somewhere in the parish".
   */
  publishCampState(c) {
    const r = c.ring;
    const key = `${c.owner}|${c.contested ? 1 : 0}|${r.capMine > 0 ? 1 : 0}|${r.theirs}`;
    if (key === c._stateKey) return;
    const first = c._stateKey === undefined;
    c._stateKey = key;
    Bus.emit('camp:state', {
      camp: c, id: c.id, name: c.name, pos: c.pos, owner: c.owner, contested: c.contested,
      onFlag: r.mine, blocking: r.theirs, captureRadius: c.captureRadius,
    });
    this.publishObjectives();
    // You are standing on their flag and it is not flipping. Say why, out loud.
    if (!first && c.contested && r.capMine > 0 && c.owner !== 0) {
      Bus.emit('ui:alert', {
        text: 'FLAG CONTESTED',
        sub: `clear ${r.theirs} Imperial${r.theirs === 1 ? '' : 's'} off the flag`,
      });
    }
  }

  /** The objective list with the camp objective's live state folded into its label. */
  publishObjectives() {
    const list = this.mission?.objectives;
    if (!Array.isArray(list)) return;
    const out = [];
    for (const o of list) {
      const e = { id: o.id, type: o.type, label: o.label, win: o.win, fail: o.fail, done: false };
      if (o.type === 'captureCamp' && !o.fail) {
        const c = this.camps.find((x) => x.id === o.campId);
        if (c) {
          e.done = c.owner === (o.team ?? 0);
          e.label = campObjectiveLabel(c, e.done);
        }
      }
      out.push(e);
    }
    // The built-in failure, published so the panel stops implying you have twenty turns to
    // play with when you have two soldiers left. See SQUAD_LOST.
    if (this.turn >= 1) {
      const standing = this.infantryStanding(0);
      const total = this.infantryTotal(0) || standing;
      out.push({
        id: SQUAD_LOST.id, type: SQUAD_LOST.type, fail: true, done: standing === 0,
        label: total ? `Keep the squad alive — ${standing} of ${total} standing` : SQUAD_LOST.label,
      });
      // The capture-capable count, shown only ONCE YOU HAVE LOST ONE. At full strength it is
      // redundant with the take-camp line above and just costs a panel row; the moment a
      // scout goes down it is the most important number on the screen, because at zero the
      // mission is over. See NO_CAPTURERS.
      const capStand = this.capturersStanding(0);
      const capTotal = this.capturersTotal(0);
      if (capTotal && capStand < capTotal) {
        out.push({
          id: NO_CAPTURERS.id, type: NO_CAPTURERS.type, fail: true, done: capStand === 0,
          label: `Keep someone who can take the flag — ${capStand} of ${capTotal} able`,
        });
      }
    }
    Bus.emit('ui:objectives', { objectives: out });
  }

  captureCamp(camp, by) {
    if (!camp || !by) return false;
    if (camp.owner === by.team) return false;
    if (!by.classDef?.canCapture) return false;
    if (!this.onFlag(by, camp)) return false;             // must be ON the pole
    for (const u of this.units) {
      if (!u.active || u.team === by.team) continue;
      if (this.onFlag(u, camp)) return false;             // still contested
    }
    const from = camp.owner;
    camp.owner = by.team;
    if (by.team === 0) this.stats.campsTaken++;
    Bus.emit('camp:captured', { camp, by, from });
    Bus.emit('sfx', { name: 'capture', pos: camp.pos });
    this.commandMode?.markDirty();
    this.publishObjectives();
    this.checkObjectives();
    return true;
  }

  // -------------------------------------------------------------------------
  // Reinforcements
  // -------------------------------------------------------------------------

  /**
   * WAVE BOOKKEEPING BELONGS TO THE BATTLE, NOT TO THE MISSION MODULE.
   *
   * This used to stamp `w._done = true` on the wave objects inside MISSION_VASEL — a
   * module-level singleton. A second `new Battle(...)` in the same page therefore inherited
   * every wave already spent and spawned NOBODY. Measured: build a battle, run it past turn 8,
   * build a fresh one, call spawnReinforcements() at turn 9 — 0 units spawned, so no Imperial
   * reserve platoon, no counter-attack, and no Squad 7 second section.
   *
   * `ui:restart` currently reloads the page, which hides it. It is still a live landmine for
   * every headless playtest: the harness builds Battle after Battle in one page, and from the
   * second one on it is silently testing a mission with no reinforcements in it.
   */
  spawnReinforcements(team) {
    const waves = this.mission.waves || [];
    const done = this._wavesDone || (this._wavesDone = new Set());
    for (let wi = 0; wi < waves.length; wi++) {
      const w = waves[wi];
      if (done.has(wi)) continue;
      if (w.team !== team) continue;
      if (w.turn > this.turn) continue;
      if (w.requiresCamp) {
        const c = this.camps.find((x) => x.id === w.requiresCamp);
        if (!c || c.owner !== team) continue;
      }
      done.add(wi);
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
    // The squad resolves before anything a mission declares: with no infantry on the field
    // there is no win condition left to reach. See SQUAD_LOST.
    if (this.squadWiped()) { this.finish(false, this.squadLossReason()); return true; }
    // ...and one notch earlier, the last soldier who could stand on the flag. See NO_CAPTURERS.
    if (this.captureLost()) { this.finish(false, NO_CAPTURERS); return true; }
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

  /** Infantry of `team` still on their feet on the field. */
  infantryStanding(team = 0) {
    let n = 0;
    for (const u of this.units) if (u.team === team && !u.isVehicle && u.active) n++;
    return n;
  }

  /**
   * Infantry of `team` that were ever on the field, for the "N of M standing" readout.
   *
   * `u.deployed` is the WRONG test and it read as the right one for a long time, because the
   * three ways off the field are not alike: die() and rescue() both clear `deployed`. So
   * evacuating a casualty SHRANK THE DENOMINATOR. Measured: down Rosie, rescue her with Isara,
   * and the objective panel goes from "5 of 6 standing" to "5 of 5 standing" — the squad reads
   * at full strength over a stretcher. Same for the capturer row, which is worse: it only
   * appears at all when `capStand < capTotal`, so rescuing a scout hid the one number that
   * tells you the mission is about to become unwinnable.
   *
   * `_wasOnField` is stamped in startTurn() for anyone standing on the map that turn, so it
   * covers the start line, reinforcement waves, and nobody who was left in the truck.
   */
  infantryTotal(team = 0) {
    let n = 0;
    for (const u of this.units) if (u.team === team && !u.isVehicle && (u.deployed || u._wasOnField)) n++;
    return n;
  }

  /**
   * Every soldier is down. Downed bodies do not save you: the only unit left that could reach
   * one is the Edelweiss, and a tank cannot rescue (CLASSES.tank.canRescue === false), so a
   * bleed-out is the only thing left to watch. See SQUAD_LOST for the round-22 measurement.
   */
  squadWiped() {
    if (this.turn < 1 || this.phase === 'briefing' || this.phase === 'deploy') return false;
    if (this.infantryStanding(0) > 0) return false;
    return this._sawInfantry === true;      // never fire before anybody deployed
  }

  /**
   * The field is empty and NOBODY DIED — every soldier who left it was carried off alive.
   * See SQUAD_WITHDRAWN. The mission still ends (there is no one left to take the flag); this
   * only decides which of the two banners and which failure record it ends with.
   */
  squadEvacuated() {
    if (!this.squadWiped()) return false;
    let rescued = 0;
    for (const u of this.units) {
      if (u.team !== 0 || u.isVehicle) continue;
      if (!(u.deployed || u._wasOnField)) continue;
      if (!u.alive || u.downed) return false;      // a body on the field or in the ground
      if (u.rescued) rescued++;
    }
    return rescued > 0;
  }

  /** SQUAD_LOST or SQUAD_WITHDRAWN, whichever is true. */
  squadLossReason() { return this.squadEvacuated() ? SQUAD_WITHDRAWN : SQUAD_LOST; }

  /** Soldiers of `team` still standing who could actually plant a flag. See NO_CAPTURERS. */
  capturersStanding(team = 0) {
    let n = 0;
    for (const u of this.units) {
      if (u.team === team && u.active && !u.isVehicle && u.classDef?.canCapture) n++;
    }
    return n;
  }

  /** Same, but "was ever on the field" — for the "N of M" readout. See infantryTotal(). */
  capturersTotal(team = 0) {
    let n = 0;
    for (const u of this.units) {
      if (u.team === team && (u.deployed || u._wasOnField) && !u.isVehicle && u.classDef?.canCapture) n++;
    }
    return n;
  }

  /**
   * The capture win is gone for good and the rout win is not available. See NO_CAPTURERS.
   * Only meaningful for a mission whose win condition IS a capture; a rout-only mission is
   * unaffected.
   */
  captureLost() {
    if (this.turn < 1 || this.phase === 'briefing' || this.phase === 'deploy') return false;
    if (!this._sawCapturers) return false;                 // never fire before anybody deployed
    if (this.capturersStanding(0) > 0) return false;
    const M = this.mission;
    if (!M?.objectives?.some((o) => o.type === 'captureCamp' && !o.fail)) return false;
    // Rout is still on the table while any Imperial breathes; if none do, the rout win fires
    // this same frame and it is a VICTORY, not this.
    return this.units.some((u) => u.team === 1 && u.alive && u.deployed);
  }

  finish(victory, objective) {
    if (this.over) return;
    this.over = true;
    this.victory = victory;
    this.aiFocus = null;
    this._aiActor = null;
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
        // A soldier lying on the field when the mission ends is a casualty. Counting only
        // `!alive` is why the wipe-out results screen read "No Casualties" over six bodies:
        // downed soldiers are still `alive` until they bleed out or are taken prisoner.
        if (!u.alive || u.downed) losses++;
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
      // Named explicitly because the HUD's fallback is `roster.filter(r => !r.alive)`, and a
      // soldier left face-down on the bridge is still `alive` — which is how a six-body wipe
      // printed "No Casualties" over the withdrawal report.
      casualties: roster.filter((r) => !r.alive || r.downed).map((r) => ({ name: r.name, cls: r.cls })),
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
    let gdt = dt * this.timeScale;

    // The Imperial phase decides how much simulation this frame is worth — see paceEnemy().
    // Capture renders are excluded outright: their frame count must stay a pure function of
    // the shot name.
    let steps = 1, sub = gdt;
    const paced = this.phase === 'enemy' && !CFG.capture;
    if (paced) {
      const p = this.paceEnemy(dt, gdt);
      steps = p.steps; sub = p.sub;
      gdt = steps * sub;                    // total simulated time for this frame
    }

    this.updateBarrages(gdt);
    this.syncVehicleColliders();

    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      u.update(gdt);
      if (u !== this.activeUnit) u.syncActor();
    }

    // THE FLAG MUST FLIP UNDER THE MAN, NOT ONE SORTIE LATER.
    //
    // updateCamps() ran in exactly three places — setup(), startTurn() and onUnitActionEnd()
    // — and nowhere in this loop. So the mission's primary win condition was sampled only at
    // the END of a sortie: a soldier could walk onto the Imperial pole, stand on it, watch the
    // objective panel not change and the ring not fill, and conclude the capture was broken.
    // He would then usually walk off it again looking for whatever he had missed. MEASURED
    // headless: Alicia placed exactly on camp 'imperial' pos, 400 frames of battle.update(),
    // camp.owner still 1 and battle.over still false; the same state with one updateCamps()
    // call flips the camp and finishes the mission on the frame it is called.
    //
    // Throttled at 0.1 s because it is O(camps x units) — 2 x ~24 distance tests here — and
    // nothing it publishes wants 60 Hz. publishCampState() is already keyed so an unchanged
    // camp emits nothing, and captureCamp() no-ops once the owner matches, so the extra calls
    // are free when nothing is happening.
    //
    // Capture renders are excluded deliberately: a posed shot may stand any unit anywhere, and
    // a camp flipping inside a screenshot would fire checkObjectives() (ending the battle) and
    // emit ui:alert into the plate. Shots get the old three-call cadence, which is what every
    // existing plate was authored against.
    if (!CFG.capture && (this.phase === 'action' || this.phase === 'enemy')) {
      this._campT = (this._campT || 0) + dt;
      if (this._campT >= 0.1) { this._campT = 0; this.updateCamps(); }
    }

    if (this.phase === 'action') {
      this.actionMode?.update(dt, gdt);
      this.interception.update(gdt);
    } else if (this.phase === 'enemy') {
      // Sub-step: the AI, interception fire and grenades in flight integrate in 1/60 slices
      // however much simulated time this frame is worth. A fast-forwarded soldier still walks
      // its path, still eats interception fire, and its grenade still flies a real arc,
      // instead of teleporting through a wall on one enormous step.
      for (let i = 0; i < steps; i++) {
        if (this.phase !== 'enemy') break;
        if (this.ai.running) {
          this.ai.update(sub);
          this.interception.update(sub);
        }
        this.actionMode?.updateGrenades(sub);
      }
      if (paced && this.phase === 'enemy' && this._enemyT > ENEMY_PACE.hard) this.drainEnemyTurn(sub);
      this.commandMode?.update(dt);
      // Only chase an Imperial the player can actually SEE. An unspotted actor is already
      // fast-forwarded at ENEMY_PACE.fast, so following it was pure waste — and it is how the
      // camera ended the turn pointing at a rooftop somewhere in the fog.
      if (this.aiFocus?.spotted) this.commandMode?.focusOn(this.aiFocus.pos);
    } else {
      this.commandMode?.update(dt);
      this.interception.update(gdt);
      // Grenades in flight when an action ends must still cook off.
      this.actionMode?.updateGrenades(gdt);
    }

    if (this.phase !== 'result') this.checkBodies(gdt);

    // THE LAST MAN CAN FALL AT ANY MOMENT OF THE IMPERIAL PHASE, and checkObjectives() only
    // runs on a turn boundary, a capture and the end of a sortie. Watching it per frame is
    // what turns "eighteen more turns of one immobile tank" into a mission that ends. The
    // grace beat is so the player sees him go down before the results screen arrives.
    if (!this.over && this.phase !== 'result') {
      if (this.infantryStanding(0) > 0) { this._sawInfantry = true; this._wipeT = 0; }
      else if (this.squadWiped()) {
        // "WIPED OUT" over six living, evacuated soldiers is a lie the results screen then
        // contradicts with "No Casualties". See SQUAD_WITHDRAWN / squadEvacuated().
        const evac = this.squadEvacuated();
        if (this._wipeT === 0) {
          Bus.emit('ui:alert', evac
            ? { text: 'SQUAD WITHDRAWN', sub: 'every soldier evacuated — no one left to advance' }
            : { text: 'SQUAD WIPED OUT', sub: 'no infantry left on the field' });
        }
        this._wipeT += dt;
        if (this._wipeT >= WIPE_GRACE) this.finish(false, evac ? SQUAD_WITHDRAWN : SQUAD_LOST);
      }
      // Same watcher, one notch earlier: the last soldier who could take the flag. Largo and
      // Marina still standing is not a win path. See NO_CAPTURERS.
      if (this.capturersStanding(0) > 0) { this._sawCapturers = true; this._noCapT = 0; }
      else if (!this.over && this.captureLost()) {
        if (this._noCapT === 0) {
          // Not "all down" — evacuating a casualty clears `deployed` too, so this fires just
          // as readily when you rescued your last scout as when he bled out, and blaming the
          // player for a death that did not happen reads as a bug.
          Bus.emit('ui:alert', {
            text: 'NO ONE LEFT TO TAKE THE FLAG',
            sub: 'no scout, trooper or engineer left on the field',
          });
        }
        this._noCapT += dt;
        if (this._noCapT >= WIPE_GRACE) this.finish(false, NO_CAPTURERS);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Imperial-phase pacing
  // -------------------------------------------------------------------------

  /**
   * How much simulation the Imperial phase is worth THIS frame.
   *
   * The old answer was "one frame, always", and it cost 36-53 s of wall clock per turn with
   * the player watching an empty rooftop for nine tenths of it. The new answer:
   *
   *   - a soldier the player can actually see (spotted through the fog AND inside the frame)
   *     moves at 1x, because that is the part of the turn worth showing;
   *   - everything else runs ENEMY_PACE.fast sim-frames per rendered frame;
   *   - past `press` seconds even watched soldiers compress, past `budget` everything runs
   *     at flush speed, and past `hard` the turn is drained and handed back (drainEnemyTurn).
   *
   * @returns {{steps:number, sub:number}} run `steps` sub-steps of `sub` seconds.
   */
  paceEnemy(dt, gdt) {
    const P = ENEMY_PACE;
    this._enemyT += dt;

    // Publish the acting soldier for the camera. ai.js sets battle.aiFocus when it activates
    // a unit but nothing ever cleared it; owning it here means a follow camera can trust it.
    const actor = this.ai?.actor || null;
    if (actor !== this._aiActor) {
      this._aiActor = actor;
      this.aiFocus = actor;
      if (actor) {
        Bus.emit('enemy:focus', {
          unit: actor, pos: actor.pos, watchable: this.watchable(actor), elapsed: this._enemyT,
        });
      }
    }

    let rate = this.watchable(actor) ? 1 : P.fast;
    if (this._enemyT > P.budget) rate = P.flush;
    else if (this._enemyT > P.press) rate = Math.max(rate, 1 + (this._enemyT - P.press) * 2.2);

    const sub = 1 / 60;
    const steps = clamp(Math.ceil((gdt * rate) / sub), 1, 120);
    return { steps, sub };
  }

  /**
   * Is this soldier worth animating in real time? Only if the player can see it: spotted
   * through the fog AND inside the frame. A soldier behind the camera or forty metres off
   * the edge of it is not worth a second of anybody's turn.
   */
  watchable(u) {
    if (!u || !u.active) return false;
    if (u.team === 0) return true;                       // never fast-forward the player's own
    if (!u.spotted) return false;
    const cam = this.camera;
    if (!cam) return true;
    _ndc.set(u.pos.x, u.pos.y + 1.1, u.pos.z).project(cam);
    return _ndc.z > 0 && _ndc.z < 1 && Math.abs(_ndc.x) < 1.2 && Math.abs(_ndc.y) < 1.2;
  }

  /**
   * The hard cap. Whatever the Imperials still meant to do is resolved as fast as the CPU
   * will resolve it, inside a per-frame compute budget so the drain costs a few frames
   * rather than freezing. If it still has not finished, the turn is simply over — an
   * unfinished Imperial plan is cheaper than a player staring at a rooftop.
   */
  drainEnemyTurn(sub) {
    const t0 = _now();
    let n = 0;
    while (this.ai.running && this.phase === 'enemy' && n < 6000 && _now() - t0 < ENEMY_PACE.drainMs) {
      this.ai.update(sub);
      this.interception.update(sub);
      this.actionMode?.updateGrenades(sub);
      n++;
    }
    if (this._enemyT > ENEMY_PACE.hard + 1.5 && this.phase === 'enemy' && !this.over) {
      this.ai.abort();
      Bus.emit('ai:end', { team: this.team, reason: 'timeCap' });
      this.endTurn();
    }
  }

  /**
   * A round that cracked past somebody. `shot:hit` carries the impact point of every traced
   * round in the game, and one that lands within a stride of a hostile rattles him: a little
   * suppression, held briefly, capped well below what a real hit gives (units.js: 0.34).
   *
   * This exists so that FIRING AT the gun covering the bridge is worth a Command Point even
   * on the shots that miss. Without it the counterplay in interception.js only pays out on a
   * hit, and at 40 m that is a coin flip — which is not a decision, it is a gamble.
   */
  onNearMiss(p) {
    if (!p || p.unit || !p.shooter || !p.point) return;   // a hit is takeDamage's business
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.active || u.team === p.shooter.team || u.isVehicle) continue;
      const dx = u.pos.x - p.point.x, dz = u.pos.z - p.point.z;
      if (dx * dx + dz * dz > NEAR_MISS_R2) continue;
      const dy = p.point.y - u.pos.y;
      if (dy < -0.6 || dy > 2.6) continue;
      u.applySuppression(NEAR_MISS_SUP, 2.0, NEAR_MISS_CAP);
    }
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
    this._offShotHit?.();
    this._offShotHit = null;
    // The World outlives the Battle (probes and the shot harness build several against one
    // world), so a vehicle collider left in the grid would keep blocking bodies forever.
    for (const { col } of this._vehicleColliders || []) {
      this.world?.grid?.remove?.(col);
      const i = this.world?.colliders?.indexOf(col) ?? -1;
      if (i >= 0) this.world.colliders.splice(i, 1);
    }
    this._vehicleColliders = null;
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

const _ndc = new THREE.Vector3();

/**
 * One line of live objective text for a camp the player is trying to take. This is the text
 * that tells a player what the game is actually asking of them; "Capture the Imperial base
 * camp" did not, because it never said where to stand or what was blocking it.
 */
function campObjectiveLabel(c, done) {
  const r = c.ring || { mine: 0, theirs: 0, capMine: 0 };
  if (done) return `${c.name} secured`;
  if (c.contested) return `Clear ${r.theirs} Imperial${r.theirs === 1 ? '' : 's'} off their flag`;
  if (r.capMine > 0) return 'Hold their flag — camp falling';
  return 'Stand on their flag: Scout, Trooper or Engineer';
}

function weightOf(u) {
  return u.isVehicle ? 100 : { lancer: 40, shock: 35, scout: 30, engineer: 20, sniper: 10 }[u.cls] || 15;
}
function rankMul(r) { return r === 'A' ? 1.5 : r === 'B' ? 1.2 : r === 'C' ? 1.0 : 0.7; }

export default Battle;
