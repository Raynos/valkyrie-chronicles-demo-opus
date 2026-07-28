// Structures: the built environment of a Gallian river village.
//
// Every building is generated from a grammar rather than placed from a kit of
// fixed models: footprint -> bays -> door/window assignment -> wall solids with
// real openings -> hipped pantile roof -> chimney, shutters, timber framing.
// A share of the village is then SHELLED — the intact geometry is generated
// first and then bitten into with carveGeometry(), so a blown-out gable always
// lines up with the wall it was blown out of, with ragged brick stubs along the
// break, collapsed roof, exposed rafters and a rubble spill at the foot.
//
// Geometry is binned by material (stucco / stone / tile / timber / metal) and
// merged ACROSS buildings, so the whole village costs five draw calls. Nothing
// here animates except the windmill sails, which get their own node.

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { makeRng, rngRange, rngInt, rngPick, valueNoise2 } from '../core/rng.js';
import { lerp, TAU } from '../core/math.js';
import {
  mergeGeoms, setGeomColor, tx, box, cyl, loft, hipRoof, ribbonWall,
  rubblePile, raggedEdge, carveGeometry, worldUV, scorch,
  smoothNormals, extrudeElevation,
} from './geoutil.js';
import { makeSurfaceMaterial, PALETTE } from './worldMaterials.js';
import { stuccoTexture, stoneTexture, woodTexture } from './textures.js';
import { makeBox } from './collider.js';
import { WATER_Y } from './layout.js';

const BINS = ['stucco', 'stone', 'tile', 'timber', 'metal'];

function newBins() {
  const b = {};
  for (const k of BINS) b[k] = [];
  return b;
}

// ---------------------------------------------------------------------------
// wall grammar
// ---------------------------------------------------------------------------

/**
 * A wall running along local X from -len/2 to +len/2, thickness along Z,
 * base at y = 0. Openings are punched by emitting the solid remainder as
 * boxes: piers between openings, plus the spandrel below and the head above
 * each one. Exact, cheap, and it never leaves a T-junction crack.
 */
function wallSolids(len, height, thick, openings, color, variation = 0.05) {
  const out = [];
  const half = len * 0.5;
  const sorted = openings.slice().sort((a, b) => a.x0 - b.x0);
  let cursor = -half;
  for (const o of sorted) {
    if (o.x0 > cursor + 0.02) {
      const w = o.x0 - cursor;
      out.push(box(w, height, thick, color, { x: cursor + w * 0.5, y: height * 0.5, z: 0, variation }));
    }
    if (o.y0 > 0.02) {
      out.push(box(o.x1 - o.x0, o.y0, thick, color,
        { x: (o.x0 + o.x1) * 0.5, y: o.y0 * 0.5, z: 0, variation }));
    }
    if (o.y1 < height - 0.02) {
      out.push(box(o.x1 - o.x0, height - o.y1, thick, color,
        { x: (o.x0 + o.x1) * 0.5, y: (height + o.y1) * 0.5, z: 0, variation }));
    }
    cursor = Math.max(cursor, o.x1);
  }
  if (cursor < half - 0.02) {
    const w = half - cursor;
    out.push(box(w, height, thick, color, { x: cursor + w * 0.5, y: height * 0.5, z: 0, variation }));
  }
  return out;
}

/** Bay-by-bay door/window assignment for one facade. */
function facadeOpenings(len, storeys, storeyH, rng, wantDoor) {
  const bays = Math.max(2, Math.round(len / 2.45));
  const bw = len / bays;
  const openings = [];
  const doorBay = wantDoor ? rngInt(rng, 0, bays - 1) : -1;
  for (let s = 0; s < storeys; s++) {
    const y0base = s * storeyH;
    for (let b = 0; b < bays; b++) {
      const cx = -len * 0.5 + (b + 0.5) * bw;
      if (s === 0 && b === doorBay) {
        const w = Math.min(1.05, bw * 0.55);
        openings.push({ x0: cx - w * 0.5, x1: cx + w * 0.5, y0: 0, y1: 2.12, kind: 'door', cx });
        continue;
      }
      // not every bay gets a window — blank walls are what make a facade read
      if (rng() < (s === 0 ? 0.30 : 0.20)) continue;
      const w = Math.min(0.95, bw * 0.46);
      const sill = y0base + (s === 0 ? 1.02 : 0.92);
      const head = sill + (s === 0 ? 1.18 : 1.02);
      openings.push({ x0: cx - w * 0.5, x1: cx + w * 0.5, y0: sill, y1: head, kind: 'window', cx });
    }
  }
  return { openings, bays, bw };
}

/**
 * Frames, shutters, sills and doors for a facade's openings, in the wall's
 * local frame (wall plane at z = 0, exterior toward +Z).
 */
function facadeFurniture(openings, thick, rng, bins) {
  const zOut = thick * 0.5;
  for (const o of openings) {
    const w = o.x1 - o.x0, h = o.y1 - o.y0;
    const cx = (o.x0 + o.x1) * 0.5, cy = (o.y0 + o.y1) * 0.5;
    // dark recess so the opening never reads as a hole in a card
    bins.timber.push(box(w * 0.98, h * 0.98, 0.06, PALETTE.darkest,
      { x: cx, y: cy, z: -thick * 0.18, variation: 0.1 }));
    if (o.kind === 'door') {
      // hinged on the left jamb, sometimes standing open
      const ajar = rng() < 0.35 ? rngRange(rng, 0.25, 0.9) : 0;
      const gg = box(w * 0.94, h * 0.96, 0.07, PALETTE.timber, { variation: 0.09 });
      gg.translate(w * 0.47, 0, 0);
      tx(gg, { ry: -ajar });
      gg.translate(o.x0, cy, zOut + 0.02);
      bins.timber.push(gg);
      // stone step
      bins.stone.push(box(w * 1.35, 0.14, 0.7, PALETTE.stone,
        { x: cx, y: 0.06, z: zOut + 0.3, variation: 0.08 }));
      // lintel
      bins.timber.push(box(w * 1.25, 0.16, thick + 0.09, PALETTE.timberDark,
        { x: cx, y: o.y1 + 0.08, z: 0, variation: 0.08 }));
    } else {
      // sill + lintel
      bins.stone.push(box(w * 1.3, 0.10, thick + 0.16, PALETTE.stone,
        { x: cx, y: o.y0 - 0.05, z: 0.02, variation: 0.08 }));
      bins.timber.push(box(w * 1.22, 0.13, thick + 0.07, PALETTE.timberDark,
        { x: cx, y: o.y1 + 0.06, z: 0, variation: 0.08 }));
      // glazing bars
      bins.timber.push(box(0.05, h * 0.94, 0.05, PALETTE.plaster,
        { x: cx, y: cy, z: -thick * 0.1, variation: 0.05 }));
      bins.timber.push(box(w * 0.94, 0.05, 0.05, PALETTE.plaster,
        { x: cx, y: cy, z: -thick * 0.1, variation: 0.05 }));
      // shutters, sometimes swung open
      if (rng() < 0.75) {
        for (const side of [-1, 1]) {
          const open = rng() < 0.55 ? rngRange(rng, 0.7, 1.5) : 0.04;
          const sw = w * 0.52;
          const g = box(sw, h * 1.02, 0.05, rng() < 0.5 ? PALETTE.olive : PALETTE.timberDark,
            { variation: 0.1 });
          g.translate(side * sw * 0.5, 0, 0);
          tx(g, { ry: -side * open });
          g.translate(cx + side * (w * 0.5), cy, zOut + 0.03);
          bins.timber.push(g);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// farmhouse
// ---------------------------------------------------------------------------

/**
 * @returns {{bins:object, colliders:Array, w:number, d:number, height:number}}
 * All geometry is in the building's local frame: origin at footprint centre,
 * y = 0 at the finished floor, +Z is the street-facing facade.
 */
export function buildFarmhouse(rng, opts = {}) {
  const bins = newBins();
  const colliders = [];

  const storeys = opts.storeys ?? (rng() < 0.45 ? 2 : 1);
  const w = opts.w ?? rngRange(rng, 6.5, 11.5);
  const d = opts.d ?? rngRange(rng, 5.2, 8.4);
  const storeyH = 2.72;
  const wallH = storeys * storeyH;
  const thick = 0.36;
  const shelled = opts.shelled ?? false;
  const timbered = rng() < 0.45;

  const stucco = rngPick(rng, [PALETTE.stucco, PALETTE.stuccoWarm, PALETTE.stuccoGrey, PALETTE.plaster]);

  // --- plinth
  bins.stone.push(box(w + 0.34, 0.62, d + 0.34, PALETTE.stone,
    { x: 0, y: 0.02, z: 0, variation: 0.10 }));

  // --- four walls
  const faces = [
    { len: w, yaw: 0, off: [0, 0, d * 0.5 - thick * 0.5], door: true },
    { len: w, yaw: Math.PI, off: [0, 0, -d * 0.5 + thick * 0.5], door: rng() < 0.3 },
    { len: d, yaw: Math.PI * 0.5, off: [w * 0.5 - thick * 0.5, 0, 0], door: false },
    { len: d, yaw: -Math.PI * 0.5, off: [-w * 0.5 + thick * 0.5, 0, 0], door: false },
  ];
  const facadeInfo = [];
  for (const f of faces) {
    const { openings } = facadeOpenings(f.len, storeys, storeyH, rng, f.door);
    const solids = wallSolids(f.len, wallH, thick, openings, stucco, 0.055);
    const sub = newBins();
    facadeFurniture(openings, thick, rng, sub);
    if (timbered) {
      // exposed frame: posts on the bay lines, a rail at the storey break,
      // and a pair of braces
      const bays = Math.max(2, Math.round(f.len / 2.45));
      for (let b = 0; b <= bays; b++) {
        const x = -f.len * 0.5 + (b * f.len) / bays;
        sub.timber.push(box(0.17, wallH, 0.10, PALETTE.timberDark,
          { x, y: wallH * 0.5, z: thick * 0.5 + 0.03, variation: 0.09 }));
      }
      for (let s = 1; s <= storeys; s++) {
        sub.timber.push(box(f.len, 0.19, 0.11, PALETTE.timberDark,
          { x: 0, y: s * storeyH - 0.12, z: thick * 0.5 + 0.03, variation: 0.09 }));
      }
      const bl = Math.min(1.9, f.len * 0.3);
      for (const s of [-1, 1]) {
        sub.timber.push(box(0.14, bl * 1.5, 0.09, PALETTE.timberDark,
          { x: s * (f.len * 0.5 - bl * 0.55), y: bl * 0.75, z: thick * 0.5 + 0.03, rz: s * 0.62, variation: 0.09 }));
      }
    }
    // rotate + translate everything of this facade into building space
    const place = (g) => {
      tx(g, { ry: f.yaw });
      g.translate(f.off[0], f.off[1], f.off[2]);
    };
    for (const g of solids) { place(g); bins.stucco.push(g); }
    for (const k of BINS) for (const g of sub[k]) { place(g); bins[k].push(g); }
    facadeInfo.push({ f, openings });
  }

  // --- floor slab (so a blown-out wall does not show sky through the ground)
  bins.stone.push(box(w, 0.2, d, PALETTE.stoneWarm, { x: 0, y: 0.32, z: 0, variation: 0.06 }));

  // --- roof
  const roofH = Math.min(w, d) * rngRange(rng, 0.32, 0.44);
  const overhang = rngRange(rng, 0.32, 0.55);
  let roof = hipRoof(w, d, roofH, overhang, rng, PALETTE.tileA, PALETTE.tileB);
  roof.translate(0, wallH, 0);
  // rafter tails poking out under the eaves
  const nTails = Math.max(3, Math.round(w / 0.75));
  for (let i = 0; i < nTails; i++) {
    const x = -w * 0.5 + ((i + 0.5) / nTails) * w;
    for (const s of [-1, 1]) {
      bins.timber.push(box(0.08, 0.13, overhang * 2 + 0.25, PALETTE.timberDark,
        { x, y: wallH + 0.06, z: s * (d * 0.5 + overhang * 0.4), variation: 0.1 }));
    }
  }

  // --- chimney
  const chx = (rng() < 0.5 ? -1 : 1) * (w * 0.5 - rngRange(rng, 0.8, 1.6));
  const chz = rngRange(rng, -d * 0.22, d * 0.22);
  const chH = wallH + roofH + rngRange(rng, 0.7, 1.5);
  bins.stone.push(box(0.86, chH, 0.72, PALETTE.brick, { x: chx, y: chH * 0.5, z: chz, variation: 0.13 }));
  bins.stone.push(box(1.04, 0.18, 0.9, PALETTE.stone, { x: chx, y: chH + 0.05, z: chz, variation: 0.09 }));

  // --- damage pass
  if (shelled) {
    const side = rngPick(rng, [0, 1, 2, 3]);
    const info = facadeInfo[side];
    const yawS = info.f.yaw;
    // blast centre on the chosen wall, in building space
    const along = rngRange(rng, -info.f.len * 0.28, info.f.len * 0.28);
    const bx = Math.cos(yawS) * along + info.f.off[0];
    const bz = -Math.sin(yawS) * along + info.f.off[2];
    const by = rngRange(rng, wallH * 0.45, wallH * 0.95);
    const br = rngRange(rng, 1.9, 3.4);

    const keep = (x, y, z) => {
      // ragged bite: the radius wobbles with position so the edge is torn
      const n = valueNoise2(x * 1.7 + y * 0.9, z * 1.7 - y * 0.6, 991);
      const r = br * (0.72 + n * 0.62);
      return Math.hypot(x - bx, (y - by) * 0.85, z - bz) > r;
    };
    for (const k of BINS) {
      const carved = [];
      for (const g of bins[k]) {
        const c = carveGeometry(g, keep);
        g.dispose();
        if (c.getAttribute('position').count > 0) carved.push(c);
        else c.dispose();
      }
      bins[k] = carved;
    }
    // roof: collapse a slice
    roof = carveGeometry(roof, (x, y, z) => {
      const n = valueNoise2(x * 1.1 + 3.3, z * 1.1 - 2.2, 553);
      return Math.hypot(x - bx * 0.7, z - bz * 0.7) > br * (0.95 + n * 0.85)
        && y < wallH + roofH * 1.2;
    });
    // exposed rafters across the hole
    const nR = 5;
    for (let i = 0; i < nR; i++) {
      const x = bx + (i - nR * 0.5) * 0.55;
      const len = rngRange(rng, 1.4, d * 0.9);
      bins.timber.push(box(0.10, 0.16, len, PALETTE.timberDark, {
        x, y: wallH + rngRange(rng, 0.1, roofH * 0.7), z: bz * 0.5 + rngRange(rng, -0.6, 0.6),
        rx: rngRange(rng, -0.35, 0.35), rz: rngRange(rng, -0.2, 0.2), variation: 0.14,
      }));
    }
    // ragged brick stubs along the break
    const nrm = { x: Math.sin(yawS), z: Math.cos(yawS) };
    const stubs = raggedEdge(rng,
      { x: bx - nrm.z * br, z: bz + nrm.x * br },
      { x: bx + nrm.z * br, z: bz - nrm.x * br },
      by + br * 0.55, 0.9, thick, [PALETTE.brick, PALETTE.stone, PALETTE.stuccoGrey]);
    for (const g of stubs) bins.stone.push(g);
    // rubble spilling out of the breach
    const heap = rubblePile(rng, br * 1.35, 0.9, 46,
      [PALETTE.brick, PALETTE.stone, PALETTE.stuccoGrey, PALETTE.tileDark]);
    heap.translate(bx * 1.25, 0.15, bz * 1.25);
    bins.stone.push(heap);
    // scorching around the impact
    for (const k of BINS) for (const g of bins[k]) scorch(g, bx, by, bz, br * 2.4, 0.5);
    scorch(roof, bx, wallH + roofH * 0.5, bz, br * 2.6, 0.45);

    colliders.push({
      cx: bx * 1.25, cy: 0.5, cz: bz * 1.25,
      hx: br * 1.2, hy: 0.5, hz: br * 1.2, yaw: 0,
      opts: { cover: 0.5, conceal: 0.2, solid: false, blocksLos: false, tag: 'rubble' },
    });
  }
  bins.tile.push(roof);

  // --- collision: one solid mass for the shell, plus the plinth as a step
  colliders.push({
    cx: 0, cy: wallH * 0.5, cz: 0,
    hx: w * 0.5 + 0.1, hy: wallH * 0.5, hz: d * 0.5 + 0.1, yaw: 0,
    opts: { cover: 1, conceal: 0, solid: true, blocksLos: true, tag: 'building', destructible: false },
  });

  return { bins, colliders, w, d, height: wallH + roofH, shelled };
}

// ---------------------------------------------------------------------------
// barn / shed
// ---------------------------------------------------------------------------

export function buildBarn(rng, opts = {}) {
  const bins = newBins();
  const colliders = [];
  const w = opts.w ?? rngRange(rng, 9, 13);
  const d = opts.d ?? rngRange(rng, 6, 8);
  const h = rngRange(rng, 3.4, 4.4);
  const thick = 0.28;

  // timber-boarded walls on a low stone base, big cart doors on the long side
  bins.stone.push(box(w + 0.2, 0.5, d + 0.2, PALETTE.stone, { y: 0.1, variation: 0.1 }));
  const boards = Math.max(6, Math.round(w / 0.42));
  for (const s of [-1, 1]) {
    for (let i = 0; i < boards; i++) {
      const x = -w * 0.5 + ((i + 0.5) / boards) * w;
      if (s === 1 && Math.abs(x) < w * 0.17) continue;      // door gap
      bins.timber.push(box(w / boards - 0.03, h, thick,
        i % 3 === 0 ? PALETTE.timberDark : PALETTE.timber,
        { x, y: h * 0.5 + 0.3, z: s * (d * 0.5), variation: 0.13 }));
    }
  }
  const dBoards = Math.max(4, Math.round(d / 0.42));
  for (const s of [-1, 1]) {
    for (let i = 0; i < dBoards; i++) {
      const z = -d * 0.5 + ((i + 0.5) / dBoards) * d;
      bins.timber.push(box(thick, h, d / dBoards - 0.03,
        i % 4 === 0 ? PALETTE.timberDark : PALETTE.timber,
        { x: s * (w * 0.5), y: h * 0.5 + 0.3, z, variation: 0.13 }));
    }
  }
  // cart doors
  for (const s of [-1, 1]) {
    bins.timber.push(box(w * 0.17, h * 0.86, 0.09, PALETTE.timberDark,
      { x: s * w * 0.085, y: h * 0.43 + 0.3, z: d * 0.5 + 0.1, ry: s * rngRange(rng, 0, 0.5), variation: 0.1 }));
  }
  const roof = hipRoof(w, d, Math.min(w, d) * 0.38, 0.5, rng, PALETTE.tileDark, PALETTE.tileA);
  roof.translate(0, h + 0.3, 0);
  bins.tile.push(roof);

  colliders.push({
    cx: 0, cy: (h + 0.3) * 0.5, cz: 0,
    hx: w * 0.5 + 0.15, hy: (h + 0.3) * 0.5, hz: d * 0.5 + 0.15, yaw: 0,
    opts: { cover: 1, solid: true, blocksLos: true, tag: 'building' },
  });
  return { bins, colliders, w, d, height: h + 2 };
}

// ---------------------------------------------------------------------------
// stone arch bridge
// ---------------------------------------------------------------------------

// Span geometry, shared with water.js so the pier wash breaks exactly where the
// masonry stands in the stream. Changing the bridge means changing this ONE
// function; nothing else may hard-code the span arithmetic.
export const BRIDGE_SPANS = 3;
export const BRIDGE_PIER_W = 1.9;
export const BRIDGE_ABUT = 2.6;

/** @returns {{span:number, pierZ:number[], spanZ:{z0:number,z1:number}[]}} */
export function bridgeSpanLayout(length) {
  const spans = BRIDGE_SPANS, pierW = BRIDGE_PIER_W, abut = BRIDGE_ABUT;
  const span = (length - pierW * (spans - 1) - abut * 2) / spans;
  const spanZ = [];
  const pierZ = [];
  for (let s = 0; s < spans; s++) {
    const z0 = -length * 0.5 + abut + s * (span + pierW);
    spanZ.push({ z0, z1: z0 + span });
  }
  for (let s = 1; s < spans; s++) {
    pierZ.push(-length * 0.5 + abut + s * span + (s - 0.5) * pierW);
  }
  return { span, pierZ, spanZ };
}

/**
 * Three-span masonry bridge.
 *
 * The whole body — deck, spandrels, piers, abutments AND the barrel vaults — is
 * ONE extrusion of a single elevation profile with three elliptical holes
 * punched through it. That is the only way to get a C1-continuous intrados: the
 * previous build stepped 0.30 m boxes along each arch, which produced a literal
 * staircase silhouette and a stack of laminated black-edged slabs inside every
 * span, because the outline pass draws a crease at every facet break.
 * `smoothNormals` then welds the barrel's 5-degree facets into a continuous
 * surface while leaving the 90-degree arris at the spandrel face intact.
 *
 * Local frame: length along +Z, width along X, deck top at y = 0.
 */
export function buildBridge(rng, length, width, deckY, riverBedY, waterY) {
  const bins = newBins();
  const colliders = [];
  const { span, pierZ, spanZ } = bridgeSpanLayout(length);
  const pierW = BRIDGE_PIER_W;

  const half = width * 0.5;
  const deckT = 0.72;

  // Everything is measured relative to the deck TOP at y = 0.
  const bedRel = riverBedY - deckY;                      // negative
  const waterRel = (waterY ?? WATER_Y) - deckY;          // negative
  // Just enough footing to be bedded in the gravel. Any deeper and the
  // foundation shows THROUGH the translucent river as a dark wedge.
  const baseY = bedRel - 0.30;
  const crownY = -deckT - 0.26;                          // intrados at the crown
  // Springing sits a hand above the waterline, the way a village bridge does,
  // not down on the riverbed.
  let springY = Math.max(bedRel + 0.55, waterRel + 0.30);
  let rise = crownY - springY;
  if (rise < 0.9) { rise = 0.9; springY = crownY - rise; }
  // A segmental (elliptical) arch: semicircular only when rise == span/2.

  // --- the body: one profile, three holes, one sweep ------------------------
  const shape = new THREE.Shape();
  shape.moveTo(-length * 0.5, baseY);
  shape.lineTo(length * 0.5, baseY);
  shape.lineTo(length * 0.5, 0);
  shape.lineTo(-length * 0.5, 0);
  shape.closePath();
  for (const { z0, z1 } of spanZ) {
    const zc = (z0 + z1) * 0.5;
    const hole = new THREE.Path();
    hole.moveTo(z0, baseY);
    hole.lineTo(z0, springY);
    hole.absellipse(zc, springY, span * 0.5, rise, Math.PI, 0, true);
    hole.lineTo(z1, baseY);
    hole.closePath();
    shape.holes.push(hole);
  }
  let body = extrudeElevation(shape, width, 40);
  setGeomColor(body, PALETTE.stone, 0.085);
  body = smoothNormals(body, 40);
  bins.stone.push(body);

  // road surface on top of the deck
  bins.stone.push(box(width - 1.5, 0.10, length, PALETTE.dirtDark,
    { y: 0.02, variation: 0.12 }));

  // --- voussoir ring: a band of dressed stone standing proud of the spandrel
  //     face, following the SAME ellipse as the intrados.
  const ringT = 0.44;
  for (const { z0, z1 } of spanZ) {
    const zc = (z0 + z1) * 0.5;
    const rxi = span * 0.5 - 0.06, ryi = rise - 0.06;
    const rxo = rxi + ringT, ryo = ryi + ringT;
    const skew = springY - 0.42;
    const band = new THREE.Shape();
    band.moveTo(zc - rxo, skew);
    band.absellipse(zc, springY, rxo, ryo, Math.PI, 0, true);
    band.lineTo(zc + rxo, skew);
    band.lineTo(zc + rxi, skew);
    band.absellipse(zc, springY, rxi, ryi, 0, Math.PI, false);
    band.lineTo(zc - rxi, skew);
    band.closePath();
    for (const side of [-1, 1]) {
      let ring = extrudeElevation(band, 0.17, 40);
      setGeomColor(ring, PALETTE.stoneWarm, 0.10);
      ring = smoothNormals(ring, 40);
      ring.translate(side * (half + 0.055), 0, 0);
      bins.stone.push(ring);
    }
  }

  // --- string course under the parapet: the horizontal shadow line that tells
  //     you where the structure stops and the balustrade begins.
  bins.stone.push(box(width + 0.34, 0.19, length, PALETTE.stoneWarm,
    { y: -0.30, variation: 0.09 }));

  // --- piers: pointed cutwaters running from the foundation to a sloped
  //     starling cap just under the springing, in ONE hexagonal-plan solid per
  //     pier so both noses and the pier shaft are a single continuous form.
  // The nose only exists where a cutwater has work to do: from a hand under the
  // waterline up to the springing. Carrying it all the way to the foundation
  // hangs two metres of fully-inked masonry inside a translucent river, and the
  // outline pass draws that as a pair of black fins floating in the water.
  const reach = 0.95;
  for (const zc of pierZ) {
    const capBase = Math.min(springY - 0.12, waterRel + 1.9);
    const g = loft([
      // The nose STOPS at the waterline. Below it there is only the plain pier
      // shaft (which is part of the extruded body). The river does not write
      // depth, so anything submerged still gets a full-weight graphite outline
      // drawn over the water by the composite — carrying a 2 m tapered cutwater
      // down to the bed therefore reads as a pair of inked blades hanging in the
      // channel, which is exactly what it looked like.
      { c: { x: 0, y: waterRel - 0.45, z: zc }, r: 1, sx: half + reach * 0.97, sz: pierW * 0.550 },
      { c: { x: 0, y: waterRel + 0.10, z: zc }, r: 1, sx: half + reach, sz: pierW * 0.555 },
      { c: { x: 0, y: capBase, z: zc }, r: 1, sx: half + reach * 0.90, sz: pierW * 0.55 },
      { c: { x: 0, y: capBase + 0.75, z: zc }, r: 1, sx: half * 0.97, sz: pierW * 0.50 },
    ], 6, true, true);
    setGeomColor(g, PALETTE.stone, 0.10, rng);
    bins.stone.push(g);
    // a dark waterline course — algae and wet stone where the river washes it
    const wl = loft([
      { c: { x: 0, y: waterRel - 0.30, z: zc }, r: 1, sx: half + reach * 1.00, sz: pierW * 0.562 },
      { c: { x: 0, y: waterRel + 0.28, z: zc }, r: 1, sx: half + reach * 1.005, sz: pierW * 0.560 },
    ], 6, false, false);
    setGeomColor(wl, PALETTE.mud, 0.13, rng);
    bins.stone.push(wl);
  }

  // --- wing walls: the abutments splay into the bank so the deck never ends
  //     on a floating card.
  for (const s of [-1, 1]) {
    for (const side of [-1, 1]) {
      const wing = box(0.7, -baseY, 4.6, PALETTE.stone, {
        x: side * (half + 0.55), y: baseY * 0.5,
        z: s * (length * 0.5 + 1.1), ry: side * s * 0.34, variation: 0.11,
      });
      bins.stone.push(wing);
    }
    bins.stone.push(box(width + 1.3, -baseY * 0.9, 2.8, PALETTE.stone,
      { y: baseY * 0.45, z: s * (length * 0.5 + 0.9), variation: 0.1 }));
  }

  // --- parapets with coping
  const parapetStart = bins.stone.length;
  for (const side of [-1, 1]) {
    const pts = [];
    const segs = 14;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push({ x: side * (half - 0.26), z: -length * 0.5 + t * length });
    }
    const par = ribbonWall(pts, 0, 0.92, 0.52);
    setGeomColor(par, PALETTE.stone, 0.12, rng);
    bins.stone.push(par);
    const cop = ribbonWall(pts, 0.92, 1.08, 0.68);
    setGeomColor(cop, PALETTE.stoneWarm, 0.09, rng);
    bins.stone.push(cop);

    colliders.push({
      cx: side * (half - 0.26), cy: 0.54, cz: 0,
      hx: 0.34, hy: 0.54, hz: length * 0.5, yaw: 0,
      opts: { cover: 1, solid: true, blocksLos: false, tag: 'parapet', destructible: true, hp: 220 },
    });
  }

  // a shell hole knocked through one parapet — the crossing has been fought
  // over. Only the balustrade is bitten into; the arch body is left whole.
  const holeZ = rngRange(rng, -length * 0.22, length * 0.22);
  const holeSide = rng() < 0.5 ? -1 : 1;
  const holeHalf = rngRange(rng, 0.95, 1.5);
  for (let i = parapetStart; i < bins.stone.length; i++) {
    const g = bins.stone[i];
    // torn, not sawn: the bite radius wobbles along the parapet
    bins.stone[i] = carveGeometry(g, (x, y, z) => {
      if (!(y > -0.1 && x * holeSide > half - 0.9)) return true;
      const wob = holeHalf * (0.72 + valueNoise2(z * 1.6, y * 1.6, 617) * 0.7);
      return Math.abs(z - holeZ) > wob;
    });
    g.dispose();
  }
  const spill = rubblePile(rng, 1.5, 0.45, 22, [PALETTE.stone, PALETTE.stoneWarm]);
  spill.translate(holeSide * (half - 0.4), 0.05, holeZ);
  bins.stone.push(spill);

  return { bins, colliders, length, width, deckY, deckT, springY, rise, span };
}

// ---------------------------------------------------------------------------
// windmill
// ---------------------------------------------------------------------------

export function buildWindmill(rng) {
  const bins = newBins();
  const colliders = [];
  const H = 10.5;
  const rBase = 3.1, rTop = 2.0;

  // battered octagonal tower
  const rings = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    rings.push({ c: { x: 0, y: t * H, z: 0 }, r: lerp(rBase, rTop, Math.pow(t, 0.85)), rot: Math.PI / 8 });
  }
  const tower = loft(rings, 8, false, false);
  setGeomColor(tower, PALETTE.stuccoWarm, 0.075);
  bins.stucco.push(tower);

  // stone base course
  const baseRings = [
    { c: { x: 0, y: -0.4, z: 0 }, r: rBase + 0.22, rot: Math.PI / 8 },
    { c: { x: 0, y: 1.25, z: 0 }, r: rBase + 0.05, rot: Math.PI / 8 },
  ];
  const baseG = loft(baseRings, 8, false, false);
  setGeomColor(baseG, PALETTE.stone, 0.12);
  bins.stone.push(baseG);

  // gallery
  const galRings = [
    { c: { x: 0, y: 4.4, z: 0 }, r: rTop + 1.25, rot: Math.PI / 8 },
    { c: { x: 0, y: 4.62, z: 0 }, r: rTop + 1.25, rot: Math.PI / 8 },
  ];
  const gal = loft(galRings, 8, true, true);
  setGeomColor(gal, PALETTE.timber, 0.1);
  bins.timber.push(gal);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    bins.timber.push(box(0.09, 0.85, 0.09, PALETTE.timberDark, {
      x: Math.cos(a) * (rTop + 1.15), y: 5.0, z: Math.sin(a) * (rTop + 1.15), variation: 0.1,
    }));
  }
  const rail = loft([
    { c: { x: 0, y: 5.42, z: 0 }, r: rTop + 1.2, rot: Math.PI / 8 },
    { c: { x: 0, y: 5.54, z: 0 }, r: rTop + 1.2, rot: Math.PI / 8 },
  ], 8, false, false);
  setGeomColor(rail, PALETTE.timberDark, 0.08);
  bins.timber.push(rail);

  // door + windows
  bins.timber.push(box(1.15, 2.15, 0.14, PALETTE.timber, { y: 1.08, z: rBase - 0.02, variation: 0.09 }));
  for (let i = 0; i < 3; i++) {
    const a = rngRange(rng, 0, TAU);
    const y = 3.0 + i * 2.3;
    const r = lerp(rBase, rTop, y / H);
    bins.timber.push(box(0.62, 0.8, 0.12, PALETTE.darkest, {
      x: Math.cos(a) * r, y, z: Math.sin(a) * r, ry: -a, variation: 0.1,
    }));
  }

  // conical cap
  const capRings = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    capRings.push({ c: { x: 0, y: H + t * 2.4, z: 0 }, r: (rTop + 0.35) * Math.pow(1 - t, 0.62), rot: Math.PI / 8 });
  }
  const cap = loft(capRings, 8, false, true);
  setGeomColor(cap, PALETTE.tileDark, 0.1);
  bins.tile.push(cap);

  // tail pole steering the cap into the wind
  bins.timber.push(box(0.16, 0.16, 5.2, PALETTE.timberDark,
    { y: H + 0.9, z: -3.0, rx: 0.28, variation: 0.09 }));

  // --- sails: hub + four lattice frames, returned as their own node so they
  //     can turn. Local +Z faces out of the cap.
  const sailParts = [];
  const hub = cyl(0.35, 0.42, 0.9, 8, PALETTE.timberDark, { rx: Math.PI * 0.5, variation: 0.08 });
  sailParts.push(hub);
  const sailLen = 7.4;
  for (let s = 0; s < 4; s++) {
    const a = (s / 4) * TAU;
    const parts = [];
    parts.push(box(0.20, sailLen, 0.16, PALETTE.timber, { y: sailLen * 0.5 + 0.5, variation: 0.1 }));
    parts.push(box(1.25, 0.12, 0.10, PALETTE.timberDark, { y: sailLen * 0.35, variation: 0.1 }));
    const ribs = 11;
    for (let i = 0; i < ribs; i++) {
      const t = (i + 1) / (ribs + 1);
      const y = 0.6 + t * sailLen;
      const wdt = lerp(1.45, 0.95, t);
      parts.push(box(wdt, 0.075, 0.07, PALETTE.timberDark, { x: wdt * 0.28, y, variation: 0.12 }));
      // canvas panel, furled on two of the four sails
      if (s % 2 === 0 && i % 2 === 0) {
        parts.push(box(wdt * 0.9, (sailLen / ribs) * 0.85, 0.03, PALETTE.plaster,
          { x: wdt * 0.3, y: y + 0.1, z: 0.05, variation: 0.09 }));
      }
    }
    const merged = mergeGeoms(parts);
    tx(merged, { rz: a });
    sailParts.push(merged);
  }
  const sailGeom = mergeGeoms(sailParts);
  worldUV(sailGeom, 0.6);

  colliders.push({
    cx: 0, cy: H * 0.5, cz: 0, hx: rBase * 0.82, hy: H * 0.5, hz: rBase * 0.82, yaw: 0,
    opts: { cover: 1, solid: true, blocksLos: true, tag: 'windmill' },
  });

  return { bins, colliders, sailGeom, sailPivot: { x: 0, y: H + 1.35, z: rTop + 0.55 }, height: H + 2.4 };
}

// ---------------------------------------------------------------------------
// small stuff
// ---------------------------------------------------------------------------

export function buildWell(rng) {
  const bins = newBins();
  const rings = [
    { c: { x: 0, y: 0, z: 0 }, r: 1.05 },
    { c: { x: 0, y: 0.85, z: 0 }, r: 0.98 },
  ];
  const ring = loft(rings, 12, false, false);
  setGeomColor(ring, PALETTE.stone, 0.14);
  bins.stone.push(ring);
  const cop = loft([
    { c: { x: 0, y: 0.85, z: 0 }, r: 1.12 }, { c: { x: 0, y: 0.99, z: 0 }, r: 1.12 },
  ], 12, true, true);
  setGeomColor(cop, PALETTE.stoneWarm, 0.09);
  bins.stone.push(cop);
  for (const s of [-1, 1]) {
    bins.timber.push(box(0.13, 2.3, 0.13, PALETTE.timberDark,
      { x: s * 0.95, y: 1.15, z: 0, rz: -s * 0.08, variation: 0.1 }));
  }
  bins.timber.push(box(2.3, 0.14, 0.14, PALETTE.timberDark, { y: 2.28, variation: 0.09 }));
  bins.timber.push(cyl(0.11, 0.11, 1.7, 8, PALETTE.timber, { y: 2.05, rz: Math.PI * 0.5, variation: 0.08 }));
  const roof = hipRoof(2.9, 2.4, 0.7, 0.22, rng, PALETTE.tileA, PALETTE.tileB);
  roof.translate(0, 2.35, 0);
  bins.tile.push(roof);
  const bucket = cyl(0.26, 0.22, 0.34, 8, PALETTE.timber, { y: 1.5, variation: 0.1 });
  bins.timber.push(bucket);
  const colliders = [{
    cx: 0, cy: 0.5, cz: 0, hx: 1.15, hy: 0.5, hz: 1.15, yaw: 0,
    opts: { cover: 0.7, solid: true, blocksLos: false, tag: 'well' },
  }];
  return { bins, colliders };
}

export function buildCart(rng) {
  const bins = newBins();
  const L = rngRange(rng, 2.6, 3.4), W = 1.5;
  const planks = 6;
  for (let i = 0; i < planks; i++) {
    bins.timber.push(box(W / planks - 0.03, 0.09, L, i % 2 ? PALETTE.timber : PALETTE.timberDark,
      { x: -W * 0.5 + ((i + 0.5) / planks) * W, y: 0.86, z: 0, variation: 0.12 }));
  }
  for (const s of [-1, 1]) {
    bins.timber.push(box(0.09, 0.44, L, PALETTE.timber,
      { x: s * W * 0.5, y: 1.08, z: 0, variation: 0.12 }));
  }
  bins.timber.push(box(W, 0.44, 0.09, PALETTE.timber, { y: 1.08, z: -L * 0.5, variation: 0.12 }));
  // wheels
  for (const s of [-1, 1]) {
    for (const f of [-1, 1]) {
      const r = f > 0 ? 0.62 : 0.5;
      const wheel = cyl(r, r, 0.11, 14, PALETTE.timberDark, {
        x: s * (W * 0.5 + 0.12), y: r, z: f * L * 0.32, rz: Math.PI * 0.5, variation: 0.1,
      });
      bins.timber.push(wheel);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI;
        bins.timber.push(box(0.06, r * 2 * 0.92, 0.06, PALETTE.timber, {
          x: s * (W * 0.5 + 0.12), y: r, z: f * L * 0.32, rx: a, rz: Math.PI * 0.5, variation: 0.1,
        }));
      }
    }
  }
  // shafts
  for (const s of [-1, 1]) {
    bins.timber.push(box(0.1, 0.1, 1.9, PALETTE.timber,
      { x: s * 0.5, y: 0.86, z: L * 0.5 + 0.85, rx: 0.12, variation: 0.1 }));
  }
  const colliders = [{
    cx: 0, cy: 0.6, cz: 0, hx: W * 0.5 + 0.2, hy: 0.6, hz: L * 0.5, yaw: 0,
    opts: { cover: 0.7, solid: true, blocksLos: false, tag: 'cart', destructible: true, hp: 80 },
  }];
  return { bins, colliders };
}

export function buildHayBale(rng, round = true) {
  const bins = newBins();
  if (round) {
    const g = cyl(0.78, 0.78, 1.35, 12, PALETTE.wheat, { rz: Math.PI * 0.5, variation: 0.16 });
    bins.timber.push(g);
  } else {
    bins.timber.push(box(1.6, 0.85, 0.9, PALETTE.wheatDark, { y: 0.42, variation: 0.16 }));
  }
  const colliders = [{
    cx: 0, cy: 0.42, cz: 0, hx: 0.82, hy: 0.42, hz: 0.78, yaw: 0,
    opts: { cover: 0.8, conceal: 0.2, solid: true, blocksLos: true, tag: 'hay', destructible: true, hp: 40 },
  }];
  return { bins, colliders };
}

// ---------------------------------------------------------------------------
// Structures — assembly
// ---------------------------------------------------------------------------

export class Structures {
  constructor(parent, terrain, layout, opts = {}) {
    this.terrain = terrain;
    this.layout = layout;
    this.seed = opts.seed ?? CFG.seed;
    this.rng = makeRng(this.seed ^ 0xb00c);
    this.colliders = [];
    this.platforms = [];          // walkable tops (the bridge deck)
    this.footprints = [];         // for vegetation exclusion
    this.time = 0;

    this.group = new THREE.Group();
    this.group.name = 'structures';
    parent.add(this.group);

    this.bins = newBins();
    this._buildVillage();
    this._buildBridge();
    this._buildWindmill();
    this._buildWalls();
    this._commit();
  }

  /**
   * Push a built unit into the world at (x, z) with a yaw.
   *
   * A building is NOT placed at the ground height of its centre point. On any
   * slope that leaves the downhill corners hanging in the air, which is how a
   * farmhouse ends up standing on stilts with daylight under it. Instead the
   * whole footprint is sampled and the building is TERRACED: the finished floor
   * sits about two thirds of the way up the fall, so the uphill side is cut
   * into the bank and only the downhill side needs a foundation course — which
   * is added, running well below the lowest corner. That is how a rubble-stone
   * farmhouse actually deals with a slope, and it keeps the exposed footing to
   * a course or two instead of a storey-high blank plinth.
   */
  _place(built, x, z, yaw, yOffset = 0) {
    const fp = this._footprintY(x, z, yaw, built.w, built.d);
    const cut = fp ? fp.drop * 0.36 : 0;               // how far into the bank
    const y = (fp ? fp.hi - cut : this.terrain.heightAt(x, z)) + yOffset;
    if (fp && fp.drop > 0.05) this._addFooting(built, fp.drop - cut, yOffset);
    const co = Math.cos(yaw), si = Math.sin(yaw);
    for (const k of BINS) {
      for (const g of built.bins[k]) {
        tx(g, { ry: yaw });
        g.translate(x, y, z);
        this.bins[k].push(g);
      }
    }
    for (const c of built.colliders || []) {
      const wx = x + c.cx * co + c.cz * si;
      const wz = z - c.cx * si + c.cz * co;
      this.colliders.push(makeBox(
        { x: wx, y: y + c.cy, z: wz },
        { x: c.hx, y: c.hy, z: c.hz },
        yaw + (c.yaw || 0),
        c.opts
      ));
    }
    return { x, y, z, yaw };
  }

  /**
   * Ground statistics over a rotated rectangular footprint.
   * @returns {{hi:number, lo:number, drop:number}|null} null if the unit has no
   *   declared footprint (wells, carts, hay bales — they sit on a point).
   */
  _footprintY(x, z, yaw, w, d) {
    if (!(w > 0) || !(d > 0)) return null;
    const co = Math.cos(yaw), si = Math.sin(yaw);
    const hw = w * 0.5 + 0.3, hd = d * 0.5 + 0.3;
    let hi = -Infinity, lo = Infinity;
    const S = 4;
    for (let j = 0; j <= S; j++) {
      const lz = -hd + (2 * hd * j) / S;
      for (let i = 0; i <= S; i++) {
        const lx = -hw + (2 * hw * i) / S;
        const h = this.terrain.heightAt(x + lx * co + lz * si, z - lx * si + lz * co);
        if (h > hi) hi = h;
        if (h < lo) lo = h;
      }
    }
    return { hi, lo, drop: hi - lo };
  }

  /**
   * A rubble-stone footing course that fills the wedge between the finished
   * floor and the fall of the ground. Emitted into the unit's own bins so it is
   * rotated and translated with the rest of the building.
   */
  _addFooting(built, drop, yOffset) {
    const w = built.w + 0.5, d = built.d + 0.5;
    // Top laps over the plinth; the bottom is measured in the unit's OWN frame,
    // whose origin lands at (highest corner + yOffset), and pushed a further
    // 0.7 m under the lowest corner so the course is buried rather than resting
    // on the grass.
    const top = 0.34;
    const bottom = -(drop + yOffset + 0.70);
    const h = top - bottom;
    const g = box(w, h, d, PALETTE.stone, { y: bottom + h * 0.5, variation: 0.11 });
    built.bins.stone.push(g);
    // a chamfered second course, so the base reads as coursed masonry rather
    // than as one extruded slab
    if (drop > 0.55) {
      built.bins.stone.push(box(w + 0.34, Math.min(0.42, h * 0.45), d + 0.34,
        PALETTE.stoneWarm, { y: bottom + Math.min(0.42, h * 0.45) * 0.5, variation: 0.13 }));
    }
  }

  // -----------------------------------------------------------------------

  _buildVillage() {
    const rng = this.rng;
    const V = this.layout.village;
    const road = this.layout.road;
    const placed = [];

    // Candidate plots: two rows flanking the street through the village, plus
    // a back lane. Buildings face the street.
    const cands = [];
    for (let i = 0; i < road.n; i++) {
      const x = road.x[i], z = road.z[i];
      if (Math.hypot(x - V.x, z - V.z) > V.r * 1.05) continue;
      if (i % 3 !== 0) continue;
      const j = Math.min(road.n - 2, Math.max(0, i - 1));
      let tx0 = road.x[j + 1] - road.x[j], tz0 = road.z[j + 1] - road.z[j];
      const tl = Math.hypot(tx0, tz0) || 1;
      const nx = -tz0 / tl, nz = tx0 / tl;
      for (const side of [-1, 1]) {
        for (const rank of [0, 1]) {
          const off = side * (this.layout.roadHalfWidth(i / road.n) + 4.6 + rank * 11.5);
          cands.push({
            x: x + nx * off + rngRange(rng, -1.2, 1.2),
            z: z + nz * off + rngRange(rng, -1.2, 1.2),
            yaw: Math.atan2(-nx * side, -nz * side),
          });
        }
      }
    }
    // a few outliers around the edge of the pad
    for (let i = 0; i < 8; i++) {
      const a = rng() * TAU;
      const r = V.r * rngRange(rng, 0.55, 0.95);
      const x = V.x + Math.cos(a) * r, z = V.z + Math.sin(a) * r;
      cands.push({ x, z, yaw: Math.atan2(V.x - x, V.z - z) + rngRange(rng, -0.4, 0.4) });
    }

    let count = 0;
    for (const c of cands) {
      if (count >= 13) break;
      if (!this.terrain.inBounds(c.x, c.z)) continue;
      if (this.terrain.heightAt(c.x, c.z) < WATER_Y + 1.0) continue;
      if (this.terrain.maxSlopeNear(c.x, c.z, 3.5) > 0.42) continue;
      const riv = this.layout.riverSDF(c.x, c.z);
      if (riv.d < this.layout.riverHalfWidth(riv.t) + 8) continue;
      let clash = false;
      for (const p of placed) {
        if (Math.hypot(p.x - c.x, p.z - c.z) < p.r + 8.2) { clash = true; break; }
      }
      if (clash) continue;

      const kind = rng() < 0.18 ? 'barn' : 'house';
      const shelled = rng() < 0.42;
      const built = kind === 'barn'
        ? buildBarn(rng, {})
        : buildFarmhouse(rng, { shelled });
      this._place(built, c.x, c.z, c.yaw, -0.15);
      const r = Math.max(built.w, built.d) * 0.5 + 0.6;
      placed.push({ x: c.x, z: c.z, r });
      this.footprints.push({ x: c.x, z: c.z, r: r + 1.4 });
      count++;
    }

    // village well on the square
    const wx = V.x + rngRange(rng, -4, 4), wz = V.z + rngRange(rng, -4, 4);
    this._place(buildWell(rng), wx, wz, rng() * TAU);
    this.footprints.push({ x: wx, z: wz, r: 2.4 });

    // carts and hay in the yards
    for (let i = 0; i < 5; i++) {
      const a = rng() * TAU, r = V.r * rngRange(rng, 0.3, 0.95);
      const x = V.x + Math.cos(a) * r, z = V.z + Math.sin(a) * r;
      if (!this.terrain.inBounds(x, z)) continue;
      if (this.terrain.slopeAt(x, z) > 0.35) continue;
      this._place(rng() < 0.5 ? buildCart(rng) : buildHayBale(rng, rng() < 0.6), x, z, rng() * TAU);
      this.footprints.push({ x, z, r: 2.6 });
    }
    // a stack of bales out by the fields
    for (const f of this.layout.fields) {
      if (f.type !== 'wheat') continue;
      for (let i = 0; i < 4; i++) {
        const x = f.x + rngRange(rng, -f.rx * 0.8, f.rx * 0.8);
        const z = f.z + rngRange(rng, -f.rz * 0.8, f.rz * 0.8);
        if (!this.terrain.inBounds(x, z)) continue;
        if (this.terrain.slopeAt(x, z) > 0.3) continue;
        this._place(buildHayBale(rng, true), x, z, rng() * TAU);
        this.footprints.push({ x, z, r: 1.9 });
      }
    }
  }

  _buildBridge() {
    const b = this.layout.bridge;
    const bedY = WATER_Y - 2.1;
    const built = buildBridge(this.rng, b.length, b.width, b.deckY, bedY, WATER_Y);
    // The bridge's local +Z runs along the road; buildBridge works with the
    // deck top at y = 0, so we place it at the carved deck elevation.
    const co = Math.cos(b.yaw), si = Math.sin(b.yaw);
    for (const k of BINS) {
      for (const g of built.bins[k]) {
        tx(g, { ry: b.yaw });
        g.translate(b.x, b.deckY, b.z);
        this.bins[k].push(g);
      }
    }
    for (const c of built.colliders) {
      const wx = b.x + c.cx * co + c.cz * si;
      const wz = b.z - c.cx * si + c.cz * co;
      this.colliders.push(makeBox(
        { x: wx, y: b.deckY + c.cy, z: wz },
        { x: c.hx, y: c.hy, z: c.hz },
        b.yaw + (c.yaw || 0), c.opts
      ));
    }
    // walkable deck
    this.platforms.push({
      x: b.x, z: b.z, yaw: b.yaw,
      hx: b.width * 0.5 - 0.55, hz: b.length * 0.5,
      topY: b.deckY + 0.07,
      tag: 'bridge',
    });
    this.footprints.push({ x: b.x, z: b.z, r: b.length * 0.5 });
    this.bridgeInfo = { ...b };
  }

  _buildWindmill() {
    const w = this.layout.windmill;
    const built = buildWindmill(this.rng);
    this._place(built, w.x, w.z, w.yaw, -0.2);
    this.footprints.push({ x: w.x, z: w.z, r: 5.5 });

    // sails live on their own node so they can turn
    const y = this.terrain.heightAt(w.x, w.z) - 0.2;
    const p = built.sailPivot;
    const co = Math.cos(w.yaw), si = Math.sin(w.yaw);
    this.sailPivotWorld = new THREE.Vector3(
      w.x + p.x * co + p.z * si, y + p.y, w.z - p.x * si + p.z * co
    );
    this.sailGeom = built.sailGeom;
    this.sailYaw = w.yaw;
  }

  _buildWalls() {
    const rng = this.rng;
    const V = this.layout.village;
    // dry-stone boundary walls along two field edges near the village
    for (let k = 0; k < 3; k++) {
      const a0 = rngRange(rng, 0, TAU);
      const len = rngRange(rng, 14, 26);
      const x0 = V.x + Math.cos(a0) * V.r * 0.8;
      const z0 = V.z + Math.sin(a0) * V.r * 0.8;
      const dir = a0 + Math.PI * 0.5 + rngRange(rng, -0.4, 0.4);
      const pts = [];
      const segs = Math.max(3, Math.round(len / 2.2));
      let ok = true;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const x = x0 + Math.cos(dir) * len * t + Math.sin(dir) * (valueNoise2(t * 4, k, 77) - 0.5) * 1.4;
        const z = z0 + Math.sin(dir) * len * t - Math.cos(dir) * (valueNoise2(t * 4, k, 77) - 0.5) * 1.4;
        if (!this.terrain.inBounds(x, z) || this.terrain.heightAt(x, z) < WATER_Y + 0.8) { ok = false; break; }
        const y = this.terrain.heightAt(x, z);
        pts.push({ x, z, y0: y - 0.5, y1: y + rngRange(rng, 0.85, 1.25) });
      }
      if (!ok || pts.length < 3) continue;
      const wall = ribbonWall(pts, 0, 1, 0.55);
      setGeomColor(wall, PALETTE.stone, 0.15, rng);
      this.bins.stone.push(wall);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        const top = (a.y1 + b.y1) * 0.5;
        const gy = this.terrain.heightAt(mx, mz);
        this.colliders.push(makeBox(
          { x: mx, y: (gy + top) * 0.5, z: mz },
          { x: l * 0.5 + 0.1, y: Math.max(0.3, (top - gy) * 0.5), z: 0.3 },
          Math.atan2(b.z - a.z, b.x - a.x),
          { cover: 1, solid: true, blocksLos: true, tag: 'wall', destructible: true, hp: 160 }
        ));
      }
    }

    // post-and-rail fencing along a stretch of the farm track
    const track = this.layout.track;
    for (const side of [-1, 1]) {
      const posts = [];
      for (let i = 2; i < track.n - 2; i += 2) {
        let tx0 = track.x[i + 1] - track.x[i - 1], tz0 = track.z[i + 1] - track.z[i - 1];
        const tl = Math.hypot(tx0, tz0) || 1;
        const nx = -tz0 / tl, nz = tx0 / tl;
        const off = side * rngRange(rng, 2.6, 3.4);
        const x = track.x[i] + nx * off, z = track.z[i] + nz * off;
        if (!this.terrain.inBounds(x, z)) continue;
        if (this.terrain.heightAt(x, z) < WATER_Y + 0.6) continue;
        if (valueNoise2(x * 0.3, z * 0.3, 13) > 0.82) { posts.length = 0; continue; }
        const y = this.terrain.heightAt(x, z);
        posts.push({ x, y, z });
        this.bins.timber.push(box(0.13, 1.35, 0.13, PALETTE.timberDark,
          { x, y: y + 0.55, z, ry: rng() * 0.4, rz: rngRange(rng, -0.06, 0.06), variation: 0.12 }));
      }
      for (let i = 0; i < posts.length - 1; i++) {
        const a = posts[i], b = posts[i + 1];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        if (l > 6) continue;
        for (const hy of [0.55, 1.02]) {
          const g = box(l, 0.09, 0.06, PALETTE.timber, { variation: 0.13 });
          tx(g, { ry: -Math.atan2(b.z - a.z, b.x - a.x) });
          g.translate((a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + hy, (a.z + b.z) * 0.5);
          this.bins.timber.push(g);
        }
        this.colliders.push(makeBox(
          { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 + 0.7, z: (a.z + b.z) * 0.5 },
          { x: l * 0.5, y: 0.7, z: 0.12 },
          Math.atan2(b.z - a.z, b.x - a.x),
          { cover: 0.35, solid: true, blocksLos: false, tag: 'fence', destructible: true, hp: 25 }
        ));
      }
    }
  }

  // -----------------------------------------------------------------------

  _commit() {
    const mats = {
      stucco: makeSurfaceMaterial({ color: 0xffffff, vertexColors: true, map: stuccoTexture(23), rim: 0.5 }),
      stone: makeSurfaceMaterial({ color: 0xffffff, vertexColors: true, map: stoneTexture(31), rim: 0.45 }),
      tile: makeSurfaceMaterial({ color: 0xffffff, vertexColors: true, rim: 0.55, hatch: 0.8 }),
      timber: makeSurfaceMaterial({ color: 0xffffff, vertexColors: true, map: woodTexture(41), rim: 0.4 }),
      metal: makeSurfaceMaterial({ color: 0xffffff, vertexColors: true, rim: 0.8 }),
    };
    const uvScale = { stucco: 0.34, stone: 0.42, tile: 0.5, timber: 0.75, metal: 0.5 };
    this.materials = mats;
    this.meshes = [];
    for (const k of BINS) {
      if (!this.bins[k].length) continue;
      const g = mergeGeoms(this.bins[k]);
      worldUV(g, uvScale[k]);
      for (const src of this.bins[k]) src.dispose();
      const m = new THREE.Mesh(g, mats[k]);
      m.name = `structures:${k}`;
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.outline = true;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.meshes.push(m);
      this.bins[k] = [];
    }

    // windmill sails
    if (this.sailGeom) {
      this.sailMesh = new THREE.Mesh(this.sailGeom, mats.timber);
      this.sailMesh.name = 'windmill-sails';
      this.sailMesh.castShadow = true;
      this.sailMesh.receiveShadow = true;
      this.sailMesh.userData.outline = true;
      this.sailMesh.position.copy(this.sailPivotWorld);
      this.sailMesh.rotation.set(0, this.sailYaw, 0);
      this.group.add(this.sailMesh);
      this.sailSpin = 0;
    }
  }

  /** Vegetation exclusion test: is (x,z) inside a building footprint? */
  occupied(x, z) {
    for (let i = 0; i < this.footprints.length; i++) {
      const f = this.footprints[i];
      const dx = x - f.x, dz = z - f.z;
      if (dx * dx + dz * dz < f.r * f.r) return true;
    }
    return false;
  }

  update(dt, windGain = 1) {
    this.time += dt;
    if (this.sailMesh) {
      // A mill under load turns at roughly 10-20 rpm; scale with the wind.
      this.sailSpin += dt * (0.34 + windGain * 0.42);
      this.sailMesh.rotation.set(0, this.sailYaw, 0);
      this.sailMesh.rotateZ(this.sailSpin);
    }
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    this.sailMesh?.geometry.dispose();
    for (const k of BINS) this.materials[k]?.dispose();
    this.group.parent?.remove(this.group);
  }
}
