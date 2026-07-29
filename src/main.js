// src/main.js — the integrator.
//
// Owns every instantiation site in the game: Engine, World, light rig, render
// pipeline, FX, physics, Battle, HUD, audio; the front-end flow
// (title -> chapter -> briefing -> opening script -> deployment -> battle); and
// the deterministic capture path the screenshot critic drives through
// `tools/shoot.mjs` (?capture&shot=<name> -> window.__READY__ / __STATS__).
//
// Nothing else in the tree reaches across module boundaries: the systems below
// only ever meet each other here or on the Bus.

import * as THREE from 'three';

import { CFG, byQ } from './core/config.js';
import { Bus } from './core/bus.js';
import { Input } from './core/input.js';
import { makeRng } from './core/rng.js';
import { Engine } from './core/engine.js';

import { CanvasRenderPipeline } from './render/canvasRenderPipeline.js';
import { createLightRig } from './render/lighting.js';
import { FxSystem } from './render/fx.js';
import { MaterialRegistry } from './render/materials.js';

import { World } from './world/world.js';
import { WorldLighting } from './world/worldMaterials.js';

import {
  PhysicsWorld, WEAPON_BALLISTICS, GRAVITY, groundUnder,
} from './physics/index.js';

import { Battle } from './game/battle.js';
import { setPhysics } from './game/combat.js';
import { startMission, MISSION_VASEL } from './game/mission.js';
import { SHOT_NAMES, runShot } from './game/captureShots.js';

import { Character } from './actors/character.js';
import { Tank } from './actors/tank.js';

import { HUD } from './ui/hud.js';
import { injectStyles } from './ui/style.js';
import { h, panel, label } from './ui/dom.js';
import { ribbonButton } from './ui/screens.js';

import { AudioEngine } from './audio/engine.js';

// ---------------------------------------------------------------------------
// Constants / scratch
// ---------------------------------------------------------------------------

/** Virtual frame length used in capture mode so a shot is a pure function of
 *  its frame count and not of how fast this particular GPU happened to be. */
const CAPTURE_DT = 1 / 60;

/** Frames pumped before the shot runs: shader compile, first shadow pass, LOD. */
const CAPTURE_WARMUP = 10;
/** Settle bounds after the shot. Deterministic: both are frame counts. */
const SETTLE_MIN = 14;
const SETTLE_MAX = 200;
/**
 * Total frames the settle stage ALWAYS runs, convergence or not.
 *
 * Convergence alone is not enough for a repeatable PNG. Everything in the world
 * that moves — wind on the grass, the cloud FBM's scroll, the shared material
 * clock, a contact-shadow or banding term that is a function of world time — is
 * advanced once per settle frame, so its phase in the captured frame is a
 * function of HOW MANY settle frames happened to run. That count depends on when
 * the last shader finished compiling and when the foliage LOD stopped streaming,
 * which is a property of the GPU and not of the shot. Padding to a fixed total
 * removes the dependency entirely: the shutter always opens on frame
 * CAPTURE_WARMUP + <shot frames> + SETTLE_TOTAL + finale, on every machine.
 */
const SETTLE_TOTAL = 120;
/** Hard watchdog so the harness always gets a frame instead of a 45 s timeout. */
const CAPTURE_WATCHDOG_MS = 32000;

/**
 * PIXEL convergence, run after the world has been frozen.
 *
 * The settle loop above keys on `renderer.info` and the label layer, which
 * catches everything that changes the DRAW LIST and nothing that changes only
 * the picture. Measured on `command`: the PNG at --wait 900 and the PNG at
 * --wait 2600 differ on 18.3% of their bytes (max 60 LSB), the difference
 * concentrated on the masonry and the terrain edges — i.e. something is still
 * converging after `__READY__` with every render counter identical, so the
 * harness reports success and writes whichever of two different images the
 * shutter happened to land on. Both long waits agree with each other, so it is
 * a settling process and not noise.
 *
 * The only signal that catches that is the frame itself. After the freeze the
 * loop below keeps pumping render-only frames and downsamples each one to a
 * PIXEL_PROBE-wide thumbnail; the shutter is only armed once consecutive
 * thumbnails stop moving. It is bounded in FRAMES, so it cannot make the
 * capture a function of wall-clock time, and the world is already paused, so
 * the extra frames cannot advance an animation.
 */
// 256, not 128. The probe is the ONLY thing standing between the harness and a
// frame that is still moving, and a 128-wide thumbnail of a 1920-wide page
// averages 15 x 15 source pixels into one sample — which is a 225:1 low-pass
// over exactly the high-frequency ink, hatch and grain the whole art direction
// is made of. Measured on `command` and `village`, two captures of the same shot
// taken at --wait 700 and --wait 2600 still differed by up to 21 and 30 LSB on
// isolated pixels with the old probe reporting convergence: the difference was
// real and the probe could not see it.
const PIXEL_PROBE_W = 256;
const PIXEL_STABLE_FRAMES = 30;
const PIXEL_SETTLE_MAX = 900;
/**
 * Mean absolute LSB difference between two probes that still counts as equal.
 *
 * 0.25 was two and a half times too loose: convergence here is asymptotic (the
 * grade, the wet-edge term and the overlay washes all creep toward a fixed
 * point), so the threshold IS the residual, and 0.25 LSB of thumbnail residual
 * is tenths of an LSB of full-frame residual with occasional 20-LSB outliers
 * where a band boundary happens to sit on a quantiser step. At 0.05 the loop
 * costs a few dozen extra render-only frames on a paused scene — nothing, since
 * `settlePixels` runs after the freeze — and buys a genuinely repeatable PNG.
 */
const PIXEL_EPS = 0.05;

const _focus = new THREE.Vector3();

const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
async function frames(n) { for (let i = 0; i < n; i++) await raf(); }

// ---------------------------------------------------------------------------
// Fatal-error surface. A black screen tells the critic nothing; a stack does.
// ---------------------------------------------------------------------------

function showFatal(err, where = 'boot') {
  const message = String((err && err.message) || err);
  const stack = String((err && err.stack) || '');
  console.error(`[main] ${where} failed:`, err);
  try {
    window.__BOOT_ERROR__ = { where, message, stack };
    let el = document.getElementById('vc-fatal');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'vc-fatal';
      el.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:9999', 'margin:0', 'padding:4vh 5vw',
        'background:#17120e', 'color:#e8d9be', 'overflow:auto', 'white-space:pre-wrap',
        'font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent =
      `Valkyrie Chronicles — ${where} failed\n\n${stack || message}\n\n` +
      `capture=${CFG.capture} shot=${CFG.captureShot || '-'} quality=${CFG.quality} seed=${CFG.seed}`;
  } catch (e) {
    console.error('[main] could not render the error overlay', e);
  }
  // Give the harness something to report instead of a null stats blob.
  window.__STATS__ = Object.assign({}, window.__STATS__, {
    shot: CFG.captureShot || null, fatal: true, where, error: message,
  });
  window.__READY__ = true;
}

// ---------------------------------------------------------------------------
// System construction. Dependency order is load-bearing, see the comments.
// ---------------------------------------------------------------------------

function buildSystems() {
  const canvas = document.getElementById('view');
  if (!canvas) throw new Error('#view canvas is missing from index.html');

  const engine = new Engine(canvas);
  const { scene, camera, renderer } = engine;
  // A scripted shot must not be steerable: no stray key from the harness gets in.
  if (CFG.capture) Input.enabled = false;

  // --- lights first -------------------------------------------------------
  // World._makeLights() adopts an existing key light by NAME rather than adding
  // a second one (the banded NPR shading is calibrated for exactly one
  // directional source), so the rig has to exist — and be named — before the
  // World is built.
  const rig = createLightRig(scene, {
    timeOfDay: MISSION_VASEL.timeOfDay ?? 0.34,
    azimuth: 0.95,
    shadowRadius: 32,
    shadowDistance: 110,
  });
  // (createLightRig already names them 'sun' / 'worldFill' — that IS the
  // handshake World._makeLights() looks for. Nothing to do here.)

  // --- world --------------------------------------------------------------
  const world = new World(scene, CFG.seed);

  // The sky dome and every fallback world material read WorldLighting, while the
  // NPR pipeline reads the rig. Keep the two agreeing or the sun sits in one
  // place and its shadows fall from another.
  const applyTimeOfDay = (t) => {
    rig.setTimeOfDay(t);
    rig.sunDirection(WorldLighting.sunDir);
    WorldLighting.sunColor.copy(rig.sun.color);
    WorldLighting.sunIntensity = rig.sun.intensity;
  };
  let sunTod = MISSION_VASEL.timeOfDay ?? 0.34;
  applyTimeOfDay(sunTod);
  // captureShots.setSun() publishes this; World exposes no setter itself.
  // `azimuth` is how a scripted shot lights *for the camera* — it puts the key
  // three-quarters behind whatever that shot has framed, which is the only way
  // a fixed compass direction and an arbitrary camera yaw can both be right.
  Bus.on('world:timeOfDay', (p) => {
    if (!p) return;
    if (typeof p.azimuth === 'number') rig.setAzimuth(p.azimuth);
    if (typeof p.t === 'number') sunTod = p.t;
    applyTimeOfDay(sunTod);
  });

  // --- render pipeline ----------------------------------------------------
  const pipeline = new CanvasRenderPipeline(renderer, scene, camera);
  pipeline.setLightRig(rig);
  engine.pipeline = pipeline;          // Engine.start() renders through it

  // --- fx -----------------------------------------------------------------
  const fx = new FxSystem(scene);
  // FxSystem defaults to Math.random for jitter; a screenshot must repeat.
  if (CFG.capture) fx.rng = makeRng((CFG.seed ^ 0x9e3779b9) >>> 0);

  // --- physics ------------------------------------------------------------
  const physics = new PhysicsWorld(world);
  // combat.js traces the world itself unless an adapter is installed. We give it
  // the parts of src/physics that are strictly better than its fallbacks, and we
  // deliberately do NOT hand it `raycast`: both raycasts are now correct (the
  // physics one is world-aware and filters on `blocksProjectile` for rounds and
  // `blocksLos` for sight, same as the World's), but only the World's goes
  // through the uniform-grid broadphase — the physics one is a linear scan over
  // every collider on the map, which for hitscan volume is the wrong trade.
  setPhysics({ GRAVITY, groundUnder });

  // --- battle -------------------------------------------------------------
  // Battle.makeActor() cannot see the PhysicsWorld, so a Tank built by it gets
  // no ballistics and never joins the fixed-step clock. actorFactory is the
  // documented hook for exactly this.
  Battle.actorFactory = (u, spec = {}) => {
    try {
      if (u.isVehicle) {
        return new Tank({
          team: u.team, name: u.name, seed: u.seed, variant: spec.variant,
          world, scene, physics, hp: u.maxHp,
        });
      }
      return new Character({
        class: u.cls, team: u.team, name: u.name, seed: u.seed,
        ground: (x, z) => world.groundHeightAt(x, z),
        quality: CFG.quality,
      });
    } catch (e) {
      console.warn('[main] actor construction failed, using placeholder', e);
      const g = new THREE.Group();
      g.name = `${u.name}-placeholder`;
      return { root: g, play() {}, setAimAngles() {}, update() {}, dispose() {} };
    }
  };

  const battle = new Battle(world, scene, { camera, mission: MISSION_VASEL, seed: CFG.seed });
  battle.setup();
  battle.attachCamera(camera);
  physics.setUnits(battle.units);

  // An inactive mode owns nothing. CommandMode.update() drives the map camera
  // even when it is not active, which fights whoever legitimately owns the view
  // (the opening cutscene, the title orbit, a capture shot that aimed the camera
  // itself). Gate it here rather than letting two systems write camera.position.
  const cm = battle.commandMode;
  const cmUpdateCamera = cm.updateCamera.bind(cm);
  let captureUiMode = 'none';
  cm.updateCamera = (dt) => {
    if (!cm.active) return;
    if (CFG.capture && captureUiMode !== 'command') return;   // the shot framed it
    cmUpdateCamera(dt);
  };

  // --- ui -----------------------------------------------------------------
  injectStyles();
  const hud = new HUD(battle, {
    camera, mission: battle.mission, autoChapter: false,
  });
  hud.briefing.hide();

  const hudHost = document.getElementById('hud');
  Bus.on('ui:captureMode', (p) => {
    captureUiMode = (p && p.mode) || 'none';
    if (hudHost) hudHost.style.display = captureUiMode === 'none' ? 'none' : '';
  });

  // --- audio --------------------------------------------------------------
  // Constructed (and Bus-wired) always; ctx creation waits for a user gesture,
  // and in capture mode it never happens at all.
  const audio = new AudioEngine({ seed: CFG.seed });
  audio.setMusicState('menu');          // S11: the boot state is the menu bed

  return { engine, scene, camera, renderer, rig, world, pipeline, fx, physics, battle, hud, audio };
}

// ---------------------------------------------------------------------------
// S12 — combat VFX. FxSystem already self-wires `shot:hit` -> impact() and
// `explosion` -> explosion(); everything below is what nobody was consuming:
// the muzzle flash, ejected brass, and tracers for both the hitscan path
// (combat.fireRound) and the simulated path (physics/ballistics projectiles).
// ---------------------------------------------------------------------------

const NO_CASING = new Set(['lance', 'cannon', 'grenade', 'mortar', 'flame']);

function weaponKind(w) {
  if (!w) return 'rifle';
  if (typeof w === 'string') return w;
  return w.kind || w.type || 'rifle';
}

/**
 * Muzzle velocity for a `shot:fired` payload. combat.fireRound now resolves the
 * ballistics profile itself and publishes `speed`/`ballistics`, so prefer those
 * and only fall back to guessing from the weapon's `kind`.
 */
function muzzleSpeed(p) {
  if (p && p.speed > 0) return p.speed;
  const w = p && p.weapon !== undefined ? p.weapon : p;
  const id = (w && w.ballistics) || (p && p.ballistics) || weaponKind(w);
  const prof = WEAPON_BALLISTICS[id]
    || WEAPON_BALLISTICS[id === 'cannon' ? 'tankAP' : 'rifle'];
  return (prof && prof.v0) || 480;
}

/** Deterministic "is this round a tracer": a hash of the projectile id. */
function tracerRoll(id, chance) {
  if (chance >= 1) return true;
  if (chance <= 0) return false;
  let x = Math.imul(id ^ 0x9e3779b9, 2246822519);
  x = Math.imul(x ^ (x >>> 15), 3266489917);
  return (((x ^ (x >>> 16)) >>> 0) / 4294967296) < chance;
}

function wireCombatFx({ fx, physics, world }) {
  const pending = { origin: new THREE.Vector3(), weapon: null, speed: 0, live: false };
  const _fwd = new THREE.Vector3(0, 0, 1);     // fallback direction
  const _at = new THREE.Vector3();             // casing spawn
  const _caseOpt = { weapon: null, groundY: 0 };
  const _tracerOpt = { speed: 0, weapon: null };
  const _segOpt = { weapon: null };

  Bus.on('shot:fired', (p) => {
    if (!p || !p.origin) return;
    const dir = p.dir || _fwd;
    // fx resolves flash size, gas volume and backblast from the weapon record
    // (or from a ballistics profile name) — pass it through rather than letting
    // every gun in the game flash like a rifle.
    fx.muzzleFlash(p.origin, dir, p.weapon);

    // Ejected brass, off the weapon's own ejection port when the actor has one.
    // fx.shellCasing takes the FIRING DIRECTION and builds the ejection frame
    // itself (up + shooter's right + a little forward carry), so we must not
    // hand it a velocity here.
    const kind = weaponKind(p.weapon);
    const u = p.unit;
    if (!NO_CASING.has(kind) && u && !u.isVehicle) {
      const node = u.actor && u.actor.weapon && u.actor.weapon.userData
        && u.actor.weapon.userData.eject;
      if (node) {
        const e = node.matrixWorld.elements;
        _at.set(e[12], e[13], e[14]);
      } else {
        _at.copy(p.origin).addScaledVector(dir, -0.28);
      }
      _caseOpt.weapon = p.weapon;
      _caseOpt.groundY = world.groundHeightAt(_at.x, _at.z) + 0.02;
      fx.shellCasing(_at, dir, _caseOpt);
    }

    // Hitscan tracer: fireRound() emits shot:fired, traces, then shot:hit in the
    // same tick, so the hit point of the next shot:hit is this shot's endpoint.
    pending.live = !!p.tracer;
    if (pending.live) {
      pending.origin.copy(p.origin);
      pending.weapon = p.weapon;
      pending.speed = muzzleSpeed(p);
    }
  });

  Bus.on('shot:hit', (p) => {
    if (!pending.live) return;
    pending.live = false;
    if (!p || !p.point) return;
    _tracerOpt.speed = pending.speed;
    _tracerOpt.weapon = pending.weapon;
    fx.tracer(pending.origin, p.point, _tracerOpt);
  });

  // Simulated rounds (tank main gun, lance) live for many frames. A drag +
  // gravity round is a curve, so stamp the segment it actually covered this
  // frame — consecutive stamps tile head-to-tail into the true path. `tracer()`
  // is the straight-line hitscan streak and would cut the corner.
  const trail = new Map();          // projectile id -> { at:Vector3, seen:number }
  let tick = 0;

  return function updateTracers(dt) {
    const list = physics.ballistics.projectiles;
    tick++;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      if (!pr.alive || !(pr.tracer > 0)) continue;
      if (!tracerRoll(pr.id, pr.tracer)) continue;
      let rec = trail.get(pr.id);
      if (!rec) {
        rec = { at: new THREE.Vector3().copy(pr.spawn), seen: tick };
        trail.set(pr.id, rec);
      }
      rec.seen = tick;
      if (rec.at.distanceToSquared(pr.renderPos) > 1e-4) {
        _segOpt.weapon = pr.weapon;
        fx.tracerSegment(rec.at, pr.renderPos, dt, _segOpt);
        rec.at.copy(pr.renderPos);
      }
    }
    if ((tick & 63) === 0 && trail.size) {
      for (const [id, rec] of trail) if (rec.seen < tick - 2) trail.delete(id);
    }
  };
}

// ---------------------------------------------------------------------------
// Frame systems
// ---------------------------------------------------------------------------

function installSystems(S, updateTracers) {
  const { engine, camera, renderer, world, battle, fx, physics, hud, audio } = S;

  // The pipeline renders the scene and then several full-screen passes; with
  // three's default auto-reset `renderer.info` would only ever describe the last
  // of them (one triangle). Reset once per frame instead so the counters mean
  // "this frame", which is what the capture stats report.
  renderer.info.autoReset = false;
  engine.add({ update: () => renderer.info.reset() });

  // MaterialRegistry only advances its shared clock when at least 2 ms of WALL
  // time have passed since the last call (a guard against double-advancing when
  // two systems drive it). Under an unthrottled capture that guard makes the
  // paper/wind/hatch phase depend on how fast the GPU happened to be, so pixels
  // stop repeating. Re-arm it every frame: the pipeline is the only caller, and
  // one virtual frame must advance the clock exactly once.
  if (CFG.capture) engine.add({ update: () => { MaterialRegistry._last = -Infinity; } });

  // 1. physics first: everything below reads the results of this tick.
  engine.add(physics);
  // 2. game logic (units, action/command modes, AI, camera for those modes).
  engine.add(battle);
  // 3. the living world (wind, water, foliage, LOD) — needs the camera.
  engine.add({ update: (dt) => world.update(dt, camera) });
  // 4. tracers read ballistics' interpolated render positions from step 1.
  engine.add({ update: updateTracers });
  // 5. FX pools flush after everything that could have written to them.
  engine.add(fx);
  // 6. shadow frustum follows the action.
  engine.add({ update: (dt) => updateLighting(S, dt) });
  // 7. audio listener rides the camera.
  engine.add({ update: (dt) => { if (audio.ready) audio.update(dt, camera); } });
  // 8. UI observes the settled state of the frame.
  engine.add(hud);

  if (!CFG.capture) engine.add({ update: (dt) => autoQuality(S, dt) });
}

let _shadowRadius = 0;
const _ray = new THREE.Vector3();

/**
 * Where the camera is actually looking, on the ground.
 *
 * The old version put the focus a flat 26 m down the view ray, which is right for an
 * over-the-shoulder camera and badly wrong for a landscape shot: from a ridge 100 m back from
 * the subject the shadow frustum ended up centred on the empty foreground, so the bridge and
 * the town — the things the frame is about — fell outside it and lost their shadows entirely.
 * March the ray to the heightfield instead and let the framing choose the frustum.
 */
function viewGroundFocus(camera, world, out) {
  camera.getWorldDirection(_ray);
  const ox = camera.position.x, oy = camera.position.y, oz = camera.position.z;
  const gap = (t) => (oy + _ray.y * t) - world.groundHeightAt(ox + _ray.x * t, oz + _ray.z * t);
  let lo = 2, hi = 2;
  if (gap(lo) <= 0) { out.set(ox + _ray.x * lo, 0, oz + _ray.z * lo); }
  else {
    let found = false;
    for (let t = 8; t <= 200; t += 8) { if (gap(t) <= 0) { lo = t - 8; hi = t; found = true; break; } }
    if (!found) { lo = hi = 60; }               // aimed at the sky: pick a sane mid-distance
    for (let i = 0; i < 8 && hi > lo; i++) {
      const mid = (lo + hi) * 0.5;
      if (gap(mid) <= 0) hi = mid; else lo = mid;
    }
    out.set(ox + _ray.x * hi, 0, oz + _ray.z * hi);
  }
  out.y = world.groundHeightAt(out.x, out.z);
  return out;
}

function updateLighting(S, dt) {
  const { battle, camera, world, rig } = S;

  // A SCRIPTED SHOT is framed by its camera and by nothing else. Deferring to
  // `battle.activeUnit` here is what left the tank, the bridge and half the
  // landscape shots with no cast shadows at all: ensureBattle() leaves whichever
  // soldier the battle happened to activate as the active unit, that soldier is
  // usually not even visible in the shot, and the 26 m ortho frustum then gets
  // snapped around HIM — so the object the frame is actually about falls outside
  // the shadow map entirely and lands on the ground as a decal. Follow the lens.
  if (CFG.capture) viewGroundFocus(camera, world, _focus);
  else if (battle.activeUnit && battle.activeUnit.pos) _focus.copy(battle.activeUnit.pos);
  else if (battle.commandMode && battle.commandMode.active) _focus.copy(battle.commandMode.target);
  else viewGroundFocus(camera, world, _focus);

  // Quantised so the texel-snapped shadow frustum does not resize every frame
  // (which would make the shadow edge boil). The rig sizes its normal bias from
  // the world size of one shadow texel at construction time, so widening the
  // frustum without re-deriving it is what produces striped acne on the terrain.
  const d = camera.position.distanceTo(_focus);
  const want = d < 24 ? 26 : d < 46 ? 38 : d < 78 ? 54 : 72;
  if (want !== _shadowRadius) {
    rig.setShadowRadius(want);
    const mapSize = byQ(CFG.render.shadowMapSize);
    rig.sun.shadow.normalBias = ((want * 2) / mapSize) * 2.4;
    _shadowRadius = want;
  }

  // A scripted shot cuts the camera rather than flying it, so the follow spring has nothing
  // to smooth: snap the frustum onto the new framing instead of spending the settle loop
  // sliding toward it (which would leave the subject half out of the shadow camera).
  rig.update(CFG.capture ? 1 : dt, _focus);
}

// --- quality auto step-down (never in capture mode) -------------------------
let _slow = 0;
let _lastStep = -99;

function autoQuality(S, dt) {
  const { pipeline, engine, hud } = S;
  if (dt > 1 / 42) _slow++; else _slow = Math.max(0, _slow - 2);
  if (_slow < 90) return;
  _slow = 0;
  if (pipeline.quality <= 0 || engine.time - _lastStep < 8) return;
  _lastStep = engine.time;
  pipeline.setQuality(pipeline.quality - 1);
  hud.toast(`RENDER QUALITY: ${['LOW', 'HIGH', 'ULTRA'][pipeline.quality]}`);
  console.warn('[main] frame budget missed, quality ->', pipeline.quality);
}

// ---------------------------------------------------------------------------
// Normal play: title -> chapter -> briefing -> opening script -> deploy -> battle
// ---------------------------------------------------------------------------

function titleScreen(S, onBegin) {
  const { hud } = S;
  const root = h('div', { class: 'vc-screen vc-titlecard' });
  root.appendChild(h('div', { class: 'vc-scrim' }));
  const p = panel({ seed: 1917, cls: '', tilt: 0.3, under: true, amp: 1.1 });
  p.root.style.width = 'min(44em, 80vw)';
  const inner = h('div', { class: 'vc-page-in', style: 'text-align:center' });
  inner.appendChild(label('Gallian Militia · Squad 7'));
  inner.appendChild(h('div', { class: 'vc-h1 vc-it', text: 'Valkyrie Chronicles' }));
  inner.appendChild(h('div', {
    class: 'vc-body', style: 'margin-top:.7em;max-width:30em;margin-left:auto;margin-right:auto',
    text: 'A record of the Second Europan War, as it was written down afterwards by '
      + 'the people who were there.',
  }));
  const row = h('div', { class: 'vc-btnrow', style: 'justify-content:center' });
  const begin = ribbonButton('Open the Book', () => start(), { w: 16, key: 'Enter', seed: 61 });
  row.appendChild(begin);
  inner.appendChild(row);
  p.content.appendChild(inner);
  root.appendChild(p.root);
  hud.screens.appendChild(root);

  let started = false;
  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') start();
  };
  addEventListener('keydown', onKey);

  function start() {
    if (started) return;
    started = true;
    removeEventListener('keydown', onKey);
    root.remove();
    onBegin();
  }
  return { start };
}

function playFlow(S) {
  const { engine, camera, world, battle, hud, audio } = S;

  // A slow orbit over the valley behind the title card and the briefing.
  const orbit = {
    t: 0,
    enabled: true,
    update(dt) {
      if (!this.enabled) return;
      this.t += dt;
      const a = 0.55 + this.t * 0.028;
      const x = 4 + Math.sin(a) * 74;
      const z = 2 + Math.cos(a) * 74;
      camera.position.set(x, world.groundHeightAt(x, z) + 30, z);
      camera.lookAt(4, 5, -4);
      if (camera.fov !== 32) { camera.fov = 32; camera.updateProjectionMatrix(); }
    },
  };
  engine.add(orbit);

  // The audio context may only be created inside a user gesture — the title
  // button is that gesture.
  const startAudio = () => {
    if (audio.ready) return;
    audio.init().then(() => {
      audio.setMusicState('menu');                    // S11
    }).catch((e) => console.warn('[main] audio init failed', e));
  };

  // S11: the front-end phases have no music mapping of their own.
  Bus.on('phase:change', (p) => {
    if (!audio.ready || !p) return;
    if (p.to === 'briefing' || p.to === 'deploy') audio.setMusicState('menu');
  });

  const title = titleScreen(S, () => {
    startAudio();
    hud.showChapter({ onDone: () => hud.showBriefing({}) });
  });
  void title;

  // Briefing -> the scripted opening -> deployment.
  let script = null;
  Bus.on('ui:briefingDone', () => {
    if (script) return;
    orbit.enabled = false;
    script = startMission(battle, camera, battle.mission.id);
    engine.add({ update: (dt) => script.update(dt) });
  });

  // The opening script publishes plain `dialogue` beats; the HUD listens on the
  // ui: channel.
  Bus.on('dialogue', (p) => {
    if (!p) return;
    hud.say({ name: p.who, text: p.text, hold: p.dur });
  });
  Bus.on('title', (p) => { if (p && p.text) hud.alert(p.text, p.sub || ''); });

  // Deployment: the screen hands back { campId: [unit, ...] }.
  Bus.on('ui:deployConfirm', (p) => {
    if (battle.phase !== 'deploy') return;
    const slots = battle.deploySlots();
    const assignments = (p && p.assignments) || {};
    const used = new Set();
    const take = (campId) => slots.find((s) => !used.has(s.index) && s.camp === campId)
      || slots.find((s) => !used.has(s.index));

    battle.deployment.clear();
    for (const u of battle.units) if (u.team === 0 && !u.isVehicle) u.deployed = false;
    for (const campId of Object.keys(assignments)) {
      for (const unit of assignments[campId]) {
        const slot = take(campId);
        if (!slot) continue;
        used.add(slot.index);
        battle.deploy(unit, slot);
      }
    }
    if (!battle.deployment.size) battle.autoDeploy();
    battle.confirmDeployment();
  });

  // Pause: the HUD owns the menu, the engine owns the clock.
  Bus.on('ui:pause', (p) => {
    const paused = !p || p.paused !== false;
    engine.paused = paused;
    if (audio.ready) { if (paused) audio.suspend(); else audio.resume(); }
  });
  Bus.on('ui:resume', () => { engine.paused = false; if (audio.ready) audio.resume(); });

  // The HUD announces intent and never mutates the battle; this is where the
  // intent is actually carried out.
  Bus.on('ui:endTurn', () => { if (battle.phase === 'command') battle.endTurn(); });
  Bus.on('ui:selectUnit', (p) => { if (p && p.unit) battle.selectUnit(p.unit); });
  Bus.on('ui:order', (p) => {
    const id = p && p.order && (p.order.id || p.order);
    if (id) battle.useOrder(id, p.unit || null);
  });
  Bus.on('ui:resultsDone', () => location.reload());
  Bus.on('ui:restart', () => location.reload());

  // Skip the cutscene.
  addEventListener('keydown', (e) => {
    if (script && script.running && (e.key === 'Enter' || e.key === 'Escape')) script.skip();
  });

  // Tab-out shouldn't burn a laptop battery or fast-forward the fight on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      engine.paused = true;
      if (audio.ready) audio.suspend();
    } else if (!hud.pause.visible) {
      engine.paused = false;
      engine.clock.getDelta();          // drop the elapsed background time
      if (audio.ready) audio.resume();
    }
  });
}

// ---------------------------------------------------------------------------
// Capture mode — the visual-review loop depends on every line of this.
// ---------------------------------------------------------------------------

/**
 * A capture must never be reloaded out from under the shutter.
 *
 * tools/shoot.mjs points at the dev server and then waits `--wait` milliseconds
 * after __READY__ before it grabs the frame. If ANY module changes in that window
 * — and with several people editing the tree at once it regularly does — vite's
 * HMR client has no accept handler to hand the update to and falls back to a full
 * `location.reload()`. The page then boots again from scratch, and the screenshot
 * lands on a frame from the middle of that boot: the default camera, which sits at
 * the world origin inside the bridge abutment. That is where the identical
 * "close-up of a stone wall" PNG that overwrote three different shots came from,
 * and it is silent — __READY__ was still true from the previous life of the page,
 * so the harness reported no error and wrote the garbage frame over a good one.
 *
 * Clearing `payload.path` is the documented way to veto vite's full reload. It is
 * a no-op in a production build (`import.meta.hot` is undefined) and deliberately
 * only applies under ?capture: interactive development still hot-reloads.
 */
function pinModulesForCapture() {
  if (!CFG.capture || typeof import.meta === 'undefined' || !import.meta.hot) return;
  import.meta.hot.on('vite:beforeFullReload', (payload) => {
    console.warn('[main] suppressed an HMR full reload during capture');
    if (payload) payload.path = '/__vc_capture_never_reload__';
  });
}

async function captureFlow(S) {
  const { engine, scene, camera, renderer, pipeline, world, battle, fx, rig, hud, audio } = S;

  const requested = CFG.captureShot || 'overview';
  const shot = SHOT_NAMES.includes(requested) ? requested : 'overview';

  const hudHost = document.getElementById('hud');
  if (hudHost) hudHost.style.display = 'none';       // shots opt the UI back in
  hud.briefing.hide();
  hud.chapterCard.hide();

  // Measurement handle. `tools/probe.mjs` evaluates arbitrary script inside the
  // page with `vc` = window.__VC__ in scope, and the pipeline only ever put the
  // RENDER half of the game on it. Every claim about a shot's staging — how many
  // pixels tall a soldier projects, whether a counter has a soldier under it,
  // where the bridge actually is — needs the game half too, and measuring by eye
  // off a PNG is exactly how four rounds of "characters are too small" went
  // unnoticed. Capture builds only; a played build never has __VC__ at all.
  if (typeof window !== 'undefined') {
    window.__VC__ = Object.assign(window.__VC__ || {}, {
      engine, scene, camera, renderer, pipeline, world, battle, fx, rig, hud, Bus, CFG,
    });
  }

  // Compile every material we already know about before the clock starts, so
  // the first frames are not spent stalling on shader compiles.
  try { renderer.compile(scene, camera); } catch (e) { console.warn('[main] precompile', e); }

  await frames(CAPTURE_WARMUP);

  const ctx = {
    engine, scene, camera, renderer, battle, world, ui: hud, pipeline, audio, fx, rig,
    finale: null,
  };
  await runShot(shot, ctx);

  // Settle: hold frames until NOTHING is still converging. Every condition below
  // is a function of the frame count, never of wall-clock time, so the frame we
  // grab is the same frame on every machine:
  //   programs                 every shader the shot needs has compiled
  //   draw calls + triangles   LOD has resolved and the grass/foliage instancing
  //                            has finished streaming in around the new camera
  //   geometries + textures    nothing is still being uploaded
  //   _dofBlend                the pipeline's temporal depth-of-field has converged
  //   labels                   the DOM annotation layer (name slips, command-mode
  //                            counters, damage plates) has stopped adding or
  //                            hiding elements
  // Shadow maps re-render every frame, so a stable draw list means a stable shadow.
  //
  // The label layer is in the key because it is NOT part of renderer.info and it is
  // now load-bearing: `command` draws eighteen counters that are created lazily the
  // first frame their unit projects on screen and hidden again by a declutter pass,
  // so a frame grabbed while that layer was still settling would differ from the
  // next one with every render counter identical. Counting the visible elements is
  // one DOM query per settle frame and there are at most SETTLE_MAX of them.
  const labelHost = document.querySelector('.vc-world');
  const labelKey = () => {
    if (!labelHost) return '0';
    const kids = labelHost.children;
    let shown = 0;
    for (let i = 0; i < kids.length; i++) if (kids[i].style.visibility !== 'hidden') shown++;
    return kids.length + ':' + shown;
  };
  let n = 0, stable = 0, lastKey = '';
  let fpsFrames = 0, fpsT0 = 0;
  const wantDof = pipeline.quality >= 2 && pipeline.dof.enabled ? 1 : 0;
  while (n < SETTLE_MAX) {
    await raf();
    n++;
    if (n === 4) { fpsT0 = performance.now(); fpsFrames = 0; } else if (n > 4) fpsFrames++;
    const info = renderer.info;
    const key = `${info.programs ? info.programs.length : 0}|${info.render.calls}|`
      + `${info.render.triangles}|${info.memory.geometries}|${info.memory.textures}`
      + `|${labelKey()}`;
    const dofDone = Math.abs(pipeline._dofBlend - wantDof) < 0.004;
    if (key === lastKey && dofDone) stable++; else stable = 0;
    lastKey = key;
    if (n >= SETTLE_MIN && stable >= 5) break;
  }
  // Real render throughput, measured over the convergence loop only — the warmup
  // is all shader compilation and would report a fps nobody would ever see.
  const fps = Math.round(fpsFrames / Math.max(0.001, (performance.now() - fpsT0) / 1000));
  const converged = n;
  // Then pad to the fixed budget so the animated phase of the captured frame is
  // a function of the shot and nothing else. See SETTLE_TOTAL.
  while (n < SETTLE_TOTAL) { await raf(); n++; }
  // ...and say so out loud when that guarantee did NOT hold. The contract is
  // "same shot name => same frame count => same pixels", and it only holds while
  // convergence finishes inside the fixed budget: a shot that takes 130 frames to
  // converge is captured at frame 130 here and at frame 118 on a faster machine,
  // with the animator, the tracers and the LOD all at different phases. That is a
  // silent failure — the harness reports success and writes a subtly different
  // PNG — so it is published as a stat and warned about rather than left to be
  // discovered by a critic wondering why a shot changed with nothing edited.
  const settleOverran = converged > SETTLE_TOTAL;
  if (settleOverran) {
    console.warn('[main] settle overran the fixed budget: converged at frame ' + converged +
      ' of ' + SETTLE_TOTAL + ' — this shot is no longer frame-count deterministic');
  }

  // The scripted VFX frames. A tracer lives for tenths of a second and a muzzle
  // flash for ~0.07 s, so neither can survive the settle loop above; the shot
  // hands us a frame-indexed script instead and we run it last. `n - i` frames
  // of age is exactly what the shot asked for, on every machine.
  const fin = ctx.finale;
  if (fin) {
    for (let i = 0; i < fin.frames; i++) {
      try { fin.fn(i); } catch (e) { console.warn('[main] finale frame', i, e); }
      await raf();
    }
  }

  // One last live frame, so `renderer.info` describes the picture we are about
  // to publish rather than whatever the freeze leaves in the counters.
  await raf();
  publishStats(S, {
    shot, requestedShot: requested, fallback: shot !== requested,
    fps, settleFrames: n, convergedAt: converged, settleOverran,
    finaleFrames: fin ? fin.frames : 0,
  });

  // FREEZE — and freeze the SYSTEMS, not just the clock.
  //
  // tools/shoot.mjs waits another `--wait` milliseconds after __READY__ before it
  // grabs the frame, and rAF is unthrottled under --disable-frame-rate-limit, so
  // between __READY__ and the shutter this loop runs another two to five THOUSAND
  // times. Round 3 that stopped being harmless. Stopping the clock alone leaves
  // every system still running, just with dt = 0 — and a system is only inert at
  // dt = 0 if it is a pure function of dt, which several are not: the foliage LOD
  // re-streams around the camera every call, the shadow rig is deliberately handed
  // dt = 1 in capture mode so it snaps, and the material registry re-arms its own
  // guard once a frame. Measured on `tank`: the PNG at --wait 800 was correct and
  // the PNG at --wait 3500 was a completely different, broken image. That is the
  // determinism contract failing, and it fails silently — the harness reports no
  // error and writes the garbage frame over the good one.
  //
  // `engine.paused` skips the system pass entirely while still re-rendering, so
  // the scene graph is now provably constant: after this line the only thing the
  // loop touches is the framebuffer, and every redraw is the same draw.
  engine.clock.getDelta = () => 0;
  engine.paused = true;
  const freeze = document.createElement('style');
  freeze.textContent =
    '#hud *, #hud *::before, #hud *::after{animation-play-state:paused!important;transition:none!important}';
  document.head.appendChild(freeze);
  await raf();                     // one frozen frame, so the canvas holds it
  const pixelFrames = await settlePixels(renderer);
  window.__STATS__ = Object.assign({}, window.__STATS__, { pixelSettleFrames: pixelFrames });
  window.__READY__ = true;
}

/**
 * Pump render-only frames until the IMAGE stops changing. See PIXEL_PROBE_W.
 * Returns how many frames it took (or -1 if the readback is unavailable, in
 * which case nothing is waited for and the old behaviour stands).
 */
async function settlePixels(renderer) {
  const src = renderer && renderer.domElement;
  if (!src || typeof document === 'undefined') return -1;
  let ctx, w, h;
  try {
    const probe = document.createElement('canvas');
    w = PIXEL_PROBE_W;
    h = Math.max(2, Math.round((PIXEL_PROBE_W * src.height) / Math.max(1, src.width)));
    probe.width = w; probe.height = h;
    ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) return -1;
  } catch { return -1; }

  // The readback has to happen inside a rAF callback, immediately after the
  // engine's own callback has rendered into the drawing buffer: the context is
  // not `preserveDrawingBuffer`, so outside that window there is nothing to
  // copy. `raf()` resolves from within the callback, so awaiting it lands here.
  const grab = () => {
    try {
      ctx.drawImage(src, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    } catch { return null; }
  };

  let prev = null, stable = 0, n = 0;
  while (n < PIXEL_SETTLE_MAX) {
    await raf();
    n++;
    const cur = grab();
    if (!cur) return -1;
    if (prev) {
      let sum = 0;
      for (let i = 0; i < cur.length; i += 4) {
        sum += Math.abs(cur[i] - prev[i]) + Math.abs(cur[i + 1] - prev[i + 1]) +
          Math.abs(cur[i + 2] - prev[i + 2]);
      }
      const mad = sum / ((cur.length / 4) * 3);
      if (mad <= PIXEL_EPS) stable++; else stable = 0;
      if (stable >= PIXEL_STABLE_FRAMES) return n;
    }
    prev = cur;
  }
  console.warn('[main] pixel settle never converged in ' + PIXEL_SETTLE_MAX + ' frames');
  return n;
}

function publishStats(S, extra) {
  const { renderer, battle, world, pipeline, engine, camera } = S;
  const info = renderer.info;
  // The camera pose belongs in the stats blob. A shot whose framing silently
  // came out wrong is otherwise indistinguishable from a shot whose WORLD came
  // out wrong, and the harness has no way to tell the reviewer which it was
  // looking at. Three numbers make it obvious.
  const r3 = (v) => +v.toFixed(2);
  camera.getWorldDirection(_ray);
  window.__STATS__ = Object.assign({}, window.__STATS__, {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    programs: info.programs ? info.programs.length : 0,
    textures: info.memory.textures,
    geometries: info.memory.geometries,
    quality: pipeline.quality,
    seed: CFG.seed,
    frame: engine.frame,
    worldTime: +world.time.toFixed(4),
    units: battle.units.length,
    colliders: world.colliders.length,
    phase: battle.phase,
    camPos: [r3(camera.position.x), r3(camera.position.y), r3(camera.position.z)],
    camDir: [r3(_ray.x), r3(_ray.y), r3(_ray.z)],
    camFov: r3(camera.fov),
    groundUnderCam: r3(world.groundHeightAt(camera.position.x, camera.position.z)),
  }, extra);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // Armed before anything else: a reload that fires while the shot is being set up
  // is just as fatal as one that fires while the shutter is open.
  pinModulesForCapture();
  const S = buildSystems();
  const updateTracers = wireCombatFx(S);
  installSystems(S, updateTracers);

  if (CFG.capture) {
    // One deterministic virtual clock for the whole capture: identical shot
    // name => identical frame count => identical pixels.
    S.engine.clock.getDelta = () => CAPTURE_DT;
  }

  S.engine.onResize();
  S.engine.start();

  if (CFG.debug) Object.assign(window, { VC: Object.assign({ Bus, CFG }, S) });

  if (CFG.capture) {
    const watchdog = setTimeout(() => {
      if (window.__READY__) return;
      console.warn('[main] capture watchdog fired');
      publishStats(S, { shot: CFG.captureShot || 'overview', timedOut: true });
      window.__READY__ = true;
    }, CAPTURE_WATCHDOG_MS);
    try {
      await captureFlow(S);
    } finally {
      clearTimeout(watchdog);
    }
  } else {
    playFlow(S);
  }
}

boot().catch((e) => showFatal(e, CFG.capture ? 'capture' : 'boot'));
