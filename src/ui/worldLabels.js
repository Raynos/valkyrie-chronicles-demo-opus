// src/ui/worldLabels.js
// Everything that lives at a world position but is drawn as crisp DOM: unit name
// tags, damage numerals, shout banners and base-capture rings.
//
// Per-frame cost is bounded: every element is pooled, no DOM is created after
// warm-up, no vectors are allocated in update(), and elements that fall behind
// the camera are parked with visibility:hidden rather than re-laid-out.

import * as THREE from 'three';
import { V0, clamp01, easeOutBack, easeOutCubic } from '../core/math.js';
import { h, clear } from './dom.js';
import { splat, captureRing, inkRule, inkGauge } from './icons.js';
import { deckleClip } from './style.js';

const DMG_POOL = 28;
const BANNER_POOL = 10;
// How many Imperial name slips may be on the page at once (nearest win).
const MAX_FOE_TAGS = 5;

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
    this.rings = new Map();     // id   -> { el, anchor, circle, progress }

    this._p = new THREE.Vector3();
    this._out = { x: 0, y: 0, depth: 0, visible: false };

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

    const t = h('div', { class: 't', text: name });
    el.appendChild(t);
    // the ink rule under the name, drawn
    const rule = inkRule({
      w: 120, seed: seed ^ 0x2f, weight: 1.1,
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
    });
  }

  untrack(unit) {
    const t = this.tags.get(unit);
    if (!t) return;
    t.el.remove();
    this.tags.delete(unit);
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
    const sp = splat({ size: 78, seed: 101 + i * 37, color: '#7c2028', opacity: 0.8 });
    sp.classList.add('splat');
    const n = h('div', { class: 'n vc-num' });
    const tag = h('div', { class: 'tag' });
    el.appendChild(sp); el.appendChild(n); el.appendChild(tag);
    el.style.visibility = 'hidden';
    this.layer.appendChild(el);
    return {
      el, n, tag, splat: sp, anchor: new THREE.Vector3(),
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
    d.n.textContent = (heal ? '+' : '') + Math.max(0, Math.round(amount));
    d.tag.textContent = tag || (crit ? 'CRITICAL!' : '');
    d.el.classList.toggle('crit', !!crit);
    // Fling direction walks by the golden ratio so stacked hits never overlap.
    this._spin = (this._spin + 0.6180339887) % 1;
    const r = seed ? ((seed >>> 0) % 997) / 997 : this._spin;
    d.vx = (r * 2 - 1) * 110;
    d.vy = -(340 + r * 130);
    d.splat.style.opacity = heal ? '0.35' : (crit ? '1' : '0.8');
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
  _updateTags() {
    const out = this._out;
    const order = this._tagOrder || (this._tagOrder = []);
    order.length = 0;

    for (const [unit, t] of this.tags) {
      t.show = false;
      if (!unit.pos || (unit.alive === false && !unit.downed)) continue;
      V0.set(unit.pos.x, unit.pos.y + t.height, unit.pos.z);
      this.project(V0, out);
      // Imperials get a shorter leash than the squad: a slip on every enemy on
      // the far bank turns the sky into a wall of paper.
      const lim = t.foe ? Math.min(t.maxDist, 62) : t.maxDist;
      if (!out.visible || out.depth > lim) continue;
      // Measure once; the slip only changes width when the name changes.
      if (!t.w) { t.w = t.el.offsetWidth || 84; t.hgt = t.el.offsetHeight || 26; }
      const k = 1 - clamp01((out.depth - t.maxDist * 0.45) / (t.maxDist * 0.55));
      const sc = 0.72 + 0.28 * k;
      const halfW = (t.w * sc) / 2;
      const hgt = t.hgt * sc;
      // Cull to the frame itself, with just enough slack for the deckled edge.
      // The slip is anchored by its BOTTOM edge, so it occupies [y - hgt, y].
      if (out.x < halfW + 12 || out.x > this.w - halfW - 12 ||
          out.y - hgt < 14 || out.y > this.h - 30) continue;
      t.x = out.x; t.y = out.y; t.depth = out.depth; t.k = k; t.sc = sc;
      t.halfW = halfW; t.rowH = hgt;
      t.show = true;
      order.push(t);
    }

    // nearest first — the soldier you care about keeps his place on the page
    order.sort((a, b) => a.depth - b.depth);

    // Only the nearest handful of Imperials are annotated. Beyond that the page
    // stops being a map of the fight and becomes a list.
    let foes = 0;
    for (let i = 0; i < order.length; i++) {
      if (!order[i].foe) continue;
      if (++foes > MAX_FOE_TAGS) { order[i].show = false; order.splice(i--, 1); }
    }

    const placed = this._placedTags || (this._placedTags = []);
    placed.length = 0;
    for (const t of order) {
      let lane = 0;
      for (; lane < 3; lane++) {
        const top = t.y - t.rowH * (lane + 1) - lane * 2;
        let clash = false;
        for (const p of placed) {
          if (Math.abs(p.cx - t.x) > p.halfW + t.halfW + 4) continue;
          if (Math.abs(p.top - top) < Math.max(p.rowH, t.rowH) * 0.92) { clash = true; break; }
        }
        if (!clash) break;
      }
      if (lane >= 3) { t.show = false; continue; }
      // Lifting must never push a slip off the top of the page — better to sit
      // at lane 0 (or vanish) than to be drawn sliced by the frame edge.
      while (lane > 0 && t.y - lane * (t.rowH + 2) - t.rowH < 14) lane--;
      if (t.y - t.rowH < 14) { t.show = false; continue; }
      t.lane = lane;
      placed.push({ cx: t.x, halfW: t.halfW, top: t.y - t.rowH * (lane + 1) - lane * 2, rowH: t.rowH });
    }

    for (const [unit, t] of this.tags) {
      const el = t.el;
      if (!t.show) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        continue;
      }
      const lift = t.lane * (t.rowH + 2);
      el.style.visibility = 'visible';
      el.style.opacity = (0.3 + 0.7 * t.k).toFixed(2);
      el.style.transform = 'translate(' + t.x.toFixed(1) + 'px,' + (t.y - lift).toFixed(1) +
        'px) translate(-50%,-100%) scale(' + t.sc.toFixed(3) + ')';
      // A leader line back down to the soldier, once the slip has been lifted.
      el.classList.toggle('lifted', t.lane > 0);
      if (t.lane > 0) el.style.setProperty('--lead', lift.toFixed(1) + 'px');
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

  // ---------------------------------------------------------------- update

  update(dt) {
    if (!this.camera) return;
    if (++this._resizeCounter > 30) { this._resizeCounter = 0; this.resize(); }
    const s = this.scale;
    const out = this._out;

    this._updateTags();

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
      const sc = (d.crit ? 1.0 : 0.9) * (0.35 + 0.65 * pop) *
        (1 + 0.10 * Math.sin(t * 14) * Math.max(0, 1 - t * 4));
      d.el.style.visibility = 'visible';
      d.el.style.opacity = fade.toFixed(3);
      d.el.style.transform = 'translate(' + (out.x + ox).toFixed(1) + 'px,' +
        (out.y + oy).toFixed(1) + 'px) translate(-50%,-50%) scale(' + sc.toFixed(3) + ')';
      // the splat lands first and stops growing — ink does not bounce
      d.splat.style.transform = 'translate(-50%,-50%) scale(' +
        (0.6 + 0.7 * easeOutCubic(clamp01(t / 0.28))).toFixed(3) + ')';
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
    for (const r of this.rings.values()) r.el.remove();
    this.rings.clear();
    for (const d of this.dmg) d.el.remove();
    for (const b of this.banners) b.el.remove();
    this.dmg.length = 0;
    this.banners.length = 0;
    clear(this.layer);
  }
}
