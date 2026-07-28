// src/game/captureShots.js — deterministic scripted setups for the screenshot critic harness.
//
// `node tools/shoot.mjs <name>` loads the game with ?capture&shot=<name>; main.js looks the name
// up in SHOTS, awaits the setup function, and then sets window.__READY__ = true.
//
// Every setup is a pure function of (ctx, seeded rng): it positions the camera, poses units,
// forces a phase and a time of day, and resolves only once the frame is stable. No shot may
// read the clock, Math.random, or user input.
//
// ctx = { engine, scene, camera, renderer, battle, world, ui, pipeline, audio }

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { CFG } from '../core/config.js';
import { makeRng } from '../core/rng.js';
import { fireRound, jitterDirection } from './combat.js';
import { STANCE } from './units.js';

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const raf = () => new Promise((r) => (typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame(() => r())
  : setTimeout(r, 16)));

/** Let the renderer run `n` frames so animation, LOD and post-FX history settle. */
export async function frames(n = 8) { for (let i = 0; i < n; i++) await raf(); }

/** Adapter: whatever the world exposes for time of day. 0 dawn, 0.5 noon, 1 night. */
export function setTimeOfDay(ctx, t) {
  const w = ctx.world;
  if (w?.setTimeOfDay) w.setTimeOfDay(t);
  else if (w?.sky?.setTime) w.sky.setTime(t);
  else if (w?.sun?.setTime) w.sun.setTime(t);
  if (w) w.sunT = t;
  Bus.emit('world:timeOfDay', { t });
}

export function groundAt(ctx, x, z) {
  const t = ctx.world?.terrain;
  if (t?.heightAt) return t.heightAt(x, z);
  return 0;
}

/** Place a unit on the ground, facing `yaw`, and force an animation clip. */
export function pose(ctx, unit, x, z, yaw = 0, clip = 'idle', stance = STANCE.STAND) {
  if (!unit) return null;
  unit.pos.set(x, groundAt(ctx, x, z), z);
  unit.yaw = yaw;
  unit.aimYaw = yaw;
  unit.aimPitch = 0;
  unit.stance = stance;
  unit.deployed = true;
  unit.spotted = true;
  unit.actor?.play?.(clip);
  unit.syncActor?.();
  if (unit.root) unit.root.visible = true;
  return unit;
}

export function aimCamera(camera, px, py, pz, tx, ty, tz, fov) {
  camera.position.set(px, py, pz);
  camera.lookAt(tx, ty, tz);
  if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
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
 * Register a per-frame driver for shots that need living VFX (tracers, muzzle flash).
 * Returns a disposer.
 */
export function driver(ctx, fn) {
  const sys = { update: fn };
  ctx.engine?.add(sys);
  return () => ctx.engine?.remove(sys);
}

/** Hide every unit; shots opt models back in explicitly so framing is repeatable. */
export function hideAll(ctx) {
  for (const u of ctx.battle.units) { if (u.root) u.root.visible = false; u.deployed = false; }
}

function show(ctx, units) {
  for (const u of units) if (u) { u.deployed = true; if (u.root) u.root.visible = true; }
}

function uiMode(mode) { Bus.emit('ui:captureMode', { mode }); }

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export const SHOTS = {
  /** Wide hero shot: the whole valley, the bridge, the mill town beyond. */
  async overview(ctx) {
    const b = ensureBattle(ctx);
    setTimeOfDay(ctx, 0.30);
    uiMode('none');
    b.setPhase('command');
    b.commandMode?.exit();

    const rng = makeRng(0xA11CE);
    // Squad spread out on the south approach, Imperials holding the far bank.
    const squad = b.units.filter((u) => u.team === 0);
    squad.forEach((u, i) => {
      const x = -18 + i * 6.5 + (rng() - 0.5) * 2.4;
      const z = -34 + (rng() - 0.5) * 6;
      pose(ctx, u, x, z, 0.05, u.isVehicle ? 'idle' : (i % 3 === 0 ? 'crouchIdle' : 'idle'),
        i % 3 === 0 ? STANCE.CROUCH : STANCE.STAND);
    });
    const foe = b.units.filter((u) => u.team === 1);
    foe.forEach((u, i) => {
      const x = -14 + i * 5.2 + (rng() - 0.5) * 3;
      const z = 16 + (i % 3) * 9 + (rng() - 0.5) * 4;
      pose(ctx, u, x, z, Math.PI, 'idle');
      u.spotted = true;
    });

    const y = groundAt(ctx, -6, -96) + 34;
    aimCamera(ctx.camera, -6, y, -96, 4, 4, 18, 29);
    await frames(14);
  },

  /** Command Mode: tactical camera, movement range, threat overlay, HUD up. */
  async command(ctx) {
    const b = ensureBattle(ctx);
    setTimeOfDay(ctx, 0.33);
    uiMode('command');
    b.setPhase('command');
    const cm = b.commandMode;
    cm.enter();

    const rng = makeRng(0xC0FFEE);
    const squad = b.units.filter((u) => u.team === 0);
    squad.forEach((u, i) => {
      pose(ctx, u, -16 + i * 6 + (rng() - 0.5) * 2, -26 + (rng() - 0.5) * 8, 0.1);
    });
    const foe = b.units.filter((u) => u.team === 1);
    foe.forEach((u, i) => {
      pose(ctx, u, -12 + i * 5.4, 10 + (i % 4) * 8, Math.PI);
      u.spotted = true;
      u.lastKnown.copy(u.pos);
      u.lastKnownTurn = b.turn;
    });

    const alicia = unitNamed(ctx, 'Alicia Melchiott') || squad[1];
    cm.select(alicia);
    cm.showThreat = true;
    cm.focusOn(_v.set(alicia.pos.x + 4, 0, alicia.pos.z + 16), true);
    cm.distWant = cm.dist = 52;
    cm.pitchWant = cm.pitch = -0.95;
    cm.yawWant = cm.yaw = 0.22;
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

  /** Over-the-shoulder: a scout at a dead run across the open bank. */
  async action(ctx) {
    const b = ensureBattle(ctx);
    setTimeOfDay(ctx, 0.36);
    uiMode('action');
    const alicia = unitNamed(ctx, 'Alicia Melchiott') || firstOfClass(ctx, 'scout', 0);
    pose(ctx, alicia, -6, -24, 0.08, 'run');
    // A couple of Imperials in the middle distance to give the frame stakes.
    const foe = b.units.filter((u) => u.team === 1).slice(0, 4);
    foe.forEach((u, i) => pose(ctx, u, -10 + i * 7, 14 + (i % 2) * 5, Math.PI, 'idle'));

    b.setPhase('action');
    b.activeUnit = alicia;
    alicia.beginAction();
    const am = b.actionMode;
    am.enter(alicia);
    am.camYaw = 0.08;
    am.camPitch = -0.10;
    am.sprinting = true;
    am.speedSmoothed = alicia.classDef.speed.run;
    am.scriptedMove = { x: 0, y: 1 };
    alicia.speed = alicia.classDef.speed.run;
    // Let the spring arm converge on the shoulder.
    for (let i = 0; i < 24; i++) { am.updateCamera(1 / 60); await raf(); }
    b.interception.enabled = false;
    await frames(8);
  },

  /** Targeting mode: reticle, accuracy circle, hit-% on an Imperial in the square. */
  async aim(ctx) {
    const b = ensureBattle(ctx);
    setTimeOfDay(ctx, 0.35);
    uiMode('aim');
    const shooter = unitNamed(ctx, 'Alicia Melchiott') || firstOfClass(ctx, 'scout', 0);
    const target = b.units.find((u) => u.team === 1 && !u.isVehicle);
    pose(ctx, shooter, 2, -6, 0.0, 'aim', STANCE.CROUCH);
    pose(ctx, target, 3.4, 20.5, Math.PI, 'idle');
    const others = b.units.filter((u) => u.team === 1 && u !== target).slice(0, 3);
    others.forEach((u, i) => pose(ctx, u, -8 + i * 9, 26 + i * 3, Math.PI, 'crouchIdle', STANCE.CROUCH));

    b.setPhase('action');
    b.activeUnit = shooter;
    shooter.beginAction();
    const am = b.actionMode;
    am.enter(shooter);
    am.camYaw = Math.atan2(target.pos.x - shooter.pos.x, target.pos.z - shooter.pos.z);
    am.camPitch = -0.035;
    am.enterAim();
    am.aimHold = shooter.weapon.settle * 0.72;   // partly converged — the circle is visible
    am.timeScale = am.timeScaleTarget = CFG.gameplay.aimSlowFactor;
    for (let i = 0; i < 30; i++) {
      am.fov = am.fovTarget; am.armLength = am.armTarget; am.shoulder = am.shoulderTarget;
      am.updateCamera(1 / 60);
      am.updateAimSolve(1 / 60);
      await raf();
    }
    await frames(6);
  },

  /** Mid-firefight: tracers in the air, impacts on the bridge parapet, smoke. */
  async firefight(ctx) {
    const b = ensureBattle(ctx);
    setTimeOfDay(ctx, 0.32);
    uiMode('action');
    const rng = makeRng(0xF13E);

    const squad = b.units.filter((u) => u.team === 0 && !u.isVehicle);
    squad.forEach((u, i) => pose(ctx, u, -9 + i * 4.2, -9 - (i % 2) * 2.5,
      0.06, i % 2 ? 'crouchIdle' : 'aim', i % 2 ? STANCE.CROUCH : STANCE.STAND));
    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 6);
    foe.forEach((u, i) => pose(ctx, u, -8 + i * 4.6, 13 + (i % 3) * 3.5, Math.PI, 'aim'));
    foe.forEach((u) => { u.spotted = true; });

    b.setPhase('action');
    b.activeUnit = squad[0];

    aimCamera(ctx.camera,
      -22, groundAt(ctx, -22, -2) + 5.4, -2,
      2, 1.6, 12, 33);

    // Continuous, seeded exchange of fire so the screenshot always catches live tracers.
    let acc = 0, tick = 0;
    driver(ctx, (dt) => {
      acc += dt;
      while (acc > 0.075) {
        acc -= 0.075;
        const fromFoe = (tick++ & 1) === 0;
        const shooters = fromFoe ? foe : squad;
        const targets = fromFoe ? squad : foe;
        const s = shooters[Math.floor(rng() * shooters.length) % shooters.length];
        const t = targets[Math.floor(rng() * targets.length) % targets.length];
        if (!s || !t) continue;
        s.muzzlePoint(_m);
        t.centerPoint(_v);
        _d.subVectors(_v, _m).normalize();
        jitterDirection(_d, 0.035, rng, _d);
        // Emit the shot events without letting anyone actually die during a screenshot.
        const hpBefore = t.hp;
        fireRound(s, _m, _d, {
          weapon: s.weapon, rng, units: b.units, world: b.world, battle: b, tracerForce: true,
        });
        t.hp = hpBefore;
        t.downed = false;
        t.alive = true;
      }
    });
    await frames(26);
  },

  /** The Edelweiss, three-quarter low angle. */
  async tank(ctx) {
    const b = ensureBattle(ctx);
    setTimeOfDay(ctx, 0.28);
    uiMode('none');
    hideAll(ctx);
    const tank = b.units.find((u) => u.isVehicle && u.team === 0);
    const isara = unitNamed(ctx, 'Isara Gunther');
    const largo = unitNamed(ctx, 'Largo Potter');
    show(ctx, [tank, isara, largo]);
    pose(ctx, tank, 0, -14, 0.42, 'idle');
    tank.aimYaw = 0.9;
    tank.syncActor?.();
    pose(ctx, isara, 4.6, -17.4, 2.1, 'idle');
    pose(ctx, largo, -4.2, -17.8, 0.9, 'crouchIdle', STANCE.CROUCH);

    const gy = groundAt(ctx, 9.5, -22);
    aimCamera(ctx.camera, 9.5, gy + 1.85, -22.5, 0.2, 1.7, -14, 31);
    await frames(12);
  },

  /** Ruined mill-town buildings, close enough to read the brickwork and the pencil linework. */
  async village(ctx) {
    const b = ensureBattle(ctx);
    setTimeOfDay(ctx, 0.38);
    uiMode('none');
    hideAll(ctx);
    const foe = b.units.filter((u) => u.team === 1 && !u.isVehicle).slice(0, 3);
    show(ctx, foe);
    foe.forEach((u, i) => pose(ctx, u, 10 + i * 3.5, 30 + (i % 2) * 4, Math.PI * 0.8, 'crouchIdle', STANCE.CROUCH));

    const gy = groundAt(ctx, 4, 18);
    aimCamera(ctx.camera, 4, gy + 3.2, 18, 16, 4.5, 38, 36);
    await frames(12);
  },

  /** Portrait distance — this is the shot that judges the character model and the shading. */
  async closeup(ctx) {
    ensureBattle(ctx);
    setTimeOfDay(ctx, 0.31);
    uiMode('none');
    hideAll(ctx);
    const alicia = unitNamed(ctx, 'Alicia Melchiott') || firstOfClass(ctx, 'scout', 0);
    show(ctx, [alicia]);
    pose(ctx, alicia, 0, -20, 0.55, 'idle');
    alicia.aimYaw = 0.55;
    alicia.aimPitch = 0.03;
    alicia.syncActor?.();

    const head = alicia.headPoint(_v.clone());
    // Three-quarter, slightly below eyeline, 1.55 m out — the classic VC portrait framing.
    const a = 0.55 - 1.05;
    aimCamera(ctx.camera,
      alicia.pos.x + Math.sin(a) * 1.55, head.y - 0.06, alicia.pos.z + Math.cos(a) * 1.55,
      head.x, head.y - 0.10, head.z, 38);
    await frames(14);
  },

  /** Low camera looking through the riverbank scrub at a crouching scout. */
  async grass(ctx) {
    ensureBattle(ctx);
    setTimeOfDay(ctx, 0.30);
    uiMode('none');
    hideAll(ctx);
    const edy = unitNamed(ctx, 'Edy Nelson') || firstOfClass(ctx, 'scout', 0);
    const rosie = unitNamed(ctx, 'Rosie Stark');
    show(ctx, [edy, rosie]);
    pose(ctx, edy, -3.0, -30.0, 0.15, 'crouchWalk', STANCE.CROUCH);
    pose(ctx, rosie, 2.6, -33.5, 0.25, 'crouchIdle', STANCE.CROUCH);

    const cx = -3.4, cz = -36.5;
    const gy = groundAt(ctx, cx, cz);
    aimCamera(ctx.camera, cx, gy + 0.26, cz, edy.pos.x, edy.pos.y + 0.95, edy.pos.z, 40);
    await frames(12);
  },

  /** Low sun, very long shadows, the whole valley in raking light. */
  async dusk(ctx) {
    const b = ensureBattle(ctx);
    setTimeOfDay(ctx, 0.86);
    uiMode('none');
    const rng = makeRng(0xD05C);
    const squad = b.units.filter((u) => u.team === 0);
    squad.forEach((u, i) => pose(ctx, u, -14 + i * 5.5 + (rng() - 0.5) * 2, -20 + (rng() - 0.5) * 5,
      0.1, u.isVehicle ? 'idle' : 'idle'));
    const foe = b.units.filter((u) => u.team === 1).slice(0, 5);
    foe.forEach((u, i) => pose(ctx, u, -6 + i * 6, 18 + (i % 2) * 6, Math.PI, 'idle'));

    const gy = groundAt(ctx, -40, -30);
    aimCamera(ctx.camera, -40, gy + 11.5, -30, 6, 3, 16, 30);
    await frames(14);
  },
};

export const SHOT_NAMES = Object.keys(SHOTS);

/**
 * Run a named shot. Unknown names fall back to `overview` so the harness never hangs.
 * Resolves when the scene is stable and it is safe to grab the frame.
 */
export async function runShot(name, ctx) {
  const fn = SHOTS[name] || SHOTS.overview;
  await fn(ctx);
  // One last pair of frames after any driver has been installed.
  await frames(3);
  if (typeof window !== 'undefined') {
    window.__STATS__ = {
      shot: name,
      units: ctx.battle?.units.length ?? 0,
      phase: ctx.battle?.phase ?? null,
      turn: ctx.battle?.turn ?? 0,
      drawCalls: ctx.renderer?.info?.render?.calls ?? null,
      triangles: ctx.renderer?.info?.render?.triangles ?? null,
    };
  }
  return true;
}

export default SHOTS;
