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

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _proj = new THREE.Vector3();

// Ink-wash overlay palette, tuned to sit inside the CANVAS gouache range.
// NOTE: these are THREE.Color, so blend them through `_c1` (a Color). A Vector3
// cannot `.copy()` a Color — it reads .x/.y/.z, gets undefined, and every cell
// colour comes out NaN, which the vertex-colour path rasterises as solid black.
const _c1 = new THREE.Color();
const COL_MOVE_NEAR = new THREE.Color(0.74, 0.88, 0.86);
const COL_MOVE_FAR = new THREE.Color(0.40, 0.60, 0.66);
const COL_MOVE_EDGE = new THREE.Color(0.93, 0.97, 0.95);
const COL_THREAT = new THREE.Color(0.62, 0.24, 0.20);
const COL_THREAT_HOT = new THREE.Color(0.80, 0.34, 0.22);
const COL_ARC = new THREE.Color(0.70, 0.32, 0.26);

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

    this.moveMesh = this._makeCellMesh('moveRange', 0.62);
    this.threatMesh = this._makeCellMesh('threatMap', 0.44);
    this.arcMesh = this._makeCellMesh('fireArcs', 0.30);
    this.cursorRing = this._makeRing(0.55, 0.72, 0xf2e6cf, 0.9);
    this.selectRing = this._makeRing(0.72, 0.95, 0xf6d9a0, 0.95);
    this.hoverRing = this._makeRing(0.62, 0.80, 0xbfd6cf, 0.7);
    this.ghostMarks = this._makeCellMesh('lastKnown', 0.8);
    this.group.add(this.moveMesh, this.threatMesh, this.arcMesh, this.ghostMarks,
      this.cursorRing, this.selectRing, this.hoverRing);

    this._moveDirty = true;
    this._threatDirty = true;
    this._ringT = 0;
    this._offBus = [];
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
      this.frameTeam(0, true);
      this._entered = true;
    }
    this.refreshFog();
    this.buildThreatOverlay();
    this.buildFireArcs();
    Bus.emit('command:enter', { cp: this.battle.cp[0], turn: this.battle.turn });
  }

  exit() {
    if (!this.active) return;            // idempotent: Battle.setPhase also calls this
    this.active = false;
    this.group.visible = false;
    this.clearSelection();
    Bus.emit('command:exit', {});
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

  frameTeam(team, immediate = false) {
    let n = 0;
    _v0.set(0, 0, 0);
    for (const u of this.battle.units) {
      if (u.team !== team || !u.active) continue;
      _v0.add(u.pos); n++;
    }
    if (n) { _v0.multiplyScalar(1 / n); this.focusOn(_v0, immediate); }
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
    this._fillCellMesh(this.ghostMarks, _cells, 1.5);
    this.ghostMarks.visible = _cells.length > 0;
  }

  // -------------------------------------------------------------------------
  // Overlays
  // -------------------------------------------------------------------------

  buildMoveOverlay() {
    const u = this.selected;
    if (!u || !u.active || !this.nav) { this.moveMesh.visible = false; return; }
    const ap = this.battle.previewAp(u);
    const range = ap / u.apPerMetre;
    const fill = this.nav.floodFill(u.pos, range);
    const cells = fill.cells;
    _cells.length = 0;
    const nav = this.nav;
    for (let i = 0; i < cells.length; i++) {
      const ci = cells[i];
      const d = nav.reachDist(ci);
      const t = clamp01(d / Math.max(1, range));
      const ix = ci % nav.w, iz = (ci / nav.w) | 0;
      // Cells on the frontier get the bright wash edge that reads as a brush stroke.
      let edge = false;
      for (let k = 0; k < 4 && !edge; k++) {
        const jx = ix + EDGE_X[k], jz = iz + EDGE_Z[k];
        if (!nav.inBounds(jx, jz)) { edge = true; break; }
        if (nav.reachDist(nav.idx(jx, jz)) > range) edge = true;
      }
      _c1.copy(COL_MOVE_NEAR).lerp(COL_MOVE_FAR, t * t);
      if (edge) _c1.lerp(COL_MOVE_EDGE, 0.72);
      _cells.push(
        nav.worldX(ix), nav.heightAt(nav.worldX(ix), nav.worldZ(iz)) + 0.045, nav.worldZ(iz),
        _c1.r, _c1.g, _c1.b, edge ? 0.58 : lerp(0.34, 0.16, t),
      );
    }
    this._fillCellMesh(this.moveMesh, _cells, nav.cell * 1.02);
    this.moveMesh.visible = _cells.length > 0;
    Bus.emit('command:range', { unit: u, metres: range, cells: cells.length });
  }

  buildThreatOverlay() {
    if (!this.nav) return;
    this.nav.buildThreat(this.battle.units, 0);
    const nav = this.nav;
    const th = nav.threat;
    let maxT = 0.0001;
    for (let i = 0; i < th.length; i++) if (th[i] > maxT) maxT = th[i];
    _cells.length = 0;
    for (let iz = 0; iz < nav.h; iz++) {
      for (let ix = 0; ix < nav.w; ix++) {
        const i = iz * nav.w + ix;
        const v = th[i];
        if (v < maxT * 0.06) continue;
        const t = clamp01(v / maxT);
        _c1.copy(COL_THREAT).lerp(COL_THREAT_HOT, t);
        _cells.push(
          nav.worldX(ix), nav.heightAt(nav.worldX(ix), nav.worldZ(iz)) + 0.035, nav.worldZ(iz),
          _c1.r, _c1.g, _c1.b, lerp(0.10, 0.42, t * t),
        );
      }
    }
    this._fillCellMesh(this.threatMesh, _cells, nav.cell * 1.02);
    // The threat wash is opt-in (F key / a shot asking for it). _fillCellMesh
    // only ever hides an empty mesh — deciding to SHOW one is the caller's job,
    // otherwise rebuilding the buffer silently turns the overlay back on.
    this.threatMesh.visible = this.showThreat && _cells.length > 0;
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

  _makeCellMesh(name, opacity) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute([], 4));
    const m = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
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
    let pi = 0, ci = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 7;
      const x = data[o], y = data[o + 1], z = data[o + 2];
      const r = data[o + 3], g = data[o + 4], b = data[o + 5], a = data[o + 6];
      // two triangles, CCW when viewed from above
      const xs = [x - half, x + half, x + half, x - half, x + half, x - half];
      const zs = [z - half, z - half, z + half, z - half, z + half, z + half];
      for (let k = 0; k < 6; k++) {
        pos[pi++] = xs[k]; pos[pi++] = y; pos[pi++] = zs[k];
        col[ci++] = r; col[ci++] = g; col[ci++] = b; col[ci++] = a;
      }
    }
    const geo = mesh.geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
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
    for (const m of [this.moveMesh, this.threatMesh, this.arcMesh, this.ghostMarks,
      this.cursorRing, this.selectRing, this.hoverRing]) {
      m.geometry.dispose();
      m.material.dispose();
    }
    this.scene?.remove(this.group);
    for (const off of this._offBus) off();
  }
}

const _cells = [];
const EDGE_X = [1, -1, 0, 0];
const EDGE_Z = [0, 0, 1, -1];

export default CommandMode;
