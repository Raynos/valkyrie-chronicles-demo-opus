// src/ui/worldLabels.js
// Everything that lives at a world position but is drawn as crisp DOM: unit name
// tags, damage numerals, shout banners and base-capture rings.
//
// Per-frame cost is bounded: every element is pooled, no DOM is created after
// warm-up, no vectors are allocated in update(), and elements that fall behind
// the camera are parked with visibility:hidden rather than re-laid-out.

import * as THREE from 'three';
import { V0, clamp01, easeOutBack, easeOutCubic } from '../core/math.js';
import { makeRng } from '../core/rng.js';
import { h, clear, svgEl } from './dom.js';
import {
  captureRing, inkRule, inkGauge, damagePlate, wobblyPath, splatPath, hatchPath,
  iconMarkup, roughCircle, fieldFigure, fieldVehicle,
} from './icons.js';
import { deckleClip } from './style.js';

const DMG_POOL = 28;
const BANNER_POOL = 10;
// How many Imperial name slips may be on the page at once (nearest win).
// Round 2 held this at 3 and the leash at 54 m, which between them threw away
// the informational layer the action shots exist to show: a firefight across a
// 40 m river came back with one slip on it. Both are now set to "everything the
// eye can actually see", and the DECLUTTER pass — not an arbitrary cap — is what
// keeps the page from becoming a list.
// Round 5 held it at 5 and the firefight plate came back with four Imperial slips
// stacked in one column over the far frontages — the exact "list of names laid over
// a drawing of a fight" this file's own comment warns about, and the reason is that
// a garrison dug in along one bank projects into one column however well it is
// staged. Three is enough to say who is over there and few enough that they can be
// spread by the declutter pass instead of queued by it.
const MAX_FOE_TAGS = 3;
// And how many slips of ANY colour.
const MAX_TAGS = 7;
// Line-of-sight is re-tested this often (seconds). A slip over a man who is
// behind a house is the single most damning HUD tell there is, but the answer
// does not change at 140 fps.
const OCCLUSION_PERIOD = 0.11;
// Fractions of a soldier's height sampled by the line-of-sight test: chest,
// crown, hip. Any one of them clear counts as "you can see him".
const OCC_SAMPLES = [0.62, 0.94, 0.34];

/** Gallian mark: a small pennant on a staff, inked in indigo. */
function allyMark(seed) {
  const s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">' +
    '<path d="' + wobblyPath(4.5, 1.5, 4.5, 14.5, { seed, amp: 0.35, segs: 4 }) +
    '" stroke="#2f4258" stroke-width="1.5" fill="none" stroke-linecap="round"/>' +
    '<path d="M5 2.6 L13.4 5.4 L5 8.6 Z" fill="#37536f" stroke="#22364a" stroke-width="1" ' +
    'stroke-linejoin="round" filter="url(#vc-rough)"/></svg>';
  return svgEl(s);
}

/** Imperial mark: a stamped lozenge on a hatched ground, in oxide red. */
function foeMark(seed) {
  const s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">' +
    '<path d="' + hatchPath(1, 1, 14, 14, { spacing: 3.1, angle: -0.85, seed: seed + 3 }) +
    '" stroke="#7a2822" stroke-width="0.7" opacity="0.42" fill="none"/>' +
    '<path d="' + splatPath(8, 8, 6.4, { seed: seed + 11, lobes: 4, rough: 0.10 }) +
    '" fill="#8d3730" stroke="#5e1c19" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  return svgEl(s);
}

const TOKEN_CLS = {
  scout: 'scout', shock: 'shock', shocktrooper: 'shock', lancer: 'lancer',
  engineer: 'engineer', sniper: 'sniper', tank: 'tank',
};

/** Counter geometry, in the counter's own 52x56 viewBox. */
const CTR = { cx: 26, cy: 29 };

/**
 * The hand-cut card a command counter is drawn on.
 *
 * Allegiance is carried by the CUT, not only by the colour: a Gallian counter
 * has its top corners taken off (a tab that points forward), an Imperial one has
 * its bottom corners taken off (a tab that points back). Two counters printed in
 * grey still tell you whose they are, which is the test a map symbol has to pass
 * and which the old red-and-blue discs failed.
 */
function counterPoints(foe, w, hgt, seed) {
  const { cx, cy } = CTR;
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - hgt / 2, y1 = cy + hgt / 2;
  const ch = 4.6;
  const p = foe
    ? [[x0, y0], [x1, y0], [x1, y1 - ch], [x1 - ch, y1], [x0 + ch, y1], [x0, y1 - ch]]
    : [[x0 + ch, y0], [x1 - ch, y0], [x1, y0 + ch], [x1, y1], [x0, y1], [x0, y0 + ch]];
  // Hand-cut: every corner is a little off where a ruler would have put it.
  const rng = makeRng((seed >>> 0) || 7);
  return p.map(([x, y]) => [x + (rng() * 2 - 1) * 0.62, y + (rng() * 2 - 1) * 0.62]);
}

const polyD = (p) => 'M' + p.map((q) => q[0].toFixed(2) + ' ' + q[1].toFixed(2)).join('L') + 'Z';

/** The card's outline as N wobbly runs — a drawn edge, never a vector one. */
function polyStroke(p, seed, amp) {
  let d = '';
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    d += wobblyPath(a[0], a[1], b[0], b[1],
      { seed: seed + i * 13, amp, segs: 3, overshoot: 0.55 }) + ' ';
  }
  return d;
}

/**
 * A command-mode counter: the marker a staff officer pushes across a survey.
 *
 * Round 5 drew this as a round disc on a stem — which, at the command camera and
 * over a painted landscape, is a map-application PIN, and a map-application pin
 * is the single most modern object it is possible to put on a page that is
 * pretending to be a 1930s field journal. It is replaced here by the thing a
 * staff officer actually pushes across a survey: a small card of cream stock,
 * cut by hand, ruled in ink, with a colour bar at the head, the arm-of-service
 * glyph on the body, a facing pip, and a strength gauge along the foot.
 *
 * Everything about it is drawn: the outline is six wobbly runs with overshoot,
 * the corners are jittered off the ruler, the card throws an offset paper shadow
 * and the Imperial stock is hatched along its foot. It carries five states —
 * plain, selected (a grease-pencil ring), spent (struck through), damaged (the
 * gauge) and down (crossed out) — because a marker that cannot say what the unit
 * has DONE is decoration rather than a HUD.
 *
 * @param {0|1} team
 * @param {string} cls unit class id
 * @param {number} seed
 * @param {{vehicle?:boolean}} [opts]
 */
function unitCounter(team, cls, seed, { vehicle = false } = {}) {
  const foe = team === 1;
  const ink = foe ? '#59201b' : '#28394c';
  const band = foe ? '#9c4032' : '#4b6a8b';
  const stock = foe ? '#e7d5b4' : '#f3e8ce';
  const w = vehicle ? 34 : 27;
  const hgt = vehicle ? 23 : 21;
  const { cx, cy } = CTR;
  const p = counterPoints(foe, w, hgt, seed);
  const card = polyD(p);
  const y0 = cy - hgt / 2, y1 = cy + hgt / 2;
  const cid = 'cclip' + (seed >>> 0);
  const glyph = iconMarkup(TOKEN_CLS[cls] || 'scout', {
    size: vehicle ? 17 : 14, width: 2.1, stroke: ink, rough: false,
  }).replace(/^<svg /, '<svg x="' + (cx - (vehicle ? 8.5 : 7)) + '" y="' +
    (cy - (vehicle ? 6.5 : 5.4)) + '" ');

  return svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 56" width="52" height="56">' +
    '<defs><clipPath id="' + cid + '"><path d="' + card + '"/></clipPath></defs>' +
    // the counter's own shadow on the survey — an offset copy of the same cut,
    // because a card of pasteboard does not cast a round blur
    '<path d="' + card + '" fill="#453630" opacity="0.30" transform="translate(1.5 2.9)"/>' +
    // the stock
    '<path d="' + card + '" fill="' + stock + '"/>' +
    '<g clip-path="url(#' + cid + ')">' +
    // colour bar at the head: the one saturated mark on the counter
    '<rect x="0" y="' + y0.toFixed(1) + '" width="52" height="6.4" fill="' + band +
    '" opacity="0.95"/>' +
    '<rect x="0" y="' + (y0 + 6.4).toFixed(1) + '" width="52" height="1.1" fill="' + ink +
    '" opacity="0.45"/>' +
    // Imperial stock is hatched along the foot; Gallian is clean. Shape, mark AND
    // texture differ, so the two read apart at 20 px and in monochrome.
    (foe
      ? '<path d="' + hatchPath(cx - w / 2, y1 - 7, w, 7,
        { spacing: 2.5, angle: -0.86, seed: seed + 21 }) +
        '" stroke="' + ink + '" stroke-width="0.6" opacity="0.34" fill="none"/>'
      : '') +
    // a laid tint so the stock is not a flat fill
    '<path d="' + splatPath(cx - 3, cy + 2, w * 0.52, { seed: seed + 5, lobes: 9, rough: 0.34 }) +
    '" fill="#a8905f" opacity="0.13"/>' +
    '</g>' +
    // double-struck rim: one weighted pass, one hairline ghost beside it
    '<path d="' + polyStroke(p, seed + 3, 0.52) + '" fill="none" stroke="' + ink +
    '" stroke-width="1.75" stroke-linecap="round" opacity="0.95"/>' +
    '<path d="' + polyStroke(p, seed + 61, 0.85) + '" fill="none" stroke="' + ink +
    '" stroke-width="0.55" stroke-linecap="round" opacity="0.34"/>' +
    glyph +
    // strength gauge along the foot — hidden until the unit is actually hurt
    '<g class="hp" style="display:none">' +
    '<rect x="' + (cx - w / 2 + 2.5).toFixed(1) + '" y="' + (y1 - 3.4).toFixed(1) +
    '" width="' + (w - 5).toFixed(1) + '" height="2.3" fill="' + ink + '" opacity="0.22"/>' +
    '<rect class="hpf" x="' + (cx - w / 2 + 2.5).toFixed(1) + '" y="' + (y1 - 3.4).toFixed(1) +
    '" width="' + (w - 5).toFixed(1) + '" height="2.3" fill="#8a2f2c"/></g>' +
    // facing pip: a pen-nib triangle that swings round the card
    '<g class="fac"><path d="M' + cx + ' ' + (cy - 20) + 'L' + (cx + 4.4) + ' ' + (cy - 13.2) +
    'L' + (cx - 4.4) + ' ' + (cy - 13.2) + 'Z" fill="' + band + '" stroke="' + ink +
    '" stroke-width="1.5" stroke-linejoin="round"/></g>' +
    // spent: the counter is struck off with a grease pencil
    '<path class="act" d="' + wobblyPath(cx - w / 2 - 1, y1 - 2, cx + w / 2 + 1, y0 + 2,
      { seed: seed + 33, amp: 0.9, segs: 5, overshoot: 1.2 }) +
    '" stroke="#4b3f36" stroke-width="2.1" stroke-linecap="round" fill="none" opacity="0"/>' +
    // down: crossed out entirely
    '<g class="dwn" opacity="0"><path d="' +
    wobblyPath(cx - w / 2, y0, cx + w / 2, y1, { seed: seed + 41, amp: 1.1, segs: 5 }) + ' ' +
    wobblyPath(cx + w / 2, y0, cx - w / 2, y1, { seed: seed + 47, amp: 1.1, segs: 5 }) +
    '" stroke="#5d2420" stroke-width="2.4" stroke-linecap="round" fill="none"/></g>' +
    // selected: a ring of red grease pencil thrown round the counter by hand
    '<g class="sel" opacity="0">' +
    '<path d="' + roughCircle(cx, cy, w * 0.72, { seed: seed + 71, amp: 1.15, segs: 22 }) +
    '" fill="none" stroke="#a32f34" stroke-width="2.3" stroke-linecap="round" opacity="0.92"/>' +
    '<path d="' + roughCircle(cx, cy, w * 0.78, { seed: seed + 83, amp: 1.5, segs: 20, open: 1.9 }) +
    '" fill="none" stroke="#a32f34" stroke-width="1.0" stroke-linecap="round" opacity="0.45"/>' +
    '</g></svg>');
}

/** Stable 32-bit hash of a string, for per-name deckle seeds. */
function hashStr(s) {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x >>> 0;
}

// Screen-space ballistics for damage numerals, in px at a 900px-tall reference.
const DMG_GRAV = 900;
const DMG_LIFE = 1.35;
const CRIT_LIFE = 1.75;

// How much bigger than life a command-map figure is drawn, and the window it is
// held inside. FIG_MIN is the floor below which a silhouette stops being one:
// at 24 px — what round 6 measured — a soldier is a smudge, and the whole reason
// `command` has been the worst card in the set for five rounds. FIG_MAX stops a
// counter in the near corner of the map from towering over the survey.
const FIG_GAIN = 1.75;
const FIG_MIN = 40;
const FIG_MAX = 88;
// ...and the same window for ARMOUR, quoted as the symbol's drawn LENGTH.
// The vehicle symbol is 118 x 64 in its own viewBox, so a 150 px counter stands
// 81 px tall — about the height a 40 px infantry figure beside it reads at,
// scaled by the real 3:1 difference between a man and a medium tank.
const VEH_MIN = 104;
const VEH_MAX = 210;
const VEH_ASPECT = 64 / 118;

export class WorldLabels {
  /**
   * @param {HTMLElement} layer container (position:absolute, inset:0)
   * @param {THREE.Camera} [camera]
   */
  constructor(layer, camera = null) {
    this.layer = layer;
    this.camera = camera;
    this.w = 1;
    this.h = 1;
    this._resizeCounter = 0;

    this.tags = new Map();      // unit -> { el, fill, hpKey, offset }
    this.tokens = new Map();    // unit -> { el, key }
    this.figures = new Map();   // unit -> { el, ang }  (command-map symbols)
    this.rings = new Map();     // id   -> { el, anchor, circle, progress }

    this._p = new THREE.Vector3();
    this._pf = new THREE.Vector3();
    this._occPt = new THREE.Vector3();
    this._out = { x: 0, y: 0, depth: 0, visible: false };
    /** (worldPoint, unit) => true when the camera can actually see that point. */
    this.occluder = null;
    /** The soldier the camera is riding: he never wears his own name slip. */
    this.selfUnit = null;
    /** Only these units may be annotated (null = anyone). */
    this.filter = null;
    /** Command mode is a MAP: a slip may sit over a canopy there quite legibly. */
    this.useOcclusion = true;
    /** Minimum screen-space rise above the anchor, in px at a 900px reference. */
    this.screenLift = 0;
    /** Command mode pushes counters onto the map; action mode does not. */
    this.useTokens = false;
    /**
     * Command mode also draws the SOLDIER, not only his counter.
     *
     * At the map camera the rendered figure is 13x24 px of salt-and-pepper (see
     * icons.js fieldFigure), so CommandMode hides the rig and this layer draws an
     * authored symbol in its place at FIG_GAIN times the size the man projected
     * to. Off in every other phase — an action shot photographs the actual model.
     */
    this.useFigures = false;
    /** The unit the page is currently pointed at (its counter is ringed). */
    this.markedUnit = null;
    this._occClock = 0;

    this._spin = 0.3819660113;   // golden-ratio walk: deterministic pop scatter
    this.dmg = [];
    for (let i = 0; i < DMG_POOL; i++) this.dmg.push(this._makeDmg(i));
    this.banners = [];
    for (let i = 0; i < BANNER_POOL; i++) this.banners.push(this._makeBanner(i));

    this.resize();
  }

  resize() {
    const r = this.layer.getBoundingClientRect();
    this.w = r.width || innerWidth;
    this.h = r.height || innerHeight;
    this.scale = this.h / 900;
  }

  setCamera(cam) { this.camera = cam; }

  /**
   * Install the line-of-sight test used to cull name slips.
   * @param {(p:THREE.Vector3, unit:object)=>boolean} fn true when `p` is visible
   */
  setOccluder(fn) { this.occluder = typeof fn === 'function' ? fn : null; }

  /** The unit the camera is attached to (his own slip is suppressed). */
  setSelf(unit) { this.selfUnit = unit || null; }

  /**
   * How the page annotates units this phase.
   * @param {{filter?:function|null, occlusion?:boolean, lift?:number}} o
   *   `filter(unit)` -> may this unit be annotated at all
   *   `occlusion`    -> cull slips whose soldier is out of sight
   *   `lift`         -> extra screen-space rise above the anchor, in px
   */
  setPolicy({
    filter = null, occlusion = true, lift = 0, tokens = false, marked = null, figures = null,
  } = {}) {
    this.filter = typeof filter === 'function' ? filter : null;
    this.useOcclusion = occlusion !== false;
    this.screenLift = lift || 0;
    this.useTokens = !!tokens;
    this.useFigures = figures === null ? !!tokens : !!figures;
    this.markedUnit = marked || null;
    if (!this.useTokens) {
      for (const t of this.tokens.values()) {
        if (t.el.style.visibility !== 'hidden') t.el.style.visibility = 'hidden';
      }
    }
    if (!this.useFigures) {
      for (const f of this.figures.values()) {
        if (f.el.style.visibility !== 'hidden') f.el.style.visibility = 'hidden';
      }
    }
  }

  // ------------------------------------------------------------------ util

  /**
   * World -> screen. Writes into (and returns) a reused result object:
   * { x, y, depth, visible }. `depth` is distance to camera in metres.
   */
  project(pos, out = this._out) {
    const cam = this.camera;
    if (!cam || !pos) { out.visible = false; return out; }
    this._p.set(pos.x, pos.y, pos.z);
    out.depth = this._p.distanceTo(cam.position);
    this._p.project(cam);
    out.x = (this._p.x * 0.5 + 0.5) * this.w;
    out.y = (-this._p.y * 0.5 + 0.5) * this.h;
    // z outside [-1,1] means behind the near plane / past far
    out.visible = this._p.z > -1 && this._p.z < 1 &&
      out.x > -220 && out.x < this.w + 220 && out.y > -160 && out.y < this.h + 160;
    return out;
  }

  /**
   * How many pixels of page a vehicle's hull actually spans.
   *
   * Sizing armour off `(height / depth)` the way the infantry are sized is
   * wrong twice over: a hull is nearly three times longer than it is tall, and
   * under a map camera the foreshortening depends entirely on whether it is
   * broadside or end-on. Project the four corners of the footprint and measure.
   */
  _vehicleScreenLength(unit) {
    const cam = this.camera;
    if (!cam) return 0;
    const yaw = unit.yaw || 0;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    const HL = 3.1, HW = 1.45, Y = 1.2;         // half-length, half-width, hull mid-height
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      this._pf.set(
        unit.pos.x + s * HL * a + c * HW * b,
        unit.pos.y + Y,
        unit.pos.z + c * HL * a - s * HW * b,
      );
      const o = this.project(this._pf, this._vehOut ||
        (this._vehOut = { x: 0, y: 0, depth: 0, visible: false }));
      if (o.x < minX) minX = o.x; if (o.x > maxX) maxX = o.x;
      if (o.y < minY) minY = o.y; if (o.y > maxY) maxY = o.y;
    }
    return Math.max(maxX - minX, maxY - minY);
  }

  // ------------------------------------------------------------- name tags

  /**
   * Bind a persistent name tag to a unit.
   * @param {object} unit game Unit (needs .pos, .name; .team/.hp optional)
   * @param {{height?:number, maxDist?:number, showHp?:boolean}} [opts]
   */
  track(unit, { height = 2.05, maxDist = 90, showHp = true } = {}) {
    if (!unit || this.tags.has(unit)) return;
    const foe = (unit.team | 0) === 1;
    const name = unit.name || (foe ? 'IMPERIAL' : 'SOLDIER');
    const el = h('div', { class: 'vc-wl vc-nametag' + (foe ? ' foe' : '') });

    // A torn slip of paper with a hand-ruled underline, not a hex-filled box
    // with a 1px border. The deckle is seeded off the name so every soldier's
    // slip is torn differently and no two ever line up.
    const seed = (hashStr(name) ^ 0x51ed) >>> 0;
    const slip = h('div', { class: 'slip' });
    slip.style.clipPath = deckleClip(seed, { perSide: 5, amp: 6 });
    el.appendChild(slip);

    // The allegiance mark, pinned through the left edge of the slip: ours is an
    // indigo pennant, theirs a stamped red lozenge over a hatched ground. The
    // two must be distinguishable in a thumbnail and in monochrome, which two
    // near-identical cream rectangles with slightly different text colour were
    // not.
    const pip = h('div', { class: 'pip' });
    pip.appendChild(foe ? foeMark(seed) : allyMark(seed));
    el.appendChild(pip);

    const t = h('div', { class: 't', text: name });
    el.appendChild(t);
    // the ink rule under the name, drawn
    const rule = inkRule({
      w: 120, seed: seed ^ 0x2f, weight: foe ? 1.35 : 1.0,
      color: foe ? '#7a2822' : '#4a3c2c',
    });
    rule.classList.add('rule');
    el.appendChild(rule);

    let gauge = null;
    if (showHp) {
      // A drawn gauge, not a coloured div: at tag size a flat fill reads as a
      // CSS progress bar hanging in the world.
      gauge = inkGauge({
        w: 96, h: 8, seed: seed ^ 0x77, segs: 4, tone: foe ? 'foe' : 'hp',
      });
      gauge.classList.add('hp');
      el.appendChild(gauge);
    }
    el.style.visibility = 'hidden';
    this.layer.appendChild(el);
    this.tags.set(unit, {
      el, gauge, foe, hpKey: -1, height, maxDist, name: t,
      w: 0, hgt: 0, lane: 0, depth: 0, x: 0, y: 0, show: false,
      seen: true, occT: -1,
    });
  }

  untrack(unit) {
    const t = this.tags.get(unit);
    if (!t) return;
    t.el.remove();
    this.tags.delete(unit);
    const tok = this.tokens.get(unit);
    if (tok) { tok.el.remove(); this.tokens.delete(unit); }
    const fig = this.figures.get(unit);
    if (fig) { fig.el.remove(); this.figures.delete(unit); }
  }

  /** Re-sync the tracked set to a unit list (adds new, drops removed). */
  syncTracked(units, opts) {
    if (!units) return;
    for (const u of units) if (!this.tags.has(u)) this.track(u, opts);
    for (const u of this.tags.keys()) if (!units.includes(u)) this.untrack(u);
  }

  // --------------------------------------------------------- damage popups

  _makeDmg(i) {
    const el = h('div', { class: 'vc-wl vc-dmg' });
    // One drawn piece — blot, flicks and outlined figure together — rather than
    // a bare DOM digit sitting on top of an SVG disc. See icons.js damagePlate.
    const plate = damagePlate({ seed: 101 + i * 37 });
    el.appendChild(plate);
    el.style.visibility = 'hidden';
    this.layer.appendChild(el);
    return {
      el, plate, anchor: new THREE.Vector3(),
      t: 0, life: 0, vx: 0, vy: 0, active: false, crit: false,
    };
  }

  _takeDmg() {
    let oldest = null;
    for (const d of this.dmg) {
      if (!d.active) return d;
      if (!oldest || d.t > oldest.t) oldest = d;
    }
    return oldest;   // recycle the one closest to death
  }

  /**
   * Pop a damage numeral at a world point.
   * @param {THREE.Vector3|{x,y,z}} pos
   * @param {number} amount
   * @param {{crit?:boolean, tag?:string, heal?:boolean, seed?:number}} [opts]
   */
  damage(pos, amount, { crit = false, tag = '', heal = false, seed = 0 } = {}) {
    if (!pos) return;
    const d = this._takeDmg();
    d.anchor.set(pos.x, pos.y, pos.z);
    d.active = true;
    d.t = 0;
    d.crit = crit;
    d.life = crit ? CRIT_LIFE : DMG_LIFE;
    const n = Math.max(0, Math.round(amount));
    d.plate.set((heal ? '+' : '') + n, {
      crit, heal, tagText: tag || (crit ? 'CRITICAL' : ''),
    });
    // A big hit hits the page harder: the plate grows with the number, so eight
    // points and eighty do not read as the same event.
    d.weight = clamp01((n - 4) / 46);
    // Fling direction walks by the golden ratio so stacked hits never overlap.
    this._spin = (this._spin + 0.6180339887) % 1;
    const r = seed ? ((seed >>> 0) % 997) / 997 : this._spin;
    d.vx = (r * 2 - 1) * 110;
    d.vy = -(340 + r * 130);
    d.roll = (r * 2 - 1) * 9;
    d.el.style.visibility = 'hidden';   // shown on the first projected frame
  }

  // -------------------------------------------------------------- banners

  _makeBanner(i) {
    const el = h('div', { class: 'vc-wl vc-banner' });
    el.style.visibility = 'hidden';
    this.layer.appendChild(el);
    return { el, anchor: new THREE.Vector3(), t: 0, life: 0, active: false, rise: 0 };
  }

  /** Shout a word at a world point ("INTERCEPTION FIRE!", "DOWNED"). */
  banner(pos, text, { life = 1.8, color = null, rise = 34 } = {}) {
    if (!pos) return;
    let b = this.banners.find((x) => !x.active);
    if (!b) b = this.banners.reduce((a, x) => (x.t > a.t ? x : a), this.banners[0]);
    b.anchor.set(pos.x, pos.y, pos.z);
    b.el.textContent = text;
    if (color) b.el.style.color = color;
    b.active = true; b.t = 0; b.life = life; b.rise = rise;
    b.el.style.visibility = 'hidden';
  }

  // -------------------------------------------------------- capture rings

  /**
   * Create or update a capture-progress ring over a base camp.
   * @param {string|number} id
   * @param {THREE.Vector3|{x,y,z}} pos
   * @param {{progress?:number, team?:number, label?:string}} opts
   */
  capture(id, pos, { progress = 0, team = 0, label = '' } = {}) {
    let r = this.rings.get(id);
    if (!r) {
      const el = h('div', { class: 'vc-wl vc-ring' });
      const svg = captureRing({ size: 92, progress: 0, team, seed: 63 + (String(id).length * 11) });
      el.appendChild(svg);
      const lab = h('div', {
        class: 'vc-label',
        style: 'text-align:center;margin-top:-.2em;text-shadow:0 1px 2px rgba(40,24,20,.9);color:#f2e5c8',
      });
      el.appendChild(lab);
      el.style.visibility = 'hidden';
      this.layer.appendChild(el);
      r = { el, svg, circle: svg.querySelector('.prog'), anchor: new THREE.Vector3(), lab, prog: -1 };
      this.rings.set(id, r);
    }
    r.anchor.set(pos.x, pos.y, pos.z);
    if (label !== r.lab.textContent) r.lab.textContent = label;
    const p = clamp01(progress);
    if (Math.abs(p - r.prog) > 0.004) {
      r.prog = p;
      const c = r.circle;
      if (c) {
        const circ = parseFloat(c.getAttribute('stroke-dasharray')) || 1;
        c.setAttribute('stroke-dashoffset', (circ * (1 - p)).toFixed(1));
        c.setAttribute('stroke', team === 1 ? '#8d3730' : '#37536f');
      }
    }
    return r;
  }

  clearCapture(id) {
    const r = this.rings.get(id);
    if (r) { r.el.remove(); this.rings.delete(id); }
  }

  clearAllCaptures() {
    for (const id of Array.from(this.rings.keys())) this.clearCapture(id);
  }

  // ------------------------------------------------------------- tag layout

  /**
   * Project, declutter and place every name tag.
   *
   * A squad seen head-on projects into a wall of overlapping slips, which is
   * exactly what the frame must not look like. Nearest tag wins its spot; any
   * tag whose box would collide is lifted a lane at a time, and one that still
   * cannot find room is dropped rather than drawn on top of its neighbour.
   * Tags are also culled to the frame proper — the projection's generous
   * offscreen margin used to leave slips sliced in half by the page edge.
   */
  _updateTags(dt = 0) {
    const out = this._out;
    const order = this._tagOrder || (this._tagOrder = []);
    order.length = 0;

    // Line of sight is re-tested on a clock, not per frame: the answer is a
    // grid raycast and it does not change between two 7 ms frames.
    this._occClock += dt;
    let doOcc = false;
    if (this.occluder && this._occClock >= OCCLUSION_PERIOD) { this._occClock = 0; doOcc = true; }

    for (const [unit, t] of this.tags) {
      t.show = false;
      if (!unit.pos || (unit.alive === false && !unit.downed)) continue;
      if (this.filter && !this.filter(unit)) continue;
      // The camera's own soldier does not wear a slip — but only when the lens
      // is actually ON him. A scripted wide shot of the same phase still wants
      // his name, so the suppression is a distance test, not a flag test.
      if (unit === this.selfUnit && this.camera &&
          Math.abs(unit.pos.x - this.camera.position.x) < 4.5 &&
          Math.abs(unit.pos.z - this.camera.position.z) < 4.5) continue;
      // A foe the section has not spotted is not on the page at all.
      if (t.foe && unit.spotted === false) continue;
      V0.set(unit.pos.x, unit.pos.y + t.height, unit.pos.z);
      this.project(V0, out);
      // Imperials get a slightly shorter leash than the squad — a slip on a man
      // 90 m off is a smudge — but both now reach the whole depth of a firefight.
      const lim = t.foe ? Math.min(t.maxDist, 76) : Math.min(t.maxDist, 88);
      if (!out.visible || out.depth > lim) continue;

      // ---- occlusion ------------------------------------------------------
      // A slip drawn over a man who is behind a house or a stand of poplars is
      // the thing that makes the whole frame read as a sticker sheet: it labels
      // masonry. But ONE ray at chest height calls a soldier invisible the
      // moment a single grass blade or fence post crosses it, which is what
      // stripped the action frames of their entire ally layer. A soldier is
      // visible if ANY of chest / head / hip is: that is what "you can see him"
      // means, and only a man genuinely behind cover fails all three.
      if (doOcc && this.occluder && this.useOcclusion) {
        let vis = false;
        for (let s = 0; s < OCC_SAMPLES.length && !vis; s++) {
          this._occPt.set(unit.pos.x, unit.pos.y + t.height * OCC_SAMPLES[s], unit.pos.z);
          try { vis = !!this.occluder(this._occPt, unit); } catch { vis = true; }
        }
        t.seen = vis;
      }
      if (this.useOcclusion && t.seen === false) continue;

      // Measure once; the slip only changes width when the name changes.
      if (!t.w) { t.w = t.el.offsetWidth || 84; t.hgt = t.el.offsetHeight || 26; }
      const k = 1 - clamp01((out.depth - lim * 0.35) / (lim * 0.65));
      const sc = 0.68 + 0.32 * k;
      const halfW = (t.w * sc) / 2;
      const hgt = t.hgt * sc;
      // Cull to the frame itself, with just enough slack for the deckled edge.
      // The slip is anchored by its BOTTOM edge, so it occupies [y - hgt, y].
      // The top guard is deliberately generous: a slip sliced by the frame rule
      // at the head of the page is worse than no slip at all.
      // A MARKER MAY NOT COVER THE UNIT IT MARKS.
      //
      // Round 7: "the marker card at (1130-1215, 55-105) is drawn OVER its own
      // soldier: the figure's helmet is visible above the card at y=40-55 and
      // its legs below at y=145-165, with the entire torso hidden behind the
      // card stock". The slip is anchored 2.05 m over the man's feet, and in
      // command mode his counter is ALSO up there — two independent layouts
      // competing for the same strip of page. Since the counter is the thing the
      // survey is made of, the slip gives way to it: anchor the slip's bottom
      // edge on the counter's top edge and the intersection is zero by
      // construction. `_updateTokens` runs first for exactly this reason.
      const ownTok = this.useTokens ? this.tokens.get(unit) : null;
      let anchorY = out.y;
      if (ownTok && ownTok.placedStamp === this._tokStamp) {
        anchorY = Math.min(anchorY, ownTok.cy - ownTok.rowH * 0.5 - 5);
      }
      const ay = anchorY - this.screenLift * this.scale;
      if (out.x < halfW + 14 || out.x > this.w - halfW - 14 ||
          ay - hgt < this.h * 0.055 || ay > this.h - 30) continue;
      t.x = out.x; t.y = ay; t.depth = out.depth;
      // Where the soldier's FEET are, so the leader hairline can be run all the
      // way down to him (or, in command mode, onto his counter) instead of
      // stopping in mid air a head above the anchor.
      this._pf.set(unit.pos.x, unit.pos.y, unit.pos.z);
      this.project(this._pf, this._footOut || (this._footOut = { x: 0, y: 0, depth: 0, visible: false }));
      t.anchorY = this._footOut.y;
      t.k = k; t.sc = sc;
      t.halfW = halfW; t.rowH = hgt;
      t.show = true;
      order.push(t);
    }

    // nearest first — the soldier you care about keeps his place on the page
    order.sort((a, b) => a.depth - b.depth);

    // Only the nearest handful of Imperials are annotated, and only a squad's
    // worth of slips in total. Beyond that the page stops being a drawing of a
    // fight and becomes a list of names laid over one.
    let foes = 0;
    for (let i = 0; i < order.length; i++) {
      if (order[i].foe && ++foes > MAX_FOE_TAGS) { order[i].show = false; order.splice(i--, 1); }
    }
    for (let i = MAX_TAGS; i < order.length; i++) order[i].show = false;
    order.length = Math.min(order.length, MAX_TAGS);

    const placed = this._placedTags || (this._placedTags = []);
    placed.length = 0;
    const topGuard = this.h * 0.055;
    for (const t of order) {
      let lane = 0;
      for (; lane < 4; lane++) {
        const top = t.y - t.rowH * (lane + 1) - lane * 3;
        if (top < topGuard) { lane = 99; break; }
        let clash = false;
        for (const p of placed) {
          if (Math.abs(p.cx - t.x) > p.halfW + t.halfW + 6) continue;
          if (Math.abs(p.top - top) < Math.max(p.rowH, t.rowH) * 0.96) { clash = true; break; }
        }
        if (!clash) break;
      }
      // No room without either overlapping a neighbour or running off the top
      // of the page: the slip is simply not drawn. Two half-legible names
      // stacked on each other say less than one.
      if (lane >= 4) { t.show = false; continue; }
      t.lane = lane;
      placed.push({ cx: t.x, halfW: t.halfW, top: t.y - t.rowH * (lane + 1) - lane * 3, rowH: t.rowH });
    }

    for (const [unit, t] of this.tags) {
      const el = t.el;
      if (!t.show) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        continue;
      }
      const lift = t.lane * (t.rowH + 3);
      el.style.visibility = 'visible';
      // Distance fade: the far slips wash out the way a pencil note does under
      // aerial perspective, so the near ones own the reading order.
      el.style.opacity = (0.52 + 0.48 * t.k * t.k).toFixed(2);
      el.style.transform = 'translate(' + t.x.toFixed(1) + 'px,' + (t.y - lift).toFixed(1) +
        'px) translate(-50%,-100%) scale(' + t.sc.toFixed(3) + ')';
      // The leader hairline back down to the soldier the slip belongs to. It is
      // always drawn, and it runs the WHOLE way to his feet — a hairline that
      // stops in mid air over a canopy is exactly the "anchored to nothing"
      // plate the round-2 critic rejected the command frame for.
      const drop = Math.max(7, (t.anchorY || 0) - (t.y - lift));
      el.style.setProperty('--lead', (drop / t.sc).toFixed(1) + 'px');
      if (t.gauge && unit.maxHp) {
        const key = Math.round((unit.hp / unit.maxHp) * 100);
        if (key !== t.hpKey) {
          t.hpKey = key;
          t.gauge.set(Math.max(0, key) / 100,
            key <= 25 ? 'crit' : key <= 55 ? 'warn' : (t.foe ? 'foe' : 'hp'));
        }
      }
    }
  }

  // ------------------------------------------------------------- map tokens

  /**
   * Push a counter onto the survey for every unit the player can see, and turn
   * each one to face the way its soldier is looking. Screen-space facing is read
   * off the projection of a point one metre in front of him, so it stays honest
   * under any camera yaw without the label layer having to know the rig.
   *
   * THE COUNTER STANDS OVER ITS SOLDIER, NOT ON HIM.
   *
   * Round 5 centred the marker on the man's feet. At the command camera a
   * soldier is 40 px tall and the marker is 40 px across, so the marker sat
   * exactly on top of the only thing that proved there was a soldier there — the
   * critic counted eighteen markers and could find a model under two of them,
   * which is not a staging bug, it is the marker eating its own referent. The
   * counter is therefore lifted clear of the man's head in SCREEN space and a
   * leader hairline is dropped from its foot to his boots, so every counter has
   * a visible figure standing under it and the sizes never fight.
   */
  _updateTokens() {
    if (!this.useTokens) return;
    this._tokStamp = (this._tokStamp || 0) + 1;
    const out = this._out;
    const order = this._tokOrder || (this._tokOrder = []);
    order.length = 0;

    for (const [unit, t] of this.tags) {
      let tok = this.tokens.get(unit);
      const live = !!unit.pos && !(unit.alive === false && !unit.downed) &&
        !(t.foe && unit.spotted === false) && unit.deployed !== false;
      if (!live) { if (tok) tok.el.style.visibility = 'hidden'; continue; }

      // Anchor on the CROWN, not the feet: the counter has to clear the figure.
      const hgt = unit.isVehicle ? 2.9 : 1.85;
      V0.set(unit.pos.x, unit.pos.y + hgt, unit.pos.z);
      this.project(V0, out);
      // Counters live on the map, so they hold to a much longer leash than the
      // name slips do — the whole point is that the survey shows the whole force.
      if (!out.visible || out.depth > 220 ||
          out.x < 6 || out.x > this.w - 6 || out.y < 6 || out.y > this.h - 6) {
        if (tok) tok.el.style.visibility = 'hidden';
        continue;
      }
      const hx = out.x, hy = out.y, depth = out.depth;
      // and where his boots are, for the leader
      this._pf.set(unit.pos.x, unit.pos.y, unit.pos.z);
      this.project(this._pf, out);
      const footY = out.y, footX = out.x;
      // How tall the man actually projects. This is the number the whole command
      // frame turns on: round 6 measured it at 24 px and the critic could not
      // find a soldier under sixteen of eighteen markers.
      const projH = Math.max(2, footY - hy);
      // ARMOUR TAKES THE SAME PATH. Round 7 found the Edelweiss — the one object
      // the mode exists to track — was the only unit still rendered as geometry,
      // and at 100 px it came back as "a cream amoeba with NO ink outline". A
      // vehicle is sized off its projected LENGTH rather than its height, since
      // a hull seen end-on is 2.8 m tall and 6.2 m long and only the second
      // number says how much of the page it owns.
      // WHO DRAWS THIS UNIT — asked, not re-derived.
      //
      // CommandMode.syncFigureLod owns the decision: it hides the rig of
      // anything too small to read and this layer draws the symbol in its
      // place. The first cut had both sides computing their own screen-size
      // test, which is a duplicated formula waiting to disagree — and it did,
      // immediately: the infantry gate divides height by depth, the armour one
      // has to project the footprint (a 6.2 m hull at 33 degrees of map pitch
      // foreshortens to 118 px where height/depth predicts 195), so the tank
      // fell down the gap between the two and shipped as neither. Reading
      // `root.visible` instead makes the two agree by construction: a symbol is
      // drawn exactly when there is no model to see. CommandMode.update() runs
      // before the HUD in main.js's system order, so this is the same frame.
      const drawSymbol = this.useFigures && !!unit.root && unit.root.visible === false;
      t.figVeh = false;
      if (drawSymbol && unit.isVehicle) {
        t.figVeh = true;
        // Sized off the real projected footprint: a hull seen end-on owns a
        // third of the page a broadside one does.
        const L = this._vehicleScreenLength(unit);
        t.figW = Math.min(VEH_MAX, Math.max(VEH_MIN, L * 1.25));
        t.figH = t.figW * VEH_ASPECT;
      } else {
        t.figH = drawSymbol
          ? Math.min(FIG_MAX, Math.max(FIG_MIN, projH * FIG_GAIN)) : 0;
      }

      if (!tok) {
        const el = h('div', { class: 'vc-wl vc-token' + (t.foe ? ' foe' : '') });
        el.appendChild(unitCounter(t.foe ? 1 : 0, String(unit.cls || 'scout').toLowerCase(),
          (hashStr(unit.name || 'x') & 0x3ff) + 3, { vehicle: !!unit.isVehicle }));
        this.layer.appendChild(el);
        tok = {
          el, fac: el.querySelector('.fac'), hp: el.querySelector('.hp'),
          hpf: el.querySelector('.hpf'), act: el.querySelector('.act'),
          dwn: el.querySelector('.dwn'), sel: el.querySelector('.sel'),
          isSel: false, hpKey: -1, actKey: null, dwnKey: null,
          hpW: 0,
        };
        if (tok.hpf) tok.hpW = parseFloat(tok.hpf.getAttribute('width')) || 22;
        this.tokens.set(unit, tok);
      }

      // facing: project a point a metre ahead and take the screen angle
      const yaw = unit.aimYaw != null ? unit.aimYaw : (unit.yaw || 0);
      this._pf.set(unit.pos.x + Math.sin(yaw), unit.pos.y + hgt, unit.pos.z + Math.cos(yaw));
      this.project(this._pf, out);
      tok.ang = Math.atan2(out.x - hx, -(out.y - hy)) * 180 / Math.PI;

      // A counter is a piece of card: it is the same size wherever it is on the
      // page, give or take the small perspective courtesy that keeps the far
      // ones from shouting over the near ones.
      tok.sc = clamp01(1.30 - Math.max(0, depth - 30) / 190) * 0.40 + 0.86;
      // Card bottom edge just clears the head of whatever is standing there —
      // the DRAWN figure when there is one, otherwise the rendered crown.
      const crownY = t.figH ? footY - t.figH : hy;
      tok.x = t.figH ? footX : hx;
      tok.y = crownY - 13 * tok.sc;
      tok.footY = footY; tok.crownY = crownY; tok.depth = depth;
      tok.halfW = 27 * tok.sc; tok.rowH = 30 * tok.sc;
      tok.unit = unit; tok.foe = t.foe;
      tok.figH = t.figH; tok.figX = footX; tok.figY = footY;
      tok.figVeh = !!t.figVeh;
      order.push(tok);
    }

    // Declutter. Counters may not be dropped — a survey that hides a platoon is
    // worse than a busy one — so a clashing counter is lifted a lane at a time
    // and its leader grows to follow. Nearest keeps its place.
    order.sort((a, b) => a.depth - b.depth);
    const placed = this._placedToks || (this._placedToks = []);
    placed.length = 0;
    for (const k of order) {
      let lane = 0;
      for (; lane < 5; lane++) {
        const cy = k.y - lane * (k.rowH * 0.80);
        let clash = false;
        for (const q of placed) {
          if (Math.abs(q.cx - k.x) > q.halfW + k.halfW - 3) continue;
          if (Math.abs(q.cy - cy) < (q.rowH + k.rowH) * 0.46) { clash = true; break; }
        }
        if (!clash) break;
      }
      if (lane >= 5) lane = 0;
      k.lane = lane;
      // ...and never above the sheet's own headline. A counter lifted over the
      // running head ("SURVEY SHEET IV — Vasel Crossing") covers the one line
      // that says what the map IS, which is worse than a counter one lane low.
      k.cy = Math.max(this.h * 0.045 + k.rowH * 0.5, k.y - lane * (k.rowH * 0.80));
      k.placedStamp = this._tokStamp;
      placed.push({ cx: k.x, cy: k.cy, halfW: k.halfW, rowH: k.rowH });
    }

    for (const k of order) {
      const unit = k.unit;
      k.el.style.visibility = 'visible';
      k.el.style.transform = 'translate(' + k.x.toFixed(1) + 'px,' + k.cy.toFixed(1) +
        'px) translate(-50%,-50%) scale(' + k.sc.toFixed(3) + ')';
      // The leader hairline down toward the boots the counter belongs to. It is
      // CAPPED: run all the way to a soldier 50 px below and the counter stops
      // being a counter and becomes a signpost on a pole, which is what the
      // first cut of this looked like. Capped at 30 px it reads as the tick a
      // draughtsman puts between a symbol and the thing it labels.
      k.el.style.setProperty('--lead',
        (Math.max(5, Math.min(30, k.crownY - k.cy - 14 * k.sc)) / k.sc).toFixed(1) + 'px');
      if (k.fac) k.fac.setAttribute('transform', 'rotate(' + k.ang.toFixed(1) + ' 26 29)');

      // --- the figure the counter belongs to -------------------------------
      if (k.figH) this._placeFigure(unit, k);

      const isSel = unit === this.markedUnit;
      if (isSel !== k.isSel) {
        k.isSel = isSel;
        k.el.classList.toggle('sel', isSel);
        if (k.sel) k.sel.setAttribute('opacity', isSel ? '1' : '0');
      }
      // spent / down / hurt — the three things a counter must be able to say
      const acted = !!unit.hasActed && !k.foe;
      if (acted !== k.actKey) {
        k.actKey = acted;
        if (k.act) k.act.setAttribute('opacity', acted ? '0.85' : '0');
        k.el.classList.toggle('spent', acted);
      }
      const down = !!unit.downed || unit.alive === false;
      if (down !== k.dwnKey) {
        k.dwnKey = down;
        if (k.dwn) k.dwn.setAttribute('opacity', down ? '0.9' : '0');
      }
      if (unit.maxHp && k.hp) {
        const key = Math.round(clamp01(unit.hp / unit.maxHp) * 20);
        if (key !== k.hpKey) {
          k.hpKey = key;
          k.hp.style.display = key >= 20 ? 'none' : '';
          if (k.hpf) k.hpf.setAttribute('width', (k.hpW * (key / 20)).toFixed(2));
        }
      }
    }

    // Any figure whose counter did not place this frame has nothing standing
    // under it: park it rather than leaving a soldier drawn on stale ground.
    for (const [unit, fig] of this.figures) {
      if (fig.stamp !== this._tokStamp && fig.el.style.visibility !== 'hidden') {
        fig.el.style.visibility = 'hidden';
      }
    }

    // units that vanished from the tracked set
    for (const [unit, tok] of this.tokens) {
      if (!this.tags.has(unit)) { tok.el.remove(); this.tokens.delete(unit); }
    }
    for (const [unit, fig] of this.figures) {
      if (!this.tags.has(unit)) { fig.el.remove(); this.figures.delete(unit); }
    }
  }

  /**
   * Draw (or move) the map symbol for one soldier, standing on his own boots.
   *
   * The figure is anchored by its FEET at the projected ground point and scaled
   * so it reads at map distance — never smaller than FIG_MIN, which is the size
   * below which a silhouette stops being a silhouette. It is mirrored when the
   * man is facing screen-left, so a section reads as a formation with a
   * direction rather than as a row of identical stamps.
   */
  _placeFigure(unit, k) {
    let fig = this.figures.get(unit);
    if (!fig) {
      const foe = (unit.team | 0) === 1;
      const veh = !!k.figVeh;
      const el = h('div', {
        class: 'vc-wl vc-figure' + (foe ? ' foe' : '') + (veh ? ' veh' : ''),
      });
      el.appendChild(veh
        ? fieldVehicle(foe ? 1 : 0, (hashStr(unit.name || 'x') & 0x3ff) + 29)
        : fieldFigure(foe ? 1 : 0, String(unit.cls || 'scout').toLowerCase(),
          (hashStr(unit.name || 'x') & 0x3ff) + 11));
      this.layer.appendChild(el);
      fig = { el, flip: null, stamp: -1, veh };
      this.figures.set(unit, fig);
    }
    fig.stamp = this._tokStamp;
    const sc = k.figH / (fig.veh ? 64 : 76);
    // Facing: `k.ang` is the screen bearing of the man's own aim, 0 = up the page.
    const flip = Math.sin((k.ang || 0) * Math.PI / 180) < -0.12;
    if (flip !== fig.flip) { fig.flip = flip; fig.el.classList.toggle('mirror', flip); }
    fig.el.style.visibility = 'visible';
    fig.el.style.opacity = (k.foe ? 0.94 : 1).toFixed(2);
    fig.el.style.transform = 'translate(' + k.figX.toFixed(1) + 'px,' + k.figY.toFixed(1) +
      'px) translate(-50%,-100%) scale(' + sc.toFixed(3) + ')';
    fig.el.classList.toggle('spent', !!unit.hasActed && !k.foe);
    fig.el.classList.toggle('sel', unit === this.markedUnit);
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    if (!this.camera) return;
    if (++this._resizeCounter > 30) { this._resizeCounter = 0; this.resize(); }
    const s = this.scale;
    const out = this._out;

    // TOKENS FIRST, then the slips. The name-slip layout has to know where each
    // unit's own counter ended up so it can sit clear of it (see _updateTags);
    // running the slips first is what let a marker card eclipse the soldier it
    // was pointing at. _updateTokens reads nothing the slip pass writes.
    this._updateTokens();
    this._updateTags(dt);

    // --- damage numerals
    for (const d of this.dmg) {
      if (!d.active) continue;
      d.t += dt;
      if (d.t >= d.life) {
        d.active = false;
        d.el.style.visibility = 'hidden';
        continue;
      }
      this.project(d.anchor, out);
      if (!out.visible) { d.el.style.visibility = 'hidden'; continue; }
      const t = d.t;
      const ox = d.vx * t * s;
      const oy = (d.vy * t + 0.5 * DMG_GRAV * t * t) * s;
      const pop = easeOutBack(clamp01(t / 0.20));
      const fade = 1 - easeOutCubic(clamp01((t - d.life * 0.62) / (d.life * 0.38)));
      // The plate lands hard and settles — the ink is thrown, it does not float.
      const sc = (d.crit ? 1.0 : 0.74 + 0.34 * (d.weight || 0)) * (0.35 + 0.65 * pop) *
        (1 + 0.10 * Math.sin(t * 14) * Math.max(0, 1 - t * 4)) *
        (0.85 + 0.15 * (this.h / 900));
      d.el.style.visibility = 'visible';
      d.el.style.opacity = fade.toFixed(3);
      d.el.style.transform = 'translate(' + (out.x + ox).toFixed(1) + 'px,' +
        (out.y + oy).toFixed(1) + 'px) translate(-50%,-50%) rotate(' +
        (d.roll || 0).toFixed(1) + 'deg) scale(' + sc.toFixed(3) + ')';
    }

    // --- banners
    for (const b of this.banners) {
      if (!b.active) continue;
      b.t += dt;
      if (b.t >= b.life) { b.active = false; b.el.style.visibility = 'hidden'; continue; }
      this.project(b.anchor, out);
      if (!out.visible) { b.el.style.visibility = 'hidden'; continue; }
      const k = clamp01(b.t / b.life);
      const rise = easeOutCubic(clamp01(b.t / 0.6)) * b.rise * s;
      const pop = easeOutBack(clamp01(b.t / 0.26));
      b.el.style.visibility = 'visible';
      b.el.style.opacity = (k > 0.72 ? 1 - (k - 0.72) / 0.28 : 1).toFixed(3);
      b.el.style.transform = 'translate(' + out.x.toFixed(1) + 'px,' + (out.y - rise).toFixed(1) +
        'px) translate(-50%,-50%) scale(' + (0.5 + 0.5 * pop).toFixed(3) + ')';
    }

    // --- capture rings
    for (const r of this.rings.values()) {
      this.project(r.anchor, out);
      if (!out.visible) { r.el.style.visibility = 'hidden'; continue; }
      const sc = Math.max(0.62, Math.min(1.5, 26 / Math.max(4, out.depth)));
      r.el.style.visibility = 'visible';
      // A far ring shrinks its caption into an illegible smudge that reads as a
      // debug gizmo — drop the caption, and let the ring itself fade back.
      const small = sc < 0.82;
      if (r.small !== small) { r.small = small; r.lab.style.display = small ? 'none' : ''; }
      r.el.style.opacity = clamp01(1.35 - out.depth / 78).toFixed(2);
      r.el.style.transform = 'translate(' + out.x.toFixed(1) + 'px,' + out.y.toFixed(1) +
        'px) translate(-50%,-50%) scale(' + sc.toFixed(3) + ')';
    }
  }

  dispose() {
    for (const t of this.tags.values()) t.el.remove();
    this.tags.clear();
    for (const t of this.tokens.values()) t.el.remove();
    this.tokens.clear();
    for (const f of this.figures.values()) f.el.remove();
    this.figures.clear();
    for (const r of this.rings.values()) r.el.remove();
    this.rings.clear();
    for (const d of this.dmg) d.el.remove();
    for (const b of this.banners) b.el.remove();
    this.dmg.length = 0;
    this.banners.length = 0;
    clear(this.layer);
  }
}
