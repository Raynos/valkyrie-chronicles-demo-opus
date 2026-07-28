// src/physics/explosions.js
// Spherical damage with distance falloff and line-of-sight occlusion, impulse
// application to nearby rigid bodies, and an expanding shockwave the FX layer
// can query for screen distortion / dust rings / camera shake.

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { clamp, smoothstep } from '../core/math.js';
import { lineOfSight, normalizeCollider } from './collision.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _target = new THREE.Vector3();

/** One live blast wave. Pooled. */
class Wave {
  constructor() {
    this.pos = new THREE.Vector3();
    this.t = 0;
    this.life = 1.2;
    this.radius = 4;
    this.power = 50;
    this.speed = 90;      // m/s front expansion
    this.alive = false;
    this.weapon = '';
    this.normal = new THREE.Vector3(0, 1, 0);
  }
  /** Current front radius. */
  front() { return Math.min(this.radius * 1.9, this.t * this.speed); }
}

export class Explosions {
  /**
   * @param {object} world
   * @param {object} opts { rigid: RigidBodySim, units: Unit[], impulseScale }
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.rigid = opts.rigid || null;
    this.units = opts.units || [];
    this.impulseScale = opts.impulseScale ?? 3.2;
    this.waves = [];
    this._pool = [];
    this.maxWaves = 24;
    /** Falloff exponent — 1 is linear, >1 concentrates damage at the centre. */
    this.falloffExp = 1.6;
    /** Last detonation report; reused to avoid per-blast allocation. */
    this.lastReport = { pos: new THREE.Vector3(), radius: 0, power: 0, affected: [] };
    this._affectedPool = [];
  }

  setUnits(units) { this.units = units; return this; }

  /**
   * @param {object} o { pos, radius, power, source?, weapon?, normal?,
   *                     damage?, falloffExp?, noDamage? }
   * @returns {object} report { pos, radius, power, affected: [{unit,dist,factor,los,dir}] }
   */
  detonate(o) {
    const pos = o.pos;
    const radius = o.radius ?? 4;
    const power = o.power ?? 50;
    const falloffExp = o.falloffExp ?? this.falloffExp;

    // ---- shockwave record (FX + audio consume this) -------------------------
    let w = this._pool.pop() || new Wave();
    w.pos.copy(pos);
    w.t = 0;
    w.life = 0.35 + radius * 0.09;
    w.radius = radius;
    w.power = power;
    w.speed = 70 + radius * 8;
    w.weapon = o.weapon || '';
    w.alive = true;
    if (o.normal) w.normal.copy(o.normal); else w.normal.set(0, 1, 0);
    if (this.waves.length >= this.maxWaves) this._pool.push(this.waves.shift());
    this.waves.push(w);

    // ---- damage -------------------------------------------------------------
    const report = this.lastReport;
    report.pos.copy(pos);
    report.radius = radius;
    report.power = power;
    for (const a of report.affected) this._affectedPool.push(a);
    report.affected.length = 0;

    if (!o.noDamage) {
      const units = this.units;
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u || u.alive === false) continue;
        centreOf(u, _target);
        const dist = _target.distanceTo(pos);
        if (dist > radius) continue;
        // Distance falloff.
        let factor = Math.pow(clamp(1 - dist / radius, 0, 1), falloffExp);
        // Occlusion: a wall between you and the blast eats most of it.
        const los = lineOfSight(this.world, pos, _target, null);
        factor *= 0.25 + 0.75 * los;
        // Armour: vehicles shrug off blast unless the charge is shaped.
        if (u.tank) factor *= o.antiTank ? 1 : 0.35;
        if (factor <= 0.01) continue;
        const dmg = (o.damage ?? power) * factor;
        const rec = this._affectedPool.pop() || { unit: null, dist: 0, factor: 0, los: 0, dir: new THREE.Vector3() };
        rec.unit = u; rec.dist = dist; rec.factor = factor; rec.los = los;
        rec.dir.subVectors(_target, pos);
        if (rec.dir.lengthSq() < 1e-6) rec.dir.set(0, 1, 0); else rec.dir.normalize();
        report.affected.push(rec);
        if (u.takeDamage) {
          u.takeDamage(dmg, {
            source: o.source || null, crit: false, worldPos: _target.clone(),
            explosion: true, weapon: o.weapon, dir: rec.dir,
          });
        }
      }
    }

    // ---- physics impulse ----------------------------------------------------
    if (this.rigid) {
      this.rigid.applyRadialImpulse(pos, radius * 1.35, power * this.impulseScale);
    }

    // ---- destructible cover -------------------------------------------------
    const cols = (this.world && this.world.colliders) || null;
    if (cols) {
      for (let i = 0; i < cols.length; i++) {
        const raw = cols[i];
        if (!raw.destructible || raw.dead) continue;
        const box = normalizeCollider(raw);
        const d = box.center.distanceTo(pos) - box.boundRadius * 0.5;
        if (d > radius) continue;
        const f = Math.pow(clamp(1 - d / radius, 0, 1), falloffExp);
        raw.hp = (raw.hp ?? 60) - power * f;
        if (raw.hp <= 0) {
          raw.dead = true;
          raw.disabled = true;
          Bus.emit('cover:destroyed', { collider: raw, pos: box.center.clone() });
        }
      }
    }

    Bus.emit('explosion', { pos: pos.clone(), radius, power, source: o.source || null, weapon: o.weapon });
    Bus.emit('sfx', { name: radius > 5 ? 'explosionBig' : 'explosion', pos, vol: clamp(radius / 6, 0.4, 1) });
    return report;
  }

  /**
   * Blast attenuation at an arbitrary point — used by the AI to score cover and
   * by the camera for shake.
   * @returns {number} 0..1
   */
  attenuationAt(pos, point, radius) {
    const d = pos.distanceTo(point);
    if (d > radius) return 0;
    const los = lineOfSight(this.world, pos, point, null);
    return Math.pow(1 - d / radius, this.falloffExp) * (0.25 + 0.75 * los);
  }

  /**
   * Query live shockwave fronts near a point.
   * @param {THREE.Vector3} pos
   * @param {Array} out  filled with { wave, dist, front, intensity, dir }
   */
  queryShockwave(pos, out = []) {
    out.length = 0;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      if (!w.alive) continue;
      const d = pos.distanceTo(w.pos);
      const front = w.front();
      // The front is a shell ~1.5 m thick; intensity peaks as it sweeps past.
      const shell = 1 - clamp(Math.abs(d - front) / 1.6, 0, 1);
      if (shell <= 0) continue;
      const fade = 1 - w.t / w.life;
      _v.subVectors(pos, w.pos);
      if (_v.lengthSq() < 1e-6) _v.set(0, 1, 0); else _v.normalize();
      out.push({
        wave: w, dist: d, front,
        intensity: shell * fade * clamp(w.power / 60, 0.2, 2) * (1 - clamp(d / (w.radius * 2), 0, 1)),
        dir: _v2.copy(_v).clone(),
      });
    }
    return out;
  }

  /** Aggregate camera shake at a listener position, 0..1. */
  shakeAt(pos) {
    let s = 0;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      if (!w.alive) continue;
      const d = pos.distanceTo(w.pos);
      const reach = w.radius * 5 + 8;
      if (d > reach) continue;
      const fade = smoothstep(w.life, 0, w.t);
      s += (1 - d / reach) * fade * clamp(w.power / 70, 0.15, 1.4);
    }
    return clamp(s, 0, 1);
  }

  fixedStep(h) {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.t += h;
      if (w.t >= w.life) {
        w.alive = false;
        this.waves.splice(i, 1);
        this._pool.push(w);
      }
    }
  }

  clear() {
    for (const w of this.waves) { w.alive = false; this._pool.push(w); }
    this.waves.length = 0;
  }
}

function centreOf(u, out) {
  const p = u.pos || (u.root && u.root.position) ||
            (u.tank && u.tank.root.position) || (u.character && u.character.root.position);
  if (!p) return out.set(0, 0, 0);
  out.copy(p);
  out.y += u.tank ? 1.0 : 0.9;      // aim at mass centre, not the feet
  return out;
}
