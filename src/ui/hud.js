// src/ui/hud.js
// The whole interface: an illustrated wartime field journal laid over the frame.
//
//   new HUD(battle)                      // per docs/ARCHITECTURE.md
//   new HUD(battle, { camera, mission }) // preferred — camera enables world labels
//
// The HUD is a pure observer. It subscribes to Bus events and reads (never
// mutates) battle state; every interactive control reports back by emitting a
// `ui:*` event, so the game layer can adopt them at its own pace.
//
// Events consumed (canonical, from docs/ARCHITECTURE.md):
//   phase:change unit:selected unit:damaged unit:downed shot:fired interception
//   cp:changed turn:changed mission:end order:used explosion
// Events consumed (optional UI channel — no-ops if never emitted):
//   ui:chapter ui:briefing ui:deploy ui:dialogue ui:objective ui:objectives
//   ui:target ui:aim ui:ammo ui:alert ui:toast ui:capture ui:markers ui:orders
//   ui:results ui:legend ui:pause
// Events emitted:
//   ui:endTurn ui:selectUnit ui:order ui:deployConfirm ui:briefingDone ui:resume
//   ui:restart ui:option ui:pause ui:dialogueDone sfx

import { Bus } from '../core/bus.js';
import { CFG } from '../core/config.js';
import { Input } from '../core/input.js';
import { V0, V1, clamp, clamp01, damp, lerp, shortestAngle } from '../core/math.js';
import { injectStyles, disposeStyles } from './style.js';
import { h, clear, panel, clickable, label, replay, pad } from './dom.js';
import {
  icon, ribbon, cpToken, classBadge, bookmark, cornerFlourish, frameRule,
  aimBrackets, crosshair, accuracyRing, bodyFigure, ammoPip, meterTicks, terrainSketch,
  wobblyPath, hatchPath,
} from './icons.js';
import { portraitFor } from './portraits.js';
import { WorldLabels } from './worldLabels.js';
import {
  ChapterCard, BriefingScreen, DeploymentScreen, ResultsScreen, PauseMenu, DialogueBar,
  ribbonButton,
} from './screens.js';

const CLASS_NAME = {
  scout: 'Scout', shock: 'Shocktrooper', shocktrooper: 'Shocktrooper', lancer: 'Lancer',
  engineer: 'Engineer', sniper: 'Sniper', tank: 'Tank',
};

const DEFAULT_ORDERS = [
  { id: 'awaken', name: 'Awaken', cost: 1, icon: 'ragnaid', desc: 'Rouse a downed ally back onto their feet.' },
  { id: 'caution', name: 'Caution', cost: 2, icon: 'shield', desc: 'One soldier takes 40% less fire this turn.' },
  { id: 'demolition', name: 'Demolition Boost', cost: 2, icon: 'lancer', desc: 'Anti-armour damage raised by half.' },
  { id: 'resupply', name: 'Resupply', cost: 1, icon: 'ammo', desc: 'Restore ammunition and ragnaid to one unit.' },
  { id: 'recon', name: 'Reconnaissance', cost: 2, icon: 'eye', desc: 'Reveal every enemy position on the map.' },
  { id: 'command', name: 'Direct Command', cost: 3, icon: 'radio', desc: 'Grant a soldier a second sortie.' },
];

const LEGENDS = {
  command: [
    ['Drag', 'Pan Map'], ['Wheel', 'Zoom'], ['LMB', 'Select Unit'],
    ['Enter', 'Sortie'], ['E', 'End Turn'], ['Esc', 'Pause'],
  ],
  action: [
    ['WASD', 'Move'], ['Shift', 'Sprint'], ['Ctrl', 'Crouch'], ['RMB', 'Aim'],
    ['LMB', 'Fire'], ['R', 'Reload'], ['Enter', 'End Action'], ['Esc', 'Pause'],
  ],
  aim: [
    ['LMB', 'Fire'], ['RMB', 'Lower Weapon'], ['Wheel', 'Magnify'],
    ['Tab', 'Target Part'], ['Esc', 'Pause'],
  ],
  enemy: [['—', 'Imperial Turn']],
  result: [['Enter', 'Continue']],
  dialogue: [['Space', 'Advance']],
};

export class HUD {
  /**
   * @param {object} battle the BLiTZ Battle (may be partially initialised)
   * @param {{camera?:THREE.Camera, container?:HTMLElement, mission?:object,
   *          handleKeys?:boolean, mapExtent?:number}} [opts]
   */
  constructor(battle, opts = {}) {
    this.battle = battle || {};
    this.opts = opts;
    this.camera = opts.camera || this.battle.camera || null;
    this.mission = opts.mission || this.battle.mission || {};
    this.handleKeys = opts.handleKeys !== false;
    this.mapExtent = opts.mapExtent || 128;

    injectStyles();
    this.host = opts.container || document.getElementById('hud') || document.body;
    this.root = h('div', { class: 'vc-root' });
    this.host.appendChild(this.root);

    // ---- persistent state -------------------------------------------------
    this.phase = this.battle.phase || 'command';
    this.selected = this.battle.selected || this.battle.selectedUnit || null;
    this.turn = this.battle.turn || 1;
    this.cp = this._readCp();
    this.cpShown = -1;
    this.target = null;
    this.aiming = false;
    this.spread = 1;
    this.spreadShown = 1;
    this.hitChance = 0;
    this.hitShown = 0;
    this.dmgFlash = 0;
    this.apShown = 0;
    this.markers = [];
    this.orders = DEFAULT_ORDERS;
    this.objectives = this.mission.objectives || [
      { type: 'capture', text: 'Seize the Imperial base camp.' },
      { type: 'defend', text: 'Hold the bridge until relief arrives.', sub: true },
    ];
    this._rosterCards = new Map();
    this._rosterKey = '';
    this._blips = [];
    this._time = 0;
    this._alertTimer = 0;
    this._unsubs = [];

    // ---- layers ----------------------------------------------------------
    this._buildFrame();
    this.worldLayer = h('div', { class: 'vc-world' });
    this.root.appendChild(this.worldLayer);
    this._buildCommand();
    this._buildAction();
    this._buildTargeting();
    this._buildChrome();

    this.screens = h('div', { class: 'vc-screens' });
    this.root.appendChild(this.screens);
    this.chapterCard = new ChapterCard(this.screens);
    this.briefing = new BriefingScreen(this.screens, { onBegin: () => this._onBriefingDone() });
    this.deployment = new DeploymentScreen(this.screens, { onConfirm: (a) => this._onDeployed(a) });
    this.results = new ResultsScreen(this.screens, { onContinue: () => Bus.emit('ui:resultsDone', {}) });
    this.pause = new PauseMenu(this.screens, {
      onResume: () => this._setPaused(false),
      onOption: (k, v) => this._applyOption(k, v),
      onRestart: () => this._setPaused(false),
    });
    this.dialogue = new DialogueBar(this.root, {});

    this.labels = new WorldLabels(this.worldLayer, this.camera);

    this._wire();
    this._setPhase(this.phase, true);
    this._renderCp();
    this.turnNum.textContent = pad(this.turn);
    this._onResize = () => { this.labels.resize(); this._mapW = 0; this._compassW = 0; };
    addEventListener('resize', this._onResize);

    if (this.mission.chapter != null && opts.autoChapter !== false) {
      this.showChapter(this.mission);
    }
  }

  // ======================================================================
  // Build: book frame
  // ======================================================================

  _buildFrame() {
    const f = h('div', { class: 'vc-frame' });
    f.appendChild(h('div', { class: 'vc-fibre' }));
    const rule = h('div', { class: 'vc-frame-rule' });
    rule.appendChild(frameRule({ w: 1600, h: 900, seed: 202 }));
    f.appendChild(rule);
    for (const c of ['tl', 'tr', 'bl', 'br']) {
      const el = h('div', { class: 'vc-corner ' + c });
      el.appendChild(cornerFlourish({ size: 84, seed: 9 + c.charCodeAt(0) }));
      f.appendChild(el);
    }
    this.bookmarkEl = h('div', { class: 'vc-bookmark' });
    this.bookmarkEl.appendChild(bookmark({ w: 34, h: 96, text: 'I' }));
    f.appendChild(this.bookmarkEl);
    f.appendChild(h('div', { class: 'vc-vignette' }));
    this.root.appendChild(f);
  }

  _setBookmark(chapter) {
    clear(this.bookmarkEl);
    const r = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][(chapter | 0) - 1] || 'I';
    this.bookmarkEl.appendChild(bookmark({ w: 34, h: 96, text: r }));
  }

  // ======================================================================
  // Build: command mode
  // ======================================================================

  _buildCommand() {
    const L = h('div', { class: 'vc-layer vc-cmd vc-hidden' });
    this.cmdLayer = L;

    // --- CP + turn ---------------------------------------------------------
    const top = h('div', { class: 'vc-cmd-top' });
    const cpP = panel({ seed: 811, cls: 'vc-cp', tilt: 0.4 });
    const cpHead = h('div', { class: 'vc-cp-count' });
    cpHead.appendChild(h('b', { class: 'vc-num' }));
    cpHead.appendChild(label('Command Points'));
    this.cpNum = cpHead.firstChild;
    cpP.content.appendChild(cpHead);
    this.cpRow = h('div', { class: 'vc-cp-row' });
    cpP.content.appendChild(this.cpRow);
    top.appendChild(cpP.root);

    const tP = panel({ seed: 812, cls: 'vc-turn', tilt: -0.5 });
    tP.content.appendChild(label('Turn'));
    this.turnNum = h('b', { class: 'vc-num', text: '01' });
    tP.content.appendChild(this.turnNum);
    this.turnTeam = h('div', { class: 'vc-label vc-tight', text: 'Gallian' });
    tP.content.appendChild(this.turnTeam);
    top.appendChild(tP.root);
    L.appendChild(top);

    // --- roster ------------------------------------------------------------
    this.rosterEl = h('div', { class: 'vc-roster' });
    L.appendChild(this.rosterEl);

    // --- objective card ----------------------------------------------------
    const oP = panel({ seed: 813, cls: 'vc-obj', tilt: 0.35, under: true });
    oP.content.appendChild(label('Objective'));
    this.objList = h('div');
    oP.content.appendChild(this.objList);
    L.appendChild(oP.root);
    this._renderObjectives();

    // --- tactical map ------------------------------------------------------
    const mP = panel({ seed: 814, cls: 'vc-map', tilt: -0.3, under: true });
    const mt = h('div', { class: 'vc-map-title' });
    mt.appendChild(label('Tactical Survey'));
    this.mapScaleEl = h('div', { class: 'vc-label vc-tight', text: this.mapExtent + ' m' });
    mt.appendChild(this.mapScaleEl);
    mP.content.appendChild(mt);
    this.mapIn = h('div', { class: 'vc-map-in' });
    this.mapIn.appendChild(terrainSketch({ w: 400, h: 300, seed: CFG.seed || 1234 }));
    this.mapBlips = h('div', { class: 'vc-map-blips' });
    this.mapIn.appendChild(this.mapBlips);
    mP.content.appendChild(this.mapIn);
    L.appendChild(mP.root);

    // --- end turn ----------------------------------------------------------
    this.endTurnBtn = ribbonButton('End Turn', () => this._endTurn(), { w: 14, key: 'E', seed: 815 });
    this.endTurnBtn.classList.add('vc-endturn');
    L.appendChild(this.endTurnBtn);

    // --- order cards -------------------------------------------------------
    this.ordersEl = h('div', { class: 'vc-orders' });
    L.appendChild(this.ordersEl);

    this.root.appendChild(L);
    this._renderOrders();
  }

  _renderObjectives() {
    clear(this.objList);
    const ICONS = { capture: 'flag', defend: 'shield', kill: 'swords', escort: 'boot', survive: 'clock' };
    for (const o of this.objectives) {
      const row = h('div', { class: 'vc-obj-row' + (o.sub ? ' sub' : '') });
      row.appendChild(icon(ICONS[o.type] || 'pin', { size: 17, width: 1.6 }));
      row.appendChild(h('div', { class: o.done ? 'vc-obj-done' : '', text: o.text }));
      this.objList.appendChild(row);
    }
  }

  _renderOrders() {
    clear(this.ordersEl);
    this._orderCards = [];
    const cp = this.cp;
    this.orders.forEach((o, i) => {
      const p = panel({ seed: 900 + i * 37, cls: 'vc-card', tilt: 1.1, under: false, amp: 1.1, soft: true });
      p.root.style.animationDelay = (i * 0.055).toFixed(3) + 's';
      const in_ = h('div', { class: 'vc-card-in' });

      // illustrated art plate: wash + hatching + the order's emblem
      const art = h('div', { class: 'vc-card-art' });
      art.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" preserveAspectRatio="none">' +
        '<rect width="100" height="60" fill="#8a7a52" fill-opacity="0.16"/>' +
        '<path d="' + hatchPath(0, 30, 100, 30, { spacing: 4, angle: -0.85, seed: 300 + i * 7 }) +
        '" stroke="#5d4d3b" stroke-width="0.5" opacity="0.28" fill="none"/>' +
        '<path d="' + wobblyPath(2, 2, 98, 2, { seed: 400 + i, amp: 0.7, segs: 8 }) + ' ' +
        wobblyPath(98, 2, 98, 58, { seed: 410 + i, amp: 0.7, segs: 6 }) + ' ' +
        wobblyPath(98, 58, 2, 58, { seed: 420 + i, amp: 0.7, segs: 8 }) + ' ' +
        wobblyPath(2, 58, 2, 2, { seed: 430 + i, amp: 0.7, segs: 6 }) +
        '" fill="none" stroke="#4a3c2c" stroke-width="1" opacity="0.7"/></svg>';
      const emblem = icon(o.icon || 'star', { size: 34, width: 1.5, rough: true });
      emblem.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#4a3c2c';
      art.appendChild(emblem);
      in_.appendChild(art);

      in_.appendChild(h('div', { class: 'vc-card-name', text: o.name }));
      in_.appendChild(h('div', { class: 'vc-card-desc', text: o.desc || '' }));
      p.content.appendChild(in_);

      const cost = h('div', { class: 'vc-card-cost' });
      cost.appendChild(cpToken({ plain: true, size: 34, seed: 500 + i }));
      cost.appendChild(h('span', { class: 'vc-num', text: String(o.cost) }));
      p.root.appendChild(cost);

      const locked = o.cost > cp;
      p.root.classList.toggle('locked', locked);
      if (!locked) {
        clickable(p.root, () => {
          Bus.emit('ui:order', { order: o, unit: this.selected });
          Bus.emit('sfx', { name: 'ui_order', vol: 0.8 });
          this.toast(o.name.toUpperCase() + ' ISSUED');
        });
      }
      this.ordersEl.appendChild(p.root);
      this._orderCards.push({ o, root: p.root });
    });
  }

  _refreshOrderLocks() {
    if (!this._orderCards) return;
    for (const c of this._orderCards) {
      const locked = c.o.cost > this.cp;
      if (c.root.classList.contains('locked') !== locked) {
        c.root.classList.toggle('locked', locked);
        if (!locked && !c.root.classList.contains('clickable')) {
          clickable(c.root, () => {
            Bus.emit('ui:order', { order: c.o, unit: this.selected });
            this.toast(c.o.name.toUpperCase() + ' ISSUED');
          });
        }
      }
    }
  }

  // ======================================================================
  // Build: action mode
  // ======================================================================

  _buildAction() {
    const L = h('div', { class: 'vc-layer vc-act vc-hidden' });
    this.actLayer = L;

    // name plate + class badge
    const np = h('div', { class: 'vc-name' });
    this.badgeEl = h('div', { class: 'vc-badge' });
    np.appendChild(this.badgeEl);
    const nt = h('div', { class: 'vc-name-t' });
    this.unitNameEl = h('b', { text: '—' });
    nt.appendChild(this.unitNameEl);
    this.unitClsEl = label('Scout');
    nt.appendChild(this.unitClsEl);
    np.appendChild(nt);
    L.appendChild(np);

    // AP meter
    const apP = panel({ seed: 821, cls: 'vc-ap', tilt: 0.25 });
    this.apPanel = apP.root;
    const head = h('div', { class: 'vc-ap-head' });
    head.appendChild(label('Action Points'));
    this.apNum = h('b', { class: 'vc-num', text: '0' });
    head.appendChild(this.apNum);
    this.apMaxEl = h('span', { class: 'vc-label', text: '/ 0' });
    head.appendChild(this.apMaxEl);
    apP.content.appendChild(head);
    const meter = h('div', { class: 'vc-ap-meter vc-bar' });
    meter.appendChild(h('div', { class: 'vc-bar-bg' }));
    this.apGhost = h('div', { class: 'vc-bar-ghost' });
    meter.appendChild(this.apGhost);
    this.apFill = h('div', { class: 'vc-bar-fill ap' });
    meter.appendChild(this.apFill);
    const ticks = h('div', { class: 'vc-ap-ticks' });
    ticks.appendChild(meterTicks({ w: 400, h: 22, count: 10, seed: 88 }));
    meter.appendChild(ticks);
    apP.content.appendChild(meter);
    L.appendChild(apP.root);

    // ammo
    const amP = panel({ seed: 822, cls: 'vc-ammo', tilt: -0.3 });
    this.ammoPanel = amP.root;
    amP.content.appendChild(label('Ammunition'));
    this.ammoNum = h('div', { class: 'vc-ammo-n vc-num' }, h('span', { text: '0' }), h('small', { text: ' / 0' }));
    amP.content.appendChild(this.ammoNum);
    this.ammoPips = h('div', { class: 'vc-ammo-pips' });
    amP.content.appendChild(this.ammoPips);
    this.reloadEl = h('div', { class: 'vc-reload vc-hidden', text: 'Reloading' });
    amP.content.appendChild(this.reloadEl);
    L.appendChild(amP.root);

    // compass
    this.compass = h('div', { class: 'vc-compass' });
    this.compassTape = h('div', { class: 'vc-compass-tape' });
    this.compass.appendChild(this.compassTape);
    // Objective pins ride a second row below the cardinal tape so they never
    // sit on top of a letter.
    this.compassPins = h('div', { class: 'vc-compass-tape', style: 'width:100%;top:1.7em;height:auto' });
    this.compass.appendChild(this.compassPins);
    this._buildCompassTape();
    L.appendChild(this.compass);

    // damage vignette + interception flash
    this.dmgVig = h('div', { class: 'vc-dmgv' });
    L.appendChild(this.dmgVig);
    this.iceptEl = h('div', { class: 'vc-intercept' });
    L.appendChild(this.iceptEl);

    this.root.appendChild(L);
  }

  _buildCompassTape() {
    clear(this.compassTape);
    // Two full revolutions of ticks so the tape never runs out while scrolling.
    // Ticks are placed as a PERCENTAGE of the tape's own width — the tape is then
    // resized in px each frame. Scaling the tape instead would squash the glyphs.
    const CARD = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = 0; d < 720; d += 15) {
      const deg = d % 360;
      const card = CARD[deg];
      const el = h('div', {
        class: 'vc-compass-pin',
        style: 'left:' + ((d / 720) * 100).toFixed(4) + '%;color:' + (card ? '#3a2f28' : '#6b5a44'),
      });
      if (card) {
        el.appendChild(h('div', {
          style: 'font-size:.86em;font-variant:small-caps;letter-spacing:.12em;line-height:1',
          text: card,
        }));
      }
      el.appendChild(h('div', {
        style: 'width:1px;height:' + (card ? 9 : 5) + 'px;margin:2px auto 0;background:currentColor;opacity:' +
          (card ? 0.8 : 0.45),
      }));
      this.compassTape.appendChild(el);
    }
  }

  // ======================================================================
  // Build: targeting overlay
  // ======================================================================

  _buildTargeting() {
    const L = h('div', { class: 'vc-tgt' });
    this.tgtLayer = L;

    this.bracketsEl = h('div', { class: 'vc-brackets' });
    this.bracketsEl.appendChild(aimBrackets({ w: 340, h: 240, seed: 31 }));
    L.appendChild(this.bracketsEl);

    this.accEl = h('div', { class: 'vc-acc' });
    this.accSvg = accuracyRing({ size: 260, seed: 53 });
    this.accSvg.removeAttribute('width');
    this.accSvg.removeAttribute('height');
    this.accSvg.style.cssText = 'width:100%;height:100%';
    this.accEl.appendChild(this.accSvg);
    L.appendChild(this.accEl);

    const cross = h('div', { class: 'vc-cross' });
    cross.appendChild(crosshair({ size: 240, seed: 47 }));
    L.appendChild(cross);

    const hit = h('div', { class: 'vc-hit' });
    this.hitNum = h('b', {
      class: 'vc-num',
      style: 'color:#f6ecd6;text-shadow:0 1px 3px rgba(40,20,16,.95)',
      text: '0%',
    });
    hit.appendChild(this.hitNum);
    hit.appendChild(h('div', {
      class: 'vc-label', style: 'color:#e8d9b6;text-shadow:0 1px 3px rgba(40,20,16,.95)', text: 'Hit',
    }));
    L.appendChild(hit);

    const tc = panel({ seed: 831, cls: 'vc-tcard', tilt: -0.4, under: true });
    this.tcard = tc.root;
    const th = h('div', { class: 'vc-tcard-head' });
    this.tcardIcon = h('span');
    th.appendChild(this.tcardIcon);
    this.tcardName = h('div', { class: 'vc-h3', text: 'Imperial Soldier' });
    th.appendChild(this.tcardName);
    tc.content.appendChild(th);
    const hpBar = h('div', { class: 'vc-bar', style: 'margin-top:.3em' });
    hpBar.appendChild(h('div', { class: 'vc-bar-bg' }));
    this.tcardHp = h('div', { class: 'vc-bar-fill hp' });
    hpBar.appendChild(this.tcardHp);
    tc.content.appendChild(hpBar);
    this.tcardRows = h('div', { class: 'vc-tcard-rows' });
    tc.content.appendChild(this.tcardRows);
    this.bodyFig = h('div', { class: 'vc-body-fig' });
    this.bodyFig.appendChild(bodyFigure({ part: 'torso', size: 96 }));
    tc.content.appendChild(this.bodyFig);
    L.appendChild(tc.root);

    this.root.appendChild(L);
  }

  // ======================================================================
  // Build: alerts, toasts, legend
  // ======================================================================

  _buildChrome() {
    this.alertEl = h('div', { class: 'vc-alert' });
    this.alertTitle = h('div', { class: 'vc-alert-t', text: 'Enemy Sighted' });
    this.alertSub = h('div', { class: 'vc-alert-sub', text: '' });
    this.alertEl.appendChild(this.alertTitle);
    this.alertEl.appendChild(this.alertSub);
    this.root.appendChild(this.alertEl);

    this.toastsEl = h('div', { class: 'vc-toasts' });
    this.root.appendChild(this.toastsEl);

    const lp = panel({ seed: 841, cls: 'vc-legend', tilt: 0 });
    this.legendEl = h('div', { style: 'display:flex;gap:.85em;flex-wrap:wrap;justify-content:center' });
    lp.content.appendChild(this.legendEl);
    this.root.appendChild(lp.root);
    this.setControls('command');
  }

  /** Rebuild the controls legend for a mode key ('command'|'action'|'aim'|...). */
  setControls(mode) {
    const rows = LEGENDS[mode] || LEGENDS.command;
    if (this._legendKey === mode) return;
    this._legendKey = mode;
    clear(this.legendEl);
    for (const [k, t] of rows) {
      const g = h('div', { class: 'vc-lg' });
      g.appendChild(h('span', { class: 'vc-key', text: k }));
      g.appendChild(h('span', { text: t }));
      this.legendEl.appendChild(g);
    }
  }

  // ======================================================================
  // Bus wiring
  // ======================================================================

  _on(evt, fn) { this._unsubs.push(Bus.on(evt, fn)); }

  _wire() {
    this._on('phase:change', (p) => this._setPhase(p?.to || 'command'));
    this._on('turn:changed', (p) => {
      if (p?.turn != null) this.turn = p.turn;
      this.turnNum.textContent = pad(this.turn);
      this.turnTeam.textContent = (p?.team | 0) === 1 ? 'Imperial' : 'Gallian';
      this.turnTeam.style.color = (p?.team | 0) === 1 ? '#8d3730' : '';
    });
    this._on('cp:changed', (p) => {
      if (p && (p.team | 0) !== 0) return;
      this.cp = p?.cp != null ? p.cp : this._readCp();
      this._renderCp();
      this._refreshOrderLocks();
    });
    this._on('unit:selected', (p) => {
      this.selected = p?.unit || null;
      this._syncSelection();
      if (this.selected) this._flashSelected();
    });
    this._on('unit:damaged', (p) => {
      if (!p) return;
      const pos = p.worldPos || p.unit?.pos;
      if (pos) {
        this.labels.damage(pos, p.amount || 0, {
          crit: !!p.crit,
          seed: (p.unit?.name || '').length * 977 + Math.round(p.amount || 0) * 31,
        });
      }
      if (p.unit && p.unit === this.selected && (p.unit.team | 0) === 0) {
        this.dmgFlash = Math.min(1, this.dmgFlash + 0.35 + clamp01((p.amount || 0) / 60) * 0.5);
      }
    });
    this._on('unit:downed', (p) => {
      const u = p?.unit;
      if (!u) return;
      if (u.pos) this.labels.banner(u.pos, 'DOWNED', { life: 2.2, color: '#77202a' });
      this.toast(((u.name || 'Soldier') + ' is down').toUpperCase());
      this._rosterKey = '';   // force a rebuild so the stamp appears
    });
    this._on('interception', (p) => {
      replay(this.iceptEl, 'on');
      const at = p?.target?.pos || p?.shooter?.pos;
      if (at) this.labels.banner(at, 'INTERCEPTION FIRE!', { life: 1.9 });
      this.alert('Interception Fire', 'take cover');
    });
    this._on('mission:end', (p) => {
      this.results.show({
        victory: p?.victory !== false,
        turns: p?.turns != null ? p.turns : this.turn,
        dp: p?.stats?.dp, exp: p?.stats?.exp,
        stats: p?.stats, casualties: p?.stats?.casualties,
        seed: 777,
      });
      this.setControls('result');
    });
    this._on('order:used', (p) => {
      if (p?.order?.name) this.toast(String(p.order.name).toUpperCase());
    });
    this._on('explosion', (p) => {
      if (!p?.pos || !this.camera) return;
      // A near blast rattles the frame — a shake on the vignette, not the text.
      const d = V0.set(p.pos.x, p.pos.y, p.pos.z).distanceTo(this.camera.position);
      if (d < 24) this.dmgFlash = Math.max(this.dmgFlash, 0.35 * (1 - d / 24));
    });

    // ---- optional ui:* channel -------------------------------------------
    this._on('ui:chapter', (p) => this.showChapter(p || {}));
    this._on('ui:briefing', (p) => (p && p.show === false ? this.briefing.hide() : this.showBriefing(p || {})));
    this._on('ui:deploy', (p) => (p && p.show === false ? this.deployment.hide() : this.showDeployment(p || {})));
    this._on('ui:results', (p) => this.results.show(p || {}));
    this._on('ui:dialogue', (p) => this.say(p));
    this._on('ui:objective', (p) => {
      if (!p) return;
      this.objectives = p.objectives || [{ type: p.type || 'capture', text: p.text || '' }];
      this._renderObjectives();
    });
    this._on('ui:objectives', (p) => {
      this.objectives = (p && p.objectives) || this.objectives;
      this._renderObjectives();
    });
    this._on('ui:target', (p) => this.setTarget(p));
    this._on('ui:aim', (p) => {
      this.aiming = !!(p && p.aiming);
      if (p && p.spread != null) this.spread = clamp01(p.spread);
      if (p && p.hit != null) this.hitChance = clamp01(p.hit > 1 ? p.hit / 100 : p.hit);
    });
    this._on('ui:ammo', (p) => this.setAmmo(p || {}));
    this._on('ui:alert', (p) => this.alert(p?.text || 'Enemy Sighted', p?.sub || ''));
    this._on('ui:toast', (p) => this.toast(typeof p === 'string' ? p : (p?.text || '')));
    this._on('ui:capture', (p) => {
      if (!p) return;
      if (p.remove) this.labels.clearCapture(p.id);
      else this.labels.capture(p.id != null ? p.id : 'camp', p.pos, p);
    });
    this._on('ui:markers', (p) => { this.markers = (p && p.markers) || []; });
    this._on('ui:orders', (p) => {
      this.orders = (p && p.orders) || DEFAULT_ORDERS;
      this._renderOrders();
    });
    this._on('ui:legend', (p) => this.setControls(typeof p === 'string' ? p : p?.mode));
    this._on('ui:pause', (p) => this._applyPause(p ? p.paused !== false : true));
    this._on('shot:fired', () => { this._muzzle = 0.06; });
  }

  // ======================================================================
  // Public API
  // ======================================================================

  setCamera(cam) { this.camera = cam; this.labels.setCamera(cam); }

  /** Project a world position to viewport pixels; returns a reused object. */
  project(worldPos, out) { return this.labels.project(worldPos, out); }

  showChapter(d = {}) {
    if (d.chapter != null) this._setBookmark(d.chapter);
    this.chapterCard.show({
      chapter: d.chapter, title: d.title, subtitle: d.subtitle, place: d.place,
      seed: d.seed || 404, dwell: d.dwell, onDone: d.onDone,
    });
  }

  showBriefing(d = {}) {
    this.briefing.show({
      chapter: d.chapter != null ? d.chapter : this.mission.chapter,
      title: d.title || this.mission.title,
      brief: d.brief || this.mission.brief,
      date: d.date || this.mission.date,
      objectives: d.objectives || this.objectives,
      squad: d.squad || this._allies(),
      intel: d.intel || this.mission.intel,
      markers: d.markers,
      seed: d.seed || CFG.seed || 1234,
    });
    this.setControls('command');
  }

  showDeployment(d = {}) {
    this.deployment.show({
      camps: d.camps || this.mission.camps,
      squad: d.squad || this._allies(),
      seed: d.seed || CFG.seed || 5150,
      title: d.title,
      minDeploy: d.minDeploy,
    });
  }

  showResults(d = {}) { this.results.show(d); this.setControls('result'); }

  /** Queue one or many dialogue lines. */
  say(lines) {
    if (!lines) return;
    this.dialogue.play(Array.isArray(lines) ? lines : [lines]);
    this.setControls('dialogue');
  }

  /** Big centre-screen alert ("ENEMY SIGHTED"). */
  alert(text, sub = '') {
    this.alertTitle.textContent = text;
    this.alertSub.textContent = sub;
    replay(this.alertEl, 'on');
    this._alertTimer = 2.1;
  }

  /** Transient small notice near the top of the page. */
  toast(text) {
    if (!text) return;
    const p = panel({ seed: 950 + (text.length * 13), cls: 'vc-toast', tilt: 0.6, soft: true });
    p.content.textContent = text;
    this.toastsEl.appendChild(p.root);
    setTimeout(() => p.root.remove(), 2700);
    while (this.toastsEl.childElementCount > 4) this.toastsEl.firstChild.remove();
  }

  /**
   * Drive the targeting overlay.
   * @param {null|{unit?:object, name?:string, cls?:string, hp?:number, maxHp?:number,
   *   distance?:number, hit?:number, part?:string, spread?:number}} t
   */
  setTarget(t) {
    if (!t || (t.show === false)) { this.target = null; return; }
    this.target = t;
    const u = t.unit || {};
    const cls = String(t.cls || u.cls || 'shock').toLowerCase();
    this.tcardName.textContent = t.name || u.name || (CLASS_NAME[cls] || 'Imperial Soldier');
    clear(this.tcardIcon);
    this.tcardIcon.appendChild(icon(cls, { size: 19, width: 1.6 }));
    const hp = t.hp != null ? t.hp : u.hp, maxHp = t.maxHp != null ? t.maxHp : u.maxHp;
    if (hp != null && maxHp) {
      const pct = clamp01(hp / maxHp) * 100;
      this.tcardHp.style.width = pct + '%';
      this.tcardHp.classList.toggle('warn', pct <= 55 && pct > 25);
      this.tcardHp.classList.toggle('crit', pct <= 25);
    }
    clear(this.tcardRows);
    const rows = [
      ['Class', CLASS_NAME[cls] || 'Infantry'],
      ['Health', (hp != null ? Math.max(0, Math.round(hp)) : '—') + ' / ' + (maxHp || '—')],
      ['Distance', (t.distance != null ? Math.round(t.distance) : '—') + ' m'],
      ['Aim Point', partName(t.part)],
    ];
    if (t.cover != null) rows.push(['Cover', t.cover >= 0.99 ? 'Full' : t.cover >= 0.4 ? 'Half' : 'None']);
    for (const [k, v] of rows) {
      this.tcardRows.appendChild(h('div', null, h('span', { class: 'vc-label', text: k }), h('span', { text: v })));
    }
    if (t.part !== this._bodyPart) {
      this._bodyPart = t.part || 'torso';
      clear(this.bodyFig);
      this.bodyFig.appendChild(bodyFigure({ part: this._bodyPart, size: 96 }));
    }
    if (t.hit != null) this.hitChance = clamp01(t.hit > 1 ? t.hit / 100 : t.hit);
    if (t.spread != null) this.spread = clamp01(t.spread);
    this.aiming = t.aiming !== false;
  }

  /** @param {{ammo?:number, mag?:number, reloading?:boolean}} a */
  setAmmo({ ammo = null, mag = null, reloading = false }) {
    this._ammo = ammo != null ? ammo : this._ammo;
    this._mag = mag != null ? mag : this._mag;
    this.reloadEl.classList.toggle('vc-hidden', !reloading);
    this._renderAmmo();
  }

  /** Track a base camp's capture ring in world space. */
  setCapture(id, pos, opts) { this.labels.capture(id, pos, opts); }
  clearCapture(id) { this.labels.clearCapture(id); }

  // ======================================================================
  // Per-frame
  // ======================================================================

  update(dt) {
    this._time += dt;

    if (!this.camera && this.battle && this.battle.camera) this.setCamera(this.battle.camera);

    // Phase may change without an event if the game mutates battle.phase directly.
    const bp = this.battle.phase;
    if (bp && bp !== this.phase) this._setPhase(bp);

    // Selection fallback for the same reason.
    const bs = this.battle.selected || this.battle.selectedUnit || this.battle.activeUnit;
    if (bs !== undefined && bs !== this.selected && bs !== null) {
      this.selected = bs;
      this._syncSelection();
    }

    if (this.handleKeys) this._keys();

    if (this.phase === 'command' || this.phase === 'enemy') {
      this._updateCommand(dt);
    }
    if (this.phase === 'action') {
      this._updateAction(dt);
      this._updateTargeting(dt);
    }

    // damage vignette decay
    if (this.dmgFlash > 0.001) {
      this.dmgFlash = damp(this.dmgFlash, 0, 3.4, dt);
      this.dmgVig.style.opacity = (this.dmgFlash * 0.9).toFixed(3);
    } else if (this.dmgVig.style.opacity !== '0') {
      this.dmgVig.style.opacity = '0';
    }

    if (this._alertTimer > 0) this._alertTimer -= dt;

    this.labels.update(dt);
  }

  _keys() {
    if (Input.pressed('escape')) {
      if (this.dialogue.visible) this.dialogue.hide();
      else if (this.briefing.visible || this.deployment.visible) { /* modal screens own Esc */ }
      else this._setPaused(!this.pause.visible);
    }
    if (this.dialogue.visible && (Input.pressed(' ') || Input.pressed('enter'))) {
      this.dialogue.advance();
    }
    if (!this.pause.visible && this.phase === 'command' && Input.pressed('e')) this._endTurn();
    if ((this.briefing.visible || this.deployment.visible) && Input.pressed('enter')) {
      if (this.briefing.visible) this.briefing.root.querySelector('.vc-rbtn')?.click();
      else this.deployment.root.querySelector('.vc-rbtn')?.click();
    }
  }

  // ---------------------------------------------------------------- command

  _updateCommand(dt) {
    const cp = this._readCp();
    if (cp !== this.cp) { this.cp = cp; this._renderCp(); this._refreshOrderLocks(); }
    if ((this.battle.turn || 1) !== this.turn) {
      this.turn = this.battle.turn || 1;
      this.turnNum.textContent = pad(this.turn);
    }
    this._syncRoster();
    this._updateRoster();
    this._updateMap();
  }

  _readCp() {
    const c = this.battle && this.battle.cp;
    if (c == null) return CFG.gameplay.cpPerTurn;
    if (typeof c === 'number') return c;
    return c[0] != null ? c[0] : (c['0'] != null ? c['0'] : 0);
  }

  _renderCp() {
    const n = Math.max(0, this.cp | 0);
    if (n === this.cpShown) return;
    const gained = n > this.cpShown;
    this.cpShown = n;
    this.cpNum.textContent = pad(n);
    const max = Math.max(n, CFG.gameplay.cpPerTurn);
    clear(this.cpRow);
    for (let i = 0; i < max; i++) {
      const spent = i >= n;
      const t = cpToken({ spent, size: 26, seed: 600 + i * 17 });
      t.classList.add('vc-cp-tok');
      if (spent) t.classList.add('spent');
      else if (gained && i >= Math.max(0, this.cpShown - 2)) {
        t.classList.add('fresh');
        t.style.animationDelay = ((i % 3) * 0.06).toFixed(2) + 's';
      }
      this.cpRow.appendChild(t);
    }
  }

  _allies() {
    const us = this.battle.units;
    if (!Array.isArray(us)) return [];
    return us.filter((u) => u && (u.team | 0) === 0);
  }

  _syncRoster() {
    const allies = this._allies();
    const key = allies.map((u) => (u.name || '?')).join('|') + '#' +
      allies.map((u) => (u.downed ? 'd' : u.alive === false ? 'x' : 'o')).join('');
    if (key === this._rosterKey) return;
    this._rosterKey = key;
    clear(this.rosterEl);
    this._rosterCards.clear();
    allies.forEach((u, i) => {
      const seed = 700 + i * 53 + (u.name || '').length * 7;
      const p = panel({ seed, cls: 'vc-ru', tilt: 1.0, amp: 1.2, soft: true });
      p.root.style.animationDelay = (i * 0.05).toFixed(2) + 's';
      const in_ = h('div', { class: 'vc-ru-in' });

      const por = h('div', { class: 'vc-ru-por' });
      por.appendChild(portraitFor(u, { w: 100, frame: true }));
      in_.appendChild(por);

      const body = h('div', { class: 'vc-ru-body' });
      body.appendChild(h('div', { class: 'vc-ru-name', text: u.name || 'Soldier' }));
      const cls = h('div', { class: 'vc-ru-cls' });
      cls.appendChild(icon(String(u.cls || 'scout').toLowerCase(), { size: 15, width: 1.6 }));
      cls.appendChild(h('span', { class: 'vc-label vc-tight', text: CLASS_NAME[String(u.cls || 'scout').toLowerCase()] || 'Scout' }));
      body.appendChild(cls);

      const hpBar = h('div', { class: 'vc-bar' });
      hpBar.appendChild(h('div', { class: 'vc-bar-bg' }));
      const hpFill = h('div', { class: 'vc-bar-fill hp' });
      hpBar.appendChild(hpFill);
      body.appendChild(hpBar);

      const apBar = h('div', { class: 'vc-bar', style: 'height:.34em' });
      apBar.appendChild(h('div', { class: 'vc-bar-bg' }));
      const apFill = h('div', { class: 'vc-bar-fill ap' });
      apBar.appendChild(apFill);
      body.appendChild(apBar);

      in_.appendChild(body);
      p.content.appendChild(in_);

      const stamp = h('div', { class: 'vc-ru-stamp vc-hidden', text: 'Acted' });
      p.root.appendChild(stamp);
      const rib = h('div', { class: 'vc-ru-ribbon vc-hidden' });
      rib.appendChild(ribbon({ w: 14, h: 44, seed: seed + 3 }));
      p.root.appendChild(rib);

      clickable(p.root, () => {
        if (u.alive === false) return;
        Bus.emit('ui:selectUnit', { unit: u });
        Bus.emit('sfx', { name: 'ui_select', vol: 0.7 });
        this.selected = u;
        this._syncSelection();
      });

      this.rosterEl.appendChild(p.root);
      this._rosterCards.set(u, { root: p.root, hpFill, apFill, stamp, rib, hpKey: -1, apKey: -1 });
    });
    this._syncSelection();
  }

  _updateRoster() {
    for (const [u, c] of this._rosterCards) {
      if (u.maxHp) {
        const k = Math.round(clamp01(u.hp / u.maxHp) * 100);
        if (k !== c.hpKey) {
          c.hpKey = k;
          c.hpFill.style.width = k + '%';
          c.hpFill.classList.toggle('warn', k <= 55 && k > 25);
          c.hpFill.classList.toggle('crit', k <= 25);
        }
      }
      if (u.maxAp) {
        const k = Math.round(clamp01(u.ap / u.maxAp) * 100);
        if (k !== c.apKey) { c.apKey = k; c.apFill.style.width = k + '%'; }
      }
      const acted = !!u.hasActed;
      c.stamp.classList.toggle('vc-hidden', !acted);
      c.root.classList.toggle('acted', acted);
      c.root.classList.toggle('downed', !!u.downed || u.alive === false);
    }
  }

  _syncSelection() {
    for (const [u, c] of this._rosterCards) {
      const sel = u === this.selected;
      c.root.classList.toggle('sel', sel);
      c.rib.classList.toggle('vc-hidden', !sel);
    }
    const u = this.selected;
    if (!u) return;
    this.unitNameEl.textContent = u.name || 'Soldier';
    const cls = String(u.cls || 'scout').toLowerCase();
    this.unitClsEl.textContent = CLASS_NAME[cls] || 'Scout';
    clear(this.badgeEl);
    this.badgeEl.appendChild(classBadge(cls, { size: 46, team: u.team | 0, seed: 5 }));
    this.apShown = u.ap || 0;
    this._ammo = u.ammo != null ? u.ammo : (u.weapon && u.weapon.ammo);
    this._mag = u.magSize != null ? u.magSize : (u.weapon && (u.weapon.mag || u.weapon.magSize));
    this._renderAmmo();
  }

  _flashSelected() {
    const c = this._rosterCards.get(this.selected);
    if (c) replay(c.root, 'vc-ru');
  }

  _updateMap() {
    const box = this.mapBlips;
    const units = Array.isArray(this.battle.units) ? this.battle.units : [];
    const ext = this.mapExtent;
    const half = ext / 2;

    // Cache the panel size: percentage translate() would resolve against the
    // blip's own (zero) box, so blips must be placed in pixels.
    if ((this._mapTick = (this._mapTick || 0) + 1) > 20 || !this._mapW) {
      this._mapTick = 0;
      this._mapW = box.clientWidth || 1;
      this._mapH = box.clientHeight || 1;
    }
    const mw = this._mapW, mh = this._mapH;
    const toX = (x) => clamp01((x + half) / ext) * mw;
    const toY = (z) => clamp01((z + half) / ext) * mh;

    // grow the blip pool as needed (bounded by squad size, so this settles fast)
    while (this._blips.length < units.length) {
      const b = h('div', { style: 'position:absolute;left:0;top:0;width:0;height:0;will-change:transform' });
      b.appendChild(h('div', {
        class: 'blip',
        style: 'position:absolute;left:-5px;top:-5px;width:10px;height:10px;' +
          'clip-path:polygon(50% 0%,100% 100%,0% 100%);' +
          'filter:drop-shadow(0 1px 1px rgba(58,47,51,.55))',
      }));
      box.appendChild(b);
      this._blips.push(b);
    }
    for (let i = 0; i < this._blips.length; i++) {
      const b = this._blips[i];
      const u = units[i];
      if (!u || !u.pos || u.alive === false) { b.style.display = 'none'; continue; }
      const foe = (u.team | 0) === 1;
      b.style.display = '';
      b.style.transform = 'translate(' + toX(u.pos.x).toFixed(1) + 'px,' + toY(u.pos.z).toFixed(1) + 'px)';
      const dot = b.firstChild;
      dot.style.background = foe ? '#8d3730' : (u === this.selected ? '#a32f34' : '#37536f');
      dot.style.transform = 'rotate(' + ((u.yaw || 0) * 180 / Math.PI).toFixed(1) + 'deg) scale(' +
        (u === this.selected ? 1.55 : 1) + ')';
      dot.style.opacity = u.downed ? '0.35' : '1';
    }

    // camera wedge — the field-of-view cone drawn on the survey
    if (this.camera) {
      if (!this._camWedge) {
        this._camWedge = h('div', { style: 'position:absolute;left:0;top:0;width:0;height:0' });
        this._camWedge.appendChild(h('div', {
          style: 'position:absolute;left:-17px;top:0;width:34px;height:40px;' +
            'background:radial-gradient(farthest-side at 50% 0%, rgba(243,232,206,.62), rgba(243,232,206,0));' +
            'clip-path:polygon(50% 0%,100% 100%,0% 100%);transform-origin:50% 0%',
        }));
        box.appendChild(this._camWedge);
      }
      const c = this.camera;
      this._camWedge.style.transform =
        'translate(' + toX(c.position.x).toFixed(1) + 'px,' + toY(c.position.z).toFixed(1) + 'px)';
      this._camWedge.firstChild.style.transform =
        'rotate(' + ((this._cameraHeading() * 180 / Math.PI) + 180).toFixed(1) + 'deg)';
    }
  }

  _endTurn() {
    Bus.emit('ui:endTurn', { team: 0 });
    Bus.emit('sfx', { name: 'ui_endturn', vol: 0.9 });
    this.battle.endTurn?.();
    this.toast('TURN ENDED');
  }

  // ----------------------------------------------------------------- action

  _updateAction(dt) {
    const u = this.selected;
    if (!u) return;
    const maxAp = u.maxAp || 1;
    const ap = clamp(u.ap || 0, 0, maxAp);
    // The meter drains smoothly even if the game steps AP in chunks.
    this.apShown = damp(this.apShown, ap, 14, dt);
    const pct = clamp01(this.apShown / maxAp) * 100;
    this.apFill.style.width = pct.toFixed(2) + '%';
    this.apGhost.style.width = (clamp01(ap / maxAp) * 100).toFixed(2) + '%';
    const shown = Math.round(this.apShown);
    if (shown !== this._apLast) {
      this._apLast = shown;
      this.apNum.textContent = String(shown);
      this.apMaxEl.textContent = '/ ' + Math.round(maxAp);
    }
    const low = ap / maxAp < 0.2;
    this.apPanel.classList.toggle('low', low);
    this.apFill.style.backgroundColor = low ? '#a5382f' : '';

    // ammo can be driven by the unit directly if the game does not emit ui:ammo
    const a = u.ammo != null ? u.ammo : (u.weapon && u.weapon.ammo);
    const m = u.magSize != null ? u.magSize : (u.weapon && (u.weapon.mag || u.weapon.magSize));
    if (a !== this._ammo || m !== this._mag) { this._ammo = a; this._mag = m; this._renderAmmo(); }

    this._updateCompass();
    this.setControls(this.aiming ? 'aim' : 'action');
  }

  _renderAmmo() {
    const a = this._ammo, m = this._mag;
    if (a == null || m == null) { this.ammoPanel.classList.add('vc-hidden'); return; }
    this.ammoPanel.classList.remove('vc-hidden');
    this.ammoNum.firstChild.textContent = String(Math.max(0, a | 0));
    this.ammoNum.lastChild.textContent = ' / ' + (m | 0);
    const want = Math.min(20, m | 0);
    if (this.ammoPips.childElementCount !== want) {
      clear(this.ammoPips);
      for (let i = 0; i < want; i++) this.ammoPips.appendChild(ammoPip({ spent: false }));
    }
    const live = Math.round((a / Math.max(1, m)) * want);
    let i = 0;
    for (const pip of this.ammoPips.children) { pip.classList.toggle('spent', i >= live); i++; }
  }

  _cameraHeading() {
    if (!this.camera) return 0;
    this.camera.getWorldDirection(V1);
    return Math.atan2(V1.x, -V1.z);   // 0 = -Z (north), +ve toward +X (east)
  }

  _updateCompass() {
    if (!this.camera) return;
    const w = this.compass.clientWidth || 400;
    const pxPerDeg = w / 120;         // 120 degrees of arc fit across the widget
    if (w !== this._compassW) {
      this._compassW = w;
      this.compassTape.style.width = (720 * pxPerDeg).toFixed(1) + 'px';
    }
    let yaw = (this._cameraHeading() * 180 / Math.PI) % 360;
    if (yaw < 0) yaw += 360;
    // Ticks sit at (deg/720) of the tape; slide so the second revolution's copy
    // of `yaw` lands dead centre — there is always tape on both sides.
    const shift = -(yaw + 360) * pxPerDeg + w / 2;
    this.compassTape.style.transform = 'translateX(' + shift.toFixed(1) + 'px)';

    // objective pins
    const ms = this.markers;
    if (this.compassPins.childElementCount !== ms.length) {
      clear(this.compassPins);
      for (const m of ms) {
        const el = h('div', { class: 'vc-compass-pin', style: 'left:0' });
        el.appendChild(icon(m.icon || 'pin', { size: 14, width: 1.7 }));
        if (m.label) el.appendChild(h('span', { text: m.label }));
        el.style.color = m.team === 1 ? '#8d3730' : '#3a2f28';
        this.compassPins.appendChild(el);
      }
      this.compassPins.style.transform = '';
    }
    const cam = this.camera.position;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i], el = this.compassPins.children[i];
      if (!m.pos || !el) continue;
      const bearing = Math.atan2(m.pos.x - cam.x, -(m.pos.z - cam.z));
      const rel = shortestAngle(this._cameraHeading(), bearing) * 180 / Math.PI;
      const x = w / 2 + rel * pxPerDeg;
      const inView = x > -10 && x < w + 10;
      el.style.opacity = inView ? '1' : '0.35';
      el.style.transform = 'translateX(' + clamp(x, 4, w - 4).toFixed(1) + 'px) translateX(-50%)';
    }
  }

  // -------------------------------------------------------------- targeting

  _updateTargeting(dt) {
    const on = this.aiming;
    this.tgtLayer.classList.toggle('on', on);
    if (!on) return;

    // accuracy circle contracts as the shot settles
    this.spreadShown = damp(this.spreadShown, this.spread, 7, dt);
    const base = Math.min(innerWidth, innerHeight);
    const r = lerp(base * 0.035, base * 0.30, this.spreadShown);
    // add a slow sway so the reticle never looks pinned to the pixel grid
    const sway = Math.sin(this._time * 1.7) * 1.2 * this.spreadShown;
    this.accEl.style.width = (r * 2).toFixed(1) + 'px';
    this.accEl.style.height = (r * 2).toFixed(1) + 'px';
    this.accEl.style.transform = 'translate(-50%,-50%) translate(' + sway.toFixed(2) + 'px,' +
      (sway * 0.7).toFixed(2) + 'px)';

    // brackets converge with confidence
    const k = 1 - this.spreadShown;
    this.bracketsEl.style.transform = 'translate(-50%,-50%) scale(' + (1.28 - 0.30 * k).toFixed(3) + ')';
    this.bracketsEl.style.opacity = (0.45 + 0.55 * k).toFixed(2);

    this.hitShown = damp(this.hitShown, this.hitChance, 9, dt);
    const pct = Math.round(this.hitShown * 100);
    if (pct !== this._hitLast) {
      this._hitLast = pct;
      this.hitNum.textContent = pct + '%';
      this.hitNum.style.color = pct >= 70 ? '#dff0c8' : pct >= 40 ? '#f6e2b0' : '#f0b6a4';
    }
    this.tcard.style.display = this.target ? '' : 'none';
  }

  // ---------------------------------------------------------------- phases

  _setPhase(to, initial = false) {
    if (!initial && to === this.phase) return;
    const from = this.phase;
    this.phase = to;
    const cmd = to === 'command' || to === 'enemy';
    this.cmdLayer.classList.toggle('vc-hidden', !cmd);
    this.actLayer.classList.toggle('vc-hidden', to !== 'action');
    this.tgtLayer.classList.toggle('on', false);
    if (to !== 'action') this.aiming = false;
    this.endTurnBtn.classList.toggle('vc-hidden', to !== 'command');
    this.ordersEl.classList.toggle('vc-hidden', to !== 'command');
    this.setControls(to === 'action' ? 'action' : to === 'enemy' ? 'enemy' : to === 'result' ? 'result' : 'command');
    if (cmd && !initial) {
      this._rosterKey = '';       // re-deal the roster with its slide-in
      this.cpShown = -1;
      this._renderCp();
    }
    if (to === 'action' && from !== 'action') {
      this._syncSelection();
      this.apShown = this.selected?.ap || 0;
    }
    if (to === 'enemy') this.alert('Imperial Advance', 'enemy turn');
  }

  /** Show/hide the pause page without announcing it (used by the ui:pause listener). */
  _applyPause(on) {
    if (on === this.pause.visible) return false;
    if (on) this.pause.show(); else this.pause.hide();
    this.setControls(on ? 'command' : (this.phase === 'action' ? 'action' : 'command'));
    return true;
  }

  /** Toggle pause and tell the game about it. */
  _setPaused(on) {
    if (this._applyPause(on)) Bus.emit('ui:pause', { paused: on });
  }

  _applyOption(key, value) {
    if (key === 'quality') CFG.quality = ['Low', 'High', 'Ultra'].indexOf(value);
    if (key === 'grain') {
      const s = { Off: '0', Subtle: '.16', Full: '.30' }[value] || '.30';
      this.root.querySelector('.vc-fibre').style.opacity = s;
    }
    if (key === 'motion') {
      this.root.style.setProperty('--vc-motion', value === 'Reduced' ? '0' : '1');
      this.root.classList.toggle('vc-nomotion', value === 'Reduced');
    }
  }

  _onBriefingDone() { this.setControls('command'); }
  _onDeployed() { this.setControls('command'); }

  // ------------------------------------------------------------------ life

  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    removeEventListener('resize', this._onResize);
    this.labels.dispose();
    this.chapterCard.dispose();
    this.briefing.dispose();
    this.deployment.dispose();
    this.results.dispose();
    this.pause.dispose();
    this.dialogue.dispose();
    this.root.remove();
    if (this.opts.disposeStyles) disposeStyles();
  }
}

function partName(p) {
  return ({ head: 'Head', torso: 'Torso', legs: 'Legs', arms: 'Arms', radiator: 'Radiator' })[p] || 'Torso';
}

export default HUD;
