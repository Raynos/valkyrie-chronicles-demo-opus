// src/ui/portraits.js
// Deterministic illustrated portraits, drawn as SVG from a seed.
//
// The look copies the CANVAS-engine trick that sells the whole game as an
// illustration: the flat colour washes are deliberately MIS-REGISTERED from the
// ink linework by a pixel or two, as if the plates were printed slightly out of
// alignment. Every wash also has a rough edge and a hatched shadow side.
//
// Nothing here is random at runtime — the same (seed, class, team) always yields
// the same face, so a soldier looks the same in the roster, briefing and results.

import { makeRng, rngPick } from '../core/rng.js';
import { svgEl } from './dom.js';
import { roughCircle, wobblyPath, hatchPath } from './icons.js';

const SKIN = ['#f2d7b8', '#ecc9a2', '#dcae87', '#c68f68', '#a97350', '#8a5a3e'];
const SKIN_SHADE = ['#d9b28c', '#d3a179', '#c08a63', '#a5714c', '#8b5a3b', '#6f452c'];
const HAIR = ['#3b2f25', '#241d19', '#6d4f2c', '#a8813f', '#d9c58e', '#8a4230',
  '#5d6a70', '#b9bcc2', '#4b3b52'];
const EYES = ['#5b6e4a', '#46607a', '#6b4a34', '#3f4a52', '#7a5a3a', '#4a4a4a'];

// Uniform colours. Gallian militia read olive/khaki with a red tab; Imperial
// forces read cold grey-blue with oxblood.
const UNIFORM = [
  { coat: '#7d7a53', coatDark: '#5f5d3d', tab: '#a32f34', trim: '#c8b184' },
  { coat: '#5d6470', coatDark: '#434a55', tab: '#6d2028', trim: '#9aa0a8' },
];

const CLASS_ACCENT = {
  scout: '#7f8f52', shock: '#9a7238', lancer: '#7a6350',
  engineer: '#4f7378', sniper: '#6a5a7c', tank: '#6b6553',
};

/** Stable 32-bit hash so a soldier's name alone can seed their face. */
export function seedFromName(name = '') {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}

// --------------------------------------------------------------------------
// Feature builders — each returns SVG path data in a 100 x 120 frame
// --------------------------------------------------------------------------

function headPath(rx, ry, jaw, cy) {
  const jw = 7.4 + jaw * 8.2;
  const chin = cy + ry * 1.02;
  return 'M' + (50 - rx) + ' ' + cy +
    ' C' + (50 - rx) + ' ' + (cy - ry * 1.16) + ' ' + (50 + rx) + ' ' + (cy - ry * 1.16) + ' ' + (50 + rx) + ' ' + cy +
    ' C' + (50 + rx) + ' ' + (cy + ry * 0.52) + ' ' + (50 + jw) + ' ' + (chin - 5.5) + ' 50 ' + chin +
    ' C' + (50 - jw) + ' ' + (chin - 5.5) + ' ' + (50 - rx) + ' ' + (cy + ry * 0.52) + ' ' + (50 - rx) + ' ' + cy + 'Z';
}

function eyePath(cx, cy, w, h, tilt) {
  // Upper lid is a heavier arc than the lower — the classic illustrated eye.
  const x0 = cx - w, x1 = cx + w;
  const ty = cy - h - tilt;
  return 'M' + x0.toFixed(1) + ' ' + cy.toFixed(1) +
    ' Q' + cx.toFixed(1) + ' ' + ty.toFixed(1) + ' ' + x1.toFixed(1) + ' ' + (cy - tilt * 0.6).toFixed(1) +
    ' Q' + cx.toFixed(1) + ' ' + (cy + h * 0.78).toFixed(1) + ' ' + x0.toFixed(1) + ' ' + cy.toFixed(1) + 'Z';
}

const HAIR_STYLES = ['crop', 'part', 'long', 'ponytail', 'bob', 'spiky', 'braids', 'swept'];

/**
 * @returns {{back:string, front:string}} path data drawn behind / in front of the head.
 */
function hairPaths(style, rx, ry, cy, rng) {
  const top = cy - ry * 1.14;
  const j = (a) => (rng() * 2 - 1) * a;
  const L = 50 - rx, R = 50 + rx;
  let back = '', front = '';

  // The outer edge stops well above the ear (cy - ry*0.18) — dropping it to the
  // jaw is what makes procedural hair read as a hood instead of a hairstyle.
  const domeFront = (dip) => {
    const side = cy - ry * 0.18;
    return 'M' + (L - 1.4) + ' ' + (side + j(1)) +
      ' C' + (L - 2.6) + ' ' + (top + 1) + ' ' + (R + 2.6) + ' ' + (top + 1) + ' ' + (R + 1.4) + ' ' + (side + j(1)) +
      ' C' + (R - 1.5) + ' ' + (cy - ry * 0.52) + ' ' + (50 + rx * 0.36) + ' ' + (cy - ry * dip) + ' 50 ' + (cy - ry * (dip - 0.04)) +
      ' C' + (50 - rx * 0.44) + ' ' + (cy - ry * (dip + 0.07)) + ' ' + (L + 1.5) + ' ' + (cy - ry * 0.50) + ' ' + (L - 1.4) + ' ' + side + 'Z';
  };

  switch (style) {
    case 'crop':
      front = domeFront(0.62);
      break;
    case 'part':
      front = 'M' + (L - 2) + ' ' + (cy - ry * 0.14) +
        ' C' + (L - 3) + ' ' + (top + 1) + ' ' + (R + 3) + ' ' + (top + 1) + ' ' + (R + 2) + ' ' + (cy - ry * 0.20) +
        ' C' + (R - 1) + ' ' + (cy - ry * 0.58) + ' ' + (50 + rx * 0.9) + ' ' + (cy - ry * 0.80) + ' ' + (50 - rx * 0.18) + ' ' + (cy - ry * 0.57) +
        ' C' + (50 - rx * 0.5) + ' ' + (cy - ry * 0.44) + ' ' + (L + 1) + ' ' + (cy - ry * 0.34) + ' ' + (L - 2) + ' ' + (cy - ry * 0.14) + 'Z';
      break;
    case 'long':
      back = 'M' + (L - 5) + ' ' + (cy - ry * 0.2) +
        ' C' + (L - 9) + ' ' + (cy + ry * 1.9) + ' ' + (L - 3) + ' ' + (cy + ry * 2.5) + ' ' + (L + 2) + ' ' + (cy + ry * 2.4) +
        ' L' + (R - 2) + ' ' + (cy + ry * 2.4) +
        ' C' + (R + 3) + ' ' + (cy + ry * 2.5) + ' ' + (R + 9) + ' ' + (cy + ry * 1.9) + ' ' + (R + 5) + ' ' + (cy - ry * 0.2) +
        ' C' + (R + 4) + ' ' + (top - 1) + ' ' + (L - 4) + ' ' + (top - 1) + ' ' + (L - 5) + ' ' + (cy - ry * 0.2) + 'Z';
      front = domeFront(0.58);
      break;
    case 'ponytail':
      back = 'M' + (R - 2) + ' ' + (cy - ry * 0.5) +
        ' C' + (R + 13 + j(2)) + ' ' + (cy - ry * 0.2) + ' ' + (R + 15) + ' ' + (cy + ry * 1.3) + ' ' + (R + 6) + ' ' + (cy + ry * 1.85) +
        ' C' + (R + 11) + ' ' + (cy + ry * 1.0) + ' ' + (R + 7) + ' ' + (cy - ry * 0.1) + ' ' + (R - 3) + ' ' + (cy - ry * 0.2) + 'Z';
      front = domeFront(0.66);
      break;
    case 'bob':
      back = 'M' + (L - 5.5) + ' ' + (cy - ry * 0.3) +
        ' C' + (L - 6) + ' ' + (cy + ry * 1.25) + ' ' + (L - 1) + ' ' + (cy + ry * 1.45) + ' ' + (L + 4) + ' ' + (cy + ry * 1.32) +
        ' L' + (R - 4) + ' ' + (cy + ry * 1.32) +
        ' C' + (R + 1) + ' ' + (cy + ry * 1.45) + ' ' + (R + 6) + ' ' + (cy + ry * 1.25) + ' ' + (R + 4) + ' ' + (cy - ry * 0.3) +
        ' C' + (R + 3) + ' ' + (top) + ' ' + (L - 3) + ' ' + (top) + ' ' + (L - 4) + ' ' + (cy - ry * 0.3) + 'Z';
      front = 'M' + (L - 3.5) + ' ' + (cy - ry * 0.18) +
        ' C' + (L - 4.5) + ' ' + (top + 1) + ' ' + (R + 4.5) + ' ' + (top + 1) + ' ' + (R + 3.5) + ' ' + (cy - ry * 0.18) +
        ' L' + (R - 1) + ' ' + (cy - ry * 0.50) + ' L' + (L + 1) + ' ' + (cy - ry * 0.50) + 'Z';
      break;
    case 'spiky': {
      let d = 'M' + (L - 2) + ' ' + (cy + 2);
      const n = 7;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = (L - 2) + t * (rx * 2 + 4);
        const yb = top + Math.sin(t * Math.PI) * -3 + 6;
        const spike = yb - 6 - rng() * 7;
        d += ' L' + (x - 2.2).toFixed(1) + ' ' + spike.toFixed(1) + ' L' + x.toFixed(1) + ' ' + yb.toFixed(1);
      }
      d += ' C' + (R - 2) + ' ' + (cy - ry * 0.45) + ' ' + (L + 2) + ' ' + (cy - ry * 0.45) + ' ' + (L - 2) + ' ' + (cy + 2) + 'Z';
      front = d;
      break;
    }
    case 'braids':
      back = 'M' + (L - 1) + ' ' + (cy - ry * 0.4) +
        ' C' + (L - 12) + ' ' + (cy + ry * 0.4) + ' ' + (L - 10) + ' ' + (cy + ry * 1.7) + ' ' + (L - 3) + ' ' + (cy + ry * 2.0) +
        ' C' + (L - 5) + ' ' + (cy + ry * 1.1) + ' ' + (L - 2) + ' ' + (cy + ry * 0.2) + ' ' + (L + 3) + ' ' + (cy - ry * 0.3) + 'Z' +
        'M' + (R + 1) + ' ' + (cy - ry * 0.4) +
        ' C' + (R + 12) + ' ' + (cy + ry * 0.4) + ' ' + (R + 10) + ' ' + (cy + ry * 1.7) + ' ' + (R + 3) + ' ' + (cy + ry * 2.0) +
        ' C' + (R + 5) + ' ' + (cy + ry * 1.1) + ' ' + (R + 2) + ' ' + (cy + ry * 0.2) + ' ' + (R - 3) + ' ' + (cy - ry * 0.3) + 'Z';
      front = domeFront(0.60);
      break;
    default: // swept
      front = 'M' + (L - 2) + ' ' + (cy - ry * 0.12) +
        ' C' + (L - 4) + ' ' + (top) + ' ' + (R + 5) + ' ' + (top - 2) + ' ' + (R + 4) + ' ' + (cy - ry * 0.14) +
        ' C' + (R + 2) + ' ' + (cy - ry * 0.66) + ' ' + (50 - rx * 0.2) + ' ' + (cy - ry * 0.94) + ' ' + (L - 5) + ' ' + (cy - ry * 0.36) +
        ' C' + (L - 4) + ' ' + (cy - ry * 0.22) + ' ' + (L - 2) + ' ' + (cy - ry * 0.16) + ' ' + (L - 2) + ' ' + (cy - ry * 0.12) + 'Z';
  }
  return { back, front };
}

function headgearPaths(kind, rx, ry, cy, uni) {
  const top = cy - ry * 1.16;
  const L = 50 - rx, R = 50 + rx;
  if (kind === 'cap') {
    return {
      shape: 'M' + (L - 2) + ' ' + (cy - ry * 0.42) +
        ' C' + (L - 3) + ' ' + (top - 4) + ' ' + (R + 3) + ' ' + (top - 4) + ' ' + (R + 2) + ' ' + (cy - ry * 0.42) + 'Z',
      brim: 'M' + (L - 7) + ' ' + (cy - ry * 0.40) + ' Q50 ' + (cy - ry * 0.05) + ' ' + (R + 7) + ' ' + (cy - ry * 0.40) +
        ' Q50 ' + (cy - ry * 0.28) + ' ' + (L - 7) + ' ' + (cy - ry * 0.40) + 'Z',
      col: uni.coatDark,
    };
  }
  if (kind === 'helmet') {
    return {
      shape: 'M' + (L - 5) + ' ' + (cy + 1) +
        ' C' + (L - 6) + ' ' + (top - 6) + ' ' + (R + 6) + ' ' + (top - 6) + ' ' + (R + 5) + ' ' + (cy + 1) + 'Z',
      brim: 'M' + (L - 8) + ' ' + (cy + 0.5) + ' Q50 ' + (cy + 5.5) + ' ' + (R + 8) + ' ' + (cy + 0.5) +
        ' Q50 ' + (cy + 2.5) + ' ' + (L - 8) + ' ' + (cy + 0.5) + 'Z',
      col: '#6f6f5c',
    };
  }
  if (kind === 'bandana') {
    return {
      shape: 'M' + (L - 2.5) + ' ' + (cy - ry * 0.30) + ' Q50 ' + (cy - ry * 0.86) + ' ' + (R + 2.5) + ' ' + (cy - ry * 0.30) +
        ' Q50 ' + (cy - ry * 0.52) + ' ' + (L - 2.5) + ' ' + (cy - ry * 0.30) + 'Z',
      brim: 'M' + (R + 1) + ' ' + (cy - ry * 0.40) + ' l9 3 l-3 4 l-6 -4Z',
      col: uni.tab,
    };
  }
  return null;
}

// --------------------------------------------------------------------------

/**
 * Build portrait SVG markup.
 * @param {object} o
 * @param {number|string} o.seed  number, or a name string (hashed)
 * @param {string} o.cls          'scout'|'shock'|'lancer'|'engineer'|'sniper'|'tank'
 * @param {0|1}    o.team
 * @param {number} o.w            frame width in px attribute (viewBox is fixed)
 * @param {boolean} o.frame       draw the hand-inked portrait frame
 * @param {'calm'|'grim'|'alert'|'hurt'|'down'} o.mood
 */
export function portraitMarkup({
  seed = 1, cls = 'scout', team = 0, w = 100, frame = true, mood = 'calm', bg = true,
} = {}) {
  const s = typeof seed === 'string' ? seedFromName(seed) : ((seed >>> 0) || 1);
  const rng = makeRng(s);
  const uni = UNIFORM[team === 1 ? 1 : 0];
  const accent = CLASS_ACCENT[String(cls).toLowerCase()] || CLASS_ACCENT.scout;

  const skinIdx = Math.floor(rng() * SKIN.length);
  const skin = SKIN[skinIdx], skinShade = SKIN_SHADE[skinIdx];
  const hairCol = HAIR[Math.floor(rng() * HAIR.length)];
  const eyeCol = EYES[Math.floor(rng() * EYES.length)];

  const rx = 20 + rng() * 2.4;
  const ry = 24 + rng() * 2.6;
  const cy = 46 + rng() * 2;
  const jaw = rng();
  const style = HAIR_STYLES[Math.floor(rng() * HAIR_STYLES.length)];

  // Headgear probability is class-flavoured: lancers wear helmets, snipers caps.
  const gearRoll = rng();
  let gear = null;
  const c = String(cls).toLowerCase();
  if (c === 'lancer' || c === 'tank') gear = gearRoll < 0.75 ? 'helmet' : 'cap';
  else if (c === 'sniper') gear = gearRoll < 0.6 ? 'cap' : null;
  else if (c === 'engineer') gear = gearRoll < 0.45 ? 'cap' : null;
  else if (team === 1) gear = gearRoll < 0.8 ? 'helmet' : 'cap';
  else gear = gearRoll < 0.30 ? 'bandana' : (gearRoll < 0.5 ? 'cap' : null);

  const hair = hairPaths(style, rx, ry, cy, rng);
  const hg = gear ? headgearPaths(gear, rx, ry, cy, uni) : null;

  // Mis-registration offset of the colour plate under the ink plate.
  const ox = (rng() * 2 - 1) * 1.9, oy = 0.9 + rng() * 1.3;

  // Face metrics
  const eyeY = cy + ry * 0.16;
  const eyeDx = rx * 0.44;
  const eyeW = 5.2 + rng() * 1.1;
  const eyeH = mood === 'alert' ? 4.2 : mood === 'grim' ? 2.5 : 3.3;
  const browY = eyeY - 6.2 - rng() * 1.4;
  const browTilt = mood === 'grim' || mood === 'hurt' ? 2.4 : mood === 'alert' ? -1.6 : 0.4;
  const noseY = cy + ry * 0.56;
  const mouthY = cy + ry * 0.82;
  const mouthCurve = mood === 'grim' ? -1.6 : mood === 'hurt' ? -2.4 : mood === 'alert' ? 1.4 : 0.6;
  const chin = cy + ry * 1.02;

  const head = headPath(rx, ry, jaw, cy);
  const shoulderY = 104;
  const neck = 'M' + (50 - 7.4) + ' ' + (chin - 3) + ' L' + (50 - 8.2) + ' ' + (shoulderY - 12) +
    ' L' + (50 + 8.2) + ' ' + (shoulderY - 12) + ' L' + (50 + 7.4) + ' ' + (chin - 3) + 'Z';
  const coat = 'M2 120 C6 ' + (shoulderY - 8) + ' 22 ' + (shoulderY - 14) + ' ' + (50 - 11) + ' ' + (shoulderY - 11) +
    ' L50 ' + (shoulderY - 4) + ' L' + (50 + 11) + ' ' + (shoulderY - 11) +
    ' C78 ' + (shoulderY - 14) + ' 94 ' + (shoulderY - 8) + ' 98 120Z';
  const lapelL = 'M' + (50 - 11) + ' ' + (shoulderY - 11) + ' L50 ' + (shoulderY - 4) + ' L' + (50 - 3) + ' 120';
  const lapelR = 'M' + (50 + 11) + ' ' + (shoulderY - 11) + ' L50 ' + (shoulderY - 4) + ' L' + (50 + 3) + ' 120';

  const INK = '#3a2f28';
  const inkAttrs = 'fill="none" stroke="' + INK + '" stroke-linecap="round" stroke-linejoin="round"';

  let g = '';

  // ---- background wash --------------------------------------------------
  if (bg) {
    g += '<path d="' + roughCircle(50, 62, 62, { seed: s + 3, amp: 4, segs: 26 }) +
      '" fill="' + accent + '" fill-opacity="0.13"/>';
    g += '<rect x="0" y="0" width="100" height="120" fill="' + accent + '" fill-opacity="0.05"/>';
  }

  // ---- colour plate (offset) -------------------------------------------
  // The plate multiplies against the paper wash behind it, but `isolation`
  // keeps its own shapes blending normally with each other — without that,
  // every overlapping fill would compound into mud.
  g += '<g transform="translate(' + ox.toFixed(2) + ' ' + oy.toFixed(2) +
    ')" style="mix-blend-mode:multiply"><g style="isolation:isolate">';
  if (hair.back) g += '<path d="' + hair.back + '" fill="' + hairCol + '" fill-opacity="0.92"/>';
  g += '<path d="' + coat + '" fill="' + uni.coat + '"/>';
  g += '<path d="' + neck + '" fill="' + skinShade + '"/>';
  g += '<path d="' + head + '" fill="' + skin + '"/>';
  // shadow side of the face — a soft crescent, cool violet-ish shade
  g += '<path d="M' + (50 + rx * 0.30) + ' ' + (cy - ry * 0.98) +
    ' C' + (50 + rx * 1.06) + ' ' + (cy - ry * 0.5) + ' ' + (50 + rx * 0.96) + ' ' + (cy + ry * 0.6) + ' 50 ' + chin +
    ' C' + (50 + rx * 0.62) + ' ' + (cy + ry * 0.55) + ' ' + (50 + rx * 0.70) + ' ' + (cy - ry * 0.4) + ' ' + (50 + rx * 0.30) + ' ' + (cy - ry * 0.98) +
    'Z" fill="' + skinShade + '" fill-opacity="0.72"/>';
  if (hair.front) g += '<path d="' + hair.front + '" fill="' + hairCol + '"/>';
  if (hg) {
    g += '<path d="' + hg.shape + '" fill="' + hg.col + '"/>';
    g += '<path d="' + hg.brim + '" fill="' + hg.col + '" fill-opacity="0.85"/>';
  }
  g += '<path d="' + lapelL + ' L' + (50 - 22) + ' 120Z" fill="' + uni.coatDark + '" fill-opacity="0.75"/>';
  g += '<path d="' + lapelR + ' L' + (50 + 22) + ' 120Z" fill="' + uni.coatDark + '" fill-opacity="0.75"/>';
  g += '<path d="M' + (50 - 11) + ' ' + (shoulderY - 11) + ' l6 3 l-3 5 l-5 -4Z" fill="' + uni.tab + '"/>';
  g += '<path d="M' + (50 + 11) + ' ' + (shoulderY - 11) + ' l-6 3 l3 5 l5 -4Z" fill="' + uni.tab + '"/>';
  g += '</g></g>';

  // ---- pencil hatching on the shade side --------------------------------
  g += '<g opacity="0.30" stroke="' + INK + '" stroke-width="0.5" fill="none">' +
    '<path d="' + hatchPath(50 + rx * 0.30, cy - ry * 0.30, rx * 0.70, ry * 1.20,
      { spacing: 2.6, angle: -0.95, seed: s + 17, amp: 0.35 }) + '"/>' +
    '<path d="' + hatchPath(50 - 9, chin - 2, 18, 7, { spacing: 2.2, angle: -0.9, seed: s + 29, amp: 0.3 }) + '"/>' +
    '</g>';

  // ---- ink plate --------------------------------------------------------
  g += '<g ' + inkAttrs + '>';
  g += '<path d="' + coat + '" stroke-width="1.5"/>';
  g += '<path d="' + lapelL + '" stroke-width="1.2"/><path d="' + lapelR + '" stroke-width="1.2"/>';
  g += '<path d="' + neck + '" stroke-width="1.1" stroke-opacity="0.8"/>';
  if (hair.back) g += '<path d="' + hair.back + '" stroke-width="1.3"/>';
  g += '<path d="' + head + '" stroke-width="1.6"/>';
  // ears
  g += '<path d="M' + (50 - rx - 0.5) + ' ' + (cy + 1) + ' q-3.4 1.6 -1.2 5.2 q1.6 2.6 3.4 1.2" stroke-width="1.1"/>';
  g += '<path d="M' + (50 + rx + 0.5) + ' ' + (cy + 1) + ' q3.4 1.6 1.2 5.2 q-1.6 2.6 -3.4 1.2" stroke-width="1.1"/>';
  if (hair.front) g += '<path d="' + hair.front + '" stroke-width="1.4"/>';
  // a few strand lines inside the hair mass
  for (let i = 0; i < 4; i++) {
    const t = (i + 1) / 5;
    const x = 50 - rx + t * rx * 2;
    g += '<path d="' + wobblyPath(x, cy - ry * 1.02, x + (rng() * 6 - 3), cy - ry * 0.42,
      { seed: s + i * 13, amp: 0.6, segs: 4 }) + '" stroke-width="0.6" stroke-opacity="0.55"/>';
  }
  if (hg) {
    g += '<path d="' + hg.shape + '" stroke-width="1.5"/><path d="' + hg.brim + '" stroke-width="1.3"/>';
  }
  g += '</g>';

  // ---- eyes / brows / nose / mouth --------------------------------------
  const closed = mood === 'down';
  g += '<g stroke="' + INK + '" stroke-linecap="round" stroke-linejoin="round">';
  for (const sgn of [-1, 1]) {
    const ex = 50 + sgn * eyeDx;
    if (closed) {
      g += '<path d="M' + (ex - eyeW) + ' ' + eyeY + ' q' + (eyeW) + ' ' + 2.4 + ' ' + (eyeW * 2) + ' 0" fill="none" stroke-width="1.5"/>';
      continue;
    }
    g += '<path d="' + eyePath(ex, eyeY, eyeW, eyeH, 0.6) + '" fill="#fbf5e6" stroke="none"/>';
    const irisR = eyeH * 0.86;
    g += '<circle cx="' + (ex + sgn * 0.5).toFixed(1) + '" cy="' + (eyeY - 0.4).toFixed(1) +
      '" r="' + irisR.toFixed(1) + '" fill="' + eyeCol + '"/>';
    g += '<circle cx="' + (ex + sgn * 0.5).toFixed(1) + '" cy="' + (eyeY - 0.4).toFixed(1) +
      '" r="' + (irisR * 0.42).toFixed(1) + '" fill="#241d19"/>';
    g += '<circle cx="' + (ex + sgn * 0.5 - 0.9).toFixed(1) + '" cy="' + (eyeY - 1.5).toFixed(1) +
      '" r="' + (irisR * 0.26).toFixed(1) + '" fill="#fdf8ec"/>';
    // lids: heavy upper lash, faint lower
    g += '<path d="M' + (ex - eyeW) + ' ' + eyeY + ' Q' + ex + ' ' + (eyeY - eyeH - 1.4) + ' ' +
      (ex + eyeW) + ' ' + (eyeY - 0.5) + '" fill="none" stroke-width="1.6"/>';
    g += '<path d="M' + (ex - eyeW * 0.85) + ' ' + (eyeY + 0.4) + ' Q' + ex + ' ' + (eyeY + eyeH * 0.8) +
      ' ' + (ex + eyeW * 0.8) + ' ' + eyeY + '" fill="none" stroke-width="0.8" stroke-opacity="0.6"/>';
    // brow
    g += '<path d="M' + (ex - eyeW * 1.15) + ' ' + (browY + sgn * 0 + browTilt) + ' Q' + ex + ' ' +
      (browY - 2.2) + ' ' + (ex + eyeW * 1.1) + ' ' + (browY - browTilt * 0.4) +
      '" fill="none" stroke-width="' + (mood === 'grim' ? 2.0 : 1.6) + '" stroke-opacity="0.9"/>';
  }
  // nose — one hook line plus a nostril tick
  g += '<path d="M' + (50 - 1.2) + ' ' + (noseY - 6) + ' q-1.6 4.2 0.4 6 q1.4 1.2 3 0.4" fill="none" stroke-width="1.2" stroke-opacity="0.85"/>';
  // mouth
  g += '<path d="M' + (50 - 5.4) + ' ' + mouthY + ' q5.4 ' + mouthCurve.toFixed(1) + ' 10.8 0" fill="none" stroke-width="1.5"/>';
  if (mood === 'hurt' || mood === 'alert') {
    g += '<path d="M' + (50 - 4.2) + ' ' + (mouthY + 0.6) + ' q4.2 3.2 8.4 0" fill="#8a4a44" stroke="none" opacity="0.5"/>';
  }
  g += '</g>';

  // ---- class flash on the collar ---------------------------------------
  g += '<path d="M' + (50 - 21) + ' 118 l10 -5 l3 5Z" fill="' + accent + '" stroke="' + INK +
    '" stroke-width="0.9"/>';

  // ---- frame ------------------------------------------------------------
  if (frame) {
    const clipId = 'vc-pc-' + s.toString(36);
    g = '<clipPath id="' + clipId + '"><path d="M2 2 H98 V118 H2Z"/></clipPath>' +
      '<g clip-path="url(#' + clipId + ')">' + g + '</g>' +
      '<path d="' + wobblyPath(2, 2, 98, 2, { seed: s + 41, amp: 0.8, segs: 8 }) + ' ' +
      wobblyPath(98, 2, 98, 118, { seed: s + 43, amp: 0.8, segs: 9 }) + ' ' +
      wobblyPath(98, 118, 2, 118, { seed: s + 47, amp: 0.8, segs: 8 }) + ' ' +
      wobblyPath(2, 118, 2, 2, { seed: s + 53, amp: 0.8, segs: 9 }) +
      '" fill="none" stroke="' + INK + '" stroke-width="1.6" stroke-opacity="0.85"/>';
  }

  const cls2 = 'vc-portrait por' + (mood === 'down' ? ' down' : '');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120" width="' + w +
    '" height="' + (w * 1.2) + '" class="' + cls2 + '" aria-hidden="true">' + g + '</svg>';
}

/** Live SVG element. */
export function portrait(opts) { return svgEl(portraitMarkup(opts)); }

/** Portrait for a game Unit — seeds from the unit name so it never changes. */
export function portraitFor(unit, opts = {}) {
  if (!unit) return portrait(opts);
  return portrait({
    seed: unit.portraitSeed != null ? unit.portraitSeed : (unit.name || 'soldier'),
    cls: unit.cls || unit.class || 'scout',
    team: unit.team | 0,
    mood: unit.downed || !unit.alive ? 'down'
      : (unit.hp / Math.max(1, unit.maxHp)) < 0.35 ? 'hurt' : 'calm',
    ...opts,
  });
}
