// Props: the materiel of a contested crossing.
//
// Sandbag emplacements, barbed wire on pickets, Czech hedgehogs and dragon's
// teeth, ammunition crates, oil drums, signposts, telegraph poles carrying
// catenary wires, debris rings around the shell craters, and two wrecks.
//
// Static props are binned by material and merged. Anything that can be
// destroyed keeps its own mesh so it can be collapsed, sunk or hidden at
// runtime — see damage(). Sandbag walls do not vanish when they are shot to
// pieces: they settle, and their cover value drops with them, which is what
// makes them read as *deformable* rather than as an on/off obstacle.

import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { CFG } from '../core/config.js';
import { makeRng, rngRange, valueNoise2 } from '../core/rng.js';
import { clamp01, TAU, lerp } from '../core/math.js';
import {
  mergeGeoms, setGeomColor, tx, box, cyl, loft, wobble,
  catenaryGeom, carveGeometry, worldUV, scorch, rubblePile,
} from './geoutil.js';
import { makeSurfaceMaterial, PALETTE } from './worldMaterials.js';
import { burlapTexture, woodTexture, barbedWireTexture, stoneTexture } from './textures.js';
import { makeBox } from './collider.js';
import { WATER_Y } from './layout.js';

// HP of blast damage a drum delivers at the epicentre — the `power` convention
// documented for the `explosion` Bus event. Enough to set off its neighbours
// (drum hp 20, crates hp 45) without levelling a sandbag revetment.
const DRUM_BLAST_POWER = 55;

const BINS = ['sandbag', 'wood', 'metal', 'stone'];
function newBins() {
  const b = {};
  for (const k of BINS) b[k] = [];
  return b;
}

// ---------------------------------------------------------------------------
// builders (local frame: origin on the ground, +Z is the threat direction)
// ---------------------------------------------------------------------------

/**
 * A sandbag revetment. Bags are laid in courses, each course offset half a bag
 * and pulled back so the wall batters inward; every bag is an independently
 * squashed and wobbled blob, which is what stops a stack of identical
 * primitives from reading as a stack of identical primitives.
 */
export function buildSandbagWall(rng, length, courses = 4, curve = 0.18) {
  const bins = newBins();
  const colliders = [];
  const bagW = 0.62, bagH = 0.28, bagD = 0.40;
  const parts = [];
  const perCourse = Math.max(2, Math.round(length / bagW));
  // The bottom course is bedded slightly into the ground, as it would be.
  const sink = 0.08;
  let top = 0;
  for (let c = 0; c < courses; c++) {
    const y = c * bagH * 0.94 + bagH * 0.5 - sink;
    top = y + bagH * 0.5;
    const inset = c * 0.055;
    const off = (c % 2) * bagW * 0.5;
    for (let i = 0; i < perCourse - (c % 2); i++) {
      const x = -length * 0.5 + off + (i + 0.5) * bagW;
      const z = -Math.pow(x / (length * 0.5), 2) * curve * length * 0.5 + inset;
      const g = new THREE.IcosahedronGeometry(0.5, 1);
      wobble(g, 0.085, 3.4, (c * 31 + i * 7) | 0);
      tx(g, {
        x: x + rngRange(rng, -0.03, 0.03),
        y: y + rngRange(rng, -0.02, 0.02),
        z: z + rngRange(rng, -0.035, 0.035),
        sx: bagW * 0.98, sy: bagH * 1.05, sz: bagD * 1.05,
        ry: rngRange(rng, -0.16, 0.16), rz: rngRange(rng, -0.09, 0.09),
      });
      setGeomColor(g, PALETTE.burlap, 0.11, rng);
      parts.push(g);
    }
  }
  bins.sandbag.push(mergeGeoms(parts));
  for (const p of parts) p.dispose();

  // one collider per ~2 m of frontage so cover follows the curve
  const segs = Math.max(1, Math.round(length / 2.0));
  for (let s = 0; s < segs; s++) {
    const x = -length * 0.5 + (s + 0.5) * (length / segs);
    const z = -Math.pow(x / (length * 0.5), 2) * curve * length * 0.5;
    colliders.push({
      cx: x, cy: top * 0.5, cz: z,
      hx: length / segs * 0.5, hy: top * 0.5, hz: bagD * 0.62, yaw: 0,
      // Sand stops rifle rounds dead; you can still see over the parapet.
      opts: {
        cover: 1, conceal: 0.15, solid: true, blocksLos: false, blocksProjectile: true,
        tag: 'sandbag', destructible: true, hp: 120,
      },
    });
  }
  return { bins, colliders, height: top };
}

/**
 * A field boulder with actual FORM.
 *
 * Round 1's rocks were `IcosahedronGeometry(r, 0)` painted a single near-black
 * (PALETTE.darkest) and lifted clear of the ground, which renders as a flat
 * dark pentagon with a uniform outline round it and no shading inside — the
 * closeup critique called them out by name. Three things fix that:
 *
 *   1. subdivision 1 + ridged displacement, so there are 80 faces at three
 *      different scales and the light actually breaks across them;
 *   2. a per-FACE albedo ramp keyed to the face normal — the up-facing planes
 *      go pale lichen-grey, the down-facing ones go umber — so the stone reads
 *      as volume even before the lighting touches it;
 *   3. the rock is BEDDED: its lower third is pushed under the ground plane so
 *      it emerges from the turf instead of resting on it.
 *
 * @returns {THREE.BufferGeometry} in local space, y = 0 at the ground line.
 */
export function boulderGeom(rng, radius, palette = [PALETTE.rock, PALETTE.stoneWarm, PALETTE.mud]) {
  // 320 faces on anything that fills more than a few pixels, 80 for a cobble,
  // 20 for a pebble. At subdivision 1 a 0.6 m boulder two metres from the lens
  // is 20 triangles across its silhouette and the band quantiser lands the
  // whole of it in two washes — which is the "flat polygon" the critique keeps
  // finding at close range.
  const g = new THREE.IcosahedronGeometry(radius, radius > 0.42 ? 2 : radius > 0.16 ? 1 : 0);
  // three octaves: broad lumps, facet break-up, then a chipped tooth
  wobble(g, radius * 0.30, 2.6 / Math.max(0.25, radius), (rng() * 997) | 0);
  wobble(g, radius * 0.11, 7.5 / Math.max(0.25, radius), (rng() * 997) | 0);
  if (radius > 0.42) wobble(g, radius * 0.045, 19.0 / Math.max(0.25, radius), (rng() * 997) | 0);
  // squat it and bed it: a boulder sits low and is half buried
  tx(g, {
    rx: rng() * TAU, ry: rng() * TAU, rz: rngRange(rng, -0.4, 0.4),
    sy: rngRange(rng, 0.58, 0.82),
  });
  g.computeVertexNormals();
  const base = new THREE.Color(palette[(rng() * palette.length) | 0]);
  const warm = new THREE.Color(PALETTE.stoneWarm);
  const dark = new THREE.Color(PALETTE.mud);
  const c = new THREE.Color();
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const ny = n.getY(i);
    c.copy(base);
    // sun-bleached, lichened top; damp umber underside
    c.lerp(warm, Math.max(0, ny) * 0.55);
    c.lerp(dark, Math.max(0, -ny) * 0.60);
    // per-face value jitter so no two planes match
    const v = 0.86 + valueNoise2(p.getX(i) * 9.1, p.getZ(i) * 9.1 + p.getY(i) * 5.3, 733) * 0.32;
    col[i * 3] = c.r * v; col[i * 3 + 1] = c.g * v; col[i * 3 + 2] = c.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // bed the lower third
  g.translate(0, radius * 0.30, 0);
  return g;
}

/** Czech hedgehog: three crossed girders bolted at the centre. */
export function buildHedgehog(rng) {
  const bins = newBins();
  const L = 1.55;
  const axes = [
    [1, 0.62, 0], [0, 0.62, 1], [0.72, -0.5, -0.72],
  ];
  // Each girder is a single full-length bar through the collar, so the three
  // of them cross at the centre and their ends splay out as legs and spikes.
  for (const a of axes) {
    const len = L * 2 * rngRange(rng, 0.92, 1.08);
    const v = new THREE.Vector3(a[0], a[1], a[2]).normalize();
    const g = box(0.11, len, 0.11, PALETTE.steel, { variation: 0.14 });
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
    g.applyQuaternion(q);
    g.translate(0, L * 0.55, 0);
    bins.metal.push(g);
  }
  const collar = cyl(0.14, 0.14, 0.2, 8, PALETTE.steelDark, { y: L * 0.55, variation: 0.1 });
  bins.metal.push(collar);
  const colliders = [{
    cx: 0, cy: 0.55, cz: 0, hx: 0.85, hy: 0.55, hz: 0.85, yaw: 0,
    // Open girder work: it will stop a round that hits a beam, but the volume
    // is mostly air, so it is not a bullet screen.
    opts: { cover: 0.5, solid: true, blocksLos: false, blocksProjectile: false, tag: 'hedgehog' },
  }];
  return { bins, colliders };
}

/** Concrete dragon's tooth. */
export function buildDragonTooth(rng) {
  const bins = newBins();
  const h = rngRange(rng, 0.85, 1.15);
  const g = loft([
    { c: { x: 0, y: 0, z: 0 }, r: 0.62, rot: Math.PI * 0.25 },
    { c: { x: 0, y: h * 0.55, z: 0 }, r: 0.44, rot: Math.PI * 0.25 },
    { c: { x: 0, y: h, z: 0 }, r: 0.22, rot: Math.PI * 0.25 },
  ], 4, false, true);
  setGeomColor(g, PALETTE.stone, 0.13, rng);
  bins.stone.push(g);
  return {
    bins,
    colliders: [{
      cx: 0, cy: h * 0.5, cz: 0, hx: 0.55, hy: h * 0.5, hz: 0.55, yaw: 0,
      opts: { cover: 0.7, solid: true, blocksLos: false, blocksProjectile: true, tag: 'tooth' },
    }],
  };
}

/** Stack of ammunition crates. */
export function buildCrateStack(rng) {
  const bins = newBins();
  const colliders = [];
  const n = 2 + Math.floor(rng() * 4);
  let y = 0;
  let maxW = 0;
  for (let i = 0; i < n; i++) {
    const w = rngRange(rng, 0.62, 0.92);
    const d = rngRange(rng, 0.42, 0.62);
    const h = rngRange(rng, 0.3, 0.44);
    const g = box(w, h, d, rng() < 0.35 ? PALETTE.olive : PALETTE.crate, { variation: 0.1 });
    tx(g, {
      x: rngRange(rng, -0.12, 0.12), y: y + h * 0.5, z: rngRange(rng, -0.1, 0.1),
      ry: rngRange(rng, -0.32, 0.32),
    });
    bins.wood.push(g);
    // strapping
    for (const s of [-1, 1]) {
      bins.metal.push(box(w * 1.02, 0.045, 0.05, PALETTE.steelDark,
        { y: y + h * 0.5, z: s * d * 0.5, variation: 0.1 }));
    }
    y += h;
    maxW = Math.max(maxW, w);
  }
  colliders.push({
    cx: 0, cy: y * 0.5, cz: 0, hx: maxW * 0.55, hy: y * 0.5, hz: 0.38, yaw: 0,
    opts: {
      cover: 0.7, solid: true, blocksLos: false, blocksProjectile: true,
      tag: 'crates', destructible: true, hp: 45,
    },
  });
  return { bins, colliders, height: y };
}

/** Oil drum. Shooting one is a bad idea for whoever is standing next to it. */
export function buildOilDrum(rng, tipped = false) {
  const bins = newBins();
  const r = 0.3, h = 0.88;
  const g = cyl(r, r, h, 12, rng() < 0.5 ? PALETTE.rust : PALETTE.olive, { variation: 0.13 });
  const ribA = cyl(r * 1.05, r * 1.05, 0.06, 12, PALETTE.steelDark, { y: h * 0.22, variation: 0.1 });
  const ribB = cyl(r * 1.05, r * 1.05, 0.06, 12, PALETTE.steelDark, { y: -h * 0.22, variation: 0.1 });
  const drum = mergeGeoms([g, ribA, ribB]);
  g.dispose(); ribA.dispose(); ribB.dispose();
  if (tipped) tx(drum, { rx: Math.PI * 0.5, y: r, rz: rngRange(rng, -0.4, 0.4) });
  else tx(drum, { y: h * 0.5, ry: rng() * TAU });
  bins.metal.push(drum);
  return {
    bins,
    colliders: [{
      cx: 0, cy: (tipped ? r : h * 0.5), cz: 0,
      hx: tipped ? h * 0.5 : r, hy: tipped ? r : h * 0.5, hz: r, yaw: 0,
      opts: {
        cover: 0.5, solid: true, blocksLos: false, blocksProjectile: true, tag: 'drum',
        destructible: true, hp: 20, explosive: true,
      },
    }],
  };
}

/** Wooden signpost at a junction. */
export function buildSignpost(rng, arms = 2) {
  const bins = newBins();
  const h = 2.3;
  bins.wood.push(box(0.13, h, 0.13, PALETTE.timberDark, { y: h * 0.5, variation: 0.1 }));
  for (let i = 0; i < arms; i++) {
    const y = h - 0.28 - i * 0.36;
    const dir = rng() < 0.5 ? 1 : -1;
    const g = box(1.05, 0.22, 0.05, PALETTE.plaster, { variation: 0.07 });
    g.translate(dir * 0.58, 0, 0);
    tx(g, { ry: rngRange(rng, -0.6, 0.6) });
    g.translate(0, y, 0);
    bins.wood.push(g);
  }
  return {
    bins,
    colliders: [{
      cx: 0, cy: h * 0.5, cz: 0, hx: 0.16, hy: h * 0.5, hz: 0.16, yaw: 0,
      opts: { cover: 0.15, solid: false, blocksLos: false, blocksProjectile: false, tag: 'sign' },
    }],
  };
}

/** Telegraph pole with a crossarm and insulators. */
export function buildTelegraphPole(rng) {
  const bins = newBins();
  const h = rngRange(rng, 6.4, 7.4);
  bins.wood.push(cyl(0.11, 0.16, h, 8, PALETTE.timberDark, { y: h * 0.5, variation: 0.09 }));
  bins.wood.push(box(1.5, 0.11, 0.11, PALETTE.timberDark, { y: h - 0.35, variation: 0.09 }));
  for (let i = 0; i < 4; i++) {
    const x = -0.6 + i * 0.4;
    bins.metal.push(cyl(0.055, 0.07, 0.16, 6, PALETTE.plaster, { x, y: h - 0.22, variation: 0.08 }));
  }
  return {
    bins, height: h,
    wireAnchors: [
      { x: -0.6, y: h - 0.16, z: 0 }, { x: -0.2, y: h - 0.16, z: 0 },
      { x: 0.2, y: h - 0.16, z: 0 }, { x: 0.6, y: h - 0.16, z: 0 },
    ],
    colliders: [{
      cx: 0, cy: h * 0.5, cz: 0, hx: 0.2, hy: h * 0.5, hz: 0.2, yaw: 0,
      // Creosoted timber: a rifle round does not go through it.
      opts: { cover: 0.3, solid: true, blocksLos: false, blocksProjectile: true, tag: 'pole' },
    }],
  };
}

/** Burnt-out supply lorry. */
export function buildWreckLorry(rng) {
  const bins = newBins();
  const L = 4.9, W = 2.0;
  // chassis + cab
  bins.metal.push(box(W, 0.28, L, PALETTE.steelDark, { y: 0.62, variation: 0.14 }));
  const cab = box(W * 0.95, 1.25, 1.6, PALETTE.olive, { y: 1.4, z: L * 0.5 - 0.95, variation: 0.16 });
  bins.metal.push(cab);
  bins.metal.push(box(W * 0.98, 0.22, 0.5, PALETTE.steelDark,
    { y: 0.75, z: L * 0.5 + 0.12, variation: 0.12 }));
  // load bed with hoops, tilt burned away
  bins.wood.push(box(W * 0.96, 0.7, L * 0.52, PALETTE.timber,
    { y: 1.1, z: -L * 0.18, variation: 0.16 }));
  for (let i = 0; i < 4; i++) {
    const z = -L * 0.42 + i * (L * 0.16);
    const hoop = loft([
      { c: { x: 0, y: 1.45, z }, r: W * 0.48, sz: 0.09 },
      { c: { x: 0, y: 1.9, z }, r: W * 0.44, sz: 0.09 },
    ], 5, false, false);
    setGeomColor(hoop, PALETTE.steelDark, 0.12, rng);
    bins.metal.push(hoop);
  }
  // wheels — one blown off and lying flat
  const wheelPos = [[-1, L * 0.34], [1, L * 0.34], [-1, -L * 0.28], [1, -L * 0.28]];
  for (let i = 0; i < wheelPos.length; i++) {
    const [s, z] = wheelPos[i];
    if (i === 1) {
      bins.metal.push(cyl(0.52, 0.52, 0.32, 12, PALETTE.steelDark,
        { x: s * (W * 0.5 + 1.5), y: 0.16, z: z - 1.2, variation: 0.14 }));
      continue;
    }
    bins.metal.push(cyl(0.52, 0.52, 0.32, 12, PALETTE.darkest,
      { x: s * (W * 0.5 - 0.08), y: 0.52, z, rz: Math.PI * 0.5, variation: 0.16 }));
  }
  // Three shell holes punched through the whole assembly, plus fire damage.
  const holes = [];
  for (let i = 0; i < 3; i++) {
    holes.push({
      x: rngRange(rng, -W * 0.45, W * 0.45),
      y: rngRange(rng, 0.7, 1.8),
      z: rngRange(rng, -L * 0.35, L * 0.35),
      r: rngRange(rng, 0.38, 0.62),
    });
  }
  for (const k of BINS) {
    for (let i = 0; i < bins[k].length; i++) {
      const g = bins[k][i];
      const c = carveGeometry(g, (x, y, z) => {
        const n = valueNoise2(x * 2.2 + y, z * 2.2 - y, 431);
        for (const h of holes) {
          if (Math.hypot(x - h.x, y - h.y, z - h.z) < h.r * (0.7 + n * 0.7)) return false;
        }
        return true;
      });
      g.dispose();
      scorch(c, 0, 1.2, 0, 4.0, 0.62);
      bins[k][i] = c;
    }
  }
  return {
    bins,
    colliders: [{
      cx: 0, cy: 0.95, cz: 0, hx: W * 0.5 + 0.1, hy: 0.95, hz: L * 0.5, yaw: 0,
      opts: { cover: 1, solid: true, blocksLos: true, tag: 'wreck' },
    }],
  };
}

/** Knocked-out light tank: hull on the ground, turret blown off beside it. */
export function buildWreckTank(rng) {
  const bins = newBins();
  const L = 4.6, W = 2.5, H = 0.95;
  // sloped hull
  bins.metal.push(box(W, H, L * 0.78, PALETTE.olive, { y: 0.78, variation: 0.15 }));
  bins.metal.push(box(W * 0.98, 0.62, 1.2, PALETTE.olive,
    { y: 1.02, z: L * 0.34, rx: -0.5, variation: 0.15 }));
  bins.metal.push(box(W * 0.98, 0.55, 1.0, PALETTE.olive,
    { y: 1.0, z: -L * 0.34, rx: 0.42, variation: 0.15 }));
  // running gear
  for (const s of [-1, 1]) {
    bins.metal.push(box(0.42, 0.62, L * 0.9, PALETTE.darkest,
      { x: s * (W * 0.5 + 0.12), y: 0.45, z: 0, variation: 0.14 }));
    for (let i = 0; i < 5; i++) {
      bins.metal.push(cyl(0.31, 0.31, 0.26, 10, PALETTE.steelDark, {
        x: s * (W * 0.5 + 0.12), y: 0.36, z: -L * 0.36 + i * (L * 0.18),
        rz: Math.PI * 0.5, variation: 0.12,
      }));
    }
    // a track thrown and lying in a loop on the ground
    if (s === -1) {
      const link = box(0.4, 0.09, 0.34, PALETTE.darkest, { variation: 0.16 });
      const parts = [];
      for (let i = 0; i < 12; i++) {
        const t = i / 12;
        const g = link.clone();
        tx(g, {
          x: -W * 0.5 - 1.2 - Math.sin(t * Math.PI) * 0.9,
          y: 0.06,
          z: -L * 0.4 + t * L * 0.95,
          ry: t * 1.2,
        });
        parts.push(g);
      }
      link.dispose();
      bins.metal.push(mergeGeoms(parts));
      for (const p of parts) p.dispose();
    }
  }
  // turret, upside down in the mud a few metres away
  const turret = loft([
    { c: { x: 0, y: 0, z: 0 }, r: 1.05, rot: 0.3 },
    { c: { x: 0, y: 0.55, z: 0 }, r: 0.92, rot: 0.3 },
    { c: { x: 0, y: 0.75, z: 0 }, r: 0.72, rot: 0.3 },
  ], 7, true, true);
  setGeomColor(turret, PALETTE.olive, 0.14, rng);
  const barrel = cyl(0.11, 0.13, 2.2, 8, PALETTE.steelDark, { y: 0.42, z: 1.4, rx: Math.PI * 0.5, variation: 0.1 });
  const tg = mergeGeoms([turret, barrel]);
  turret.dispose(); barrel.dispose();
  tx(tg, { rz: Math.PI * 0.86, x: -3.1, y: 0.9, z: rngRange(rng, -1.5, 1.5), ry: rngRange(rng, 0, TAU) });
  bins.metal.push(tg);

  for (const k of BINS) {
    for (let i = 0; i < bins[k].length; i++) scorch(bins[k][i], 0, 1.0, 0, 5.0, 0.55);
  }
  return {
    bins,
    colliders: [
      {
        cx: 0, cy: 0.75, cz: 0, hx: W * 0.5 + 0.5, hy: 0.75, hz: L * 0.5, yaw: 0,
        opts: { cover: 1, solid: true, blocksLos: true, tag: 'wreck' },
      },
      {
        cx: -3.1, cy: 0.55, cz: 0, hx: 1.1, hy: 0.55, hz: 1.1, yaw: 0,
        opts: { cover: 1, solid: true, blocksLos: true, tag: 'wreck' },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Props — assembly
// ---------------------------------------------------------------------------

export class Props {
  constructor(parent, terrain, layout, opts = {}) {
    this.terrain = terrain;
    this.layout = layout;
    this.seed = opts.seed ?? CFG.seed;
    this.rng = makeRng(this.seed ^ 0xdead);
    this.colliders = [];
    this.footprints = [];
    this.destructibles = [];       // { mesh, colliders, hp, kind, sunk, pos }
    this._cookoff = [];            // queued drum detonations, flushed in update()
    this.occupiedTest = opts.occupied || (() => false);

    this.group = new THREE.Group();
    this.group.name = 'props';
    parent.add(this.group);

    this.bins = newBins();
    this._materials();
    this._buildEmplacements();
    this._buildObstacles();
    this._buildCrossingCover();
    this._buildWire();
    this._buildTelegraph();
    this._buildCraterDebris();
    this._buildStones();
    this._buildRoadside();
    this._buildWrecks();
    this._commit();
  }

  _materials() {
    this.mats = {
      sandbag: makeSurfaceMaterial({ color: 0xffffff, vertexColors: true, map: burlapTexture(53), rim: 0.4 }),
      wood: makeSurfaceMaterial({ color: 0xffffff, vertexColors: true, map: woodTexture(41), rim: 0.45 }),
      metal: makeSurfaceMaterial({ color: 0xffffff, vertexColors: true, rim: 0.9, roughness: 0.55 }),
      stone: makeSurfaceMaterial({ color: 0xffffff, vertexColors: true, map: stoneTexture(31), rim: 0.4 }),
    };
    this.uvScale = { sandbag: 1.4, wood: 0.9, metal: 0.6, stone: 0.5 };
    // makeSurfaceMaterial() cannot forward band-quantiser options, so reach into
    // the uniforms. Three washes with a bled edge and the detail map driving the
    // BAND rather than multiplying the albedo is the difference between a rock
    // that has a terminator on it and a rock that is a flat polygon with a
    // texture printed on it.
    for (const k of BINS) {
      const u = this.mats[k] && this.mats[k].uniforms;
      if (!u) continue;
      if (u.uBands) u.uBands.value = 3;
      if (u.uBandBleed) u.uBandBleed.value = 0.14;
      if (u.uMapDrive) u.uMapDrive.value = k === 'metal' ? 0.10 : 0.26;
      if (u.uMapFlat) u.uMapFlat.value = 0.70;
      if (u.uLightContrast) u.uLightContrast.value = 1.22;
      if (u.uShadeCool) u.uShadeCool.value = k === 'wood' ? 0.66 : 0.85;
      if (u.uWetPx) u.uWetPx.value = 11;
    }
    this.wireMat = makeSurfaceMaterial({
      color: 0xffffff, vertexColors: true, map: barbedWireTexture(83),
      alphaTest: 0.35, side: THREE.DoubleSide, rim: 0.9,
    });
  }

  /**
   * Average ground level over a wall footprint and how uneven it is.
   * Cover is measured against the ground the DEFENDER stands on, so the level
   * is taken from a strip just behind the parapet, not from its centre.
   */
  _levelBehind(x, z, yaw, len) {
    const co = Math.cos(yaw), si = Math.sin(yaw);
    let sum = 0, n = 0, lo = Infinity, hi = -Infinity;
    for (let i = -2; i <= 2; i++) {
      const lx = (i / 2) * len * 0.5;
      for (const lz of [-1.1, -0.2]) {
        const wx = x + lx * co + lz * si;
        const wz = z - lx * si + lz * co;
        const h = this.terrain.heightAt(wx, wz);
        sum += h; n++;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    return { y: sum / n, spread: hi - lo };
  }

  /** Ground a local-space build at (x,z,yaw) and file its geometry + colliders. */
  _place(built, x, z, yaw, into = this.bins, colliderSink = this.colliders, yOverride = null) {
    const y = yOverride !== null ? yOverride : this.terrain.heightAt(x, z);
    const co = Math.cos(yaw), si = Math.sin(yaw);
    for (const k of BINS) {
      for (const g of built.bins[k]) {
        tx(g, { ry: yaw });
        g.translate(x, y, z);
        into[k].push(g);
      }
    }
    for (const c of built.colliders || []) {
      const wx = x + c.cx * co + c.cz * si;
      const wz = z - c.cx * si + c.cz * co;
      colliderSink.push(makeBox(
        { x: wx, y: y + c.cy, z: wz }, { x: c.hx, y: c.hy, z: c.hz },
        yaw + (c.yaw || 0), c.opts
      ));
    }
    return y;
  }

  /** Free-standing destructible: own mesh, own collider set. */
  _placeDestructible(built, x, z, yaw, kind, hp, yOverride = null) {
    const bins = newBins();
    const cols = [];
    const groundY = this._place(built, x, z, yaw, bins, cols, yOverride);
    const geoms = [];
    for (const k of BINS) for (const g of bins[k]) geoms.push({ k, g });
    if (!geoms.length) return null;
    // A destructible is one mesh; pick the dominant material bin for it.
    const counts = {};
    for (const { k } of geoms) counts[k] = (counts[k] || 0) + 1;
    let domK = BINS[0], best = -1;
    for (const k of Object.keys(counts)) if (counts[k] > best) { best = counts[k]; domK = k; }
    const merged = mergeGeoms(geoms.map((e) => e.g));
    worldUV(merged, this.uvScale[domK]);
    for (const { g } of geoms) g.dispose();
    const mesh = new THREE.Mesh(merged, this.mats[domK]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.outline = true;
    mesh.name = `prop:${kind}`;
    this.group.add(mesh);
    // The geometry is baked in world space, so mesh.position stays at the
    // origin and is NOT where the prop is. Anything that needs a world position
    // for this prop (the drum cook-off blast, its sfx) must use `rec.pos`.
    const rec = {
      mesh, colliders: cols, hp, maxHp: hp, kind, sunk: 0,
      origin: mesh.position.clone(),
      pos: new THREE.Vector3(x, groundY + 0.5, z),
      /** Called by the collider's `destroyed` setter — see world/collider.js. */
      onColliderDestroyed: (c, dead) => this._onColliderDestroyed(rec, dead),
    };
    for (const c of cols) { c.owner = rec; this.colliders.push(c); }
    this.destructibles.push(rec);
    this.footprints.push({ x, z, r: 2.2 });
    return rec;
  }

  /**
   * A prop's collider flipped `destroyed`. Keeps the visual in step with the
   * collision state in ONE place, in both directions — an engineer rebuilding
   * cover clears the flag and the mesh has to come back with it.
   */
  _onColliderDestroyed(rec, dead) {
    if (dead) {
      if (rec.hp > 0) rec.hp = 0;
      if (rec.kind !== 'sandbag') rec.mesh.visible = false;
      return;
    }
    rec.hp = rec.maxHp;
    rec.sunk = 0;
    rec.mesh.visible = true;
    rec.mesh.position.copy(rec.origin);
    rec.mesh.updateMatrix();
  }

  // -----------------------------------------------------------------------

  /**
   * THE CROSSING LANE — the one strip of ground this mission cannot afford to
   * garnish, and the one it was garnishing hardest.
   *
   * MEASURED, live, before this guard existed: the nav grid north of the bridge
   * exit had a SINGLE 1.5 m walkable cell at (5, -15), and it was walled again
   * 2 m further on. Four different soldiers wedged at the identical coordinate
   * (7.6, -11.4) and paid for it — 450 AP bought 10.1 m, 287 AP bought 10.4 m,
   * 131 AP bought 2.4 m, against a clean 20 AP/m on open ground — because
   * `moveWithCollision` charges the metres a man SLIDES along an obstacle, not
   * the metres he gains. The Edelweiss returned 0.0 m for four consecutive
   * sorties. None of that was authored: seven chevaux-de-frise, two sandbag
   * revetments, a crate stack, an oil drum and a burnt-out lorry were each
   * placed relative to the bridge, the bridge got 7.5 m shorter when the span
   * layout became adaptive, and the whole belt slid onto the road.
   *
   * So the lane is now defended by a PREDICATE rather than by arithmetic that
   * has to stay in sync: nothing scattered may sit within `clear` metres of the
   * road centreline between the south approach and the ruins. Cover on that
   * lane is authored by hand in `_buildCrossingCover()`, where the gaps can be
   * checked. If you add a new scatter pass to this module, filter it through
   * here.
   */
  _onCrossingLane(x, z, clear = 5.0) {
    // The ford's approach corridor counts as the crossing too: a wire belt laid
    // across the north bank there would quietly delete the second route.
    const f = this.layout.ford;
    if (f && Math.abs(x - f.x) < clear + 1.5 && z > f.z - 15 && z < f.z + 11) return true;
    if (z > 27 || z < -30) return false;
    return this.layout.roadSDF(x, z).d < clear;
  }

  /** The road centreline and its normal at the polyline sample nearest to `z`. */
  _roadAtZ(zWant) {
    const r = this.layout.road;
    let bi = 1, best = Infinity;
    for (let i = 1; i < r.n - 1; i++) {
      const d = Math.abs(r.z[i] - zWant);
      if (d < best) { best = d; bi = i; }
    }
    let fx = r.x[bi + 1] - r.x[bi - 1], fz = r.z[bi + 1] - r.z[bi - 1];
    const l = Math.hypot(fx, fz) || 1;
    fx /= l; fz /= l;
    // The road runs south -> north, i.e. toward -Z. Force the tangent that way
    // so "forward" is always toward the objective.
    if (fz > 0) { fx = -fx; fz = -fz; }
    return { x: r.x[bi], z: r.z[bi], fx, fz, nx: -fz, nz: fx };
  }

  /**
   * BOUNDING COVER ON THE CROSSING.
   *
   * A crossing under fire is a great game only if there is something to get
   * behind. This mission had nothing: 26 m of open masonry deck, then 12 m of
   * open abutment, with a dug-in Sturmtruppe 14 m off the exit. Both
   * playtesters lost four of six soldiers ON THE DECK, during their own turn,
   * mid-run — 62 HP buys about 15 seconds of interception and the deck takes
   * longer than that. There was no decision in it: you ran and you died.
   *
   * Nine pieces, hand-placed, every 7-9 m along the route, which is one third
   * of a scout's sortie — so every leg of the crossing is a bound from cover to
   * cover that a player can afford. All of it is sandbag or crate: `cover 1`
   * but `blocksLos:false`, so you can shoot back over the parapet. That is the
   * only kind of cover worth having.
   *
   * THE CLEAR LANE IS THE DESIGN. All three deck pieces are 1.8 m of a 7.3 m
   * carriageway and all three are bedded against the SAME (west) parapet, which
   * leaves one unobstructed 5.4 m lane up the east half of the span from end to
   * end. Hold W and you cross without touching anything, including in the
   * Edelweiss (1.6 m collision radius, 3.2 m of hull). Want cover, step left.
   *
   * IT TOOK FOUR GOES AND EVERY FAILURE WAS MEASURED IN A LIVE SORTIE:
   *   2.9 m walls        -> a 2.9 m slot to the parapet, one nav cell wide: the
   *                         same death funnel this mission already had, rebuilt
   *                         by hand.
   *   2.2 m, alternating -> the scout crossed the span cleanly at 19-21 AP/m and
   *                         then burned 564 AP and DIED grinding past the third
   *                         wall on her way to the abutment.
   *   1.8 m, alternating -> identical, to the metre. Staggering the walls forces
   *                         a diagonal across the carriageway at exactly the
   *                         point the far bank is shooting at you.
   * Cover you can wedge on is worse than no cover: it charges AP at the rate of
   * a sprint and returns no ground. Do not lengthen these, do not move them
   * toward the crown, and do not re-stagger them, without re-running a sortie
   * and reading the AP-per-metre.
   */
  _buildCrossingCover() {
    const rng = this.rng;
    const b = this.layout.bridge;
    const deckY = b.deckY + 0.07;                      // platform top, see structures
    // lat > 0 is west across the carriageway, along > 0 is north toward the ruins
    const deckPos = (lat, along) => ({
      x: b.x + lat * Math.cos(b.yaw) + along * Math.sin(b.yaw),
      z: b.z - lat * Math.sin(b.yaw) + along * Math.cos(b.yaw),
    });
    // yaw + PI puts the parapet's battered face toward the north bank, because
    // that is where the fire comes from.
    const deckYaw = b.yaw + Math.PI;
    const halfLen = b.length * 0.5;
    for (const [lat, along] of [[2.75, -halfLen + 5.0], [2.75, -1.0], [2.75, halfLen - 4.5]]) {
      const p = deckPos(lat, along);
      const built = buildSandbagWall(rng, 1.8, 4, 0.16);
      this._placeDestructible(built, p.x, p.z, deckYaw, 'sandbag', 480, deckY);
    }

    // --- the abutment lodgement and the ruins approach.
    // Off the centreline by 3.4 m: close enough to reach from the lane in one
    // step, far enough that nobody running the lane ever touches it.
    const beats = [
      { z: -12.5, lat: 3.4, kind: 'sandbag', len: 3.2 },
      { z: -16.0, lat: -3.4, kind: 'crates' },
      { z: -21.5, lat: 3.6, kind: 'sandbag', len: 3.4 },
      { z: -27.0, lat: -3.6, kind: 'sandbag', len: 3.2 },
      { z: -33.0, lat: 3.6, kind: 'crates' },
      { z: -38.0, lat: -3.4, kind: 'sandbag', len: 3.2 },
    ];
    for (const s of beats) {
      const r = this._roadAtZ(s.z);
      const x = r.x + r.nx * s.lat, z = r.z + r.nz * s.lat;
      if (!this.terrain.inBounds(x, z)) continue;
      if (this.terrain.heightAt(x, z) < WATER_Y + 0.5) continue;
      // Facing the objective: local -Z is the parapet's front, so aim it up the
      // road. (`_place` maps local +Z to (sin yaw, cos yaw).)
      const yaw = Math.atan2(-r.fx, -r.fz);
      if (s.kind === 'crates') {
        this._placeDestructible(buildCrateStack(rng), x, z, yaw + rngRange(rng, -0.3, 0.3), 'crates', 45);
        continue;
      }
      const lvl = this._levelBehind(x, z, yaw, s.len);
      this._placeDestructible(buildSandbagWall(rng, s.len, 4, rngRange(rng, 0.12, 0.24)),
        x, z, yaw, 'sandbag', 480, lvl.y);
    }
  }

  /** Where a defender would actually dig in: bridgeheads, the village edge. */
  _buildEmplacements() {
    const rng = this.rng;
    const b = this.layout.bridge;
    const specs = [];

    // The SOUTH bridgehead only — the firing line the player starts behind, on
    // his own bank, where a marksman lying up can reach the far abutment at
    // 40 m. The NORTH bridgehead pair used to be built here too, and that is
    // where the mission went wrong: two parapets, two crate stacks and two oil
    // drums landed 5-7 m off the deck exit, on the road, in the one place the
    // player has to be. The far bank's defences are now dug in on the RUINS
    // LINE below, 10-14 m further back, which leaves a lodgement at the
    // abutment worth fighting for instead of a wall to die against.
    {
      const dx = Math.sin(b.yaw) * -(b.length * 0.5 + 5.5);
      const dz = Math.cos(b.yaw) * -(b.length * 0.5 + 5.5);
      for (const lateral of [-1, 1]) {
        specs.push({
          x: b.x + dx + Math.cos(b.yaw) * lateral * 5.5,
          z: b.z + dz - Math.sin(b.yaw) * lateral * 5.5,
          yaw: b.yaw,
          len: rngRange(rng, 3.4, 5.2),
          courses: 4,
        });
      }
    }
    // The ruins line: the far bank's actual defence, dug in where the garrison
    // now stands (see mission.js `enemies`) so that a player LOOKING at the
    // crossing can see where the danger is before he commits to it. Sandbags at
    // the mouth of a street read as "someone is in that street".
    for (const [ex, ez] of [[3.0, -19.5], [14.2, -20.5], [6.5, -25.0]]) {
      const r = this._roadAtZ(ez);
      specs.push({
        x: ex, z: ez + 1.1,
        yaw: Math.atan2(r.fx, r.fz),         // facing back down the road, at the bridge
        len: rngRange(rng, 3.6, 4.8), courses: 4,
        // Hand-placed to match a garrison position, so it is not allowed to be
        // silently dropped by the scatter guards: two of these three vanished
        // into `occupiedTest` on the first cut and the ruins line stopped
        // reading as a defended line.
        authored: true,
      });
    }
    // the northern camp perimeter, facing the road
    const V = this.layout.village;
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.45;
      const r = V.r * 0.82;
      specs.push({
        x: V.x + Math.cos(a) * r, z: V.z + Math.sin(a) * r,
        yaw: a + Math.PI * 0.5,
        len: rngRange(rng, 3.0, 4.6), courses: rng() < 0.4 ? 5 : 4,
      });
    }
    // a forward post on the southern ridge
    specs.push({ x: -26, z: 46, yaw: Math.PI * 0.92, len: 4.6, courses: 4 });
    specs.push({ x: 12, z: 40, yaw: Math.PI * 1.05, len: 3.8, courses: 4 });

    for (const s of specs) {
      if (!this.terrain.inBounds(s.x, s.z)) continue;
      if (this.terrain.heightAt(s.x, s.z) < WATER_Y + 0.5) continue;
      if (!s.authored && this.occupiedTest(s.x, s.z)) continue;
      // Troops dig in on ground they can actually revet: reject anything the
      // parapet would either float over or bury itself in.
      const lvl = this._levelBehind(s.x, s.z, s.yaw, s.len);
      if (!s.authored && lvl.spread > 0.85) continue;
      if (!s.authored && this.terrain.slopeAt(s.x, s.z) > 0.42) continue;
      const built = buildSandbagWall(rng, s.len, s.courses, rngRange(rng, 0.10, 0.26));
      this._placeDestructible(built, s.x, s.z, s.yaw, 'sandbag', 120 * s.courses, lvl.y);

      // supplies behind the parapet
      const bx = s.x - Math.sin(s.yaw) * 1.5;
      const bz = s.z - Math.cos(s.yaw) * 1.5;
      if (rng() < 0.75) {
        this._placeDestructible(buildCrateStack(rng), bx, bz, rng() * TAU, 'crates', 45);
      }
      if (rng() < 0.5) {
        this._placeDestructible(
          buildOilDrum(rng, rng() < 0.3),
          bx + rngRange(rng, -1.4, 1.4), bz + rngRange(rng, -1.4, 1.4), rng() * TAU, 'drum', 20
        );
      }
    }
  }

  _buildObstacles() {
    const rng = this.rng;
    const b = this.layout.bridge;
    // Chevaux-de-frise FLANKING the bridge exit, never across it. Six of these
    // used to be scattered at +-4.6 m of the bridge axis and they sealed the
    // north abutment into a single 1.5 m nav cell — see `_onCrossingLane`. They
    // are worth keeping, because a bridge nobody bothered to block reads as a
    // bridge nobody was defending; they just have to be beside the road, where
    // they narrow the approach instead of plugging it.
    for (let i = 0; i < 8; i++) {
      const t = rngRange(rng, 0.3, 2.4);
      const side = i % 2 ? 1 : -1;
      const lat = side * rngRange(rng, 5.6, 10.5);
      const x = b.x + Math.sin(b.yaw) * (b.length * 0.5 + 2.5 + t * 4) + Math.cos(b.yaw) * lat;
      const z = b.z + Math.cos(b.yaw) * (b.length * 0.5 + 2.5 + t * 4) - Math.sin(b.yaw) * lat;
      if (!this.terrain.inBounds(x, z)) continue;
      if (this.terrain.heightAt(x, z) < WATER_Y + 0.3) continue;
      if (this._onCrossingLane(x, z)) continue;
      this._place(buildHedgehog(rng), x, z, rng() * TAU);
      this.footprints.push({ x, z, r: 1.6 });
    }
    // a line of dragon's teeth across the northern lane
    const V = this.layout.village;
    for (let i = 0; i < 9; i++) {
      const a = -1.35 + i * 0.11;
      const r = V.r * 1.02;
      const x = V.x + Math.cos(a) * r, z = V.z + Math.sin(a) * r;
      if (!this.terrain.inBounds(x, z)) continue;
      if (this.terrain.slopeAt(x, z) > 0.45) continue;
      if (this.occupiedTest(x, z)) continue;
      if (this._onCrossingLane(x, z)) continue;
      this._place(buildDragonTooth(rng), x, z, rng() * TAU);
      this.footprints.push({ x, z, r: 1.2 });
    }
    // signposts at the crossing
    for (const s of [-1, 1]) {
      const x = b.x + Math.sin(b.yaw) * s * (b.length * 0.5 + 3.0) + Math.cos(b.yaw) * 4.2;
      const z = b.z + Math.cos(b.yaw) * s * (b.length * 0.5 + 3.0) - Math.sin(b.yaw) * 4.2;
      if (!this.terrain.inBounds(x, z)) continue;
      this._place(buildSignpost(rng, 2), x, z, rng() * TAU);
    }
  }

  /**
   * Barbed wire: pickets every ~2.4 m with three strands strung between them.
   * The strands are textured strips rather than geometry — a real double-apron
   * fence is thousands of triangles and reads worse at this camera distance.
   */
  _buildWire() {
    const rng = this.rng;
    const V = this.layout.village;
    const runs = [];
    // perimeter arc around the northern camp
    {
      const pts = [];
      for (let i = 0; i <= 22; i++) {
        const a = -1.75 + (i / 22) * 2.5;
        const r = V.r * 1.12 + (valueNoise2(i * 0.4, 3, 21) - 0.5) * 2.2;
        pts.push({ x: V.x + Math.cos(a) * r, z: V.z + Math.sin(a) * r });
      }
      runs.push(pts);
    }
    // a belt along the north bank of the river, either side of the bridge
    {
      const riv = this.layout.river;
      for (const side of [0, 1]) {
        const pts = [];
        for (let i = 6 + side * 26; i < 6 + side * 26 + 20 && i < riv.n - 2; i += 2) {
          const t = riv.cum[i] / riv.length;
          let tx0 = riv.x[i + 1] - riv.x[i - 1], tz0 = riv.z[i + 1] - riv.z[i - 1];
          const tl = Math.hypot(tx0, tz0) || 1;
          const nx = -tz0 / tl, nz = tx0 / tl;
          const off = -(this.layout.riverHalfWidth(t) + rngRange(rng, 5.5, 8.5));
          pts.push({ x: riv.x[i] + nx * off, z: riv.z[i] + nz * off });
        }
        if (pts.length > 2) runs.push(pts);
      }
    }

    const strips = [];
    for (const pts of runs) {
      let prev = null;
      for (const p of pts) {
        if (!this.terrain.inBounds(p.x, p.z) ||
          this.terrain.heightAt(p.x, p.z) < WATER_Y + 0.4 ||
          this._onCrossingLane(p.x, p.z, 7.0) ||
          this.occupiedTest(p.x, p.z)) { prev = null; continue; }
        const y = this.terrain.heightAt(p.x, p.z);
        // picket: an angle iron leaning slightly, with a corkscrew foot
        this.bins.metal.push(box(0.07, 1.05, 0.07, PALETTE.steelDark, {
          x: p.x, y: y + 0.5, z: p.z,
          rx: rngRange(rng, -0.09, 0.09), rz: rngRange(rng, -0.09, 0.09), variation: 0.12,
        }));
        if (prev) {
          const seg = Math.hypot(p.x - prev.x, p.z - prev.z);
          if (seg < 6) {
            for (let s = 0; s < 3; s++) {
              const hy = 0.28 + s * 0.31;
              const sag = 0.06 + s * 0.02;
              strips.push(this._wireStrip(prev, p, hy, sag, seg));
            }
            this.colliders.push(makeBox(
              { x: (p.x + prev.x) * 0.5, y: (y + prev.y) * 0.5 + 0.5, z: (p.z + prev.z) * 0.5 },
              { x: seg * 0.5, y: 0.5, z: 0.28 },
              Math.atan2(p.z - prev.z, p.x - prev.x),
              // Wire entangles bodies and stops nothing else: three strands of
              // 3 mm steel are not cover, they are a delay.
              {
                cover: 0.25, conceal: 0, solid: true, blocksLos: false, blocksProjectile: false,
                tag: 'wire', destructible: true, hp: 30,
              }
            ));
          }
        }
        prev = { x: p.x, z: p.z, y };
      }
    }
    if (strips.length) {
      const g = mergeGeoms(strips);
      for (const s of strips) s.dispose();
      const m = new THREE.Mesh(g, this.wireMat);
      m.name = 'barbed-wire';
      m.castShadow = false;
      m.receiveShadow = false;
      m.userData.outline = false;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.wireMesh = m;
    }
  }

  /** One sagging strand as a vertical quad strip with the barb texture on it. */
  _wireStrip(a, b, height, sag, len) {
    const segs = 6;
    const pos = [], uv = [], col = [], nrm = [];
    const push = (x, y, z, u, v) => {
      pos.push(x, y, z); uv.push(u, v); col.push(1, 1, 1); nrm.push(0, 1, 0);
    };
    const yA = this.terrain.heightAt(a.x, a.z) + height;
    const yB = this.terrain.heightAt(b.x, b.z) + height;
    const H = 0.13;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const p0 = { x: lerp(a.x, b.x, t0), z: lerp(a.z, b.z, t0), y: lerp(yA, yB, t0) - Math.sin(t0 * Math.PI) * sag };
      const p1 = { x: lerp(a.x, b.x, t1), z: lerp(a.z, b.z, t1), y: lerp(yA, yB, t1) - Math.sin(t1 * Math.PI) * sag };
      const u0 = t0 * len * 0.6, u1 = t1 * len * 0.6;
      push(p0.x, p0.y - H, p0.z, u0, 0); push(p1.x, p1.y - H, p1.z, u1, 0); push(p1.x, p1.y + H, p1.z, u1, 1);
      push(p0.x, p0.y - H, p0.z, u0, 0); push(p1.x, p1.y + H, p1.z, u1, 1); push(p0.x, p0.y + H, p0.z, u0, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    return g;
  }

  /** Poles down the road with catenary wires strung between them. */
  _buildTelegraph() {
    const rng = this.rng;
    const road = this.layout.road;
    let prev = null;
    for (let i = 3; i < road.n - 3; i += 7) {
      const t = road.cum[i] / road.length;
      let tx0 = road.x[i + 1] - road.x[i - 1], tz0 = road.z[i + 1] - road.z[i - 1];
      const tl = Math.hypot(tx0, tz0) || 1;
      const nx = -tz0 / tl, nz = tx0 / tl;
      const off = this.layout.roadHalfWidth(t) + 2.4;
      const x = road.x[i] + nx * off, z = road.z[i] + nz * off;
      if (!this.terrain.inBounds(x, z) || this.terrain.heightAt(x, z) < WATER_Y + 0.6) { prev = null; continue; }
      if (this.occupiedTest(x, z)) { prev = null; continue; }
      const yaw = Math.atan2(tx0, tz0) + Math.PI * 0.5;
      const built = buildTelegraphPole(rng);
      const y = this._place(built, x, z, yaw);
      const co = Math.cos(yaw), si = Math.sin(yaw);
      const anchors = built.wireAnchors.map((p) => ({
        x: x + p.x * co + p.z * si, y: y + p.y, z: z - p.x * si + p.z * co,
      }));
      if (prev) {
        const span = Math.hypot(anchors[0].x - prev[0].x, anchors[0].z - prev[0].z);
        if (span < 45) {
          for (let w = 0; w < anchors.length; w++) {
            const g = catenaryGeom(prev[w], anchors[w], span * 0.055, 12, 0.032);
            setGeomColor(g, PALETTE.steelDark, 0.06);
            this.bins.metal.push(g);
          }
        }
      }
      prev = anchors;
      this.footprints.push({ x, z, r: 1.4 });
    }
  }

  /** Ejecta and splinters around every shell crater. */
  _buildCraterDebris() {
    const rng = this.rng;
    for (const c of this.layout.craters) {
      const n = 10 + Math.floor(rng() * 12);
      const parts = [];
      for (let i = 0; i < n; i++) {
        const a = rng() * TAU;
        const r = c.r * rngRange(rng, 0.85, 1.7);
        const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
        if (!this.terrain.inBounds(x, z)) continue;
        const y = this.terrain.heightAt(x, z);
        const s = rngRange(rng, 0.11, 0.34);
        // Ejecta is turned earth and broken stone, NOT charcoal: PALETTE.darkest
        // on a flat-shaded 20-face solid is exactly the "flat black pentagon"
        // the closeup critique picked out.
        const g = boulderGeom(rng, s, [PALETTE.dirtDark, PALETTE.mud, PALETTE.rock, PALETTE.stoneWarm]);
        tx(g, { x, y: y - s * 0.12, z, ry: rng() * TAU });
        parts.push(g);
      }
      // splintered timber thrown clear
      if (rng() < 0.55) {
        const a = rng() * TAU;
        const x = c.x + Math.cos(a) * c.r * 1.3, z = c.z + Math.sin(a) * c.r * 1.3;
        if (this.terrain.inBounds(x, z)) {
          const y = this.terrain.heightAt(x, z);
          const g = box(0.11, 0.09, rngRange(rng, 0.9, 2.1), PALETTE.timberDark, {
            x, y: y + 0.06, z, ry: rng() * TAU, rx: rngRange(rng, -0.2, 0.2), variation: 0.16,
          });
          parts.push(g);
        }
      }
      if (parts.length) {
        const g = mergeGeoms(parts);
        for (const p of parts) p.dispose();
        this.bins.stone.push(g);
      }
    }
  }

  /**
   * Field stone. Three populations, all placed against terrain facts so they
   * land where a geologist would put them rather than sprinkled at random:
   *
   *   outcrop  — on the steep faces, where the terrain splat already paints
   *              rock, in tight groups so the ridge reads as broken ground;
   *   shingle  — cobbles and pebbles along the waterline, which is the ONE
   *              place a river valley reliably has loose stone;
   *   clearance— the stones a farmer pulled out of a field and dumped at the
   *              hedge line, in small cairns.
   *
   * This is also what gives the near ground something to look at: the round-1
   * critique's "flat fills" note is as much about a total absence of 20-50 cm
   * incident as it is about the terrain shader.
   */
  _buildStones() {
    const rng = makeRng(this.seed ^ 0x5704);
    const T = this.terrain;
    const half = T.size * 0.5 - 4;
    const sp = [0, 0, 0, 0];
    const parts = [];
    const place = (x, z, radius, pal, sink = 0) => {
      if (!T.inBounds(x, z)) return false;
      if (this.occupiedTest(x, z)) return false;
      const g = boulderGeom(rng, radius, pal);
      tx(g, { x, y: T.heightAt(x, z) - radius * sink, z, ry: rng() * TAU });
      parts.push(g);
      return true;
    };

    // --- outcrops on the rocky slopes
    let placed = 0;
    for (let i = 0; i < 5200 && placed < 190; i++) {
      const x = rngRange(rng, -half, half), z = rngRange(rng, -half, half);
      T.splatAt(x, z, sp);
      const rocky = sp[2];
      if (rocky < 0.24) continue;
      if (rng() > rocky * 1.25) continue;
      if (T.heightAt(x, z) < WATER_Y + 0.35) continue;
      // a knot of two to five stones, so they group like an outcrop
      const n = 2 + ((rng() * 4) | 0);
      for (let k = 0; k < n; k++) {
        const a = rng() * TAU, rr = Math.sqrt(rng()) * 1.5;
        if (place(x + Math.cos(a) * rr, z + Math.sin(a) * rr,
          rngRange(rng, 0.20, 0.62), [PALETTE.rock, PALETTE.stone, PALETTE.stoneWarm], 0.30)) placed++;
      }
      this.footprints.push({ x, z, r: 1.6 });
    }

    // --- shingle and cobbles along the river margin
    const riv = this.layout.river;
    for (let i = 1; i < riv.n - 1; i++) {
      const t = riv.cum[i] / riv.length;
      let tx0 = riv.x[i + 1] - riv.x[i - 1], tz0 = riv.z[i + 1] - riv.z[i - 1];
      const tl = Math.hypot(tx0, tz0) || 1;
      const nx = -tz0 / tl, nz = tx0 / tl;
      const w = this.layout.riverHalfWidth(t);
      for (let k = 0; k < 7; k++) {
        const side = rng() < 0.5 ? -1 : 1;
        const off = side * (w + rngRange(rng, -1.4, 3.4));
        const x = riv.x[i] + nx * off, z = riv.z[i] + nz * off;
        if (!T.inBounds(x, z)) continue;
        const h = T.heightAt(x, z);
        if (h < WATER_Y - 0.45 || h > WATER_Y + 0.85) continue;
        place(x, z, rngRange(rng, 0.07, 0.26),
          [PALETTE.rock, PALETTE.stoneWarm, PALETTE.sand, PALETTE.mud], 0.45);
      }
    }

    // --- field-clearance cairns at the hedge lines
    for (const line of this.layout.hedges) {
      for (let s = 0; s < line.length - 1; s++) {
        if (rng() > 0.55) continue;
        const f = rng();
        const x = line[s].x + (line[s + 1].x - line[s].x) * f + rngRange(rng, -2.5, 2.5);
        const z = line[s].z + (line[s + 1].z - line[s].z) * f + rngRange(rng, -2.5, 2.5);
        if (!T.inBounds(x, z) || T.heightAt(x, z) < WATER_Y + 0.5) continue;
        const n = 4 + ((rng() * 6) | 0);
        for (let k = 0; k < n; k++) {
          const a = rng() * TAU, rr = Math.sqrt(rng()) * 1.1;
          place(x + Math.cos(a) * rr, z + Math.sin(a) * rr,
            rngRange(rng, 0.13, 0.36), [PALETTE.rock, PALETTE.stone, PALETTE.stoneWarm], 0.15);
        }
        this.footprints.push({ x, z, r: 1.5 });
      }
    }

    if (!parts.length) return;
    const g = mergeGeoms(parts);
    for (const p of parts) p.dispose();
    this.bins.stone.push(g);
  }

  /**
   * Roadside incident.
   *
   * The round-2 critiques both say the same thing about the ground: "the road
   * is one uninterrupted cream plane spanning the middle third", "there is no
   * pebble, rut or tuft scale anywhere in the near field". The terrain's albedo
   * bake runs on a 0.625 m vertex grid, so it CANNOT put anything smaller than
   * about a metre on the ground — sub-metre incident has to be geometry.
   *
   * So: kerb stones and turned-out gravel along the verges, chippings sitting
   * in the two wheel ruts (which the terrain paints but nothing occupies), and
   * a scatter of timber offcuts and dropped fence rails where a farm track
   * meets the road. Everything is keyed to the road spline, so it thins where
   * the road does and never lands on the carriageway crown.
   */
  _buildRoadside() {
    const rng = makeRng(this.seed ^ 0x2c19);
    const T = this.terrain;
    const road = this.layout.road;
    if (!road || !(road.n > 2)) return;
    const stones = [];
    const timber = [];

    for (let i = 1; i < road.n - 1; i++) {
      const t = road.cum[i] / road.length;
      let tx0 = road.x[i + 1] - road.x[i - 1], tz0 = road.z[i + 1] - road.z[i - 1];
      const tl = Math.hypot(tx0, tz0) || 1;
      const nx = -tz0 / tl, nz = tx0 / tl;
      const hw = this.layout.roadHalfWidth(t);

      // --- verge: kerb stones and the gravel a cart throws out of the surface
      for (let k = 0; k < 9; k++) {
        const side = rng() < 0.5 ? -1 : 1;
        // just outside the metalled width, where the surface breaks up
        const off = side * hw * rngRange(rng, 0.94, 1.30);
        const x = road.x[i] + nx * off + rngRange(rng, -1.1, 1.1);
        const z = road.z[i] + nz * off + rngRange(rng, -1.1, 1.1);
        if (!T.inBounds(x, z) || this.occupiedTest(x, z)) continue;
        if (T.heightAt(x, z) < WATER_Y + 0.30) continue;
        const r = rng() < 0.22 ? rngRange(rng, 0.16, 0.28) : rngRange(rng, 0.045, 0.12);
        const g = boulderGeom(rng, r,
          [PALETTE.rock, PALETTE.stoneWarm, PALETTE.sand, PALETTE.dirtDark]);
        tx(g, { x, y: T.heightAt(x, z) - r * 0.42, z, ry: rng() * TAU });
        stones.push(g);
      }

      // --- chippings loose in the two wheel ruts. The terrain paints the ruts
      //     at 0.55 of the half width; this puts something IN them.
      for (let k = 0; k < 5; k++) {
        const side = rng() < 0.5 ? -1 : 1;
        const off = side * hw * rngRange(rng, 0.42, 0.68);
        const x = road.x[i] + nx * off + rngRange(rng, -0.9, 0.9);
        const z = road.z[i] + nz * off + rngRange(rng, -0.9, 0.9);
        if (!T.inBounds(x, z) || this.occupiedTest(x, z)) continue;
        if (T.heightAt(x, z) < WATER_Y + 0.30) continue;
        const r = rngRange(rng, 0.028, 0.075);
        const g = boulderGeom(rng, r, [PALETTE.rock, PALETTE.sand, PALETTE.dirtDark, PALETTE.mud]);
        tx(g, { x, y: T.heightAt(x, z) - r * 0.55, z, ry: rng() * TAU });
        stones.push(g);
      }

      // --- dropped timber: a rail off a fence, a sawn offcut, a discarded stake
      if (rng() < 0.16) {
        const side = rng() < 0.5 ? -1 : 1;
        const off = side * hw * rngRange(rng, 1.05, 1.55);
        const x = road.x[i] + nx * off, z = road.z[i] + nz * off;
        if (!T.inBounds(x, z) || this.occupiedTest(x, z)) continue;
        if (T.heightAt(x, z) < WATER_Y + 0.35) continue;
        const len = rngRange(rng, 0.9, 2.4);
        const th = rngRange(rng, 0.07, 0.13);
        const g = box(len, th, th * rngRange(rng, 0.8, 1.5),
          rng() < 0.5 ? PALETTE.timber : PALETTE.timberDark, { variation: 0.16 });
        tx(g, {
          x, y: T.heightAt(x, z) + th * 0.45, z,
          ry: rng() * TAU, rz: rngRange(rng, -0.09, 0.09),
        });
        timber.push(g);
      }
    }

    if (stones.length) {
      const g = mergeGeoms(stones);
      for (const p of stones) p.dispose();
      this.bins.stone.push(g);
    }
    if (timber.length) {
      const g = mergeGeoms(timber);
      for (const p of timber) p.dispose();
      this.bins.wood.push(g);
    }
  }

  _buildWrecks() {
    const rng = this.rng;
    const b = this.layout.bridge;
    // a lorry burnt out short of the bridge
    const lx = b.x + Math.sin(b.yaw) * (b.length * 0.5 + 9) + Math.cos(b.yaw) * 3.2;
    const lz = b.z + Math.cos(b.yaw) * (b.length * 0.5 + 9) - Math.sin(b.yaw) * 3.2;
    if (this.terrain.inBounds(lx, lz) && this.terrain.heightAt(lx, lz) > WATER_Y + 0.4) {
      this._place(buildWreckLorry(rng), lx, lz, b.yaw + rngRange(rng, -0.5, 0.5));
      this.footprints.push({ x: lx, z: lz, r: 4.2 });
      const heap = rubblePile(rng, 2.6, 0.28, 24, [PALETTE.darkest, PALETTE.steelDark, PALETTE.rust]);
      heap.translate(lx, this.terrain.heightAt(lx, lz), lz);
      this.bins.metal.push(heap);
    }
    // a light tank knocked out in the northern field
    const tx0 = 44, tz0 = -30;
    if (this.terrain.inBounds(tx0, tz0)) {
      this._place(buildWreckTank(rng), tx0, tz0, rngRange(rng, 0, TAU));
      this.footprints.push({ x: tx0, z: tz0, r: 5.5 });
    }
  }

  // -----------------------------------------------------------------------

  _commit() {
    this.meshes = [];
    for (const k of BINS) {
      if (!this.bins[k].length) continue;
      const g = mergeGeoms(this.bins[k]);
      worldUV(g, this.uvScale[k]);
      for (const src of this.bins[k]) src.dispose();
      const m = new THREE.Mesh(g, this.mats[k]);
      m.name = `props:${k}`;
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.outline = true;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.meshes.push(m);
      this.bins[k] = [];
    }
  }

  occupied(x, z) {
    for (let i = 0; i < this.footprints.length; i++) {
      const f = this.footprints[i];
      const dx = x - f.x, dz = z - f.z;
      if (dx * dx + dz * dz < f.r * f.r) return true;
    }
    return false;
  }

  /**
   * Damage a destructible prop. Sandbag walls settle progressively — the mesh
   * sinks and the cover value falls with it, so a wall that has been raked with
   * MG fire stops protecting the man behind it before it disappears. Drums
   * detonate.
   *
   * @param {object} collider  any collider belonging to the prop
   * @param {number} amount    HP of damage (the same scale as `explosion.power`)
   * @returns {boolean} true ONLY on the frame the prop is destroyed, so the
   *   caller can raise `cover:destroyed` exactly once.
   */
  damage(collider, amount) {
    const rec = collider?.owner;
    if (!rec || rec.hp <= 0 || !(amount > 0)) return false;
    rec.hp -= amount;
    const f = clamp01(1 - rec.hp / rec.maxHp);
    if (rec.kind === 'sandbag') {
      const sink = f * 0.55;
      rec.sunk = sink;
      rec.mesh.position.copy(rec.origin).setY(rec.origin.y - sink);
      rec.mesh.updateMatrix();
      for (const c of rec.colliders) c.cover = lerp(1, 0.4, f);
    }
    if (rec.hp > 0) return false;
    rec.hp = 0;
    if (rec.kind === 'drum') {
      // Cook-off. Queued rather than emitted inline: `damage()` runs inside a
      // ColliderGrid.query callback (World.damageArea) and a nested blast would
      // re-enter that iteration. Props.update() flushes it a beat later, which
      // also makes a fuel dump ripple instead of going up as one flat bang.
      this._cookoff.push({
        pos: rec.pos.clone(), radius: 5.5, power: DRUM_BLAST_POWER, t: 0.12,
      });
    }
    if (rec.kind !== 'sandbag') {
      // ONE switch: the accessor clears solid/blocksLos/blocksProjectile/cover
      // and hides the mesh through onColliderDestroyed.
      for (const c of rec.colliders) c.destroyed = true;
    } else {
      // A shot-out revetment settles into a low mound: still a body-blocker and
      // still stops rounds, but it is no longer full cover.
      for (const c of rec.colliders) c.cover = 0.4;
    }
    return true;
  }

  update(dt = 0) {
    if (!this._cookoff.length) return;
    for (let i = this._cookoff.length - 1; i >= 0; i--) {
      const b = this._cookoff[i];
      b.t -= dt;
      if (b.t > 0) continue;
      this._cookoff.splice(i, 1);
      Bus.emit('explosion', { pos: b.pos, radius: b.radius, power: b.power });
      Bus.emit('sfx', { name: 'explosion', pos: b.pos });
    }
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    for (const d of this.destructibles) d.mesh.geometry.dispose();
    this.wireMesh?.geometry.dispose();
    for (const k of BINS) this.mats[k].dispose();
    this.wireMat.dispose();
    this.group.parent?.remove(this.group);
  }
}
