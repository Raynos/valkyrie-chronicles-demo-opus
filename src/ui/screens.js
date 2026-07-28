// src/ui/screens.js
// The full-page "spreads" of the field journal: chapter title, briefing,
// deployment, results, pause/options, and the dialogue bar.
//
// Each screen owns its DOM, builds lazily on first show, and is inert (display:none)
// when hidden so it costs nothing. None of them touch game state — they take a
// plain data object in and hand a plain result back through a callback.

import { Bus } from '../core/bus.js';
import { h, clear, panel, clickable, label, typewriter, roman, numberWord, pad, replay } from './dom.js';
import {
  icon, inkRule, ribbon, chapterVignette, terrainSketch, rankStamp, keyCap, compassRose,
} from './icons.js';
import { portrait, portraitMarkup } from './portraits.js';
import { reducedMotion } from './style.js';

// --------------------------------------------------------------------------

/** A red ribbon button. Returns the element; `setEnabled` hangs off it. */
export function ribbonButton(text, onClick, { w = 15, key = '', seed = 21 } = {}) {
  const root = h('div', { class: 'vc-rbtn', style: { width: w + 'em' } });
  root.appendChild(ribbon({ w: 240, h: 58, seed }));
  const t = h('div', { class: 'vc-rbtn-t' });
  t.appendChild(h('span', { text }));
  if (key) {
    const cap = h('span', { class: 'vc-key' });
    cap.appendChild(keyCap(key, { seed: seed + 41, color: '#fbf2dd' }));
    t.appendChild(cap);
  }
  root.appendChild(t);
  clickable(root, () => { if (!root.classList.contains('off')) onClick?.(); });
  root.setEnabled = (on) => root.classList.toggle('off', !on);
  return root;
}

function statRow(k, v, cls = '') {
  return h('div', { class: 'vc-stat ' + cls }, label(k), h('b', { class: 'vc-num', text: String(v) }));
}

const OBJ_ICON = { capture: 'flag', defend: 'shield', kill: 'swords', escort: 'boot', survive: 'clock' };

const CLASS_NAME = {
  scout: 'Scout', shock: 'Shocktrooper', shocktrooper: 'Shocktrooper', lancer: 'Lancer',
  engineer: 'Engineer', sniper: 'Sniper', tank: 'Tank',
};

// --------------------------------------------------------------------------
// Chapter title card — turns in like a page, dwells, turns out.
// --------------------------------------------------------------------------

export class ChapterCard {
  constructor(host) {
    this.host = host;
    this.root = h('div', { class: 'vc-chapter vc-hidden' });
    this.host.appendChild(this.root);
    this._timers = [];
    this.visible = false;
  }

  /**
   * @param {{chapter?:number, title?:string, subtitle?:string, place?:string,
   *          seed?:number, dwell?:number, onDone?:Function}} d
   */
  show(d = {}) {
    this._clearTimers();
    clear(this.root);
    const seed = d.seed || 404;
    this.root.appendChild(h('div', { class: 'vc-scrim' }));
    const p = panel({ seed, cls: '', tilt: 0.25, under: true, amp: 1.15 });
    p.paper.style.filter =
      'url(#vc-deckle) drop-shadow(0 3px 0 rgba(58,47,51,.16)) drop-shadow(0 16px 34px rgba(40,30,34,.55))';
    const inner = h('div', { class: 'vc-chapter-in' });
    // `chapter` may be a number (4) or an authored string ('Chapter 4').
    const chapterLine = typeof d.chapter === 'string' ? d.chapter
      : 'Chapter ' + (d.chapter != null ? numberWord(d.chapter) : 'One');
    inner.appendChild(h('div', { class: 'vc-chapter-num', text: chapterLine }));
    inner.appendChild(h('div', { class: 'vc-h1 vc-it', text: d.title || 'An Unwritten Page' }));
    if (d.place) inner.appendChild(h('div', { class: 'vc-label', style: 'margin-top:.5em', text: d.place }));
    const ill = h('div', { class: 'vc-chapter-ill' });
    ill.appendChild(chapterVignette({ w: 480, h: 150, seed: seed + 17 }));
    inner.appendChild(ill);
    inner.appendChild(inkRule({ w: 420, seed: seed + 3, flourish: true }));
    if (d.subtitle) {
      inner.appendChild(h('div', {
        class: 'vc-body', style: 'margin-top:.7em;max-width:34em;margin-left:auto;margin-right:auto',
        text: d.subtitle,
      }));
    }
    p.content.appendChild(inner);
    this.root.appendChild(p.root);

    this.root.classList.remove('vc-hidden', 'out');
    replay(this.root, 'in');
    this.visible = true;

    const dwell = d.dwell != null ? d.dwell : (reducedMotion() ? 1800 : 3400);
    this._timers.push(setTimeout(() => {
      this.root.classList.remove('in');
      this.root.classList.add('out');
      this._timers.push(setTimeout(() => { this.hide(); d.onDone?.(); }, reducedMotion() ? 220 : 800));
    }, dwell));
  }

  hide() {
    this._clearTimers();
    this.root.classList.add('vc-hidden');
    this.root.classList.remove('in', 'out');
    this.visible = false;
  }

  _clearTimers() { for (const t of this._timers) clearTimeout(t); this._timers.length = 0; }
  dispose() { this._clearTimers(); this.root.remove(); }
}

// --------------------------------------------------------------------------
// Briefing — map illustration, objectives, deployment roll
// --------------------------------------------------------------------------

export class BriefingScreen {
  constructor(host, { onBegin = null } = {}) {
    this.host = host;
    this.onBegin = onBegin;
    this.root = h('div', { class: 'vc-screen vc-hidden' });
    this.host.appendChild(this.root);
    this.visible = false;
  }

  /**
   * @param {{chapter?:number, title?:string, brief?:string, seed?:number,
   *          objectives?:Array, squad?:Array, intel?:Array}} d
   */
  show(d = {}) {
    clear(this.root);
    const seed = d.seed || 1234;
    this.root.appendChild(h('div', { class: 'vc-scrim' }));

    const p = panel({ seed, cls: 'vc-page', tilt: 0.2, under: true, amp: 0.7 });
    const in_ = h('div', { class: 'vc-page-in' });

    // masthead
    const head = h('div', { style: 'display:flex;align-items:flex-end;justify-content:space-between;gap:2em' });
    const chapterLine = typeof d.chapter === 'string' ? d.chapter
      : 'Chapter ' + roman(d.chapter || 1);
    head.appendChild(h('div', null,
      label('Operational Briefing — ' + chapterLine),
      h('div', { class: 'vc-h2 vc-it', text: d.title || 'The Bridge at Vasel' })));
    head.appendChild(h('div', { class: 'vc-label', text: d.date || 'EW 1935 · Squad 7' }));
    in_.appendChild(head);
    in_.appendChild(inkRule({ w: 900, seed: seed + 1 }));

    const cols = h('div', { class: 'vc-cols', style: 'margin-top:.9em' });

    // left: map
    const mapWrap = h('div');
    mapWrap.appendChild(label('Theatre Map'));
    const mapBox = h('div', {
      style: 'position:relative;width:100%;aspect-ratio:4/3;margin-top:.3em;background:rgba(238,226,199,.5)',
    });
    mapBox.appendChild(terrainSketch({ w: 400, h: 300, seed }));
    const pins = h('div', { style: 'position:absolute;inset:0' });
    for (const m of (d.markers || defaultMarkers())) {
      const pin = h('div', {
        style: 'position:absolute;left:' + (m.x * 100) + '%;top:' + (m.y * 100) +
          '%;transform:translate(-50%,-100%);text-align:center;color:' +
          (m.team === 1 ? '#8d3730' : m.team === 0 ? '#37536f' : '#4a3c2c'),
      });
      pin.appendChild(icon(OBJ_ICON[m.type] || 'pin', { size: 22, width: 1.6, rough: true }));
      if (m.label) pin.appendChild(h('div', { class: 'vc-label vc-tight', style: 'font-size:.56em', text: m.label }));
      pins.appendChild(pin);
    }
    mapBox.appendChild(pins);
    // North rose — the theatre map is the same north-up survey as the in-play
    // one (north is -Z, per src/world/layout.js), so it says so the same way.
    const rose = h('div', {
      style: 'position:absolute;right:.6em;top:.6em;width:3.4em;height:3.4em;opacity:.8',
    });
    rose.appendChild(compassRose({ size: 52 }));
    mapBox.appendChild(rose);
    mapWrap.appendChild(mapBox);
    if (d.brief) mapWrap.appendChild(h('div', { class: 'vc-body', style: 'margin-top:.6em', text: d.brief }));
    cols.appendChild(mapWrap);

    // right: objectives + squad
    const right = h('div');
    right.appendChild(label('Objectives'));
    const list = h('div', { class: 'vc-obj-list', style: 'margin-top:.35em' });
    for (const o of (d.objectives || [{ type: 'capture', text: 'Seize the enemy base camp.' }])) {
      const row = h('div', { class: 'vc-obj-item' });
      row.appendChild(icon(OBJ_ICON[o.type] || 'pin', { size: 22, width: 1.6, rough: true }));
      row.appendChild(h('div', null,
        h('div', { class: o.sub ? 'vc-body' : '', text: o.text }),
        o.note ? h('div', { class: 'vc-body vc-dim', style: 'font-size:.78em', text: o.note }) : null));
      list.appendChild(row);
    }
    right.appendChild(list);

    if (d.intel && d.intel.length) {
      right.appendChild(h('div', { style: 'margin-top:.9em' }, label('Intelligence')));
      for (const line of d.intel) {
        right.appendChild(h('div', { class: 'vc-body', style: 'margin-top:.2em', text: '— ' + line }));
      }
    }

    right.appendChild(h('div', { style: 'margin-top:.9em' }, label('Squad Roll')));
    const squad = h('div', { class: 'vc-squad', style: 'margin-top:.35em' });
    for (const u of (d.squad || [])) squad.appendChild(squadChip(u));
    right.appendChild(squad);
    cols.appendChild(right);

    in_.appendChild(cols);

    const row = h('div', { class: 'vc-btnrow' });
    row.appendChild(ribbonButton(d.beginText || 'Begin Mission', () => {
      this.hide();
      this.onBegin?.();
      Bus.emit('ui:briefingDone', {});
    }, { w: 15, key: 'Enter', seed: seed + 9 }));
    in_.appendChild(row);

    p.content.appendChild(in_);
    this.root.appendChild(p.root);
    this.root.classList.remove('vc-hidden');
    this.visible = true;
  }

  hide() { this.root.classList.add('vc-hidden'); this.visible = false; }
  dispose() { this.root.remove(); }
}

function defaultMarkers() {
  return [
    { x: 0.16, y: 0.78, type: 'capture', team: 0, label: 'Base' },
    { x: 0.82, y: 0.24, type: 'capture', team: 1, label: 'Enemy' },
    { x: 0.52, y: 0.50, type: 'defend', label: 'Bridge' },
  ];
}

function squadChip(u, { onClick = null, size = 6.4 } = {}) {
  const seed = (u && (u.portraitSeed || (u.name || 'x').length * 977)) || 7;
  const p = panel({ seed: seed + 5, cls: 'vc-chip', tilt: 1.4, amp: 1.4, soft: true });
  p.root.style.width = size + 'em';
  const in_ = h('div', { class: 'vc-chip-in' });
  const por = portrait({
    seed: u?.portraitSeed != null ? u.portraitSeed : (u?.name || 'soldier'),
    cls: u?.cls || 'scout', team: u?.team | 0, w: 100,
    mood: u && u.alive === false ? 'down' : 'calm',
  });
  por.classList.add('por');
  in_.appendChild(por);
  in_.appendChild(h('div', { class: 'vc-chip-n', text: (u?.name || 'Soldier') }));
  in_.appendChild(h('div', {
    class: 'vc-label vc-tight', style: 'font-size:.52em',
    text: CLASS_NAME[String(u?.cls || 'scout').toLowerCase()] || 'Scout',
  }));
  p.content.appendChild(in_);
  if (onClick) clickable(p.root, () => onClick(u, p.root));
  p.root._unit = u;
  return p.root;
}

// --------------------------------------------------------------------------
// Deployment — assign squad members to base camps
// --------------------------------------------------------------------------

export class DeploymentScreen {
  constructor(host, { onConfirm = null } = {}) {
    this.host = host;
    this.onConfirm = onConfirm;
    this.root = h('div', { class: 'vc-screen vc-hidden' });
    this.host.appendChild(this.root);
    this.visible = false;
    this.assign = new Map();     // campId -> unit[]
    this.activeCamp = null;
  }

  /**
   * @param {{camps?:Array<{id,name,slots}>, squad?:Array, seed?:number,
   *          title?:string, minDeploy?:number}} d
   */
  show(d = {}) {
    this.data = d;
    this.assign = new Map();
    this.camps = d.camps && d.camps.length ? d.camps
      : [{ id: 'base', name: 'Base Camp', slots: 6 }];
    for (const c of this.camps) this.assign.set(c.id, []);
    this.activeCamp = this.camps[0].id;
    this.squad = (d.squad || []).filter((u) => !u || u.alive !== false);
    this.minDeploy = d.minDeploy != null ? d.minDeploy : 1;
    this._build();
    this.root.classList.remove('vc-hidden');
    this.visible = true;
  }

  _build() {
    clear(this.root);
    const seed = this.data.seed || 5150;
    this.root.appendChild(h('div', { class: 'vc-scrim' }));
    const p = panel({ seed, cls: 'vc-page', tilt: 0.2, under: true, amp: 0.7 });
    const in_ = h('div', { class: 'vc-page-in' });
    in_.appendChild(label('Deployment'));
    in_.appendChild(h('div', { class: 'vc-h2 vc-it', text: this.data.title || 'Order of Battle' }));
    in_.appendChild(inkRule({ w: 900, seed: seed + 1 }));
    in_.appendChild(h('div', {
      class: 'vc-body', style: 'margin-top:.5em',
      text: 'Choose a camp, then tap a soldier to post them there. Tap again to withdraw.',
    }));

    // camps
    const camps = h('div', { class: 'vc-camps', style: 'margin-top:.9em' });
    this._campEls = new Map();
    for (const c of this.camps) {
      const cp = panel({ seed: seed + c.id.length * 31, cls: 'vc-camp', tilt: 0.4, amp: 1.0, soft: true });
      const head = h('div', { class: 'vc-camp-h' });
      head.appendChild(icon('camp', { size: 20, width: 1.6 }));
      head.appendChild(h('div', { class: 'vc-h3', text: c.name || c.id }));
      head.appendChild(h('div', {
        class: 'vc-label', style: 'margin-left:auto',
        text: '0 / ' + (c.slots || 6),
      }));
      cp.content.appendChild(head);
      const slots = h('div', { class: 'vc-slots' });
      cp.content.appendChild(slots);
      clickable(cp.root, () => { this.activeCamp = c.id; this._refresh(); });
      this._campEls.set(c.id, { root: cp.root, slots, count: head.lastChild });
      camps.appendChild(cp.root);
    }
    in_.appendChild(camps);

    // roster
    in_.appendChild(h('div', { style: 'margin-top:1.0em' }, label('Available')));
    this._squadWrap = h('div', { class: 'vc-squad', style: 'margin-top:.35em' });
    in_.appendChild(this._squadWrap);

    const row = h('div', { class: 'vc-btnrow' });
    this._btn = ribbonButton('Deploy', () => this._confirm(), { w: 13, key: 'Enter', seed: seed + 9 });
    row.appendChild(this._btn);
    in_.appendChild(row);

    p.content.appendChild(in_);
    this.root.appendChild(p.root);
    this._refresh();
  }

  _refresh() {
    // squad chips: available ones only
    const placed = new Set();
    for (const arr of this.assign.values()) for (const u of arr) placed.add(u);
    clear(this._squadWrap);
    for (const u of this.squad) {
      if (placed.has(u)) continue;
      this._squadWrap.appendChild(squadChip(u, { onClick: (unit) => this._place(unit) }));
    }
    for (const c of this.camps) {
      const e = this._campEls.get(c.id);
      const arr = this.assign.get(c.id);
      e.root.classList.toggle('on', this.activeCamp === c.id);
      e.count.textContent = arr.length + ' / ' + (c.slots || 6);
      clear(e.slots);
      for (const u of arr) {
        e.slots.appendChild(squadChip(u, { onClick: (unit) => this._remove(unit), size: 5.0 }));
      }
    }
    let total = 0;
    for (const arr of this.assign.values()) total += arr.length;
    this._btn.setEnabled(total >= this.minDeploy);
  }

  _place(unit) {
    const camp = this.camps.find((c) => c.id === this.activeCamp) || this.camps[0];
    const arr = this.assign.get(camp.id);
    if (arr.length >= (camp.slots || 6)) return;
    arr.push(unit);
    this._refresh();
    Bus.emit('sfx', { name: 'ui_place' });
  }

  _remove(unit) {
    for (const arr of this.assign.values()) {
      const i = arr.indexOf(unit);
      if (i >= 0) { arr.splice(i, 1); break; }
    }
    this._refresh();
  }

  _confirm() {
    const out = {};
    for (const [k, v] of this.assign) out[k] = v.slice();
    this.hide();
    this.onConfirm?.(out);
    Bus.emit('ui:deployConfirm', { assignments: out });
  }

  hide() { this.root.classList.add('vc-hidden'); this.visible = false; }
  dispose() { this.root.remove(); }
}

// --------------------------------------------------------------------------
// Results — the rank stamp slams down
// --------------------------------------------------------------------------

export class ResultsScreen {
  constructor(host, { onContinue = null } = {}) {
    this.host = host;
    this.onContinue = onContinue;
    this.root = h('div', { class: 'vc-screen vc-hidden' });
    this.host.appendChild(this.root);
    this.visible = false;
    this._timers = [];
  }

  /**
   * @param {{victory?:boolean, rank?:string, turns?:number, dp?:number, exp?:number,
   *          casualties?:Array, stats?:object, seed?:number, title?:string}} d
   */
  show(d = {}) {
    this._clear();
    clear(this.root);
    const seed = d.seed || 777;
    const victory = d.victory !== false;
    const rank = d.rank || rankFor(d);
    this.root.appendChild(h('div', { class: 'vc-scrim' }));

    const p = panel({ seed, cls: 'vc-page', tilt: 0.25, under: true, amp: 0.7 });
    p.root.style.width = 'min(56em, 82vw)';
    const in_ = h('div', { class: 'vc-page-in' });
    in_.appendChild(label(victory ? 'Mission Report — Success' : 'Mission Report — Withdrawal'));
    in_.appendChild(h('div', {
      class: 'vc-h2 vc-it', text: d.title || (victory ? 'The Field is Ours' : 'A Costly Retreat'),
    }));
    in_.appendChild(inkRule({ w: 760, seed: seed + 1, flourish: true }));

    const cols = h('div', { class: 'vc-cols', style: 'margin-top:1.0em;grid-template-columns:1fr 1.1fr' });

    // rank stamp
    const left = h('div', { style: 'display:flex;flex-direction:column;align-items:center' });
    const stamp = h('div', { class: 'vc-result-rank' });
    stamp.appendChild(rankStamp({ size: 180, seed: seed + 3, color: victory ? '#77202a' : '#4a4038' }));
    stamp.appendChild(h('div', { class: 'letter', text: rank }));
    left.appendChild(stamp);
    left.appendChild(h('div', { class: 'vc-label', style: 'margin-top:.6em', text: 'Evaluation' }));
    cols.appendChild(left);

    // stats
    const right = h('div');
    const stats = h('div', { class: 'vc-stats' });
    const rows = [
      ['Turns Used', pad(d.turns || 1)],
      ['Ducats Earned', String(d.dp != null ? d.dp : 0)],
      ['Experience', String(d.exp != null ? d.exp : 0)],
    ];
    const S = d.stats || {};
    if (S.kills != null) rows.push(['Enemies Routed', String(S.kills)]);
    const camps = S.campsTaken != null ? S.campsTaken : S.captured;
    if (camps != null) rows.push(['Camps Taken', String(camps)]);
    if (S.damageDealt != null) rows.push(['Damage Dealt', String(Math.round(S.damageDealt))]);
    if (S.ordersUsed != null) rows.push(['Orders Issued', String(S.ordersUsed)]);
    if (S.rescued) rows.push(['Comrades Rescued', String(S.rescued)]);
    if (S.shots != null && S.hits != null) {
      rows.push(['Accuracy', Math.round((S.hits / Math.max(1, S.shots)) * 100) + '%']);
    }
    for (const [k, v] of rows) stats.appendChild(statRow(k, v, 'late'));
    right.appendChild(stats);

    const cas = d.casualties || [];
    right.appendChild(h('div', { style: 'margin-top:1.0em' },
      label(cas.length ? 'Casualties' : 'No Casualties')));
    if (cas.length) {
      const wrap = h('div', { class: 'vc-body', style: 'margin-top:.25em' });
      for (const c of cas) {
        const nm = typeof c === 'string' ? c : (c.name || 'Unknown');
        const row = h('div', { style: 'display:flex;align-items:center;gap:.4em;opacity:.85' });
        row.appendChild(icon('skull', { size: 15, width: 1.5 }));
        row.appendChild(h('span', { text: nm }));
        wrap.appendChild(row);
      }
      right.appendChild(wrap);
    }
    cols.appendChild(right);
    in_.appendChild(cols);

    const row = h('div', { class: 'vc-btnrow' });
    row.appendChild(ribbonButton('Close the Book', () => {
      this.hide(); this.onContinue?.();
    }, { w: 15, key: 'Enter', seed: seed + 11 }));
    in_.appendChild(row);

    p.content.appendChild(in_);
    this.root.appendChild(p.root);
    this.root.classList.remove('vc-hidden');
    this.visible = true;

    // stagger: the stamp lands, then the ledger fills in line by line
    const rm = reducedMotion();
    this._timers.push(setTimeout(() => {
      stamp.classList.add('slam');
      Bus.emit('sfx', { name: 'ui_stamp', vol: 0.9 });
    }, rm ? 20 : 420));
    const lines = stats.querySelectorAll('.vc-stat');
    lines.forEach((el, i) => {
      el.style.opacity = '0';
      this._timers.push(setTimeout(() => {
        el.style.opacity = '';
        el.style.animationDelay = '0s';
        replay(el, 'late');
      }, (rm ? 30 : 780) + i * (rm ? 10 : 130)));
    });
  }

  hide() { this._clear(); this.root.classList.add('vc-hidden'); this.visible = false; }
  _clear() { for (const t of this._timers) clearTimeout(t); this._timers.length = 0; }
  dispose() { this._clear(); this.root.remove(); }
}

/** Fallback grading when the game does not supply a rank. */
export function rankFor({ turns = 5, victory = true, stats = {} } = {}) {
  if (!victory) return 'D';
  const t = Math.max(1, turns);
  const casualties = (stats.casualties || 0);
  const score = 30 / t - casualties * 1.2;
  return score >= 9 ? 'A' : score >= 5 ? 'B' : score >= 2 ? 'C' : 'D';
}

// --------------------------------------------------------------------------
// Pause / options
// --------------------------------------------------------------------------

const DEFAULT_OPTIONS = [
  { key: 'quality', name: 'Render Quality', values: ['Low', 'High', 'Ultra'], index: 2 },
  { key: 'motion', name: 'Flourishes', values: ['Reduced', 'Full'], index: 1 },
  { key: 'grain', name: 'Paper Grain', values: ['Off', 'Subtle', 'Full'], index: 2 },
  { key: 'music', name: 'Music', values: ['Off', 'Quiet', 'Normal', 'Loud'], index: 2 },
  { key: 'sfx', name: 'Effects', values: ['Off', 'Quiet', 'Normal', 'Loud'], index: 2 },
  { key: 'invertY', name: 'Invert Aim', values: ['No', 'Yes'], index: 0 },
];

export class PauseMenu {
  constructor(host, { onResume = null, onOption = null, onRestart = null } = {}) {
    this.host = host;
    this.onResume = onResume;
    this.onOption = onOption;
    this.onRestart = onRestart;
    this.root = h('div', { class: 'vc-screen vc-hidden' });
    this.host.appendChild(this.root);
    this.visible = false;
    this.options = DEFAULT_OPTIONS.map((o) => ({ ...o }));
    if (reducedMotion()) {
      const m = this.options.find((o) => o.key === 'motion');
      if (m) m.index = 0;
    }
    this._built = false;
  }

  toggle() { this.visible ? this.hide() : this.show(); }

  show() {
    if (!this._built) { this._build(); this._built = true; }
    this._refresh();
    this.root.classList.remove('vc-hidden');
    this.visible = true;
  }

  hide() { this.root.classList.add('vc-hidden'); this.visible = false; }

  _build() {
    clear(this.root);
    this.root.appendChild(h('div', { class: 'vc-scrim' }));
    const p = panel({ seed: 3131, cls: 'vc-page', tilt: 0.2, under: true, amp: 0.8 });
    p.root.style.width = 'min(40em, 74vw)';
    const in_ = h('div', { class: 'vc-page-in' });
    in_.appendChild(label('The Book is Closed'));
    in_.appendChild(h('div', { class: 'vc-h2 vc-it', text: 'Paused' }));
    in_.appendChild(inkRule({ w: 520, seed: 44 }));

    const menu = h('div', { class: 'vc-menu' });
    this._rows = [];
    for (const o of this.options) {
      const row = h('div', { class: 'vc-mi' });
      row.appendChild(h('div', { class: 'k', text: o.name }));
      const v = h('div', { class: 'v' });
      row.appendChild(v);
      clickable(row, () => {
        o.index = (o.index + 1) % o.values.length;
        v.textContent = o.values[o.index];
        this.onOption?.(o.key, o.values[o.index], o.index);
        Bus.emit('ui:option', { key: o.key, value: o.values[o.index], index: o.index });
      });
      menu.appendChild(row);
      this._rows.push({ o, v });
    }
    in_.appendChild(menu);
    in_.appendChild(inkRule({ w: 520, seed: 48 }));

    const row = h('div', { class: 'vc-btnrow', style: 'justify-content:space-between' });
    const restart = h('div', { class: 'vc-mi', style: 'flex:0 0 auto' },
      h('div', { class: 'k', text: 'Restart Mission' }));
    clickable(restart, () => { this.hide(); this.onRestart?.(); Bus.emit('ui:restart', {}); });
    row.appendChild(restart);
    row.appendChild(ribbonButton('Resume', () => {
      this.hide(); this.onResume?.(); Bus.emit('ui:resume', {});
    }, { w: 12, key: 'Esc', seed: 52 }));
    in_.appendChild(row);

    p.content.appendChild(in_);
    this.root.appendChild(p.root);
  }

  _refresh() { for (const r of this._rows) r.v.textContent = r.o.values[r.o.index]; }
  getOption(key) { const o = this.options.find((x) => x.key === key); return o ? o.values[o.index] : null; }
  dispose() { this.root.remove(); }
}

// --------------------------------------------------------------------------
// Dialogue bar — portrait + name plate + typewriter
// --------------------------------------------------------------------------

export class DialogueBar {
  constructor(host, { onDone = null } = {}) {
    this.host = host;
    this.onDone = onDone;
    this.root = h('div', { class: 'vc-hidden' });
    this.host.appendChild(this.root);
    this.visible = false;
    this.queue = [];
    this.tw = null;
    this._auto = 0;
    this._built = false;
  }

  _build() {
    clear(this.root);
    const p = panel({ seed: 909, cls: 'vc-dlg', tilt: 0.15, under: true, amp: 0.6 });
    const in_ = h('div', { class: 'vc-dlg-in' });
    this.porBox = h('div', { class: 'vc-dlg-por' });
    in_.appendChild(this.porBox);
    const body = h('div', { class: 'vc-dlg-body' });
    this.nameEl = h('div', { class: 'vc-dlg-name' });
    body.appendChild(this.nameEl);
    this.textEl = h('div', { class: 'vc-dlg-text' });
    body.appendChild(this.textEl);
    in_.appendChild(body);
    p.content.appendChild(in_);
    this.next = h('div', { class: 'vc-dlg-next', text: 'space' });
    p.content.appendChild(this.next);
    clickable(p.root, () => this.advance());
    this.root.appendChild(p.root);
    this.panel = p.root;
    this._built = true;
  }

  /**
   * @param {Array<{name?:string, text:string, seed?:number|string, cls?:string,
   *                team?:number, mood?:string, hold?:number}>} lines
   */
  play(lines) {
    if (!this._built) this._build();
    this.queue = Array.isArray(lines) ? lines.slice() : [lines];
    this.root.classList.remove('vc-hidden');
    this.visible = true;
    this._show(this.queue.shift());
  }

  say(line) { this.play([line]); }

  _show(line) {
    if (!line) { this.hide(); this.onDone?.(); Bus.emit('ui:dialogueDone', {}); return; }
    this.current = line;
    clear(this.porBox);
    if (line.name || line.seed != null) {
      this.porBox.style.display = '';
      // No frame and no ground: the bust is cut out and rises out of the top of
      // the box. A framed portrait read as a boxed thumbnail bolted on the side.
      this.porBox.innerHTML = portraitMarkup({
        seed: line.seed != null ? line.seed : (line.name || 'narrator'),
        cls: line.cls || 'scout', team: line.team | 0, w: 100, mood: line.mood || 'calm',
        frame: false, bg: false,
      });
    } else this.porBox.style.display = 'none';
    this.nameEl.textContent = line.name || '';
    this.nameEl.style.display = line.name ? '' : 'none';
    this.tw?.cancel();
    this.next.style.opacity = '0';
    this.tw = typewriter(this.textEl, line.text || '', {
      cps: line.cps || 44,
      onDone: () => {
        this.next.style.opacity = '';
        if (line.hold) this._auto = setTimeout(() => this.advance(), line.hold * 1000);
      },
    });
    replay(this.panel, 'vc-dlg');
    Bus.emit('sfx', { name: 'ui_dialogue', vol: 0.5 });
  }

  /** Space/click: finish the reveal, or move to the next line if already done. */
  advance() {
    if (!this.visible) return;
    clearTimeout(this._auto);
    if (this.tw && !this.tw.done) { this.tw.finish(); return; }
    this._show(this.queue.shift());
  }

  hide() {
    clearTimeout(this._auto);
    this.tw?.cancel();
    this.root.classList.add('vc-hidden');
    this.visible = false;
    this.queue.length = 0;
  }

  dispose() { this.hide(); this.root.remove(); }
}

export { squadChip };
