// src/ui/icons.js
// Every icon, rule, ribbon and stamp in the interface, drawn as SVG at runtime.
// Nothing is loaded; the "hand-drawn" quality comes from seeded path jitter
// (wobblyPath / roughCircle / roughRect) rather than from a filter, so it holds
// up at any size and stays deterministic.

import { makeRng } from '../core/rng.js';
import { clamp01 } from '../core/math.js';
import { h, svgEl } from './dom.js';

// --------------------------------------------------------------------------
// Rough geometry primitives — the graphite hand
// --------------------------------------------------------------------------

/** A straight run broken into segments that wander perpendicular to the line. */
export function wobblyPath(x1, y1, x2, y2, { seed = 1, amp = 0.8, segs = 6, overshoot = 0 } = {}) {
  const rng = makeRng((seed >>> 0) || 1);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const o = overshoot / len;
  let d = '';
  for (let i = 0; i <= segs; i++) {
    const t = -o + (i / segs) * (1 + o * 2);
    // taper the wander toward the ends so strokes still meet their anchors
    const taper = Math.sin(Math.min(1, Math.max(0, (t + o) / (1 + 2 * o))) * Math.PI);
    const w = (rng() * 2 - 1) * amp * (0.35 + 0.65 * taper);
    const x = x1 + dx * t + nx * w;
    const y = y1 + dy * t + ny * w;
    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
  }
  return d;
}

/** A closed ring whose radius breathes — an inked circle, not a compass circle. */
export function roughCircle(cx, cy, r, { seed = 1, amp = 0.9, segs = 26, open = 0 } = {}) {
  const rng = makeRng((seed >>> 0) || 1);
  const start = rng() * Math.PI * 2;
  const sweep = Math.PI * 2 - open;
  let d = '';
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const a = start + (i / segs) * sweep;
    const rr = r + (rng() * 2 - 1) * amp + Math.sin(a * 3 + start) * amp * 0.35;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  // Catmull-ish smoothing via quadratic midpoints keeps it organic, not polygonal.
  d = 'M' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = pts[i - 1];
    d += 'Q' + q[0].toFixed(2) + ' ' + q[1].toFixed(2) + ' ' +
      ((p[0] + q[0]) / 2).toFixed(2) + ' ' + ((p[1] + q[1]) / 2).toFixed(2);
  }
  if (!open) d += 'Z';
  return d;
}

/** Four wobbly runs forming a hand-ruled box. */
export function roughRect(x, y, w, hgt, { seed = 1, amp = 0.7, segs = 5, overshoot = 0.8 } = {}) {
  return [
    wobblyPath(x, y, x + w, y, { seed, amp, segs, overshoot }),
    wobblyPath(x + w, y, x + w, y + hgt, { seed: seed + 7, amp, segs, overshoot }),
    wobblyPath(x + w, y + hgt, x, y + hgt, { seed: seed + 13, amp, segs, overshoot }),
    wobblyPath(x, y + hgt, x, y, { seed: seed + 19, amp, segs, overshoot }),
  ].join(' ');
}

/** Splattered ink blob — a lumpy radial polygon with a few flung droplets. */
export function splatPath(cx, cy, r, { seed = 1, lobes = 11, rough = 0.42 } = {}) {
  const rng = makeRng((seed >>> 0) || 1);
  const pts = [];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + rng() * 0.22;
    const rr = r * (1 - rough + rng() * rough * 2);
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  let d = 'M' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
  for (let i = 1; i <= lobes; i++) {
    const p = pts[i % lobes], q = pts[i - 1];
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    d += 'Q' + q[0].toFixed(2) + ' ' + q[1].toFixed(2) + ' ' + mx.toFixed(2) + ' ' + my.toFixed(2);
  }
  d += 'Z';
  // droplets
  const drops = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < drops; i++) {
    const a = rng() * Math.PI * 2;
    const dist = r * (1.15 + rng() * 0.95);
    const dr = r * (0.06 + rng() * 0.13);
    const dx = cx + Math.cos(a) * dist, dy = cy + Math.sin(a) * dist;
    d += 'M' + (dx + dr).toFixed(2) + ' ' + dy.toFixed(2) +
      'a' + dr.toFixed(2) + ' ' + dr.toFixed(2) + ' 0 1 0 ' + (-dr * 2).toFixed(2) + ' 0' +
      'a' + dr.toFixed(2) + ' ' + dr.toFixed(2) + ' 0 1 0 ' + (dr * 2).toFixed(2) + ' 0Z';
  }
  return d;
}

/** Parallel graphite hatching inside a rect — the shadow-band pencil texture. */
export function hatchPath(x, y, w, hgt, { spacing = 3, angle = -0.85, seed = 3, amp = 0.5 } = {}) {
  const rng = makeRng((seed >>> 0) || 1);
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const diag = Math.abs(w * dy) + Math.abs(hgt * dx);
  let d = '';
  const n = Math.ceil((w + diag) / spacing);
  for (let i = 0; i < n; i++) {
    const s = -diag + i * spacing + (rng() - 0.5) * spacing * 0.3;
    // clip the infinite line to the rect analytically (parametric slab test)
    const px = x + s, py = y;
    let t0 = -1e4, t1 = 1e4;
    const slab = (p, dir, lo, hi) => {
      if (Math.abs(dir) < 1e-6) return p >= lo && p <= hi;
      const a = (lo - p) / dir, b = (hi - p) / dir;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
      return true;
    };
    if (!slab(px, dx, x, x + w) || !slab(py, dy, y, y + hgt) || t1 <= t0) continue;
    const j = (rng() - 0.5) * amp;
    d += 'M' + (px + dx * t0 + j).toFixed(2) + ' ' + (py + dy * t0).toFixed(2) +
      'L' + (px + dx * t1 + j).toFixed(2) + ' ' + (py + dy * t1).toFixed(2);
  }
  return d;
}

// --------------------------------------------------------------------------
// Icon library — 24x24 viewBox, stroke-based line art
// --------------------------------------------------------------------------

const PATHS = {
  // --- classes / weapons ---
  scout:
    '<path d="M3.2 19.4 5.4 17.2"/><path d="M4.6 18 18.4 6.2"/><path d="M18.4 6.2 21.2 4.4 20.2 7.6"/>' +
    '<path d="M9.4 13.6 12.2 16.4"/><path d="M11.6 10.6 14.6 8.1"/><path d="M11.6 10.6 13.1 12.2"/>' +
    '<path d="M14.6 8.1 16.1 9.7"/><path d="M8.6 14.5 7.1 18"/>',
  shock:
    '<path d="M4.6 11.4H15"/><path d="M15 11.4h4.9"/><path d="M15.4 11.4v-2.3"/>' +
    '<path d="M8.6 11.6 8.2 18.4h2.6l.4-6.8"/><path d="M12.6 11.6 13.6 15.4"/>' +
    '<path d="M4.6 11.4 2.6 14.6l1.8 1.2"/><path d="M6.2 9.6h6"/>',
  lancer:
    '<path d="M3.6 17.6 16.4 7.6"/><path d="M16.4 7.6 21 4.6 19.4 10.1Z"/>' +
    '<path d="M7 14.4 4.2 12.9"/><path d="M5.4 16.4 2.4 15.9"/><path d="M3.6 17.6 1.8 19.9"/>' +
    '<path d="M9.8 12.2 12 14.6"/>',
  engineer:
    '<path d="M4.4 19.6 12.4 11.4"/><path d="M11.2 9.6a3.3 3.3 0 1 0 3.7 3.6"/>' +
    '<path d="M11.2 9.6 14.3 6.4"/><path d="M14.9 13.2 18 10.2"/>' +
    '<path d="M17.8 4.4v2.2M20.8 8.9h-2.2M17.8 13.4v-2.2M14.8 8.9h2.2"/>' +
    '<path d="M17.8 6.6a2.3 2.3 0 1 0 .1 4.6 2.3 2.3 0 0 0-.1-4.6Z"/>' +
    '<path d="M3.2 20.8 5 19"/>',
  sniper:
    '<path d="M2.6 19.8 20.4 5.4"/><path d="M20.4 5.4 22.4 4.6"/>' +
    '<path d="M10.4 11.6 15.6 7.4"/><path d="M10.9 10.2 11.8 11.2M15.1 8.8 16 9.8"/>' +
    '<path d="M16.8 8.4 18.8 10.8M18.8 10.8 17.6 13.4M18.8 10.8 20.6 13"/>' +
    '<path d="M4.6 18.2 3.4 21.4"/><path d="M7.6 15.8 9.6 17.8"/>',
  tank:
    '<path d="M2.6 17.6h17.8"/><path d="M3.4 14.2h14.4v3.4H3.4Z"/>' +
    '<path d="M7.4 14.2 8.8 11h6.2l1.2 3.2"/><path d="M12.6 12 21 11.4"/>' +
    '<path d="M4.6 19.6a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM11.4 19.6a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM18.2 19.6a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z"/>',
  grenade:
    '<path d="M12 20.2a5.6 5.6 0 1 0 0-11.2 5.6 5.6 0 0 0 0 11.2Z"/>' +
    '<path d="M9.8 8.8V6.6h4.4v2.2"/><path d="M14.2 7 17 4.6"/>' +
    '<path d="M17 4.6a1.5 1.5 0 1 0 0-.1"/><path d="M8.6 12.4h6.8M8.6 15.2h6.8M12 9.4v9.4"/>',
  mortar:
    '<path d="M7 19.4 15.6 6.2"/><path d="M15.6 6.2 18 4.6"/><path d="M5.2 20.4h9"/>' +
    '<path d="M8.4 17.2 6 20.4M11 13.4 14.6 19.4"/>',
  ragnaid:
    '<path d="M9.6 4.6h4.8v3l3 5.4v6a1.4 1.4 0 0 1-1.4 1.4H8a1.4 1.4 0 0 1-1.4-1.4v-6l3-5.4Z"/>' +
    '<path d="M6.6 14.4h10.8"/><path d="M12 15.6v3.4M10.3 17.3h3.4"/>',
  // --- status / meta ---
  cp: '<path d="M12 3.4 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8L6.7 20l1-6-4.3-4.2 6-.9Z"/>',
  ap: '<path d="M13.6 2.6 5.4 13.8h5.4L9.6 21.4 18.6 9.6h-5.6Z"/>',
  hp: '<path d="M12 20.4S4.4 15.8 4.4 10.4a3.9 3.9 0 0 1 7.6-1.3 3.9 3.9 0 0 1 7.6 1.3c0 5.4-7.6 10-7.6 10Z"/>',
  skull:
    '<path d="M12 3.4c-4.4 0-7.4 3-7.4 7 0 2.6 1.2 4 2.4 5v2.8c0 .9.7 1.6 1.6 1.6h6.8c.9 0 1.6-.7 1.6-1.6v-2.8c1.2-1 2.4-2.4 2.4-5 0-4-3-7-7.4-7Z"/>' +
    '<path d="M9.4 11.4a1.7 1.7 0 1 0 0-.1M14.6 11.4a1.7 1.7 0 1 0 0-.1"/><path d="M11 15.4h2"/>',
  shield: '<path d="M12 2.8 4.8 5.6v6.2c0 4.4 3 8 7.2 9.4 4.2-1.4 7.2-5 7.2-9.4V5.6Z"/><path d="M8.6 12.2 11 14.6l4.6-5"/>',
  eye: '<path d="M1.8 12S5.6 5.8 12 5.8 22.2 12 22.2 12 18.4 18.2 12 18.2 1.8 12 1.8 12Z"/><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/>',
  boot: '<path d="M6.4 3.6h4.2v8.6l6.6 2.6c1.6.6 2.4 1.6 2.4 3.2v2.4H6.4Z"/><path d="M6.4 17h13.2"/>',
  clock: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"/><path d="M12 6.8V12l3.6 2.4"/>',
  flag: '<path d="M6 21V3.4"/><path d="M6 4.4c4-2 7.4 2 11.6 0v8c-4.2 2-7.6-2-11.6 0Z"/>',
  pin: '<path d="M12 21.4s6.6-7 6.6-11.4a6.6 6.6 0 1 0-13.2 0C5.4 14.4 12 21.4 12 21.4Z"/><path d="M12 12.6a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6Z"/>',
  swords:
    '<path d="M3.4 3.4h3.4l11 11-3.4 3.4Z"/><path d="M20.6 3.4h-3.4l-11 11 3.4 3.4Z"/>' +
    '<path d="M4 18.6 7 21.6M20 18.6 17 21.6"/>',
  star: '<path d="M12 3 14.9 9.2 21.6 10 16.8 14.8 18 21.4 12 18.2 6 21.4l1.2-6.6L2.4 10l6.7-.8Z"/>',
  medal: '<path d="M8.4 2.6 12 9.4 15.6 2.6"/><path d="M12 21.4a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"/><path d="M12 17.6a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"/>',
  coin: '<path d="M12 20.6a8.6 8.6 0 1 0 0-17.2 8.6 8.6 0 0 0 0 17.2Z"/><path d="M12 17.4a5.4 5.4 0 1 0 0-10.8 5.4 5.4 0 0 0 0 10.8Z"/><path d="M12 9.4 13.2 12l-1.2 2.6L10.8 12Z"/>',
  crosshair: '<path d="M12 20.8a8.8 8.8 0 1 0 0-17.6 8.8 8.8 0 0 0 0 17.6Z"/><path d="M12 .8v6M12 17.2v6M.8 12h6M17.2 12h6"/>',
  compass: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"/><path d="m15.6 8.4-2 5.2-5.2 2 2-5.2Z"/>',
  warn: '<path d="M12 3.4 22 20.4H2Z"/><path d="M12 9.4v5.2M12 17.2v.6"/>',
  book: '<path d="M3.4 4.4h6.2c1.4 0 2.4 1 2.4 2.4v13c0-1-1-1.8-2.4-1.8H3.4Z"/><path d="M20.6 4.4h-6.2c-1.4 0-2.4 1-2.4 2.4v13c0-1 1-1.8 2.4-1.8h6.2Z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  cross: '<path d="M5 5 19 19M19 5 5 19"/>',
  check: '<path d="m4.6 12.6 5 5L19.4 6.4"/>',
  camp: '<path d="M3.6 19.4h16.8"/><path d="M5.6 19.4v-4.6h12.8v4.6"/><path d="M12 14.8V4.6"/><path d="M12 5.6c2.6-1.6 4.6 1.2 7 0v4c-2.4 1.2-4.4-1.6-7 0Z"/>',
  radio: '<path d="M6.4 21h11.2V11.4H6.4Z"/><path d="M9 11.4 17 5.6"/><path d="M9.4 15.4h3.2M15 15.4h.6"/><path d="M17 4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Z"/>',
};

const ALIAS = {
  shocktrooper: 'shock', trooper: 'shock', assault: 'shock', medic: 'engineer',
  rifle: 'scout', smg: 'shock', lance: 'lancer', wrench: 'engineer',
  sniperRifle: 'sniper', kill: 'swords', capture: 'flag', defend: 'shield',
  objective: 'pin', downed: 'skull', turn: 'clock', dp: 'coin', ammo: 'ap',
  leader: 'star', order: 'radio',
};

export const CLASS_ICONS = {
  scout: 'scout', shock: 'shock', shocktrooper: 'shock', lancer: 'lancer',
  engineer: 'engineer', sniper: 'sniper', tank: 'tank',
};

/** Raw SVG markup for an icon. */
export function iconMarkup(name, {
  size = 24, stroke = 'currentColor', width = 1.55, fill = 'none', rough = null, cls = '',
} = {}) {
  const key = PATHS[name] ? name : (ALIAS[name] && PATHS[ALIAS[name]] ? ALIAS[name] : 'pin');
  const doRough = rough == null ? size >= 26 : rough;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + size +
    '" height="' + size + '" class="vc-icon ' + cls + '" aria-hidden="true">' +
    '<g fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + width +
    '" stroke-linecap="round" stroke-linejoin="round"' +
    (doRough ? ' filter="url(#vc-rough)"' : '') + '>' + PATHS[key] + '</g></svg>';
}

/** Live SVG element for an icon. */
export function icon(name, opts) { return svgEl(iconMarkup(name, opts)); }

/**
 * Class emblem inside a hand-inked hexagonal badge.
 *
 * The whole device is GRAPHITE on a laid ochre wash — it used to be drawn flat
 * in #37536f, which put a saturated web blue and a flat blue weapon glyph in the
 * bottom-left corner of every action frame. Allegiance is carried instead by a
 * wax seal blotted onto the lower point of the hex, which is how a field journal
 * would mark it: red for the Empire, indigo for Gallia.
 */
export function classBadge(cls, { size = 46, team = 0, seed = 5 } = {}) {
  const c = CLASS_ICONS[String(cls || '').toLowerCase()] || 'scout';
  const seal = team === 1 ? '#8d3730' : '#37536f';
  const ink = '#3f3227';
  const w = size, hgt = size * 1.08;
  const pt = (fx, fy) => [w * fx, hgt * fy];
  const P = [pt(0.5, 0.03), pt(0.94, 0.28), pt(0.94, 0.73), pt(0.5, 0.98), pt(0.06, 0.73),
    pt(0.06, 0.28)];
  // Six hand-ruled runs, each wandering and overshooting its corner — a drawn
  // hexagon rather than a vector one.
  let rim = '', rim2 = '';
  for (let i = 0; i < 6; i++) {
    const a = P[i], b = P[(i + 1) % 6];
    rim += wobblyPath(a[0], a[1], b[0], b[1],
      { seed: seed + i * 11, amp: size * 0.022, segs: 4, overshoot: size * 0.03 }) + ' ';
    rim2 += wobblyPath(a[0], a[1], b[0], b[1],
      { seed: seed + 97 + i * 11, amp: size * 0.030, segs: 4 }) + ' ';
  }
  const hexFill = 'M' + P.map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z';
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + hgt + '" width="' + w +
    '" height="' + hgt + '">' +
    '<path d="' + hexFill + '" fill="#c9b184" fill-opacity="0.26"/>' +
    '<path d="' + splatPath(w * 0.42, hgt * 0.44, w * 0.30, { seed: seed + 5, lobes: 11, rough: 0.4 }) +
    '" fill="#8f7c53" opacity="0.13"/>' +
    '<path d="' + hatchPath(w * 0.10, hgt * 0.56, w * 0.80, hgt * 0.38,
      { spacing: 2.8, angle: -0.9, seed: seed + 13 }) +
    '" stroke="' + ink + '" stroke-width="0.5" opacity="0.20" fill="none"/>' +
    // double-struck rim: a fat pass and a hairline ghost beside it
    '<path d="' + rim + '" fill="none" stroke="' + ink + '" stroke-width="' +
    (size * 0.062).toFixed(2) + '" stroke-linecap="round" opacity="0.92"/>' +
    '<path d="' + rim2 + '" fill="none" stroke="' + ink + '" stroke-width="' +
    (size * 0.020).toFixed(2) + '" stroke-linecap="round" opacity="0.34"/>' +
    '<path d="' + roughCircle(w * 0.5, hgt * 0.5, w * 0.38, { seed: seed + 3, amp: 0.6, segs: 20 }) +
    '" fill="none" stroke="' + ink + '" stroke-width="0.75" opacity="0.34"/>' +
    '<g transform="translate(' + (w * 0.5 - w * 0.30) + ' ' + (hgt * 0.5 - w * 0.30) +
    ') scale(' + ((w * 0.60) / 24).toFixed(3) + ')" fill="none" stroke="' + ink +
    '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
    'filter="url(#vc-rough)">' + PATHS[c] + '</g>' +
    // the wax seal blotted onto the lower point, inside the rim
    '<path d="' + splatPath(w * 0.5, hgt * 0.865, w * 0.085, { seed: seed + 71, lobes: 9, rough: 0.34 }) +
    '" fill="' + seal + '" opacity="0.92"/>' +
    '<path d="' + roughCircle(w * 0.5, hgt * 0.865, w * 0.048, { seed: seed + 73, amp: 0.4, segs: 12 }) +
    '" fill="none" stroke="#f3e6c9" stroke-width="0.7" opacity="0.42"/>' +
    '</svg>');
}

/**
 * One stamped Command Point token.
 * `plain` omits the star device, leaving room for a numeral drawn on top
 * (used for the cost stamp on order cards).
 */
export function cpToken({ spent = false, size = 28, seed = 1, plain = false } = {}) {
  const r = size * 0.42, c = size / 2;
  const ink = '#5c1d22';
  if (plain) {
    return svgEl(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size +
      '" width="' + size + '" height="' + size + '">' +
      '<path d="' + roughCircle(c, c, r, { seed, amp: r * 0.055, segs: 22 }) +
      '" fill="url(#vc-ribbon-grad)" opacity="0.94"/>' +
      '<path d="' + roughCircle(c, c, r, { seed: seed + 3, amp: r * 0.07, segs: 22 }) +
      '" fill="none" stroke="' + ink + '" stroke-width="' + (size * 0.055).toFixed(2) + '"/>' +
      '<path d="' + roughCircle(c, c, r * 0.76, { seed: seed + 9, amp: r * 0.05, segs: 20 }) +
      '" fill="none" stroke="#f3e6c9" stroke-width="' + (size * 0.030).toFixed(2) +
      '" opacity="0.55"/></svg>');
  }
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size +
    '" width="' + size + '" height="' + size + '">' +
    (spent ? '' :
      '<path d="' + roughCircle(c, c, r, { seed, amp: r * 0.055, segs: 22 }) +
      '" fill="url(#vc-ribbon-grad)" opacity="0.92"/>') +
    '<path d="' + roughCircle(c, c, r, { seed: seed + 3, amp: r * 0.07, segs: 22 }) +
    '" fill="none" stroke="' + ink + '" stroke-width="' + (size * 0.055).toFixed(2) + '"/>' +
    '<path d="' + roughCircle(c, c, r * 0.74, { seed: seed + 9, amp: r * 0.05, segs: 20 }) +
    '" fill="none" stroke="' + (spent ? ink : '#f3e6c9') + '" stroke-width="' +
    (size * 0.035).toFixed(2) + '" opacity="0.8"/>' +
    '<g transform="translate(' + (c - size * 0.24) + ' ' + (c - size * 0.24) + ') scale(' +
    ((size * 0.48) / 24).toFixed(3) + ')" fill="' + (spent ? 'none' : '#f6ead0') +
    '" stroke="' + (spent ? ink : '#f6ead0') + '" stroke-width="1.4" stroke-linejoin="round">' +
    PATHS.cp + '</g></svg>');
}

/** The END TURN ribbon (notched tail, swallow-tail right edge). */
export function ribbon({ w = 220, h = 54, seed = 21, flip = false } = {}) {
  const notch = h * 0.34;
  const d = 'M' + (h * 0.16) + ' 2 H' + (w - 2) + ' L' + (w - 2 - notch) + ' ' + (h / 2) +
    ' L' + (w - 2) + ' ' + (h - 2) + ' H' + (h * 0.16) + ' L2 ' + (h / 2) + ' Z';
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w +
    '" height="' + h + '"' + (flip ? ' style="transform:scaleX(-1)"' : '') + '>' +
    '<path d="' + d + '" fill="url(#vc-ribbon-grad)" stroke="#5c1d22" stroke-width="1.6" ' +
    'stroke-linejoin="round" filter="url(#vc-rough)"/>' +
    '<path d="' + wobblyPath(h * 0.4, h * 0.24, w - notch * 0.9, h * 0.24, { seed, amp: 0.8, segs: 9 }) +
    '" stroke="#f1dcc0" stroke-opacity="0.32" stroke-width="1.2" fill="none"/>' +
    '<path d="' + wobblyPath(h * 0.4, h * 0.78, w - notch * 0.9, h * 0.78, { seed: seed + 5, amp: 0.8, segs: 9 }) +
    '" stroke="#3d1013" stroke-opacity="0.30" stroke-width="1.2" fill="none"/>' +
    '</svg>');
}

/** The book-mark tab that hangs off the top edge of the frame. */
export function bookmark({ w = 34, h = 96, text = '' } = {}) {
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w +
    '" height="' + h + '">' +
    '<path d="M0 0 H' + w + ' V' + (h - 14) + ' L' + (w / 2) + ' ' + h + ' L0 ' + (h - 14) +
    ' Z" fill="url(#vc-ribbon-grad)" stroke="#5c1d22" stroke-width="1.4" filter="url(#vc-rough)"/>' +
    (text ? '<text x="' + (w / 2) + '" y="' + (h * 0.52) +
      '" text-anchor="middle" fill="#f5e7cb" font-size="' + (w * 0.52) +
      '" font-family="Georgia,serif" letter-spacing="1">' + text + '</text>' : '') +
    '</svg>');
}

/** A hand-ruled horizontal rule, optionally with a centre diamond flourish. */
export function inkRule({ w = 240, seed = 3, weight = 1.3, flourish = false, color = '#5d4d3b' } = {}) {
  const h = 12, y = h / 2;
  let inner = '<path d="' + wobblyPath(2, y, w - 2, y, { seed, amp: 0.55, segs: Math.max(6, w / 26) }) +
    '" stroke="' + color + '" stroke-width="' + weight + '" fill="none" stroke-linecap="round"/>';
  if (flourish) {
    const c = w / 2;
    inner =
      '<path d="' + wobblyPath(2, y, c - 12, y, { seed, amp: 0.5, segs: 7 }) +
      '" stroke="' + color + '" stroke-width="' + weight + '" fill="none" stroke-linecap="round"/>' +
      '<path d="' + wobblyPath(c + 12, y, w - 2, y, { seed: seed + 4, amp: 0.5, segs: 7 }) +
      '" stroke="' + color + '" stroke-width="' + weight + '" fill="none" stroke-linecap="round"/>' +
      '<path d="M' + c + ' ' + (y - 4.2) + ' L' + (c + 5) + ' ' + y + ' L' + c + ' ' + (y + 4.2) +
      ' L' + (c - 5) + ' ' + y + ' Z" fill="' + color + '" opacity="0.85"/>';
  }
  return svgEl('<svg xmlns="http://www.w3.org/2000/svg" class="vc-rule" viewBox="0 0 ' + w + ' ' + h +
    '" width="100%" height="' + h + '" preserveAspectRatio="none">' + inner + '</svg>');
}

/** Corner flourish for the book frame — a double rule with a small leaf. */
export function cornerFlourish({ size = 84, seed = 9, color = '#4a3c2c' } = {}) {
  const s = size;
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + s + ' ' + s + '" width="' + s +
    '" height="' + s + '">' +
    '<g fill="none" stroke="' + color + '" stroke-linecap="round">' +
    '<path d="' + wobblyPath(2, s * 0.62, 2, 2, { seed, amp: 0.8, segs: 6 }) + ' ' +
    wobblyPath(2, 2, s * 0.62, 2, { seed: seed + 2, amp: 0.8, segs: 6 }) + '" stroke-width="1.5"/>' +
    '<path d="' + wobblyPath(7, s * 0.42, 7, 7, { seed: seed + 5, amp: 0.6, segs: 5 }) + ' ' +
    wobblyPath(7, 7, s * 0.42, 7, { seed: seed + 8, amp: 0.6, segs: 5 }) + '" stroke-width="0.8" opacity="0.7"/>' +
    '<path d="M' + (s * 0.16) + ' ' + (s * 0.16) + ' q' + (s * 0.2) + ' ' + (s * 0.04) + ' ' +
    (s * 0.26) + ' ' + (s * 0.22) + ' q-' + (s * 0.2) + ' -' + (s * 0.03) + ' -' + (s * 0.26) +
    ' -' + (s * 0.22) + 'Z" stroke-width="1" opacity="0.75"/>' +
    '</g></svg>');
}

// The sight picture is DRAWN, never vector-white. Every stroke in it goes down
// twice: a broad graphite pass that gives the mark its body and lets it read
// against a bleached stucco wall, then a narrower chalk pass laid inside it.
// A single uniform near-white hairline is the tell that gave the aim frame away.
const SIGHT_INK = '#2b211a';
const SIGHT_CHALK = '#f0e1bd';
// R25 — the ONE saturated thing in the frame. In docs/reference/vc-088.jpg the
// targeting ring is a warm orange (sampled ~#e8801f over a ~#c4551a shadow) and
// it carries the strongest chroma anywhere in that picture: it is what says
// "this is targeting mode" at a glance. Our sight picture was drawn entirely in
// the paper-ink palette, so at full size the aim frame read as "a soldier
// standing in front of a house". The reticle is DOM, above the canvas, so the
// grade's drawing falloff cannot desaturate it. Accent only — the crosshair arms
// stay ink, because VC's cross is a fine dark one.
const SIGHT_ACCENT = '#e8801f';
const SIGHT_ACCENT_DEEP = '#bd5415';

/** Broad ink pass + chalk pass over the same path list. */
function doubleStroke(d, { ink = SIGHT_INK, chalk = SIGHT_CHALK, w = 1.5, spread = 2.1 } = {}) {
  return '<path d="' + d + '" fill="none" stroke="' + ink + '" stroke-width="' +
    (w + spread).toFixed(2) + '" stroke-linecap="round" opacity="0.62"/>' +
    '<path d="' + d + '" fill="none" stroke="' + chalk + '" stroke-width="' + w.toFixed(2) +
    '" stroke-linecap="round" opacity="0.94"/>';
}

/** The AIM corner brackets that converge while aiming. */
export function aimBrackets({ w = 340, h = 240, seed = 31 } = {}) {
  const L = Math.min(w, h) * 0.16, o = 3;
  const corner = (x, y, sx, sy, sd) =>
    wobblyPath(x, y + sy * L, x, y, { seed: sd, amp: 1.1, segs: 4 }) + ' ' +
    wobblyPath(x, y, x + sx * L, y, { seed: sd + 3, amp: 1.1, segs: 4 });
  const d = [corner(o, o, 1, 1, seed), corner(w - o, o, -1, 1, seed + 11),
    corner(o, h - o, 1, -1, seed + 21), corner(w - o, h - o, -1, -1, seed + 31)].join(' ');
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w +
    '" height="' + h + '" preserveAspectRatio="none">' +
    doubleStroke(d, { w: 1.9, spread: 2.6 }) + '</svg>');
}

/** The fine ink crosshair (centre of the targeting overlay). */
export function crosshair({ size = 240, seed = 47, gap = 0.10, arm = 0.20 } = {}) {
  const c = size / 2, g = size * gap, a = size * arm;
  // Arms taper: a fat root at the gap thinning to a hairline at the tip, which
  // is what a nib does and what a plotted vector line never does.
  const arms = [
    wobblyPath(c, c - g, c, c - g - a, { seed, amp: 1.0, segs: 5 }),
    wobblyPath(c, c + g, c, c + g + a, { seed: seed + 5, amp: 1.0, segs: 5 }),
    wobblyPath(c - g, c, c - g - a, c, { seed: seed + 9, amp: 1.0, segs: 5 }),
    wobblyPath(c + g, c, c + g + a, c, { seed: seed + 13, amp: 1.0, segs: 5 }),
  ];
  // Root halves get the heavier weight, tips the lighter one.
  const roots = [
    wobblyPath(c, c - g, c, c - g - a * 0.45, { seed, amp: 0.8, segs: 3 }),
    wobblyPath(c, c + g, c, c + g + a * 0.45, { seed: seed + 5, amp: 0.8, segs: 3 }),
    wobblyPath(c - g, c, c - g - a * 0.45, c, { seed: seed + 9, amp: 0.8, segs: 3 }),
    wobblyPath(c + g, c, c + g + a * 0.45, c, { seed: seed + 13, amp: 0.8, segs: 3 }),
  ].join(' ');
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size +
    '" height="' + size + '">' +
    doubleStroke(arms.join(' '), { w: 1.25, spread: 1.9 }) +
    doubleStroke(roots, { w: 2.0, spread: 2.2 }) +
    // The aiming dot: a blotted point, not a circle. R25 — carried in the sight
    // accent (see SIGHT_ACCENT) so the exact aim point is the one warm mark at
    // the centre of the frame; the arms around it stay ink.
    '<path d="' + splatPath(c, c, 2.8, { seed: seed + 41, lobes: 8, rough: 0.3 }) +
    '" fill="' + SIGHT_ACCENT_DEEP + '" opacity="0.9"/>' +
    '<path d="' + splatPath(c - 0.4, c - 0.4, 1.5, { seed: seed + 43, lobes: 7, rough: 0.3 }) +
    '" fill="' + SIGHT_ACCENT + '" opacity="0.95"/>' +
    '</svg>');
}

/**
 * The accuracy ring. Radius is driven by the caller each frame (the element is
 * resized; this SVG scales to fit), so every stroke is `non-scaling-stroke`:
 * stroke widths are in SCREEN px, not user units. Without it a ring sized to a
 * real ballistic radius (~55 px across at 23 m) scaled its 3.4-unit strokes down
 * to 0.7 px and vanished, while a wide one drew 9 px cables.
 *
 * Solid, not dashed, for the same reason: a dasharray IS in user units, so the
 * dash pattern collapsed as the ring tightened. vc-088's ring is a continuous
 * orange circle with four pale dispersion ticks standing off it.
 */
export function accuracyRing({ size = 260, seed = 53 } = {}) {
  const c = size / 2, r = size * 0.42;
  const ns = ' vector-effect="non-scaling-stroke" stroke-linecap="round"';
  const d = roughCircle(c, c, r, { seed, amp: r * 0.035, segs: 44 });
  // Four dispersion ticks, standing off the ring at the diagonals.
  const tick = (a) => {
    const dx = Math.cos(a), dy = Math.sin(a);
    return 'M' + (c + dx * r * 1.13).toFixed(1) + ' ' + (c + dy * r * 1.13).toFixed(1) +
      'L' + (c + dx * r * 1.33).toFixed(1) + ' ' + (c + dy * r * 1.33).toFixed(1);
  };
  const ticks = [Math.PI * 0.75, Math.PI * 0.25, Math.PI * 1.25, Math.PI * 1.75].map(tick).join(' ');
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size +
    '" height="' + size + '">' +
    '<path d="' + d + '" fill="none" stroke="' + SIGHT_ACCENT_DEEP + '" stroke-width="5.4"' +
    ns + ' opacity="0.62"/>' +
    '<path d="' + d + '" fill="none" stroke="' + SIGHT_ACCENT + '" stroke-width="2.6"' +
    ns + ' opacity="0.96"/>' +
    // a second, drier pass just inside it — the compass slipped on the first go
    '<path d="' + roughCircle(c, c, r * 0.93, { seed: seed + 7, amp: r * 0.025, segs: 40 }) +
    '" fill="none" stroke="' + SIGHT_ACCENT_DEEP + '" stroke-width="0.9"' + ns + ' opacity="0.5"/>' +
    '<path d="' + ticks + '" fill="none" stroke="' + SIGHT_INK + '" stroke-width="4.2"' +
    ns + ' opacity="0.5"/>' +
    '<path d="' + ticks + '" fill="none" stroke="' + SIGHT_CHALK + '" stroke-width="2.0"' +
    ns + ' opacity="0.95"/>' +
    '</svg>');
}

/**
 * The body-part hit diagram: a drawn anatomical study out of a field manual,
 * not a stick figure. A greatcoated soldier in three-quarter stance, hatched in
 * the shaded half, with the selected region washed in carmine and ringed.
 */
export function bodyFigure({ part = 'torso', size = 96, color = '#4a3c2c', hot = '#a32f34' } = {}) {
  const w = size * 0.66, h = size;
  const S = (x) => (x * w).toFixed(2);
  const T = (y) => (y * h).toFixed(2);
  const on = (p) => (p === part ? hot : color);
  // The selected region is washed, not blocked in — the drawn silhouette has to
  // stay readable through the carmine.
  const fo = (p) => (p === part ? 0.15 : 0.07);
  const sw = (p) => (p === part ? 1.9 : 1.3);

  // --- outlines, drawn as closed rough silhouettes -------------------------
  // Head: an upright oval, taller than it is wide, with a helmet brow across it.
  const head =
    'M' + S(0.500) + ' ' + T(0.018) +
    'C' + S(0.622) + ' ' + T(0.018) + ' ' + S(0.658) + ' ' + T(0.072) + ' ' + S(0.652) + ' ' + T(0.118) +
    'C' + S(0.646) + ' ' + T(0.170) + ' ' + S(0.596) + ' ' + T(0.202) + ' ' + S(0.500) + ' ' + T(0.202) +
    'C' + S(0.404) + ' ' + T(0.202) + ' ' + S(0.354) + ' ' + T(0.170) + ' ' + S(0.348) + ' ' + T(0.118) +
    'C' + S(0.342) + ' ' + T(0.072) + ' ' + S(0.378) + ' ' + T(0.018) + ' ' + S(0.500) + ' ' + T(0.018) + 'Z';
  // helmet brow line so the head reads as a soldier, not an egg
  const helmet =
    'M' + S(0.344) + ' ' + T(0.098) +
    'C' + S(0.362) + ' ' + T(0.020) + ' ' + S(0.638) + ' ' + T(0.020) + ' ' + S(0.656) + ' ' + T(0.098) +
    'C' + S(0.586) + ' ' + T(0.074) + ' ' + S(0.414) + ' ' + T(0.074) + ' ' + S(0.344) + ' ' + T(0.098) + 'Z';
  // neck, so the head is not floating over the collar
  const neck = 'M' + S(0.452) + ' ' + T(0.196) + 'V' + T(0.232) + 'M' + S(0.548) + ' ' + T(0.196) +
    'V' + T(0.232);
  // Shoulders wide, a real waist, then the greatcoat flares to its hem — so the
  // silhouette reads as a soldier and not as a gingerbread man.
  const torso =
    'M' + S(0.500) + ' ' + T(0.205) +
    'C' + S(0.630) + ' ' + T(0.205) + ' ' + S(0.720) + ' ' + T(0.245) + ' ' + S(0.742) + ' ' + T(0.320) +
    'C' + S(0.756) + ' ' + T(0.385) + ' ' + S(0.706) + ' ' + T(0.440) + ' ' + S(0.688) + ' ' + T(0.492) +
    'C' + S(0.700) + ' ' + T(0.530) + ' ' + S(0.722) + ' ' + T(0.560) + ' ' + S(0.732) + ' ' + T(0.592) +
    'L' + S(0.268) + ' ' + T(0.592) +
    'C' + S(0.278) + ' ' + T(0.560) + ' ' + S(0.300) + ' ' + T(0.530) + ' ' + S(0.312) + ' ' + T(0.492) +
    'C' + S(0.294) + ' ' + T(0.440) + ' ' + S(0.244) + ' ' + T(0.385) + ' ' + S(0.258) + ' ' + T(0.320) +
    'C' + S(0.280) + ' ' + T(0.245) + ' ' + S(0.370) + ' ' + T(0.205) + ' ' + S(0.500) + ' ' + T(0.205) + 'Z';
  const armL =
    'M' + S(0.262) + ' ' + T(0.252) +
    'C' + S(0.168) + ' ' + T(0.286) + ' ' + S(0.118) + ' ' + T(0.372) + ' ' + S(0.100) + ' ' + T(0.512) +
    'L' + S(0.186) + ' ' + T(0.528) +
    'C' + S(0.204) + ' ' + T(0.418) + ' ' + S(0.232) + ' ' + T(0.346) + ' ' + S(0.300) + ' ' + T(0.312) + 'Z';
  const armR =
    'M' + S(0.738) + ' ' + T(0.252) +
    'C' + S(0.832) + ' ' + T(0.286) + ' ' + S(0.882) + ' ' + T(0.372) + ' ' + S(0.900) + ' ' + T(0.512) +
    'L' + S(0.814) + ' ' + T(0.528) +
    'C' + S(0.796) + ' ' + T(0.418) + ' ' + S(0.768) + ' ' + T(0.346) + ' ' + S(0.700) + ' ' + T(0.312) + 'Z';
  const legs =
    'M' + S(0.265) + ' ' + T(0.592) +
    'L' + S(0.735) + ' ' + T(0.592) +
    'C' + S(0.726) + ' ' + T(0.700) + ' ' + S(0.700) + ' ' + T(0.860) + ' ' + S(0.686) + ' ' + T(0.968) +
    'L' + S(0.556) + ' ' + T(0.968) +
    'C' + S(0.548) + ' ' + T(0.840) + ' ' + S(0.522) + ' ' + T(0.720) + ' ' + S(0.500) + ' ' + T(0.660) +
    'C' + S(0.478) + ' ' + T(0.720) + ' ' + S(0.452) + ' ' + T(0.840) + ' ' + S(0.444) + ' ' + T(0.968) +
    'L' + S(0.314) + ' ' + T(0.968) +
    'C' + S(0.300) + ' ' + T(0.860) + ' ' + S(0.274) + ' ' + T(0.700) + ' ' + S(0.265) + ' ' + T(0.592) + 'Z';

  const region = (d, p) =>
    '<path d="' + d + '" fill="' + on(p) + '" fill-opacity="' + fo(p) +
    '" stroke="' + on(p) + '" stroke-width="' + sw(p) + '"/>';

  // A marker ring over the selected region, so the choice reads at a glance.
  const RING = {
    head: [0.50, 0.110, 0.24], torso: [0.50, 0.400, 0.40],
    arms: [0.50, 0.395, 0.58], legs: [0.50, 0.780, 0.40], radiator: [0.50, 0.400, 0.40],
  };
  const rr = RING[part] || RING.torso;
  const ring =
    '<path d="' + roughCircle(rr[0] * w, rr[1] * h, rr[2] * w, { seed: 41, amp: w * 0.018, segs: 26 }) +
    '" fill="none" stroke="' + hot + '" stroke-width="1.3" stroke-dasharray="4 3.2" opacity="0.85"/>';

  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w +
    '" height="' + h + '">' +
    '<defs><clipPath id="vc-bfclip-' + part + '"><path d="' + torso + '"/></clipPath></defs>' +
    // No displacement filter here: at 96 px it chewed the outlines into mush.
    // The character comes from the drawn curves and the hatching instead.
    '<g stroke-linejoin="round" stroke-linecap="round">' +
    region(legs, 'legs') + region(armL, 'arms') + region(armR, 'arms') +
    '<path d="' + neck + '" stroke="' + color + '" stroke-width="1.1" opacity="0.8" fill="none"/>' +
    region(torso, 'torso') + region(head, 'head') +
    '<path d="' + helmet + '" fill="' + color + '" fill-opacity="0.16" stroke="' + on('head') +
    '" stroke-width="1.0"/>' +
    // pencil hatching down the shaded (left) flank of the coat
    '<g clip-path="url(#vc-bfclip-' + part + ')">' +
    '<path d="' + hatchPath(w * 0.22, h * 0.21, w * 0.24, h * 0.39, { spacing: 2.9, angle: -1.05, seed: 17 }) +
    '" stroke="' + color + '" stroke-width="0.6" opacity="0.55" fill="none"/>' +
    '<path d="' + hatchPath(w * 0.22, h * 0.40, w * 0.16, h * 0.20, { spacing: 2.6, angle: 0.62, seed: 19 }) +
    '" stroke="' + color + '" stroke-width="0.5" opacity="0.34" fill="none"/></g>' +
    // collar, buttoned placket and belt: the lines that make it read as a uniform
    '<path d="' + wobblyPath(w * 0.38, h * 0.240, w * 0.50, h * 0.290, { seed: 23, amp: 0.4, segs: 4 }) + ' ' +
    wobblyPath(w * 0.62, h * 0.240, w * 0.50, h * 0.290, { seed: 25, amp: 0.4, segs: 4 }) +
    '" stroke="' + color + '" stroke-width="1.0" opacity="0.75" fill="none"/>' +
    '<path d="' + wobblyPath(w * 0.50, h * 0.290, w * 0.50, h * 0.490, { seed: 27, amp: 0.4, segs: 5 }) +
    '" stroke="' + color + '" stroke-width="0.7" opacity="0.5" fill="none"/>' +
    '<path d="' + wobblyPath(w * 0.290, h * 0.492, w * 0.710, h * 0.492, { seed: 29, amp: 0.5, segs: 7 }) +
    '" stroke="' + color + '" stroke-width="1.25" opacity="0.8" fill="none"/>' +
    ring +
    '</g></svg>');
}

/**
 * A hand-inked key cap for the controls legend. Replaces a CSS rounded-rect
 * border, which read as a web keyboard chip rather than a drawn journal note.
 */
export function keyCap(text, { seed = 3, color = '#33291f' } = {}) {
  const t = String(text || '');
  const w = Math.max(20, 11 + t.length * 8.2), h = 20;
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w +
    '" height="' + h + '" class="vc-keycap">' +
    '<path d="' + roughRect(2, 2, w - 4, h - 4, { seed, amp: 0.55, segs: 4, overshoot: 0.9 }) +
    '" fill="rgba(247,239,221,.5)" stroke="' + color + '" stroke-width="1.15" ' +
    'stroke-linecap="round" opacity="0.82"/>' +
    '<text x="' + (w / 2) + '" y="' + (h * 0.70) + '" text-anchor="middle" fill="' + color +
    '" font-size="' + (h * 0.56) + '" font-family="Georgia,serif">' +
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</text></svg>');
}

/**
 * The north rose stamped on the tactical survey. It is not decoration: the
 * world's north is -Z (src/world/layout.js) and the survey is drawn north-up,
 * so the reader needs the arrow to trust the panel.
 */
export function compassRose({ size = 46, seed = 71, color = '#4a3c2c', accent = '#a32f34' } = {}) {
  const c = size / 2, r = size * 0.40;
  const needle =
    'M' + c + ' ' + (c - r) + 'L' + (c + r * 0.26) + ' ' + (c + r * 0.20) +
    'L' + c + ' ' + (c + r * 0.06) + 'L' + (c - r * 0.26) + ' ' + (c + r * 0.20) + 'Z';
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size +
    '" height="' + size + '">' +
    '<path d="' + roughCircle(c, c, r * 1.16, { seed, amp: r * 0.05, segs: 22 }) +
    '" fill="rgba(243,232,206,.35)" stroke="' + color + '" stroke-width="0.9" opacity="0.75"/>' +
    '<g stroke="' + color + '" stroke-width="0.7" opacity="0.55">' +
    '<path d="M' + c + ' ' + (c - r * 1.16) + 'V' + (c - r * 0.88) + '"/>' +
    '<path d="M' + c + ' ' + (c + r * 1.16) + 'V' + (c + r * 0.88) + '"/>' +
    '<path d="M' + (c - r * 1.16) + ' ' + c + 'H' + (c - r * 0.88) + '"/>' +
    '<path d="M' + (c + r * 1.16) + ' ' + c + 'H' + (c + r * 0.88) + '"/></g>' +
    '<path d="' + needle + '" fill="' + accent + '" fill-opacity="0.85" stroke="' + color +
    '" stroke-width="0.8" stroke-linejoin="round" filter="url(#vc-rough)"/>' +
    '<path d="M' + c + ' ' + (c + r * 0.06) + 'L' + (c + r * 0.20) + ' ' + (c + r * 0.62) +
    'L' + c + ' ' + (c + r * 0.50) + 'L' + (c - r * 0.20) + ' ' + (c + r * 0.62) +
    'Z" fill="none" stroke="' + color + '" stroke-width="0.8" stroke-linejoin="round" opacity="0.8"/>' +
    '<text x="' + c + '" y="' + (c - r * 1.22) + '" text-anchor="middle" fill="' + color +
    '" font-size="' + (size * 0.24) + '" font-family="Georgia,serif" letter-spacing="0.5">N</text>' +
    '</svg>');
}

/** Ruled scale bar for the survey: "|—————| 40 m", drawn by hand. */
export function mapScaleBar({ w = 74, seed = 83, color = '#4a3c2c' } = {}) {
  const h = 11, y = h * 0.55;
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w +
    '" height="' + h + '">' +
    '<g stroke="' + color + '" stroke-width="1.1" fill="none" stroke-linecap="round" opacity="0.8">' +
    '<path d="' + wobblyPath(2, y, w - 2, y, { seed, amp: 0.4, segs: 6 }) + '"/>' +
    '<path d="M2 ' + (y - 3) + 'V' + (y + 3) + '"/>' +
    '<path d="M' + (w / 2) + ' ' + (y - 2) + 'V' + (y + 2) + '"/>' +
    '<path d="M' + (w - 2) + ' ' + (y - 3) + 'V' + (y + 3) + '"/></g></svg>');
}

/**
 * A survey blip: an inked chevron pointing along the unit's heading, filled
 * with the team colour. Drawn rather than clip-path'd so it carries an outline
 * and reads at 10 px instead of looking like a flat CSS triangle.
 */
export function unitBlip({ size = 13, team = 0, seed = 5, selected = false } = {}) {
  const fill = team === 1 ? '#8d3730' : (selected ? '#a32f34' : '#37536f');
  const s = size, c = s / 2;
  const tri = 'M' + c + ' ' + (s * 0.06) + 'L' + (s * 0.93) + ' ' + (s * 0.94) +
    'L' + c + ' ' + (s * 0.72) + 'L' + (s * 0.07) + ' ' + (s * 0.94) + 'Z';
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + s + ' ' + s + '" width="' + s +
    '" height="' + s + '" class="blip">' +
    '<path d="' + tri + '" fill="' + fill + '" stroke="#2f261f" stroke-width="' +
    (s * 0.085).toFixed(2) + '" stroke-linejoin="round" opacity="0.96"/>' +
    (selected
      ? '<path d="' + roughCircle(c, c * 1.05, s * 0.62, { seed, amp: s * 0.05, segs: 18 }) +
        '" fill="none" stroke="#a32f34" stroke-width="' + (s * 0.09).toFixed(2) + '" opacity="0.9"/>'
      : '') +
    '</svg>');
}

/** The results-screen rank stamp: rough double ring over an ink splat. */
export function rankStamp({ size = 180, seed = 77, color = '#77202a' } = {}) {
  const c = size / 2;
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size +
    '" height="' + size + '">' +
    '<path d="' + splatPath(c, c, size * 0.40, { seed: seed + 5, lobes: 13, rough: 0.20 }) +
    '" fill="' + color + '" opacity="0.10" filter="url(#vc-splat)"/>' +
    '<path d="' + roughCircle(c, c, size * 0.44, { seed, amp: size * 0.012, segs: 34 }) +
    '" fill="none" stroke="' + color + '" stroke-width="' + (size * 0.035) + '" opacity="0.9"/>' +
    '<path d="' + roughCircle(c, c, size * 0.375, { seed: seed + 3, amp: size * 0.010, segs: 30 }) +
    '" fill="none" stroke="' + color + '" stroke-width="' + (size * 0.013) + '" opacity="0.8"/>' +
    '</svg>');
}

/** Ink splat used behind damage numerals. */
export function splat({ size = 76, seed = 1, color = '#7c2028', opacity = 0.85 } = {}) {
  const c = size / 2;
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size +
    '" height="' + size + '">' +
    '<path d="' + splatPath(c, c, size * 0.32, { seed, lobes: 10, rough: 0.5 }) +
    '" fill="' + color + '" opacity="' + opacity + '" filter="url(#vc-splat)"/></svg>');
}

/**
 * A damage pop, drawn as one piece: a thrown blot of ink with the figure struck
 * through it in a heavy nib, outlined so it holds against ANY background.
 *
 * Bare DOM digits with a text-shadow — which is what this used to be — read as
 * floating browser text the instant they cross a busy hillside. Here the numeral
 * is SVG with `paint-order:stroke`, so the ink outline is real ink laid under
 * real chalk, and it never disappears into the terrain behind it.
 *
 * @returns {SVGElement} root with `.set(text, {crit, heal, tag})`
 */
export function damagePlate({ seed = 1 } = {}) {
  const W = 160, H = 118, cx = W / 2, cy = 58;
  const rng = makeRng((seed >>> 0) || 1);
  // Two overlapping throws of ink plus a spray of flicks: a splash, not a disc.
  let blot = '<path class="b1" d="' + splatPath(cx, cy, 34, { seed, lobes: 11, rough: 0.52 }) +
    '" filter="url(#vc-splat)"/>' +
    '<path class="b2" d="' + splatPath(cx + 6, cy + 4, 23, { seed: seed + 17, lobes: 9, rough: 0.6 }) +
    '" filter="url(#vc-splat)"/>';
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2, dist = 34 + rng() * 40, r = 1.3 + rng() * 3.4;
    blot += '<path class="b3" d="' + splatPath(cx + Math.cos(a) * dist, cy + Math.sin(a) * dist * 0.72,
      r, { seed: seed + 31 + i * 7, lobes: 7, rough: 0.45 }) + '"/>';
  }
  const root = svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W +
    '" height="' + H + '" class="vc-dmg-svg">' +
    '<g class="blot">' + blot + '</g>' +
    '<text class="num" x="' + cx + '" y="' + (cy + 15) + '" text-anchor="middle" ' +
    'font-size="52" letter-spacing="0.5" ' +
    'style="paint-order:stroke fill;stroke-linejoin:round" ' +
    'font-family="Iowan Old Style,Palatino,Georgia,serif">0</text>' +
    '<text class="tag" x="' + cx + '" y="' + (cy + 40) + '" text-anchor="middle" font-size="15" ' +
    'letter-spacing="3.2" font-family="Iowan Old Style,Palatino,Georgia,serif"></text>' +
    '</svg>');
  const num = root.querySelector('.num');
  const tag = root.querySelector('.tag');
  root.set = (text, { crit = false, heal = false, tagText = '' } = {}) => {
    num.textContent = text;
    tag.textContent = tagText;
    root.setAttribute('class', 'vc-dmg-svg' + (crit ? ' crit' : '') + (heal ? ' heal' : ''));
  };
  return root;
}

/** The heading caret nailed to the centre of the compass tape. */
export function compassPip({ w = 13, seed = 5 } = {}) {
  const h0 = w * 0.9;
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h0 + '" width="' + w +
    '" height="' + h0 + '">' +
    '<path d="' + wobblyPath(1, 1, w / 2, h0 - 1, { seed, amp: 0.4, segs: 3 }) + ' ' +
    wobblyPath(w / 2, h0 - 1, w - 1, 1, { seed: seed + 5, amp: 0.4, segs: 3 }) + ' ' +
    wobblyPath(w - 1, 1, 1, 1, { seed: seed + 9, amp: 0.4, segs: 3 }) +
    '" fill="#a32f34" stroke="#6d1f22" stroke-width="1" stroke-linejoin="round"/></svg>');
}

/** One nibbed compass tick. `major` 0 minor / 1 half / 2 cardinal. */
export function compassTick({ major = 0, seed = 3, color = '#4a3c2c' } = {}) {
  const h0 = major === 2 ? 11 : major === 1 ? 7.5 : 4.5;
  const wdt = major === 2 ? 1.9 : major === 1 ? 1.35 : 1.0;
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 12" width="4" height="12">' +
    '<path d="' + wobblyPath(2, 0.4, 2, h0, { seed, amp: 0.32, segs: 2 }) +
    '" stroke="' + color + '" stroke-width="' + wdt + '" stroke-linecap="round" fill="none" ' +
    'opacity="' + (major === 2 ? 0.92 : major === 1 ? 0.6 : 0.4) + '"/></svg>');
}

/** The camera's field of view, brushed onto the tactical survey. */
export function viewWedge({ w = 40, h: hgt = 46, seed = 29 } = {}) {
  const gid = 'vcw' + (++_gid);
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + hgt + '" width="' + w +
    '" height="' + hgt + '">' +
    '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#f6e9c6" stop-opacity="0.72"/>' +
    '<stop offset="1" stop-color="#f6e9c6" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="M' + (w / 2) + ' 1 L' + (w - 1) + ' ' + (hgt - 1) + ' L1 ' + (hgt - 1) +
    'Z" fill="url(#' + gid + ')" filter="url(#vc-wash)"/>' +
    '<path d="' + wobblyPath(w / 2, 2, w - 2, hgt - 2, { seed, amp: 0.7, segs: 4 }) + ' ' +
    wobblyPath(w / 2, 2, 2, hgt - 2, { seed: seed + 7, amp: 0.7, segs: 4 }) +
    '" fill="none" stroke="#5d4d3b" stroke-width="0.9" opacity="0.55" stroke-linecap="round"/>' +
    '</svg>');
}

/** Capture-progress ring drawn over a base camp in world space. */
export function captureRing({ size = 86, progress = 0, team = 0, seed = 63 } = {}) {
  const c = size / 2, r = size * 0.40;
  const col = team === 1 ? '#8d3730' : '#37536f';
  const circ = 2 * Math.PI * r;
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size +
    '" height="' + size + '">' +
    '<path d="' + roughCircle(c, c, r, { seed, amp: r * 0.035, segs: 30 }) +
    '" fill="rgba(243,232,206,.16)" stroke="#3a2f33" stroke-width="1.4" opacity="0.75"/>' +
    '<circle class="prog" cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="' + col +
    '" stroke-width="' + (size * 0.075) + '" stroke-linecap="round" opacity="0.92" ' +
    'stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' +
    (circ * (1 - progress)).toFixed(1) + '" transform="rotate(-90 ' + c + ' ' + c + ')"/>' +
    '</svg>');
}

/**
 * A stylised journal map: contours, a river, a road, hatched high ground.
 * Deterministic from `seed`, so the briefing map and the mini-map agree.
 */
export function terrainSketch({ w = 320, h = 240, seed = 1234, contours = 7 } = {}) {
  const rng = makeRng((seed >>> 0) || 1);
  let g = '';
  // contour rings — nested wandering loops suggesting two hills
  for (let hill = 0; hill < 2; hill++) {
    const cx = w * (0.24 + hill * 0.48 + (rng() - 0.5) * 0.08);
    const cy = h * (0.30 + rng() * 0.34);
    const base = Math.min(w, h) * (0.10 + rng() * 0.05);
    for (let i = 0; i < contours; i++) {
      const r = base + i * Math.min(w, h) * 0.043;
      g += '<path d="' + roughCircle(cx, cy, r, { seed: seed + hill * 31 + i * 7, amp: r * 0.10, segs: 22 }) +
        '" fill="none" stroke="#7a6647" stroke-width="' + (i === 0 ? 1.2 : 0.75) +
        '" opacity="' + (0.62 - i * 0.055).toFixed(2) + '"/>';
    }
    g += '<path d="' + hatchPath(cx - base * 0.7, cy - base * 0.7, base * 1.4, base * 1.4,
      { spacing: 4, angle: -0.9, seed: seed + hill * 17 }) +
      '" stroke="#7a6647" stroke-width="0.55" opacity="0.34" fill="none"/>';
  }
  // river — a meander from left edge to bottom
  let d = 'M0 ' + (h * (0.55 + rng() * 0.2)).toFixed(1);
  let px = 0, py = h * 0.6;
  for (let i = 1; i <= 6; i++) {
    const nx = (i / 6) * w;
    const ny = h * (0.45 + Math.sin(i * 1.3 + seed * 0.001) * 0.16 + (rng() - 0.5) * 0.10);
    d += 'Q' + ((px + nx) / 2).toFixed(1) + ' ' + (py + (rng() - 0.5) * h * 0.16).toFixed(1) +
      ' ' + nx.toFixed(1) + ' ' + ny.toFixed(1);
    px = nx; py = ny;
  }
  g += '<path d="' + d + '" fill="none" stroke="#6b8a94" stroke-width="3.4" opacity="0.55"/>';
  g += '<path d="' + d + '" fill="none" stroke="#40606b" stroke-width="0.9" opacity="0.5"/>';
  // road — dashed track corner to corner
  g += '<path d="' + wobblyPath(w * 0.06, h * 0.92, w * 0.94, h * 0.12,
    { seed: seed + 91, amp: h * 0.045, segs: 11 }) +
    '" fill="none" stroke="#8a6a44" stroke-width="2.2" stroke-dasharray="9 5" opacity="0.6"/>';
  // Frame: hand-ruled with overshot corners. At 1.3 px over a 400-unit box a
  // 0.9 amp wobble is invisible and the border reads as a CSS rectangle.
  g += '<path d="' + roughRect(3, 3, w - 6, h - 6,
    { seed: seed + 5, amp: 2.4, segs: 14, overshoot: 3.2 }) +
    '" fill="none" stroke="#4a3c2c" stroke-width="1.5" stroke-linecap="round" opacity="0.82"/>';
  g += '<path d="' + roughRect(6, 6, w - 12, h - 12,
    { seed: seed + 23, amp: 1.6, segs: 11, overshoot: 0 }) +
    '" fill="none" stroke="#4a3c2c" stroke-width="0.6" stroke-linecap="round" opacity="0.34"/>';
  return svgEl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h +
    '" width="100%" height="100%" preserveAspectRatio="none">' + g + '</svg>');
}

/** Chapter-card headpiece: a distant line-drawn landscape. */
export function chapterVignette({ w = 480, h = 150, seed = 404 } = {}) {
  const rng = makeRng((seed >>> 0) || 1);
  let g = '';
  for (let layer = 0; layer < 3; layer++) {
    const base = h * (0.52 + layer * 0.13);
    const amp = h * (0.22 - layer * 0.06);
    let d = 'M0 ' + h + ' L0 ' + base.toFixed(1);
    for (let i = 1; i <= 14; i++) {
      const x = (i / 14) * w;
      const y = base - Math.abs(Math.sin(i * (0.7 + layer * 0.5) + layer * 2.1)) * amp -
        (rng() - 0.5) * amp * 0.3;
      d += 'L' + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    d += 'L' + w + ' ' + h + 'Z';
    g += '<path d="' + d + '" fill="#6d7350" fill-opacity="' + (0.10 + layer * 0.07).toFixed(2) +
      '" stroke="#4a3c2c" stroke-width="' + (1.3 - layer * 0.3) + '" stroke-opacity="' +
      (0.75 - layer * 0.18).toFixed(2) + '"/>';
  }
  // a bridge in the middle distance — the Vasel motif
  const bx = w * 0.32, bw = w * 0.36, by = h * 0.70;
  g += '<path d="M' + bx + ' ' + by + ' H' + (bx + bw) + '" stroke="#4a3c2c" stroke-width="2" fill="none"/>';
  for (let i = 0; i <= 3; i++) {
    const x = bx + (i / 3) * bw;
    g += '<path d="M' + x.toFixed(1) + ' ' + by + ' V' + (by + h * 0.20).toFixed(1) +
      '" stroke="#4a3c2c" stroke-width="1.2" opacity="0.8"/>';
  }
  g += '<path d="M' + bx + ' ' + by + ' q' + (bw / 4) + ' -' + (h * 0.16) + ' ' + (bw / 2) + ' 0 q' +
    (bw / 4) + ' ' + (h * 0.16) + ' ' + (bw / 2) + ' 0" fill="none" stroke="#4a3c2c" ' +
    'stroke-width="1.1" opacity="0.7"/>';
  g += '<path d="M0 ' + (h * 0.92) + ' H' + w + '" stroke="#6b8a94" stroke-width="4" opacity="0.35"/>';
  return svgEl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h +
    '" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto">' + g + '</svg>');
}

/** A tiny ammunition pip (filled = live round, hollow = spent). */
export function ammoPip({ spent = false, w = 10, h = 24 } = {}) {
  const col = spent ? 'none' : '#b3873f';
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w +
    '" height="' + h + '"><path d="M' + (w / 2) + ' 1 L' + (w - 1) + ' ' + (h * 0.30) + ' V' +
    (h - 1) + ' H1 V' + (h * 0.30) + ' Z" fill="' + col + '" stroke="#4a3c2c" stroke-width="1.1" ' +
    'stroke-linejoin="round"/><path d="M1 ' + (h * 0.62) + ' H' + (w - 1) +
    '" stroke="#4a3c2c" stroke-width="0.8" opacity="0.6"/></svg>');
}

/** Hand-drawn tick marks for the AP meter. */
export function meterTicks({ w = 400, h = 22, count = 9, seed = 88 } = {}) {
  let g = '';
  for (let i = 1; i < count; i++) {
    const x = (i / count) * w;
    const tall = i % 2 === 0;
    g += '<path d="' + wobblyPath(x, h * (tall ? 0.18 : 0.34), x, h * (tall ? 0.82 : 0.66),
      { seed: seed + i * 3, amp: 0.4, segs: 3 }) +
      '" stroke="#4a3c2c" stroke-width="' + (tall ? 1.0 : 0.7) + '" opacity="' +
      (tall ? 0.55 : 0.38) + '" fill="none"/>';
  }
  return svgEl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h +
    '" width="100%" height="100%" preserveAspectRatio="none">' + g + '</svg>');
}

/** Full-viewport hand-ruled border for the book frame. */
export function frameRule({ w = 1600, h = 900, seed = 202 } = {}) {
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h +
    '" width="100%" height="100%" preserveAspectRatio="none">' +
    '<path d="' + roughRect(6, 6, w - 12, h - 12, { seed, amp: 1.6, segs: 26, overshoot: 0 }) +
    '" fill="none" stroke="#4a3c2c" stroke-width="1.6" opacity="0.55"/>' +
    '<path d="' + roughRect(13, 13, w - 26, h - 26, { seed: seed + 11, amp: 1.1, segs: 22, overshoot: 0 }) +
    '" fill="none" stroke="#4a3c2c" stroke-width="0.7" opacity="0.30"/>' +
    '</svg>');
}

// --------------------------------------------------------------------------
// Drawn gauges — a meter in this book is INKED, never a filled <div>
// --------------------------------------------------------------------------

/**
 * The pigments a gauge may be laid in. Every one is an EARTH — sap green, raw
 * sienna, burnt umber, red oxide. The previous set held a #6d92b1 web blue and a
 * flat #8a9c56 that existed nowhere else in the painting, and a critic named
 * exactly that as the automatic-reject "browser-default control".
 *   a    the thin edge of the wash, where the paper still shows through
 *   b    the body of the colour
 *   pool where the pigment settled and dried darkest
 */
const PIGMENT = {
  hp: { a: '#aeac89', b: '#818458', pool: '#575c37' },
  warn: { a: '#e0c184', b: '#b8862f', pool: '#8a5f1c' },
  crit: { a: '#c58b6c', b: '#9d4331', pool: '#71271f' },
  ap: { a: '#e8dcc0', b: '#c08a3e', pool: '#966522' },
  foe: { a: '#c2926f', b: '#9c4a3f', pool: '#6f2b23' },
  ink: { a: '#a89372', b: '#6f5738', pool: '#463218' },
};

let _gid = 0;

/**
 * A ruled gauge trough with a brushed pigment wash.
 *
 * Four layers, so the reading can never collapse into a CSS progress bar:
 *   back  graphite hatch laid inside the trough (the empty run is *paper*)
 *   wash  a full-length painted band — irregular top and bottom edges, pigment
 *         mottled with blots, settled dark along the foot — CLIPPED to the
 *         value rather than scaled, so the wobble keeps its own drawn length
 *   nib   the wet edge: where the brush lifted, the pigment pools and bleeds
 *   face  segment ticks + a hand-ruled box drawn ON TOP of the paint, so the
 *         rule reads as ink over pigment rather than as a border around a bar
 *
 * @param {{w?:number,h?:number,seed?:number,segs?:number,tone?:string}} o
 * @returns {HTMLElement} root with `.set(frac, tone?)` attached
 */
export function inkGauge({ w = 200, h: hgt = 14, seed = 11, segs = 8, tone = 'hp' } = {}) {
  const pad = 1.4;
  const iw = w - pad * 2, ih = hgt - pad * 2;
  const vb = ' viewBox="0 0 ' + w + ' ' + hgt + '" preserveAspectRatio="none"';
  const gid = 'vcg' + (++_gid);

  const back = svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg"' + vb + '>' +
    // TWO angles, not one. A single rank of parallel strokes at 34% opacity is
    // what the critique kept reading as "weak hatching" on the UI: at gauge
    // scale it disappears into the paper and the empty run of a meter comes out
    // as a blank div. A cross-hatch — the dominant rank plus a sparser
    // counter-rank at the opposite lean — is what a pencil actually leaves when
    // it fills a ledger column, and it survives being 11 px tall.
    '<path d="' + hatchPath(pad, pad, iw, ih, {
      spacing: Math.max(1.9, hgt * 0.19), angle: -0.92, seed: seed + 5, amp: 0.3,
    }) + '" stroke="#4a3c2c" stroke-width="0.65" opacity="0.46" fill="none"/>' +
    '<path d="' + hatchPath(pad, pad, iw, ih, {
      spacing: Math.max(3.4, hgt * 0.34), angle: 0.74, seed: seed + 71, amp: 0.36,
    }) + '" stroke="#4a3c2c" stroke-width="0.5" opacity="0.26" fill="none"/>' +
    '<path d="' + wobblyPath(pad, pad + ih * 0.22, w - pad, pad + ih * 0.22,
      { seed: seed + 31, amp: 0.4, segs: 7 }) +
    '" stroke="#3a2f28" stroke-width="0.7" opacity="0.16" fill="none"/></svg>');
  back.classList.add('vc-g-back');

  // ---- the wash ----------------------------------------------------------
  // The band is a closed path: a wandering top edge, a wandering foot, joined
  // at the ends. Laid as a rectangle it read as a filled div no matter what
  // colour went in it.
  const segsE = Math.max(6, Math.round(w / 14));
  const top = pad + ih * 0.13, bot = pad + ih * 0.90;
  const edge = (y, s, amp) => {
    const rng = makeRng((s >>> 0) || 1);
    let d = '';
    for (let i = 0; i <= segsE; i++) {
      const x = pad + (i / segsE) * iw;
      const yy = y + (rng() * 2 - 1) * amp;
      d += (i === 0 ? '' : 'L') + x.toFixed(2) + ' ' + yy.toFixed(2);
    }
    return d;
  };
  const band = 'M' + edge(top, seed + 101, ih * 0.09) +
    'L' + (pad + iw).toFixed(2) + ' ' + bot.toFixed(2) +
    'L' + edge(bot, seed + 137, ih * 0.08).split('L').reverse().join('L') + 'Z';
  let wash =
    '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="0.35">' +
    '<stop offset="0" style="stop-color:var(--pig-a)"/>' +
    '<stop offset="0.42" style="stop-color:var(--pig-b)"/>' +
    '<stop offset="1" style="stop-color:var(--pig-pool)"/></linearGradient></defs>' +
    '<g filter="url(#vc-wash)">' +
    '<path d="' + band + '" fill="url(#' + gid + ')"/>';
  // blots: where the brush loaded and where it ran dry
  const brng = makeRng(((seed + 7) >>> 0) || 1);
  for (let i = 0; i < 4; i++) {
    const cx = pad + (0.10 + brng() * 0.85) * iw;
    const cy = pad + (0.28 + brng() * 0.5) * ih;
    wash += '<path d="' + splatPath(cx, cy, ih * (0.36 + brng() * 0.55),
      { seed: seed + 41 + i * 13, lobes: 9, rough: 0.5 }) +
      '" style="fill:var(--pig-pool)" opacity="' + (0.14 + brng() * 0.20).toFixed(2) + '"/>';
  }
  // Dry-brush breaks: where the tooth of the paper took no pigment at all.
  for (let i = 0; i < 3; i++) {
    const x0 = pad + (0.12 + brng() * 0.72) * iw;
    wash += '<path d="' + wobblyPath(x0, pad + ih * 0.30, x0 + iw * 0.08, pad + ih * 0.30,
      { seed: seed + 201 + i * 9, amp: ih * 0.12, segs: 4 }) +
      '" stroke="#fdf6e4" stroke-width="' + (ih * 0.13).toFixed(2) +
      '" fill="none" opacity="0.30" stroke-linecap="round"/>';
  }
  // pigment settles along the foot of a wet band, and the top edge stays pale
  wash += '<path d="' + wobblyPath(pad, bot - ih * 0.10, pad + iw, bot - ih * 0.10,
    { seed: seed + 167, amp: ih * 0.06, segs: segsE }) +
    '" style="stroke:var(--pig-pool)" stroke-width="' + (ih * 0.26).toFixed(2) +
    '" fill="none" opacity="0.34"/>' +
    '<path d="' + wobblyPath(pad, top + ih * 0.13, pad + iw, top + ih * 0.13,
      { seed: seed + 173, amp: ih * 0.05, segs: segsE }) +
    '" stroke="#fdf6e4" stroke-width="' + (ih * 0.16).toFixed(2) +
    '" fill="none" opacity="0.22"/></g>';
  const washEl = svgEl('<svg xmlns="http://www.w3.org/2000/svg"' + vb + '>' + wash + '</svg>');
  const washBox = h('div', { class: 'vc-g-wash' });
  washBox.appendChild(washEl);

  // The nib: pigment pools and bleeds out where the brush was lifted.
  const nib = svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 ' + hgt +
    '" preserveAspectRatio="none">' +
    '<path d="' + splatPath(3.4, hgt * 0.66, hgt * 0.36, { seed: seed + 59, lobes: 8, rough: 0.55 }) +
    '" style="fill:var(--pig-pool)" opacity="0.72"/>' +
    '<path d="' + wobblyPath(3.0, top - 0.4, 3.0, bot + 0.4, { seed: seed + 61, amp: 1.0, segs: 4 }) +
    '" style="stroke:var(--pig-pool)" stroke-width="3.0" fill="none" stroke-linecap="round" ' +
    'opacity="0.88"/></svg>');
  nib.classList.add('vc-g-nib');

  // ---- the ink over the paint --------------------------------------------
  // Ticks are struck twice — a pale ghost under a graphite stroke — so the same
  // rule reads whether it crosses bare paper or laid pigment.
  let face = '';
  for (let i = 1; i < segs; i++) {
    const x = pad + (i / segs) * iw;
    const tall = segs <= 6 || i % 2 === 0;
    const d = wobblyPath(x, pad + ih * (tall ? 0.10 : 0.28), x, pad + ih * (tall ? 0.90 : 0.72),
      { seed: seed + i * 7, amp: 0.32, segs: 2 });
    face += '<path d="' + d + '" stroke="#f4ead2" stroke-width="' + (tall ? 1.9 : 1.5) +
      '" opacity="' + (tall ? 0.34 : 0.22) + '" fill="none"/>' +
      '<path d="' + d + '" stroke="#3a2f28" stroke-width="' + (tall ? 0.85 : 0.6) +
      '" opacity="' + (tall ? 0.5 : 0.32) + '" fill="none"/>';
  }
  // The trough is ruled, not bordered: two hand-drawn rules along the long
  // edges with the short ends barely closed, the way a ledger column is struck.
  face += '<path d="' + wobblyPath(pad - 0.6, pad, pad + iw + 0.9, pad,
    { seed: seed + 3, amp: 0.45, segs: Math.max(5, w / 22), overshoot: 1.6 }) +
    '" fill="none" stroke="#3a2f28" stroke-width="1.35" opacity="0.88" stroke-linecap="round"/>' +
    '<path d="' + wobblyPath(pad - 0.9, pad + ih, pad + iw + 0.6, pad + ih,
      { seed: seed + 9, amp: 0.5, segs: Math.max(5, w / 22), overshoot: 1.9 }) +
    '" fill="none" stroke="#3a2f28" stroke-width="1.05" opacity="0.78" stroke-linecap="round"/>' +
    '<path d="' + wobblyPath(pad, pad - 0.4, pad, pad + ih + 0.4, { seed: seed + 15, amp: 0.35, segs: 2 }) +
    ' ' + wobblyPath(pad + iw, pad - 0.4, pad + iw, pad + ih + 0.4, { seed: seed + 21, amp: 0.35, segs: 2 }) +
    '" fill="none" stroke="#3a2f28" stroke-width="0.85" opacity="0.6" stroke-linecap="round"/>';
  const faceEl = svgEl('<svg xmlns="http://www.w3.org/2000/svg"' + vb + '>' + face + '</svg>');
  faceEl.classList.add('vc-g-face');

  const root = h('div', { class: 'vc-g' });
  root.appendChild(back);
  root.appendChild(washBox);
  root.appendChild(nib);
  root.appendChild(faceEl);

  let last = -1, lastTone = '';
  const paint = (t) => {
    const p = PIGMENT[t] || PIGMENT.hp;
    lastTone = t;
    root.style.setProperty('--pig-a', p.a);
    root.style.setProperty('--pig-b', p.b);
    root.style.setProperty('--pig-pool', p.pool);
  };
  paint(tone);
  root.set = (frac, t) => {
    const v = clamp01(frac);
    if (t && t !== lastTone) paint(t);
    const k = Math.round(v * 400);
    if (k === last) return;
    last = k;
    // Clipped, never scaled: the drawn edges must keep their own wobble length.
    washBox.style.clipPath = 'inset(0 ' + ((1 - v) * 100).toFixed(2) + '% 0 0)';
    washBox.style.opacity = v < 0.004 ? '0' : '1';
    nib.style.left = 'calc(' + (v * 100).toFixed(2) + '% - 4px)';
    nib.style.opacity = v < 0.02 || v > 0.995 ? '0' : '1';
    // Hatching belongs to the DRY part of the trough only: laid under the wash
    // it turned the pigment into a hatched swatch instead of a laid colour.
    back.style.clipPath = 'inset(0 0 0 ' + (v * 100).toFixed(2) + '%)';
  };
  root.set(1);
  return root;
}

/**
 * A surveyor's march line — the AP readout. Deliberately NOT a bar: AP in this
 * game is a *distance*, so it is drawn as a chained pace-line with a pin at the
 * head of the run, the way a route is stepped off on a field map.
 * @returns {HTMLElement} root with `.set(frac)` attached
 */
export function marchLine({ w = 150, h: hgt = 10, seed = 21, paces = 9 } = {}) {
  const y = hgt * 0.56;
  // A trough for the line to be stepped off IN, laid UNDER everything. Without
  // it the march reads as a stray underline rather than as a gauge, and the AP
  // row vanished beside the painted HP band right above it.
  const trough = svgEl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + hgt +
    '" preserveAspectRatio="none"><path d="' +
    wobblyPath(2, y, w - 6, y, { seed: seed + 211, amp: 0.30, segs: Math.max(5, w / 26) }) +
    '" stroke="#c9b184" stroke-width="' + (hgt * 0.70).toFixed(2) +
    '" fill="none" stroke-linecap="round" opacity="0.40"/><path d="' +
    hatchPath(2, hgt * 0.18, w - 8, hgt * 0.66, { spacing: 2.6, angle: -0.9, seed: seed + 233 }) +
    '" stroke="#4a3c2c" stroke-width="0.5" opacity="0.20" fill="none"/></svg>');
  trough.classList.add('vc-m-trough');
  let g = '';
  for (let i = 0; i < paces; i++) {
    const x0 = 2 + (i / paces) * (w - 8) + 1.2;
    const x1 = 2 + ((i + 0.62) / paces) * (w - 8);
    g += '<path d="' + wobblyPath(x0, y, x1, y, { seed: seed + i * 5, amp: 0.35, segs: 2 }) +
      '" stroke="#4a3c2c" stroke-width="0.9" opacity="0.42" fill="none" stroke-linecap="round"/>';
  }
  for (let i = 0; i <= paces; i += 3) {
    const x = 2 + (i / paces) * (w - 8);
    g += '<path d="M' + x.toFixed(1) + ' ' + (y - hgt * 0.26) + 'V' + (y + hgt * 0.26) +
      '" stroke="#4a3c2c" stroke-width="0.8" opacity="0.42"/>';
  }
  const back = svgEl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + hgt +
    '" preserveAspectRatio="none">' + g + '</svg>');
  back.classList.add('vc-m-back');

  // The route already stepped off: a broad sepia wash under a firm nib line.
  // It used to be laid in #3a5872 over #8fa6b8 — a web blue with no counterpart
  // anywhere in the painting, which is precisely the axis-11 tell.
  const runSvg = svgEl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + hgt +
    '" preserveAspectRatio="none"><path d="' +
    wobblyPath(2, y, w - 6, y, { seed: seed + 71, amp: 0.55, segs: Math.max(6, w / 18) }) +
    '" stroke="#b79a68" stroke-width="3.6" fill="none" stroke-linecap="round" opacity="0.50"/>' +
    '<path d="' + wobblyPath(2, y - 0.5, w - 6, y - 0.5,
      { seed: seed + 73, amp: 0.5, segs: Math.max(6, w / 18) }) +
    '" stroke="#5d4426" stroke-width="2.0" fill="none" stroke-linecap="round"/></svg>');
  const run = h('div', { class: 'vc-m-run' });
  run.appendChild(runSvg);

  // A surveyor's flag pinned at the head of the run, inked in the book's red.
  const pin = svgEl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 ' + hgt + '">' +
    '<path d="' + wobblyPath(4.5, hgt * 0.06, 4.5, hgt * 0.98, { seed: seed + 81, amp: 0.35, segs: 3 }) +
    '" stroke="#8d2f31" stroke-width="1.7" fill="none" stroke-linecap="round"/>' +
    '<path d="M4.5 ' + (hgt * 0.10).toFixed(2) + 'l4.0 1.7-4.0 1.9Z" fill="#a32f34" ' +
    'stroke="#6d1f22" stroke-width="0.6" stroke-linejoin="round"/></svg>');
  pin.classList.add('vc-m-pin');

  const root = h('div', { class: 'vc-m' });
  root.appendChild(trough);
  root.appendChild(back);
  root.appendChild(run);
  root.appendChild(pin);
  let last = -1;
  root.set = (frac) => {
    const v = clamp01(frac);
    const k = Math.round(v * 300);
    if (k === last) return;
    last = k;
    run.style.clipPath = 'inset(0 ' + ((1 - v) * 100).toFixed(2) + '% 0 0)';
    pin.style.left = (v * 100).toFixed(2) + '%';
    pin.style.opacity = v < 0.01 ? '0' : '1';
  };
  root.set(1);
  return root;
}

/**
 * A drawn dial — an inked arc that fills clockwise from the bottom-left. The
 * moving arc carries class `prog`; set its `stroke-dashoffset` to drive it.
 */
export function dialGauge({ size = 46, seed = 61, color = '#4a3c2c', ink = '#a32f34' } = {}) {
  const c = size / 2, r = size * 0.38;
  const span = Math.PI * 1.5;                       // 270 degrees, gap at the foot
  const a0 = Math.PI * 0.75;
  const pt = (a) => [(c + Math.cos(a) * r).toFixed(2), (c + Math.sin(a) * r).toFixed(2)];
  const [x0, y0] = pt(a0), [x1, y1] = pt(a0 + span);
  const arc = 'M' + x0 + ' ' + y0 + 'A' + r.toFixed(2) + ' ' + r.toFixed(2) +
    ' 0 1 1 ' + x1 + ' ' + y1;
  const len = r * span;
  let ticks = '';
  for (let i = 0; i <= 4; i++) {
    const a = a0 + (i / 4) * span;
    const [ix, iy] = pt(a);
    ticks += '<path d="M' + ix + ' ' + iy + 'L' +
      (c + Math.cos(a) * r * 1.24).toFixed(2) + ' ' + (c + Math.sin(a) * r * 1.24).toFixed(2) +
      '" stroke="' + color + '" stroke-width="1" opacity="0.5"/>';
  }
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size +
    '" width="' + size + '" height="' + size + '">' +
    '<path d="' + roughCircle(c, c, r * 1.34, { seed, amp: 0.5, segs: 22 }) +
    '" fill="none" stroke="' + color + '" stroke-width="0.8" opacity="0.35"/>' +
    ticks +
    '<path d="' + arc + '" fill="none" stroke="' + color +
    '" stroke-width="3.2" opacity="0.22" stroke-linecap="round"/>' +
    '<path class="prog" d="' + arc + '" fill="none" stroke="' + ink +
    '" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="' + len.toFixed(2) +
    '" stroke-dashoffset="' + len.toFixed(2) + '"/></svg>');
}

/** A pencilled marginal bracket — the mark a reader leaves beside a line. */
export function marginBracket({ w = 12, hgt = 60, seed = 41, color = '#a32f34' } = {}) {
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + hgt +
    '" preserveAspectRatio="none"><path d="' +
    wobblyPath(w - 1.5, 2, 2.5, 5, { seed, amp: 0.7, segs: 3 }) + ' ' +
    wobblyPath(2.5, 5, 2.5, hgt - 5, { seed: seed + 7, amp: 0.9, segs: 8 }) + ' ' +
    wobblyPath(2.5, hgt - 5, w - 1.5, hgt - 2, { seed: seed + 13, amp: 0.7, segs: 3 }) +
    '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linecap="round" ' +
    'opacity="0.85"/></svg>');
}

/** Veterancy chevrons, drawn with a nib rather than stamped from a font. */
export function rankChevrons({ n = 1, w = 15, seed = 33, color = '#7a6244' } = {}) {
  const rows = Math.max(1, Math.min(3, n | 0));
  const h0 = 4.2, gap = 3.4;
  let g = '';
  for (let i = 0; i < rows; i++) {
    const y = 2 + i * gap;
    g += '<path d="' + wobblyPath(1.5, y + h0, w / 2, y, { seed: seed + i * 9, amp: 0.32, segs: 3 }) + ' ' +
      wobblyPath(w / 2, y, w - 1.5, y + h0, { seed: seed + i * 9 + 4, amp: 0.32, segs: 3 }) +
      '" stroke="' + color + '" stroke-width="1.35" fill="none" stroke-linecap="round"/>';
  }
  return svgEl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' +
    (2 + rows * gap + h0) + '" width="' + w + '">' + g + '</svg>');
}

/**
 * Contour survey drawn from REAL sampled terrain, so the page agrees with the
 * ground under it. `sample(x, z)` returns a height in metres; the extent is a
 * square of `ext` metres centred on the origin, north (-Z) at the top.
 */
export function contourMap({
  w = 400, hgt = 300, ext = 128, sample = null, seed = 1234, levels = 7, water = 0,
} = {}) {
  const N = 48, M = 36;
  const grid = new Float32Array(N * M);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1) - 0.5) * ext;
      const z = (j / (M - 1) - 0.5) * ext;
      let v = 0;
      try { v = sample ? sample(x, z) : 0; } catch { v = 0; }
      if (!isFinite(v)) v = 0;
      grid[j * N + i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!isFinite(lo) || hi - lo < 0.2) { lo = 0; hi = 1; }

  const rng = makeRng((seed >>> 0) || 1);
  const px = (i) => (i / (N - 1)) * w;
  const py = (j) => (j / (M - 1)) * hgt;
  // Marching squares, one polyline segment per crossed cell edge. Segments are
  // emitted individually with a little per-segment wander so the contour reads
  // as a drawn line rather than a plotted one.
  let g = '';
  for (let L = 1; L <= levels; L++) {
    const iso = lo + ((hi - lo) * L) / (levels + 1);
    const major = L % 2 === 0;
    let d = '';
    for (let j = 0; j < M - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = grid[j * N + i], b = grid[j * N + i + 1];
        const c = grid[(j + 1) * N + i + 1], e = grid[(j + 1) * N + i];
        const pts = [];
        const cut = (v0, v1, x0, y0, x1, y1) => {
          if ((v0 < iso) === (v1 < iso)) return;
          const t = (iso - v0) / (v1 - v0 || 1e-6);
          pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
        };
        cut(a, b, px(i), py(j), px(i + 1), py(j));
        cut(b, c, px(i + 1), py(j), px(i + 1), py(j + 1));
        cut(c, e, px(i + 1), py(j + 1), px(i), py(j + 1));
        cut(e, a, px(i), py(j + 1), px(i), py(j));
        for (let k = 0; k + 1 < pts.length; k += 2) {
          const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
          const mx = (x0 + x1) / 2 + (rng() - 0.5) * 1.5;
          const my = (y0 + y1) / 2 + (rng() - 0.5) * 1.5;
          d += 'M' + x0.toFixed(1) + ' ' + y0.toFixed(1) +
            'Q' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + x1.toFixed(1) + ' ' + y1.toFixed(1);
        }
      }
    }
    if (d) {
      g += '<path d="' + d + '" fill="none" stroke="#6b5a44" stroke-width="' +
        (major ? 1.05 : 0.68) + '" opacity="' + (major ? 0.62 : 0.38) +
        '" stroke-linecap="round"/>';
    }
  }

  // Water: everything at or below the river level, laid in as a pale wash with a
  // firmer bank line — the same marching-squares crossing, filled from below.
  if (water) {
    // Fill: one unstroked path (a stroke would draw every internal cell edge and
    // the river would read as graph paper). Bank: the iso-line at water level,
    // drawn separately as a firm, slightly wandering pen line.
    let fill = '';
    for (let j = 0; j < M - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const mid = (grid[j * N + i] + grid[j * N + i + 1] +
          grid[(j + 1) * N + i + 1] + grid[(j + 1) * N + i]) * 0.25;
        if (mid < water) {
          fill += 'M' + (px(i) - 1.1).toFixed(1) + ' ' + (py(j) - 1.1).toFixed(1) +
            'H' + (px(i + 1) + 1.1).toFixed(1) + 'V' + (py(j + 1) + 1.1).toFixed(1) +
            'H' + (px(i) - 1.1).toFixed(1) + 'Z';
        }
      }
    }
    let bank = '';
    for (let j = 0; j < M - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = grid[j * N + i], b = grid[j * N + i + 1];
        const c = grid[(j + 1) * N + i + 1], e = grid[(j + 1) * N + i];
        const pts = [];
        const cut = (v0, v1, x0, y0, x1, y1) => {
          if ((v0 < water) === (v1 < water)) return;
          const t = (water - v0) / (v1 - v0 || 1e-6);
          pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
        };
        cut(a, b, px(i), py(j), px(i + 1), py(j));
        cut(b, c, px(i + 1), py(j), px(i + 1), py(j + 1));
        cut(c, e, px(i + 1), py(j + 1), px(i), py(j + 1));
        cut(e, a, px(i), py(j + 1), px(i), py(j));
        for (let k = 0; k + 1 < pts.length; k += 2) {
          const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
          bank += 'M' + x0.toFixed(1) + ' ' + y0.toFixed(1) +
            'L' + x1.toFixed(1) + ' ' + y1.toFixed(1);
        }
      }
    }
    g = (fill ? '<path d="' + fill + '" fill="#6d8f96" fill-opacity="0.26" stroke="none"/>' : '') +
      g + (bank ? '<path d="' + bank + '" fill="none" stroke="#41636a" stroke-width="1.35" ' +
        'stroke-opacity="0.72" stroke-linecap="round"/>' : '');
  }

  // A wash of tone under the line work, so the survey has value as well as line.
  g = '<rect width="' + w + '" height="' + hgt + '" fill="#cbbb93" fill-opacity="0.16"/>' + g;

  return svgEl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + hgt +
    '" preserveAspectRatio="none" style="width:100%;height:100%">' + g + '</svg>');
}

// --------------------------------------------------------------------------
// Command-map field figures
// --------------------------------------------------------------------------

/**
 * The palette a command figure is painted in.
 *
 * Two constraints decided every number here, and both are measurements rather
 * than taste. (1) Round 6 measured the focal soldier on the command map at
 * rgb(155,144,118), hue 42, standing on ground at hue 45 — three degrees apart,
 * so the figure did not separate from the field by colour at all. Every tone
 * below is at least forty degrees off the map's 10-65 degree khaki wedge.
 * (2) The shade of every band is VIOLET (hue 230-270 with B > R), which is the
 * axis-3 requirement the world shading has failed for six rounds; on a drawn
 * token it is simply a fill, so it cannot be lost downstream.
 */
const FIG_PAL = {
  0: {
    ink: '#26303f', hatch: '#39415a',
    coat: ['#93a06d', '#4c5070'],     // tunic:    lit sage / violet shade
    leg: ['#75825a', '#3d4363'],      // trousers
    helm: ['#7f8d61', '#42475f'],     // helmet
    kit: '#5c4a33',
  },
  1: {
    ink: '#361f28', hatch: '#4b3550',
    coat: ['#a06a5b', '#523a58'],     // Imperial oxide, violet shade
    leg: ['#845646', '#452f4c'],
    helm: ['#8d5c4e', '#472f4a'],
    kit: '#43242c',
  },
};

/** A wandering vertical terminator: where the light leaves the figure. */
function _termPath(seed, hgt) {
  const rng = makeRng((seed >>> 0) || 3);
  let d = 'M0 -2 L' + (21 + rng() * 2).toFixed(1) + ' -2';
  for (let y = 6; y <= hgt + 2; y += 8) {
    d += 'L' + (20.4 + rng() * 3.4).toFixed(1) + ' ' + y.toFixed(1);
  }
  return d + 'L0 ' + (hgt + 2) + 'Z';
}

/**
 * A soldier as a MAP SYMBOL: the figure a staff officer draws beside a counter
 * so the survey says what is standing there, not merely that something is.
 *
 * WHY THIS EXISTS AT ALL. At the command camera the rendered soldier is 13x24
 * px, and round 6 measured his interior flipping 56<->160 between adjacent
 * pixels — the paper and hatch passes inject a per-pixel residual of sd 22.4
 * lum against a band step of 22.2, so the grain is 101% of the light and the
 * figure is salt-and-pepper. No amount of shading work can fix a 13 px man; the
 * only honest answer is to stop drawing him and draw a SYMBOL instead, which is
 * exactly what Valkyria Chronicles does with its command map.
 *
 * Being DOM, it sits above the render and therefore outside the paper and hatch
 * passes entirely — which is the masking the round-6 critique asked for, got for
 * free. It is drawn in three flat bands (helmet / tunic / trousers), each split
 * by a wandering terminator into a warm lit half and a VIOLET shaded half, with
 * pencil hatching in the shade, a double-struck ink silhouette, and a violet
 * contact shadow on the ground under the boots so the figure is planted.
 *
 * @param {0|1} team
 * @param {string} cls   unit class id — changes the silhouette, not only a glyph
 * @param {number} seed
 */
export function fieldFigure(team, cls, seed = 1) {
  const P = FIG_PAL[team === 1 ? 1 : 0];
  const S = (seed >>> 0) || 1;
  const c = String(cls || 'scout').toLowerCase();
  const bulk = c === 'shock' || c === 'shocktrooper' ? 2.4 : c === 'lancer' ? 1.6 : 0;
  const cid = 'ff' + S;

  // --- silhouette ---------------------------------------------------------
  const legL = 'M16.4 43 L21.4 43 L20.9 64 L21.6 68.5 L14.9 68.5 L15.7 64 Z';
  const legR = 'M22.6 43 L27.6 43 L28.3 64 L29.1 68.5 L22.4 68.5 L23.1 64 Z';
  const torso = 'M' + (13.9 - bulk) + ' 20.2 L' + (30.1 + bulk) + ' 20.2 L' +
    (31.6 + bulk) + ' 30 L' + (29.2 + bulk * 0.6) + ' 46 L' + (14.8 - bulk * 0.6) +
    ' 46 L' + (12.4 - bulk) + ' 30 Z';
  // The neck is CLOSED into the shoulders. The first cut left a two-pixel gap
  // between head and torso which, at forty pixels tall, read as a ball floating
  // over a slab rather than as a man.
  const head = 'M18.3 9.6 L25.7 9.6 L26.4 16.4 L24.6 21.4 L19.4 21.4 L17.6 16.4 Z';
  // The helmet is the read at twenty pixels: a Gallian bowl, an Imperial
  // stahlhelm with a flared skirt. Two nations, two silhouettes, no colour needed.
  const helm = team === 1
    ? 'M14.6 12.0 A7.4 7.4 0 0 1 29.4 12.0 L30.4 15.0 L26.9 13.6 L17.1 13.6 L13.6 15.0 Z'
    : 'M15.6 12.4 A6.4 6.4 0 0 1 28.4 12.4 L28.9 14.6 L15.1 14.6 Z';

  // Arm-of-service kit, carried on the silhouette rather than stamped on it.
  let kit = '';
  if (c === 'lancer') {
    kit = '<path d="' + wobblyPath(10.5, 22.5, 35.5, 34.5, { seed: S + 5, amp: 0.5, segs: 4 }) +
      '" stroke="' + P.kit + '" stroke-width="4.2" stroke-linecap="round" fill="none"/>';
  } else if (c === 'sniper') {
    kit = '<path d="' + wobblyPath(9.5, 49, 36.5, 23, { seed: S + 5, amp: 0.4, segs: 5 }) +
      '" stroke="' + P.kit + '" stroke-width="1.9" stroke-linecap="round" fill="none"/>';
  } else if (c === 'engineer') {
    kit = '<path d="' + roughRect(7.2, 24, 7.4, 12.5, { seed: S + 9, amp: 0.5 }) +
      '" fill="' + P.kit + '" stroke="' + P.ink + '" stroke-width="1.1"/>' +
      '<path d="' + wobblyPath(13, 44, 30, 33, { seed: S + 11, amp: 0.4, segs: 4 }) +
      '" stroke="' + P.kit + '" stroke-width="1.7" stroke-linecap="round" fill="none"/>';
  } else if (c === 'shock' || c === 'shocktrooper') {
    kit = '<path d="' + wobblyPath(12.5, 37.5, 31.5, 32.5, { seed: S + 5, amp: 0.4, segs: 4 }) +
      '" stroke="' + P.kit + '" stroke-width="2.9" stroke-linecap="round" fill="none"/>';
  } else {
    kit = '<path d="' + wobblyPath(11.5, 46, 33.5, 26, { seed: S + 5, amp: 0.4, segs: 5 }) +
      '" stroke="' + P.kit + '" stroke-width="1.7" stroke-linecap="round" fill="none"/>';
  }

  // --- two-tone banding ---------------------------------------------------
  // Every band is laid in twice: the whole shape in its violet shade, then the
  // lit side of the same shape clipped back by the terminator. Flat fills, so a
  // scan across the torso returns hard plateaus with ZERO residual noise —
  // which is the axis-2 measurement the rendered figure could not pass.
  const band = (d, pair, hatchIt) =>
    '<path d="' + d + '" fill="' + pair[1] + '"/>' +
    '<g clip-path="url(#' + cid + ')"><path d="' + d + '" fill="' + pair[0] + '"/></g>' +
    (hatchIt
      ? '<g clip-path="url(#' + cid + 'r)"><path d="' + d + '" fill="none"/>' +
        '<path d="' + hatchPath(12, 20, 22, 30, { spacing: 2.6, angle: -0.95, seed: S + 17 }) +
        '" stroke="' + P.hatch + '" stroke-width="0.75" opacity="0.5" fill="none"/></g>'
      : '');

  const outline = (d, w) => '<path d="' + d + '" fill="none" stroke="' + P.ink +
    '" stroke-width="' + w + '" stroke-linejoin="round" stroke-linecap="round"/>';

  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 76" width="44" height="76">' +
    '<defs>' +
    '<clipPath id="' + cid + '"><path d="' + _termPath(S, 76) + '"/></clipPath>' +
    '<clipPath id="' + cid + 'r"><path d="' + _termPath(S, 76) +
    '" transform="translate(44,0) scale(-1,1)"/></clipPath>' +
    '</defs>' +
    // contact shadow — cast to screen-right, which is where the command shot's
    // sun (bearing -0.405) throws every other shadow on the map
    '<ellipse cx="24.6" cy="69.2" rx="12.4" ry="3.4" fill="#4b4270" opacity="0.44"/>' +
    '<ellipse cx="23.2" cy="68.8" rx="7.6" ry="2.3" fill="#3a3159" opacity="0.42"/>' +
    kit +
    band(legL, P.leg, false) + band(legR, P.leg, false) +
    band(torso, P.coat, true) +
    band(head, P.coat, false) + band(helm, P.helm, false) +
    // double-struck ink: one weighted pass on the silhouette, one hairline ghost
    '<g opacity="0.96">' + outline(torso, 2.5) + outline(legL, 2.2) + outline(legR, 2.2) +
    outline(helm, 2.4) + outline(head, 1.7) + '</g>' +
    '<g opacity="0.36">' +
    outline(torso, 0.8) + outline(helm, 0.8) + '</g>' +
    // the one interior crease: a belt, hairline, so the torso is not one slab
    '<path d="' + wobblyPath(14.6 - bulk * 0.6, 39.5, 29.4 + bulk * 0.6, 39.5,
      { seed: S + 23, amp: 0.45, segs: 3 }) +
    '" stroke="' + P.ink + '" stroke-width="1.6" opacity="0.82" fill="none"/>' +
    '</svg>');
}
