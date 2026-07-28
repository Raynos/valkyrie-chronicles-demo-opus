// src/ui/icons.js
// Every icon, rule, ribbon and stamp in the interface, drawn as SVG at runtime.
// Nothing is loaded; the "hand-drawn" quality comes from seeded path jitter
// (wobblyPath / roughCircle / roughRect) rather than from a filter, so it holds
// up at any size and stays deterministic.

import { makeRng } from '../core/rng.js';
import { svgEl } from './dom.js';

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

/** Class emblem inside a hand-inked hexagonal badge. */
export function classBadge(cls, { size = 46, team = 0, seed = 5 } = {}) {
  const c = CLASS_ICONS[String(cls || '').toLowerCase()] || 'scout';
  const col = team === 1 ? '#8d3730' : '#37536f';
  const w = size, hgt = size * 1.08;
  const hex = 'M' + (w * 0.5) + ' ' + (hgt * 0.02) + 'L' + (w * 0.95) + ' ' + (hgt * 0.27) +
    'L' + (w * 0.95) + ' ' + (hgt * 0.74) + 'L' + (w * 0.5) + ' ' + (hgt * 0.99) +
    'L' + (w * 0.05) + ' ' + (hgt * 0.74) + 'L' + (w * 0.05) + ' ' + (hgt * 0.27) + 'Z';
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + hgt + '" width="' + w +
    '" height="' + hgt + '">' +
    '<path d="' + hex + '" fill="' + col + '" fill-opacity="0.16" stroke="' + col +
    '" stroke-width="1.5" filter="url(#vc-rough)"/>' +
    '<path d="' + roughCircle(w * 0.5, hgt * 0.5, w * 0.40, { seed, amp: 0.5, segs: 20 }) +
    '" fill="none" stroke="' + col + '" stroke-width="0.8" opacity="0.5"/>' +
    '<g transform="translate(' + (w * 0.5 - w * 0.32) + ' ' + (hgt * 0.5 - w * 0.32) +
    ') scale(' + ((w * 0.64) / 24).toFixed(3) + ')" fill="none" stroke="' + col +
    '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + PATHS[c] + '</g>' +
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

/** The AIM corner brackets that converge while aiming. */
export function aimBrackets({ w = 340, h = 240, seed = 31, color = '#f3e7cd' } = {}) {
  const L = Math.min(w, h) * 0.16, o = 2;
  const corner = (x, y, sx, sy, sd) =>
    '<path d="' + wobblyPath(x, y + sy * L, x, y, { seed: sd, amp: 0.9, segs: 4 }) + ' ' +
    wobblyPath(x, y, x + sx * L, y, { seed: sd + 3, amp: 0.9, segs: 4 }) + '"/>';
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w +
    '" height="' + h + '" preserveAspectRatio="none">' +
    '<g fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" ' +
    'style="filter:drop-shadow(0 1px 2px rgba(40,20,16,.85))">' +
    corner(o, o, 1, 1, seed) + corner(w - o, o, -1, 1, seed + 11) +
    corner(o, h - o, 1, -1, seed + 21) + corner(w - o, h - o, -1, -1, seed + 31) +
    '</g></svg>');
}

/** The fine ink crosshair (centre of the targeting overlay). */
export function crosshair({ size = 240, seed = 47, color = '#f6ecd6', gap = 0.10, arm = 0.20 } = {}) {
  const c = size / 2, g = size * gap, a = size * arm;
  const line = (x1, y1, x2, y2, sd) =>
    '<path d="' + wobblyPath(x1, y1, x2, y2, { seed: sd, amp: 0.7, segs: 5 }) + '"/>';
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size +
    '" height="' + size + '">' +
    '<g fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" ' +
    'style="filter:drop-shadow(0 1px 2px rgba(40,20,16,.9))">' +
    line(c, c - g, c, c - g - a, seed) + line(c, c + g, c, c + g + a, seed + 5) +
    line(c - g, c, c - g - a, c, seed + 9) + line(c + g, c, c + g + a, c, seed + 13) +
    '<circle cx="' + c + '" cy="' + c + '" r="1.5" fill="' + color + '" stroke="none"/>' +
    '</g></svg>');
}

/** Dashed accuracy circle; radius is driven by the caller each frame. */
export function accuracyRing({ size = 260, seed = 53, color = '#f2e3c4' } = {}) {
  const c = size / 2, r = size * 0.42;
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size +
    '" height="' + size + '">' +
    '<path d="' + roughCircle(c, c, r, { seed, amp: r * 0.03, segs: 44 }) +
    '" fill="none" stroke="' + color + '" stroke-width="1.4" stroke-dasharray="7 6" opacity="0.85" ' +
    'style="filter:drop-shadow(0 1px 2px rgba(40,20,16,.8))"/>' +
    '<path d="' + roughCircle(c, c, r * 0.985, { seed: seed + 7, amp: r * 0.02, segs: 40 }) +
    '" fill="none" stroke="#2a1d18" stroke-width="0.9" stroke-dasharray="7 6" opacity="0.35"/>' +
    '</svg>');
}

/** Silhouette used for the body-part hit indicator. */
export function bodyFigure({ part = 'torso', size = 96, color = '#4a3c2c', hot = '#a32f34' } = {}) {
  const w = size * 0.62, h = size;
  const on = (p) => (p === part ? hot : color);
  const fo = (p) => (p === part ? '0.55' : '0.10');
  const S = (x) => (x * w).toFixed(2);
  const T = (y) => (y * h).toFixed(2);
  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w +
    '" height="' + h + '">' +
    '<g stroke-width="1.4" stroke-linejoin="round">' +
    '<ellipse cx="' + S(0.5) + '" cy="' + T(0.10) + '" rx="' + S(0.17) + '" ry="' + T(0.085) +
    '" fill="' + on('head') + '" fill-opacity="' + fo('head') + '" stroke="' + on('head') + '"/>' +
    '<path d="M' + S(0.28) + ' ' + T(0.22) + ' H' + S(0.72) + ' L' + S(0.68) + ' ' + T(0.56) +
    ' H' + S(0.32) + ' Z" fill="' + on('torso') + '" fill-opacity="' + fo('torso') +
    '" stroke="' + on('torso') + '"/>' +
    '<path d="M' + S(0.28) + ' ' + T(0.23) + ' L' + S(0.10) + ' ' + T(0.46) + ' M' + S(0.72) +
    ' ' + T(0.23) + ' L' + S(0.90) + ' ' + T(0.46) + '" fill="none" stroke="' + on('arms') +
    '" stroke-opacity="' + (part === 'arms' ? 1 : 0.7) + '"/>' +
    '<path d="M' + S(0.34) + ' ' + T(0.56) + ' L' + S(0.30) + ' ' + T(0.96) + ' M' + S(0.66) +
    ' ' + T(0.56) + ' L' + S(0.70) + ' ' + T(0.96) + '" fill="none" stroke="' + on('legs') +
    '" stroke-opacity="' + (part === 'legs' ? 1 : 0.7) + '" stroke-width="' +
    (part === 'legs' ? 2.4 : 1.4) + '"/>' +
    '</g></svg>');
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
  // frame
  g += '<path d="' + roughRect(2, 2, w - 4, h - 4, { seed: seed + 5, amp: 0.9, segs: 9 }) +
    '" fill="none" stroke="#4a3c2c" stroke-width="1.3" opacity="0.8"/>';
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
