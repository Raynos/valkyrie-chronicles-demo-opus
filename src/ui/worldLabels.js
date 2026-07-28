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
import { splat, captureRing } from './icons.js';

const DMG_POOL = 28;
const BANNER_POOL = 10;

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
    const el = h('div', { class: 'vc-wl vc-nametag' + (foe ? ' foe' : '') });
    const t = h('div', { class: 't', text: unit.name || (foe ? 'IMPERIAL' : 'SOLDIER') });
    el.appendChild(t);
    let fill = null;
    if (showHp) {
      const bar = h('div', { class: 'hp vc-bar' });
      bar.appendChild(h('div', { class: 'vc-bar-bg' }));
      fill = h('div', { class: 'vc-bar-fill hp' });
      bar.appendChild(fill);
      el.appendChild(bar);
    }
    el.style.visibility = 'hidden';
    this.layer.appendChild(el);
    this.tags.set(unit, { el, fill, hpKey: -1, height, maxDist, name: t });
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

  // ---------------------------------------------------------------- update

  update(dt) {
    if (!this.camera) return;
    if (++this._resizeCounter > 30) { this._resizeCounter = 0; this.resize(); }
    const s = this.scale;
    const out = this._out;

    // --- name tags
    for (const [unit, t] of this.tags) {
      const el = t.el;
      if (!unit.pos || (unit.alive === false && !unit.downed)) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        continue;
      }
      V0.set(unit.pos.x, unit.pos.y + t.height, unit.pos.z);
      this.project(V0, out);
      if (!out.visible || out.depth > t.maxDist) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        continue;
      }
      // Distance falloff: tags shrink and fade so a crowd does not become soup.
      const k = 1 - clamp01((out.depth - t.maxDist * 0.45) / (t.maxDist * 0.55));
      const sc = 0.72 + 0.28 * k;
      el.style.visibility = 'visible';
      el.style.opacity = (0.25 + 0.75 * k).toFixed(2);
      el.style.transform = 'translate(' + out.x.toFixed(1) + 'px,' + out.y.toFixed(1) +
        'px) translate(-50%,-100%) scale(' + sc.toFixed(3) + ')';
      if (t.fill && unit.maxHp) {
        const key = Math.round((unit.hp / unit.maxHp) * 100);
        if (key !== t.hpKey) {
          t.hpKey = key;
          t.fill.style.width = Math.max(0, key) + '%';
          t.fill.classList.toggle('warn', key <= 55 && key > 25);
          t.fill.classList.toggle('crit', key <= 25);
        }
      }
    }

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
      const sc = Math.max(0.45, Math.min(1.5, 22 / Math.max(4, out.depth)));
      r.el.style.visibility = 'visible';
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
