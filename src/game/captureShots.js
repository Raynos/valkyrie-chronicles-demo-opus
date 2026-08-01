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
 * Author a staging in CAMERA SPACE and get map coordinates back.
 *
 * Every composition note in this file — "on the left third", "four metres off the lens",
 * "cropped by the right edge" — is a statement about the PICTURE, and a picture has two
 * axes: how far down the view ray something is, and how far across it. Map x/z has neither.
 * Hand-converting them is where the round-2 framings went wrong: a soldier authored as
 * "near foreground" ended up twenty-seven metres out because the lens had been re-aimed
 * since and nobody redid the trigonometry.
 *
 * `at(depth, lateral)` returns `[x, z]` for a point `depth` metres down the view axis from
 * the lens and `lateral` metres to screen-RIGHT of it. `halfWidth(depth, fovDeg, aspect)`
 * is how many metres of lateral the frame actually holds at that depth, so a lateral can be
 * quoted as a fraction of the frame instead of guessed.
 */
export function staging(cx, cz, tx, tz) {
  const dx = tx - cx, dz = tz - cz;
  const inv = 1 / Math.max(1e-6, Math.hypot(dx, dz));
  const fx = dx * inv, fz = dz * inv;
  const rx = -fz, rz = fx;                   // cross(forward, +Y), normalised
  return {
    at: (depth, lateral = 0) => [cx + fx * depth + rx * lateral, cz + fz * depth + rz * lateral],
    halfWidth: (depth, fovDeg, aspect = 16 / 9) =>
      depth * Math.tan((fovDeg * Math.PI) / 360) * aspect,
  };
}

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

/**
 * Aim by PITCH, which is the only unit a framing is ever actually authored in.
 *
 * aimCameraG() takes a look-at height above the ground UNDER THE TARGET, and on a heightfield
 * that silently couples the pitch of the shot to the elevation difference between two points
 * that may be twenty-five metres apart. The `squad` reframe is the worked example: a lens 1.5 m
 * over the road shoulder, asked to look at 0.35 m over a point down by the river, came out
 * pitched fourteen degrees DOWN and photographed the bridge deck from above like a site plan.
 * "Three degrees below the horizontal" is what the framing means and it is what this takes.
 *
 * @param {number} eye    metres above the ground under the lens
 * @param {number} pitch  degrees below horizontal (positive looks down)
 */
export function aimCameraPitch(ctx, cx, cz, eye, tx, tz, pitch, fov) {
  const camY = groundAt(ctx, cx, cz) + eye;
  const dist = Math.hypot(tx - cx, tz - cz);
  aimCamera(ctx.camera, cx, camY, cz,
    tx, camY - dist * Math.tan((pitch * Math.PI) / 180), tz, fov);
}

/**
 * The first of `fracs` (laterals, as fractions of the half-width at `depth`) that lands on
 * ground a man could stand on rather than in the river.
 *
 * A camera-space staging says WHERE IN THE PICTURE something should be; it knows nothing
 * about the heightfield under that point. On a shot framed across a pool that is exactly
 * how you end up with two riflemen apparently standing on the water — which is what the
 * first pass of `bridge` did with them at +0.44 and +0.66 of half-width. Ask the terrain.
 */
export function dryLateral(ctx, S, depth, fracs, fovDeg) {
  const hw = S.halfWidth(depth, fovDeg);
  for (const f of fracs) {
    const [x, z] = S.at(depth, hw * f);
    if (groundAt(ctx, x, z) > WATER_Y + 0.35) return [x, z];
  }
  return S.at(depth, hw * fracs[fracs.length - 1]);
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
function uiMode(ctx, mode, caption) {
  Bus.emit('ui:captureMode', { mode, caption });
  if (mode !== 'command') ctx.battle?.commandMode?.exit();
}

/**
 * The world shots run in `field` mode: the REAL in-battle HUD.
 *
 * History, because this has been wrong twice. Round 3 hid the whole HUD host on
 * overview / bridge / tank / squad / dusk, and every one of them scored the hud
 * axis at ZERO — not for anything the HUD did, but because there was none of it
 * in the frame. The answer to that was `plate` mode, which dressed those shots in
 * the book's own furniture: a deckled outer rule, corner flourishes, a chapter
 * bookmark, a gummed "Chapter II / The Crossing at Vasel / Plate VII" running
 * head and a pencilled "Plate VII — Sergeant Melchiott, before the crossing"
 * caption slip in the lower margin. It scored well and it was still wrong: the
 * success test for this project is a BLIND SIDE-BY-SIDE against a real Valkyria
 * Chronicles Remastered screenshot, and a paper-bordered page with a handwritten
 * caption is a mock-up of a book page. It gives the frame away in under a second
 * however good the render underneath is. On `action` and `aim` the furniture was
 * sitting over live gameplay, on top of the AP gauge and the unit slips.
 *
 * The right fix for a HUD-less frame is to show the HUD. Valkyria has its battle
 * interface on screen at ALL times, so `field` puts up what it puts up: the
 * selected soldier's name and class plate, his AP gauge, the control strip and
 * the world name slips, and no page furniture at all. The book styling itself is
 * untouched and still drives the chapter / briefing / journal screens in
 * ui/screens.js, where a book page is exactly what is wanted.
 */
function field(ctx) {
  uiMode(ctx, 'field');
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
    field(ctx);
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
    // THE DOLLY (see the lens note at the bottom of this shot). The lens moves 5 m along
    // -screen-right to swing the near copse off the picture; the section and the tank move
    // WITH it, by the same vector, so their screen positions are unchanged and only the
    // world-fixed trees swing. Moving the lens alone shoved the whole squad into the
    // right-hand corner and inside the drawing falloff's drained margin — measured.
    const DX = -4.4, DZ = -2.35;

    const hx = -7.7 + DX, hz = 30.1 + DZ;
    pose(ctx, unitNamed(ctx, 'Alicia Melchiott'), hx, hz, facing(hx, hz, bx, bz),
      'walk', STANCE.STAND, { phase: 0.31 });

    const section = [
      ['Largo Potter', -8.0, 26.9, 'idle', STANCE.STAND, 0],
      ['Edy Nelson', -3.4, 26.7, 'walk', STANCE.STAND, 0.62],
      ['Rosie Stark', -9.43, 31.14, 'crouchIdle', STANCE.CROUCH, 0],
      ['Marina Wulfstan', 0.7, 19.7, 'walk', STANCE.STAND, 0.12],
    ];
    for (const [name, x0, z0, clip, stance, ph] of section) {
      const x = x0 + DX, z = z0 + DZ;
      pose(ctx, unitNamed(ctx, name), x, z, facing(x, z, bx, bz), clip, stance, { phase: ph });
    }
    const tx = 2.90 + DX, tz = 19.55 + DZ;      // the Edelweiss, dollied with everything else
    const isara = unitNamed(ctx, 'Isara Gunther');
    if (isara) {
      const ix = 0.4 + DX, iz = 22.9 + DZ;
      pose(ctx, isara, ix, iz, facing(ix, iz, tx, tz) + 0.9, 'idle');
    }

    // The Edelweiss halted on the shoulder, angled across the frame so it reads as a wedge
    // and not as a side elevation, gun traversed toward the town. It also gives the right
    // third of the frame something with hard edges and real value contrast in it.
    const tank = b.units.find((u) => u.isVehicle && u.team === 0);
    if (tank) {
      pose(ctx, tank, tx, tz, facing(tx, tz, bx, bz) - 0.55, 'idle');
      turretTo(tank, facing(tx, tz, 30, -30));
    }

    // The garrison, small, on the far bank — the frame's stakes, not its subject.
    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 6);
    const foeSpots = [[2, -13], [8, -15], [-4, -14], [14, -18], [19, -22], [-9, -13]];
    foe.forEach((u, i) => {
      const [x, z] = foeSpots[i % foeSpots.length];
      pose(ctx, u, x, z, facing(x, z, 2, 26), i % 2 ? 'crouchIdle' : 'idle',
        i % 2 ? STANCE.CROUCH : STANCE.STAND);
    });

    // UP AND BACK, because the world grew. Round 2's eye-level lens on the lip of the south
    // bank worked when the poplars along the approach were saplings; this round they are
    // full-grown, and from 2 m two of them stood dead in front of the crossing and turned the
    // best-scoring frame in the set into a hedge. Five metres up and six west clears the
    // canopy and turns those same trees into what they should have been all along — a mass
    // closing the RIGHT edge, with the river leading out of the bottom-left corner, the
    // crossing on the left third, the mill town along the top and the section coming up the
    // near bank through the foreground.
    // R25: the copse did not close the right edge, it sliced the right HALF. Three bare
    // trunks ran the full height of the frame at roughly x = 1050, 1370 and 1520 of 1920,
    // cutting the picture into vertical bands and putting the Edelweiss behind one of them.
    // No reference frame does that — vc-072 and vc-092 keep near trees at the EDGE as a
    // repoussoir, never through the subject.
    //
    // Fixed with parallax rather than by deleting trees (the world is another agent's file,
    // and the trunks are correct scenery in the wrong place on ONE lens). The lens axis runs
    // f = (0.47, -0.88) with screen-right r = (0.88, 0.47); translating BOTH the eye and the
    // look-at by -5 m along r is a pure lateral dolly, so the framing of the far bank is
    // unchanged while near objects swing hard. The offending trunks sit ~12 m out, so the
    // dolly swings them from 12-26 deg off-axis to 42-54 deg, i.e. clean off a 34.3 deg
    // half-field; the Edelweiss at 26 m only moves from 0.36 to 0.58 of the half-field.
    //
    // It has to be a TRUE dolly, so both heights are taken at the ORIGINAL two points and
    // carried across unchanged. Routing the moved look-at through aimCameraG instead puts it
    // over the river channel, whose ground is four metres lower, and the shot silently
    // pitches down: measured, that framing lost the whole mill town off the top edge and gave
    // the bottom-left half of the page to an empty grass bank. That is exactly the
    // heightfield trap aimCameraG's own docstring names.
    const EX = -14.0, EZ = 40.0, TX = 1.0, TZ = 12.0;   // DX/DZ = -5 m along right (0.88,0.47)
    const eyeY = groundAt(ctx, EX, EZ) + 5.20;
    const lookY = groundAt(ctx, TX, TZ) + 1.00;
    aimCamera(ctx.camera, EX + DX, eyeY, EZ + DZ, TX + DX, lookY, TZ + DZ, 42);

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
    // THE OLD KEY LIT NOTHING THE LENS COULD SEE. t 0.17 / azimuth -1.72 resolves to a sun
    // bearing of -2.10 rad — almost exactly opposite the camera-facing east elevation — so
    // every stone surface in the frame, 35% of the canvas, landed in the same shade band and
    // measured one hue (lit spandrel 268 deg, intrados 273, retaining wall 270) at a flat
    // 0.68 value ratio. A masonry vault with no terminator on it is a grey elevation drawing.
    //
    // Re-solved for the new three-quarter below. The spandrel the camera sees faces roughly
    // +X+Z; at t = 0.19 the elevation is 0.66 rad and a bearing of AZ = 0.62 puts that face
    // at n.L = 0.62 (top band, warm) while the arch INTRADOS — which faces down and away —
    // stays at -0.2 (violet). That is a terminator running round every voussoir ring, which
    // is the only thing that makes a stone arch read as a curved solid.
    setSun(ctx, 0.19, 0.977);
    field(ctx);
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

    // THREE-QUARTER, not broadside — and this time actually three-quarter. The round-2 frame
    // stood at (17.5, 26.5) and aimed at (1, -2): the span runs along the road bearing, so
    // that view axis met it at barely twenty degrees and what came out was a flat elevation
    // with the arches stacked edge-on behind one another. Swinging round to the south-EAST
    // corner of the pool and aiming up the channel meets the span at close to fifty degrees,
    // which is what opens all three rings so you can see daylight through them, and puts the
    // near abutment in the bottom-right corner as a foreground mass.
    const CX = 25.5, CZ = 22.0, TX = 0.5, TZ = -3.0;
    const S = staging(CX, CZ, TX, TZ);

    // Two of ours in the near-bank scrub, lower right — the eye enters the frame there.
    // Authored in camera space so they LAND there: at 9 and 13 metres, right of the axis,
    // they occupy the near third instead of being two ten-pixel blobs on the deck.
    const alicia = unitNamed(ctx, 'Alicia Melchiott');
    const largo = unitNamed(ctx, 'Largo Potter');
    show(ctx, [alicia, largo]);
    // 15 and 20 metres, not 8 and 12: the lens sits 1.6 m over a pool whose bank falls away
    // in front of it, so a figure standing on that bank at eight metres is BELOW the bottom
    // of the frame — which is exactly where the first two passes put them (two scalps in the
    // bottom-right corner). Back them off until the bank has risen into shot, and let
    // dryLateral() pick which side of the axis is actually land: half of this frame is open
    // water and a lateral chosen off the picture alone put both of them standing on it.
    const [ax, az] = dryLateral(ctx, S, 15.0, [-0.30, -0.52, 0.44, -0.70], 38);
    const [gx, gz] = dryLateral(ctx, S, 20.0, [-0.52, -0.72, 0.62, -0.30], 38);
    pose(ctx, alicia, ax, az, facing(ax, az, 5, 4), 'crouchIdle', STANCE.CROUCH);
    pose(ctx, largo, gx, gz, facing(gx, gz, 5, 4), 'idle');

    // AND OUT OF THE GRASS. The lens used to sit 0.30 m over ground carrying a 0.9 m sward,
    // i.e. INSIDE it, which filled the bottom-left quarter with 40-px-wide flat blade slabs.
    // 1.6 m clears the canopy and is still low enough that the whole span carries a
    // reflection under it on the pool.
    aimCamera(ctx.camera,
      CX, Math.max(surfaceAt(ctx, CX, CZ) + 1.60, WATER_Y + 2.35), CZ,
      TX, deckY(ctx) - 2.30, TZ, 38);
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
    field(ctx);
    hideAll(ctx);

    const alicia = unitNamed(ctx, 'Alicia Melchiott') || firstOfClass(ctx, 'scout', 0);
    const rosie = unitNamed(ctx, 'Rosie Stark') || firstOfClass(ctx, 'shock', 0);
    const largo = unitNamed(ctx, 'Largo Potter') || firstOfClass(ctx, 'lancer', 0);
    const isara = unitNamed(ctx, 'Isara Gunther') || firstOfClass(ctx, 'engineer', 0);
    show(ctx, [alicia, rosie, largo, isara]);

    // OFF THE BRIDGE.
    //
    // Round 3 stood the section on the span because the deck is the only ground on the map
    // with eight clear metres in every direction, and it cost the frame the same note for the
    // second round running: "~40% of the frame to a bare deck". That is not a staging problem
    // that a better stagger fixes — a bridge deck is a 8.4 m wide slab of one pale material
    // with no vertical incident in it anywhere, so ANY arrangement of four men on it leaves
    // the rest of it empty, and the emptier half is always the near half because that is
    // where the perspective puts the most pixels per square metre.
    //
    // The road corridor between the poplar avenue and the bridgehead has the opposite
    // property. It is carved flat (so nobody stands on a slope), the avenue closes BOTH
    // vertical edges of the frame with trunk and canopy, the crossing and the mill town close
    // the top, the verge grass and the cart ruts fill the bottom — and the section stands in
    // the middle of all that instead of on an empty table. Same four silhouettes, four depth
    // planes, and nothing in the frame that is not drawn.
    // ...and the lens turns its back on the crossing entirely.
    //
    // Two rounds of restaging this frame on and around the bridge produced the same note both
    // times, and the reason is a property of the object rather than of the staging: a deck is
    // 8.4 m of one pale material with no vertical incident anywhere in it, so wherever it
    // falls in the frame it is an empty region, and an eye-height lens aimed down any flat
    // corridor puts the largest, nearest, emptiest part of that corridor across the bottom of
    // the picture. Photographing the bridge from the far bank only moved the empty part.
    //
    // The poplar avenue is the same corridor with the opposite property. It is the same
    // carved-flat road, so nobody stands on a slope; but it has 15 m trunks at 3 m intervals
    // down both sides, which close BOTH vertical edges, break the sky into fragments, and
    // throw barred shadows across the surface that is otherwise the problem. Looking SOUTH
    // down it, the crossing is behind the camera, the southern ridge closes the top, and
    // there is no flat pale plane anywhere in the frame.
    // Depths chosen against the vertical field, not picked by eye: at 1.48 m of lens height
    // and 3.2 degrees of down-pitch a standing man is cropped at the knee at 3.4 m, whole and
    // frame-filling at 6.4, half-height at 11 and a third at 16.5. That IS the depth ladder —
    // the near man fills the lower-left third, and by the time the eye reaches the fourth
    // there is bridge parapet behind him.
    //
    // AND THE LENS COMES OFF THE SPAN. groundAt() honours the bridge platform, so a camera
    // authored at z = 8 stood ON the deck and photographed exactly the paving this framing
    // exists to avoid. z = 19 is the road shoulder above the south abutment, inside the
    // avenue, on carved earth.
    const FOV = 38, CX = 3.0, CZ = 19.0, TX = -1.8, TZ = 46.0;
    const S = staging(CX, CZ, TX, TZ);
    const put = (u, d, f, clip = 'idle', st = STANCE.STAND) => {
      const [x, z] = S.at(d, S.halfWidth(d, FOV) * f);
      // Facing back down the road toward the crossing, i.e. roughly at the lens and a little
      // across it — three-quarter, which is the only angle at which a uniform reads.
      return pose(ctx, u, x, z, facing(x, z, CX + (f < 0 ? 5 : -5), CZ - 2), clip, st);
    };
    // A REPOUSSOIR THAT STILL HAS FEET.
    //
    // Round 4's near man stood at 2.4 m, which on a 38-degree lens 1.52 m up crops a
    // standing figure across the upper thigh — deliberately, as foreground mass. The
    // critique's answer was blunt and correct: this is the plate whose entire job is to
    // let four SILHOUETTES be judged side by side, and the focal one had "neither feet
    // nor ground contact visible", so the anchoring work that landed elsewhere was
    // invisible on the one figure anybody would look at.
    //
    // The depth is solvable rather than guessable. The bottom edge of a 38-degree
    // vertical field nosed 2.2 degrees down runs 21.2 degrees below the horizontal; a
    // lens at eye height E sees a man's boots at atan(E / d). Requiring 60 px of clear
    // page under the sole on a 1080-line frame (28.4 px per degree) means
    //     atan(1.52 / d) <= 21.2 - 2.1 degrees  ->  d >= 4.4 m.
    // 5.2 m leaves 116 px of margin and still gives him 19.5 degrees of the 38 the frame
    // has, i.e. he owns half its height — which is every bit as much foreground mass as
    // the crop was buying, without the amputation.
    //
    // AND THE OTHER NEAR CORNER GETS ONE TOO.
    //
    // With one near figure on the left and the next at 8.2 m, the lower RIGHT quadrant of
    // this plate was 3-8 m of road surface and verge with nothing standing in it — the same
    // "large empty region" note the bridge deck used to earn, moved rather than cured, and
    // still worth composition 6. The lancer comes forward to 3.6 m and two-thirds of the way
    // to the right edge. At that depth he is 72% of the page tall, so his mass closes the
    // corner outright, and the same arithmetic that keeps Rosie's boots on the page keeps
    // his: the bottom edge runs 21.4 degrees below horizontal and atan(1.20 / 3.6) is 18.4,
    // leaving 85 px of drawn ground under his soles. The four silhouettes now read at four
    // clearly different scales — 72%, 56%, 24%, 16% of page height — which is the depth
    // ladder this plate exists to show, rather than four men at nearly one size.
    //
    // ROUND 7: AND THE HOLE MOVES OUT OF THE MIDDLE OF THE PAGE.
    //
    // Round 6 scored this plate composition 6 against `overview`'s 8, and the
    // reason is measurable rather than a matter of taste: with the lancer on the
    // right third at 3.6 m, the shocktrooper on the left at 4.9 and the scout
    // ELEVEN metres back, the wedge of ground between them — roughly x 550-1300,
    // y 500-1050, a fifth of the whole page — held nothing but beaten road. That
    // is the "large empty region" automatic rejection, and it was in the exact
    // place the eye enters the picture.
    //
    // The scout comes forward to 7.2 m and onto the axis. Crouched, at that
    // depth, she is ~38% of the page tall and her mass lands squarely in the
    // hole; the depth ladder is still four clearly different rungs (3.6 / 4.9 /
    // 7.2 / 15.0 m, i.e. 72% / 56% / 38% / 18% of page height) and the reading
    // order now runs lancer -> scout -> shocktrooper -> engineer in a Z across
    // the plate instead of left-right across an empty middle.
    put(largo, 3.6, 0.66);                           // lancer, near right, launcher across
    put(rosie, 4.9, -0.52);                          // shocktrooper, whole, boots down
    put(alicia, 7.4, 0.12, 'crouchIdle', STANCE.CROUCH);    // scout, into the middle
    put(isara, 13.5, -0.18);                         // engineer, against the sky gap

    // Chest height, nosed down 2.2 degrees — in DEGREES, not in metres above the ground
    // under a point thirty metres away and four lower (see aimCameraPitch; getting that
    // wrong is what photographed this road from above like a site plan on the first
    // attempt). It puts the horizon a little above the middle, the canopy across the top
    // third and the road's own ruts under the near man's boots.
    // ...AND THE LENS DROPS INTO THE SWARD.
    //
    // At 1.52 m the bottom third of this frame was 3-8 m of beaten road surface with
    // nothing standing in it — the same "large empty region" the bridge deck used to
    // supply, just moved. A lens at 1.20 m puts the bottom edge on ground 3.0 m out
    // instead of 3.8, which is inside the verge sward rather than beyond it, so the
    // foreground is grass heads and cart ruts crossing the plate instead of open metal.
    // It also raises the near man's apparent height to 56% of the page while KEEPING his
    // boots and 199 px of clear ground under them.
    aimCameraPitch(ctx, CX, CZ, 1.20, TX, TZ, 2.6, FOV);
    await frames(14);
  },

  /**
   * Command Mode: tactical camera, movement range, threat overlay, HUD up.
   *
   * THIS IS A DIFFERENT LIGHTING PROBLEM FROM EVERY OTHER SHOT AND IT HAD NEVER
   * BEEN GIVEN ONE.
   *
   * Round 4 scored it atmosphere 2, form 2, materials 3, hatching 2 — the worst
   * card in the set — and all four have the same cause. A map camera looks at
   * ground, and ground is horizontal, so under the old near-noon key (t 0.31 is
   * 57 degrees of elevation) EVERY square metre in the frame returned the same
   * N.L. The band drive is a function of N.L; one N.L is one band; one band is
   * a flat wash with no terminator, no cast shadow, no hatching (which is gated
   * on band index) and nothing for the eye to read as relief. It was not that
   * the shading was wrong — there was no shading event in the frame at all.
   *
   * The fix is the hour, and it is solvable rather than guessable. The map lens
   * below looks north-west, ground forward f = (-0.6, -0.8), so screen-right is
   * r = (0.8, -0.6). A sun at bearing AZ throws its shadows along
   * s = (-sin AZ, -cos AZ), giving
   *     s.r = -0.8 sin AZ + 0.6 cos AZ      (how far ACROSS the frame)
   *     s.f =  0.6 sin AZ + 0.8 cos AZ      (how far INTO it)
   * AZ = -0.75 returns s.r = +0.98 — every shadow on the map rakes the full
   * width of the page to screen-right, which is the only way a shadow has any
   * apparent length at all under a camera looking down at it — with s.f = +0.18,
   * i.e. the sun still ten degrees in FRONT of the lens, so the counters, the
   * tank, the parapets and the bank crests all keep a warm rim on their near
   * edge.
   *
   * t = 0.20 puts the sun at 41 degrees. Low enough that the two banks, the
   * cutting the road runs in and the bridge's own spandrels each throw a shape;
   * high enough that the map is still a map and not a nocturne. azimuth is then
   * AZ - (t - 0.5) * 1.15 = -0.405.
   */
  async command(ctx) {
    const b = ensureBattle(ctx);
    setSun(ctx, 0.20, -0.405);
    uiMode(ctx, 'command');
    b.setPhase('command');
    const cm = b.commandMode;
    cm.enter();

    // THE MAP IS ABOUT THE CROSSING, SO THE CROSSING IS IN IT.
    //
    // Round 4 put the section thirty metres NORTH of the bridge and pointed the lens
    // further north still, which threw the one drawn object on the map — three stone
    // arches, a cutting, two banks and a river — clean off the bottom edge and left the
    // middle of the picture as forty metres of unmodulated hillside with a movement wash
    // painted over it. "Composition 5" was the note and an empty region was the reason.
    //
    // The situation staged here is the one the mission is actually in at turn one: the
    // section up on the SOUTH bank either side of the road head, the Edelweiss at the
    // south abutment, the Imperial line dug in across the water among the first
    // frontages. The river then runs across the picture as a diagonal, the bridge is the
    // focal object on it, and there is a counter on both sides of the thing they are
    // fighting over — which is what a staff map is FOR.
    //
    // AND THE LENS LOOKS ALONG THE VALLEY, NOT SQUARE ACROSS IT.
    //
    // The river at this crossing runs east-west with open water over z = 0..14, the south
    // bank crest at z ~ 16 and the north bank at z ~ -5. A map camera aimed due north
    // meets all three of those as horizontal stripes, which is the least interesting
    // thing a river can do to a picture and leaves both banks parallel to the frame edge.
    // Swung round to the south-east and aimed north-west, the same three features cross
    // the page as a diagonal, the span cuts that diagonal at an angle, and the near bank
    // enters bottom-right while the village leaves top-left — the compositional skeleton
    // the `bridge` and `dusk` frames scored 8 on.
    //
    // Laterals are spread by hand rather than lined up along the road: six counters in a
    // column reads as a menu, six counters fanned round a bridgehead reads as a section.
    // Every position below was solved against the projection rather than guessed: the
    // orbit camera's window is derived in the camera note, and each of these lands the
    // counter it carries inside the clear part of the page — off the roster column
    // (x < 330), off the order deck (y > 810), off the objective slip (x > 1500, y < 270)
    // and off the tactical survey (x > 1470, y > 620). Round 4's section projected to
    // y = 800-1050 and four of its six counters were behind the deck.
    // EVERY POSITION BELOW WAS SOLVED BACKWARDS OUT OF THE PICTURE.
    //
    // Round 5 authored these as map coordinates and then looked at where they had
    // landed, which is how six of them ended up in a 200 px huddle either side of
    // the road head. They are now authored the other way round: a screen point was
    // chosen on the page first, and `tools/probe.mjs` raycast that pixel onto the
    // terrain under this exact lens to get the metres. The comment beside each one
    // is the pixel it was solved for, at 1920x1080, and it can be re-checked by
    // projecting the unit and comparing.
    //
    // The page the staging is composed into is NOT the frame: the roster column
    // owns x < 330, the objective slip x > 1500 / y < 270, the tactical survey
    // x > 1470 / y > 620 and the order deck y > 810. The clear window is therefore
    // x 340..1490, y 60..800, whose thirds fall at x = 723 / 1107 and y = 307 / 553
    // — and Alicia, the selected counter and the subject of the plate, stands on
    // the (1107, 553) intersection.
    const squad = [
      ['Alicia Melchiott', 12.5, -8.0],    // (1155, 617) — focal, lower-right third
      ['Rosie Stark', 17.6, -9.2],         // (1300, 665)
      ['Largo Potter', 7.1, -1.2],         // ( 900, 690) — nearest, bottom of the bank
      ['Edy Nelson', 1.2, -1.1],           // ( 760, 560)
      ['Isara Gunther', 0.5, -8.5],        // ( 863, 413)
      ['Marina Wulfstan', 16.8, -14.9],    // (1370, 480)
    ];
    for (const [name, x, z] of squad) {
      pose(ctx, unitNamed(ctx, name), x, z, facing(x, z, 6, -34), 'idle');
    }
    // The Edelweiss on the road at the north abutment — the one object on the map
    // with a silhouette big enough to read at fifty metres, and the thing that says
    // which way the attack is going. It sits between the section and the enemy line,
    // so the picture has a shape: our counters below it, the tank on the axis, the
    // Imperial line above.
    const tank = b.units.find((u) => u.isVehicle && u.team === 0);
    pose(ctx, tank, 5.0, -8.8, facing(5.0, -8.8, 8, -34), 'idle');   // (985, 470)
    turretTo(tank, facing(5.0, -8.8, -14, -30));

    // The garrison holding the frontages behind the bridgehead, laid out across the
    // whole upper half of the clear window rather than trailed into one corner, so
    // the threat wash has a SHAPE and the top of the page is never bare pasture.
    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle);
    // Three of these sit out on the WESTERN flank rather than in the village street.
    // Measured on the round-5 framing, the band x 340..700 / y 200..560 — a seventh of
    // the clear window — held no counter, no structure and no incident of any kind: open
    // pasture with a wash over it, which is the "empty region" automatic rejection. The
    // three positions marked below were raycast onto that band and put a picket, a
    // section post and a flank guard in it, which also gives the threat wash a lobe to
    // the west instead of one solid bar across the top.
    const foeSpots = [
      [-1.0, -11.5],    // ( 900, 385) — the picket closest to our line
      [0.4, -16.5],     // (1005, 330)
      [-16.4, 0.4],     // ( 430, 520) — western flank, low
      [9.6, -29.3],     // (1350, 290)
      [-8.3, -6.7],     // ( 700, 430) — western flank, mid
      [-2.6, -36.0],    // (1180, 175)
      [11.2, -42.9],    // (1500, 185)
      [20.9, -34.6],    // (1660, 300)
      [-23.5, -5.7],    // ( 430, 330) — western flank, high
      // 95 px put this man's CROWN at y = 37 and his counter above the top edge, where
      // the label layer culls it: seventeen counters for eighteen units. A counter is
      // lifted 13 units above the crown, so nothing may be staged inside the top 90 px.
      [-9.7, -44.4],    // (1130, 140)
      [4.3, -49.7],     // (1420, 115)
    ];
    foe.forEach((u, i) => {
      const [x, z] = foeSpots[i % foeSpots.length];
      pose(ctx, u, x, z, facing(x, z, 6, 10), 'idle');
      u.lastKnown.copy(u.pos);
      u.lastKnownTurn = b.turn;
    });
    // Their armour on the flank, big enough to matter and far enough back to be a
    // threat rather than a contact.
    const foeTank = b.units.find((u) => u.isVehicle && u.team === 1);
    if (foeTank) {
      pose(ctx, foeTank, 22.8, -22.4, facing(22.8, -22.4, 6, 4), 'idle');   // (1620, 430)
      turretTo(foeTank, facing(22.8, -22.4, 8, -6));
      foeTank.lastKnown.copy(foeTank.pos);
      foeTank.lastKnownTurn = b.turn;
    }

    // A TURN THAT HAS ALREADY BEEN FOUGHT.
    //
    // Rounds 2-5 all shot this on turn 1 with seven CP and six soldiers at full
    // health, which meant every state the HUD is capable of drawing — the spent
    // stamp on a roster card, the strike through a counter that has already gone,
    // the strength gauge on a counter that has been hit, a CP bank part-spent —
    // was switched off in the only frame that gets judged. A staff map on turn one
    // is a deployment diagram; a staff map on turn three is a battle. The numbers
    // below are the only game state this shot invents, and every one of them
    // exists to put a piece of the interface on the page.
    b.turn = 3;
    b.cp[0] = 5;
    for (const [name, hp] of [['Largo Potter', 61], ['Edy Nelson', 38], ['Rosie Stark', 74]]) {
      const u = unitNamed(ctx, name);
      if (u) u.hp = Math.min(u.maxHp, hp);
    }
    for (const name of ['Rosie Stark', 'Marina Wulfstan']) {
      const u = unitNamed(ctx, name);
      if (u) { u.hasActed = true; u.actionsThisTurn = 1; }
    }

    const alicia = unitNamed(ctx, 'Alicia Melchiott');
    cm.select(alicia);
    cm.showThreat = true;
    // A HAND-TINTED WASH, NOT A FILLED POLYGON.
    //
    // CommandMode builds its overlays at 0.86 / 0.74 opacity, which is right for a
    // player who has to see at a glance where the boundary is on a live 60 Hz screen and
    // catastrophic for a still: at that weight the wash is no longer a tint over the
    // painting, it IS the painting, and it took the whole middle of round 4's frame down
    // to one flat pale teal with the terrain invisible under it. A pencilled overlay on a
    // survey sheet lets the survey through. These are the only two numbers in the shot
    // that touch a system this file does not own, and they are set here rather than in
    // CommandMode because the difference is a photographic one.
    // Round 5 held these at 0.52 / 0.40 and the critic still measured the middle of
    // the map as one flat wash. A tint laid over a survey by hand is a BOUNDARY with
    // a little colour inside it, not a colour with a boundary round it, so the body
    // comes down again and the wet edge (which CommandMode already pools) is what
    // carries the read.
    if (cm.moveMesh?.material) cm.moveMesh.material.opacity = 0.46;
    if (cm.threatMesh?.material) cm.threatMesh.material.opacity = 0.54;
    if (cm.arcMesh?.material) cm.arcMesh.material.opacity = 0.18;
    // WHAT THE LENS CAN ACTUALLY SEE, DERIVED RATHER THAN GUESSED.
    //
    // A map camera at height H and pitch p on a fov f sees ground from
    // H / tan(p + f/2) out to H / tan(p - f/2) along its own axis, and round 4's
    // (dist 38, pitch 0.70, fov 34) put that window at 20..64 m — while the six units
    // the frame is about stood 8..20 m from the lens, i.e. under the bottom edge. That
    // is why the middle of the picture was hillside: the section was never in it.
    //
    // dist 58 at pitch 0.60 put the lens 32.8 m above the ground and every soldier in
    // the frame 55-95 m away, which projected them at 29-39 px tall and 12-16 px wide.
    // That is the structural reason this shot has been the worst card in the set for
    // four rounds: at 13 px across there is no shading, no silhouette and no banding to
    // be had, so no amount of work on the materials could ever have shown up here.
    //
    // Coming in to dist 50 / pitch 0.585 / fov 41 drops the lens to 27 m and pulls the
    // window in to 20..96 m; measured, the same soldiers now project 48-56 px and the
    // Edelweiss 88 px, with the near counters at the bottom of the page reading a third
    // larger again than the Imperial line at the top — which is the foreground /
    // midground / background layering the composition axis has been asking for and
    // which a single flat rung of 37 px could not supply. The bridge still enters at
    // the lower left (its south abutment projects to about (260, 940)) and runs up to
    // the centre of the page, so the diagonal that carried the round-5 framing survives.
    //
    // The focus is 5.5 m FURTHER DOWN THE AXIS than the staging was solved against,
    // and the reason is worth writing down because it cost a whole pass. CommandMode
    // damps `target.y` toward the ground under the focus rather than snapping it, so
    // the lens converges 3.3 m lower than the naive rig the staging was raycast with
    // (measured: 30.3 m against the 33.6 m the solver assumed). Everything therefore
    // projected 85-160 px HIGHER than it was authored to, which crowded the head of
    // the page and left the foot of it bare. Rather than move nineteen units, the
    // focus moves 5.5 m along the view axis — (-0.6, -0.8) * 5.5 — which walks the
    // whole staging back down by the measured 90 px and, as a bonus, brings every
    // figure ~12% closer to the lens.
    cm.focusOn(_v.set(2.7, 0, -10.4), true);
    cm.distWant = cm.dist = 50;
    // 33.5 degrees down. Steep enough to read as a survey, shallow enough that the far
    // bank's frontages still stand UP against the hillside instead of being roof plans —
    // a map with no elevation in it anywhere is a diagram.
    cm.pitchWant = cm.pitch = -0.585;
    // North-west, obliquely across the valley: see the note on the staging above.
    cm.yawWant = cm.yaw = Math.PI + 0.6435;
    cm.fovWant = cm.fov = 41;
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
    // THE ORDER DECK IS DEALT, EXPLICITLY.
    //
    // R25 wave 1 made the hand SHUT by default — correct for play (Esc used to open a
    // drawer the player had never opened, and the resting page is a reconnaissance
    // drawing with the deck as a tab in its margin), but it silently took the six order
    // cards out of this plate, and the six cards splayed along the foot of the page are
    // half of why this frame reads as a Valkyria command screen rather than a top-down
    // strategy map. A shot that wants a piece of interface on the page has to ask for it
    // now that nothing deals it automatically. `cp:changed` above has already run
    // _refreshOrderLocks(), so with 5 CP the dearer cards are drawn locked — the state a
    // turn-three staff map should be in. Reset in resetShotState().
    ctx.ui?._toggleOrders?.(true);
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
    // HALFWAY ACROSS, NOT THIRTY METRES SHORT OF IT.
    //
    // At z = 32 the whole span lay between her and the town, and an over-the-shoulder lens on
    // a 33-degree down-road axis turned the deck into a pale trapezoid across the middle of
    // the frame with nothing on it — the "~40% to a bare deck" note, in a shot that is
    // supposed to be about an assault. Put her ON the crossing, at the near end of the third
    // arch, and the SAME deck becomes a corridor: its two parapets converge either side of
    // her, the section is strung out along it ahead of and beside her, and the bridgehead she
    // is running at is the vanishing point rather than a distant strip.
    const alicia = unitNamed(ctx, 'Alicia Melchiott') || firstOfClass(ctx, 'scout', 0);
    const dy = deckY(ctx);
    pose(ctx, alicia, 3.4, 12.5, Math.PI - 0.10, 'run', STANCE.STAND, { phase: 0.18, y: dy });

    // Two of the section ahead of her on the span, staggered either side of the crown, so the
    // deck carries figures all the way to the far parapet instead of being a floor.
    const rosie = unitNamed(ctx, 'Rosie Stark');
    const largo = unitNamed(ctx, 'Largo Potter');
    const edy = unitNamed(ctx, 'Edy Nelson');
    pose(ctx, rosie, 5.4, 5.5, Math.PI - 0.16, 'run', STANCE.STAND, { phase: 0.62, y: dy });
    pose(ctx, largo, 2.6, 0.8, Math.PI + 0.12, 'run', STANCE.STAND, { phase: 0.31, y: dy });
    if (edy) pose(ctx, edy, 5.6, 17.5, Math.PI - 0.06, 'aim', STANCE.CROUCH, { y: dy });

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
    // Nose up a little as well: the deck is a pale flat plane and every degree of down-pitch
    // at fov 32 is another 3% of the page given to it. -0.09 was too far — it cropped both
    // frontages' roofs against the top edge; -0.07 keeps them whole.
    am.camPitch = -0.07;
    // R25 presentation pass: at the gameplay shoulder of 0.62 Alicia sits at 0.60 of frame
    // width — near enough dead centre that the deck's two parapets converge symmetrically
    // behind her head and the picture reads as a one-point perspective diagram with a figure
    // pasted on the axis. Composition rule 1 says never dead centre. 1.20 walks the lens far
    // enough left to put her on the right-hand third and swings the vanishing point off the
    // centre line, so the corridor rakes instead of aiming at the viewer. updateCamera()
    // damps shoulder toward shoulderTarget at rate 8, and the settle below runs 24 frames,
    // so the target alone is enough — no snapping needed.
    am.shoulderTarget = 1.00;   // 1.20 pushed her onto the bottom-right ammunition panel
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
    // HE WAS STANDING IN THE OPEN WITH HIS ARMS DOWN, IN FRONT OF HIS OWN SANDBAGS.
    // The old line took the STANCE.STAND default and the 'idle' clip, which flatly
    // contradicted the comment above it and read as a man who does not know there is a war
    // on — on the one plate whose entire job is to sell the aim mechanic. vc-088 has the
    // target CROUCHED with the sandbag course cutting his silhouette at the waist. Two
    // metres east and one and a half further out puts him behind the course, not clear of it.
    pose(ctx, target, 8.4, -15.5, 0.15, 'crouchIdle', STANCE.CROUCH);

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
    // OVER-THE-SHOULDER MEANS A SHOULDER IS IN THE FRAME.
    //
    // The gameplay defaults (fov 32/1.9 = 16.8 deg, arm 1.45 m, shoulder 0.46 m) project
    // Alicia's head at x = 1917 of 1920 — three pixels from the right edge, with her body
    // entirely off-screen and the sliver that remains sitting inside the drawing falloff's
    // drained margin, i.e. the grade erases the one character the shot is about. A 17-degree
    // lens 1.45 m behind a crouched soldier's chest cannot see her at all; VC's
    // over-the-shoulder is a normal ~30-35 deg lens (its magnification is the separate scope
    // view). vc-088 puts Alicia in the LEFT third from mid-torso up, head about a quarter of
    // frame height, with the target at dead centre.
    //
    // Set the TARGETS, because the settle loop below snaps fov/arm/shoulder to them each
    // frame. This is shot-local: it cannot disturb the aim line, because updateCamera()
    // converges camLook on pivot + fwd*convergeDist with a ZERO lateral term in AIM mode
    // (actionMode.js:1263-1265), so r22's shoulder-parallax inversion is not a function of
    // any of these three.
    // Measured, not guessed. The lateral angle from the lens axis to the soldier is
    // atan(shoulder / arm); she is in frame only while that is under the half horizontal
    // field, atan(tan(fov/2) * 16/9). At the defaults that is 17.6 deg against a 14.7 deg
    // half-field — off the edge by three degrees, which is the 1917 px reading. The SIGN
    // matters too: +shoulder swings the lens left and throws her to the RIGHT edge, so
    // vc-088's left-third placement needs a NEGATIVE shoulder.
    // 1.25 m put her head across a third of the page height and her forearm through the
    // middle of the frame; vc-088's head is ~28% of frame height. Back off to 1.85 and hold
    // the 16 deg lateral angle by scaling the shoulder with the arm.
    am.fovTarget = 32; am.armTarget = 1.85; am.shoulderTarget = -0.53;
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
    // THE KEY WAS 79% DOWN THE LENS, SO EVERY GALLIAN IN THE FRAME WAS A SILHOUETTE.
    //
    // Solved instead of guessed. The lens runs f = (0.696, -0.718) with screen-right
    // r = (0.718, 0.696); the old pair (t 0.29, az 1.95) resolves to a sun bearing of
    // 1.709, i.e. a ground sun vector of (0.990, -0.139), which is sun.f = +0.79 — dead
    // contre-jour. Every one of ours came back as a flat brown cut-out with no uniform,
    // no webbing and no face on it, on the one shot that is supposed to be a firefight
    // between two identifiable sides.
    //
    // Asking for sun = 0.95 r - 0.20 f instead gives a ground bearing of 0.593 rad:
    // sun.r = +0.98, so the shadows still rake the whole width of the page, and
    // sun.f = -0.21, i.e. the key is twelve degrees BEHIND the lens — three-quarter
    // front, which lights our line's kit and still leaves their far-bank flanks in the
    // violet. t = 0.21 holds the sun at 42 degrees; azimuth is 0.593 - (t - 0.5)*1.15.
    setSun(ctx, 0.21, 0.926);
    uiMode(ctx, 'action');

    // THE HALF OF THE FRAME THE FIGHT WAS NOT IN.
    //
    // Round 4 staged our line along z = 27..29 while the lens stood at z = 31 aimed
    // north-east, which put four of the five men within four metres of the camera plane
    // and to the LEFT of the view axis — so they fell outside the frame entirely and the
    // whole lower-right third of the picture, some 35% of the page, came back as an
    // unbroken grass bank with nothing on it. Composition 5, and "empty regions of frame"
    // is an automatic rejection in its own right.
    //
    // Both problems are one problem: the line was authored in MAP coordinates against a
    // lens authored separately. Author it in CAMERA space instead and the fire team
    // cascades from the near-right corner into the middle distance, which is exactly the
    // ground that was bare — while the crossing, the water and the burning town keep the
    // left half.
    const FCX = -16.0, FCZ = 31.0, FTX = 16.0, FTZ = -2.0, FFOV = 46;
    const SF = staging(FCX, FCZ, FTX, FTZ);
    const inLine = (u, d, f, clip, st) => {
      const [x, z] = SF.at(d, SF.halfWidth(d, FFOV) * f);
      return [pose(ctx, u, x, z, facing(x, z, 8, -16), clip, st, { aimPitch: 0.02 }), x, z];
    };
    // 3.4 m on the near man is a REPOUSSOIR and the only thing that can fill the bottom
    // of this frame. The lens stands 1.75 m up on a bank that falls away in front of it,
    // so ground from 3 to 7 m out owns the lower 30% of the page and no arrangement of
    // grass will ever be enough to make that interesting; a shocktrooper firing, cropped
    // at the shin by the bottom edge, is. The rest of the fire team then cascades away
    // from him to alternating sides so the eye is walked from the near corner to the
    // bridgehead instead of jumping there.
    //
    // AND THE BOTTOM-RIGHT CORNER GETS A MAN IN IT.
    //
    // Round 5 put the fire team's near end on the LEFT of the axis and its far end on the
    // right, which walked the eye correctly but left the lower-right quadrant — the ground
    // nearest the lens on the sunlit side, and therefore the largest, brightest, emptiest
    // region in the picture — as one unbroken grass bank. Measured on the round-5 plate
    // that quadrant is about 24% of the page with nothing drawn in it, and "empty regions
    // of frame" is an automatic rejection on its own. Isara comes forward out of the tail
    // of the cascade to 4.6 m and +0.66 of the half-width, so she is cropped by the right
    // edge and her mass closes that corner; the cascade then still runs away from the lens,
    // just from BOTH near corners instead of one.
    const line = [
      inLine(unitNamed(ctx, 'Rosie Stark'), 3.4, -0.14, 'aim', STANCE.STAND),
      inLine(unitNamed(ctx, 'Isara Gunther'), 4.6, 0.66, 'crouchIdle', STANCE.CROUCH),
      inLine(unitNamed(ctx, 'Largo Potter'), 8.0, 0.40, 'aim', STANCE.STAND),
      inLine(unitNamed(ctx, 'Alicia Melchiott'), 12.0, 0.14, 'crouchIdle', STANCE.CROUCH),
      inLine(unitNamed(ctx, 'Edy Nelson'), 16.0, -0.34, 'aim', STANCE.CROUCH),
    ].filter((r) => r[0]);

    // AND THE ENEMY IS IN THE PICTURE.
    //
    // Round 4 dug the garrison in among the frontages at z = -13..-22, forty-five metres
    // out and behind two rows of stucco: the critique measured four Imperial name slips
    // whose leader lines terminated on masonry with no soldier under them anywhere, which
    // is the single most damning HUD tell there is. Bring them forward onto the lip of
    // the north bank, where they stand against the water and the road metal rather than
    // against a wall the same value as their coats, and stagger them along the bank so
    // the line reads as a line.
    // ...and two of them are ON THE SPAN. A soldier standing on grass at forty metres,
    // under this much aerial perspective, is a 56 px smudge the same value as the bank
    // behind him — which is precisely how round 4 ended up with four Imperial name slips
    // whose leader lines landed on nothing. Against the pale road metal of the deck and
    // the parapet he is a dark shape with a silhouette, at the same distance. The rest
    // hold the far bridgehead where the road runs out of the abutment, for the same
    // reason: value contrast, not proximity, is what makes a figure legible.
    const dyF = deckY(ctx);
    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 6);
    const foeSpots = [[4.3, 1.5, dyF], [2.8, -3.5, dyF], [5.4, -9.0, null],
      [1.6, -13.0, null], [12.5, -10.0, null], [-4.5, -8.0, null]];
    foe.forEach((u, i) => {
      const [x, z, yy] = foeSpots[i % foeSpots.length];
      pose(ctx, u, x, z, facing(x, z, 4, 25), i % 2 ? 'crouchIdle' : 'aim',
        i % 2 ? STANCE.CROUCH : STANCE.STAND,
        yy === null ? { aimPitch: 0.02 } : { aimPitch: 0.02, y: yy });
    });

    b.setPhase('action');
    b.activeUnit = line[0] && line[0][0];

    // Kneeling height at the left end of our own line, on a wide lens: the shocktrooper is
    // five metres off the lens and cropped, the section recedes to the right, the crossing
    // and the burning town fill the left, and the tracer traffic runs between the two.
    aimCameraG(ctx, FCX, 1.75, FCZ, FTX, 1.6, FTZ, FFOV);

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
      // ROUNDS THAT LAND.
      //
      // Five rounds of this plate have shown tracers leaving muzzles and nothing
      // arriving anywhere, which is why it reads as a diorama of men holding rifles
      // rather than as a firefight. The damage plate — a thrown blot of ink with the
      // figure struck through it, outlined in real ink, see icons.js damagePlate — is
      // one of the best-drawn objects in the project and had never once appeared in a
      // critiqued frame. Two hits are raised on the Imperial line at finale frame 1, so
      // they are 6/60 s old when the shutter opens: past the pop, before the fall, and
      // fully opaque (the plate does not start to fade until 0.84 s).
      if (i === 1) {
        const hits = [[foe[0], 34, false], [foe[2], 61, true]];
        for (const [t, amount, crit] of hits) {
          if (!t) continue;
          t.centerPoint(_t);
          Bus.emit('unit:damaged', {
            unit: t, amount, crit, source: line[0] && line[0][0],
            // Below the chest, not above it: the Imperial name slips ride at 2.05 m
            // and a plate raised over the centre lands squarely on one.
            worldPos: { x: _t.x, y: _t.y - 0.30, z: _t.z },
          });
        }
      }
    });
    await frames(10);
  },

  /** The Edelweiss, three-quarter low angle, crew alongside, the valley falling away behind. */
  async tank(ctx) {
    const b = ensureBattle(ctx);
    // THE KEY IS SOLVED, NOT GUESSED.
    //
    // The old pair (t 0.24, azimuth 0.93) put the sun bearing ON the hull axis, which meant
    // BOTH flanks sat exactly on the terminator — and the camera can only ever see a flank
    // and the glacis. The whole vehicle therefore rendered inside one violet band: measured
    // hull mean (95,86,113), and 91% of the tank's pixels under luma 120. A quantised shader
    // that never crosses a band boundary on its largest object is a smooth-shaded 3D render
    // with a colour filter, which is exactly what the critic said.
    //
    // Solve it instead. The rig builds the sun as
    //   elev = sin(t*PI) * 1.15 + 0.045,  az = azimuth + (t - 0.5) * 1.15
    // and the two faces the lens can see are the glacis (normal = fwd*cos24 + up*sin24) and
    // the port flank (normal = -right). With hull yaw TH and sun bearing AZ:
    //   glacis . L = 0.914*cos(e)*cos(AZ - TH) + 0.407*sin(e)
    //   port   . L = cos(e) * sin(TH - AZ)
    // t = 0.16 gives e = 0.599 rad (34 deg — low enough that the cast shadow is three hull
    // lengths long), and AZ - TH = +0.372 rad puts the glacis at 0.93 (top cream band) with
    // the port flank at -0.30 (solidly through the terminator, violet). Hull yaw 0.84 is then
    // the 48-degree three-quarter that shows both of them at once, and azimuth 1.60 is the
    // AZ that follows. Change one of the three and you must re-solve the other two.
    setSun(ctx, 0.16, 1.60);
    field(ctx);
    hideAll(ctx);
    b.activeUnit = null;
    const tank = b.units.find((u) => u.isVehicle && u.team === 0);
    const isara = unitNamed(ctx, 'Isara Gunther');
    const largo = unitNamed(ctx, 'Largo Potter');
    const alicia = unitNamed(ctx, 'Alicia Melchiott');
    show(ctx, [tank, isara, largo, alicia]);

    // It sits ON THE ROAD, and so does the camera. The road corridor is the only ground on
    // this map that is carved flat, and a low camera on a heightfield otherwise spends the
    // shot looking over the crest of whatever bank lies between it and the subject — which
    // buries the running gear, the one part of a tank that has to be visible.
    const tx = 2.2, tz = 19.5;
    pose(ctx, tank, tx, tz, 0.84, 'idle');
    // The gun goes ACROSS the lens, not down it: a barrel pointed at the camera is a circle.
    // But not square across either — aimed at (40, -10) it rakes to screen-right AND four
    // degrees away from the lens, which is the difference between a barrel that reads as a
    // barrel and a barrel that grows out of the near soldier's head. (It did: aimed due east
    // the muzzle came toward the camera and landed exactly on the man in the right
    // foreground.) Eighty degrees of traverse off the hull line also gives the silhouette the
    // turret/hull disagreement that says "halted, watching a flank".
    turretTo(tank, facing(tx, tz, 40, -10), 0.02);

    // Kneeling height, seven metres out and offset to the tank's port bow, looking slightly UP
    // at the sponson line so the hull reads against sky and hillside rather than against the
    // road. A tank photographed from standing height is a diagram. The aim point is pushed
    // 1.5 m to screen-RIGHT of the hull, which is what parks the Edelweiss on the left third
    // instead of dead centre and leaves the right third for the crew.
    const FOV = 40, CX = 4.9, CZ = 25.4, AX = 3.2, AZ = 19.1;
    const S = staging(CX, CZ, AX, AZ);
    aimCameraG(ctx, CX, 0.95, CZ, AX, 1.15, AZ, FOV);

    // THREE FIGURES ON THREE DEPTH PLANES, and every one of them whole. The round-2 note was
    // that this frame "crops a soldier at the left edge so his limbs read as detached
    // pieces"; the fix is not to move the crop but to stop cropping, and the way to be SURE
    // is to place them in camera space rather than to guess map coordinates — the round-2
    // Largo was authored as "four metres off the lens, low left" and actually landed 1.3
    // half-widths outside the left edge. Depths 3.9 / 9.6 / 17, all on the right of the axis
    // so they balance the hull: Largo fills the near right corner, Isara stands at the tank's
    // off-front shoulder, Alicia is small on the road behind.
    const put = (u, d, f, clip = 'idle', st = STANCE.STAND, opts) => {
      const [x, z] = S.at(d, S.halfWidth(d, FOV) * f);
      return pose(ctx, u, x, z, facing(x, z, tx, tz), clip, st, opts);
    };
    //
    // AND 0.78 OF A HALF-WIDTH IS NOT INSIDE THE FRAME. A lateral is the position of a man's
    // ROOT, and a man is 0.55 m wide with a 1.4 m weapon across him; at 3.6 m the half-width
    // is only 2.33 m, so 0.78 of it puts his root 1.82 m out and his outboard shoulder and
    // his rifle muzzle past the edge — which is exactly the "cropped into detached limbs"
    // the critique named for the second round running. Back him off to 4.6 m (half-width
    // 2.98) and in to 0.55, and his silhouette clears the edge by 0.6 m with the crop it
    // actually wants: the BOTTOM edge, across his shins, where a crop reads as foreground.
    put(largo, 4.0, 0.52, 'crouchIdle', STANCE.CROUCH);
    put(isara, 10.5, 0.60);
    put(alicia, 18.0, 0.38, 'walk', STANCE.STAND, { phase: 0.27 });

    finale(ctx, 5, (i) => {
      if (i !== 0 || !ctx.fx || !tank) return;
      // Idling exhaust off the rear deck, and the town burning behind. The rear deck is
      // 2.2 m BEHIND the hull origin along its own heading, so derive it from the yaw
      // instead of hard-coding an offset that silently becomes the front when the hull turns.
      smokeColumn(ctx, 30, -42, 13, 9, { size: 3.0, alpha: 0.34, drift: 6, frames: 5 });
      _v.set(tx - Math.sin(0.84) * 2.2, tank.pos.y + 1.35, tz - Math.cos(0.84) * 2.2);
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
    field(ctx);
    hideAll(ctx);

    // IN THE STREET, NOT OUT ON THE GREEN.
    //
    // Round 3 stood the lens at (48, -62) — thirty metres clear of the last frontage, out on
    // the pasture — and the frame it got was one barn's broadside filling the left third,
    // three roofs across the middle, and twenty-two thousand square pixels of unbroken lawn
    // under all of it. That lawn is also most of why this shot measured a mean HSV saturation
    // of 91/255, the highest in the set: a large flat area of the one pigment the lit
    // transform deliberately boosts (greens get +16% chroma, see vcLitColour).
    //
    // Structures._buildVillage() ranks its houses along the ROAD, at 7 m and 18 m off the
    // centreline on both sides, so the road through the pad is a street with two built
    // frontages — and standing in it gives the frame walls on both edges, a receding
    // perspective down the middle, and cart ruts and beaten earth instead of turf in the near
    // field. Everything the previous framing was missing is a property of standing in the
    // right place.
    // R25 presentation pass: the right-hand frontage stood 4 m off the lens, faced away from
    // a 1.75 rad key, and came back as an unlit near-black slab down the whole right edge —
    // roughly a tenth of the page as a hole in the picture, with the near repoussoir soldier
    // lost against it. Both the lens and the street staging are authored from these four
    // numbers, so shifting all four by the same vector is a pure lateral dolly: the men keep
    // their screen positions and only the world-fixed frontage swings. -2.2 m along
    // screen-right (0.87, 0.49) walks that wall off the edge without opening the pasture the
    // round-3 framing was moved out of.
    // R25 wave 2: ON THE CARRIAGEWAY, AND FAR ENOUGH IN TO BE IN THE VILLAGE.
    //
    // The road centreline (layout.js, seed 20250728) runs (13.9, -27.2) -> (17.7, -35.9)
    // -> (21.0, -45.0) -> (23.8, -54.8), half-width 3.3-3.9 m. The previous lens at
    // (12.29, -25.08) aiming (28.59, -54.08) tracked the street in the near field but
    // diverged east of it with depth: at 22 m down the axis it sat at x = 23.1 against a
    // centreline at 20.8, i.e. on the eastern kerb, and by the far field it was out on the
    // yards — which is why the cobbled ribbon the world agent built (structures._buildStreet,
    // the road inside village.r * 1.12, i.e. z = -20.6 .. -68) never entered the frame. It
    // also stood 5 m SHORT of the first frontage, so most of the page was the approach.
    // Both lens and target are now points on the centreline itself — (16.4, -34.0) standing
    // in the street between the two built ranks, sighting (25.0, -62.0) at the far end of
    // the run — so the axis follows the carriageway for its whole 30 m and the frontages
    // close on both edges. The staging is authored in camera space off these same four
    // numbers, so the men keep their screen positions.
    // (19.6, -42) sighting (25.6, -68) — one bay further in — was tried and rejected: it
    // stands close enough to the western frontage that a single stucco wall owns the left
    // 40% of the page, and the street beyond the last building opens onto empty pasture and
    // sky with nothing closing the end of the run.
    const FOV = 42, CX = 16.4, CZ = -34.0, TX = 25.0, TZ = -62.0;
    const S = staging(CX, CZ, TX, TZ);
    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 4);
    show(ctx, foe);
    // Four depth planes down the street: one in the near field cropped at the shin by the
    // bottom edge, one at the first doorway, one at the far corner, one small by the well.
    // 2.5 m on the near man is a repoussoir: the bottom edge crops him across the thigh and
    // his torso fills the lower-right corner, which is what stops the street surface — the
    // same flat pale plane a bridge deck is — from owning the near third of the frame.
    const spots = [[2.5, 0.40, 'idle'], [6.0, -0.40, 'crouchIdle'], [11.0, 0.26, 'idle'],
      [19.0, -0.30, 'crouchIdle']];
    foe.forEach((u, i) => {
      const [d, f, clip] = spots[i % spots.length];
      const [x, z] = S.at(d, S.halfWidth(d, FOV) * f);
      pose(ctx, u, x, z, facing(x, z, CX, CZ) + (i % 2 ? 0.7 : -0.5), clip,
        clip === 'crouchIdle' ? STANCE.CROUCH : STANCE.STAND);
    });

    // 1.4 degrees, not 3: at 42 degrees of vertical field every extra degree of nose-down is
    // another 2.4% of the page given to the street surface, and the street surface here is
    // beaten earth — the flattest, emptiest thing in the frame.
    aimCameraPitch(ctx, CX, CZ, 2.05, TX, TZ, 0.6, FOV);

    finale(ctx, 5, (i) => {
      if (i === 0) smokeColumn(ctx, 34, -52, 13, 10, { size: 2.6, alpha: 0.36, drift: 6, frames: 5 });
    });
    await frames(14);
  },

  /** Portrait distance — this is the shot that judges the character model and the shading. */
  async closeup(ctx) {
    ensureBattle(ctx);
    setSun(ctx, 0.29, 2.15);
    field(ctx);
    hideAll(ctx);
    const alicia = unitNamed(ctx, 'Alicia Melchiott') || firstOfClass(ctx, 'scout', 0);
    const rosie = unitNamed(ctx, 'Rosie Stark');
    show(ctx, [alicia, rosie]);
    pose(ctx, alicia, -2, 34, 0.55, 'idle', STANCE.STAND, { aimPitch: 0.03 });
    // A second figure well behind and to the side, thrown soft by the DoF, so the portrait
    // has a background instead of a wall of grass.
    pose(ctx, rosie, 4.5, 27.0, 1.6, 'idle');

    // SETTLE BEFORE MEASURING. `pose()` writes the Unit and calls syncActor(), which
    // moves the actor ROOT — but the bone world matrices, and therefore headPoint(),
    // are only rebuilt inside Character.update() on the next frame. Reading the head
    // here without settling returns the head position from WHATEVER THE PREVIOUS SHOT
    // LEFT ON THE SKELETON, which is why this plate framed differently under the
    // resident renderer (residual state) than under a cold boot (spawn state): cold-boot put
    // the head 33% down the frame with the weapon entirely below the bottom edge,
    // batch put it at 17% with the rifle in shot. Both were accidents. Three frames
    // is enough for the pose to land and for the foot IK to plant.
    await frames(3);
    const head = alicia.headPoint(_v.clone());

    // THE FRAMING, SOLVED RATHER THAN NUDGED. The brief on this plate is exact: it
    // must show the head large enough to read as a PORTRAIT and still contain the
    // hands and the weapon. Those two demands fight, and hand-tuned numbers had
    // been satisfying whichever one was measured last — the round-9 framing put
    // the support hand 98 px BELOW the bottom edge (measured by projecting
    // fingersL: screen y 1307 in a 1080-line frame), and the framing before that
    // put the head at 250 px.
    //
    // They are reconcilable, but only if the distance is derived from the subject
    // instead of guessed. Let S be the world height from the crown to the
    // fingertips; a vertical field f at range D covers 2 D tan(f/2), so asking for
    // S to fill a fraction FILL of the page fixes D = S / (FILL * 2 tan(f/2)).
    // Measured on this pose S = 0.70 m, so at FILL 0.76 on a 34-degree lens
    // D = 1.51 m and the skull comes out at 0.24/1.51 * 1766 = 281 px, 26% of the
    // page — portrait scale, with the whole weapon hold inside the frame.
    //
    // The look-at then goes at the MIDPOINT of that span rather than at a fixed
    // offset below the head, which is what stops the framing sliding when the pose,
    // the terrain height or the character's build changes.
    const bm = alicia.character?.rig?.boneMap;
    const grip = _t.set(head.x, head.y - 0.46, head.z);
    if (bm?.fingersL) grip.setFromMatrixPosition(bm.fingersL.matrixWorld);
    const FOV = 34, FILL = 0.76;
    const top = head.y + 0.135, bot = Math.min(grip.y - 0.055, head.y - 0.30);
    const D = Math.min(2.10, Math.max(1.15, (top - bot) / (FILL * 2 * Math.tan(FOV * 0.5 * Math.PI / 180))));
    const midY = (top + bot) * 0.5;
    // Three-quarter from her weapon side, and the lens a hand's breadth ABOVE the
    // midpoint so it sits just under the eyeline — the classic VC character plate.
    const a = 0.55 - 1.02;
    aimCamera(ctx.camera,
      alicia.pos.x + Math.sin(a) * D, midY + 0.075, alicia.pos.z + Math.cos(a) * D,
      // ...and the aim goes 0.24 m past her rather than 0.09, which slides the
      // figure LEFT in the frame. The left third of this plate was 460 px of flat
      // road metal at one value — the "large empty region" the rubric rejects
      // outright — and the subject is the only thing available to fill it.
      head.x + 0.24, midY, head.z + 0.04, FOV);
    await frames(14);
  },

  /** Low camera looking through the riverbank scrub at a crouching scout. */
  async grass(ctx) {
    ensureBattle(ctx);
    setSun(ctx, 0.28, 2.30);
    field(ctx);
    hideAll(ctx);
    const edy = unitNamed(ctx, 'Edy Nelson') || firstOfClass(ctx, 'scout', 0);
    const rosie = unitNamed(ctx, 'Rosie Stark');
    const alicia = unitNamed(ctx, 'Alicia Melchiott');
    show(ctx, [edy, rosie, alicia]);

    // OVER HALF THIS FRAME IS STILL EMPTY SKY, and the reason is arithmetic that two rounds
    // of moving the camera sideways could never fix. On a 40-degree VERTICAL field a LEVEL
    // lens puts the horizon at exactly half the frame height, so half of every shot from a
    // level camera on flat ground is sky before a single object is placed. Round 3 aimed at a
    // point 0.14 m above the lens 5.3 m away — 1.5 degrees UP — and duly measured 52%.
    //
    // The fix is pitch, and the amount is derivable: the horizon lands at
    // (halfFov + pitch) / fov of the way down the frame, so six degrees of nose-down on a
    // 42-degree lens puts it at 64% and the sky is a third of the page before the poplar row
    // takes its bite out of that. The subject is lifted to compensate — a crouching man
    // 4.2 m out sits a quarter of the way down from the top edge, which is where a portrait
    // wants him — and the aim point is thrown 16 m down the axis so the pitch is measured
    // over a long baseline instead of over five metres of lumpy field.
    const FOV = 42, CX = -22.6, CZ = 65.2;
    const AX = -11.3, AZ = 54.9;
    const S = staging(CX, CZ, AX, AZ);
    const put = (u, d, f, clip, opts) => {
      const [x, z] = S.at(d, S.halfWidth(d, FOV) * f);
      return pose(ctx, u, x, z, facing(x, z, 6, 6), clip, STANCE.CROUCH, opts);
    };
    // Inside the fallow field south-west of the deployment (layout.fields), on one line of
    // advance at 4.2 / 8 / 13 m so the eye has somewhere to go after the subject.
    // R25 wave 2 — THE BOTTOM 45% WAS SWARD, AND THE SUBJECT WAS DEAD CENTRE.
    //
    // Measured on my own plate: a crouching man at 4.2 m on a 0.92 m lens has his boots
    // barely below the middle of the page, so everything under him — very nearly half the
    // frame — is one unbroken pasture at one value, with nothing in it and nothing crossing
    // it. And at a lateral of -0.12 he sits within 6% of the centre column, which is the one
    // place a subject cannot be. Both are fixed by the same move: the near man comes forward
    // to 2.6 m, where the bottom edge crops him at the shin and his mass owns the near
    // field as a repoussoir, and out to -0.30 so he stands on the left third. The other two
    // then spread wider to keep the eye walking away from him rather than stacking behind.
    put(edy, 2.6, -0.30, 'crouchWalk', { phase: 0.42 });
    put(rosie, 7.0, 0.56, 'crouchIdle');
    put(alicia, 13.0, -0.50, 'crouchWalk', { phase: 0.78 });

    aimCameraPitch(ctx, CX, CZ, 0.92, AX, AZ, 6.0, FOV);
    await frames(12);
  },

  /**
   * Last light. The valley raked from the west, every hedge and every soldier trailing a
   * shadow the length of a field, the town on the far bank going to violet.
   */
  async dusk(ctx) {
    const b = ensureBattle(ctx);
    // ACTUAL dusk — and the round-2 note was that it still did not read as one. The sun WAS
    // low (t 0.955 puts it at twelve degrees), but the bearing was eight degrees off the lens
    // axis, i.e. almost dead ahead. A shadow cast straight toward the camera is projected
    // onto four pixels: at twelve degrees of elevation every figure in the frame was trailing
    // 4.4 times its own height of shadow and NONE of it was visible. Length is only length if
    // it is ACROSS the frame.
    //
    // So: solve the bearing against the lens instead of against the compass. The camera below
    // looks down f = (-0.537, -0.844); screen-right is r = (0.844, -0.537). A sun bearing AZ
    // projects to screen-x = 0.844*sin(AZ) - 0.537*cos(AZ) and to depth = -0.537*sin(AZ) -
    // 0.844*cos(AZ). AZ = -1.35 gives screen-x -0.94 (hard left, so the shadows rake right
    // across the whole width at full apparent length) with depth +0.34 (still twenty degrees
    // IN FRONT of the lens, so the squad keeps its contre-jour rim). t = 0.95 holds the sun
    // at thirteen degrees — a 4.4:1 shadow — on the ember end of the ramp, and azimuth is
    // AZ - (t - 0.5) * 1.15 = -1.868.
    setSun(ctx, 0.95, -1.868);
    field(ctx);
    b.setPhase('command');
    b.activeUnit = null;
    // Every placement below is authored as (depth down the view ray, metres to screen-right)
    // and converted — see staging(). `lat` quotes the lateral as a FRACTION of the visible
    // half-width at that depth, so "0.62 of the way to the right edge" stays true whatever
    // the lens does. Depths run 6 to 30 m and the laterals alternate, so the section reads as
    // a section strung across a field and nobody hides behind anybody.
    const CX = 30.4, CZ = 47.2, TX = 15.4, TZ = 26.2, FOV = 40;
    const S = staging(CX, CZ, TX, TZ);
    const lat = (d, f) => S.halfWidth(d, FOV) * f;

    // Marina at six metres is the repoussoir: she is the only figure the bottom third of the
    // frame has ever had, and without her that third was 24 000 px of unbroken field.
    // The laterals are quoted as fractions of the visible half-width, which means two figures
    // with the SAME fraction land in the same screen column no matter how far apart they are
    // in depth. The first pass here used -0.52 / -0.55 / -0.62 for three of the six and they
    // duly stacked into one vertical pile on the left. Spread them.
    const squad = [
      // R25 wave 2: 6.4 m is not a repoussoir, it is a figure standing in the middle
      // distance with a quarter of the page of empty field underneath her. On a 1.95 m
      // lens at 40 degrees she cleared the bottom edge by ~230 px and the bottom third
      // was pasture again. 3.6 m crops her at the thigh, which is what a foreground
      // figure has to do to close the near field.
      // ...and -0.46 of the half-width projects to x = 518, which at this depth puts her
      // body behind the roster plate in the lower-left corner (x < 520). -0.20 lands her
      // at x = 768: still left of the centre column, clear of every HUD panel.
      ['Marina Wulfstan', 3.6, -0.20],
      ['Edy Nelson', 10.5, 0.34],
      ['Largo Potter', 15.0, -0.13],
      ['Alicia Melchiott', 20.0, 0.66],
      ['Isara Gunther', 25.0, -0.74],
      ['Rosie Stark', 30.0, 0.10],
    ];
    for (const [name, d, f] of squad) {
      const [x, z] = S.at(d, lat(d, f));
      pose(ctx, unitNamed(ctx, name), x, z, facing(x, z, 4, 2), 'idle');
    }
    const tank = b.units.find((u) => u.isVehicle && u.team === 0);
    const [kx, kz] = S.at(13.5, lat(13.5, 0.55));
    pose(ctx, tank, kx, kz, facing(kx, kz, 4, 2) - 0.42, 'idle');
    turretTo(tank, facing(kx, kz, -14, 22));

    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 5);
    const foeSpots = [[3, -7], [11, -11], [-4, -5], [15, -20], [6, -23]];
    foe.forEach((u, i) => {
      const [x, z] = foeSpots[i];
      pose(ctx, u, x, z, facing(x, z, 8, 24), 'idle');
    });

    // Down off the eleven-metre map camera and onto the field, and nosed DOWN: the old aim
    // put a third of the page into an empty upper-right sky wash. From 1.95 m the horizon
    // lands just above the middle, the far bank and the town close the top, and the raking
    // shadows own the bottom two thirds.
    aimCameraG(ctx, CX, 1.95, CZ, TX, 0.85, TZ, FOV);

    finale(ctx, 6, (i) => {
      if (i === 0) smokeColumn(ctx, 34, -46, 11, 9, { size: 2.2, alpha: 0.32, drift: 5, frames: 6 });
    });
    await frames(14);
  },
};

export const SHOT_NAMES = Object.keys(SHOTS);

/**
 * Where the triangles actually go, bucketed by subsystem.
 *
 * renderer.info gives ONE number for the whole frame, which is useless for a
 * budget: round 3 went from 2.9 M to 5.2 M and nobody could say which system
 * ate the 2.3 M. This walks the live scene the way the renderer does — visible
 * only, honouring InstancedMesh.count and the LOD tile toggles — and sums the
 * index count per top-level bucket. It is the same arithmetic the GPU does
 * minus frustum culling, so it over-reports the wide shots slightly and is
 * exactly right about the RATIO between systems, which is the number a budget
 * conversation needs.
 */
export function triangleBreakdown(ctx) {
  const out = {};
  const bucketOf = (o) => {
    for (let p = o; p; p = p.parent) {
      if (p.name === 'vegetation') return o.name?.startsWith('trunks:') ? 'trunks'
        : o.userData.vegBucket || 'grass';
      if (p.name === 'terrain') return 'terrain';
      if (p.name === 'structures') return 'structures';
      if (p.name === 'props') return 'props';
      if (p.name === 'water') return 'water';
      if (p.isScene) break;
    }
    return o.isSkinnedMesh ? 'actors' : 'other';
  };
  ctx.scene?.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const idx = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
    const range = g.drawRange;
    const n = Math.min(idx, range && range.count !== Infinity ? range.count : idx);
    const tris = (n / 3) * (o.isInstancedMesh ? o.count : 1);
    const b = bucketOf(o);
    out[b] = (out[b] || 0) + tris;
  });
  let total = 0;
  for (const k of Object.keys(out)) { out[k] = Math.round(out[k]); total += out[k]; }
  out.total = total;
  return out;
}

/**
 * Run a named shot. Unknown names fall back to `overview` so the harness never hangs.
 * Resolves when the pose is set; main.js then settles the frame and runs `ctx.finale`.
 */
/**
 * Put the world back to a known baseline before a shot poses it.
 *
 * WHY THIS EXISTS — measured, round 15. The batch harness renders every shot
 * into ONE booted world, and a shot only sets the state it cares about. `aim`
 * takes `battle.actionMode` into over-the-shoulder aim (phase 'action',
 * `am.timeScale = aimSlowFactor`, its own fov/armLength/shoulder) and nothing
 * put it back, so the NEXT shot in batch order inherited that camera. The
 * shipped `tank` plate was measured at mean 35.8 LSB from a cold
 * `shoot.mjs tank` render and matched the `aim` frame instead — a whole round of
 * running-gear work was reviewed on the wrong frame and scored as a failure.
 *
 * Only 7 of the 12 shots call hideAll(), so unit visibility leaked the same way.
 *
 * This is also what makes a RESIDENT renderer safe (tools/renderd.mjs keeps one
 * page alive for the whole session): the cost of a cold boot is ~7 s and the only
 * thing it was buying us was a clean baseline. Establish the baseline explicitly
 * and the boot is pure waste.
 *
 * Keep this in sync with anything a shot mutates. The rule for a new shot is: if
 * you set it and it is not per-unit pose, it belongs here.
 */
export function resetShotState(ctx) {
  const b = ctx.battle;
  if (!b) return;

  // ROUND 24 - the fx system now parents live objects to the scene (the
  // onomatopoeia sprites), and a resident render daemon reuses one world across
  // shots. Anything that survives a shot is a determinism bug: `--verify
  // firefight` caught this immediately, reporting "NOT reproducible" because the
  // words a previous shot's muzzle flashes had thrown were still in the scene.
  // fx.clear() drops the sprites and resets every particle pool.
  (ctx.fx || b.fx || ctx.engine?.fx)?.clear?.();

  // Modes. exitAim() before exit(): aim is a sub-state of action mode, and
  // exiting the parent first leaves the aim fov/armLength drive latched on.
  const am = b.actionMode;
  if (am) {
    am.exitAim?.();
    am.exit?.();
    am.active = false;
    am.timeScale = am.timeScaleTarget = 1;
    // fovTarget/armTarget/shoulderTarget are the drives; the `aim` shot snaps the
    // current values onto them (line ~1068) so both sides must be cleared.
    if (am.fovTarget !== undefined) am.fov = am.fovTarget = am.fovRest ?? am.fovTarget;
    // R25: the comment above was right and the code was half of it. `aim` now also snaps
    // armLength and shoulder onto over-the-shoulder targets — including a NEGATIVE shoulder,
    // which would otherwise ride into the next shot's action camera and mirror it. exitAim()
    // has already restored the two drives to their gameplay defaults, so copying them onto
    // the live values is the whole reset.
    if (am.armTarget !== undefined) am.armLength = am.armTarget;
    if (am.shoulderTarget !== undefined) am.shoulder = am.shoulderTarget;
  }
  b.commandMode?.exit?.();
  b.setPhase?.('command');

  // The order hand. `command` deals it out explicitly (see that shot's tail); shut is
  // the resting state for every other plate, and a hand left dealt would ride into the
  // next shot's lower-left corner. Same class of leak as the aim-camera latch above.
  ctx.ui?._toggleOrders?.(false);

  // Camera. main.js holds the base plate at fov 32 whenever no mode is driving
  // it; a shot that set its own fov (command uses 41) must not export that.
  if (ctx.camera && ctx.camera.fov !== 32) {
    ctx.camera.fov = 32;
    ctx.camera.updateProjectionMatrix();
  }

  // Selection. The field HUD captions itself from activeUnit/selected, so a unit
  // left latched by an earlier shot leaks into a later one's corner plate.
  b.activeUnit = null;
  if ('selected' in b) b.selected = null;
  if ('selectedUnit' in b) b.selectedUnit = null;

  // LIVE BATTLE STATE. `ap` is spent by the `action`/`aim`/`firefight` shots and
  // was never restored, so the AP readout became a function of shot ORDER and
  // printed it in 40px type — `--verify` failed on five shots at up to 1.65% of
  // pixels. Anything the HUD prints as a number has to be restored here, not
  // just anything that moves geometry.
  for (const u of (b.units || [])) {
    if (u.maxAp !== undefined) u.ap = u.maxAp;
    if (u.actionsThisTurn !== undefined) u.actionsThisTurn = 0;
    if (u.acted !== undefined) u.acted = false;
    // The locomotion cycle is a free-running accumulator: see Animator.resetPhase().
    u.actor?.animator?.resetPhase?.();
  }

  // Units: every shot declares its own cast via show(), so start from none.
  hideAll(ctx);

  ctx.finale = null;
}

export async function runShot(name, ctx) {
  const fn = SHOTS[name] || SHOTS.overview;
  resetShotState(ctx);
  ctx.finale = null;
  await fn(ctx);
  await frames(3);
  if (typeof window !== 'undefined') {
    window.__STATS__ = Object.assign({}, window.__STATS__, {
      shot: name,
      units: ctx.battle?.units.length ?? 0,
      phase: ctx.battle?.phase ?? null,
      turn: ctx.battle?.turn ?? 0,
      tris: triangleBreakdown(ctx),
    });
  }
  return true;
}

export default SHOTS;
