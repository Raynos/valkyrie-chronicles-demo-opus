// src/game/captureShots.js — deterministic scripted setups for the screenshot critic harness.
//
// `node tools/shoot.mjs <name>` loads the game with ?capture&shot=<name>; main.js looks the name
// up in SHOTS, awaits the setup function, settles the frame, runs the shot's `finale` (the one
// or two frames of scripted VFX that must still be burning when the shutter opens), and only
// then sets window.__READY__ = true.
//
// Every setup is a pure function of (ctx, seeded rng): it lights the scene FOR THE CAMERA,
// positions the camera, poses units, forces a phase, and never reads the clock, Math.random,
// or user input.
//
// COMPOSITION RULES every shot in here obeys — this is axis 8 of docs/CRITIQUE_RUBRIC.md:
//   1. One clear focal subject, on a rule-of-thirds intersection, never dead centre.
//   2. Three depth planes: something framing in the near field (a trunk, a bank, a soldier
//      cropped by the edge), the subject in the midground, hills receding into haze behind.
//   3. The horizon on a third — never halved, never crammed against the top of the frame.
//   4. The key light three-quarters to the subject so silhouettes carry a warm rim and the
//      cast shadows rake ACROSS the frame instead of falling straight away from camera.
//   5. No large empty region. If a third of the frame is bare ground, the camera is wrong.
//
// ctx = { engine, scene, camera, renderer, battle, world, ui, pipeline, audio, fx, rig }

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { CFG } from '../core/config.js';
import { makeRng } from '../core/rng.js';
import * as LAYOUT from '../world/layout.js';
import { STANCE } from './units.js';

/** The river is a level pool; anything below this is water, not ground. */
const WATER_Y = typeof LAYOUT.WATER_Y === 'number' ? LAYOUT.WATER_Y : 2.0;

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Vector3();
const _t = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const raf = () => new Promise((r) => (typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame(() => r())
  : setTimeout(r, 16)));

/** Let the renderer run `n` frames so animation, LOD and post-FX history settle. */
export async function frames(n = 8) { for (let i = 0; i < n; i++) await raf(); }

/**
 * Light the shot FOR THE CAMERA.
 *
 * `t` is time of day (0 dawn, 0.5 noon, 1 night) and drives the key's colour and elevation.
 * `azimuth` is the sun's compass bearing in radians: main.js forwards it to the light rig and
 * re-syncs WorldLighting, so the sky dome and the shadows keep agreeing. One fixed bearing
 * cannot be three-quarters behind every subject on a 180 m map at once — each shot picks the
 * bearing that rakes ITS subject, which is exactly what a war artist does with the hour.
 */
export function setSun(ctx, t, azimuth) {
  if (ctx.world) ctx.world.sunT = t;
  Bus.emit('world:timeOfDay', { t, azimuth });
}

/** Back-compat alias — time of day only, leaves the sun's bearing alone. */
export function setTimeOfDay(ctx, t) { setSun(ctx, t, undefined); }

export function groundAt(ctx, x, z) {
  const w = ctx.world;
  if (w?.groundHeightAt) return w.groundHeightAt(x, z);
  if (w?.terrain?.heightAt) return w.terrain.heightAt(x, z);
  return 0;
}

/** Ground, but never below the river surface — a camera set over the channel must float on
 *  the water, not sink to the bed and end up looking out through the inside of the bank. */
export function surfaceAt(ctx, x, z) { return Math.max(groundAt(ctx, x, z), WATER_Y); }

/** The bridge deck height, straight from the layout that carved it. */
export function deckY(ctx) {
  const d = ctx.world?.layout?.bridge?.deckY;
  return typeof d === 'number' && d > 0 ? d : 6.0;
}

/** The yaw that makes something standing at (x,z) face (tx,tz). */
export function facing(x, z, tx, tz) { return Math.atan2(tx - x, tz - z); }

/**
 * Place a unit on the ground, facing `yaw`, and force an animation clip.
 * opts: { y, fade, aimYaw, aimPitch, phase } — `y` overrides the ground snap (a bridge deck),
 * `phase` pins the locomotion cycle so a running figure is caught at an authored stride
 * instead of wherever the frame count happened to leave it.
 */
export function pose(ctx, unit, x, z, yaw = 0, clip = 'idle', stance = STANCE.STAND, opts = {}) {
  if (!unit) return null;
  unit.pos.set(x, opts.y !== undefined ? opts.y : groundAt(ctx, x, z), z);
  unit.yaw = yaw;
  unit.aimYaw = opts.aimYaw !== undefined ? opts.aimYaw : yaw;
  unit.aimPitch = opts.aimPitch !== undefined ? opts.aimPitch : 0;
  unit.stance = stance;
  unit.deployed = true;
  unit.spotted = true;
  unit.actor?.play?.(clip, { fade: opts.fade !== undefined ? opts.fade : 0 });
  if (opts.phase !== undefined) stride(unit, opts.phase);
  unit.syncActor?.();
  // A VEHICLE ignores syncActor. TankPhysics owns root.position and root.rotation
  // and rewrites both from its own state inside Tank.update(), which runs after
  // us on every subsequent frame — so posing a tank the way we pose a soldier
  // moved the gameplay Unit and left the model wherever the simulation had
  // parked it at deployment. Every shot that "placed" the Edelweiss was in fact
  // photographing it at its spawn point. Drive the simulation instead, and pin
  // the brakes on so it cannot creep down a slope during the settle loop.
  const tank = unit.isVehicle ? unit.actor : null;
  if (tank?.teleport) {
    tank.teleport(x, z, yaw);
    tank.setThrottle?.(0);
    tank.setSteer?.(0);
    tank.setBrake?.(1);
    // Keep the gameplay Y in step with where the physics actually dropped it.
    if (opts.y === undefined) unit.pos.y = tank.root.position.y;
    if (tank.setAimAngles) tank.setAimAngles(unit.aimYaw - yaw, unit.aimPitch);
    // Slew is rate-limited at 1.15 rad/s; a scripted shot wants the turret
    // already there, not converging on it for the first two seconds.
    tank.turretYaw = tank.turretYawTarget;
    tank.gunPitch = tank.gunPitchTarget;
    tank.turret.rotation.y = tank.turretYaw;
    tank.gun.rotation.x = -tank.gunPitch;
  }
  if (unit.root) unit.root.visible = true;
  return unit;
}

/**
 * Traverse a vehicle's turret to an absolute world bearing and SNAP it there.
 *
 * The gameplay path only ever sets a target; Tank.update slews toward it at
 * 1.15 rad/s, and the settle loop is a quarter of a second. A shot that asks
 * for a 130-degree traverse and then photographs it gets 15 degrees.
 */
export function turretTo(unit, aimYaw, aimPitch = 0) {
  if (!unit) return unit;
  unit.aimYaw = aimYaw;
  unit.aimPitch = aimPitch;
  unit.syncActor?.();
  const tk = unit.isVehicle ? unit.actor : null;
  if (!tk || !tk.turret) return unit;
  tk.turretYaw = tk.turretYawTarget;
  tk.gunPitch = tk.gunPitchTarget;
  tk.turret.rotation.y = tk.turretYaw;
  tk.gun.rotation.x = -tk.gunPitch;
  return unit;
}

/** Pin a walk/run cycle to an authored phase (0 = left heel strike). */
export function stride(unit, phase) {
  const an = unit?.actor?.animator;
  if (an) an.phase = phase - Math.floor(phase);
  return unit;
}

export function aimCamera(camera, px, py, pz, tx, ty, tz, fov) {
  camera.position.set(px, py, pz);
  camera.lookAt(tx, ty, tz);
  if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

/**
 * The same thing in the units a framing is actually authored in: BOTH heights are metres
 * ABOVE THE GROUND under that point. An absolute look-at height is a trap on a heightfield —
 * "look at y = 3" is eye level down in the river channel and three metres underground up on
 * the ridge, so the pitch of the shot silently changes with whatever the terrain seed did.
 */
export function aimCameraG(ctx, px, py, pz, tx, ty, tz, fov) {
  aimCamera(ctx.camera,
    px, groundAt(ctx, px, pz) + py, pz,
    tx, groundAt(ctx, tx, tz) + ty, tz, fov);
}

export function unitNamed(ctx, name) {
  return ctx.battle.units.find((u) => u.name === name) || null;
}
export function firstOfClass(ctx, cls, team = 0) {
  return ctx.battle.units.find((u) => u.cls === cls && u.team === team) || null;
}

/** Bring the Battle to a usable state no matter which phase the harness caught it in. */
export function ensureBattle(ctx) {
  const b = ctx.battle;
  if (!b._setup) b.setup();
  if (!b.actionMode) b.attachCamera(ctx.camera);
  if (b.phase === 'briefing' || b.phase === 'deploy') b.beginBattle();
  b.interception.enabled = false;      // shots drive their own fire so they stay deterministic
  return b;
}

/** Freeze the game clock so the pose in the screenshot is exactly the pose we set. */
export function freeze(ctx) {
  if (ctx.engine) ctx.engine.paused = true;
}
export function unfreeze(ctx) {
  if (ctx.engine) ctx.engine.paused = false;
}

/**
 * Register a per-frame driver. Returns a disposer.
 * Prefer `finale()`: a live driver keeps the frame changing, which stops main.js's settle
 * loop from ever converging and leaves the particle ages at the mercy of that loop's length.
 */
export function driver(ctx, fn) {
  const sys = { update: fn };
  ctx.engine?.add(sys);
  return () => ctx.engine?.remove(sys);
}

/**
 * The last `n` frames before the shutter. main.js runs this AFTER the frame has settled, so a
 * particle spawned at frame `i` is exactly `n - i` frames old when the PNG is grabbed: a
 * muzzle flash lit at i = n-2 is still burning, a tracer lit at i = 0 is caught mid-flight.
 * This is the only honest way to photograph a firefight — waiting for a live driver to happen
 * to have something on screen makes the shot a function of how fast the GPU is.
 */
export function finale(ctx, n, fn) {
  ctx.finale = { frames: Math.max(1, n | 0), fn };
}

/**
 * A tracer caught in flight. `framesLeft` is how many finale frames remain before the shutter;
 * `frac` is how far along the shot line the streak should be sitting when it opens.
 */
export function heroTracer(fx, from, to, framesLeft, frac = 0.55, opts = {}) {
  if (!fx) return;
  const dist = from.distanceTo(to);
  if (dist < 0.5) return;
  const age = Math.max(1 / 60, framesLeft / 60);
  fx.tracer(from, to, Object.assign({
    speed: (dist * frac) / age,
    life: age * 2.4,
    // Fatter than a live round would draw: at forty metres a 35 mm streak is one pixel, and a
    // firefight the critic cannot see is not a firefight.
    width: 0.10,
    alpha: 1,
  }, opts));
}

/**
 * A standing column of smoke, already grown.
 *
 * TWO things have to be right or the column is invisible in a screenshot. The puffs must
 * spawn at their final size (a finale is six frames; a puff that inflates over three seconds
 * is still a dot when the shutter opens), and — the trap — their `life` must be short enough
 * that the shutter catches them past the shader's fade-in. fx.js ramps a puff's alpha over
 * the first tenth of its life, so a three-second puff photographed 0.1 s old is drawn at 5%
 * opacity. Life is therefore derived from the finale length: ~30% through, which is inside
 * the fully-opaque plateau and before the fade-out starts at 45%.
 */
export function smokeColumn(ctx, x, z, h = 7, n = 9, opts = {}) {
  const fx = ctx.fx;
  if (!fx) return;
  const y0 = opts.y !== undefined ? opts.y : groundAt(ctx, x, z);
  const life = ((opts.frames ?? 6) / 60) / 0.30;
  for (let i = 0; i < n; i++) {
    const k = n > 1 ? i / (n - 1) : 0;
    _v.set(x + (k - 0.3) * (opts.drift ?? 2.4), y0 + 0.4 + k * h, z + k * (opts.driftZ ?? 1.2));
    _d.set(0.1, 0.35, 0.05);
    fx.smokePuff(_v, _d, {
      size: (opts.size ?? 1.5) * (0.5 + k * 1.5),
      endSize: (opts.size ?? 1.5) * (0.7 + k * 1.8),
      life,
      alpha: (opts.alpha ?? 0.42) * (1 - k * 0.45),
      color: opts.color ?? 0x6f6459,
    });
  }
}

/** Hide every unit; shots opt models back in explicitly so framing is repeatable. */
export function hideAll(ctx) {
  for (const u of ctx.battle.units) { if (u.root) u.root.visible = false; u.deployed = false; }
}

function show(ctx, units) {
  for (const u of units) if (u) { u.deployed = true; if (u.root) u.root.visible = true; }
}

/**
 * Declare which UI a shot wants. This is not only the DOM HUD: `command` is the
 * one shot whose subject IS the tactical map, so every other mode also takes the
 * in-world annotation layer (movement wash, threat wash, fire arcs, cursor and
 * selection rings) down. Leaving it up paints map furniture across a shot that
 * is supposed to be looking at the world.
 */
function uiMode(ctx, mode) {
  Bus.emit('ui:captureMode', { mode });
  if (mode !== 'command') ctx.battle?.commandMode?.exit();
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export const SHOTS = {
  /**
   * Wide hero: the crossing from the eastern rise. Poplars close the left edge, the windmill
   * knoll closes the background, the bridge sits on the lower-left third and the mill town
   * runs along the upper right. Squad 7 comes up the near slope through the bottom third so
   * the landscape has a scale reference and a direction of travel.
   */
  async overview(ctx) {
    const b = ensureBattle(ctx);
    // Key almost straight down the road: the glacis of everything facing the crossing takes
    // the cream band and every left flank falls into violet, which is the split the band
    // quantiser needs before it can show a terminator at all.
    setSun(ctx, 0.26, 0.42);
    uiMode(ctx, 'none');
    b.setPhase('command');
    // Nothing is "acting" in a landscape, and a stale active unit drags the shadow frustum
    // off to wherever that soldier is standing — see updateLighting() in main.js.
    b.activeUnit = null;

    const bx = 4, bz = 4;                 // the crossing: everyone is looking at it

    // FOUR planes, near to far, and the frame is built out of them rather than around a
    // subject standing in the middle of a field:
    //   6 m   Alicia, on the left third, at 0.45 of frame height, walking away from the lens
    //   9-19 m the rest of the section, staggered across the middle band
    //   22 m  the Edelweiss, three-quarter, cropped by the right edge
    //   34 m+ the crossing, then the mill town on the far bank under its smoke
    // Every placement below is authored in CAMERA space (depth along the view axis, lateral
    // across it) and then converted, because "put him on the left third" is a statement about
    // the picture and not about the map.
    const hx = -7.7, hz = 30.1;
    pose(ctx, unitNamed(ctx, 'Alicia Melchiott'), hx, hz, facing(hx, hz, bx, bz),
      'walk', STANCE.STAND, { phase: 0.31 });

    const section = [
      ['Largo Potter', -8.0, 26.9, 'idle', STANCE.STAND, 0],
      ['Edy Nelson', -3.4, 26.7, 'walk', STANCE.STAND, 0.62],
      ['Rosie Stark', -9.43, 31.14, 'crouchIdle', STANCE.CROUCH, 0],
      ['Marina Wulfstan', 0.7, 19.7, 'walk', STANCE.STAND, 0.12],
    ];
    for (const [name, x, z, clip, stance, ph] of section) {
      pose(ctx, unitNamed(ctx, name), x, z, facing(x, z, bx, bz), clip, stance, { phase: ph });
    }
    const isara = unitNamed(ctx, 'Isara Gunther');
    if (isara) pose(ctx, isara, 0.4, 22.9, facing(0.4, 22.9, 2.90, 19.55) + 0.9, 'idle');

    // The Edelweiss halted on the shoulder, angled across the frame so it reads as a wedge
    // and not as a side elevation, gun traversed toward the town. It also gives the right
    // third of the frame something with hard edges and real value contrast in it.
    const tank = b.units.find((u) => u.isVehicle && u.team === 0);
    if (tank) {
      pose(ctx, tank, 2.90, 19.55, facing(2.90, 19.55, bx, bz) - 0.55, 'idle');
      turretTo(tank, facing(2.90, 19.55, 30, -30));
    }

    // The garrison, small, on the far bank — the frame's stakes, not its subject.
    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 6);
    const foeSpots = [[2, -13], [8, -15], [-4, -14], [14, -18], [19, -22], [-9, -13]];
    foe.forEach((u, i) => {
      const [x, z] = foeSpots[i % foeSpots.length];
      pose(ctx, u, x, z, facing(x, z, 2, 26), i % 2 ? 'crouchIdle' : 'idle',
        i % 2 ? STANCE.CROUCH : STANCE.STAND);
    });

    // Eye level on the lip of the south bank, pitched down about seven degrees so the sky
    // takes the top third and no more — the old framing gave forty-five per cent of the page
    // to an empty wash.
    aimCameraG(ctx, -8.8, 2.05, 36.3, -1.0, 1.55, 18.0, 40);

    finale(ctx, 6, (i) => {
      if (i === 0) {
        smokeColumn(ctx, 34, -46, 9, 8, { size: 1.9, alpha: 0.30, drift: 5, frames: 6 });
        smokeColumn(ctx, 18, -30, 6, 5, { size: 1.4, alpha: 0.22, drift: 3, frames: 6 });
      }
    });
    await frames(14);
  },

  /**
   * Hero of the crossing itself: three stone arches raking across the frame, the channel
   * running out of the bottom-left corner, the windmill on the skyline behind, an Imperial
   * picket dug in at the far bridgehead. Sun three-quarter left so the voussoirs and the
   * parapet each throw their own shadow down the spandrel.
   */
  async bridge(ctx) {
    const b = ensureBattle(ctx);
    // Low, and behind the span. The east face the camera sees therefore sits in the shade
    // band while the arch rings and the parapet carry a warm rim, which is the only way a
    // masonry vault reads as a curved solid rather than as a flat grey elevation.
    setSun(ctx, 0.17, -1.72);
    uiMode(ctx, 'none');
    hideAll(ctx);
    b.activeUnit = null;

    // A sentry standing on the span itself gives the arches their scale; the rest of the
    // picket is dug in where the road leaves the bridge on the north bank.
    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 3);
    show(ctx, foe);
    const spots = [[4.6, -1.0, 0.8], [6.0, -13.0, -0.4], [1.0, -14.5, 0.2]];
    foe.forEach((u, i) => {
      const [x, z, ry] = spots[i % spots.length];
      pose(ctx, u, x, z, facing(x, z, 16, 22) + ry, i === 2 ? 'crouchIdle' : 'idle',
        i === 2 ? STANCE.CROUCH : STANCE.STAND);
    });

    // Two of ours in the near-bank scrub, low right — the eye enters the frame there.
    const alicia = unitNamed(ctx, 'Alicia Melchiott');
    const largo = unitNamed(ctx, 'Largo Potter');
    show(ctx, [alicia, largo]);
    pose(ctx, alicia, 26.0, 24.0, facing(26, 24, 5, 4), 'crouchIdle', STANCE.CROUCH);
    pose(ctx, largo, 30.5, 27.0, facing(30.5, 27, 5, 4), 'crouchIdle', STANCE.CROUCH);

    // THREE-QUARTER, not broadside. Standing off the south-east corner of the crossing and
    // low — a metre and a half over the pool — puts the near abutment in the bottom-right
    // corner, runs the span away to the upper left at about fifty degrees to the lens, and
    // opens all three arches so you can see daylight through them. The channel comes out of
    // the bottom of the frame and leads straight into the near arch, and because the camera
    // is barely off the water the whole span gets a reflection under it.
    aimCamera(ctx.camera,
      17.5, Math.max(surfaceAt(ctx, 17.5, 26.5) + 0.30, WATER_Y + 1.35), 26.5,
      1.0, deckY(ctx) - 2.15, -2.0, 40);
    await frames(14);
  },

  /**
   * Four classes at conversational distance so silhouette, kit and uniform can be judged side
   * by side: scout, shocktrooper, lancer, engineer, staggered in depth on the approach road
   * with the crossing behind them. Chest-height camera, three-quarter key.
   */
  async squad(ctx) {
    ensureBattle(ctx);
    setSun(ctx, 0.28, 2.05);
    uiMode(ctx, 'none');
    hideAll(ctx);

    const alicia = unitNamed(ctx, 'Alicia Melchiott') || firstOfClass(ctx, 'scout', 0);
    const rosie = unitNamed(ctx, 'Rosie Stark') || firstOfClass(ctx, 'shock', 0);
    const largo = unitNamed(ctx, 'Largo Potter') || firstOfClass(ctx, 'lancer', 0);
    const isara = unitNamed(ctx, 'Isara Gunther') || firstOfClass(ctx, 'engineer', 0);
    show(ctx, [alicia, rosie, largo, isara]);

    // A loose arc on the flat ground east of the road: every one of them at a different
    // distance, a different angle to camera and a different stance, so nothing overlaps and
    // no two silhouettes repeat. They are turned across the lens, not toward it — a rank
    // facing the camera reads as a menu screen, not as a squad.
    // Halted on the span itself. Measured against the vegetation instancing, the bridge deck
    // is the only ground on this map with eight clear metres in every direction — everywhere
    // else a poplar trunk ends up growing straight through somebody's chest. It also gives
    // the group a plain stone floor and open sky, which is exactly what you want behind four
    // silhouettes that are meant to be compared.
    const dy = deckY(ctx);
    pose(ctx, rosie, 3.2, 15.5, facing(3.2, 15.5, -8.0, 16.5), 'idle', STANCE.STAND, { y: dy });
    pose(ctx, alicia, 6.0, 13.0, facing(6.0, 13.0, -6.0, 15.0) + 0.3, 'crouchIdle', STANCE.CROUCH,
      { y: dy });
    pose(ctx, largo, 2.6, 10.0, facing(2.6, 10.0, 14.0, 6.0), 'idle', STANCE.STAND, { y: dy });
    pose(ctx, isara, 5.6, 7.0, facing(5.6, 7.0, -6.0, 9.0) - 0.2, 'idle', STANCE.STAND, { y: dy });

    // Six to fifteen metres out on a portrait-length lens: near enough that webbing, belt and
    // collar read, far enough that all four silhouettes fit without overlapping.
    aimCamera(ctx.camera, 4.6, dy + 1.55, 21.5, 4.4, dy + 1.15, 12.0, 36);
    await frames(14);
  },

  /** Command Mode: tactical camera, movement range, threat overlay, HUD up. */
  async command(ctx) {
    const b = ensureBattle(ctx);
    setSun(ctx, 0.31, 1.30);
    uiMode(ctx, 'command');
    b.setPhase('command');
    const cm = b.commandMode;
    cm.enter();

    // Squad on the road shoulder south of the crossing, garrison dug in north of it, so the
    // bridge — the thing the mission is about — lies between them across the middle of frame.
    const squad = [
      ['Alicia Melchiott', 1.5, 21.0],
      ['Edy Nelson', -4.5, 24.5],
      ['Rosie Stark', 6.5, 25.0],
      ['Largo Potter', -8.0, 29.0],
      ['Isara Gunther', 10.5, 30.0],
      ['Marina Wulfstan', -1.0, 33.0],
    ];
    for (const [name, x, z] of squad) {
      pose(ctx, unitNamed(ctx, name), x, z, facing(x, z, 4, -10), 'idle');
    }
    const tank = b.units.find((u) => u.isVehicle && u.team === 0);
    pose(ctx, tank, 4.5, 34.0, facing(4.5, 34, 4, -10), 'idle');

    const foe = b.units.filter((u) => u.team === 1);
    const foeSpots = [[3, -7], [11, -11], [-4, -5], [15, -21], [6, -24], [26, -17],
      [23, -41], [35, -52], [30, -48], [50, -28], [25, -33]];
    foe.forEach((u, i) => {
      const [x, z] = foeSpots[i % foeSpots.length];
      pose(ctx, u, x, z, facing(x, z, 2, 20), 'idle');
      u.lastKnown.copy(u.pos);
      u.lastKnownTurn = b.turn;
    });

    const alicia = unitNamed(ctx, 'Alicia Melchiott');
    cm.select(alicia);
    cm.showThreat = true;
    // The overlays have to sit on something a reader can name. Focused on the CROSSING rather
    // than on the empty approach, at a shallower oblique and closer in, the frame under the
    // wash is bridge, river, road and the first row of frontages — drawn objects with edges —
    // instead of forty metres of unmodulated hillside.
    cm.focusOn(_v.set(4, 0, 6), true);
    cm.distWant = cm.dist = 52;
    cm.pitchWant = cm.pitch = -0.55;
    // Looking north, the way the player is attacking: our own section reads across the bottom
    // of the map, the crossing in the middle, their held ground at the top.
    cm.yawWant = cm.yaw = 0.34 + Math.PI;
    // A tactical map read through a lens is not a map. The pipeline switches its depth of
    // field on for this camera, and because the whole frustum falls outside the focus range
    // every fill in the frame is blurred while the ink composited on top of it stays razor
    // sharp — soft wash under hard line, which is the single thing a painting cannot do.
    if (ctx.pipeline && ctx.pipeline.dof) ctx.pipeline.dof.enabled = false;
    cm.buildMoveOverlay();
    cm.buildThreatOverlay();
    cm.buildFireArcs();
    cm.threatMesh.visible = true;
    cm.arcMesh.visible = true;
    cm.updateCamera(0.016);
    Bus.emit('cp:changed', { team: 0, cp: b.cp[0] || 7 });
    Bus.emit('turn:changed', { team: 0, turn: Math.max(1, b.turn) });
    Bus.emit('unit:selected', { unit: alicia });
    await frames(12);
  },

  /**
   * Over-the-shoulder, mid-assault: Alicia at a dead run for the bridgehead with the town in
   * front of her, the Imperial line firing back, tracers coming past her shoulder and a shell
   * burning in the ruins beyond.
   */
  async action(ctx) {
    const b = ensureBattle(ctx);
    setSun(ctx, 0.30, 1.55);
    uiMode(ctx, 'action');

    // On the road above the south end of the span, running for the crossing: the bridge and
    // the town are dead ahead of her, which is what puts stakes behind the shoulder. Far
    // enough back that the spring arm has open ground behind it — inside the bridge parapet
    // the collision pull-in buries the camera in masonry.
    const alicia = unitNamed(ctx, 'Alicia Melchiott') || firstOfClass(ctx, 'scout', 0);
    pose(ctx, alicia, 2.2, 32.0, Math.PI - 0.10, 'run', STANCE.STAND, { phase: 0.18 });

    const rosie = unitNamed(ctx, 'Rosie Stark');
    const largo = unitNamed(ctx, 'Largo Potter');
    pose(ctx, rosie, 7.5, 35.0, Math.PI - 0.05, 'crouchIdle', STANCE.CROUCH);
    pose(ctx, largo, -3.5, 35.5, Math.PI + 0.05, 'aim');

    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 5);
    const foeSpots = [[3.0, -13.0], [9.5, -15.5], [-3.5, -14.5], [15.0, -19.5], [6.0, -22.5]];
    foe.forEach((u, i) => {
      const [x, z] = foeSpots[i];
      pose(ctx, u, x, z, facing(x, z, 2.5, 20), i % 2 ? 'crouchIdle' : 'aim',
        i % 2 ? STANCE.CROUCH : STANCE.STAND);
    });

    b.setPhase('action');
    b.activeUnit = alicia;
    alicia.beginAction();
    const am = b.actionMode;
    am.enter(alicia);
    am.camYaw = Math.PI - 0.10;
    am.camPitch = -0.055;
    am.sprinting = true;
    am.speedSmoothed = alicia.classDef.speed.run;
    am.scriptedMove = { x: 0, y: 1 };
    alicia.speed = alicia.classDef.speed.run;
    // Let the spring arm converge on the shoulder.
    for (let i = 0; i < 24; i++) { am.updateCamera(1 / 60); await raf(); }
    b.interception.enabled = false;
    // Then STOP HER. She is still holding the run pose — the animator phase is pinned at
    // 0.18 below and again on every finale frame, so the picture is unchanged — but the
    // gameplay position stops advancing. Left running, the camera rides forward all the way
    // to the shutter, the foliage LOD keeps streaming in and out around it, and main.js's
    // settle loop never sees a stable draw list: this shot was the one shot in the set that
    // hit the 200-frame cap without ever converging, i.e. __READY__ fired on a frame that had
    // not finished loading. Frozen, it settles in well under the budget.
    am.scriptedMove = { x: 0, y: 0 };
    am.speedSmoothed = alicia.classDef.speed.run;   // keep the camera in its "sprinting" pose
    alicia.speed = 0;
    stride(alicia, 0.18);

    const shooters = [foe[0], foe[3]].filter(Boolean);
    finale(ctx, 6, (i) => {
      const fx = ctx.fx;
      if (!fx) return;
      if (i === 0) {
        smokeColumn(ctx, 14, -28, 15, 10, { size: 3.0, alpha: 0.5, drift: 5.5, frames: 6 });
        smokeColumn(ctx, -5, -18, 9, 6, { size: 1.8, alpha: 0.34, drift: 2, frames: 6 });
        for (const s of shooters) {
          s.muzzlePoint(_m);
          _t.set(alicia.pos.x - 1.1, alicia.pos.y + 1.35, alicia.pos.z + 1.2);
          heroTracer(fx, _m, _t, 6, 0.62);
        }
        // Rounds fired straight down the lens are invisible — they are a dot. These two are
        // aimed ACROSS the frame instead, so they read as streaks.
        const cross = [[foe[2], 22.0, 3.0, 14.0], [foe[3], -16.0, 2.6, 12.0]];
        for (const [s, tx, ty, tz] of cross) {
          if (!s) continue;
          s.muzzlePoint(_m);
          _t.set(tx, groundAt(ctx, tx, tz) + ty, tz);
          heroTracer(fx, _m, _t, 6, 0.62, { width: 0.14 });
        }
      }
      if (i === 4) {
        for (const s of shooters) {
          s.muzzlePoint(_m);
          alicia.centerPoint(_t);
          _d.subVectors(_t, _m).normalize();
          fx.muzzleFlash(_m, _d, s.weapon);
        }
      }
      stride(alicia, 0.18);
    });
    await frames(6);
  },

  /** Targeting mode: reticle, accuracy circle, hit-% on an Imperial holding the bridgehead. */
  async aim(ctx) {
    const b = ensureBattle(ctx);
    setSun(ctx, 0.31, 1.60);
    uiMode(ctx, 'aim');
    const shooter = unitNamed(ctx, 'Alicia Melchiott') || firstOfClass(ctx, 'scout', 0);
    const target = b.units.find((u) => u.team === 1 && !u.isVehicle);
    // Shooter crouched behind the bridge parapet, target dug in at the far bridgehead with
    // the ruined frontages behind him, so the reticle has something other than sky in it.
    pose(ctx, shooter, 5.0, 10.0, Math.PI, 'aim', STANCE.CROUCH);
    pose(ctx, target, 6.6, -14.0, 0.15, 'idle');

    const others = b.units.filter((u) => u.team === 1 && u !== target && !u.isVehicle).slice(0, 4);
    const spots = [[0.0, -16.0], [13.0, -18.0], [-5.5, -14.0], [18.0, -24.0]];
    others.forEach((u, i) => {
      const [x, z] = spots[i % spots.length];
      pose(ctx, u, x, z, facing(x, z, 5, 12), 'crouchIdle', STANCE.CROUCH);
    });

    b.setPhase('action');
    b.activeUnit = shooter;
    shooter.beginAction();
    const am = b.actionMode;
    am.enter(shooter);
    am.camYaw = Math.atan2(target.pos.x - shooter.pos.x, target.pos.z - shooter.pos.z);
    // Nose up a touch: at a level pitch the bridge deck in front of the shooter eats the
    // bottom third of the frame with nothing in it.
    am.camPitch = 0.035;
    am.enterAim();
    am.aimHold = shooter.weapon.settle * 0.72;   // partly converged — the circle is visible
    am.timeScale = am.timeScaleTarget = CFG.gameplay.aimSlowFactor;
    for (let i = 0; i < 30; i++) {
      am.fov = am.fovTarget; am.armLength = am.armTarget; am.shoulder = am.shoulderTarget;
      am.updateCamera(1 / 60);
      am.updateAimSolve(1 / 60);
      await raf();
    }
    finale(ctx, 5, (i) => {
      if (i === 0) smokeColumn(ctx, 18, -26, 11, 8, { size: 2.2, alpha: 0.34, drift: 4, frames: 5 });
    });
    await frames(6);
  },

  /**
   * Mid-firefight across the crossing. Camera at kneeling height off the left end of the
   * Gallian line: a shocktrooper firing, cropped, in the near third; the rest of the section
   * strung out behind the crater rim; the Imperial line and the burning town beyond; tracers
   * crossing the frame in both directions.
   */
  async firefight(ctx) {
    const b = ensureBattle(ctx);
    setSun(ctx, 0.29, 1.95);
    uiMode(ctx, 'action');

    // Our line along the top of the south bank, theirs along the north bank 40 m across the
    // water, with the bridge between them — the fight the whole mission is about.
    const line = [
      [unitNamed(ctx, 'Rosie Stark'), -11.0, 29.0, 'aim', STANCE.STAND],
      [unitNamed(ctx, 'Alicia Melchiott'), -6.0, 27.5, 'crouchIdle', STANCE.CROUCH],
      [unitNamed(ctx, 'Edy Nelson'), 0.0, 27.0, 'aim', STANCE.CROUCH],
      [unitNamed(ctx, 'Largo Potter'), 5.5, 27.5, 'aim', STANCE.STAND],
      [unitNamed(ctx, 'Isara Gunther'), 10.5, 29.0, 'crouchIdle', STANCE.CROUCH],
    ].filter((r) => r[0]);
    for (const [u, x, z, clip, stance] of line) {
      pose(ctx, u, x, z, facing(x, z, 6, -14), clip, stance, { aimPitch: 0.02 });
    }

    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 6);
    const foeSpots = [[2.0, -13.0], [8.0, -15.0], [-4.0, -14.0], [14.0, -18.0], [19.0, -22.0],
      [-9.0, -13.0]];
    foe.forEach((u, i) => {
      const [x, z] = foeSpots[i % foeSpots.length];
      pose(ctx, u, x, z, facing(x, z, 4, 25), i % 2 ? 'crouchIdle' : 'aim',
        i % 2 ? STANCE.CROUCH : STANCE.STAND, { aimPitch: 0.02 });
    });

    b.setPhase('action');
    b.activeUnit = line[0] && line[0][0];

    // Kneeling height at the left end of our own line, on a wide lens: the shocktrooper is
    // five metres off the lens and cropped, the section recedes to the right, the crossing
    // and the burning town fill the left, and the tracer traffic runs between the two.
    aimCameraG(ctx, -16.0, 1.75, 31.0, 16.0, 1.6, -2.0, 46);

    const rng = makeRng(0xF13E);
    finale(ctx, 7, (i) => {
      const fx = ctx.fx;
      if (!fx || !foe.length) return;
      if (i === 0) {
        smokeColumn(ctx, 19, -24, 14, 10, { size: 2.8, alpha: 0.40, drift: 6, frames: 7 });
        smokeColumn(ctx, 2, -13, 6, 5, { size: 1.4, alpha: 0.30, drift: 1.6, frames: 7 });
        // Outgoing, from our line into theirs.
        for (const [u] of line) {
          if (u.stance === STANCE.CROUCH) continue;
          const t = foe[(rng() * foe.length) | 0] || foe[0];
          u.muzzlePoint(_m);
          t.centerPoint(_t);
          heroTracer(fx, _m, _t, 7, 0.45 + rng() * 0.3);
        }
        // Incoming — these are the ones that cross the frame. Aimed at the bank around our
        // line rather than at a man, so they stay side-on to the lens and read as streaks.
        for (let k = 0; k < 4; k++) {
          const s = foe[(k * 2) % foe.length];
          const tx = -14.0 + k * 6.5, tz = 28.5 + k * 0.6;
          s.muzzlePoint(_m);
          _t.set(tx, groundAt(ctx, tx, tz) + 1.8 + rng() * 1.2, tz);
          heroTracer(fx, _m, _t, 7, 0.52 + k * 0.10, { width: 0.14 });
        }
      }
      if (i === 5) {
        for (const [u] of line) {
          if (u.stance === STANCE.CROUCH) continue;
          u.muzzlePoint(_m);
          _d.set(Math.sin(u.aimYaw), 0.02, Math.cos(u.aimYaw));
          fx.muzzleFlash(_m, _d, u.weapon);
        }
        for (let k = 0; k < 2; k++) {
          const s = foe[(k * 3) % foe.length];
          s.muzzlePoint(_m);
          _d.set(Math.sin(s.aimYaw), 0.02, Math.cos(s.aimYaw));
          fx.muzzleFlash(_m, _d, s.weapon);
        }
      }
    });
    await frames(10);
  },

  /** The Edelweiss, three-quarter low angle, crew alongside, the valley falling away behind. */
  async tank(ctx) {
    const b = ensureBattle(ctx);
    // The key sits almost square on the glacis and a few degrees off the left flank, so the
    // front plates take the cream band, the whole left side drops through the terminator into
    // violet, and the cast shadow rakes left across the road instead of hiding under the hull.
    setSun(ctx, 0.24, 0.93);
    uiMode(ctx, 'none');
    hideAll(ctx);
    b.activeUnit = null;
    const tank = b.units.find((u) => u.isVehicle && u.team === 0);
    const isara = unitNamed(ctx, 'Isara Gunther');
    const largo = unitNamed(ctx, 'Largo Potter');
    show(ctx, [tank, isara, largo]);

    // The camera, the Edelweiss, the crossing and the mill town are put on ONE LINE, sixty-six
    // metres of it, so the tank has a town behind it instead of a bare hillside: hull at ten
    // metres just left of centre, the bridge clipping the left edge, the village dead centre
    // in the haze. The old framing was a catalogue broadside against an empty slope.
    //
    // Hull yaw 0.50 is not arbitrary either. It puts the glacis normal exactly on the sun
    // bearing and the left flank exactly ON the terminator, so the two plates the camera can
    // see land in different bands — cream front, violet side — which is the whole point of a
    // quantised shader and something a side-on shot can never show.
    // It sits ON THE ROAD, and so does the camera. The road corridor is the only ground on
    // this map that is carved flat, and a low camera on a heightfield otherwise spends the
    // shot looking over the crest of whatever bank lies between it and the subject — which
    // buries the running gear, the one part of a tank that has to be visible.
    const tx = 2.6, tz = 19.96;
    pose(ctx, tank, tx, tz, 0.63, 'idle');
    // Gun raking across the frame to the right rather than pointing down the lens —
    // a barrel aimed at the camera is a circle.
    turretTo(tank, facing(tx, tz, 42, 2), 0.03);

    // Two crew, on two different depth planes: Largo cropped low-left four metres off the
    // lens, Isara eight metres out at the tank's shoulder.
    pose(ctx, largo, 0.89, 23.32, facing(0.89, 23.32, tx, tz) - 0.3, 'crouchIdle', STANCE.CROUCH);
    pose(ctx, isara, 5.71, 22.25, facing(5.71, 22.25, tx + 0.5, tz - 0.5), 'idle');

    // Ten metres out, at the chest height of a kneeling man, looking slightly UP at the
    // sponson line. A tank photographed from standing height is a diagram.
    aimCameraG(ctx, 2.73, 1.02, 28.51, tx, 1.34, tz, 38);

    finale(ctx, 5, (i) => {
      if (i !== 0 || !ctx.fx || !tank) return;
      // Idling exhaust off the rear deck, and the town burning behind.
      smokeColumn(ctx, 30, -42, 13, 9, { size: 3.0, alpha: 0.34, drift: 6, frames: 5 });
      _v.set(tx - 0.4, tank.pos.y + 1.5, tz + 2.0);
      _d.set(0.25, 0.9, 0.4);
      for (let k = 0; k < 4; k++) {
        _v.y += 0.35;
        ctx.fx.smokePuff(_v, _d, {
          size: 0.35 + k * 0.16, endSize: 0.6 + k * 0.2, life: 5,
          alpha: 0.3 - k * 0.05, color: 0x6b6158,
        });
      }
    });
    await frames(14);
  },

  /**
   * The mill town. Standing in the square looking down the row of frontages: broken timber
   * framing on the left, the gable at the end of the street catching the sun, Imperials in
   * cover along the way. Close enough to read brick, stucco and the pencil linework.
   */
  async village(ctx) {
    const b = ensureBattle(ctx);
    setSun(ctx, 0.33, 1.75);
    uiMode(ctx, 'none');
    hideAll(ctx);
    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 4);
    show(ctx, foe);
    const spots = [[24.0, -38.0, 0.4], [28.0, -42.0, 0.1], [20.0, -34.0, 1.0], [31.0, -47.0, -0.3]];
    foe.forEach((u, i) => {
      const [x, z, ry] = spots[i % spots.length];
      pose(ctx, u, x, z, facing(x, z, 44, -58) + ry, i % 2 ? 'crouchIdle' : 'idle',
        i % 2 ? STANCE.CROUCH : STANCE.STAND);
    });

    // Looking back up the market street from the far end of the square, so the frontages
    // recede in perspective instead of one wall filling the lens.
    aimCameraG(ctx, 48.0, 2.4, -62.0, 22.0, 3.2, -36.0, 40);

    finale(ctx, 5, (i) => {
      if (i === 0) smokeColumn(ctx, 26, -44, 13, 10, { size: 2.6, alpha: 0.36, drift: 6, frames: 5 });
    });
    await frames(14);
  },

  /** Portrait distance — this is the shot that judges the character model and the shading. */
  async closeup(ctx) {
    ensureBattle(ctx);
    setSun(ctx, 0.29, 2.15);
    uiMode(ctx, 'none');
    hideAll(ctx);
    const alicia = unitNamed(ctx, 'Alicia Melchiott') || firstOfClass(ctx, 'scout', 0);
    const rosie = unitNamed(ctx, 'Rosie Stark');
    show(ctx, [alicia, rosie]);
    pose(ctx, alicia, -2, 34, 0.55, 'idle', STANCE.STAND, { aimPitch: 0.03 });
    // A second figure well behind and to the side, thrown soft by the DoF, so the portrait
    // has a background instead of a wall of grass.
    pose(ctx, rosie, 4.5, 27.0, 1.6, 'idle');

    const head = alicia.headPoint(_v.clone());
    // Three-quarter, slightly below eyeline, 1.55 m out — the classic VC portrait framing,
    // with the head sitting on the upper-left third.
    const a = 0.55 - 1.05;
    aimCamera(ctx.camera,
      alicia.pos.x + Math.sin(a) * 1.55, head.y - 0.06, alicia.pos.z + Math.cos(a) * 1.55,
      head.x - 0.06, head.y - 0.13, head.z, 38);
    await frames(14);
  },

  /** Low camera looking through the riverbank scrub at a crouching scout. */
  async grass(ctx) {
    ensureBattle(ctx);
    setSun(ctx, 0.28, 2.30);
    uiMode(ctx, 'none');
    hideAll(ctx);
    const edy = unitNamed(ctx, 'Edy Nelson') || firstOfClass(ctx, 'scout', 0);
    const rosie = unitNamed(ctx, 'Rosie Stark');
    show(ctx, [edy, rosie]);
    // Inside the fallow field south-west of the deployment (layout.fields).
    pose(ctx, edy, -19.0, 62.0, Math.PI + 0.15, 'crouchWalk', STANCE.CROUCH, { phase: 0.42 });
    pose(ctx, rosie, -13.4, 65.5, Math.PI + 0.25, 'crouchIdle', STANCE.CROUCH);

    const cx = -19.4, cz = 68.5;
    aimCamera(ctx.camera, cx, groundAt(ctx, cx, cz) + 0.30, cz,
      edy.pos.x + 0.4, edy.pos.y + 0.92, edy.pos.z, 40);
    await frames(12);
  },

  /**
   * Last light. The valley raked from the west, every hedge and every soldier trailing a
   * shadow the length of a field, the town on the far bank going to violet.
   */
  async dusk(ctx) {
    const b = ensureBattle(ctx);
    // ACTUAL dusk. At t = 0.87 the sun is still twenty-eight degrees up and the ramp has
    // barely left afternoon, which is why the last pass read as hazy daylight; 0.925 puts it
    // at seventeen degrees on the ember end of the ramp, and that is where the shadows get
    // long enough to be the subject. Bearing is set eight degrees off the lens axis so the
    // squad is contre-jour — rim on every helmet, shadows running straight at the camera and
    // then raking left across the field.
    setSun(ctx, 0.955, -2.14);
    uiMode(ctx, 'none');
    b.setPhase('command');
    b.activeUnit = null;
    // Laid out in CAMERA space and converted: depth 8 to 27 metres, laterals alternating
    // either side of the axis, so the section reads as a section strung across the field
    // rather than as a row, and nobody hides behind anybody.
    const squad = [
      ['Rosie Stark', 28.1, 39.1],
      ['Isara Gunther', 18.6, 42.2],
      ['Alicia Melchiott', 21.7, 37.9],
      ['Largo Potter', 24.2, 30.3],
      ['Edy Nelson', 13.8, 32.2],
      ['Marina Wulfstan', 16.7, 24.4],
    ];
    for (const [name, x, z] of squad) {
      pose(ctx, unitNamed(ctx, name), x, z, facing(x, z, 4, 2), 'idle');
    }
    const tank = b.units.find((u) => u.isVehicle && u.team === 0);
    pose(ctx, tank, 17.97, 37.3, facing(17.97, 37.3, 4, 2) - 0.35, 'idle');
    turretTo(tank, facing(17.97, 37.3, -6, 10));

    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 5);
    const foeSpots = [[3, -7], [11, -11], [-4, -5], [15, -20], [6, -23]];
    foe.forEach((u, i) => {
      const [x, z] = foeSpots[i];
      pose(ctx, u, x, z, facing(x, z, 8, 24), 'idle');
    });

    // Down off the eleven-metre map camera and onto the field. From here the squad is ten to
    // twenty-five metres out with a whole field of shadow in front of them, the crossing sits
    // on the far third and the town goes violet behind it.
    aimCameraG(ctx, 30.0, 2.45, 48.0, 14.6, 0.6, 23.8, 38);

    finale(ctx, 6, (i) => {
      if (i === 0) smokeColumn(ctx, 34, -46, 11, 9, { size: 2.2, alpha: 0.32, drift: 5, frames: 6 });
    });
    await frames(14);
  },
};

export const SHOT_NAMES = Object.keys(SHOTS);

/**
 * Run a named shot. Unknown names fall back to `overview` so the harness never hangs.
 * Resolves when the pose is set; main.js then settles the frame and runs `ctx.finale`.
 */
export async function runShot(name, ctx) {
  const fn = SHOTS[name] || SHOTS.overview;
  ctx.finale = null;
  await fn(ctx);
  await frames(3);
  if (typeof window !== 'undefined') {
    window.__STATS__ = Object.assign({}, window.__STATS__, {
      shot: name,
      units: ctx.battle?.units.length ?? 0,
      phase: ctx.battle?.phase ?? null,
      turn: ctx.battle?.turn ?? 0,
    });
  }
  return true;
}

export default SHOTS;
