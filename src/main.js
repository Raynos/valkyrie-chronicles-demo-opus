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

import {
  CFG, byQ, calibrateBudget, setResolutionBudget, RESOLUTION_BUDGETS,
} from './core/config.js';
import { Bus } from './core/bus.js';
import { Input } from './core/input.js';
import { makeRng } from './core/rng.js';
import { Engine } from './core/engine.js';

import { CanvasRenderPipeline } from './render/canvasRenderPipeline.js';
import { createLightRig } from './render/lighting.js';
import { FxSystem } from './render/fx.js';
import { MaterialRegistry } from './render/materials.js';
import { warmTextureCacheAsync } from './render/textures.js';

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
const PIXEL_PROBE_W = 128;
const PIXEL_STABLE_FRAMES = 24;
const PIXEL_SETTLE_MAX = 900;
/** Mean absolute LSB difference between two probes that still counts as equal. */
const PIXEL_EPS = 0.25;

const _focus = new THREE.Vector3();

const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
async function frames(n) { for (let i = 0; i < n; i++) await raf(); }

// ---------------------------------------------------------------------------
// The pre-JS boot card (index.html #boot).
//
// It is static markup so it is on screen at FIRST PAINT, before this module has
// been fetched. Everything here only moves its text, or takes it away.
// ---------------------------------------------------------------------------

const qsMain = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

/** rAF *and then a task*, so the frame we just yielded for actually paints.
 *  Awaiting a bare rAF resumes inside the same frame's microtask checkpoint —
 *  i.e. still before the paint — which is no yield at all for this purpose. */
const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const bootEl = () => (typeof document !== 'undefined' ? document.getElementById('boot') : null);

/** Advance the loading card. `frac` is 0..1 and drives the rule under the title. */
function bootStage(text, frac) {
  const s = document.getElementById('boot-stage');
  if (s && text) s.textContent = text;
  const b = document.getElementById('boot-bar');
  if (b && frac != null) b.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
}

function bootDismiss() {
  const el = bootEl();
  if (!el) return;
  el.classList.add('gone');
  setTimeout(() => el.remove(), 360);
}

/**
 * Turn the loading card into a message card. Used for every "you cannot play
 * this here" outcome, so the reason arrives in the same typeface the game is
 * set in rather than as a browser default or a stack trace.
 */
function bootMessage(head, body, extra, foot) {
  const el = bootEl();
  if (!el) return null;
  el.classList.remove('gone');
  el.innerHTML = '';
  el.appendChild(Object.assign(document.createElement('div'), { className: 'bl', textContent: 'Gallian Militia · Squad 7' }));
  el.appendChild(Object.assign(document.createElement('h1'), { textContent: 'Valkyrie Chronicles' }));
  const rule = document.createElement('div');
  rule.className = 'rule';
  rule.appendChild(document.createElement('i')).style.animation = 'none';
  el.appendChild(rule);
  el.appendChild(Object.assign(document.createElement('div'), { className: 'sub', textContent: head }));
  el.appendChild(Object.assign(document.createElement('div'), { className: 'note', textContent: body }));
  if (extra) el.appendChild(extra);
  if (foot) {
    const f = Object.assign(document.createElement('div'), { className: 'note', textContent: foot });
    f.style.marginTop = '2.2em';
    f.style.opacity = '.7';
    el.appendChild(f);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Fatal-error surface.
//
// It has two audiences and they want opposite things. A player wants a sentence;
// the screenshot critic and anyone debugging want the stack. Before round 25 only
// the critic was served, and a browser with no WebGL rendered a minified
// "at new lg (…/index-Cz6FhtD-.js:4108:23888)" full-screen in monospace as its
// public failure page. So: the sentence is the page, and the stack is one click
// away (open by default under ?debug or ?capture, where nobody is a player).
// ---------------------------------------------------------------------------

function showFatal(err, where = 'boot') {
  const message = String((err && err.message) || err);
  const stack = String((err && err.stack) || '');
  console.error(`[main] ${where} failed:`, err);
  try {
    window.__BOOT_ERROR__ = { where, message, stack };
    const details = document.createElement('details');
    details.open = !!(CFG.debug || CFG.capture);
    details.style.cssText = 'margin-top:1.6em;max-width:min(80vw,70em);text-align:left';
    const sum = document.createElement('summary');
    sum.textContent = 'Technical details';
    sum.style.cssText = 'cursor:pointer;letter-spacing:.18em;text-transform:uppercase;font-size:.7rem;color:#8d7c62';
    details.appendChild(sum);
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin-top:.9em;padding:1em;background:rgba(0,0,0,.28);color:#c9b795;'
      + 'overflow:auto;max-height:46vh;white-space:pre-wrap;'
      + 'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
    pre.textContent = `${where} failed\n\n${stack || message}\n\n`
      + `capture=${CFG.capture} shot=${CFG.captureShot || '-'} quality=${CFG.quality} seed=${CFG.seed}`;
    details.appendChild(pre);

    const el = bootMessage(
      'The demo could not start.',
      'Something went wrong while building the field. Reloading the page usually fixes it. '
      + 'If it does not, the demo needs a browser with WebGL2 and hardware acceleration enabled.',
      details,
    );
    if (!el) {                       // #boot already removed: fall back to our own layer
      const pane = document.createElement('div');
      pane.id = 'vc-fatal';
      pane.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;'
        + 'align-items:center;justify-content:center;gap:1em;padding:6vh 8vw;text-align:center;'
        + 'background:#17120e;color:#e8d9be;font:1rem/1.6 inherit';
      pane.appendChild(Object.assign(document.createElement('div'), {
        textContent: 'The demo hit an error and stopped. Reload the page to start again.',
      }));
      pane.appendChild(details);
      document.body.appendChild(pane);
    }
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
// "You cannot play this here" gates. Both run BEFORE anything is constructed:
// a phone that builds the world melts on 986k triangles for a game it then
// cannot accept a single input for, and a machine with no WebGL2 throws inside
// the THREE.WebGLRenderer constructor.
// ---------------------------------------------------------------------------

/** @returns {boolean} true if this browser can create a WebGL2 context at all. */
function hasWebGL2() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl2', { failIfMajorPerformanceCaveat: false }));
  } catch { return false; }
}

/**
 * A touch-only device. `Input.attach` binds keydown/keyup/mousemove/mousedown/
 * mouseup/wheel and nothing else — there is not one touch or pointer handler in
 * the file, and pointer lock does not exist on iOS at all. So a phone renders
 * the title card, offers a real tappable "Open the Book", and then has no way to
 * move, select, aim or fire. Half-built touch controls would be worse than
 * saying so; this says so, before the GPU is asked for anything.
 *
 * `any-pointer`/`any-hover` rather than `pointer`, so a laptop with a
 * touchscreen (coarse primary pointer, fine trackpad) is not turned away.
 */
function needsDesktop() {
  if (CFG.capture || qsMain.has('desktop')) return false;
  if (typeof matchMedia !== 'function') return false;
  return !matchMedia('(any-pointer: fine)').matches && !matchMedia('(any-hover: hover)').matches;
}

// ---------------------------------------------------------------------------
// System construction. Dependency order is load-bearing, see the comments.
//
// ROUND 25 MADE THIS ASYNC, AND THE AWAITS ARE THE POINT.
//
// It used to be one synchronous call, and a CDP CPU profile of the boot found
// only 370 ms of idle in a 4515 ms window: the main thread was blocked solid
// from module eval to the title card, so a page.screenshot() issued at t=500 ms
// could not be serviced until t=3775 ms. The tab was unresponsive, not merely
// blank. Nothing could have painted a loading indicator even if one had existed.
//
// `await paint()` between the stages hands the browser a frame to composite, so
// the boot card's text and rule actually advance. The stage boundaries are the
// four costs the profile named: world/layout + terrain (~420 ms), the procedural
// texture bakes in render/textures.js (~550 ms), the 13 character rigs in
// actors/rig.js (~557 ms) and vegetation (~128 ms). Each yield costs one frame.
//
// Skipped entirely under ?capture: the daemon boots once and the yields would
// just make every cold render slower. They happen before engine.start(), so they
// cannot touch the frame-count determinism contract either way.
// ---------------------------------------------------------------------------

async function buildSystems() {
  const stage = async (text, frac) => {
    bootStage(text, frac);
    if (!CFG.capture) await paint();
  };

  const canvas = document.getElementById('view');
  if (!canvas) throw new Error('#view canvas is missing from index.html');

  const engine = new Engine(canvas);
  const { scene, camera, renderer } = engine;
  // A scripted shot must not be steerable: no stray key from the harness gets in.
  if (CFG.capture) Input.enabled = false;

  await stage('Raising the standard', 0.10);

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

  // --- procedural paper stock --------------------------------------------
  // Baked here, one per frame, purely so they are not baked somewhere worse.
  // Left lazy, `paper` (205 ms) and `ground` (189 ms) were pulled in mid-way
  // through the terrain material build, which is why r25's CPU profile blamed
  // world/terrain.js for time that is actually canvas painting in
  // render/textures.js. Identical output either way — see warmTextureCacheAsync.
  if (!CFG.capture) {
    await warmTextureCacheAsync(paint, (name, i, n) => {
      bootStage('Sizing the paper', 0.10 + (i / n) * 0.08);
    });
  }

  bootStage('Surveying the Vasel valley', 0.18);

  // --- world --------------------------------------------------------------
  // The single most expensive thing in the boot, and until r25 the single
  // longest freeze: one synchronous constructor, ~1.7 s dev / ~2.0 s production,
  // during which nothing painted and the tab did not answer. World.build() runs
  // the identical stages from the identical seed in the identical order and
  // yields a frame between each, so the loading card can advance and the page
  // stays responsive. Capture keeps the plain synchronous constructor: a cold
  // render must stay bit-for-bit the code path the determinism contract was
  // measured on, and the daemon boots the world once anyway.
  const world = CFG.capture
    ? new World(scene, CFG.seed)
    : await World.build(scene, CFG.seed, (name, f) => bootStage(name, 0.18 + f * 0.26));

  await stage('Mixing the pigments', 0.46);

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

  await stage('Wind, water and smoke', 0.58);

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

  await stage('Mustering Squad 7', 0.66);

  const battle = new Battle(world, scene, { camera, mission: MISSION_VASEL, seed: CFG.seed });
  battle.setup();

  await stage('Ruling the field book', 0.90);
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

  await stage('Tuning the band', 0.96);

  // --- audio --------------------------------------------------------------
  // Constructed (and Bus-wired) always; ctx creation waits for a user gesture,
  // and in capture mode it never happens at all.
  const audio = new AudioEngine({ seed: CFG.seed });
  audio.setMusicState('menu');          // S11: the boot state is the menu bed

  bootStage('Opening the book', 0.97);

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

  if (!CFG.capture) engine.add({ update: (dt) => autoScale(S, dt) });
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

// --- boot resolution calibration (never in capture mode) --------------------
//
// WHAT THIS IS NOT: the dynamic-resolution ratchet. That was tried twice — as a
// shader-tier step-down in round 21 and as a resolution step-down in round 22 —
// and both are retired for measured reasons written up in Engine.setDynScale.
// The short version: a ratchet is decided by whichever camera happens to be on
// screen (the pre-battle orbit costs 31 ms against action mode's 14 ms, so it
// tripped inside the title card every session), it never recovered because the
// step-back-up counter was decremented faster than it was incremented on the
// command map, and it silently corrupted every measurement taken afterwards.
//
// WHAT THIS IS: one measurement, one decision, once, and it can only go down.
//
// CFG.render.budgetPx is a pixel count tuned on an Apple M3 Pro, where the frame
// fits T = 3.5 ms + 4.0 ms/Mpx. That fit is a property of THIS GPU. An 8-core M1
// Air or an Intel Iris Xe has two to three times the ms-per-megapixel, so the
// same budget lands at 25-40 fps and the demo's first impression on a general
// player's machine is a slideshow. Shipping a hard-coded quality tier for every
// machine on earth (CFG.quality was flat 2/ultra for everyone) is the same bug
// in the other direction.
//
// So: after the shader precompile has resolved and settled, sample the frame
// time over ~2.5 s, solve the same linear fit for THIS machine's fill rate, and
// pick the budget that hits the target. It runs exactly once, it is clamped so
// it can never raise the budget above what the artist authored, and it is
// clamped below at a third of it — past that the picture is worse than the frame
// rate is good. A player who has chosen a resolution by hand (?rs, ?px, or the
// options menu) is never second-guessed; calibrateBudget() refuses in that case.
//
// It is sampled during the title orbit, which is the most expensive camera in
// the game (23.1 ms vs 20.7 for action mode at the shipped setting, i.e. ~12%
// pessimistic). That is deliberately the safe direction to be wrong in.
const CAL_SETTLE_S = 2.0;      // frames to ignore after arming (LOD, first bloom)
const CAL_SAMPLE_S = 2.5;      // measurement window
const CAL_STALL_MS = 60;       // a GC or a lazy compile is not evidence about fill

let _calArmAt = 8;
let _calT0 = -1;
let _calSum = 0;
let _calN = 0;
let _calDone = false;

function armAutoScale(t) { _calArmAt = Math.max(_calArmAt, t); }

function autoScale(S, dt) {
  if (_calDone) return;
  const { engine, renderer } = S;
  if (engine.time < _calArmAt) return;
  if (_calT0 < 0) { _calT0 = engine.time; return; }
  if (engine.time - _calT0 < CAL_SETTLE_S) return;

  const ms = dt * 1000;
  if (ms < CAL_STALL_MS) { _calSum += ms; _calN++; }
  if (engine.time - _calT0 < CAL_SETTLE_S + CAL_SAMPLE_S) return;

  _calDone = true;
  if (_calN < 30) return;                       // not enough clean frames to judge
  const mean = _calSum / _calN;
  const buf = renderer.domElement.width * renderer.domElement.height;
  const cal = calibrateBudget(mean, buf);
  if (cal < 0.97) {
    engine.onResize();
    console.info('[main] boot calibration:', mean.toFixed(1), 'ms over', _calN,
      'frames at', (buf / 1e6).toFixed(2), 'Mpx -> pixel budget x' + cal.toFixed(2),
      '-> pixel ratio', renderer.getPixelRatio().toFixed(2));
  }
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

  // CREDIT AND DISCLAIMER. This demo reproduces SEGA's characters, units,
  // factions and art style directly, and it is publicly linked, so the one place
  // everybody looks has to say what it is and what it is not. Deliberately small
  // and in the label style so it reads as a colophon rather than as copy.
  //
  // The repo link is `.clickable` (index.html gates pointer-events on that class)
  // and target=_blank, so following it cannot take the page — and because it is
  // an <a> rather than a button it never takes the Enter binding off the ribbon.
  const colophon = h('div', {
    class: 'vc-label',
    style: 'margin-top:1.5em;opacity:.7;font-size:.72em;letter-spacing:.1em;line-height:2.05',
  });
  colophon.appendChild(document.createTextNode(
    'A fan-made technical demo · not affiliated with SEGA',
  ));
  colophon.appendChild(h('br'));
  // Non-breaking so the byline never wraps between the first and last name,
  // which it did at 1366x768 before the line was split in two.
  colophon.appendChild(document.createTextNode('Built in three.js by Jake Verbaten · '));
  const link = h('a', {
    class: 'clickable',
    href: 'https://github.com/Raynos/valkyrie-chronicles-demo-opus',
    target: '_blank',
    rel: 'noopener noreferrer',
    style: 'color:inherit;text-decoration:underline;text-underline-offset:.35em',
    text: 'Source on GitHub',
  });
  colophon.appendChild(link);
  inner.appendChild(colophon);

  p.content.appendChild(inner);
  root.appendChild(p.root);
  hud.screens.appendChild(root);

  // The real card is mounted: the static loading card in index.html has done its
  // job and fades out. Doing it HERE rather than at the end of boot() is what
  // keeps the handover seamless — there is never a frame with neither on screen.
  bootDismiss();

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
    // `auto`: the screen posted the roll itself and the player did not rearrange
    // it, so let the battle keep the placement IT chose at startDeployment()
    // (heavy classes nearest the objective) rather than re-laying the squad out
    // in the screen's left-to-right chip order.
    if (p && p.auto) {
      if (!battle.deployment.size) battle.autoDeploy();
      battle.confirmDeployment();
      return;
    }
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

  // OPTIONS THAT ACTUALLY DO SOMETHING.
  //
  // The pause menu emits `ui:option` and the HUD applies the cosmetic half of it
  // (grain, motion, volumes). The two rows that cost frames have to be applied
  // out here, because main.js is the only module that holds both the pipeline and
  // the engine:
  //
  //  * Render Quality wrote `CFG.quality = n` and stopped. Nothing read it after
  //    boot except the fx particle counts — every expensive define (pipeline
  //    composite/grade, material tiers, shadow map size, terrain LOD, vegetation
  //    density) was baked before the menu existed, so choosing Low changed
  //    nothing a frame-time meter could see. setQuality() is the function that
  //    was written to do it properly and had exactly one call site: its own
  //    constructor. It recompiles the defines and re-tiers the materials. It
  //    still cannot re-generate the terrain, the vegetation or the shadow map —
  //    those are boot-time decisions — so this row is honest about being a
  //    SHADER quality row and Resolution below is the one that moves the frame.
  //  * Resolution is new, and it is the only knob that matters: every post pass
  //    except the contour prepass totals 5.0 ms of a 22.4 ms frame. Setting the
  //    budget and calling onResize() re-allocates every render target and changes
  //    the backing store immediately, with no reload and no artefacts.
  Bus.on('ui:option', (p) => {
    if (!p || !p.key) return;
    if (p.key === 'quality') {
      const q = ['Low', 'High', 'Ultra'].indexOf(p.value);
      if (q >= 0) { CFG.quality = q; S.pipeline?.setQuality?.(q); }
    } else if (p.key === 'resolution') {
      if (setResolutionBudget(p.value)) {
        engine.onResize();
        console.info('[main] resolution ->', p.value, 'budget',
          (RESOLUTION_BUDGETS[p.value] / 1e6).toFixed(2), 'Mpx, pixel ratio',
          S.renderer.getPixelRatio().toFixed(2));
      }
    }
  });

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

  // ENTER SORTIES — FROM THE STATE THE MAP OPENS IN.
  //
  // The HUD legend has advertised "Enter — Sortie" for twenty rounds and
  // CommandMode has always implemented it, but only for a soldier who was ALREADY
  // selected, and nothing ever selected one: the map opened with no selection, so
  // a keyboard player who reached the command phase pressed Enter forever and
  // never took control of anybody. (Tab cycles the selection. Nothing says so.)
  //
  // This handler only ever SELECTS. It must not call battle.selectUnit() itself:
  // this runs on the keydown, so the sortie would land BEFORE the frame in which
  // ActionMode polls, and ActionMode reads the very same Enter as "end action" —
  // measured, that produced six clean command -> action -> command round trips in
  // five seconds, one per press. Handing CommandMode a selection instead lets it
  // confirm inside its own update, where the phase has already switched by the
  // time anything else could read the key.
  const cmd = battle.commandMode;
  // Who "go" means when the player has not picked anybody: the first soldier on
  // the roll who can still act, and only the Edelweiss if there is nobody else.
  // The tank is the commander — lose it and the mission is over — so it is the
  // wrong thing to hand a stranger on their first press of a key.
  const firstReady = () => battle.units.find((u) => !u.isVehicle && battle.canSelect(u, 0))
    || battle.units.find((u) => battle.canSelect(u, 0));
  addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || battle.phase !== 'command' || !cmd || !cmd.active) return;
    if (hud.pause.visible || hud.dialogue.visible) return;         // those own Enter
    if (hud.briefing.visible || hud.deployment.visible) return;
    if (cmd.selected && battle.canSelect(cmd.selected, 0)) return;  // CommandMode has it
    const u = firstReady();
    if (u) { cmd.select(u); cmd.focusOn(u.pos); }
  });

  // A turn opens ON YOUR SQUAD. The command camera used to resume wherever the
  // last Imperial actor left it — one playtest handed the player a close-up of two
  // village roofs with the whole roster off screen — and the roster opened with
  // nobody highlighted, so there was nothing to press Enter on either.
  Bus.on('turn:changed', (p) => {
    if (!p || p.team !== 0 || !cmd) return;
    const u = firstReady();
    if (!u) return;
    cmd.select(u);
    cmd.focusOn(u.pos);
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
  // The loading card is DOM, and page.screenshot() captures DOM: leaving it up
  // would put a title card over every plate the critic ever looks at.
  bootEl()?.remove();
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
  // (the pipeline's temporal depth-of-field used to be in this key too; round 21
  //  cut the pass, so there is nothing temporal left in the post stack)
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
  while (n < SETTLE_MAX) {
    await raf();
    n++;
    if (n === 4) { fpsT0 = performance.now(); fpsFrames = 0; } else if (n > 4) fpsFrames++;
    const info = renderer.info;
    const key = `${info.programs ? info.programs.length : 0}|${info.render.calls}|`
      + `${info.render.triangles}|${info.memory.geometries}|${info.memory.textures}`
      + `|${labelKey()}`;
    if (key === lastKey) stable++; else stable = 0;
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

  // --- gates, before a single system is constructed -------------------------
  if (needsDesktop()) {
    bootMessage(
      'This demo needs a keyboard and a mouse.',
      'Valkyrie Chronicles is played with WASD, the mouse and a handful of keys, and there '
      + 'are no touch controls. Open it on a desktop or laptop and it will run.',
      null,
      'A fan-made technical demo built in three.js · not affiliated with SEGA',
    );
    console.info('[main] touch-only device: the battle was not built');
    return;
  }
  if (!hasWebGL2()) {
    bootMessage(
      'This demo needs WebGL2.',
      'Try a recent version of Chrome, Edge, Firefox or Safari on a desktop or laptop, and '
      + 'check that hardware acceleration is switched on in your browser settings.',
      null,
      'A fan-made technical demo built in three.js · not affiliated with SEGA',
    );
    console.warn('[main] no WebGL2 context available: the battle was not built');
    return;
  }

  const S = await buildSystems();
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
    precompilePlay(S);
  }
}

/**
 * Compile the shaders behind the title card.
 *
 * ROUND 21. `renderer.compile()` was called in captureFlow and NOWHERE ELSE, so
 * a played session compiled ~50 programs lazily, one per first frame that needed
 * one: measured p95 frame time of 115 ms and a 4.1 s worst frame over the first
 * four seconds of play, all of it shader compilation. Those stalls were also what
 * armed the auto step-down — the game was turning its own quality down in
 * response to a cost that was one-off and had nothing to do with the frame.
 *
 * It runs after playFlow so the title card is already up: the orbit behind it is
 * the one moment in the session where a stall is nobody's business. compileAsync
 * uses KHR_parallel_shader_compile where the driver has it and yields between
 * materials, so the orbit keeps moving.
 *
 * Honest limitation: three's compile() walks traverseVisible, so a material on
 * an object that is hidden at title time — anything the deploy screen or a
 * mid-battle spawn brings in — still compiles on the frame it first appears.
 * Measured, that is 5 more programs at battle start, not 50.
 */
function precompilePlay(S) {
  const { renderer, scene, camera } = S;
  const t0 = performance.now();
  const before = renderer.info.programs?.length || 0;
  const done = () => {
    console.info('[main] precompile:', (renderer.info.programs?.length || 0) - before,
      'programs in', Math.round(performance.now() - t0), 'ms');
    // Only now does a missed frame say anything about the machine.
    armAutoScale(S.engine.time + 3);
  };
  try {
    const p = renderer.compileAsync?.(scene, camera);
    if (p && p.then) p.then(done, (e) => console.warn('[main] precompile', e));
    else { renderer.compile(scene, camera); done(); }
  } catch (e) { console.warn('[main] precompile', e); }
}

boot().catch((e) => showFatal(e, CFG.capture ? 'capture' : 'boot'));
