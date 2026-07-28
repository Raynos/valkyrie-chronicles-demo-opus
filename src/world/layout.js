// The mission layout for "Vasel Crossing" — a Gallian rural river map.
//
// This module is the single source of truth for *where things are*. Terrain
// carves its river channel, road corridor and village pad from these curves;
// water.js builds its surface ribbon from the same spline; structures.js sits
// the bridge on the same crossing point. Anything that both the heightfield and
// the props need to agree on lives here.
//
// Convention: +X is east, -Z is north. The player deploys south (+Z), the
// objective village is on the north bank.

import { makeRng, rngRange, fbm2, valueNoise2 } from '../core/rng.js';
import { smoothstep, lerp } from '../core/math.js';

export const MAP_SIZE = 180;          // playable extent, metres, centred on origin
export const MAP_HALF = MAP_SIZE / 2;
export const WATER_Y = 2.0;           // the river surface is a level pool
export const UNIT_HEIGHT = 1.75;

// --- Catmull-Rom polyline sampling ------------------------------------------

function catmull(p0, p1, p2, p3, t, key) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (
    2 * p1[key] +
    (-p0[key] + p2[key]) * t +
    (2 * p0[key] - 5 * p1[key] + 4 * p2[key] - p3[key]) * t2 +
    (-p0[key] + 3 * p1[key] - 3 * p2[key] + p3[key]) * t3
  );
}

/**
 * Dense polyline + cumulative arclength for a control polygon.
 * Returns { x: Float32Array, z: Float32Array, cum: Float32Array, n, length }.
 */
function sampleSpline(ctrl, perSeg = 10) {
  const xs = [], zs = [];
  const n = ctrl.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i];
    const p2 = ctrl[i + 1], p3 = ctrl[Math.min(n - 1, i + 2)];
    const last = i === n - 2 ? perSeg : perSeg - 1;
    for (let s = 0; s <= last; s++) {
      const t = s / perSeg;
      xs.push(catmull(p0, p1, p2, p3, t, 'x'));
      zs.push(catmull(p0, p1, p2, p3, t, 'z'));
    }
  }
  const N = xs.length;
  const X = new Float32Array(xs), Z = new Float32Array(zs);
  const cum = new Float32Array(N);
  for (let i = 1; i < N; i++) cum[i] = cum[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]);
  return { x: X, z: Z, cum, n: N, length: cum[N - 1] };
}

// Scratch result for SDF queries — hot path, never allocate.
const _sdf = { d: 0, t: 0, px: 0, pz: 0, tx: 0, tz: 0, seg: 0 };

/**
 * Unsigned distance from (x,z) to a sampled polyline, plus the normalised
 * arclength of the closest point and the local tangent.
 */
function polySDF(poly, x, z, out = _sdf) {
  let best = Infinity, bi = 0, bt = 0;
  const X = poly.x, Z = poly.z, N = poly.n;
  for (let i = 0; i < N - 1; i++) {
    const ax = X[i], az = Z[i];
    const bx = X[i + 1], bz = Z[i + 1];
    const ex = bx - ax, ez = bz - az;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + ex * t, cz = az + ez * t;
    const dx = x - cx, dz = z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; bi = i; bt = t; }
  }
  const ax = X[bi], az = Z[bi], bx = X[bi + 1], bz = Z[bi + 1];
  out.d = Math.sqrt(best);
  out.px = ax + (bx - ax) * bt;
  out.pz = az + (bz - az) * bt;
  const tl = Math.hypot(bx - ax, bz - az) || 1;
  out.tx = (bx - ax) / tl;
  out.tz = (bz - az) / tl;
  out.seg = bi;
  const arc = poly.cum[bi] + tl * bt;
  out.t = poly.length > 0 ? arc / poly.length : 0;
  return out;
}

// ---------------------------------------------------------------------------

export class MissionLayout {
  constructor(seed = 20250728) {
    this.seed = seed;
    const rng = makeRng(seed);
    this.rng = rng;

    // --- the river: west to east, meandering, over-extended past the map edge
    this.riverCtrl = [
      { x: -125, z: 34 }, { x: -96, z: 30 }, { x: -70, z: 21 }, { x: -46, z: 25 },
      { x: -24, z: 13 }, { x: -5, z: 4 }, { x: 17, z: 6 }, { x: 41, z: -3 },
      { x: 66, z: -6 }, { x: 96, z: -14 }, { x: 125, z: -19 },
    ];
    this.river = sampleSpline(this.riverCtrl, 9);

    // --- the road: south deployment to north village, crossing at the bridge
    this.roadCtrl = [
      { x: -1, z: 120 }, { x: -3, z: 92 }, { x: -5, z: 68 }, { x: 1, z: 46 },
      { x: 3, z: 24 }, { x: 3, z: 8 }, { x: 5, z: -6 }, { x: 13, z: -25 },
      { x: 21, z: -45 }, { x: 26, z: -68 }, { x: 24, z: -95 }, { x: 22, z: -120 },
    ];
    this.road = sampleSpline(this.roadCtrl, 9);

    // --- desire lines. Where men and horses actually walk between the things
    //     they have to get to: the crossing, the well, the mill track, the
    //     ford. These are not carved into the heightfield — they only paint the
    //     ground, as worn earth showing through the sward, which is exactly
    //     what a footpath IS. Without them a 3 m patch of pasture in the near
    //     field has nothing in it to look at.
    this.pathCtrl = [
      // south bank: deployment ridge down to the bridgehead
      [{ x: -14, z: 60 }, { x: -8, z: 44 }, { x: -1, z: 30 }, { x: 2, z: 16 }],
      // north bank: bridgehead to the village square, cutting the corner
      [{ x: 6, z: -8 }, { x: 14, z: -18 }, { x: 24, z: -30 }, { x: 30, z: -40 }],
      // the ford: a shallow crossing the locals use instead of the bridge
      [{ x: -30, z: 26 }, { x: -25, z: 16 }, { x: -22, z: 8 }, { x: -20, z: -2 }],
      // mill track spur up the knoll
      [{ x: -44, z: -58 }, { x: -43, z: -52 }, { x: -42, z: -48 }],
    ];
    this.paths = this.pathCtrl.map((c) => sampleSpline(c, 8));

    // --- a farm track branching west toward the windmill
    this.trackCtrl = [
      { x: 4, z: -12 }, { x: -10, z: -20 }, { x: -26, z: -30 },
      { x: -38, z: -41 }, { x: -44, z: -56 }, { x: -46, z: -74 },
    ];
    this.track = sampleSpline(this.trackCtrl, 8);

    // --- broad landform bumps layered on top of the fbm hills
    this.hills = [
      { x: -42, z: -48, r: 30, h: 6.4 },     // windmill knoll
      { x: -34, z: 58, r: 42, h: 4.2 },      // southern ridge (deployment overlook)
      { x: 64, z: -26, r: 34, h: 5.0 },      // eastern rise
      { x: 58, z: 52, r: 30, h: 3.2 },
      { x: -74, z: 6, r: 26, h: 3.6 },
    ];

    // Per-curve scratch results so nested SDF queries never clobber each other.
    this._sdfA = { d: 0, t: 0, px: 0, pz: 0, tx: 0, tz: 0, seg: 0 };
    this._sdfB = { d: 0, t: 0, px: 0, pz: 0, tx: 0, tz: 0, seg: 0 };
    this._sdfC = { d: 0, t: 0, px: 0, pz: 0, tx: 0, tz: 0, seg: 0 };
    this._sdfT = { d: 0, t: 0, px: 0, pz: 0, tx: 0, tz: 0, seg: 0 };
    this._sdfP = { d: 0, t: 0, px: 0, pz: 0, tx: 0, tz: 0, seg: 0 };

    // --- where the road meets the river: the stone bridge
    const cross = this._findCrossing();
    this.bridge = {
      x: cross.x, z: cross.z,
      yaw: Math.atan2(cross.tx, cross.tz),   // along the road
      length: 34,
      width: 8.4,
      deckY: 0,                              // filled in by Terrain once built
      riverT: cross.riverT,
    };

    // --- the village pad on the north bank
    this.village = { x: 30, z: -40, r: 26, y: 0 };

    // --- shell craters. Placed along the approach and inside the village,
    //     because that is where the shelling was aimed.
    this.craters = [];
    const craterSpots = [
      [6, 22], [-4, 16], [11, -2], [-9, -6], [18, -18], [30, -28],
      [24, -50], [38, -44], [12, 34], [-16, 30], [44, -20], [-2, -22],
      [33, -58], [20, -66],
    ];
    for (const [cx, cz] of craterSpots) {
      const jx = cx + rngRange(rng, -3.5, 3.5);
      const jz = cz + rngRange(rng, -3.5, 3.5);
      this.craters.push({
        x: jx, z: jz,
        r: rngRange(rng, 2.6, 5.2),
        depth: rngRange(rng, 0.75, 1.85),
        rim: rngRange(rng, 0.22, 0.5),
        seed: (rng() * 1e6) | 0,
      });
    }

    // --- cultivated fields (wheat, fallow) as rotated ellipses
    this.fields = [
      { x: 58, z: 30, rx: 30, rz: 22, rot: 0.31, type: 'wheat' },
      { x: -58, z: 24, rx: 26, rz: 19, rot: -0.22, type: 'wheat' },
      { x: 52, z: -56, rx: 22, rz: 17, rot: 0.72, type: 'wheat' },
      { x: -20, z: 66, rx: 28, rz: 16, rot: 0.12, type: 'fallow' },
      { x: -66, z: -30, rx: 20, rz: 26, rot: -0.5, type: 'fallow' },
    ];

    // --- hedgerows: field boundaries and lane edges. Dense cover, no LOS.
    this.hedges = [
      [{ x: 28, z: 12 }, { x: 46, z: 8 }, { x: 66, z: 6 }, { x: 84, z: 9 }],
      [{ x: 30, z: 54 }, { x: 52, z: 56 }, { x: 74, z: 52 }],
      [{ x: -32, z: 12 }, { x: -52, z: 16 }, { x: -74, z: 14 }],
      [{ x: -36, z: 40 }, { x: -40, z: 58 }, { x: -34, z: 78 }],
      [{ x: -14, z: -18 }, { x: -30, z: -26 }, { x: -44, z: -30 }],
      [{ x: 44, z: -66 }, { x: 60, z: -58 }, { x: 72, z: -44 }],
      [{ x: 12, z: 40 }, { x: 14, z: 58 }, { x: 8, z: 76 }],
    ];

    // --- windmill on the knoll
    this.windmill = { x: -42, z: -48, yaw: 0.6 };

    // --- deployment / objective markers for the mission layer
    this.deploy = {
      ally: { x: -2, z: 62, r: 16 },
      enemy: { x: 30, z: -52, r: 18 },
    };
    this.objectives = [
      { id: 'bridge', x: cross.x, z: cross.z, r: 8, label: 'Secure the crossing' },
      { id: 'camp', x: 30, z: -46, r: 9, label: 'Seize the enemy camp' },
    ];
  }

  /** Where the road polyline first crosses the river polyline. */
  _findCrossing() {
    let best = Infinity, bx = 0, bz = 0, btx = 0, btz = 1, brt = 0.5;
    for (let i = 0; i < this.road.n; i += 1) {
      const x = this.road.x[i], z = this.road.z[i];
      const r = polySDF(this.river, x, z, this._sdfT);
      if (r.d < best) {
        best = r.d;
        bx = x; bz = z; brt = r.t;
        const j = Math.min(this.road.n - 2, Math.max(0, i - 1));
        const dx = this.road.x[j + 1] - this.road.x[j];
        const dz = this.road.z[j + 1] - this.road.z[j];
        const l = Math.hypot(dx, dz) || 1;
        btx = dx / l; btz = dz / l;
      }
    }
    return { x: bx, z: bz, tx: btx, tz: btz, riverT: brt };
  }

  // --- SDF accessors (each uses its own scratch so callers can nest) --------

  riverSDF(x, z) { return polySDF(this.river, x, z, this._sdfA); }
  roadSDF(x, z) { return polySDF(this.road, x, z, this._sdfB); }
  trackSDF(x, z) { return polySDF(this.track, x, z, this._sdfC); }

  /**
   * Nearest footpath: distance in metres and how worn that stretch is.
   * Purely a painting query — the paths never touch the heightfield.
   * @returns {{d:number, wear:number}}
   */
  pathSDF(x, z) {
    let best = Infinity, wear = 0;
    for (let i = 0; i < this.paths.length; i++) {
      const r = polySDF(this.paths[i], x, z, this._sdfP);
      if (r.d < best) {
        best = r.d;
        // a path is beaten hardest in the middle of its run and frays at both
        // ends, where the traffic fans out
        wear = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, Math.max(0, r.t)));
      }
    }
    return { d: best, wear };
  }

  /** Channel half-width in metres at normalised arclength t. */
  riverHalfWidth(t) {
    // The river widens downstream and pinches at the bridge narrows.
    const base = lerp(5.2, 8.6, t);
    const wig = (fbm2(t * 7.4, 0.5, { octaves: 3, seed: this.seed + 41 }) - 0.5) * 3.0;
    const pinch = 1 - 0.28 * Math.exp(-Math.pow((t - this.bridge.riverT) / 0.035, 2));
    return (base + wig) * pinch;
  }

  /** Road half-width in metres. Widens into the village as a market street. */
  roadHalfWidth(t) {
    return 3.1 + 0.9 * smoothstep(0.55, 0.78, t) + (valueNoise2(t * 22, 1.3, this.seed + 7) - 0.5) * 0.5;
  }

  /** Is (x,z) inside a cultivated field? Returns the field or null. */
  fieldAt(x, z) {
    for (const f of this.fields) {
      const co = Math.cos(-f.rot), si = Math.sin(-f.rot);
      const dx = x - f.x, dz = z - f.z;
      const lx = dx * co - dz * si, lz = dx * si + dz * co;
      const v = (lx * lx) / (f.rx * f.rx) + (lz * lz) / (f.rz * f.rz);
      if (v <= 1) { f._edge = 1 - Math.sqrt(v); return f; }
    }
    return null;
  }

  /** Village influence 0..1 (1 at the centre of the flattened pad). */
  villageMask(x, z) {
    const d = Math.hypot(x - this.village.x, z - this.village.z);
    return 1 - smoothstep(this.village.r * 0.55, this.village.r, d);
  }

  /** Combined crater displacement at (x,z): negative in the bowl, + on the rim. */
  craterDelta(x, z) {
    let sum = 0;
    for (let i = 0; i < this.craters.length; i++) {
      const c = this.craters[i];
      const d = Math.hypot(x - c.x, z - c.z);
      if (d > c.r * 1.55) continue;
      const u = d / c.r;
      // bowl: smooth parabola inside; rim: a raised lip just outside r
      const bowl = -c.depth * Math.max(0, 1 - u * u) * (1 - 0.25 * valueNoise2(x * 0.8, z * 0.8, c.seed));
      const lip = c.rim * Math.exp(-Math.pow((u - 1.02) / 0.28, 2));
      sum += bowl + lip;
    }
    return sum;
  }

  /** Broad landform bumps. */
  hillDelta(x, z) {
    let sum = 0;
    for (let i = 0; i < this.hills.length; i++) {
      const h = this.hills[i];
      const d = Math.hypot(x - h.x, z - h.z) / h.r;
      if (d > 1.6) continue;
      // smooth compact bump: cos^2 falloff, zero derivative at the edge
      const f = Math.max(0, 1 - d);
      sum += h.h * f * f * (3 - 2 * f);
    }
    return sum;
  }

  dispose() { /* pure data */ }
}

export { polySDF, sampleSpline };
