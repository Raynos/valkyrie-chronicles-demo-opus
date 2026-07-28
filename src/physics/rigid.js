// src/physics/rigid.js
// A compact impulse-based rigid-body solver: debris, shell casings, tumbling
// sandbags, blown-off tank parts. Sphere and box colliders, terrain contact,
// Coulomb friction, restitution, island-free sequential impulses and sleeping.
//
// Fixed 60 Hz; bodies keep a previous transform so the renderer can interpolate.

import * as THREE from 'three';
import { clamp } from '../core/math.js';
import { normalizeCollider, closestPointOnBox, UP } from './collision.js';

const _v = new THREE.Vector3();
const _r1 = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _imp = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _n = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();

const BOX_CORNERS = [
  [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
];

let _bid = 1;

export class RigidBody {
  constructor() {
    this.id = 0;
    this.active = false;
    this.pos = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.prevQuat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.angVel = new THREE.Vector3();
    this.mass = 1;
    this.invMass = 1;
    /** Diagonal inverse inertia in body space. */
    this.invInertia = new THREE.Vector3(1, 1, 1);
    this.shape = 'box';           // 'box' | 'sphere'
    this.half = new THREE.Vector3(0.1, 0.1, 0.1);
    this.radius = 0.1;
    this.restitution = 0.25;
    this.friction = 0.6;
    /** Contact-patch resistance to rolling; 0 = a frictionless marble. */
    this.rollingFriction = 0.09;
    this.linearDamping = 0.02;
    this.angularDamping = 0.06;
    this.gravityScale = 1;
    this.sleeping = false;
    this.sleepTimer = 0;
    this.life = 0;
    this.maxLife = 0;             // 0 = immortal
    this.userData = null;
    this.mesh = null;             // optional THREE.Object3D driven by the body
    this.instanceIndex = -1;      // or an instanced-mesh slot
    this.onRest = null;
    this.collideWorld = true;
    this.bounced = 0;
  }

  setBox(hx, hy, hz, mass) {
    this.shape = 'box';
    this.half.set(hx, hy, hz);
    this.radius = Math.hypot(hx, hy, hz);
    this.setMass(mass);
    return this;
  }
  setSphere(r, mass) {
    this.shape = 'sphere';
    this.radius = r;
    this.half.setScalar(r);
    this.setMass(mass);
    return this;
  }
  setMass(m) {
    this.mass = m;
    this.invMass = m > 0 ? 1 / m : 0;
    if (m <= 0) { this.invInertia.set(0, 0, 0); return this; }
    if (this.shape === 'sphere') {
      const i = 0.4 * m * this.radius * this.radius;
      this.invInertia.set(1 / i, 1 / i, 1 / i);
    } else {
      const x = this.half.x * 2, y = this.half.y * 2, z = this.half.z * 2;
      const k = m / 12;
      this.invInertia.set(
        1 / (k * (y * y + z * z)),
        1 / (k * (x * x + z * z)),
        1 / (k * (x * x + y * y))
      );
    }
    return this;
  }

  wake() { this.sleeping = false; this.sleepTimer = 0; }

  applyImpulse(j, atWorldPoint) {
    if (this.invMass === 0) return;
    this.wake();
    this.vel.addScaledVector(j, this.invMass);
    if (atWorldPoint) {
      _r1.subVectors(atWorldPoint, this.pos);
      _tmp.crossVectors(_r1, j);
      this._applyAngularImpulse(_tmp);
    }
  }

  _applyAngularImpulse(worldTorqueImpulse) {
    // Rotate into body space, scale by the diagonal inverse inertia, rotate back.
    _q.copy(this.quat).invert();
    _tmp2.copy(worldTorqueImpulse).applyQuaternion(_q);
    _tmp2.multiply(this.invInertia);
    _tmp2.applyQuaternion(this.quat);
    this.angVel.add(_tmp2);
  }

  /** World-space inverse inertia applied to `v`, result into `out`. */
  _invInertiaMul(v, out) {
    _q.copy(this.quat).invert();
    out.copy(v).applyQuaternion(_q).multiply(this.invInertia).applyQuaternion(this.quat);
    return out;
  }

  /** Interpolated render transform. */
  getRenderTransform(alpha, outPos, outQuat) {
    outPos.lerpVectors(this.prevPos, this.pos, alpha);
    outQuat.copy(this.prevQuat).slerp(this.quat, alpha);
  }
}

export class RigidBodySim {
  constructor(world, opts = {}) {
    this.world = world;
    this.bodies = [];
    this._pool = [];
    this.gravity = opts.gravity ?? -9.81;
    this.maxBodies = opts.maxBodies ?? 400;
    this.solverIterations = opts.iterations ?? 4;
    this.sleepLinear = 0.055;
    this.sleepAngular = 0.28;
    this.sleepTime = 0.55;
    this.alpha = 0;
    /** Broad-phase cell size for body-vs-body contacts. */
    this._grid = new Map();
    this._cell = 1.6;
    this.bodyVsBody = opts.bodyVsBody !== false;
  }

  /**
   * @param {object} o {pos, quat?, vel?, angVel?, shape:'box'|'sphere',
   *                    half?|radius?, mass?, restitution?, friction?,
   *                    maxLife?, mesh?, userData?}
   */
  addBody(o = {}) {
    let b = this._pool.pop();
    if (!b) b = new RigidBody();
    b.id = _bid++;
    b.active = true;
    b.sleeping = false;
    b.sleepTimer = 0;
    b.life = 0;
    b.bounced = 0;
    b.pos.copy(o.pos || _v.set(0, 0, 0));
    b.prevPos.copy(b.pos);
    if (o.quat) b.quat.copy(o.quat); else b.quat.identity();
    b.prevQuat.copy(b.quat);
    b.vel.copy(o.vel || _v.set(0, 0, 0));
    b.angVel.copy(o.angVel || _v.set(0, 0, 0));
    if (o.shape === 'sphere') b.setSphere(o.radius ?? 0.1, o.mass ?? 1);
    else {
      const h = o.half || { x: o.radius ?? 0.1, y: o.radius ?? 0.1, z: o.radius ?? 0.1 };
      b.setBox(h.x, h.y, h.z, o.mass ?? 1);
    }
    b.restitution = o.restitution ?? 0.24;
    b.friction = o.friction ?? 0.62;
    b.rollingFriction = o.rollingFriction ?? 0.09;
    b.linearDamping = o.linearDamping ?? 0.02;
    b.angularDamping = o.angularDamping ?? 0.06;
    b.gravityScale = o.gravityScale ?? 1;
    b.maxLife = o.maxLife ?? 0;
    b.mesh = o.mesh || null;
    b.instanceIndex = o.instanceIndex ?? -1;
    b.userData = o.userData || null;
    b.onRest = o.onRest || null;
    b.collideWorld = o.collideWorld !== false;

    if (this.bodies.length >= this.maxBodies) this.removeBody(this._oldest());
    this.bodies.push(b);
    return b;
  }

  _oldest() {
    let best = this.bodies[0];
    for (let i = 1; i < this.bodies.length; i++) {
      if (this.bodies[i].life > best.life) best = this.bodies[i];
    }
    return best;
  }

  removeBody(b) {
    const i = this.bodies.indexOf(b);
    if (i < 0) return;
    this.bodies.splice(i, 1);
    b.active = false;
    b.mesh = null;
    b.userData = null;
    b.onRest = null;
    this._pool.push(b);
  }

  clear() {
    for (const b of this.bodies) { b.active = false; this._pool.push(b); }
    this.bodies.length = 0;
  }

  /**
   * Wake and push every body within `radius`. Used by Explosions.
   * @param {number} power impulse magnitude at the centre, in N·s.
   */
  applyRadialImpulse(pos, radius, power) {
    const r2 = radius * radius;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b.invMass === 0) continue;
      _v.subVectors(b.pos, pos);
      const d2 = _v.lengthSq();
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      const falloff = 1 - d / radius;
      // Direction first, magnitude second — conflating the two is how you end
      // up launching crates into orbit.
      if (d < 1e-4) _v.set(0, 1, 0); else _v.divideScalar(d);
      _v.y += 0.5;                          // blasts loft debris
      _v.normalize();
      const j = power * falloff * falloff;  // N·s
      b.wake();
      // Terminal speed cap: a shell casing next to a howitzer round should
      // still be a shell casing afterwards, not a bullet.
      const dv = Math.min(j * b.invMass, 16);
      b.vel.addScaledVector(_v, dv);
      // Tumble: the blast strikes one face off-centre. The lever arm is
      // derived from the body id so repeated runs match exactly.
      const s = ((Math.imul(b.id, 2654435761) >>> 0) / 4294967296) - 0.5;
      _tmp.set(-_v.z, 0, _v.x);
      if (_tmp.lengthSq() < 1e-8) _tmp.set(1, 0, 0);
      _tmp.normalize().multiplyScalar(b.radius * 0.7 * s * 2);
      _tmp2.copy(_v).multiplyScalar(Math.min(j, 16 / Math.max(1e-6, b.invMass)));
      _tmp.cross(_tmp2);
      b._applyAngularImpulse(_tmp);
      clampSpin(b);
    }
  }

  // --------------------------------------------------------------- stepping ---

  fixedStep(h) {
    const bodies = this.bodies;
    const terrain = this.world && this.world.terrain;
    const cols = (this.world && this.world.colliders) || null;

    for (let i = bodies.length - 1; i >= 0; i--) {
      const b = bodies[i];
      b.life += h;
      if (b.maxLife > 0 && b.life > b.maxLife) { this.removeBody(b); continue; }
      if (b.sleeping) { b.prevPos.copy(b.pos); b.prevQuat.copy(b.quat); continue; }

      b.prevPos.copy(b.pos);
      b.prevQuat.copy(b.quat);

      // Integrate.
      b.vel.y += this.gravity * b.gravityScale * h;
      b.vel.multiplyScalar(Math.max(0, 1 - b.linearDamping * h * 60 * 0.0166));
      b.angVel.multiplyScalar(Math.max(0, 1 - b.angularDamping * h * 60 * 0.0166));
      b.pos.addScaledVector(b.vel, h);
      clampSpin(b);
      if (b.angVel.lengthSq() > 1e-10) {
        const w = b.angVel;
        _q.set(w.x * h * 0.5, w.y * h * 0.5, w.z * h * 0.5, 0).multiply(b.quat);
        b.quat.x += _q.x; b.quat.y += _q.y; b.quat.z += _q.z; b.quat.w += _q.w;
        b.quat.normalize();
      }

      if (b.collideWorld) {
        for (let it = 0; it < this.solverIterations; it++) {
          let resolved = 0;
          resolved += this._terrainContacts(b, terrain, h);
          if (cols) resolved += this._colliderContacts(b, cols, h);
          if (resolved === 0) break;
        }
      }

      // Sleeping test.
      if (b.vel.lengthSq() < this.sleepLinear * this.sleepLinear &&
          b.angVel.lengthSq() < this.sleepAngular * this.sleepAngular) {
        b.sleepTimer += h;
        if (b.sleepTimer > this.sleepTime) {
          b.sleeping = true;
          b.vel.set(0, 0, 0);
          b.angVel.set(0, 0, 0);
          if (b.onRest) b.onRest(b);
        }
      } else {
        b.sleepTimer = 0;
      }
    }

    if (this.bodyVsBody) this._bodyPairs(h);
  }

  interpolate(alpha) {
    this.alpha = alpha;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.mesh) continue;
      b.getRenderTransform(alpha, b.mesh.position, b.mesh.quaternion);
    }
  }

  // ------------------------------------------------------------- contacts ---

  /** @returns {number} contacts resolved */
  _terrainContacts(b, terrain, h) {
    if (!terrain || !terrain.heightAt) return 0;
    let count = 0;
    if (b.shape === 'sphere') {
      const gh = terrain.heightAt(b.pos.x, b.pos.z);
      const pen = gh - (b.pos.y - b.radius);
      if (pen > 0) {
        terrainNormal(terrain, b.pos.x, b.pos.z, _n);
        _cp.copy(b.pos).addScaledVector(_n, -b.radius);
        this._resolveContact(b, _cp, _n, pen, h);
        count++;
      }
    } else {
      for (let c = 0; c < 8; c++) {
        const cc = BOX_CORNERS[c];
        _cp.set(cc[0] * b.half.x, cc[1] * b.half.y, cc[2] * b.half.z)
          .applyQuaternion(b.quat).add(b.pos);
        const gh = terrain.heightAt(_cp.x, _cp.z);
        const pen = gh - _cp.y;
        if (pen > 0) {
          terrainNormal(terrain, _cp.x, _cp.z, _n);
          this._resolveContact(b, _cp, _n, pen, h);
          count++;
        }
      }
    }
    return count;
  }

  _colliderContacts(b, cols, h) {
    let count = 0;
    for (let i = 0; i < cols.length; i++) {
      const raw = cols[i];
      if (raw.disabled || raw.dead || raw.noCollide) continue;
      const box = normalizeCollider(raw);
      if (!box.solid) continue;
      // Broad phase.
      if (b.pos.distanceToSquared(box.center) >
          (b.radius + box.boundRadius + 0.2) * (b.radius + box.boundRadius + 0.2)) continue;

      if (b.shape === 'sphere' || box.type === 'sphere') {
        if (box.type === 'sphere') {
          _v.subVectors(b.pos, box.center);
          const d = _v.length();
          const pen = b.radius + box.radius - d;
          if (pen > 0) {
            if (d < 1e-6) _n.set(0, 1, 0); else _n.copy(_v).divideScalar(d);
            _cp.copy(b.pos).addScaledVector(_n, -b.radius);
            this._resolveContact(b, _cp, _n, pen, h);
            count++;
          }
        } else {
          closestPointOnBox(box, b.pos, _cp);
          _v.subVectors(b.pos, _cp);
          const d = _v.length();
          const pen = b.radius - d;
          if (pen > 0) {
            if (d < 1e-6) { _n.copy(b.pos).sub(box.center).normalize(); }
            else _n.copy(_v).divideScalar(d);
            this._resolveContact(b, _cp, _n, pen, h);
            count++;
          }
        }
      } else {
        // Box vs static box: corner-in-box contacts, min-axis push-out.
        for (let c = 0; c < 8; c++) {
          const cc = BOX_CORNERS[c];
          _cp.set(cc[0] * b.half.x, cc[1] * b.half.y, cc[2] * b.half.z)
            .applyQuaternion(b.quat).add(b.pos);
          _v.subVectors(_cp, box.center);
          if (!box.axisAligned) _v.applyQuaternion(box.invQuat);
          const ox = box.half.x - Math.abs(_v.x);
          if (ox < 0) continue;
          const oy = box.half.y - Math.abs(_v.y);
          if (oy < 0) continue;
          const oz = box.half.z - Math.abs(_v.z);
          if (oz < 0) continue;
          let pen;
          _n.set(0, 0, 0);
          if (ox <= oy && ox <= oz) { _n.x = Math.sign(_v.x) || 1; pen = ox; }
          else if (oy <= oz) { _n.y = Math.sign(_v.y) || 1; pen = oy; }
          else { _n.z = Math.sign(_v.z) || 1; pen = oz; }
          if (!box.axisAligned) _n.applyQuaternion(box.quat);
          this._resolveContact(b, _cp, _n, pen, h);
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Single contact resolution: Baumgarte positional correction + normal
   * impulse with restitution + Coulomb friction impulse.
   */
  _resolveContact(b, point, normal, penetration, h) {
    if (b.invMass === 0) return;
    // NOTE: deliberately no wake() here. A body at rest on the ground has a
    // contact every single step; waking on contact would reset the sleep timer
    // forever and nothing would ever fall asleep. Only external impulses
    // (applyImpulse / applyRadialImpulse) wake a body.

    // Positional correction (split impulse would be nicer; this is stable
    // enough for debris and avoids the extra velocity pass).
    const slop = 0.004;
    const corr = Math.max(0, penetration - slop) * 0.8;
    b.pos.addScaledVector(normal, corr);

    _r1.subVectors(point, b.pos);
    _tmp.crossVectors(b.angVel, _r1);
    _rel.copy(b.vel).add(_tmp);
    const vn = _rel.dot(normal);
    if (vn > 0) return;    // separating

    // Effective mass along the normal: 1/m + n . (I^-1 (r x n)) x r
    _tmp.crossVectors(_r1, normal);
    b._invInertiaMul(_tmp, _tmp2);
    _tmp.crossVectors(_tmp2, _r1);
    const kn = b.invMass + normal.dot(_tmp);
    if (kn < 1e-8) return;

    // Kill restitution for slow contacts so things actually come to rest.
    const e = (-vn > 0.75) ? b.restitution : 0;
    let jn = -(1 + e) * vn / kn;
    if (jn < 0) jn = 0;
    _imp.copy(normal).multiplyScalar(jn);
    b.vel.addScaledVector(_imp, b.invMass);
    _tmp.crossVectors(_r1, _imp);
    b._applyAngularImpulse(_tmp);
    if (-vn > 1.2) b.bounced++;

    // Friction along the tangential relative velocity.
    _tmp.crossVectors(b.angVel, _r1);
    _rel.copy(b.vel).add(_tmp);
    _tan.copy(_rel).addScaledVector(normal, -_rel.dot(normal));
    const tl = _tan.length();
    if (tl < 1e-5) return;
    _tan.divideScalar(tl);
    _tmp.crossVectors(_r1, _tan);
    b._invInertiaMul(_tmp, _tmp2);
    _tmp.crossVectors(_tmp2, _r1);
    const kt = b.invMass + _tan.dot(_tmp);
    if (kt < 1e-8) return;
    let jt = -tl / kt;
    const maxF = b.friction * jn;
    jt = clamp(jt, -maxF, maxF);
    _imp.copy(_tan).multiplyScalar(jt);
    b.vel.addScaledVector(_imp, b.invMass);
    _tmp.crossVectors(_r1, _imp);
    b._applyAngularImpulse(_tmp);

    this._rollingResistance(b, normal, jn);
  }

  /**
   * Coulomb friction cannot stop a rolling sphere: a body in pure roll has zero
   * velocity at the contact point, so there is nothing for friction to act on
   * and a shell casing would roll across the whole map on a 1° slope. Rolling
   * resistance models the finite contact patch — it bleeds spin, and bleeds the
   * matching tangential linear speed so the rolling constraint (v = wR) is
   * preserved rather than being turned into a slide.
   */
  _rollingResistance(b, normal, jn) {
    const crr = b.rollingFriction;
    if (crr <= 0 || jn <= 0) return;
    const wl = b.angVel.length();
    if (wl < 1e-4) return;
    const invI = Math.max(b.invInertia.x, b.invInertia.y, b.invInertia.z);
    const maxDw = crr * jn * Math.max(0.02, b.radius) * invI;
    const f = 1 - Math.min(wl, maxDw) / wl;
    b.angVel.multiplyScalar(f);
    const vn = b.vel.dot(normal);
    _tan.copy(b.vel).addScaledVector(normal, -vn).multiplyScalar(f);
    b.vel.copy(_tan).addScaledVector(normal, vn);
  }

  // ------------------------------------------------------ body vs body ------

  /**
   * Uniform-grid broad phase, sphere-approximated narrow phase. Debris piling
   * on debris only needs to look plausible, and this keeps it O(n).
   */
  _bodyPairs(h) {
    // Nothing awake -> nothing to pair. Skips the Map churn on the common case
    // of a battlefield full of settled debris.
    let awake = 0;
    for (let i = 0; i < this.bodies.length; i++) if (!this.bodies[i].sleeping) awake++;
    if (awake < 2) return;
    const grid = this._grid;
    grid.clear();
    const cell = this._cell;
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.sleeping) continue;
      const kx = Math.floor(b.pos.x / cell), ky = Math.floor(b.pos.y / cell), kz = Math.floor(b.pos.z / cell);
      const key = kx * 73856093 ^ ky * 19349663 ^ kz * 83492791;
      let arr = grid.get(key);
      if (!arr) grid.set(key, (arr = []));
      arr.push(b);
    }
    for (const arr of grid.values()) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          this._pairContact(arr[i], arr[j], h);
        }
      }
    }
  }

  _pairContact(a, b, h) {
    if (a.sleeping && b.sleeping) return;
    const ra = a.shape === 'sphere' ? a.radius : a.half.length() * 0.72;
    const rb = b.shape === 'sphere' ? b.radius : b.half.length() * 0.72;
    _v.subVectors(b.pos, a.pos);
    const d = _v.length();
    const pen = ra + rb - d;
    if (pen <= 0) return;
    if (d < 1e-6) _n.set(0, 1, 0); else _n.copy(_v).divideScalar(d);
    const totalInv = a.invMass + b.invMass;
    if (totalInv < 1e-8) return;
    // Only a genuinely moving neighbour disturbs a sleeper — otherwise a
    // settled pile keeps shaking itself awake on residual overlap.
    _rel.subVectors(b.vel, a.vel);
    const closing = _rel.dot(_n);
    const lively = Math.abs(closing) > this.sleepLinear;
    if (a.sleeping) { if (!lively) return; a.wake(); }
    if (b.sleeping) { if (!lively) return; b.wake(); }
    const corr = pen * 0.5;
    a.pos.addScaledVector(_n, -corr * (a.invMass / totalInv));
    b.pos.addScaledVector(_n, corr * (b.invMass / totalInv));
    _rel.subVectors(b.vel, a.vel);
    const vn = _rel.dot(_n);
    if (vn > 0) return;
    const e = Math.min(a.restitution, b.restitution) * (-vn > 0.7 ? 1 : 0);
    const jn = -(1 + e) * vn / totalInv;
    _imp.copy(_n).multiplyScalar(jn);
    a.vel.addScaledVector(_imp, -a.invMass);
    b.vel.addScaledVector(_imp, b.invMass);
    // Tumble: convert a fraction of the contact impulse into spin.
    _tmp.crossVectors(_n, _rel).multiplyScalar(0.12 * jn);
    a._applyAngularImpulse(_tmp);
    _tmp.multiplyScalar(-1);
    b._applyAngularImpulse(_tmp);
    void h;
  }
}

/**
 * Hard cap on spin. A quaternion integrated with an explicit Euler step goes
 * unstable well before this, and nothing in this game legitimately spins at
 * 40 rad/s (that is 380 rpm) for more than an instant.
 */
const MAX_SPIN = 40;
function clampSpin(b) {
  const w2 = b.angVel.lengthSq();
  if (w2 > MAX_SPIN * MAX_SPIN) b.angVel.multiplyScalar(MAX_SPIN / Math.sqrt(w2));
}

function terrainNormal(terrain, x, z, out) {
  if (terrain.normalAt) {
    // Prefer the out-param form (allocation-free); fall back to the return
    // value for implementations that only honour the contract's signature.
    const n = terrain.normalAt(x, z, out);
    if (n && n !== out) out.set(n.x, n.y, n.z);
    if (out.lengthSq() < 1e-6) out.copy(UP);
    return out;
  }
  const e = 0.4;
  out.set(terrain.heightAt(x - e, z) - terrain.heightAt(x + e, z), 2 * e,
    terrain.heightAt(x, z - e) - terrain.heightAt(x, z + e)).normalize();
  return out;
}

/** Build a quaternion whose +Y axis is `normal` — used to lie decals and
 *  blown-off panels flat against a surface. Allocation-free. */
export function orientationFromNormal(normal, outQuat) {
  _n.copy(normal).normalize();
  _tmp.set(0, 1, 0);
  if (Math.abs(_n.y) > 0.99) _tmp.set(1, 0, 0);
  _tmp2.crossVectors(_tmp, _n).normalize();   // tangent -> X
  _v.crossVectors(_n, _tmp2);                 // bitangent -> Z
  _m4.makeBasis(_tmp2, _n, _v);
  outQuat.setFromRotationMatrix(_m4);
  return outQuat;
}
