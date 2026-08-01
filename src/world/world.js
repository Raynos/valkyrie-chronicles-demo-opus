// World — assembles the mission battlefield and answers every spatial question
// the rest of the game asks of it.
//
// Build order matters and is not arbitrary:
//   layout      the curves everything else agrees on
//   terrain     carves the river/road/village from those curves
//   sky+lights  the key light the NPR materials calibrate against
//   structures  needs ground heights; also fixes the bridge deck elevation
//   props       needs to avoid building footprints
//   vegetation  needs to avoid both
//   water       needs the finished riverbed for its depth attribute
//   broadphase  every collider produced above, in one uniform grid
//
// Cover follows Valkyria's rules: a sandbag wall or a stone wall you are
// standing against gives FULL cover, but only against fire arriving through the
// arc it faces; a crater gives crouch cover from every direction; tall grass
// and wheat give no protection at all, only concealment, which shows up as a
// small cover value and a much larger accuracy penalty via concealmentAt().

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { Bus } from '../core/bus.js';
import { clamp01, clamp, smoothstep, V0 } from '../core/math.js';
import { makeRng, rngRange } from '../core/rng.js';
import { MissionLayout, WATER_Y, MAP_SIZE, UNIT_HEIGHT } from './layout.js';
import { Terrain } from './terrain.js';
import { Sky } from './sky.js';
import { Water } from './water.js';
import { Structures } from './structures.js';
import { Props } from './props.js';
import { Vegetation } from './vegetation.js';
import { ColliderGrid, closestPoint } from './collider.js';
import { WorldLighting, updateWorldMaterials, setWindGain, PALETTE } from './worldMaterials.js';

const _dir = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _sunDir = new THREE.Vector3();
// The ember the aerial perspective is pushed toward at last light.
const _fogWarm = new THREE.Color(0xc98f63);

// The two ray filters. They are NOT the same question — see world/collider.js.
// Sight is what a soldier can see over; projectile is what a round is stopped
// by. A sandbag parapet answers "yes" to the second and "no" to the first.
const LOS_FILTER = (c) => c.blocksLos;
const PROJECTILE_FILTER = (c) => c.blocksProjectile;

const _nav = { walkable: false, cost: 1, cover: 0, height: 0, material: 'grass', conceal: 0 };
const _rayOut = { collider: null, distance: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };
const _terrainHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0 };

/** The stage names `_buildSteps` yields, in order — only used to size progress. */
const BUILD_STAGES = [
  'Surveying the Vasel valley', 'Carving the riverbed', 'Hanging the sky',
  'Raising the village', 'Stacking the sandbags', 'Sowing the wheat',
  'Letting the river in', 'Marking the cover',
];

export class World {
  /**
   * @param {THREE.Scene} scene
   * @param {number} seed
   * @param {{defer?: boolean}} [opts] `defer: true` builds nothing here — the
   *   caller must then drive `runDeferredBuild()`. See `World.build()`.
   */
  constructor(scene, seed = CFG.seed, opts = {}) {
    this._steps = this._buildSteps(scene, seed);
    if (!opts.defer) { while (!this._steps.next().done) { /* drain */ } this._steps = null; }
  }

  /**
   * Build the world in stages that YIELD TO THE EVENT LOOP between them.
   *
   * Why this exists. The constructor was one synchronous 1.7 s block (dev; ~2.0 s
   * in a production build under load), and because it never yielded, the browser
   * could not paint the loading card index.html puts up at first paint, and could
   * not service a screenshot or a click either. A `page.screenshot()` issued at
   * t = 500 ms did not come back until t = 5.2 s. The tab was FROZEN, not merely
   * blank, for the first seconds of a published demo. That is a bounce, not a
   * slow load.
   *
   * What is safe about it. The stages are the SAME calls in the SAME order from
   * the SAME seed — `_buildSteps` is literally the old constructor body with
   * `yield` statements punctuating it. Nothing in the world build reads a clock
   * or `Math.random` (checked), so where the work happens on the timeline cannot
   * change what it produces. The determinism contract in CLAUDE.md is about
   * identical shot name => identical pixels, and it survives by construction —
   * which is also why capture mode keeps using the plain synchronous
   * constructor, so a cold render is bit-for-bit the code path it always was.
   *
   * @param {THREE.Scene} scene
   * @param {number} seed
   * @param {(name: string, frac: number) => void} [onStage] progress reporter,
   *   called with the name of the stage ABOUT to run and how far through we are.
   * @returns {Promise<World>}
   */
  static async build(scene, seed = CFG.seed, onStage = null) {
    const w = new World(scene, seed, { defer: true });
    await w.runDeferredBuild(onStage);
    return w;
  }

  /** Drive a `{ defer: true }` construction to completion, one stage per frame. */
  async runDeferredBuild(onStage = null) {
    if (!this._steps) return this;
    const total = BUILD_STAGES.length;
    for (let i = 0; ; i++) {
      const r = this._steps.next();
      if (r.done) break;
      if (onStage) onStage(r.value, (i + 1) / total);
      // rAF *and then a task*: resuming off a bare rAF lands in the same frame's
      // microtask checkpoint, i.e. still before the paint, which is no yield at
      // all for the purpose of getting the loading card on screen.
      await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    }
    this._steps = null;
    return this;
  }

  /**
   * The old constructor body, punctuated. Every `yield` names the stage that has
   * just finished; the ordering comments at the top of this file are the reason
   * the seams are where they are — each stage consumes the previous one's output.
   */
  *_buildSteps(scene, seed) {
    this.scene = scene;
    this.seed = seed;
    this.time = 0;
    this.rng = makeRng(seed ^ 0xa11ce);

    this.root = new THREE.Group();
    this.root.name = 'world';
    scene.add(this.root);

    // --- layout
    this.layout = new MissionLayout(seed);
    yield 'Surveying the Vasel valley';

    // --- terrain
    this.terrain = new Terrain({ size: MAP_SIZE, seed, layout: this.layout });
    this.root.add(this.terrain.mesh);
    yield 'Carving the riverbed';

    // --- sky and the key light. If src/render has already installed a dome,
    // do not stack a second one in front of it.
    if (!scene.getObjectByName('sky') && !scene.getObjectByName('vcSky')) {
      this.sky = new Sky({ seed });
      this.root.add(this.sky.mesh);
    }
    // Aerial perspective. The far bank of a 180 m valley has to sit back behind
    // the near bank or the frame is a flat cut-out, and the only thing that puts
    // it there is atmosphere. Exponential-squared so it is invisible inside 20 m
    // and lifts the far treeline about a third of the way to the haze colour.
    // Adopt an existing fog rather than replacing it: the render module may own
    // the grade and have set one already.
    if (!scene.fog) {
      scene.fog = new THREE.FogExp2(PALETTE.haze, 0.0026);
      this._ownsFog = true;
    }
    this._fogK = -1;
    this._makeLights(scene);
    yield 'Hanging the sky';

    // --- built environment
    this.structures = new Structures(this.root, this.terrain, this.layout, { seed });
    yield 'Raising the village';

    this.props = new Props(this.root, this.terrain, this.layout, {
      seed,
      occupied: (x, z) => this.structures.occupied(x, z),
    });
    yield 'Stacking the sandbags';

    this.vegetation = new Vegetation(this.root, this.terrain, this.layout, {
      seed,
      exclude: (x, z) => this.structures.occupied(x, z) || this.props.occupied(x, z),
    });
    yield 'Sowing the wheat';

    // --- water last: it samples the finished bed
    this.water = new Water(this.layout, this.terrain, {});
    this.root.add(this.water.mesh);
    yield 'Letting the river in';

    // --- broadphase
    this.colliders = [];
    this.grid = new ColliderGrid(MAP_SIZE + 40, 8);
    for (const c of this.structures.colliders) this._addCollider(c);
    for (const c of this.props.colliders) this._addCollider(c);
    for (const c of this.vegetation.colliders) this._addCollider(c);

    // --- walkable platforms (currently just the bridge deck)
    this.platforms = this.structures.platforms;

    // --- mission metadata other systems read
    this.deploy = this.layout.deploy;
    this.objectives = this.layout.objectives;
    this.bridge = this.layout.bridge;
    this.waterLevel = WATER_Y;
    this.size = MAP_SIZE;

    this._wind = 1;
    // `power` is HP of damage delivered AT THE EPICENTRE, falling to 0 at
    // `radius` (docs/ARCHITECTURE.md, `explosion`). It is NOT normalised: prop
    // HP is on the same scale, so a 46-power lance splash takes a 45 HP crate
    // stack out and leaves a 480 HP sandbag revetment standing.
    this._offExplosion = Bus.on('explosion', (p) => {
      if (p?.pos) this.damageArea(p.pos, p.radius ?? 5, p.power ?? 0);
    });
    yield 'Marking the cover';
  }

  _addCollider(c) {
    this.colliders.push(c);
    this.grid.insert(c);
  }

  // =========================================================================
  // lighting
  // =========================================================================

  _makeLights(scene) {
    // If the render module already installed a key light, adopt it rather than
    // adding a second one — the banded NPR shading is calibrated for exactly
    // one directional source. src/render/lighting.js names its key light 'sun'
    // and its sky fill 'worldFill' for exactly this handshake, so the rig and
    // the World compose to ONE DirectionalLight in either wiring order.
    let sun = scene.getObjectByName('sun');
    this._ownsSun = !sun;
    if (!sun) {
      sun = new THREE.DirectionalLight(WorldLighting.sunColor.getHex(), WorldLighting.sunIntensity);
      sun.name = 'sun';
      sun.castShadow = true;
      const s = CFG.render.shadowMapSize[Math.min(2, CFG.quality)] || 2048;
      sun.shadow.mapSize.set(s, s);
      const ext = MAP_SIZE * 0.62;
      sun.shadow.camera.left = -ext;
      sun.shadow.camera.right = ext;
      sun.shadow.camera.top = ext;
      sun.shadow.camera.bottom = -ext;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 420;
      // A generous normal bias is what keeps shadow acne out of the quantised
      // bands — a single acne pixel jumps a whole band and reads as a hole.
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.06;
      scene.add(sun);
      scene.add(sun.target);
    }
    this.sun = sun;
    if (this._ownsSun) this._aimSun();
    this._syncSunToMaterials();

    if (!scene.getObjectByName('worldFill')) {
      const hemi = new THREE.HemisphereLight(
        PALETTE.skyHorizon, PALETTE.dirtDark, 0.55
      );
      hemi.name = 'worldFill';
      scene.add(hemi);
      this.fill = hemi;
    }
  }

  _aimSun() {
    const d = WorldLighting.sunDir;
    this.sun.position.set(d.x * 190, d.y * 190, d.z * 190);
    this.sun.target.position.set(0, 4, 0);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * Push the ACTUAL key light into WorldLighting.
   *
   * The NPR fragment recovers `N·L * shadow` by dividing three's Lambert
   * accumulation by `uSunLum`, which is derived from these three values. If the
   * light rig owns the sun and animates time-of-day, stale values here show up
   * as the whole world drifting a band brighter or darker, and a sun direction
   * that disagrees with the shadow map. Cheap enough to do every frame.
   */
  _syncSunToMaterials() {
    const sun = this.sun;
    if (!sun) return;
    if (!sun.color.equals(WorldLighting.sunColor)) WorldLighting.sunColor.copy(sun.color);
    WorldLighting.sunIntensity = sun.intensity;
    // Direction TOWARD the sun, taken from the light's own transform — the rig
    // may have adopted the light after we made it and re-aimed it since.
    _sunDir.copy(sun.position).sub(sun.target.position);
    if (_sunDir.lengthSq() > 1e-6) WorldLighting.sunDir.copy(_sunDir.normalize());
  }

  // =========================================================================
  // ground / navigation
  // =========================================================================

  /**
   * Height a unit standing at (x,z) rests at — terrain, or the top of a
   * walkable platform (the bridge deck) if the point is on one.
   */
  groundHeightAt(x, z) {
    let y = this.terrain.heightAt(x, z);
    for (let i = 0; i < this.platforms.length; i++) {
      const p = this.platforms[i];
      const co = Math.cos(-p.yaw), si = Math.sin(-p.yaw);
      const dx = x - p.x, dz = z - p.z;
      const lx = dx * co - dz * si, lz = dx * si + dz * co;
      if (Math.abs(lx) <= p.hx && Math.abs(lz) <= p.hz && p.topY > y) y = p.topY;
    }
    return y;
  }

  /** True if (x,z) is on a walkable platform rather than on the ground. */
  onPlatform(x, z) {
    for (let i = 0; i < this.platforms.length; i++) {
      const p = this.platforms[i];
      const co = Math.cos(-p.yaw), si = Math.sin(-p.yaw);
      const dx = x - p.x, dz = z - p.z;
      const lx = dx * co - dz * si, lz = dx * si + dz * co;
      if (Math.abs(lx) <= p.hx && Math.abs(lz) <= p.hz) return p;
    }
    return null;
  }

  /**
   * Terrain query for the movement grid and the AI.
   * Returns a SHARED record — read it, do not keep it.
   * @returns {{walkable:boolean, cost:number, cover:number, height:number,
   *            material:string, conceal:number}}
   */
  navQuery(x, z) {
    const t = this.terrain;
    const plat = this.onPlatform(x, z);
    const h = plat ? plat.topY : t.heightAt(x, z);
    _nav.height = h;
    _nav.material = plat ? 'stone' : t.materialAt(x, z);
    _nav.conceal = 0;

    if (!t.inBounds(x, z)) {
      _nav.walkable = false; _nav.cost = 999; _nav.cover = 0;
      return _nav;
    }
    if (!plat && h < WATER_Y + 0.05) {
      // Fordable shallows are passable but slow; the channel is not.
      const depth = WATER_Y - h;
      _nav.walkable = depth < 0.55;
      _nav.cost = _nav.walkable ? 3.4 : 999;
      _nav.cover = 0;
      return _nav;
    }

    const slope = plat ? 0 : t.slopeAt(x, z);
    let walkable = slope < 0.62;                      // ~35 degrees
    let cost = 1 + slope * 2.6;

    // solid obstruction test with a unit-sized footprint
    let blocked = false;
    let bestCover = 0;
    this.grid.query(x, z, 2.2, (c) => {
      if (c.solid) {
        closestPoint(c, x, h + 0.9, z, _pt);
        const dx = x - _pt.x, dz = z - _pt.z;
        if (dx * dx + dz * dz < 0.30 * 0.30 && c.max.y > h + 0.3) blocked = true;
      }
      if (c.cover > 0) {
        const d = Math.hypot(x - c.center.x, z - c.center.z);
        if (d < 2.4 && c.max.y > h + 0.4) bestCover = Math.max(bestCover, c.cover);
      }
      if (c.conceal > 0) {
        const d = Math.hypot(x - c.center.x, z - c.center.z);
        if (d < 1.8) _nav.conceal = Math.max(_nav.conceal, c.conceal);
      }
    });
    if (blocked) walkable = false;

    // terrain material cost
    if (_nav.material === 'mud') cost += 0.8;
    else if (_nav.material === 'rock') cost += 0.35;
    else if (_nav.material === 'dirt') cost -= 0.15;   // the road is fast

    // standing crop and tall grass slow you and hide you
    const veg = this.vegetation.concealmentAt(x, z);
    if (veg > 0) { cost += veg * 0.9; _nav.conceal = Math.max(_nav.conceal, veg); }

    // craters are awkward to cross but worth being in
    for (const cr of this.layout.craters) {
      const d = Math.hypot(x - cr.x, z - cr.z);
      if (d < cr.r) { cost += 0.6; bestCover = Math.max(bestCover, 0.5); break; }
    }

    _nav.walkable = walkable;
    _nav.cost = Math.max(0.5, cost);
    _nav.cover = bestCover;
    return _nav;
  }

  /** Concealment 0..1 at a point — the accuracy penalty, not a bullet stop. */
  concealmentAt(x, z) {
    let v = this.vegetation.concealmentAt(x, z);
    this.grid.query(x, z, 1.6, (c) => {
      if (c.conceal > v) {
        const d = Math.hypot(x - c.center.x, z - c.center.z);
        if (d < 1.6) v = c.conceal;
      }
    });
    return clamp01(v);
  }

  // =========================================================================
  // cover
  // =========================================================================

  /**
   * Cover value at `pos` against fire arriving from direction `fromDir`.
   *
   * `fromDir` points FROM the covered unit TOWARD the threat (i.e. normalise
   * shooter.pos - target.pos). Only the vertical component is ignored.
   *
   * Rules:
   *   - a hard cover volume you are within ~1.9 m of, whose bearing falls in a
   *     140-degree arc centred on the threat, and whose top is above your
   *     chest, gives its full cover value;
   *   - if its top only reaches your waist it gives half (VC's crouch cover);
   *   - a shell crater gives half cover from all bearings;
   *   - failing all of that, standing crop returns a small value so the shooter
   *     still suffers, but it stops no bullets.
   *
   * @returns {number} 0 none .. 0.5 half .. 1 full
   */
  coverAt(pos, fromDir) {
    let fx = fromDir?.x ?? 0;
    let fz = fromDir?.z ?? 0;
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-5) { fx /= fl; fz /= fl; } else { fx = 0; fz = 1; }

    const gy = this.groundHeightAt(pos.x, pos.z);
    const chest = gy + UNIT_HEIGHT * 0.62;
    let best = 0;

    this.grid.query(pos.x, pos.z, 2.6, (c) => {
      if (c.cover <= 0) return;
      closestPoint(c, pos.x, chest, pos.z, _pt);
      const dx = _pt.x - pos.x, dz = _pt.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 1.9) return;
      // Bearing test. Right on top of the volume (d ~ 0) the bearing is
      // meaningless, so treat contact as always in-arc.
      if (d > 0.12) {
        const dot = (dx / d) * fx + (dz / d) * fz;
        if (dot < 0.34) return;                      // outside the +-70 arc
      }
      // Height thresholds are calibrated for a soldier who takes cover, not
      // one standing to attention: a waist-high sandbag revetment is FULL
      // cover in Valkyria because you crouch behind it. Knee height is half.
      const top = c.max.y;
      let factor;
      if (top >= gy + UNIT_HEIGHT * 0.52) factor = 1;
      else if (top >= gy + UNIT_HEIGHT * 0.27) factor = 0.55;
      else return;
      best = Math.max(best, c.cover * factor);
    });

    if (best < 0.5) {
      for (const cr of this.layout.craters) {
        const d = Math.hypot(pos.x - cr.x, pos.z - cr.z);
        if (d < cr.r * 0.92 && cr.depth > 0.6) { best = Math.max(best, 0.5); break; }
      }
    }
    if (best <= 0) {
      const veg = this.concealmentAt(pos.x, pos.z);
      best = Math.min(0.3, veg * 0.45);
    }
    return clamp01(best);
  }

  // =========================================================================
  // ray casting / line of sight
  // =========================================================================

  /**
   * Nearest hit against terrain and world colliders.
   *
   * Defaults to the LINE-OF-SIGHT filter. Bullets must ask for the projectile
   * filter — `raycast(o, d, dist, { projectile: true })` — because a sandbag
   * wall stops a round without blocking sight, and tall grass blocks neither.
   *
   * @param {object} [opts] { projectile?:boolean, filter?:(collider)=>boolean }
   * @returns {{point, normal, distance, collider, material}|null} shared record
   */
  raycast(origin, dir, maxDist = 300, opts = {}) {
    _dir.set(dir.x, dir.y, dir.z).normalize();
    const filter = opts.filter || (opts.projectile ? PROJECTILE_FILTER : LOS_FILTER);
    const colHit = this.grid.raycast(origin, _dir, maxDist, filter, _rayOut);
    const terHit = this.terrain.raycast(origin, _dir, maxDist, _terrainHit);

    if (colHit && (!terHit || colHit.distance < terHit.distance)) {
      return {
        point: colHit.point, normal: colHit.normal, distance: colHit.distance,
        collider: colHit.collider, material: colHit.collider.tag,
      };
    }
    if (terHit) {
      return {
        point: terHit.point, normal: terHit.normal, distance: terHit.distance,
        collider: null, material: this.terrain.materialAt(terHit.point.x, terHit.point.z),
      };
    }
    return null;
  }

  /** Is there an unobstructed line between two world points? */
  lineOfSight(a, b) {
    V0.set(b.x - a.x, b.y - a.y, b.z - a.z);
    const dist = V0.length();
    if (dist < 1e-4) return true;
    V0.multiplyScalar(1 / dist);
    const hit = this.raycast(a, V0, dist - 0.15);
    return !hit;
  }

  // =========================================================================
  // destruction
  // =========================================================================

  /**
   * Apply blast damage to every destructible prop inside a radius.
   * `amount` is HP at the epicentre — the `explosion` event's `power` — and
   * falls off to 0 at `radius`.
   * @returns {number} props hit
   */
  damageArea(pos, radius, amount) {
    if (!(amount > 0) || !(radius > 0)) return 0;
    // Deliberately a fresh Set: `damage()` emits on the Bus and a listener may
    // detonate something else, re-entering this method.
    const hit = new Set();
    this.grid.query(pos.x, pos.z, radius, (c) => {
      if (!c.destructible || c.destroyed || !c.owner || hit.has(c.owner)) return;
      const d = Math.hypot(c.center.x - pos.x, c.center.z - pos.z);
      if (d > radius) return;
      hit.add(c.owner);
      const falloff = 1 - smoothstep(0, radius, d);
      this.damage(c, amount * falloff);
    });
    return hit.size;
  }

  /**
   * Direct-fire damage against one collider. THE single funnel for destruction:
   * raises `cover:destroyed` exactly once, on the transition, so nobody else
   * has to guess whether a prop just died.
   * @returns {boolean} true if this call destroyed it
   */
  damage(collider, amount) {
    if (!collider?.destructible || collider.destroyed) return false;
    const destroyed = this.props.damage(collider, amount);
    if (destroyed) {
      Bus.emit('cover:destroyed', { collider, point: collider.center.clone() });
    }
    return destroyed;
  }

  // =========================================================================
  // spawn helpers
  // =========================================================================

  /**
   * n walkable, reasonably flat positions inside a deployment zone, spread out
   * with a simple dart-throwing pass.
   */
  deployPositions(team = 0, n = 6, minGap = 2.4) {
    const zone = team === 0 ? this.deploy.ally : this.deploy.enemy;
    const rng = makeRng(this.seed ^ (team ? 0x1111 : 0x2222));
    const out = [];
    for (let tries = 0; tries < n * 400 && out.length < n; tries++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * zone.r;
      const x = zone.x + Math.cos(a) * r;
      const z = zone.z + Math.sin(a) * r;
      const q = this.navQuery(x, z);
      if (!q.walkable || q.cost > 2.6) continue;
      let ok = true;
      for (const p of out) if ((p.x - x) ** 2 + (p.z - z) ** 2 < minGap * minGap) { ok = false; break; }
      if (!ok) continue;
      out.push(new THREE.Vector3(x, this.groundHeightAt(x, z), z));
    }
    // fall back to the zone centre if the dart throw came up short
    while (out.length < n) {
      const x = zone.x + rngRange(rng, -3, 3), z = zone.z + rngRange(rng, -3, 3);
      out.push(new THREE.Vector3(x, this.groundHeightAt(x, z), z));
    }
    return out;
  }

  /** Snap a position onto the ground and out of solid geometry. */
  resolvePosition(pos, radius = 0.35) {
    this.grid.resolve(pos, radius, UNIT_HEIGHT);
    pos.y = this.groundHeightAt(pos.x, pos.z);
    pos.x = clamp(pos.x, -this.size * 0.5 + 1, this.size * 0.5 - 1);
    pos.z = clamp(pos.z, -this.size * 0.5 + 1, this.size * 0.5 - 1);
    return pos;
  }

  // =========================================================================

  update(dt, camera) {
    this.time += dt;

    // Wind is a slow two-rate signal: a base breeze with gusts riding on it.
    // Everything that moves in the world is driven off this one number.
    const gust = 0.72
      + 0.28 * Math.sin(this.time * 0.19)
      + 0.16 * Math.sin(this.time * 0.61 + 1.3);
    if (Math.abs(gust - this._wind) > 0.01) {
      this._wind = gust;
      setWindGain(gust);
    }

    // The key light may be owned by src/render's rig, which animates it.
    this._syncSunToMaterials();
    updateWorldMaterials(dt);
    this.sky?.update(dt, camera);
    // Aerial perspective is the colour of the sky the far bank is seen THROUGH.
    // Leaving it on the daylight putty while the dome went to ember was the
    // second half of why `dusk` did not read as dusk: the town on the far side
    // of the valley dissolved into a cool grey haze under an orange sky, which
    // is a combination no evening has ever produced. Only touched if we own the
    // fog — the render pipeline's own haze pass takes priority when it exists.
    if (this._ownsFog && this.sky) {
      const k = this.sky.duskAmount;
      if (Math.abs(k - this._fogK) > 1e-3) {
        this._fogK = k;
        this.scene.fog.color.copy(this.sky.horizonColor()).lerp(_fogWarm, 0.25 * k);
      }
    }
    this.terrain.update(dt, camera);
    this.water.update(dt, camera);
    this.vegetation.update(dt, camera);
    this.structures.update(dt, this._wind);
    this.props.update(dt);
  }

  dispose() {
    this._offExplosion?.();
    this.vegetation.dispose();
    this.props.dispose();
    this.structures.dispose();
    this.water.dispose();
    this.sky?.dispose();
    this.terrain.dispose();
    if (this._ownsFog) this.scene.fog = null;
    this.scene.remove(this.root);
  }
}

export { WATER_Y, MAP_SIZE, UNIT_HEIGHT };
