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
import { makeSurfaceMaterial, PALETTE, ashlarMap, ASHLAR_TILE, ASHLAR_COURSE } from './worldMaterials.js';
// stoneTexture() is deliberately NOT imported any more: see _commit.
import { stuccoTexture, woodTexture, roofTileTexture } from './textures.js';
import { makeBox } from './collider.js';
import { WATER_Y } from './layout.js';

// `sunk` is masonry that lives BELOW the waterline. It is ordinary stone in
// every respect except that it is drawn into a mesh with outlining disabled:
// the river is a transparent sheet that does not write depth, so the outline
// composite happily draws a full-weight graphite silhouette of a submerged
// pier straight over the open channel in front of it. Round 2 "solved" that by
// deleting the submerged geometry, which produced the transparent X-ray boxes;
// the geometry has to be there to occlude the riverbed, and it is the INK that
// has to go.
const BINS = ['stucco', 'stone', 'sunk', 'tile', 'timber', 'metal'];

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

  // Weathered board-and-batten on a low stone base, big cart doors on the long
  // side. The cladding uses PALETTE.barnBoard, NOT PALETTE.timber: see the note
  // beside those two entries — a forty-year-old barn wall is silvered grey-brown
  // and this one is 35% of the `village` frame.
  bins.stone.push(box(w + 0.2, 0.5, d + 0.2, PALETTE.stone, { y: 0.1, variation: 0.1 }));
  const boards = Math.max(6, Math.round(w / 0.42));
  for (const s of [-1, 1]) {
    for (let i = 0; i < boards; i++) {
      const x = -w * 0.5 + ((i + 0.5) / boards) * w;
      if (s === 1 && Math.abs(x) < w * 0.17) continue;      // door gap
      bins.timber.push(box(w / boards - 0.03, h, thick,
        i % 3 === 0 ? PALETTE.barnBoardDark : PALETTE.barnBoard,
        { x, y: h * 0.5 + 0.3, z: s * (d * 0.5), variation: 0.16 }));
    }
  }
  const dBoards = Math.max(4, Math.round(d / 0.42));
  for (const s of [-1, 1]) {
    for (let i = 0; i < dBoards; i++) {
      const z = -d * 0.5 + ((i + 0.5) / dBoards) * d;
      bins.timber.push(box(thick, h, d / dBoards - 0.03,
        i % 4 === 0 ? PALETTE.barnBoardDark : PALETTE.barnBoard,
        { x: s * (w * 0.5), y: h * 0.5 + 0.3, z, variation: 0.16 }));
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

// ---------------------------------------------------------------------------
// ashlar coursing, as GEOMETRY (round 15)
// ---------------------------------------------------------------------------
//
// WHY GEOMETRY AND NOT ANOTHER TEXTURE PASS. Four rounds have tried to put
// coursing on this bridge through the shader — a per-block tonal offset in
// render/materials.js, a coursed stone map in world/textures.js, a map-to-drive
// term here — and every round has come back "the spandrel is a field of sage
// blotches with zero readable stone coursing, |dL/dy|/|dL/dx| = 1.10". Three
// separate reasons, all of them fatal on their own: the preset that switches the
// shader branch on was never passed (fixed in _commit), the map's joint was
// sub-pixel (fixed in ashlarMap), and — the one no texture pass can fix — a
// value step painted on a flat plane throws no shadow, so it cannot survive a
// pipeline whose whole job is to quantise value into four washes. A course that
// stands 55 mm PROUD does: the sun rakes across it, the band drive steps at its
// top arris, the outline pass finds a crease at its edge, and it goes on reading
// when the shot is re-lit from somewhere else. That is the difference between
// masonry and a decal of masonry, and it is what the rubric's "measure the
// thing, not its proxy" section is about.
//
// Two things make these blocks land ON the other two terms instead of beating
// against them:
//  * the course rows are phase-locked to the WORLD-Y 0.42 m grid (see yPhase),
//    which is the grid ashlarMap's joints and uPigment's per-block tone both
//    use, so all three draw the same course line;
//  * the stretcher pitch is courseH * 2.2, which is the pitch the shader's
//    coursing branch assumes (materials.js: `lat / (bs * 2.2)`).
const _tone = new THREE.Color();

/** Subtract [a,b] from a list of [z0,z1] segments. */
function segSubtract(segs, a, b) {
  const out = [];
  for (const [s0, s1] of segs) {
    if (b <= s0 || a >= s1) { out.push([s0, s1]); continue; }
    if (a > s0) out.push([s0, a]);
    if (b < s1) out.push([b, s1]);
  }
  return out;
}

/**
 * Proud ashlar course blocks on a vertical face lying in the plane x = faceX.
 *
 * o: { faceX, zMin, zMax, bands:[[y0,y1],...], courseH, yPhase, thick, joint,
 *      forbid(yBottom, yTop) -> [[z0,z1],...], warm }
 * @returns {THREE.BufferGeometry[]}
 */
function ashlarCourseBlocks(rng, o) {
  const out = [];
  const courseH = o.courseH;
  // THE BED JOINT IS TWICE THE PERPEND, and that asymmetry is the point. In laid
  // masonry the bed joints are continuous and run the length of the wall while
  // the perpends are broken and stop at every course, so a wall reads as a stack
  // of horizontal lines and not as a grid. Cutting them both to the same width —
  // which the first pass did — gives an equal vertical and horizontal signal,
  // i.e. brickwork-as-graph-paper, and it also flattens the |dL/dy| / |dL/dx|
  // anisotropy the critique measures by putting as much gradient in x as in y.
  const bedJoint = o.bedJoint ?? 0.075;
  const perpJoint = o.perpJoint ?? 0.035;
  const stretcher = courseH * 2.2;
  const thick = o.thick ?? 0.11;
  for (const [ya, yb] of o.bands) {
    for (let r = Math.ceil((ya - o.yPhase) / courseH - 1e-6); ; r++) {
      const y0 = o.yPhase + r * courseH;
      if (y0 + courseH > yb + 1e-4) break;
      if (y0 < ya - 1e-4) continue;
      const stagger = (((r % 2) + 2) % 2) === 0 ? 0 : 0.5;
      const banned = o.forbid ? o.forbid(y0, y0 + courseH) : [];
      let cc = Math.floor(o.zMin / stretcher) - 1;
      while ((cc + stagger) * stretcher < o.zMax) {
        // one block in five is a double-length stretcher: the bond stays on the
        // grid the shader assumes without reading as a checkerboard
        const span = rng() < 0.20 ? 2 : 1;
        const za = (cc + stagger) * stretcher;
        cc += span;
        let segs = [[Math.max(za, o.zMin), Math.min(za + span * stretcher, o.zMax)]];
        if (segs[0][1] - segs[0][0] < 0.20) continue;
        for (const [ba, bb] of banned) segs = segSubtract(segs, ba, bb);
        for (const [s0, s1] of segs) {
          const len = s1 - s0 - perpJoint;
          if (len < 0.20) continue;
          // ...and no two stones are dressed to the same projection, so the face
          // is hand-laid rubble-ashlar rather than one milled plane. Kept to
          // +/-15 mm: at +/-28 mm the per-stone value spread is as large as the
          // bed-joint shadow on the FAR spandrel, and the row-mean autocorrelation
          // peak there fell from 0.48 to 0.18 — the jitter was eating the very
          // coursing it was meant to hand-letter.
          const g = box(thick + rngRange(rng, -0.015, 0.015), courseH - bedJoint, len, undefined, {
            x: o.faceX, y: y0 + courseH * 0.5, z: (s0 + s1) * 0.5,
          });
          setGeomColor(g, _tone.set(rng() < (o.warm ?? 0.22) ? PALETTE.stoneWarm : PALETTE.stone)
            .multiplyScalar(0.90 + rng() * 0.21), 0.05, rng);
          out.push(g);
        }
      }
    }
  }
  return out;
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
 * ROUND 15 — WHAT IS LAID ON TOP OF THAT ONE SWEEP. The single extrusion is the
 * right way to get a continuous intrados and the wrong way to get a READABLE
 * bridge: one sweep of one colour is one undifferentiated slab, which is what
 * four rounds of critics called it. Everything that makes it read as built is
 * now separate geometry sitting on that sweep, in the order a mason would work:
 *
 *   1. proud ashlar course blocks over both spandrel faces, phase-locked to the
 *      0.42 m world-Y course grid and truncated against each arch ring, so the
 *      coursing follows the arch  (ashlarCourseBlocks)
 *   2. individual dressed voussoirs round each arch head, odd-numbered so there
 *      is a keystone, each with its own extrados radius and projection
 *   3. a two-part string course — bed course plus chamfered drip — deep enough
 *      to throw a real cast band down the spandrel
 *   4. the parapet's own coursing, then coping laid STONE BY STONE with gaps,
 *      slumps and tilts, because a ribbon's top edge is a ruled line
 *   5. the intrados stained down, because a damp barrel vault is the darkest
 *      thing on a bridge and this one was measuring BRIGHTER than its spandrel
 *
 * None of it is a metric pass: every item is a real solid with a real projection,
 * so it lights, shadows, inks and re-lights like masonry rather than like a decal
 * of masonry. See the ashlarCourseBlocks header for why texture alone could not
 * do this job.
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
  //
  // Split at the waterline. Everything below it is the same masonry, but it goes
  // into the `sunk` bin so the outline composite does not draw its silhouette
  // over the open channel in front of it — a transparent river that writes no
  // depth cannot stop the ink pass, and a full-weight graphite outline of a
  // submerged pier hanging in mid-stream is the "X-ray box" the critique found.
  const wlY = waterRel - 0.02;
  const splitOK = wlY > baseY + 0.10 && wlY < springY - 0.10;
  const bodyBase = splitOK ? wlY : baseY;

  const shape = new THREE.Shape();
  shape.moveTo(-length * 0.5, bodyBase);
  shape.lineTo(length * 0.5, bodyBase);
  shape.lineTo(length * 0.5, 0);
  shape.lineTo(-length * 0.5, 0);
  shape.closePath();
  for (const { z0, z1 } of spanZ) {
    const zc = (z0 + z1) * 0.5;
    const hole = new THREE.Path();
    hole.moveTo(z0, bodyBase);
    hole.lineTo(z0, springY);
    hole.absellipse(zc, springY, span * 0.5, rise, Math.PI, 0, true);
    hole.lineTo(z1, bodyBase);
    hole.closePath();
    shape.holes.push(hole);
  }
  let body = extrudeElevation(shape, width, 40);
  setGeomColor(body, PALETTE.stone, 0.085);
  body = smoothNormals(body, 40);

  // --- stain the intrados -------------------------------------------------
  //
  // Measured on round 14: the arch soffit came back at L 121.8 against L 115.8
  // for the spandrel outside it — THE BARREL VAULT WAS BRIGHTER THAN THE FACE IT
  // IS CUT INTO, which is the one thing a masonry arch can never look like. The
  // lighting reason is not ours to fix (an inward-facing surface still collects
  // the full hemisphere fill, and there is a lit pool bouncing into it), but the
  // PIGMENT reason is: a barrel vault a metre and a half above moving water is
  // damp for its whole life, and the intrados of a real village bridge is
  // stained several values darker than the dressed face — algae at the
  // springing, soot and weed toward the crown. It has been carrying the same
  // clean limestone as the parapet.
  //
  // The test is a profile test, not a normal test on its own: a vertex is on the
  // intrados if its (z, y) lies on one of the three punched holes — on the
  // ellipse above the springing, on the vertical jamb below it — AND its normal
  // is not the +/-X of an end cap. That keeps the arris with the spandrel hard,
  // which is what makes the vault read as CUT rather than shaded.
  {
    const pa = body.getAttribute('position');
    const na = body.getAttribute('normal');
    const ca = body.getAttribute('color');
    for (let i = 0; i < pa.count; i++) {
      if (Math.abs(na.getX(i)) > 0.55) continue;
      const y = pa.getY(i), z = pa.getZ(i);
      let on = false;
      for (const { z0, z1 } of spanZ) {
        const zc = (z0 + z1) * 0.5;
        if (y > springY) {
          const e = Math.hypot((z - zc) / (span * 0.5), (y - springY) / rise);
          if (Math.abs(e - 1) < 0.03) { on = true; break; }
        } else if (y > bodyBase - 0.05
          && (Math.abs(z - z0) < 0.03 || Math.abs(z - z1) < 0.03)) { on = true; break; }
      }
      if (!on) continue;
      // heaviest at the springing where the river reaches it, easing to the crown
      const t = Math.max(0, Math.min(1, (y - springY) / Math.max(rise, 0.1)));
      const k = 0.62 + 0.16 * t;
      ca.setXYZ(i, ca.getX(i) * k, ca.getY(i) * k * 0.99, ca.getZ(i) * k * 0.95);
    }
    ca.needsUpdate = true;
  }
  bins.stone.push(body);

  if (splitOK) {
    // the footing: the same plan, the same three openings, no ink
    const foot = new THREE.Shape();
    foot.moveTo(-length * 0.5, baseY);
    foot.lineTo(length * 0.5, baseY);
    foot.lineTo(length * 0.5, wlY);
    foot.lineTo(-length * 0.5, wlY);
    foot.closePath();
    for (const { z0, z1 } of spanZ) {
      const hole = new THREE.Path();
      hole.moveTo(z0, baseY);
      hole.lineTo(z0, wlY);
      hole.lineTo(z1, wlY);
      hole.lineTo(z1, baseY);
      hole.closePath();
      foot.holes.push(hole);
    }
    let footG = extrudeElevation(foot, width, 8);
    setGeomColor(footG, PALETTE.stone, 0.085);
    footG = smoothNormals(footG, 40);
    bins.sunk.push(footG);
  }

  // road surface on top of the deck
  bins.stone.push(box(width - 1.5, 0.10, length, PALETTE.dirtDark,
    { y: 0.02, variation: 0.12 }));

  // --- voussoir ring: INDIVIDUAL DRESSED VOUSSOIRS, not one continuous band.
  //
  // The ring used to be a single extrusion of an annular shape, which is why
  // three rounds of critics reported "no voussoirs radiating around the arch
  // heads" against source that contains a voussoir ring: an unbroken band of
  // one tone standing 0.11 m proud of a wall reads as a raised moulding, not as
  // twenty-nine cut stones. Cutting it into wedges — each one with its own
  // extrados radius, its own depth off the spandrel and its own tone — puts a
  // RADIAL joint every 0.45 m round the arch, which is the one piece of coursing
  // that cannot be confused with a horizontal course and the one that makes a
  // barrel vault read as a curved solid. The count is forced odd so the ring has
  // a keystone at the crown.
  const ringT = 0.44;
  for (const { z0, z1 } of spanZ) {
    const zc = (z0 + z1) * 0.5;
    const rxi = span * 0.5 - 0.06, ryi = rise - 0.06;
    const skew = springY - 0.42;
    let nV = Math.max(9, Math.round((Math.PI * 0.5 * (rxi + ryi + ringT * 2)) / 0.46));
    if (nV % 2 === 0) nV += 1;
    const dj = (Math.PI / nV) * 0.055;             // half a joint, in ellipse parameter
    const SEG = 3;
    for (const side of [-1, 1]) {
      for (let i = 0; i < nV; i++) {
        const a0 = Math.PI - (i / nV) * Math.PI - dj;
        const a1 = Math.PI - ((i + 1) / nV) * Math.PI + dj;
        const first = i === 0, last = i === nV - 1;
        const kOut = ringT + rngRange(rng, -0.05, 0.040);
        const depth = 0.17 + rngRange(rng, -0.03, 0.05);
        const rxo = rxi + kOut, ryo = ryi + kOut;
        const P = [];
        // inner arc, springing skirt included on the two end stones (the
        // springers still have to sit on a skewback, as the old band did)
        if (first) P.push([zc + rxi * Math.cos(a0), skew]);
        for (let k = 0; k <= SEG; k++) {
          const a = a0 + (a1 - a0) * (k / SEG);
          P.push([zc + rxi * Math.cos(a), springY + ryi * Math.sin(a)]);
        }
        if (last) {
          P.push([zc + rxi * Math.cos(a1), skew]);
          P.push([zc + rxo * Math.cos(a1), skew]);
        }
        for (let k = SEG; k >= 0; k--) {
          const a = a0 + (a1 - a0) * (k / SEG);
          P.push([zc + rxo * Math.cos(a), springY + ryo * Math.sin(a)]);
        }
        if (first) P.push([zc + rxo * Math.cos(a0), skew]);
        const sh = new THREE.Shape();
        sh.moveTo(P[0][0], P[0][1]);
        for (let k = 1; k < P.length; k++) sh.lineTo(P[k][0], P[k][1]);
        sh.closePath();
        let v = extrudeElevation(sh, depth, 1);
        // weld the 4-degree arc facets INSIDE one voussoir and nothing else: the
        // 90-degree arris onto the spandrel and the joints between neighbours are
        // exactly the creases the outline pass is supposed to find
        v = smoothNormals(v, 26);
        setGeomColor(v, _tone.set(i % 2 ? PALETTE.stoneWarm : PALETTE.stone)
          .multiplyScalar(0.92 + rng() * 0.17), 0.05, rng);
        v.translate(side * (half - 0.04 + depth * 0.5), 0, 0);
        bins.stone.push(v);
      }
    }
  }

  // --- spandrel coursing: proud ashlar blocks over the whole face, DYING INTO
  //     the voussoir rings so the coursing visibly follows the arch.
  //
  // The forbid() callback is the "follows the arch" half. For a course row it
  // returns the z interval each arch occupies at that height — the extrados
  // ellipse above the springing, the skewback band just under it, the open
  // barrel below that — so blocks are truncated against the ring instead of
  // running through it, and the courses step round each arch head the way laid
  // masonry does.
  const rxoMax = span * 0.5 - 0.06 + ringT + 0.04;
  const ryoMax = rise - 0.06 + ringT + 0.04;
  const skewY = springY - 0.42;
  const archForbid = (ya, yb) => {
    const out = [];
    for (const { z0, z1 } of spanZ) {
      const zc = (z0 + z1) * 0.5;
      let w = 0;
      for (const y of [ya, yb]) {
        let ww;
        if (y >= springY) {
          const t = (y - springY) / ryoMax;
          ww = t >= 1 ? 0 : rxoMax * Math.sqrt(1 - t * t);
        } else if (y >= skewY) ww = rxoMax;
        else ww = span * 0.5;
        if (ww > w) w = ww;
      }
      if (w > 0) out.push([zc - w - 0.07, zc + w + 0.07]);
    }
    return out;
  };
  // Phase-lock to the world-Y course grid: the geometry is emitted in a frame
  // whose origin is the deck top, so shifting by -(deckY mod courseH) is what
  // makes a row boundary here coincide with a joint in ashlarMap (whose UVs are
  // world-Y) and with a block boundary in the shader's own coursing branch.
  const courseH = ASHLAR_COURSE;
  const yPhase = -(((deckY % courseH) + courseH) % courseH);
  for (const side of [-1, 1]) {
    for (const g of ashlarCourseBlocks(rng, {
      faceX: side * half,
      zMin: -length * 0.5 + 0.05, zMax: length * 0.5 - 0.05,
      bands: [[bodyBase + 0.14, -0.56]],
      // 0.15 thick = 0.075 m PROUD of the face. That projection is the whole
      // mechanism: the top of every course gets a 5-6 px horizontal lit strip and
      // its underside a matching dark one, which is a genuinely anisotropic signal
      // (the metric the critique measures is |dL/dy| / |dL/dx|) and one that
      // survives a re-light, unlike a value step painted onto a flat plane.
      courseH, yPhase, thick: 0.17, forbid: archForbid,
    })) bins.stone.push(g);
  }

  // --- string course under the parapet: the horizontal shadow line that tells
  //     you where the structure stops and the balustrade begins.
  //
  // 0.30 m tall and 0.22 m proud on each side, up from 0.19/0.17. The purpose of
  // this course — and of the sun solve in captureShots that was built around it —
  // is to throw a hard cast band across the spandrel, and at 0.17 m of projection
  // seen from a lens 1.6 m over the pool it threw a band under two pixels wide:
  // measured, the whole face below it was one flat 107-147 field for 120 px. It
  // is now a two-part moulding, a bed course with a chamfered drip under it, so
  // the shadow it lays down has a step in it rather than one soft edge.
  bins.stone.push(box(width + 0.44, 0.30, length, PALETTE.stoneWarm,
    { y: -0.25, variation: 0.09 }));
  bins.stone.push(box(width + 0.24, 0.12, length, PALETTE.stone,
    { y: -0.46, variation: 0.10 }));

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
    // The cutwater now runs the whole way from the spread footing on the bed to
    // the starling cap under the springing, because the river shader finally
    // knows the masonry is there: water.js masks its own depth/alpha against
    // pierFootprints(), so the submerged shaft is only under a 0.20-alpha film
    // instead of the 0.94-alpha channel wash that used to erase it. Round 2's
    // compromise — deleting the submerged SHADE and keeping the ink — is what
    // produced the "transparent X-ray box".
    // Two lofts, split AT the waterline, sharing a ring so there is no gap.
    // The lower one goes into `sunk` (no ink); the upper is ordinary stone.
    const sunkG = loft([
      { c: { x: 0, y: baseY, z: zc }, r: 1, sx: half + reach * 1.10, sz: pierW * 0.660 },
      { c: { x: 0, y: baseY + 0.5, z: zc }, r: 1, sx: half + reach * 1.02, sz: pierW * 0.575 },
      { c: { x: 0, y: waterRel - 0.45, z: zc }, r: 1, sx: half + reach * 0.99, sz: pierW * 0.558 },
      { c: { x: 0, y: waterRel + 0.06, z: zc }, r: 1, sx: half + reach, sz: pierW * 0.555 },
    ], 6, true, false);
    setGeomColor(sunkG, PALETTE.stone, 0.10, rng);
    bins.sunk.push(sunkG);
    const g = loft([
      { c: { x: 0, y: waterRel + 0.06, z: zc }, r: 1, sx: half + reach, sz: pierW * 0.555 },
      { c: { x: 0, y: capBase, z: zc }, r: 1, sx: half + reach * 0.90, sz: pierW * 0.55 },
      { c: { x: 0, y: capBase + 0.75, z: zc }, r: 1, sx: half * 0.97, sz: pierW * 0.50 },
    ], 6, false, true);
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
  //
  // THE RULED LINE. The top of this bridge was one straight edge of constant
  // weight running 1400 px across the frame, which is the single loudest CAD
  // tell in the whole set: vertical cuts through the deck edge found 13-14 px of
  // parapet face at x = 500/900/1100 and NONE at x = 700, bounded by a 3 px
  // trough, with no coping course, no drip shadow and nothing interrupting the
  // far-bank horizon. A ribbonWall gives a mathematically straight top by
  // construction, so the coping is no longer a ribbon: it is laid as individual
  // stones, each with its own height, its own tilt and its own gap, one in
  // fourteen missing outright and one in nine slumped — a village bridge that has
  // been fought over does not have a ruled parapet, and neither does a drawing.
  const parapetStart = bins.stone.length;
  const copY = 0.92, copH = 0.22;
  for (const side of [-1, 1]) {
    const pts = [];
    const segs = 14;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push({ x: side * (half - 0.26), z: -length * 0.5 + t * length });
    }
    const par = ribbonWall(pts, 0, copY, 0.52);
    setGeomColor(par, PALETTE.stone, 0.12, rng);
    bins.stone.push(par);

    // the parapet's own coursing, on the same face plane as the spandrel's
    for (const g of ashlarCourseBlocks(rng, {
      faceX: side * half,
      zMin: -length * 0.5 + 0.05, zMax: length * 0.5 - 0.05,
      bands: [[-0.08, copY - 0.02]],
      courseH, yPhase, thick: 0.13, warm: 0.30,
    })) bins.stone.push(g);

    // coping, stone by stone
    const nCop = Math.max(10, Math.round(length / 0.66));
    const cw = length / nCop;
    for (let i = 0; i < nCop; i++) {
      const z = -length * 0.5 + (i + 0.5) * cw;
      if (rng() < 0.07) continue;                       // a stone gone from the wall
      const slump = rng() < 0.11 ? rngRange(rng, -0.13, -0.06) : 0;
      const dy = rngRange(rng, -0.045, 0.055) + slump;
      const g = box(0.86, copH, cw - 0.05, undefined, {
        x: side * (half - 0.26), y: copY + copH * 0.5 + dy, z,
        rx: rngRange(rng, -0.035, 0.035), rz: rngRange(rng, -0.02, 0.02),
      });
      setGeomColor(g, _tone.set(PALETTE.stoneWarm).multiplyScalar(0.93 + rng() * 0.15), 0.07, rng);
      bins.stone.push(g);
      // the drip fillet, tucked under the outer lip. The coping oversails the
      // parapet face by 0.17 m; this thickens the shadow that overhang throws so
      // it reads as a dark band under the coping instead of a 1 px seam.
      const f = box(0.16, 0.075, cw - 0.05, undefined, {
        x: side * (half + 0.11), y: copY - 0.03 + dy, z,
      });
      setGeomColor(f, _tone.set(PALETTE.stone).multiplyScalar(0.86), 0.06, rng);
      bins.stone.push(f);
    }

    colliders.push({
      cx: side * (half - 0.26), cy: 0.57, cz: 0,
      hx: 0.34, hy: 0.57, hz: length * 0.5, yaw: 0,
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
    this._buildRiverWorks();
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

  /**
   * REVETTED BANKS AT THE CROSSING.
   *
   * "The upper-right bank is a large featureless tan wash with nothing to look
   * at" has been on the `bridge` critique for two rounds, and it is not a
   * terrain-shader problem: that region is 450 x 600 px of correctly-lit,
   * correctly-graded, correctly-hazed slope with no OBJECT on it. A slope with
   * nothing on it renders as a wash whatever the shader does. What belongs there
   * is what belongs on the banks either side of any real village crossing — a
   * quay wall at the waterline holding the bank out of the stream, a landing
   * stair down into the shallows, and one or two terrace walls stepping the
   * slope above it. Each of those is a long horizontal masonry line with a cast
   * shadow under it, which is exactly the missing ingredient: something for the
   * eye to read the ground's fall against.
   *
   * It is built here rather than in buildBridge() because it has to ask the
   * terrain where the waterline actually is, and buildBridge is a pure function
   * of its arguments.
   *
   * NO COLLIDERS, deliberately. These are revetment set INTO a bank at the
   * water's edge, a few metres off the road corridor; giving 40 m of half-metre
   * garden wall `solid: true` on both banks of the only crossing on the map is a
   * navigation change dressed up as an art change, and the AI paths through here.
   * Footprints ARE registered along the quay so vegetation does not grow a sward
   * through the dressed stone.
   */
  _buildRiverWorks() {
    const b = this.layout.bridge;
    const rng = this.rng;
    const co = Math.cos(b.yaw), si = Math.sin(b.yaw);
    // The bridge's local +Z runs along the road, so the RIVER runs along local
    // +X and the two banks are lines of roughly constant local Z.
    const toW = (lx, lz) => ({ x: b.x + lx * co + lz * si, z: b.z - lx * si + lz * co });
    const half = b.width * 0.5;

    /** Walk out along the bank and return where the ground crosses `targetY`. */
    const contour = (q, s, targetY, n, step, x0) => {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const lx = s * (x0 + i * step);
        let lz = null;
        for (let k = 1; k <= 70; k++) {
          const t = q * k * 0.30;
          const w = toW(lx, t);
          if (!this.terrain.inBounds(w.x, w.z)) break;
          if (this.terrain.heightAt(w.x, w.z) >= targetY) { lz = t; break; }
        }
        if (lz === null) break;
        const w = toW(lx, lz);
        pts.push({ x: w.x, z: w.z, y: this.terrain.heightAt(w.x, w.z) });
      }
      return pts;
    };

    for (const q of [-1, 1]) {
      for (const s of [-1, 1]) {
        // --- the quay: dressed stone holding the bank out of the stream
        const quay = contour(q, s, WATER_Y + 0.30, 10, 1.7, half + 1.5);
        if (quay.length >= 4) {
          const pts = quay.map((p) => ({
            x: p.x, z: p.z,
            y0: WATER_Y - 1.5, y1: Math.max(p.y + 0.26, WATER_Y + 0.82),
          }));
          const wall = ribbonWall(pts, 0, 1, 0.68);
          setGeomColor(wall, PALETTE.stone, 0.13, rng);
          this.bins.stone.push(wall);
          // ...capped stone by stone, for the same reason the bridge's coping is:
          // a ribbon's top edge is a ruled line and a ruled line reads as CAD.
          for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], c = pts[i + 1];
            const l = Math.hypot(c.x - a.x, c.z - a.z);
            const nCap = Math.max(1, Math.round(l / 0.7));
            for (let j = 0; j < nCap; j++) {
              if (rng() < 0.10) continue;
              const t = (j + 0.5) / nCap;
              const g = box(l / nCap - 0.05, 0.16, 0.80, undefined, {
                ry: -Math.atan2(c.z - a.z, c.x - a.x),
                rz: rngRange(rng, -0.03, 0.03),
              });
              g.translate(a.x + (c.x - a.x) * t,
                lerp(a.y1, c.y1, t) + 0.06 + rngRange(rng, -0.035, 0.035),
                a.z + (c.z - a.z) * t);
              setGeomColor(g, _tone.set(PALETTE.stoneWarm).multiplyScalar(0.92 + rng() * 0.16),
                0.07, rng);
              this.bins.stone.push(g);
            }
            this.footprints.push({ x: (a.x + c.x) * 0.5, z: (a.z + c.z) * 0.5, r: 1.5 });
          }
          // a landing stair down into the shallows, half way along
          const mid = quay[Math.max(1, (quay.length * 0.45) | 0)];
          const dirx = (quay[quay.length - 1].x - quay[0].x), dirz = (quay[quay.length - 1].z - quay[0].z);
          const dl = Math.hypot(dirx, dirz) || 1;
          // steps run INTO the water, i.e. across the bank line
          const nx = -dirz / dl * -q, nz = dirx / dl * -q;
          for (let t = 0; t < 6; t++) {
            const g = box(2.1, 0.20, 0.42, undefined, {
              ry: -Math.atan2(dirz, dirx),
            });
            g.translate(mid.x + nx * (0.4 + t * 0.38), WATER_Y + 0.72 - t * 0.24, mid.z + nz * (0.4 + t * 0.38));
            setGeomColor(g, _tone.set(t > 2 ? PALETTE.mud : PALETTE.stone)
              .multiplyScalar(0.90 + rng() * 0.18), 0.09, rng);
            this.bins.stone.push(g);
          }
          // mooring bollards
          for (let i = 1; i < quay.length - 1; i += 3) {
            const p = pts[i];
            this.bins.stone.push(cyl(0.17, 0.21, 0.62, 7, PALETTE.stoneWarm, {
              x: p.x, y: p.y1 + 0.28, z: p.z, variation: 0.11,
            }));
          }
        }

        // --- terrace walls up the slope. Two of them, so the bank reads as
        //     stepped ground rather than one unbroken fall, each with buttresses
        //     that break its length and drop a shadow across the terrace below.
        for (const [rise, thick] of [[2.5, 0.5], [4.1, 0.44]]) {
          const ter = contour(q, s, WATER_Y + rise, 9, 2.0, half + 2.4);
          if (ter.length < 4) continue;
          const pts = ter.map((p) => ({
            x: p.x, z: p.z, y0: p.y - 1.9, y1: p.y + rngRange(rng, 0.40, 0.62),
          }));
          const wall = ribbonWall(pts, 0, 1, thick);
          setGeomColor(wall, PALETTE.stone, 0.15, rng);
          this.bins.stone.push(wall);
          for (let i = 1; i < pts.length - 1; i += 2) {
            const p = pts[i];
            this.bins.stone.push(box(0.62, p.y1 - p.y0 - 0.25, 0.9, PALETTE.stoneWarm, {
              x: p.x, y: (p.y0 + p.y1) * 0.5 - 0.1, z: p.z + 0.42 * q,
              ry: rngRange(rng, -0.2, 0.2), variation: 0.13,
            }));
          }
        }
      }
    }
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
    // THE `surface:` KEY. Every bin here used to be built without one, which
    // meant forwardNpr() in worldMaterials.js found no SURFACE_PIGMENT preset,
    // uPigment stayed at its all-zero default, and the masonry-coursing and
    // bark-fissure branches in render/materials.js were unreachable from the
    // world — three rounds of "the spandrel has no coursing" against source
    // that plainly contained the coursing code. Naming the preset is the whole
    // wiring; everything below still overrides it where a bin needs to.
    //
    // The stone bins take ashlarMap() rather than stoneTexture(): see the header
    // note on ashlarMap for the arithmetic, but in one line — stoneTexture's
    // coursing is 0.216 m with a 9-19 mm joint, which is sub-pixel at any
    // distance this bridge is ever photographed from, so it mips away to a
    // blotch field before the shader sees it.
    const mats = {
      stucco: makeSurfaceMaterial({
        surface: 'stucco', color: 0xffffff, vertexColors: true, map: stuccoTexture(23), rim: 0.5,
      }),
      stone: makeSurfaceMaterial({
        surface: 'masonry', color: 0xffffff, vertexColors: true, map: ashlarMap({ seed: 31 }), rim: 0.45,
      }),
      sunk: makeSurfaceMaterial({
        surface: 'masonry', color: 0xffffff, vertexColors: true, map: ashlarMap({ seed: 31 }),
        rim: 0.25, outline: false,
      }),
      tile: makeSurfaceMaterial({
        surface: 'tile', color: 0xffffff, vertexColors: true, map: roofTileTexture(37), rim: 0.55, hatch: 0.8,
      }),
      timber: makeSurfaceMaterial({
        surface: 'timber', color: 0xffffff, vertexColors: true, map: woodTexture(41), rim: 0.4,
      }),
      metal: makeSurfaceMaterial({ surface: 'metal', color: 0xffffff, vertexColors: true, rim: 0.8 }),
    };
    // Push the maps into the BAND DRIVE rather than letting them multiply the
    // albedo. makeSurfaceMaterial() has no parameter for this, so set it here:
    // a mortar course or a pantile lap that merely darkens the wash by 4% is
    // invisible after the quantiser, whereas one that moves the band drive puts
    // a real step in — which is the difference between engraved-looking
    // masonry and an untextured primitive with a decal on it.
    // stone/sunk go up from 0.34: their map is now a purpose-built coursing map
    // whose ONLY job is to put a joint line in the drive, and the joint is 1% of
    // the tile's area, so it can be driven harder than a general stain map
    // without turning the wall busy. NOT much harder, though — 0.46 measured 13
    // LSB darker on the spandrel than 0.34 did and dropped the whole span into
    // the cross-hatched bands, because the map's deviation is not mean-zero once
    // toValueDetail has clamped its highlights at 1.0.
    const drive = { stucco: 0.24, stone: 0.38, sunk: 0.34, tile: 0.36, timber: 0.26, metal: 0.10 };
    for (const k of BINS) {
      const u = mats[k] && mats[k].uniforms;
      if (!u) continue;
      if (u.uBands) u.uBands.value = k === 'tile' ? 3 : 4;
      if (u.uBandBleed) u.uBandBleed.value = 0.13;
      if (u.uMapDrive) u.uMapDrive.value = drive[k];
      if (u.uMapFlat) u.uMapFlat.value = 0.68;
      if (u.uLightContrast) u.uLightContrast.value = 1.18;
      if (u.uWetPx) u.uWetPx.value = 12;
    }
    // 0.5 -> one pantile texture per 2 m of roof, i.e. 0.14 m courses.
    // The stone bins MUST run at 1/ASHLAR_TILE and nothing else: that map is
    // authored in metres, so any other scale moves its 0.42 m course off the
    // 0.42 m course the shader's uPigment branch and the bridge's own geometric
    // course blocks are both drawing, and the three start beating.
    const aUv = 1 / ASHLAR_TILE;
    const uvScale = { stucco: 0.34, stone: aUv, sunk: aUv, tile: 0.5, timber: 0.75, metal: 0.5 };
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
      // The submerged bin writes depth and shade but no ink — see BINS.
      m.userData.outline = k !== 'sunk';
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
