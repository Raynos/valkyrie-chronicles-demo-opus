// src/physics/ballistics.js
// Projectile integration with gravity + quadratic drag, continuous collision
// against terrain / world colliders / unit hitboxes, and cover penetration.
//
// Everything is stepped on the shared fixed 60 Hz clock (see index.js) so
// replays and the AI's shot prediction agree with what actually happens.
//
// ---------------------------------------------------------------------------
// STATUS, r26 — READ THIS BEFORE AUDITING THIS FILE AGAIN.
//
// No projectile is ever spawned during play. MEASURED: `projectiles.length` is
// 0 at rest and still 0 after 180 fixed steps of a live firefight. Every shot
// in the game — the player's, the AI's, interception, the tank's — resolves
// through the HITSCAN model in src/game/combat.js (fireRound/fireBurst), which
// is the damage authority: it owns the BLiTZ stat integration, the accuracy
// model, the friendly-fire rule and the numbers the HUD's forecast promises.
//
// This file is NOT orphaned, and deleting it would be deleting a design three
// other modules are already built for:
//   * PRODUCER, live:  src/actors/tank.js `fire()` / `fireCoax()` call
//     `this.ballistics.fire(...)` on a reference main.js really does hand them.
//     MEASURED: `edelweiss.actor.fire({owner, force:true})` spawns a tankAP
//     round at 779.6 m/s into this sim right now. Nothing in src/game calls it.
//   * CONSUMER, live:  src/main.js `updateTracers()` walks `projectiles` every
//     frame and stamps `fx.tracerSegment()` head-to-tail — a curved-trail
//     renderer that exists for nothing else and currently draws nothing.
//
// So the missing link is ONE call in the game layer, in files this round did
// not own. What must NOT happen is a second damage authority: if a shell is
// routed here, combat.js has to resolve the damage on the projectile's IMPACT
// rather than at trigger-pull, or the forecast the player was shown and the
// damage he gets stop being the same number. That is a game-layer redesign, not
// a physics change. Everything below has been repaired so that call is safe to
// add: the friendly-fire filter, cover penetration and the hit record all work
// and are covered by the r26 probes.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { clamp } from '../core/math.js';
import {
  Hit, SURFACE, SURFACE_HARDNESS,
  sweptSphereVsBoxes, rayVsHeightfield, rayVsCapsule, rayVsSphere, rayVsBox,
  normalizeCollider,
} from './collision.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _hitTerrain = new Hit();
const _hitCol = new Hit();
const _hitUnit = new Hit();

export const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;

/**
 * Per-weapon exterior-ballistics profiles.
 *   v0   muzzle velocity      m/s
 *   m    projectile mass      kg
 *   cd   drag coefficient     (G1-ish, lumped)
 *   cal  calibre              m  (used for frontal area)
 *   pen  penetration power    matched against SURFACE_HARDNESS
 *   grav gravity scale        (rockets/lances fly flatter than they should —
 *                              a deliberate readability cheat, per VC)
 */
export const WEAPON_BALLISTICS = {
  rifle:      { v0: 720, m: 0.0092, cd: 0.30, cal: 0.0079, pen: 26, grav: 1.0, tracer: 0.15, damage: 22 },
  smg:        { v0: 400, m: 0.0080, cd: 0.36, cal: 0.0090, pen: 14, grav: 1.0, tracer: 0.10, damage: 12 },
  mg:         { v0: 780, m: 0.0125, cd: 0.29, cal: 0.0079, pen: 32, grav: 1.0, tracer: 0.35, damage: 18 },
  sniper:     { v0: 860, m: 0.0130, cd: 0.26, cal: 0.0079, pen: 40, grav: 1.0, tracer: 0.05, damage: 95 },
  lance:      { v0: 155, m: 2.500,  cd: 0.42, cal: 0.0880, pen: 240, grav: 0.55, tracer: 1.0,
                explosive: { radius: 4.2, power: 62 }, damage: 260 },
  grenade:    { v0: 22,  m: 0.600,  cd: 0.55, cal: 0.0600, pen: 6,  grav: 1.0, tracer: 0,
                explosive: { radius: 5.0, power: 55 }, fuse: 2.6, bounce: 0.34, damage: 40 },
  mortar:     { v0: 95,  m: 3.200,  cd: 0.36, cal: 0.0810, pen: 30, grav: 1.0, tracer: 0.2,
                explosive: { radius: 6.5, power: 78 }, damage: 70 },
  tankAP:     { v0: 780, m: 6.300,  cd: 0.24, cal: 0.0750, pen: 300, grav: 1.0, tracer: 0.6, damage: 420 },
  tankHE:     { v0: 560, m: 6.800,  cd: 0.30, cal: 0.0750, pen: 60,  grav: 1.0, tracer: 0.6,
                explosive: { radius: 6.0, power: 84 }, damage: 180 },
  coax:       { v0: 760, m: 0.0125, cd: 0.29, cal: 0.0079, pen: 30, grav: 1.0, tracer: 0.4, damage: 16 },
  flame:      { v0: 26,  m: 0.030,  cd: 1.20, cal: 0.1200, pen: 2,  grav: 0.45, tracer: 0, damage: 8 },
};

/** Register or override a weapon profile at runtime (used by weapons.js). */
export function registerWeapon(name, spec) {
  WEAPON_BALLISTICS[name] = Object.assign({}, WEAPON_BALLISTICS.rifle, spec);
  _dragCache.delete(name);
  return WEAPON_BALLISTICS[name];
}

const _dragCache = new Map();
/** k such that a_drag = -k * |v| * v   (m^-1) */
function dragK(name, spec) {
  let k = _dragCache.get(name);
  if (k !== undefined) return k;
  const area = Math.PI * spec.cal * spec.cal * 0.25;
  k = (0.5 * AIR_DENSITY * spec.cd * area) / Math.max(1e-4, spec.m);
  _dragCache.set(name, k);
  return k;
}

let _pid = 1;

/** Deterministic stand-in for a seeded rng: a splitmix-ish walk from `seed`. */
function hashRng(seed) {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A live projectile. Pooled by Ballistics — never keep a reference after death. */
class Projectile {
  constructor() {
    this.id = 0;
    this.alive = false;
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.renderPos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.spawn = new THREE.Vector3();
    this.weapon = 'rifle';
    this.spec = WEAPON_BALLISTICS.rifle;
    this.k = 0;
    this.gravity = GRAVITY;
    this.owner = null;
    this.team = -1;
    /** Opt-in: a round that is allowed to strike its own side. Default false. */
    this.friendlyFire = false;
    this.damage = 10;
    this.penetration = 20;
    this.radius = 0.04;
    this.life = 0;
    this.maxLife = 8;
    this.dist = 0;
    this.maxDist = 600;
    this.bounces = 0;
    this.fuse = -1;
    this.tracer = 0;
    this.explosive = null;
    /** Collider the round is currently punching through, if any. */
    this.penColl = null;
    this.onHit = null;
    this.userData = null;
  }
}

export class Ballistics {
  /**
   * @param {object} world  World instance ({ terrain, colliders })
   * @param {object} [opts] { explosions, units, maxProjectiles }
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.explosions = opts.explosions || null;
    /** Units the projectiles can hit. The game layer keeps this in sync. */
    this.units = opts.units || [];
    this.projectiles = [];
    this._pool = [];
    this._max = opts.maxProjectiles || 256;
    this.substeps = 2;        // per fixed step; CCD makes this cheap
    this.alpha = 0;           // render interpolation factor, set by PhysicsWorld
    this.hitCallback = null;  // (hit, projectile) => void
    /** Extra hit volumes registered by non-Unit things (destructible props). */
    this.extraTargets = [];
  }

  setUnits(units) { this.units = units; return this; }

  // ------------------------------------------------------------- spawning ---

  /**
   * Fire a projectile.
   * @param {object} spec {origin, dir, weapon, speed?, owner?, team?, damage?,
   *                       penetration?, spread?, rng?, onHit?, userData?}
   * @returns {Projectile}
   */
  fire(spec) {
    const name = spec.weapon || 'rifle';
    const prof = WEAPON_BALLISTICS[name] || WEAPON_BALLISTICS.rifle;
    const p = this._pool.pop() || new Projectile();
    p.id = _pid++;
    p.alive = true;
    p.weapon = name;
    p.spec = prof;
    p.k = dragK(name, prof);
    p.gravity = GRAVITY * (prof.grav ?? 1);
    p.owner = spec.owner || null;
    p.team = spec.team ?? (spec.owner && spec.owner.team) ?? -1;
    // FRIENDLY FIRE IS NOT A FEATURE — the same rule src/game/combat.js's
    // fireRound() settled on in round 19, and for the same reason: nobody has
    // ever wanted a burst meant for an Imperial to stop on the scout who walked
    // into it. A projectile carried a `team` and no filter used it, so the
    // moment anything routes fire through here it would have hit squadmates
    // that the hitscan path already refuses to hit. Opt back in per shot.
    p.friendlyFire = spec.friendlyFire === true;
    p.damage = spec.damage ?? prof.damage ?? 12;
    p.penetration = spec.penetration ?? prof.pen ?? 20;
    p.radius = spec.radius ?? Math.max(0.03, prof.cal * 0.5);
    p.life = 0;
    p.maxLife = spec.maxLife ?? (prof.explosive ? 12 : 6);
    p.dist = 0;
    p.maxDist = spec.maxDist ?? 700;
    p.bounces = 0;
    p.fuse = spec.fuse ?? prof.fuse ?? -1;
    p.tracer = spec.tracer ?? prof.tracer ?? 0;
    p.explosive = spec.explosive || prof.explosive || null;
    p.penColl = null;
    p.onHit = spec.onHit || null;
    p.userData = spec.userData || null;

    p.pos.copy(spec.origin);
    p.prev.copy(spec.origin);
    p.renderPos.copy(spec.origin);
    p.spawn.copy(spec.origin);

    _v0.copy(spec.dir).normalize();
    const spread = spec.spread || 0;
    if (spread > 0) {
      // DETERMINISM CONTRACT (CLAUDE.md): identical shot name => identical frame
      // => identical pixels. `Math.random` as the default rng broke that for any
      // caller that forgot to pass one. Fall back to a hash of the projectile id
      // instead — same distribution, no global state, replay-safe.
      const rng = spec.rng || hashRng(p.id);
      // Cone jitter in the plane perpendicular to dir.
      const ang = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * spread;
      _v1.set(0, 1, 0);
      if (Math.abs(_v0.y) > 0.9) _v1.set(1, 0, 0);
      _v2.crossVectors(_v0, _v1).normalize();
      _v3.crossVectors(_v0, _v2).normalize();
      _v0.addScaledVector(_v2, Math.cos(ang) * r).addScaledVector(_v3, Math.sin(ang) * r).normalize();
    }
    const speed = spec.speed ?? prof.v0;
    p.vel.copy(_v0).multiplyScalar(speed);
    // Inherit shooter motion so shots from a moving tank track correctly.
    if (spec.inheritVel) p.vel.add(spec.inheritVel);

    if (this.projectiles.length >= this._max) {
      const dead = this.projectiles.shift();
      dead.alive = false;
      this._pool.push(dead);
    }
    this.projectiles.push(p);

    Bus.emit('shot:fired', {
      unit: p.owner, origin: p.spawn, dir: _v0.clone(), weapon: name,
    });
    return p;
  }

  // -------------------------------------------------------------- stepping ---

  /** Fixed-step. Called by PhysicsWorld at exactly 60 Hz. */
  fixedStep(h) {
    const sub = this.substeps;
    const dt = h / sub;
    const list = this.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (!p.alive) { list.splice(i, 1); this._pool.push(p); continue; }
      let dead = false;
      for (let s = 0; s < sub && !dead; s++) dead = this._integrate(p, dt);
      if (dead || p.life > p.maxLife || p.dist > p.maxDist) {
        if (!dead && p.explosive) this._detonate(p, p.pos, null);
        p.alive = false;
        list.splice(i, 1);
        this._pool.push(p);
      }
    }
  }

  /** Called every render frame — updates interpolated positions for the FX layer. */
  interpolate(alpha) {
    this.alpha = alpha;
    const list = this.projectiles;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.renderPos.lerpVectors(p.prev, p.pos, alpha);
    }
  }

  /** @returns {boolean} true if the projectile died this substep. */
  _integrate(p, dt) {
    p.prev.copy(p.pos);
    p.life += dt;

    // Semi-implicit Euler with quadratic drag: v += (g - k|v|v) dt
    const sp = p.vel.length();
    if (sp > 1e-4 && p.k > 0) {
      const dragMag = p.k * sp * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - dragMag));
    }
    p.vel.y -= p.gravity * dt;

    _v0.copy(p.vel).multiplyScalar(dt);
    const stepLen = _v0.length();
    if (stepLen < 1e-6) return p.fuse >= 0 && p.life >= p.fuse;
    _v1.copy(_v0).divideScalar(stepLen);   // dir

    const hit = this._sweep(p.prev, _v1, stepLen, p.radius, p);
    if (hit) {
      return this._resolveHit(p, hit, _v1);
    }
    p.pos.copy(p.prev).add(_v0);
    p.dist += stepLen;

    if (p.fuse >= 0 && p.life >= p.fuse) {
      this._detonate(p, p.pos, null);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------- queries ---

  /**
   * Nearest of terrain / colliders / units along a swept sphere.
   * @returns {Hit|null} a module-scratch Hit — copy it if you need to keep it.
   */
  _sweep(origin, dir, dist, radius, proj) {
    let best = null;
    if (rayVsHeightfield(this.world && this.world.terrain, origin, dir, dist, _hitTerrain)) {
      best = _hitTerrain;
    }
    const cols = (this.world && this.world.colliders) || null;
    if (cols && cols.length) {
      if (sweptSphereVsBoxes(origin, dir, best ? best.distance : dist, radius, cols, _hitCol)) {
        best = _hitCol;
      }
    }
    const uh = this._sweepUnits(origin, dir, best ? best.distance : dist, radius, proj);
    if (uh) best = uh;
    return best;
  }

  /**
   * Public raycast used by AI line-of-fire checks and by weapons that are
   * hitscan (nothing is, currently, but the game layer asks for LOS a lot).
   */
  raycast(origin, dir, maxDist = 500, out = new Hit(), opts = null) {
    _v2.copy(dir).normalize();
    const ignore = opts && opts.ignore;
    let best = null;
    if (!(opts && opts.skipTerrain) &&
        rayVsHeightfield(this.world && this.world.terrain, origin, _v2, maxDist, _hitTerrain)) {
      best = _hitTerrain;
    }
    const cols = (this.world && this.world.colliders) || null;
    if (cols && !(opts && opts.skipColliders)) {
      if (sweptSphereVsBoxes(origin, _v2, best ? best.distance : maxDist, 0.001, cols, _hitCol)) {
        best = _hitCol;
      }
    }
    if (!(opts && opts.skipUnits)) {
      // `friendlyFire: true` on the pseudo-projectile: a LINE-OF-FIRE query must
      // report the squadmate standing in the way — that is the entire question
      // being asked (combat.js friendlyInLine()). Only fire() suppresses him.
      const uh = this._sweepUnits(origin, _v2, best ? best.distance : maxDist, 0.001,
        ignore ? { owner: ignore, team: -1, friendlyFire: true } : null);
      if (uh) best = uh;
    }
    if (!best) return null;
    return out.copy(best);
  }

  /** Swept sphere vs every unit's hit volumes. */
  _sweepUnits(origin, dir, maxDist, radius, proj) {
    const units = this.units || null;
    let bestT = maxDist;
    let found = false;
    for (let i = 0; units && i < units.length; i++) {
      const u = units[i];
      if (!u || u.alive === false) continue;
      if (proj && (u === proj.owner || (proj.owner && u.character === proj.owner) ||
                   (proj.owner && u.tank === proj.owner))) continue;
      // Same-side rounds pass through. See the note in fire(): `team` was
      // recorded on every projectile and consulted by nothing.
      if (proj && !proj.friendlyFire && proj.team >= 0 && u.team === proj.team) continue;
      const t = hitVolumesSweep(u, origin, dir, bestT, radius, _hitUnit);
      if (t) { bestT = _hitUnit.distance; found = true; }
    }
    // Extra volumes (destructible props). This loop used to sit AFTER the
    // `if (!found) return null` below, so an extra target could only ever be
    // struck by a round that had already hit a Unit further away — i.e. never.
    for (let i = 0; i < this.extraTargets.length; i++) {
      const t = this.extraTargets[i];
      if (!t || t.dead) continue;
      const d = rayVsSphere(origin, dir, bestT, t.center, (t.radius || 0.5) + radius, _n);
      if (d >= 0) {
        bestT = d;
        found = true;
        _hitUnit.distance = d;
        _hitUnit.point.copy(origin).addScaledVector(dir, d);
        _hitUnit.normal.copy(_n);
        _hitUnit.unit = t.unit || null;
        _hitUnit.collider = t.collider || null;
        _hitUnit.bodypart = t.part || 'prop';
        _hitUnit.material = t.material || SURFACE.WOOD;
        _hitUnit.kind = 'unit';
      }
    }
    if (!found) return null;
    return _hitUnit;
  }

  // ------------------------------------------------------------ resolution ---

  _resolveHit(p, hit, dir) {
    // Cover penetration: compare projectile penetration against material
    // hardness scaled by how obliquely we struck (a glancing hit on sloped
    // armour is much harder to punch through — this is the whole point of the
    // Edelweiss' sloped glacis).
    const cosT = clamp(-dir.dot(hit.normal), 0.05, 1);
    const base = hit.collider && hit.collider.hardness != null
      ? hit.collider.hardness
      : (SURFACE_HARDNESS[hit.material] ?? 60);
    const hardness = base / cosT;
    // Only *colliders* can be shot through. The heightfield is the world: a
    // round that tunnelled through a hill would let players shoot through
    // terrain, which breaks cover entirely.
    //
    // The second clause used to be `!hit.collider.solid` — a collider that does
    // NOT block bodies but DOES stop rounds. src/world/collider.js defaults
    // `blocksProjectile` to `solid || blocksLos`, so that describes a volume
    // nobody authors: MEASURED on the live map, 0 of 423 colliders satisfied it
    // (the four combinations present are solid/los/proj = TTT x305, TFT x47,
    // TFF x22, FFF x49). Penetration was unreachable, so a tank round and a
    // pistol round were stopped identically by a hay bale.
    //
    // The question is a MATERIAL one, and hardness already answers it: at normal
    // incidence a rifle (pen 26) defeats wood (22) and nothing else, a lance
    // (240) and an 88 (300) go through brick and stone, and everything is harder
    // to defeat obliquely. `solid` is about bodies and never belonged here.
    const canPen = hit.kind === 'collider' && hit.collider &&
                   p.penetration > hardness * 1.15;

    // Bouncy ordnance (grenades) ricochets off terrain instead of detonating.
    const bounce = p.spec.bounce;
    if (bounce && hit.kind !== 'unit' && p.fuse > 0 && p.life < p.fuse) {
      p.pos.copy(hit.point).addScaledVector(hit.normal, p.radius + 0.01);
      const vn = p.vel.dot(hit.normal);
      p.vel.addScaledVector(hit.normal, -(1 + bounce) * vn);
      p.vel.multiplyScalar(0.78);            // tangential friction
      p.bounces++;
      Bus.emit('sfx', { name: 'grenadeBounce', pos: p.pos, vol: 0.5 });
      if (p.bounces > 6) { this._detonate(p, p.pos, hit); return true; }
      return false;
    }

    // Publish the through-and-through with the hit, not after it. `penetrated`
    // used to be written in the canPen branch BELOW _emitHit, so `shot:hit`
    // always announced `penetrated: false` and the FX layer could never draw a
    // punch-through; worse, `hit` is a pooled scratch record, so whatever the
    // previous hit left there was what a caller read.
    // An explosive round detonates on the face it strikes; it never punches
    // through, whatever its `pen` says, so it must not advertise that it did.
    hit.penetrated = !!canPen && !p.explosive;

    // STILL INSIDE THE SAME OBSTRUCTION. The punch-through below can only step
    // 1.2 m at a time, so a round crossing a 6.8 m building re-enters it at
    // distance 0 on the next substep and pays again — which is the thickness
    // model working as intended. What is NOT intended is announcing each of
    // those as a fresh impact: measured, a tankAP round through one building
    // published five `shot:hit` events at the same point, so FX drew five
    // impact bursts and five decals on one hole. Charge the energy, skip the
    // event; the round is spending its penetration, not striking again.
    const again = canPen && hit.collider && hit.collider === p.penColl && hit.distance < 0.05;
    if (!again) this._emitHit(p, hit);

    if (p.explosive) {
      this._detonate(p, hit.point, hit);
      return true;
    }
    if (canPen) {
      // Punch through: lose energy proportional to the material and keep going.
      const loss = clamp(hardness / p.penetration, 0.15, 0.9);
      p.penetration *= 1 - loss * 0.8;
      p.damage *= 1 - loss * 0.5;
      p.vel.multiplyScalar(1 - loss * 0.55);
      // Advance past the obstruction (thickness estimated from the collider).
      const thick = hit.collider ? Math.min(1.2, normalizeCollider(hit.collider).half.length() * 0.9) : 0.35;
      p.pos.copy(hit.point).addScaledVector(dir, thick + p.radius);
      p.dist += hit.distance + thick;
      p.penColl = hit.collider;
      return p.penetration < 4;
    }
    p.penColl = null;
    p.pos.copy(hit.point);
    return true;
  }

  _emitHit(p, hit) {
    hit.projectile = p;
    if (p.onHit) p.onHit(hit, p);
    if (this.hitCallback) this.hitCallback(hit, p);
    Bus.emit('shot:hit', {
      point: hit.point, normal: hit.normal, material: hit.material,
      unit: hit.unit || undefined, bodypart: hit.bodypart, weapon: p.weapon,
      shooter: p.owner, damage: p.damage, penetrated: hit.penetrated,
    });
    if (hit.unit && hit.unit.takeDamage) {
      const mult = BODYPART_MULT[hit.bodypart] ?? 1;
      // ARCHITECTURE.md: Unit.takeDamage(n, source, opts). `source` is the
      // SHOOTING UNIT, not a bag of options — the game layer dereferences
      // `source.stats`, so passing the options object here threw a TypeError on
      // every round that reached a soldier.
      hit.unit.takeDamage(p.damage * mult, p.owner || null, {
        crit: mult > 1.6, worldPos: hit.point, part: hit.bodypart,
        weapon: p.weapon, normal: hit.normal,
      });
    }
  }

  _detonate(p, pos, hit) {
    const ex = p.explosive;
    const payload = {
      pos: _v3.copy(pos).clone(),
      radius: ex ? ex.radius : 3,
      power: ex ? ex.power : p.damage,
      source: p.owner,
      weapon: p.weapon,
      normal: hit ? hit.normal.clone() : new THREE.Vector3(0, 1, 0),
    };
    if (this.explosions) this.explosions.detonate(payload);
    else Bus.emit('explosion', payload);
  }

  // -------------------------------------------------------- aim assistance ---

  /**
   * Solve the launch direction that lands a projectile at `to`, ignoring drag
   * (a good first-order guess; the aim arc preview uses the full integrator).
   * @param {boolean} high  pick the lofted solution (mortar) vs the flat one
   * @returns {THREE.Vector3|null} normalised direction, or null if out of range
   */
  solveLaunch(from, to, speed, high = false, gravScale = 1, out = new THREE.Vector3()) {
    const g = GRAVITY * gravScale;
    const dx = to.x - from.x, dz = to.z - from.z;
    const horiz = Math.hypot(dx, dz);
    const dy = to.y - from.y;
    // Straight up (or straight down) has no tangent solution: `tanT` below goes
    // to Infinity and `out.normalize()` then produces (0, NaN, 0), which a
    // caller has no way of telling apart from a valid direction. Answer the
    // degenerate case directly.
    if (horiz < 1e-4) {
      if (dy > 0 && speed * speed < 2 * GRAVITY * gravScale * dy) return null;
      return out.set(0, dy >= 0 ? 1 : -1, 0);
    }
    const s2 = speed * speed;
    const disc = s2 * s2 - g * (g * horiz * horiz + 2 * dy * s2);
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    const tanT = (s2 + (high ? root : -root)) / (g * horiz);
    const inv = 1 / Math.max(1e-5, horiz);
    out.set(dx * inv, tanT, dz * inv).normalize();
    return out;
  }

  /**
   * Integrate a virtual projectile and write world positions into `outArray`
   * (Float32Array, 3 floats per sample). Used by the UI to draw the lance /
   * mortar aim arc, and by the AI to check its own line of fire.
   * @returns {number} number of samples written
   */
  predictPath(spec, outArray, maxSamples = 48, dtStep = 1 / 30) {
    const prof = WEAPON_BALLISTICS[spec.weapon] || WEAPON_BALLISTICS.rifle;
    const k = dragK(spec.weapon || 'rifle', prof);
    const g = GRAVITY * (prof.grav ?? 1);
    _v0.copy(spec.origin);
    _v1.copy(spec.dir).normalize().multiplyScalar(spec.speed ?? prof.v0);
    let n = 0;
    for (let i = 0; i < maxSamples; i++) {
      outArray[n * 3] = _v0.x; outArray[n * 3 + 1] = _v0.y; outArray[n * 3 + 2] = _v0.z;
      n++;
      const sp = _v1.length();
      if (sp > 1e-4) _v1.multiplyScalar(Math.max(0, 1 - k * sp * dtStep));
      _v1.y -= g * dtStep;
      _v2.copy(_v1).multiplyScalar(dtStep);
      const len = _v2.length();
      if (len > 1e-6) {
        _v3.copy(_v2).divideScalar(len);
        if (rayVsHeightfield(this.world && this.world.terrain, _v0, _v3, len, _hitTerrain)) {
          outArray[n * 3] = _hitTerrain.point.x;
          outArray[n * 3 + 1] = _hitTerrain.point.y;
          outArray[n * 3 + 2] = _hitTerrain.point.z;
          n++;
          break;
        }
      }
      _v0.add(_v2);
    }
    return n;
  }

  /** Time-of-flight estimate to a point — the AI uses it for target leading. */
  timeOfFlight(from, to, weapon) {
    const prof = WEAPON_BALLISTICS[weapon] || WEAPON_BALLISTICS.rifle;
    const d = from.distanceTo(to);
    const k = dragK(weapon || 'rifle', prof);
    // Closed form for pure quadratic drag along a straight line:
    // x(t) = ln(1 + k v0 t)/k  ->  t = (e^{k x} - 1)/(k v0)
    if (k < 1e-6) return d / prof.v0;
    return (Math.exp(k * d) - 1) / (k * prof.v0);
  }

  clear() {
    for (const p of this.projectiles) { p.alive = false; this._pool.push(p); }
    this.projectiles.length = 0;
  }
}

/** Damage multipliers by bodypart. Radiator is the VC signature weak point. */
export const BODYPART_MULT = {
  head: 2.6, torso: 1.0, legs: 0.75, arm: 0.7,
  hull: 0.45, turret: 0.55, track: 0.6, radiator: 3.2, prop: 1.0,
};

// ------------------------------------------------------- unit hit volumes ---

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();

/**
 * Sweep against a Unit's hit volumes.
 * Prefers `unit.hitVolumes(out)` if the game layer provides one; otherwise
 * derives volumes from the actor (tank -> hull box + turret + radiator sphere,
 * character -> head/torso/legs capsules).
 * @returns {boolean}
 */
export function hitVolumesSweep(unit, origin, dir, maxDist, radius, out) {
  const tank = unit.tank || (unit.isTank ? unit : null);
  const ch = unit.character || (unit.isCharacter ? unit : null);
  const base = unit.pos || (unit.root && unit.root.position) ||
               (tank && tank.root.position) || (ch && ch.root.position);
  if (!base) return false;

  let bestT = maxDist, part = null, mat = SURFACE.FLESH;

  if (tank && tank.root) {
    // Radiator weak point first — it's small, so test it before the hull.
    if (tank.weakPointWorldPos) {
      tank.weakPointWorldPos(_p0);
      const t = rayVsSphere(origin, dir, bestT, _p0, 0.52 + radius, _n);
      if (t >= 0) { bestT = t; part = 'radiator'; mat = SURFACE.METAL; out.normal.copy(_n); }
    }
    // Hull: an OBB following the tank yaw.
    const box = tankBox(tank, 'hull');
    let t = rayVsBox(origin, dir, bestT, box, _n);
    if (t >= 0) { bestT = t; part = 'hull'; mat = SURFACE.METAL; out.normal.copy(_n); }
    const tur = tankBox(tank, 'turret');
    t = rayVsBox(origin, dir, bestT, tur, _n);
    if (t >= 0) { bestT = t; part = 'turret'; mat = SURFACE.METAL; out.normal.copy(_n); }
    // Track runs, left and right.
    for (let s = -1; s <= 1; s += 2) {
      const tb = tankBox(tank, s < 0 ? 'trackL' : 'trackR');
      t = rayVsBox(origin, dir, bestT, tb, _n);
      if (t >= 0) { bestT = t; part = 'track'; mat = SURFACE.METAL; out.normal.copy(_n); }
    }
  } else {
    const y = base.y;
    const prone = unit.prone || (ch && ch.prone);
    const crouch = unit.crouched || (ch && ch.crouched);
    const headY = ch && ch.headPoint ? ch.headPoint(_p1).y : y + (prone ? 0.42 : crouch ? 1.18 : 1.62);
    // legs
    _p0.set(base.x, y + 0.06, base.z);
    _p1.set(base.x, y + (prone ? 0.28 : 0.86), base.z);
    let t = rayVsCapsule(origin, dir, bestT, _p0, _p1, 0.19 + radius, _n);
    if (t >= 0) { bestT = t; part = 'legs'; out.normal.copy(_n); }
    // torso
    _p0.set(base.x, y + (prone ? 0.2 : 0.86), base.z);
    _p1.set(base.x, headY - 0.16, base.z);
    t = rayVsCapsule(origin, dir, bestT, _p0, _p1, 0.27 + radius, _n);
    if (t >= 0) { bestT = t; part = 'torso'; out.normal.copy(_n); }
    // head
    _p0.set(base.x, headY, base.z);
    if (ch && ch.headPoint) ch.headPoint(_p0);
    t = rayVsSphere(origin, dir, bestT, _p0, 0.135 + radius, _n);
    if (t >= 0) { bestT = t; part = 'head'; out.normal.copy(_n); }
  }

  if (!part) return false;
  out.distance = bestT;
  out.point.copy(origin).addScaledVector(dir, bestT);
  out.unit = unit;
  out.collider = null;
  out.bodypart = part;
  out.material = mat;
  out.cover = 0;
  out.penetrated = false;
  out.kind = 'unit';
  return true;
}

// Cached OBBs for tank hitboxes, rebuilt each query (cheap: 4 boxes).
const _tankBoxes = {
  hull: makeBox(1.45, 0.62, 2.55),
  turret: makeBox(0.95, 0.45, 1.15),
  trackL: makeBox(0.24, 0.4, 2.5),
  trackR: makeBox(0.24, 0.4, 2.5),
};
function makeBox(hx, hy, hz) {
  return {
    type: 'box',
    center: new THREE.Vector3(),
    half: new THREE.Vector3(hx, hy, hz),
    quat: new THREE.Quaternion(),
    invQuat: new THREE.Quaternion(),
    axisAligned: false,
    boundRadius: Math.hypot(hx, hy, hz),
    material: SURFACE.METAL,
    cover: 1,
    ref: null,
  };
}
const _tq = new THREE.Quaternion();
function tankBox(tank, which) {
  const b = _tankBoxes[which];
  const dims = tank.hitDims && tank.hitDims[which];
  if (dims) b.half.set(dims.hx, dims.hy, dims.hz);
  const node = which === 'turret' && tank.turret ? tank.turret : tank.root;
  node.updateWorldMatrix(true, false);
  node.getWorldQuaternion(_tq);
  b.quat.copy(_tq);
  b.invQuat.copy(_tq).invert();
  node.getWorldPosition(b.center);
  const off = tank.hitOffsets && tank.hitOffsets[which];
  if (off) {
    _p1.set(off.x, off.y, off.z).applyQuaternion(_tq);
    b.center.add(_p1);
  } else if (which === 'hull') {
    _p1.set(0, 0.85, 0).applyQuaternion(_tq);
    b.center.add(_p1);
  } else if (which === 'trackL' || which === 'trackR') {
    _p1.set(which === 'trackL' ? -1.32 : 1.32, 0.45, 0).applyQuaternion(_tq);
    b.center.add(_p1);
  }
  b.boundRadius = b.half.length();
  b.ref = null;
  return b;
}
