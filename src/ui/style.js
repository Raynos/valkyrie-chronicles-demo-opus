// src/ui/style.js
// The CANVAS-engine field-journal look, as injectable CSS + procedural SVG filters.
//
// Everything here is generated: the paper fibre and the watercolour blotching are
// inline-SVG feTurbulence rasterised once by the browser into a tiled background
// (a data: URI is NOT an external asset — nothing is fetched over the network).
// Deckled paper edges come from two mechanisms:
//   * cheap  — a seeded clip-path polygon with per-vertex jitter (used everywhere)
//   * costly — an feDisplacementMap filter (reserved for the hero pages)
// Text is never inside a filtered subtree, so glyphs stay crisp.

import { makeRng } from '../core/rng.js';

export const PALETTE = {
  paper: '#efe3c8',
  paperHi: '#f8f0dd',
  paperLo: '#e0cfab',
  paperEdge: '#c6b088',
  ink: '#33291f',
  ink2: '#5d4d3b',
  ink3: '#8a7659',
  red: '#a32f34',
  redDeep: '#77202a',
  gold: '#b3873f',
  ally: '#37536f',
  enemy: '#8d3730',
  shadow: '#3a2f33',
  teal: '#4a6b70',
  olive: '#6d7350',
};

// --------------------------------------------------------------------------
// Procedural textures
// --------------------------------------------------------------------------

function svgUri(inner, w, h) {
  const s =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
    '" viewBox="0 0 ' + w + ' ' + h + '">' + inner + '</svg>';
  return 'url("data:image/svg+xml;utf8,' + encodeURIComponent(s) + '")';
}

/** Fine cold-press paper fibre. Tiles seamlessly via stitchTiles. */
export function grainUri({ size = 160, freq = 0.86, oct = 4, seed = 5, alpha = 0.5 } = {}) {
  const inner =
    '<filter id="g" x="0" y="0" width="100%" height="100%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="' + freq + '" numOctaves="' + oct +
    '" seed="' + seed + '" stitchTiles="stitch"/>' +
    '<feColorMatrix type="saturate" values="0"/>' +
    // push the noise toward the light end so it multiplies as a *tint*, not soot
    '<feComponentTransfer><feFuncR type="linear" slope="0.42" intercept="0.62"/>' +
    '<feFuncG type="linear" slope="0.42" intercept="0.60"/>' +
    '<feFuncB type="linear" slope="0.42" intercept="0.56"/></feComponentTransfer>' +
    '</filter><rect width="100%" height="100%" filter="url(#g)" opacity="' + alpha + '"/>';
  return svgUri(inner, size, size);
}

/** Large soft watercolour mottling — the uneven wash of a hand-laid gouache ground. */
export function blotchUri({ size = 420, freq = 0.012, oct = 5, seed = 11, alpha = 0.4 } = {}) {
  const inner =
    '<filter id="b" x="0" y="0" width="100%" height="100%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="' + freq + '" numOctaves="' + oct +
    '" seed="' + seed + '" stitchTiles="stitch"/>' +
    '<feColorMatrix type="matrix" values="' +
    // map noise to a warm ochre wash instead of grey
    '0 0 0 0 0.86  0 0 0 0 0.80  0 0 0 0 0.68  0.7 0.2 0.1 0 0.30"/>' +
    '</filter><rect width="100%" height="100%" filter="url(#b)" opacity="' + alpha + '"/>';
  return svgUri(inner, size, size);
}

/**
 * Seeded deckle: a clip-path polygon whose vertices wander inward from the box
 * edge, so a rectangle reads as a torn/hand-cut sheet.
 * @param {number} seed
 * @param {{perSide?:number, amp?:number}} [opts] amp is in % of the box.
 */
export function deckleClip(seed = 1, { perSide = 8, amp = 0.9 } = {}) {
  const rng = makeRng((seed >>> 0) || 1);
  const p = [];
  const add = (x, y) => p.push(x.toFixed(2) + '% ' + y.toFixed(2) + '%');
  const j = () => rng() * amp;
  for (let i = 0; i < perSide; i++) add((i / perSide) * 100, j());
  for (let i = 0; i < perSide; i++) add(100 - j(), (i / perSide) * 100);
  for (let i = 0; i < perSide; i++) add(100 - (i / perSide) * 100, 100 - j());
  for (let i = 0; i < perSide; i++) add(j(), 100 - (i / perSide) * 100);
  return 'polygon(' + p.join(',') + ')';
}

/** A tiny seeded rotation, so pasted-in chips never line up perfectly. */
export function deckleTilt(seed = 1, amp = 0.5) {
  const rng = makeRng(((seed >>> 0) || 1) ^ 0x9e3779b9);
  return (rng() * 2 - 1) * amp;
}

// --------------------------------------------------------------------------
// SVG filter defs (ink bleed, displacement deckle, splatter roughening)
// --------------------------------------------------------------------------

const FILTER_DEFS = `
<svg class="vc-defs" aria-hidden="true" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden">
<defs>
  <filter id="vc-deckle" x="-6%" y="-6%" width="112%" height="112%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.016 0.028" numOctaves="4" seed="17" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="7" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <filter id="vc-deckle-fine" x="-6%" y="-6%" width="112%" height="112%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="3" seed="41" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <!-- graphite wobble for icon linework: a sub-pixel jitter along the stroke -->
  <filter id="vc-rough" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="3" seed="7" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="1.7" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <!-- ink soaking into paper: dilate + blur the alpha, then re-harden it -->
  <filter id="vc-bleed" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="1.1" result="b"/>
    <feComponentTransfer in="b" result="hard">
      <feFuncA type="linear" slope="3.2" intercept="-0.5"/>
    </feComponentTransfer>
    <feTurbulence type="fractalNoise" baseFrequency="0.22" numOctaves="3" seed="23" result="n"/>
    <feDisplacementMap in="hard" in2="n" scale="2.2" xChannelSelector="R" yChannelSelector="G" result="d"/>
    <feFlood flood-color="#33291f" result="c"/>
    <feComposite in="c" in2="d" operator="in" result="halo"/>
    <feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <!-- ink splatter used behind damage numerals -->
  <filter id="vc-splat" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="4" seed="91" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <!-- watercolour edge pooling for bar fills -->
  <filter id="vc-wash" x="-10%" y="-30%" width="120%" height="160%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.06 0.55" numOctaves="2" seed="61" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="2.0" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <linearGradient id="vc-ribbon-grad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#b8393c"/><stop offset="0.55" stop-color="#a32f34"/>
    <stop offset="1" stop-color="#7c2028"/>
  </linearGradient>
  <linearGradient id="vc-gold-grad" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#d8b168"/><stop offset="0.5" stop-color="#b3873f"/>
    <stop offset="1" stop-color="#8a6529"/>
  </linearGradient>
</defs>
</svg>`;

// --------------------------------------------------------------------------
// The stylesheet
// --------------------------------------------------------------------------

function css() {
  return `
.vc-root{
  --serif:'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua','Hoefler Text',Georgia,'Times New Roman',serif;
  --paper:${PALETTE.paper}; --paper-hi:${PALETTE.paperHi}; --paper-lo:${PALETTE.paperLo};
  --paper-edge:${PALETTE.paperEdge};
  --ink:${PALETTE.ink}; --ink-2:${PALETTE.ink2}; --ink-3:${PALETTE.ink3};
  --red:${PALETTE.red}; --red-deep:${PALETTE.redDeep}; --gold:${PALETTE.gold};
  --ally:${PALETTE.ally}; --enemy:${PALETTE.enemy}; --shadow:${PALETTE.shadow};
  --teal:${PALETTE.teal}; --olive:${PALETTE.olive};
  --grain:${'var(--vc-grain-uri)'}; --blotch:${'var(--vc-blotch-uri)'};
  --gap:0.75em;
  position:absolute; inset:0; overflow:hidden;
  font-family:var(--serif);
  font-size:clamp(13px, 0.40vw + 1.02vh, 20px);
  line-height:1.32;
  color:var(--ink);
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
.vc-root *{ box-sizing:border-box; }
.vc-root svg{ display:block; overflow:visible; }

/* ---------- paper primitives ------------------------------------------- */
.vc-panel{ position:relative; }
.vc-paper{
  position:absolute; inset:0; z-index:0; pointer-events:none;
  background-image: var(--grain), var(--blotch),
    radial-gradient(130% 100% at 24% 6%, var(--paper-hi) 0%, var(--paper) 44%, var(--paper-lo) 100%);
  background-blend-mode:multiply, multiply, normal;
  background-size:160px 160px, 420px 420px, 100% 100%;
  box-shadow:
    inset 0 0 0 1px rgba(51,41,31,.26),
    inset 0 0 18px rgba(128,96,58,.20),
    inset 0 1px 0 rgba(255,250,236,.55);
  filter: drop-shadow(0 1px 0 rgba(58,47,51,.20)) drop-shadow(0 7px 15px rgba(58,47,51,.36));
}
.vc-paper.vc-soft{ filter: drop-shadow(0 3px 7px rgba(58,47,51,.30)); }
.vc-content{ position:relative; z-index:1; }
/* second sheet peeking out behind, so panels read as a stack of pages */
.vc-under{
  position:absolute; z-index:-1; pointer-events:none;
  inset:0.35em -0.4em -0.55em 0.5em;
  background:linear-gradient(160deg,#e3d3ae,#cbb78f);
  opacity:.72;
  filter:drop-shadow(0 4px 10px rgba(58,47,51,.30));
}

/* ---------- typography -------------------------------------------------- */
.vc-label{
  font-variant:small-caps; letter-spacing:.20em; font-size:.66em;
  color:var(--ink-2); font-weight:600;
}
.vc-label.vc-tight{ letter-spacing:.13em; }
.vc-h1{ font-size:2.6em; line-height:1.06; letter-spacing:.01em; }
.vc-h2{ font-size:1.5em; line-height:1.12; }
.vc-h3{ font-size:1.06em; font-variant:small-caps; letter-spacing:.10em; }
.vc-it{ font-style:italic; }
.vc-num{ font-variant-numeric:lining-nums tabular-nums; font-feature-settings:"tnum" 1; }
.vc-dim{ color:var(--ink-3); }
.vc-red{ color:var(--red); }
.vc-body{ font-size:.86em; line-height:1.45; color:var(--ink-2); }

/* ---------- book frame -------------------------------------------------- */
.vc-frame{ position:absolute; inset:0; }
.vc-vignette{
  position:absolute; inset:0;
  background:
    radial-gradient(126% 112% at 50% 46%, rgba(58,47,51,0) 52%, rgba(58,47,51,.30) 82%, rgba(46,36,40,.62) 100%),
    linear-gradient(90deg, rgba(58,47,51,.34) 0%, rgba(58,47,51,0) 9%, rgba(58,47,51,0) 91%, rgba(58,47,51,.26) 100%);
  mix-blend-mode:multiply;
}
.vc-fibre{
  position:absolute; inset:0; opacity:.30; mix-blend-mode:multiply;
  background-image:var(--grain); background-size:160px 160px;
}
.vc-frame-rule{ position:absolute; inset:1.0em; opacity:.55; }
.vc-corner{ position:absolute; width:5.2em; height:5.2em; opacity:.62; }
.vc-corner.tl{ top:.7em; left:.7em; }
.vc-corner.tr{ top:.7em; right:.7em; transform:scaleX(-1); }
.vc-corner.bl{ bottom:.7em; left:.7em; transform:scaleY(-1); }
.vc-corner.br{ bottom:.7em; right:.7em; transform:scale(-1); }
.vc-bookmark{ position:absolute; top:0; left:27em; width:2.4em; }
.vc-rule{ margin:.6em 0 .55em; }

/* ---------- stacking order ----------------------------------------------- */
/* frame < world labels < mode HUDs < reticle < dialogue < pages < toasts */
.vc-frame{ z-index:0; }
.vc-bookmark{ z-index:1; }
.vc-world{ z-index:2; }
.vc-layer{ z-index:4; }
.vc-tgt{ z-index:5; }
.vc-legend{ z-index:6; }
.vc-alert{ z-index:14; }
.vc-dlg{ z-index:16; }
.vc-screens{ z-index:20; }
.vc-toasts{ z-index:26; }

/* ---------- generic layers ---------------------------------------------- */
.vc-layer{ position:absolute; inset:0; }
.vc-hidden{ display:none !important; }
.vc-fade{ transition:opacity .30s ease; }
.vc-off{ opacity:0; }

/* ---------- command mode ------------------------------------------------ */
.vc-cmd-top{ position:absolute; top:1.6em; left:2.2em; display:flex; align-items:flex-start; gap:1.1em; }
.vc-cp{ padding:.55em .85em .6em; min-width:11em; }
.vc-cp-row{ display:flex; gap:.28em; margin-top:.34em; flex-wrap:wrap; max-width:14em; }
.vc-cp-tok{ width:1.72em; height:1.72em; transform-origin:50% 60%; }
.vc-cp-tok.spent{ opacity:.34; }
.vc-cp-tok.fresh{ animation:vc-stamp .42s cubic-bezier(.2,1.5,.4,1) both; }
.vc-cp-count{ display:flex; align-items:baseline; gap:.4em; }
.vc-cp-count b{ font-size:2.05em; font-weight:400; line-height:.9; }
.vc-turn{ padding:.5em .95em .55em; text-align:center; }
.vc-turn b{ font-size:1.7em; font-weight:400; display:block; line-height:1; }

.vc-roster{
  position:absolute; left:1.5em; top:50%; transform:translateY(-50%);
  display:flex; flex-direction:column; gap:.55em; max-height:74vh;
}
.vc-ru{
  position:relative; width:14.4em; cursor:pointer;
  transition:transform .22s cubic-bezier(.2,.9,.3,1.15), filter .22s ease;
  animation:vc-slide-in .42s cubic-bezier(.16,.9,.3,1) both;
}
.vc-ru:hover{ transform:translateX(.45em) rotate(var(--tilt,0deg)) !important; }
.vc-ru.sel{ transform:translateX(.9em) rotate(var(--tilt,0deg)) !important; }
.vc-ru.sel .vc-paper{ box-shadow:inset 0 0 0 1.6px rgba(163,47,52,.75), inset 0 0 20px rgba(128,96,58,.22); }
.vc-ru.acted{ filter:saturate(.35) opacity(.66); }
.vc-ru.downed{ filter:grayscale(.7) opacity(.5); }
.vc-ru-in{ display:flex; gap:.5em; padding:.42em .5em; align-items:stretch; }
.vc-ru-por{ width:3.5em; height:3.9em; flex:0 0 auto; position:relative; }
.vc-ru-por svg{ width:100%; height:100%; }
.vc-ru-body{ flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:.16em; }
.vc-ru-name{ font-size:.94em; letter-spacing:.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.vc-ru-cls{ display:flex; align-items:center; gap:.3em; }
.vc-ru-cls svg{ width:1.05em; height:1.05em; }
/* A rubber stamp in the corner of the personnel card, clear of the name. */
.vc-ru-stamp{
  position:absolute; right:.34em; top:.34em; white-space:nowrap;
  font-variant:small-caps; letter-spacing:.16em; font-size:.52em;
  color:var(--red); border:1.4px solid var(--red); padding:.05em .34em .07em;
  transform:rotate(-8deg); opacity:.78; border-radius:2px;
  background:rgba(247,239,221,.72);
}
.vc-ru.acted .vc-ru-name{ padding-right:3.3em; }
.vc-ru-ribbon{ position:absolute; left:-.55em; top:.5em; width:.85em; height:2.6em; }

.vc-bar{ position:relative; height:.62em; }
.vc-bar-bg{ position:absolute; inset:0; background:rgba(51,41,31,.16); box-shadow:inset 0 0 0 1px rgba(51,41,31,.34); }
.vc-bar-fill{
  position:absolute; left:0; top:0; bottom:0; width:100%;
  transition:width .32s cubic-bezier(.3,.9,.3,1);
  filter:url(#vc-wash);
  background:linear-gradient(180deg, rgba(255,255,255,.28), rgba(0,0,0,.14));
}
.vc-bar-fill.hp{ background-color:#7e9152; }
.vc-bar-fill.hp.warn{ background-color:#c08a34; }
.vc-bar-fill.hp.crit{ background-color:#a5382f; }
.vc-bar-fill.ap{ background-color:#4b6c86; }
.vc-bar-ghost{ position:absolute; left:0; top:0; bottom:0; background:rgba(163,47,52,.42); transition:width .7s ease .18s; }
.vc-bar-num{ position:absolute; right:.25em; top:50%; transform:translateY(-50%); font-size:.58em; color:var(--ink-2); }

.vc-obj{ position:absolute; top:1.6em; right:2.0em; width:20em; padding:.6em .8em .7em; }
.vc-obj-row{ display:flex; gap:.45em; align-items:flex-start; margin-top:.3em; }
.vc-obj-row svg{ width:1.15em; height:1.15em; flex:0 0 auto; margin-top:.1em; }
.vc-obj-row.sub{ opacity:.78; font-size:.9em; }
.vc-obj-done{ text-decoration:line-through; opacity:.55; }

.vc-map{ position:absolute; right:2.0em; bottom:6.0em; width:22em; padding:.55em; }
.vc-map-in{ position:relative; width:100%; aspect-ratio:4/3; }
.vc-map-in svg{ position:absolute; inset:0; width:100%; height:100%; }
.vc-map-blips{ position:absolute; inset:0; }
.vc-map-title{ display:flex; justify-content:space-between; align-items:baseline; margin-bottom:.28em; }

.vc-rbtn{
  position:relative; width:14em; cursor:pointer;
  transition:transform .2s cubic-bezier(.2,.9,.3,1.2), filter .2s ease;
}
.vc-rbtn:hover{ transform:scale(1.04); filter:brightness(1.08); }
.vc-rbtn:active{ transform:scale(.985); }
.vc-rbtn.off{ filter:grayscale(.7) opacity(.45); cursor:default; }
.vc-rbtn svg{ width:100%; height:auto; }
.vc-rbtn-t{
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:.5em;
  color:#fbf2dd; font-variant:small-caps; letter-spacing:.20em; font-size:.94em;
  text-shadow:0 1px 0 rgba(60,12,16,.7); padding:0 1.5em .2em .7em; white-space:nowrap;
}
.vc-rbtn-t .vc-key{
  font-size:.68em; letter-spacing:.04em; border-color:rgba(255,240,220,.6);
  background:rgba(90,20,26,.4); color:#fbf2dd; box-shadow:0 1.2px 0 rgba(50,10,14,.5);
}
.vc-endturn{ position:absolute; right:2.0em; bottom:1.5em; }
.vc-endturn:hover{ transform:translateX(-.5em) scale(1.03); }
.vc-btnrow{ display:flex; gap:1.0em; justify-content:flex-end; align-items:center; margin-top:1.2em; }

/* The order strip lives strictly between the roster and the survey panel, and
   its cards shrink rather than collide when the viewport narrows. */
.vc-orders{
  position:absolute; left:17em; right:24.6em; bottom:2.3em;
  display:flex; gap:.6em; align-items:flex-end; justify-content:center;
}
.vc-card{
  position:relative; flex:0 1 9.4em; min-width:6.2em; cursor:pointer;
  animation:vc-deal .46s cubic-bezier(.14,.85,.28,1.06) both;
  transition:transform .18s cubic-bezier(.2,.9,.3,1.3), filter .18s ease;
}
.vc-card:hover{ transform:translateY(-.75em) rotate(var(--tilt,0deg)) scale(1.045) !important; z-index:4; }
.vc-card.locked{ filter:grayscale(.55) opacity(.5); cursor:default; }
.vc-card-in{ padding:.5em .55em .6em; display:flex; flex-direction:column; gap:.3em; }
.vc-card-art{ width:100%; aspect-ratio:5/3; position:relative; }
.vc-card-art svg{ position:absolute; inset:0; width:100%; height:100%; }
.vc-card-cost{
  position:absolute; right:-.4em; top:-.5em; width:2.3em; height:2.3em; z-index:2;
  display:grid; place-items:center;
}
.vc-card-cost span{ position:absolute; font-size:.9em; color:#fbf2dd; text-shadow:0 1px 0 rgba(60,12,16,.6); }
.vc-card-name{
  font-variant:small-caps; letter-spacing:.05em; font-size:.84em; line-height:1.12;
  min-height:2.0em; overflow-wrap:anywhere;
}
.vc-card-desc{ font-size:.62em; line-height:1.3; color:var(--ink-2); min-height:3.2em; }

/* ---------- action mode ------------------------------------------------- */
.vc-ap{ position:absolute; left:2.0em; bottom:1.9em; width:26em; padding:.5em .75em .7em; }
.vc-ap-head{ display:flex; align-items:baseline; gap:.5em; margin-bottom:.22em; }
.vc-ap-head b{ font-size:1.5em; font-weight:400; }
.vc-ap-meter{ position:relative; height:1.15em; }
.vc-ap-meter .vc-bar-fill{ filter:url(#vc-wash); }
.vc-ap-ticks{ position:absolute; inset:0; pointer-events:none; }
.vc-ap.low .vc-ap-head b{ color:var(--red); animation:vc-throb 1.05s ease-in-out infinite; }

.vc-name{ position:absolute; left:2.0em; bottom:6.9em; display:flex; align-items:center; gap:.55em; }
.vc-badge{ position:relative; width:2.9em; height:3.1em; }
.vc-badge svg{ position:absolute; inset:0; width:100%; height:100%; }
.vc-name-t b{ font-size:1.22em; font-weight:400; display:block; line-height:1.1; }

.vc-ammo{ position:absolute; right:2.0em; bottom:1.9em; width:14.5em; padding:.5em .75em .65em;
  text-align:right; }
.vc-ammo-pips{ display:flex; gap:.22em; justify-content:flex-end; margin-top:.25em; }
.vc-ammo-pips svg{ width:.62em; height:1.5em; }
.vc-ammo-pips .spent{ opacity:.30; }
.vc-ammo-n{ font-size:1.4em; }
.vc-ammo-n small{ font-size:.55em; color:var(--ink-3); }
.vc-reload{ margin-top:.2em; color:var(--red); font-variant:small-caps; letter-spacing:.2em; font-size:.72em; }

.vc-compass{
  position:absolute; top:1.7em; left:50%; transform:translateX(-50%);
  width:36em; max-width:62vw; height:4.0em; overflow:hidden;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 14%,#000 86%,transparent);
  mask-image:linear-gradient(90deg,transparent,#000 14%,#000 86%,transparent);
}
.vc-compass-tape{ position:absolute; top:0; left:0; height:100%; will-change:transform; }
.vc-compass-pin{ position:absolute; top:0; transform:translateX(-50%); text-align:center; }
.vc-compass-pin svg{ width:1.1em; height:1.1em; margin:0 auto; }
.vc-compass-pin span{ font-size:.56em; font-variant:small-caps; letter-spacing:.14em; }

.vc-alert{
  position:absolute; top:22%; left:50%; transform:translateX(-50%);
  text-align:center; opacity:0;
}
.vc-alert.on{ animation:vc-alert 2.1s cubic-bezier(.2,.9,.3,1) both; }
.vc-alert-t{
  font-variant:small-caps; letter-spacing:.34em; font-size:2.0em; color:var(--red-deep);
  filter:url(#vc-bleed);
}
.vc-alert-sub{ font-size:.72em; letter-spacing:.24em; font-variant:small-caps; color:var(--ink-2); }

.vc-dmgv{ position:absolute; inset:0; opacity:0; mix-blend-mode:multiply;
  background:radial-gradient(120% 110% at 50% 50%, rgba(122,32,36,0) 42%, rgba(122,32,36,.55) 88%, rgba(84,20,26,.85) 100%);
}
.vc-intercept{ position:absolute; inset:0; opacity:0; mix-blend-mode:multiply;
  background:linear-gradient(90deg, rgba(163,47,52,.5), rgba(163,47,52,0) 11%, rgba(163,47,52,0) 89%, rgba(163,47,52,.5)); }
.vc-intercept.on{ animation:vc-icept .5s steps(1,end) 3; }

/* ---------- targeting overlay ------------------------------------------- */
.vc-tgt{ position:absolute; inset:0; opacity:0; transition:opacity .18s ease; }
.vc-tgt.on{ opacity:1; }
.vc-cross{ position:absolute; left:50%; top:50%; width:15em; height:15em; transform:translate(-50%,-50%); }
.vc-cross svg{ width:100%; height:100%; }
.vc-acc{ position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); }
.vc-brackets{ position:absolute; left:50%; top:50%; width:21em; height:15em; transform:translate(-50%,-50%); }
.vc-brackets svg{ width:100%; height:100%; }
.vc-hit{
  position:absolute; left:calc(50% + 6.0em); top:calc(50% - 3.2em); text-align:left;
}
.vc-hit b{ font-size:2.0em; font-weight:400; line-height:.95; display:block; }
.vc-tcard{ position:absolute; right:2.0em; top:8.5em; width:17em; padding:.55em .7em .65em; }
.vc-tcard-head{ display:flex; align-items:center; gap:.45em; }
.vc-tcard-head svg{ width:1.3em; height:1.3em; }
.vc-tcard-rows{ margin-top:.35em; display:flex; flex-direction:column; gap:.24em; font-size:.76em; }
.vc-tcard-rows div{ display:flex; justify-content:space-between; gap:1em; }
.vc-body-fig{ width:4.4em; margin:.45em auto 0; opacity:.9; }
.vc-body-fig svg{ width:100%; height:auto; }

/* ---------- world-space labels ------------------------------------------ */
.vc-world{ position:absolute; inset:0; overflow:hidden; }
.vc-wl{ position:absolute; left:0; top:0; will-change:transform; transform-origin:50% 50%; }
.vc-nametag{ transform:translate(-50%,-100%); text-align:center; white-space:nowrap; }
.vc-nametag .t{
  display:inline-block; padding:.06em .5em .1em; font-size:.68em;
  font-variant:small-caps; letter-spacing:.13em;
  background:linear-gradient(180deg, rgba(244,236,216,.94), rgba(226,213,183,.9));
  box-shadow:0 0 0 1px rgba(51,41,31,.5), 0 2px 5px rgba(58,47,51,.35);
  color:var(--ink);
}
.vc-nametag.foe .t{ box-shadow:0 0 0 1px rgba(141,55,48,.85), 0 2px 5px rgba(58,47,51,.35); color:#7a2822; }
.vc-nametag .hp{ width:5.4em; height:.28em; margin:.14em auto 0; position:relative; }
.vc-dmg{ transform:translate(-50%,-50%); text-align:center; }
.vc-dmg .n{ font-size:1.5em; color:#f6ecd4; text-shadow:0 0 .12em rgba(60,20,20,.9), 0 2px 0 rgba(60,20,20,.5); position:relative; z-index:1; }
.vc-dmg.crit .n{ font-size:2.1em; color:#ffe9b8; }
.vc-dmg .splat{ position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); z-index:0; }
.vc-dmg .tag{ font-size:.62em; font-variant:small-caps; letter-spacing:.22em; color:#ffd48a; }
.vc-banner{ transform:translate(-50%,-50%); text-align:center; white-space:nowrap;
  font-variant:small-caps; letter-spacing:.24em; font-size:1.0em; color:var(--red-deep); filter:url(#vc-bleed); }
.vc-ring{ transform:translate(-50%,-50%); }

/* ---------- screens ------------------------------------------------------ */
.vc-screens{ position:absolute; inset:0; }
.vc-screen{ position:absolute; inset:0; display:grid; place-items:center; }
.vc-scrim{ position:absolute; inset:0; background:rgba(38,29,26,.62); backdrop-filter:blur(2px) saturate(.8); }
.vc-page{ position:relative; width:min(74em, 88vw); max-height:88vh; }
.vc-page-in{ padding:2.0em 2.4em 2.2em; }

.vc-chapter{ position:absolute; inset:0; display:grid; place-items:center; perspective:2200px; }
.vc-chapter .vc-scrim{ animation:vc-fade-in .5s ease both; background:rgba(38,29,26,.55); }
.vc-chapter .vc-page{ width:min(50em,78vw); transform-origin:left center; }
.vc-chapter.in .vc-page{ animation:vc-page-in .95s cubic-bezier(.22,.9,.26,1) both; }
.vc-chapter.out .vc-page{ animation:vc-page-out .78s cubic-bezier(.5,0,.72,.3) both; }
.vc-chapter-in{ padding:2.4em 3.0em 2.6em; text-align:center; }
.vc-chapter-num{ font-variant:small-caps; letter-spacing:.42em; font-size:.82em; color:var(--red); }
.vc-chapter-ill{ width:100%; max-width:34em; margin:1.1em auto .5em; }

.vc-cols{ display:grid; grid-template-columns:1.25fr 1fr; gap:1.6em; }
.vc-obj-list{ display:flex; flex-direction:column; gap:.55em; }
.vc-obj-item{ display:flex; gap:.6em; align-items:flex-start; }
.vc-obj-item svg{ width:1.5em; height:1.5em; flex:0 0 auto; }
.vc-squad{ display:flex; flex-wrap:wrap; gap:.5em; }
.vc-chip{
  position:relative; width:6.4em; cursor:pointer;
  transition:transform .18s cubic-bezier(.2,.9,.3,1.3);
}
.vc-chip:hover{ transform:translateY(-.3em) rotate(var(--tilt,0deg)) scale(1.06) !important; }
.vc-chip.on .vc-paper{ box-shadow:inset 0 0 0 2px rgba(163,47,52,.8), inset 0 0 16px rgba(128,96,58,.2); }
.vc-chip-in{ padding:.35em .35em .45em; text-align:center; }
.vc-chip-in svg.por{ width:100%; height:auto; }
.vc-chip-n{ font-size:.68em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:.15em; }

.vc-camps{ display:flex; gap:1.2em; align-items:flex-start; }
.vc-camp{ flex:1 1 0; min-width:0; padding:.7em .8em .9em; }
.vc-camp.on .vc-paper{ box-shadow:inset 0 0 0 2px rgba(163,47,52,.7), inset 0 0 16px rgba(128,96,58,.2); }
.vc-camp-h{ display:flex; align-items:center; gap:.4em; margin-bottom:.4em; }
.vc-camp-h svg{ width:1.3em; height:1.3em; }
.vc-slots{ display:flex; flex-wrap:wrap; gap:.4em; min-height:5.6em; }

.vc-result-rank{ position:relative; width:11em; height:11em; margin:0 auto; }
.vc-result-rank svg{ position:absolute; inset:0; width:100%; height:100%; }
.vc-result-rank.slam{ animation:vc-slam .62s cubic-bezier(.2,1.7,.4,1) both; }
.vc-result-rank .letter{
  position:absolute; inset:0; display:grid; place-items:center;
  font-size:5.6em; color:var(--red-deep); line-height:1; padding-bottom:.06em;
}
.vc-stats{ display:flex; flex-direction:column; gap:.4em; margin-top:1.0em; }
.vc-stat{ display:flex; justify-content:space-between; align-items:baseline; gap:1.4em;
  border-bottom:1px dashed rgba(51,41,31,.3); padding-bottom:.2em; }
.vc-stat b{ font-size:1.35em; font-weight:400; }
.vc-stat.late{ animation:vc-stat-in .4s ease both; }

.vc-menu{ display:flex; flex-direction:column; gap:.3em; margin-top:1.0em; }
.vc-mi{
  display:flex; align-items:center; justify-content:space-between; gap:1.2em;
  padding:.34em .7em; cursor:pointer; position:relative;
}
.vc-mi:hover{ background:rgba(163,47,52,.10); }
.vc-mi:hover::before{ content:''; position:absolute; left:-.1em; top:50%; transform:translateY(-50%);
  border:.34em solid transparent; border-left-color:var(--red); }
.vc-mi .v{ font-variant:small-caps; letter-spacing:.14em; color:var(--ink-2); font-size:.86em; }
.vc-mi .k{ font-size:1.02em; }

/* ---------- dialogue ----------------------------------------------------- */
.vc-dlg{ position:absolute; left:50%; bottom:2.0em; width:min(62em,84vw); transform:translateX(-50%);
  animation:vc-slide-up .38s cubic-bezier(.16,.9,.3,1) both; }
/* The speaker's bust rises out of the top of the box, VC-style. */
.vc-dlg-in{ display:block; padding:.9em 1.1em 1.0em 9.6em; min-height:6.2em; }
.vc-dlg-por{ position:absolute; left:1.0em; bottom:.15em; width:7.8em; }
.vc-dlg-por svg{ width:100%; height:auto; filter:drop-shadow(0 3px 6px rgba(58,47,51,.42)); }
.vc-dlg-body{ min-width:0; }
.vc-dlg-name{ display:inline-block; position:relative; margin:-1.6em 0 .35em -1.0em; padding:.14em 1.1em .18em 1.0em;
  color:#fbf2dd; font-variant:small-caps; letter-spacing:.2em; font-size:.86em;
  background:linear-gradient(180deg,#b8393c,#7c2028);
  box-shadow:0 2px 6px rgba(58,47,51,.4); clip-path:polygon(0 0,100% 0,calc(100% - .7em) 100%,0 100%); }
.vc-dlg-text{ font-size:.95em; line-height:1.5; min-height:3.2em; }
.vc-caret{ display:inline-block; width:.5em; margin-left:.12em; animation:vc-blink 1s steps(1) infinite; }
.vc-dlg-next{ position:absolute; right:1.0em; bottom:.5em; font-size:.6em; font-variant:small-caps;
  letter-spacing:.2em; color:var(--ink-3); animation:vc-throb 1.4s ease-in-out infinite; }

/* ---------- controls legend ---------------------------------------------- */
.vc-legend{ position:absolute; left:50%; bottom:.55em; transform:translateX(-50%);
  display:flex; gap:.85em; flex-wrap:wrap; justify-content:center; max-width:76vw;
  padding:.24em .7em; }
.vc-lg{ display:flex; align-items:center; gap:.32em; font-size:.66em; color:var(--ink-2);
  font-variant:small-caps; letter-spacing:.1em; }
.vc-key{
  display:inline-grid; place-items:center; min-width:1.55em; height:1.45em; padding:0 .3em;
  border:1.3px solid rgba(51,41,31,.62); border-radius:3px; font-size:.92em; letter-spacing:.02em;
  box-shadow:0 1.5px 0 rgba(51,41,31,.35); background:rgba(247,239,221,.55);
  font-variant:normal;
}
.vc-legend .vc-paper{ filter:none; box-shadow:none; opacity:.66; }

/* ---------- toast -------------------------------------------------------- */
.vc-toasts{ position:absolute; top:6.4em; left:50%; transform:translateX(-50%);
  display:flex; flex-direction:column; gap:.35em; align-items:center; }
.vc-toast{ padding:.28em .9em .34em; font-size:.8em; font-variant:small-caps; letter-spacing:.16em;
  animation:vc-toast 2.6s cubic-bezier(.2,.9,.3,1) both; position:relative; }

/* ---------- keyframes ---------------------------------------------------- */
@keyframes vc-slide-in{
  from{ opacity:0; transform:translateX(-2.2em) rotate(-1.4deg); filter:blur(2.5px); }
  60%{ opacity:1; filter:blur(0); }
  to{ opacity:1; transform:translateX(0) rotate(var(--tilt,0deg)); filter:blur(0); }
}
@keyframes vc-slide-up{
  from{ opacity:0; transform:translateX(-50%) translateY(1.6em) rotate(var(--tilt,0deg)); filter:blur(2px); }
  to{ opacity:1; transform:translateX(-50%) translateY(0) rotate(var(--tilt,0deg)); filter:blur(0); }
}
@keyframes vc-deal{
  from{ opacity:0; transform:translate(-9em, 4.5em) rotate(-16deg) scale(.86); }
  to{ opacity:1; transform:translate(0,0) rotate(var(--tilt,0deg)) scale(1); }
}
@keyframes vc-stamp{
  from{ transform:scale(2.1) rotate(-14deg); opacity:0; filter:blur(3px); }
  70%{ opacity:1; filter:blur(0); }
  to{ transform:scale(1) rotate(0); opacity:1; filter:blur(0); }
}
@keyframes vc-slam{
  0%{ transform:scale(3.2) rotate(-22deg); opacity:0; filter:blur(7px); }
  46%{ transform:scale(1.06) rotate(-7deg); opacity:1; filter:blur(0); }
  62%{ transform:scale(.965) rotate(-4.4deg); }
  100%{ transform:scale(1) rotate(-5.6deg); opacity:1; }
}
@keyframes vc-page-in{
  from{ transform:rotateY(-96deg) translateZ(0); opacity:.1; }
  to{ transform:rotateY(0deg); opacity:1; }
}
@keyframes vc-page-out{
  from{ transform:rotateY(0deg); opacity:1; }
  to{ transform:rotateY(88deg); opacity:0; }
}
@keyframes vc-alert{
  0%{ opacity:0; transform:translateX(-50%) scale(1.5); filter:blur(6px); }
  14%{ opacity:1; transform:translateX(-50%) scale(1); filter:blur(0); }
  16%{ transform:translateX(-50%) translateX(-.4em) scale(1); }
  18%{ transform:translateX(-50%) translateX(.35em) scale(1); }
  20%{ transform:translateX(-50%) scale(1); }
  80%{ opacity:1; }
  100%{ opacity:0; transform:translateX(-50%) scale(1.04); }
}
@keyframes vc-icept{ 0%{opacity:0} 12%{opacity:.9} 40%{opacity:0} 100%{opacity:0} }
@keyframes vc-throb{ 0%,100%{ opacity:1 } 50%{ opacity:.42 } }
@keyframes vc-blink{ 0%,49%{ opacity:1 } 50%,100%{ opacity:0 } }
@keyframes vc-stat-in{ from{ opacity:0; transform:translateX(1.2em); } to{ opacity:1; transform:none; } }
@keyframes vc-toast{
  0%{ opacity:0; transform:translateY(-.9em) rotate(var(--tilt,0deg)); filter:blur(3px); }
  10%{ opacity:1; transform:translateY(0) rotate(var(--tilt,0deg)); filter:blur(0); }
  82%{ opacity:1; }
  100%{ opacity:0; transform:translateY(-.5em) rotate(var(--tilt,0deg)); }
}
@keyframes vc-fade-in{ from{opacity:0} to{opacity:1} }

/* ---------- responsive --------------------------------------------------- */
@media (max-aspect-ratio:5/4){
  .vc-map{ width:17em; }
  .vc-obj{ width:16em; }
}
@media (max-width:1400px){
  .vc-roster{ left:1.0em; gap:.42em; }
  .vc-ru{ width:13.2em; }
  .vc-orders{ left:15.4em; right:22.6em; gap:.45em; }
  .vc-card-name{ font-size:.74em; letter-spacing:.02em; }
  .vc-card-desc{ font-size:.58em; }
  .vc-map{ width:20em; }
  .vc-ap{ width:22em; }
}

/* ---------- reduced motion ----------------------------------------------- */
.vc-root.vc-nomotion *, .vc-root.vc-nomotion *::before, .vc-root.vc-nomotion *::after{
  animation-duration:.001s !important; animation-delay:0s !important;
  transition-duration:.09s !important;
}
@media (prefers-reduced-motion:reduce){
  .vc-root *, .vc-root *::before, .vc-root *::after{
    animation-duration:.001s !important; animation-delay:0s !important;
    transition-duration:.09s !important;
  }
  .vc-chapter.in .vc-page, .vc-chapter.out .vc-page{ animation:vc-fade-in .2s both; }
  .vc-result-rank.slam{ animation:vc-fade-in .2s both; transform:rotate(-5.6deg); }
  .vc-alert.on{ animation:vc-fade-in .2s both; opacity:1; }
}
`;
}

// --------------------------------------------------------------------------

let styleEl = null;
let defsHost = null;

/** Inject the stylesheet + SVG filter defs. Idempotent. */
export function injectStyles() {
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'vc-ui-style';
    styleEl.textContent =
      ':root{--vc-grain-uri:' + grainUri() + ';--vc-blotch-uri:' + blotchUri() + ';}\n' + css();
    document.head.appendChild(styleEl);
  }
  if (!defsHost) {
    defsHost = document.createElement('div');
    defsHost.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    defsHost.innerHTML = FILTER_DEFS;
    document.body.appendChild(defsHost);
  }
  return styleEl;
}

export function disposeStyles() {
  styleEl?.remove();
  defsHost?.remove();
  styleEl = null;
  defsHost = null;
}

/** True when the viewer has asked for reduced motion. */
export function reducedMotion() {
  return typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
}
