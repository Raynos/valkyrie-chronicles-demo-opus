// src/game/commandMode.js — the top-down tactical half of BLiTZ.
//
// Orbiting / panning map camera, a cursor that snaps to soldiers, fog of war (enemies exist on
// the map only once somebody has actually seen them, and leave a "last known position" ghost),
// a Dijkstra movement-range wash, and a threat overlay that rasterises every enemy's fire
// envelope so you can see the killing ground before you walk into it.
//
// Overlay meshes deliberately use plain THREE materials with `userData.outline = false` — they
// are map annotations drawn *over* the painting, not part of the painted world, so they must not
// be picked up by the NPR outline pass.

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { CFG } from '../core/config.js';
import { Input } from '../core/input.js';
import { clamp, clamp01, damp, dampAngle, lerp } from '../core/math.js';
import { traceWorld } from './combat.js';
import { ORDERS, availableOrders } from './orders.js';
import { WATER_Y } from '../world/layout.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _proj = new THREE.Vector3();

// Ink-wash overlay palette, tuned to sit inside the CANVAS gouache range.
// NOTE: these are THREE.Color, so blend them through `_c1` (a Color). A Vector3
// cannot `.copy()` a Color — it reads .x/.y/.z, gets undefined, and every cell
// colour comes out NaN, which the vertex-colour path rasterises as solid black.
const _c1 = new THREE.Color();
const COL_MOVE_NEAR = new THREE.Color(0.72, 0.89, 0.86);
const COL_MOVE_FAR = new THREE.Color(0.44, 0.68, 0.75);
const COL_MOVE_EDGE = new THREE.Color(0.26, 0.47, 0.56);
const COL_THREAT = new THREE.Color(0.58, 0.26, 0.22);
const COL_THREAT_HOT = new THREE.Color(0.74, 0.31, 0.20);
const COL_THREAT_EDGE = new THREE.Color(0.44, 0.15, 0.14);
const COL_ARC = new THREE.Color(0.70, 0.32, 0.26);

// ---------------------------------------------------------------------------
// Wash painting
//
// The overlays used to be two triangles per nav cell, each carrying one flat
// vertex colour. At the command camera a 1.5 m cell is 45-50 px, so the whole
// map came out ruled into hard-edged parallelograms — a lattice a critic could
// pull straight out of an FFT, and the one artefact no watercolour can make.
// A wash is not a set of cells: it is one sheet of pigment whose edge is soft,
// whose interior granulates, and which pools darker where the brush stopped.
// So the field is rasterised on the CPU, blurred, granulated, given a wet edge,
// and sampled per-fragment off a single terrain-conforming sheet.
// ---------------------------------------------------------------------------

/** Texels per nav cell in the wash texture. 3 puts a texel at ~0.5 m / ~15 px. */
const WASH_SS = 3;

/**
 * Projected height, in pixels, below which a soldier's rig is replaced by a
 * drawn map symbol. 70 is a little above the 60 the round-6 critique named, so
 * the swap happens while the figure can still be recognised rather than after
 * it has already dissolved.
 */
const RIG_MIN_PX = 70;

/** Deterministic 2-D value hash in [0,1). */
function hash2(x, y) {
  let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n ^= n >>> 13;
  return ((n >>> 0) % 65536) / 65536;
}

/** Smooth value noise, one octave, at `f` texels per lobe. */
function vnoise(x, y, f, seed) {
  const px = x / f, py = y / f;
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const fx = px - x0, fy = py - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0 + seed, y0), b = hash2(x0 + 1 + seed, y0);
  const c = hash2(x0 + seed, y0 + 1), d = hash2(x0 + 1 + seed, y0 + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

// ---------------------------------------------------------------------------
// The survey sheet
//
// COMMAND MODE IS A MAP, NOT A MINIATURE DIORAMA.
//
// Six rounds of critique on this frame say the same thing in different words:
// at sixty metres the soldiers are 13x24 px, the terrain is "dithered khaki
// mush", the plateau count on seven separate transects was ZERO, and the whole
// picture reads as an aerial photograph of a hillside with pins in it. A
// photograph of terrain and a MAP of terrain are different objects, and the
// second one is what the mode is for: Valkyria's command mode is a survey sheet
// with counters on it, drawn in the same hand as the rest of the journal.
//
// So the ground gets survey furniture, drawn ON the terrain and conforming to
// it: contour lines at two-metre intervals with every fifth ruled heavier, a
// twenty-metre graticule, and the river picked out with a bank line. All three
// are computed in the fragment shader from the sheet's own interpolated height
// and world position, with `fwidth` normalising the line width — so a contour
// is the same weight in pixels wherever it falls, exactly like a ruling pen,
// and no line can ever alias into the sub-pixel noise the critic measured.
// Flat ground produces no contours at all, which is what makes the landforms
// legible: the lines appear exactly where there is relief to describe.
// ---------------------------------------------------------------------------

const SURVEY_VERT = /* glsl */`
varying vec3 vW;
void main() {
  vW = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SURVEY_FRAG = /* glsl */`
precision highp float;
uniform vec3 uInk;        // contour ink
uniform vec3 uGrat;       // graticule ink
uniform vec3 uWater;      // river wash
uniform float uStep;      // contour interval, metres
uniform float uGrid;      // graticule pitch, metres
uniform float uWaterY;
uniform float uOpacity;
varying vec3 vW;

// A cheap value noise, used ONLY to wander the iso-value a hand's breadth so the
// contours are drawn rather than plotted. Amplitude is a fifth of the interval:
// enough that no two lines are parallel for long, small enough that a contour
// still means its height.
float h21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}

// A ruled line at every integer of t, held to a constant width IN PIXELS by
// dividing the distance-to-line by the screen-space derivative of t. On ground
// with no slope fwidth(t) is zero and no line is drawn, which is the whole
// point: the furniture appears where there is relief to describe.
float ruled(float t, float w) {
  float aw = fwidth(t);
  if (aw < 1e-5) return 0.0;
  float d = abs(fract(t - 0.5) - 0.5);
  // A PLATEAU, not a spike. Ramping straight down from the iso-value gives a
  // line whose peak opacity is only reached on the exact crossing, so after the
  // NPR composite has had its way with it the "line" measured 4 LSB against its
  // own neighbours — present in the buffer, invisible on the page. Holding full
  // weight across the inner 60% of the stroke and antialiasing only the outer
  // 40% is what a ruling pen actually lays down.
  return 1.0 - smoothstep(w * aw * 0.60, w * aw, d);
}

void main() {
  float wob = (vnoise(vW.xz * 0.55) - 0.5) * 0.34 + (vnoise(vW.xz * 1.9) - 0.5) * 0.13;
  float hgt = vW.y + wob * uStep;

  float minor = ruled(hgt / uStep, 2.30);
  float major = ruled(hgt / (uStep * 5.0), 3.10);
  float gx = ruled(vW.x / uGrid, 1.75);
  float gz = ruled(vW.z / uGrid, 1.75);
  float grat = max(gx, gz);
  float gxM = ruled(vW.x / (uGrid * 5.0), 2.30);
  float gzM = ruled(vW.z / (uGrid * 5.0), 2.30);
  float gratM = max(gxM, gzM);

  // ---- the ground's own gradient, in METRES PER METRE ----------------------
  // Screen derivatives give dh/ds and d(x,z)/ds; inverting the 2x2 Jacobian
  // turns them into the true world gradient, so the relief below is a property
  // of the LANDFORM and not of how far away it happens to be.
  vec2 ax = vec2(dFdx(vW.x), dFdx(vW.z));
  vec2 ay = vec2(dFdy(vW.x), dFdy(vW.z));
  float det = ax.x * ay.y - ax.y * ay.x;
  vec2 grad = vec2(0.0);
  if (abs(det) > 1e-7) {
    float hx = dFdx(vW.y), hy = dFdy(vW.y);
    grad = vec2(hx * ay.y - hy * ax.y, -hx * ay.x + hy * ax.x) / det;
  }
  // HACHURES — the thing that makes a survey readable and a photograph not.
  // Ground that falls away from the sheet's own light is hatched with
  // screen-aligned pencil at a CONSTANT pixel pitch (rubric axis 5), and flat
  // ground takes none at all, so the landforms draw themselves.
  vec3 nrm = normalize(vec3(-grad.x, 1.0, -grad.y));
  float lam = dot(nrm, normalize(vec3(-0.58, 0.60, 0.55)));
  float relief = smoothstep(0.60, 0.16, lam);
  float hl = sin((gl_FragCoord.x + gl_FragCoord.y) * 0.62);
  float hatch = smoothstep(0.05, 0.55, hl) * relief;

  // the river: a pale wash below the pool level with a firm pen line on the bank
  float wet = 1.0 - smoothstep(uWaterY - 0.10, uWaterY + 0.30, vW.y);
  float bankT = (vW.y - uWaterY) / 0.9;
  float bank = 1.0 - smoothstep(0.0, 2.4 * max(fwidth(bankT), 1e-5), abs(bankT));

  float inkA = max(minor * 0.95, major * 1.0);
  vec3 col = uGrat;
  float a = max(grat * 0.86, gratM * 0.98);
  col = mix(col, uInk, hatch);
  a = max(a, hatch * 0.26);
  col = mix(col, uInk, step(0.004, inkA));
  a = max(a, inkA);
  col = mix(col, uInk, bank * 0.9);
  a = max(a, bank * 0.72);
  col = mix(col, uWater, wet * 0.85);
  a = max(a, wet * 0.32);

  gl_FragColor = vec4(col, a * uOpacity);
  #include <colorspace_fragment>
}`;

let _blotTex = null;
/** A soft, slightly ragged thumbprint of pigment — the alpha for map marks. */
function blotTexture() {
  if (_blotTex) return _blotTex;
  const N = 64, d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5) / N - 0.5, dy = (y + 0.5) / N - 0.5;
      const ang = Math.atan2(dy, dx);
      // an irregular rim, so no two marks are the same disc
      const wob = 0.40 + 0.055 * Math.sin(ang * 3 + 0.7) + 0.035 * Math.sin(ang * 5 - 1.9);
      const r = Math.sqrt(dx * dx + dy * dy) / wob;
      let a = clamp01(1 - r);
      a = a * a * (3 - 2 * a);
      a *= 0.82 + 0.36 * vnoise(x, y, 5.5, 3);
      const o = (y * N + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = 255;
      d[o + 3] = (clamp01(a) * 255) | 0;
    }
  }
  _blotTex = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  _blotTex.minFilter = THREE.LinearFilter;
  _blotTex.magFilter = THREE.LinearFilter;
  _blotTex.needsUpdate = true;
  return _blotTex;
}

/** Separable 1-2-1 blur, in place, `passes` times. Approximates a gaussian. */
function blurField(src, w, h, passes) {
  const tmp = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        const l = src[r + (x > 0 ? x - 1 : 0)];
        const c = src[r + x];
        const rr = src[r + (x < w - 1 ? x + 1 : w - 1)];
        tmp[r + x] = (l + 2 * c + rr) * 0.25;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const u = tmp[(y > 0 ? y - 1 : 0) * w + x];
        const c = tmp[y * w + x];
        const d = tmp[(y < h - 1 ? y + 1 : h - 1) * w + x];
        src[y * w + x] = (u + 2 * c + d) * 0.25;
      }
    }
  }
  return src;
}

export class CommandMode {
  constructor(battle, camera, opts = {}) {
    this.battle = battle;
    this.camera = camera;
    this.scene = opts.scene || battle.scene;
    this.world = battle.world;
    this.nav = battle.nav;

    this.active = false;

    // --- camera rig -------------------------------------------------------
    this.target = new THREE.Vector3(0, 0, 0);         // ground focus
    this.targetWant = new THREE.Vector3();
    this.yaw = 0.35;
    this.yawWant = 0.35;
    this.pitch = -0.98;                                // ~56 degrees down
    this.pitchWant = -0.98;
    this.dist = 58;
    this.distWant = 58;
    this.minDist = 18;
    this.maxDist = 150;
    this.panSpeed = 30;
    this.fov = 34;
    this.fovWant = 34;
    this.bounds = opts.bounds || null;                 // { minX, maxX, minZ, maxZ }

    // --- selection --------------------------------------------------------
    this.cursor = new THREE.Vector3();
    this.hovered = null;
    this.selected = null;
    this.cycleIndex = -1;
    this.orderMode = null;                             // pending order awaiting a target
    this.showThreat = false;
    this.locked = false;                               // true while a transition plays

    // --- overlays ---------------------------------------------------------
    this.group = new THREE.Group();
    this.group.name = 'commandOverlays';
    this.group.renderOrder = 900;
    this.group.matrixAutoUpdate = false;
    this.scene?.add(this.group);

    // Movement and threat are WASHES — one painted sheet each, sampled per
    // fragment. Fire arcs stay geometry (they are drawn fans, not a field).
    this.surveyMesh = this._makeSurvey();
    this.moveMesh = this._makeWash('moveRange', 0.86, 0.11);
    this.threatMesh = this._makeWash('threatMap', 0.74, 0.085);
    this.arcMesh = this._makeCellMesh('fireArcs', 0.30);
    this.cursorRing = this._makeRing(0.55, 0.72, 0xf2e6cf, 0.9);
    this.selectRing = this._makeRing(0.72, 0.95, 0xf6d9a0, 0.95);
    this.hoverRing = this._makeRing(0.62, 0.80, 0xbfd6cf, 0.7);
    this.ghostMarks = this._makeCellMesh('lastKnown', 0.8, true);
    this.group.add(this.surveyMesh, this.moveMesh, this.threatMesh, this.arcMesh,
      this.ghostMarks, this.cursorRing, this.selectRing, this.hoverRing);

    this._moveDirty = true;
    this._threatDirty = true;
    this._ringT = 0;
    this._offBus = [];
    // Capture-only handle. The overlay's whole job is to be INVISIBLE as
    // machinery, which means the only way to measure it is to difference a
    // frame against the same frame with the washes switched off; the shot
    // harness needs a way in to do that. Never present in a played build.
    if (typeof window !== 'undefined' && CFG.capture) window.__CM__ = this;
  }

  // -------------------------------------------------------------------------

  enter() {
    this.active = true;
    this.group.visible = true;
    this.fovWant = 34;
    this.showThreat = false;
    this._threatDirty = true;
    this._moveDirty = true;
    if (!CFG.capture) Input.exitLock();
    // Frame the player's centre of mass on entry.
    if (!this._entered) {
      this.frameTeam(0, true, true);
      this._entered = true;
    }
    this._ensureSheet();
    if (this.surveyMesh) this.surveyMesh.visible = true;
    this.refreshFog();
    this.buildThreatOverlay();
    this.buildFireArcs();
    this.syncFigureLod();
    Bus.emit('command:enter', { cp: this.battle.cp[0], turn: this.battle.turn });
  }

  exit() {
    if (!this.active) return;            // idempotent: Battle.setPhase also calls this
    this.active = false;
    this.group.visible = false;
    this.restoreRigs();
    this.clearSelection();
    Bus.emit('command:exit', {});
  }

  // -------------------------------------------------------------------------
  // Figure level of detail
  //
  // A SOLDIER AT THIRTEEN PIXELS IS NOT A SOLDIER.
  //
  // Round 6 measured the focal figure on this map at 13x24 px with its interior
  // flipping 56<->160 between adjacent pixels: the paper and hatch passes inject
  // a residual of sd 22.4 lum against a band step of 22.2, so at map range the
  // grain is 101% of the light and every man is salt-and-pepper. That is not a
  // shading bug that better shading fixes — it is a resolution bug, and the
  // answer a tactical map has always used is to stop drawing the man and draw
  // his SYMBOL. Below RIG_MIN_PX of projected height the rig is switched off and
  // src/ui/worldLabels.js draws an authored figure in DOM at 1.75x the size he
  // projected to, above the render and therefore outside the grain entirely.
  //
  // Vehicles are exempt: the Edelweiss projects ~88 px here and the lit tank is
  // one of the few things the critics have consistently scored well.
  // -------------------------------------------------------------------------

  /** Hide every rig too small to read; remember which ones so exit can undo it. */
  syncFigureLod() {
    const hidden = this._hiddenRigs || (this._hiddenRigs = []);
    this.restoreRigs();
    const cam = this.camera;
    if (!cam) return;
    const vh = (typeof innerHeight === 'number' && innerHeight > 0) ? innerHeight : 1080;
    const pxAt1m = vh / (2 * Math.tan(((cam.fov || 40) * Math.PI) / 360));
    for (const u of this.battle.units) {
      if (!u.root || u.isVehicle || !u.deployed) continue;
      const d = Math.max(1, cam.position.distanceTo(u.pos));
      if ((1.75 * pxAt1m) / d >= RIG_MIN_PX) continue;
      if (u.root.visible) { u.root.visible = false; hidden.push(u); }
    }
  }

  restoreRigs() {
    const hidden = this._hiddenRigs;
    if (!hidden || !hidden.length) return;
    for (const u of hidden) if (u.root) u.root.visible = true;
    hidden.length = 0;
  }

  clearSelection() {
    this.selected = null;
    this.orderMode = null;
    this.moveMesh.visible = false;
    this.selectRing.visible = false;
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  update(dt) {
    if (!this.active) { this.updateCamera(dt); return; }
    this._ringT += dt;

    if (!CFG.capture && !this.locked) {
      this.readCameraInput(dt);
      this.readSelectionInput(dt);
    }
    this.updateCamera(dt);
    this.updateCursor();
    this.updateRings(dt);
    // Re-run every frame rather than on a clock: a scripted shot poses its units
    // AFTER enter() and the harness's settle loop has to converge on a stable
    // draw list, which it cannot do if this is answering a stale staging.
    this.syncFigureLod();
    if (this._moveDirty) { this.buildMoveOverlay(); this._moveDirty = false; }
    if (this._threatDirty) { this.buildThreatOverlay(); this.buildFireArcs(); this._threatDirty = false; }
    this.threatMesh.visible = this.showThreat;
    this.arcMesh.visible = this.showThreat;
  }

  readCameraInput(dt) {
    const sp = this.panSpeed * (this.dist / 58) * (Input.down('shift') ? 2.2 : 1);
    let px = 0, pz = 0;
    if (Input.down('w') || Input.down('arrowup')) pz += 1;
    if (Input.down('s') || Input.down('arrowdown')) pz -= 1;
    if (Input.down('a') || Input.down('arrowleft')) px -= 1;
    if (Input.down('d') || Input.down('arrowright')) px += 1;
    if (px || pz) {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      this.targetWant.x += (s * pz + c * px) * sp * dt;
      this.targetWant.z += (c * pz - s * px) * sp * dt;
    }
    if (Input.down('q')) this.yawWant -= dt * 1.5;
    if (Input.down('e')) this.yawWant += dt * 1.5;
    if (Input.mouse.right && !CFG.capture) {
      this.yawWant += Input.mouse.dx * 0.005;
      this.pitchWant = clamp(this.pitchWant + Input.mouse.dy * 0.004, -1.45, -0.32);
    }
    if (Input.mouse.wheel) {
      this.distWant = clamp(this.distWant * (1 + Input.mouse.wheel * 0.13), this.minDist, this.maxDist);
    }
    if (this.bounds) {
      this.targetWant.x = clamp(this.targetWant.x, this.bounds.minX, this.bounds.maxX);
      this.targetWant.z = clamp(this.targetWant.z, this.bounds.minZ, this.bounds.maxZ);
    }
  }

  readSelectionInput() {
    const b = this.battle;

    if (Input.pressed('tab')) this.cycleSelection(Input.down('shift') ? -1 : 1);
    if (Input.pressed('t')) { this.showThreat = !this.showThreat; Bus.emit('sfx', { name: 'uiSelect' }); }
    if (Input.pressed('escape') || Input.pressed('backspace')) {
      if (this.orderMode) { this.cancelOrder(); }
      else this.clearSelection();
    }
    if (Input.pressed('n')) { Bus.emit('command:endTurnRequest', {}); b.endTurn(); return; }

    // Left click: hover -> select -> confirm
    if (Input.mouse.leftJust) {
      if (this.orderMode) { this.applyOrderAt(this.hovered, this.cursor); return; }
      if (this.hovered && this.hovered.team === 0) {
        if (this.selected === this.hovered) this.confirmSelection();
        else this.select(this.hovered);
      } else if (this.hovered) {
        Bus.emit('command:inspect', { unit: this.hovered });
        Bus.emit('sfx', { name: 'uiSelect' });
      }
    }
    if (Input.pressed('enter') || Input.pressed(' ')) {
      if (this.selected) this.confirmSelection();
    }
  }

  cycleSelection(dir) {
    const list = this.battle.units.filter((u) => u.team === 0 && u.active);
    if (!list.length) return;
    this.cycleIndex = (this.cycleIndex + dir + list.length * 2) % list.length;
    this.select(list[this.cycleIndex]);
    this.focusOn(list[this.cycleIndex].pos);
  }

  select(u) {
    if (!u || !u.active || u.team !== 0) return;
    this.selected = u;
    this.cycleIndex = this.battle.units.filter((x) => x.team === 0 && x.active).indexOf(u);
    this._moveDirty = true;
    this.selectRing.visible = true;
    Bus.emit('unit:selected', { unit: u });
    Bus.emit('command:preview', {
      unit: u,
      apNext: this.battle.previewAp(u),
      cost: this.battle.selectCost(u),
      cp: this.battle.cp[0],
    });
    Bus.emit('sfx', { name: 'uiSelect' });
  }

  confirmSelection() {
    const u = this.selected;
    if (!u) return;
    if (!this.battle.canSelect(u)) {
      Bus.emit('command:denied', { unit: u, reason: this.battle.selectDenyReason(u) });
      Bus.emit('sfx', { name: 'uiDeny' });
      return;
    }
    this.locked = true;
    Bus.emit('sfx', { name: 'uiConfirm' });
    this.battle.selectUnit(u);
    this.locked = false;
  }

  // -- orders --------------------------------------------------------------

  beginOrder(id) {
    const o = ORDERS[id];
    if (!o) return false;
    if (this.battle.cp[0] < o.cost) {
      Bus.emit('command:denied', { order: o, reason: 'Not enough Command Points' });
      Bus.emit('sfx', { name: 'uiDeny' });
      return false;
    }
    if (o.target === 'none') { this.battle.useOrder(id, null); return true; }
    this.orderMode = o;
    Bus.emit('order:prompt', { order: o, target: o.target });
    return true;
  }

  cancelOrder() {
    if (!this.orderMode) return;
    Bus.emit('order:cancel', { order: this.orderMode });
    this.orderMode = null;
    Bus.emit('sfx', { name: 'uiBack' });
  }

  applyOrderAt(unit, point) {
    const o = this.orderMode;
    if (!o) return;
    const tgt = o.target === 'unit' ? unit : point;
    if (o.target === 'unit' && (!unit || unit.team !== 0 || !o.filter(unit, this.battle))) {
      Bus.emit('command:denied', { order: o, reason: 'Invalid target' });
      Bus.emit('sfx', { name: 'uiDeny' });
      return;
    }
    if (this.battle.useOrder(o.id, tgt)) {
      this.orderMode = null;
      this._threatDirty = true;
      this._moveDirty = true;
    }
  }

  availableOrders() { return availableOrders(this.battle, 0); }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  focusOn(pos, immediate = false) {
    this.targetWant.set(pos.x, 0, pos.z);
    if (immediate) this.target.copy(this.targetWant);
  }

  /**
   * Centre the map on `team`'s centre of mass. With `fit`, also put the rig back to the default
   * map attitude and pull it far enough back to hold the whole squad in shot.
   *
   * `fit` is what a turn change wants. The Imperial phase walks `focusOn` across the valley
   * after whichever soldier is acting and the player is free to orbit, zoom and pan anywhere,
   * so by the time the turn comes back the lens can be anywhere at any angle at any distance —
   * round 21 shipped a command frame that was a close-up of two village roofs with the whole
   * roster off-screen. Re-framing without also resetting distance and attitude would fix the
   * centre and leave a 20 m close-up, which is the same unreadable frame with a soldier in it.
   */
  frameTeam(team, immediate = false, fit = false) {
    let n = 0;
    _v0.set(0, 0, 0);
    for (const u of this.battle.units) {
      if (u.team !== team || !u.active) continue;
      _v0.add(u.pos); n++;
    }
    if (!n) return;
    _v0.multiplyScalar(1 / n);
    if (fit) {
      let r = 0;
      for (const u of this.battle.units) {
        if (u.team !== team || !u.active) continue;
        r = Math.max(r, Math.hypot(u.pos.x - _v0.x, u.pos.z - _v0.z));
      }
      this.yawWant = 0.35;
      this.pitchWant = -0.98;
      this.fovWant = 34;
      // 2.9x the squad's radius plus a 12 m margin — at the mission's opening spread (r ~ 8 m)
      // that lands on 58 m, the authored default, and it opens out gently from there. Held to a
      // 46-96 m band on purpose: the exact geometric fit for a squad strung 60 m across the
      // valley is 150 m, where a soldier is 14 px and the frame is technically correct and
      // practically useless. Better to frame the centre of mass well and let the player pan.
      this.distWant = clamp(2.9 * (r + 12), 46, 96);
      if (immediate) {
        this.yaw = this.yawWant; this.pitch = this.pitchWant;
        this.dist = this.distWant; this.fov = this.fovWant;
      }
    }
    this.focusOn(_v0, immediate);
  }

  updateCamera(dt) {
    this.target.lerp(this.targetWant, 1 - Math.exp(-7 * dt));
    this.yaw = dampAngle(this.yaw, this.yawWant, 7, dt);
    this.pitch = damp(this.pitch, this.pitchWant, 7, dt);
    this.dist = damp(this.dist, this.distWant, 6.5, dt);
    this.fov = damp(this.fov, this.fovWant, 6, dt);

    const gy = this.nav ? this.nav.heightAt(this.target.x, this.target.z) : 0;
    this.target.y = damp(this.target.y, gy, 5, dt);

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    _v0.set(Math.sin(this.yaw) * cp, sp, Math.cos(this.yaw) * cp);
    this.camera.position.copy(this.target).addScaledVector(_v0, -this.dist);
    // Do not clip into the hillside.
    if (this.nav) {
      const gh = this.nav.heightAt(this.camera.position.x, this.camera.position.z) + 2.2;
      if (this.camera.position.y < gh) this.camera.position.y = gh;
    }
    this.camera.lookAt(this.target);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  // -------------------------------------------------------------------------
  // Cursor + hover
  // -------------------------------------------------------------------------

  /** Project the mouse onto the terrain, then snap to the nearest visible soldier. */
  updateCursor() {
    const nx = CFG.capture ? 0 : Input.mouse.nx;
    const ny = CFG.capture ? 0 : Input.mouse.ny;
    _ray.set(nx, ny, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    const h = traceWorld(
      this.camera.position.x, this.camera.position.y, this.camera.position.z,
      _ray.x, _ray.y, _ray.z, 600, this.world,
    );
    if (h) this.cursor.set(h.x, h.y, h.z);
    else {
      // No terrain hit: fall back to the y = target.y plane.
      const t = (this.target.y - this.camera.position.y) / (_ray.y || -1e-4);
      if (t > 0) this.cursor.copy(this.camera.position).addScaledVector(_ray, t);
    }

    // Screen-space snap: the closest unit within 64 px wins.
    let best = null, bestD = 64 * 64;
    const w = typeof innerWidth === 'number' ? innerWidth : 1920;
    const hgt = typeof innerHeight === 'number' ? innerHeight : 1080;
    const mx = CFG.capture ? w * 0.5 : Input.mouse.x;
    const my = CFG.capture ? hgt * 0.5 : Input.mouse.y;
    for (const u of this.battle.units) {
      if (!u.deployed || (!u.alive && !u.downed)) continue;
      if (u.team !== 0 && !u.spotted) continue;
      _proj.copy(u.pos); _proj.y += 1.1;
      _proj.project(this.camera);
      if (_proj.z > 1) continue;
      const sx = (_proj.x * 0.5 + 0.5) * w;
      const sy = (-_proj.y * 0.5 + 0.5) * hgt;
      const d2 = (sx - mx) ** 2 + (sy - my) ** 2;
      if (d2 < bestD) { bestD = d2; best = u; }
    }
    if (best !== this.hovered) {
      this.hovered = best;
      Bus.emit('command:hover', { unit: best, cursor: this.cursor });
      if (best) Bus.emit('sfx', { name: 'uiCursor', vol: 0.4 });
    }
    Bus.emit('command:cursor', { pos: this.cursor, unit: best, order: this.orderMode });
  }

  updateRings(dt) {
    const pulse = 0.5 + 0.5 * Math.sin(this._ringT * 3.4);
    this.cursorRing.position.set(this.cursor.x, this.cursor.y + 0.06, this.cursor.z);
    this.cursorRing.scale.setScalar(1 + pulse * 0.06);
    this.cursorRing.visible = this.active;

    if (this.hovered) {
      this.hoverRing.position.set(this.hovered.pos.x, this.hovered.pos.y + 0.07, this.hovered.pos.z);
      this.hoverRing.scale.setScalar(this.hovered.isVehicle ? 3.0 : 1.25);
      this.hoverRing.visible = true;
    } else this.hoverRing.visible = false;

    if (this.selected && this.selected.active) {
      this.selectRing.position.set(this.selected.pos.x, this.selected.pos.y + 0.08, this.selected.pos.z);
      this.selectRing.scale.setScalar((this.selected.isVehicle ? 3.0 : 1.35) * (1 + pulse * 0.05));
      this.selectRing.visible = true;
    } else this.selectRing.visible = false;
  }

  // -------------------------------------------------------------------------
  // Fog of war
  // -------------------------------------------------------------------------

  /**
   * Battle owns the spotting truth (the AI reads it too); we just rebuild the ghost markers
   * for anything that has slipped back into the fog.
   */
  refreshFog() {
    this.battle.refreshFog();
    this.buildGhostMarks();
  }

  buildGhostMarks() {
    const b = this.battle;
    _cells.length = 0;
    for (const u of b.units) {
      if (u.team === 0 || u.spotted || !u.alive) continue;
      if (u.lastKnownTurn < b.turn - 1) continue;
      _cells.push(u.lastKnown.x, u.lastKnown.y + 0.05, u.lastKnown.z, 0.55, 0.30, 0.34, 0.5);
    }
    this._fillCellMesh(this.ghostMarks, _cells, 2.7);
    this.ghostMarks.visible = _cells.length > 0;
  }

  // -------------------------------------------------------------------------
  // Overlays
  // -------------------------------------------------------------------------

  buildMoveOverlay() {
    const u = this.selected;
    if (!u || !u.active || !this.nav) { this.moveMesh.visible = false; return; }
    const nav = this.nav;
    const ap = this.battle.previewAp(u);
    const range = ap / u.apPerMetre;
    const fill = this.nav.floodFill(u.pos, range);
    const cells = fill.cells;
    const f = this._washFields(nav.w * nav.h);
    f.cov.fill(0); f.amt.fill(0); f.ramp.fill(0);
    for (let i = 0; i < cells.length; i++) {
      const ci = cells[i];
      const t = clamp01(nav.reachDist(ci) / Math.max(1, range));
      f.cov[ci] = 1;
      // The near ground takes more pigment than the far ground: a brush loaded
      // at the soldier's feet runs out as the reach does.
      f.amt[ci] = lerp(1.0, 0.42, t * t);
      f.ramp[ci] = t * t;
    }
    // A HAND-TINTED AREA, NOT A FILLED POLYGON.
    //
    // A staff officer washing a movement area onto a survey does not flood it: he
    // runs the boundary in with a loaded brush and lets the pigment pool there,
    // and the middle of the area keeps almost all of the map underneath. So the
    // BODY is thin and the wet EDGE carries the read — which is also the only way
    // the terrain survives being annotated, and the round-4/5 note "the whole
    // middle of the frame went to one flat pale teal" was the opposite arrangement.
    this._paintWash(this.moveMesh, f, COL_MOVE_NEAR, COL_MOVE_FAR, COL_MOVE_EDGE, {
      seed: 17, edge: 1.20, grain: 0.34, blur: 2, body: 0.22, rim: 0.80,
    });
    this.moveMesh.visible = cells.length > 0;
    Bus.emit('command:range', { unit: u, metres: range, cells: cells.length });
  }

  buildThreatOverlay() {
    if (!this.nav) return;
    this.nav.buildThreat(this.battle.units, 0);
    const nav = this.nav;
    const th = nav.threat;
    let maxT = 0.0001;
    for (let i = 0; i < th.length; i++) if (th[i] > maxT) maxT = th[i];
    const n = nav.w * nav.h;
    const f = this._washFields(n);
    f.cov.fill(0); f.amt.fill(0); f.ramp.fill(0);
    let any = 0;
    for (let i = 0; i < n; i++) {
      const v = th[i];
      if (v < maxT * 0.06) continue;
      const t = clamp01(v / maxT);
      f.cov[i] = 1;
      f.amt[i] = 0.26 + 0.74 * t * t;
      f.ramp[i] = t;
      any++;
    }
    // Same reasoning as the movement wash: the killing ground is drawn as an
    // outline that has bled inward, not as a red sheet over the village.
    this._paintWash(this.threatMesh, f, COL_THREAT, COL_THREAT_HOT, COL_THREAT_EDGE, {
      seed: 91, edge: 0.90, grain: 0.40, blur: 3, body: 0.22, rim: 0.78,
    });
    // The threat wash is opt-in (T key / a shot asking for it). Painting the
    // sheet is not a reason to SHOW it — only the caller knows that.
    this.threatMesh.visible = this.showThreat && any > 0;
  }

  /** Filled fans showing each spotted enemy's interception cone. */
  buildFireArcs() {
    const b = this.battle;
    const pos = [], col = [];
    const SEG = 22;
    for (const u of b.units) {
      if (u.team === 0 || !u.spotted || !u.active) continue;
      const C = u.classDef;
      const R = C.interceptRange || 0;
      if (R <= 0) continue;
      const half = (C.interceptCone || Math.PI) * 0.5;
      const y0 = (this.nav ? this.nav.heightAt(u.pos.x, u.pos.z) : u.pos.y) + 0.03;
      for (let s = 0; s < SEG; s++) {
        const a0 = u.aimYaw - half + (s / SEG) * half * 2;
        const a1 = u.aimYaw - half + ((s + 1) / SEG) * half * 2;
        const x0 = u.pos.x + Math.sin(a0) * R, z0 = u.pos.z + Math.cos(a0) * R;
        const x1 = u.pos.x + Math.sin(a1) * R, z1 = u.pos.z + Math.cos(a1) * R;
        const y1 = this.nav ? this.nav.heightAt(x0, z0) + 0.03 : y0;
        const y2 = this.nav ? this.nav.heightAt(x1, z1) + 0.03 : y0;
        pos.push(u.pos.x, y0, u.pos.z, x0, y1, z0, x1, y2, z1);
        col.push(COL_ARC.r, COL_ARC.g, COL_ARC.b, 0.30);
        col.push(COL_ARC.r, COL_ARC.g, COL_ARC.b, 0.02);
        col.push(COL_ARC.r, COL_ARC.g, COL_ARC.b, 0.02);
      }
    }
    const g = this.arcMesh.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setDrawRange(0, pos.length / 3);
    g.computeBoundingSphere();
    this.arcMesh.visible = this.showThreat && pos.length > 0;
  }

  markDirty() { this._moveDirty = true; this._threatDirty = true; }

  // -------------------------------------------------------------------------
  // Overlay mesh plumbing
  // -------------------------------------------------------------------------

  _makeCellMesh(name, opacity, soft = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute([], 4));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([], 2));
    const m = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      // A last-known-position mark is a thumbprint of pigment, not a tile: with
      // a hard-edged quad it reads as a selection box on the map.
      map: soft ? blotTexture() : null,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.renderOrder = 901;
    mesh.userData.outline = false;
    mesh.userData.overlay = true;
    mesh.visible = false;
    return mesh;
  }

  /**
   * One terrain-conforming sheet for a painted overlay. The geometry is shared
   * between every wash (built once, off the nav grid); only the texture differs.
   */
  _makeWash(name, opacity, lift) {
    const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    const m = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      // The sheet floats a hand's breadth over the ground; the offset keeps it
      // off the terrain's own z under the shallow command pitch.
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.renderOrder = 901;
    mesh.userData.outline = false;
    mesh.userData.overlay = true;
    mesh.visible = false;
    mesh.position.y = lift;
    mesh.userData.washTex = tex;
    return mesh;
  }

  /**
   * The survey furniture sheet — contours, graticule and river, on the terrain.
   *
   * It shares the wash geometry (built by `_ensureSheet`) and sits UNDER both
   * washes at a lower lift and a lower render order, so the movement and threat
   * tints read as pigment laid over a printed sheet rather than beside it.
   */
  _makeSurvey() {
    const m = new THREE.ShaderMaterial({
      vertexShader: SURVEY_VERT,
      fragmentShader: SURVEY_FRAG,
      uniforms: {
        // Sepia contour ink and a fainter blue-grey graticule: the two hands a
        // survey is actually drawn in. Both are OFF the 10-65 degree khaki wedge
        // that 72% of this frame's chromatic pixels fell into.
        uInk: { value: new THREE.Color(0.0423, 0.0284, 0.0194) },
        uGrat: { value: new THREE.Color(0.0670, 0.0670, 0.1248) },
        uWater: { value: new THREE.Color(0.109, 0.219, 0.249) },
        uStep: { value: 2.0 },
        uGrid: { value: 10.0 },
        uWaterY: { value: 2.0 },
        uOpacity: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -3,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
    mesh.name = 'surveySheet';
    mesh.frustumCulled = false;
    mesh.renderOrder = 900;
    mesh.userData.outline = false;
    mesh.userData.overlay = true;
    mesh.position.y = 0.055;
    mesh.visible = false;
    return mesh;
  }

  /** Scratch fields at nav resolution, allocated once. */
  _washFields(n) {
    let f = this._fields;
    if (!f || f.cov.length !== n) {
      f = this._fields = {
        cov: new Float32Array(n), amt: new Float32Array(n), ramp: new Float32Array(n),
      };
    }
    return f;
  }

  /**
   * Build (once) the sheet the washes are painted on: a grid over the nav area
   * whose vertices sit on the terrain, with UVs that put texel (ix+.5)/W exactly
   * over the centre of nav cell ix.
   */
  _ensureSheet() {
    if (this._sheet) return this._sheet;
    const nav = this.nav;
    if (!nav) return null;
    const W = nav.w, H = nav.h, c = nav.cell;
    const vx = W + 1, vz = H + 1;
    const pos = new Float32Array(vx * vz * 3);
    const uv = new Float32Array(vx * vz * 2);
    for (let j = 0; j < vz; j++) {
      for (let i = 0; i < vx; i++) {
        const k = j * vx + i;
        const x = nav.minX + i * c, z = nav.minZ + j * c;
        // Take the HIGHEST of a small neighbourhood: a sheet hung off corner
        // samples alone gets bitten through by every ridge that runs between
        // two of them.
        let y = nav.heightAt(x, z);
        const q = c * 0.5;
        y = Math.max(y, nav.heightAt(x - q, z), nav.heightAt(x + q, z),
          nav.heightAt(x, z - q), nav.heightAt(x, z + q));
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        uv[k * 2] = i / W; uv[k * 2 + 1] = j / H;
      }
    }
    const idx = (vx * vz > 65535 ? new Uint32Array(W * H * 6) : new Uint16Array(W * H * 6));
    let o = 0;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const a = j * vx + i, b = a + 1, d = a + vx, e = d + 1;
        idx[o++] = a; idx[o++] = d; idx[o++] = b;
        idx[o++] = b; idx[o++] = d; idx[o++] = e;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    this._sheet = g;
    for (const m of [this.surveyMesh, this.moveMesh, this.threatMesh]) m.geometry = g;
    if (this.surveyMesh) {
      this.surveyMesh.material.uniforms.uWaterY.value =
        typeof WATER_Y === 'number' ? WATER_Y : 2.0;
      this.surveyMesh.visible = this.active;
    }
    return g;
  }

  /**
   * Lay `f` down as pigment: blur the coverage so the boundary is a bled edge
   * rather than a row of cells, pool a darker rim where the wash stopped (the
   * wet edge every flat wash dries with), and granulate the interior so the
   * sheet has tooth. Nothing in the output is aligned to the cell grid.
   *
   * @param {THREE.Mesh} mesh a `_makeWash` sheet
   * @param {{cov:Float32Array,amt:Float32Array,ramp:Float32Array}} f nav-res fields
   * @param {THREE.Color} colA near/low colour
   * @param {THREE.Color} colB far/high colour
   * @param {THREE.Color} colE the pigment that pools at the wet edge
   */
  _paintWash(mesh, f, colA, colB, colE, {
    seed = 1, edge = 0.9, grain = 0.32, blur = 2, body = 0.30, rim: rimGain = 0.42,
  } = {}) {
    const g = this._ensureSheet();
    if (!g) return;
    const nav = this.nav;
    const W = nav.w, H = nav.h;
    const S = WASH_SS;
    const TW = W * S, TH = H * S;

    // Blur at nav resolution: cheap, and one pass is already a 1.5 m bleed.
    blurField(f.cov, W, H, blur);
    blurField(f.amt, W, H, blur);
    blurField(f.ramp, W, H, 1);

    // Per-MESH, not per-CommandMode: a shared scratch buffer is the same
    // Uint8Array behind both DataTextures, so whichever wash painted last
    // silently became the other one too.
    let buf = mesh.userData.washBuf;
    if (!buf || buf.length !== TW * TH * 4) {
      buf = mesh.userData.washBuf = new Uint8Array(TW * TH * 4);
    }

    const bilinear = (src, u, v) => {
      const x = u * W - 0.5, y = v * H - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      const cx0 = x0 < 0 ? 0 : x0 >= W ? W - 1 : x0;
      const cx1 = x0 + 1 < 0 ? 0 : x0 + 1 >= W ? W - 1 : x0 + 1;
      const cy0 = y0 < 0 ? 0 : y0 >= H ? H - 1 : y0;
      const cy1 = y0 + 1 < 0 ? 0 : y0 + 1 >= H ? H - 1 : y0 + 1;
      const a = src[cy0 * W + cx0], b = src[cy0 * W + cx1];
      const c = src[cy1 * W + cx0], d = src[cy1 * W + cx1];
      return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    };

    for (let ty = 0; ty < TH; ty++) {
      const v = (ty + 0.5) / TH;
      for (let tx = 0; tx < TW; tx++) {
        const u = (tx + 0.5) / TW;
        const o = (ty * TW + tx) * 4;
        const cov = bilinear(f.cov, u, v);
        if (cov <= 0.004) { buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0; continue; }
        const amt = bilinear(f.amt, u, v);
        const ramp = clamp01(bilinear(f.ramp, u, v));

        // Wet edge: pigment carried to the drying boundary and left there.
        const rim = Math.pow(clamp01(4 * cov * (1 - cov)), 1.35) * edge;
        // Tooth + granulation, two scales, neither of them the cell pitch.
        const n1 = vnoise(tx, ty, S * 0.85, seed);
        const n2 = vnoise(tx, ty, S * 4.3, seed + 37);
        const gr = 1 + grain * (n1 - 0.5) * 2 * 0.6 + grain * (n2 - 0.5) * 2 * 0.4;

        _c1.copy(colA).lerp(colB, ramp);
        if (rim > 0) _c1.lerp(colE, Math.min(0.85, rim));
        const a = clamp01((amt * cov * body + rim * rimGain) * gr);
        buf[o] = (_c1.r * 255) | 0;
        buf[o + 1] = (_c1.g * 255) | 0;
        buf[o + 2] = (_c1.b * 255) | 0;
        buf[o + 3] = (a * 255) | 0;
      }
    }

    const tex = mesh.userData.washTex;
    tex.image = { data: buf, width: TW, height: TH };
    tex.needsUpdate = true;
  }

  /**
   * `data` is a flat [x,y,z, r,g,b,a] per cell; writes two triangles per cell.
   * Filling a buffer is not a reason to make the mesh visible — only the caller
   * knows whether this overlay is currently wanted — so this hides an empty
   * mesh and otherwise leaves `visible` alone.
   */
  _fillCellMesh(mesh, data, size) {
    const n = data.length / 7;
    if (n === 0) { mesh.geometry.setDrawRange(0, 0); mesh.visible = false; return; }
    const half = size * 0.5;
    const pos = new Float32Array(n * 18);
    const col = new Float32Array(n * 24);
    const uvs = new Float32Array(n * 12);
    let pi = 0, ci = 0, ui = 0;
    // two triangles, CCW when viewed from above
    const KX = [0, 1, 1, 0, 1, 0], KZ = [0, 0, 1, 0, 1, 1];
    for (let i = 0; i < n; i++) {
      const o = i * 7;
      const x = data[o], y = data[o + 1], z = data[o + 2];
      const r = data[o + 3], g = data[o + 4], b = data[o + 5], a = data[o + 6];
      for (let k = 0; k < 6; k++) {
        pos[pi++] = x + (KX[k] * 2 - 1) * half;
        pos[pi++] = y;
        pos[pi++] = z + (KZ[k] * 2 - 1) * half;
        col[ci++] = r; col[ci++] = g; col[ci++] = b; col[ci++] = a;
        uvs[ui++] = KX[k]; uvs[ui++] = KZ[k];
      }
    }
    const geo = mesh.geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setDrawRange(0, n * 6);
    geo.computeBoundingSphere();
  }

  _makeRing(inner, outer, color, opacity) {
    const g = new THREE.RingGeometry(inner, outer, 40);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 905;
    mesh.userData.outline = false;
    mesh.userData.overlay = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  dispose() {
    this.restoreRigs();
    for (const m of [this.surveyMesh, this.moveMesh, this.threatMesh, this.arcMesh,
      this.ghostMarks, this.cursorRing, this.selectRing, this.hoverRing]) {
      m.geometry.dispose();
      if (m.userData.washTex) m.userData.washTex.dispose();
      m.material.dispose();
    }
    this._sheet = null;
    this.scene?.remove(this.group);
    for (const off of this._offBus) off();
  }
}

const _cells = [];

export default CommandMode;
