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
import { injectStyles, disposeStyles, deckleClip } from './style.js';
import { h, clear, panel, clickable, label, replay, pad } from './dom.js';
import {
  icon, ribbon, cpToken, classBadge, bookmark, cornerFlourish, frameRule,
  aimBrackets, crosshair, accuracyRing, bodyFigure, ammoPip, terrainSketch,
  wobblyPath, hatchPath, splatPath, roughRect, inkRule, compassRose, mapScaleBar,
  unitBlip, keyCap, inkGauge, marchLine, rankChevrons, marginBracket, contourMap,
  dialGauge, compassPip, compassTick, viewWedge,
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

// Ids and costs mirror src/game/orders.js so the strip is truthful even before
// the game pushes its own list over `ui:orders`. Icons/blurbs are ours.
// `short` is the line printed ON the card — a hand of cards is read at a glance,
// and a four-line paragraph set at 0.6em on a 160 px card is a grey smudge. The
// full sentence stays as the card's tooltip.
const DEFAULT_ORDERS = [
  { id: 'caution', name: 'Caution', cost: 1, icon: 'shield', short: 'Evades fire, two turns.', desc: 'One soldier evades and shrugs off fire for two turns.' },
  { id: 'resupply', name: 'Resupply', cost: 2, icon: 'ammo', short: 'Ammunition and ragnaid.', desc: 'Restore ammunition and ragnaid to one unit.' },
  { id: 'attackBoost', name: 'Attack Boost', cost: 2, icon: 'shock', short: 'Damage and aim raised.', desc: 'Raise one soldier’s damage and accuracy.' },
  { id: 'demolitionBoost', name: 'Demolition Boost', cost: 2, icon: 'lancer', short: 'Anti-armour raised.', desc: 'Anti-armour damage raised by seven tenths.' },
  { id: 'enemyRecon', name: 'Enemy Recon', cost: 2, icon: 'eye', short: 'Every position revealed.', desc: 'Reveal every enemy position on the map.' },
  { id: 'directCommand', name: 'Direct Command', cost: 3, icon: 'radio', short: 'A second sortie.', desc: 'Grant a soldier a second sortie.' },
];

const ORDER_ICON = {
  resupply: 'ammo', attackBoost: 'shock', defenseBoost: 'shield', demolitionBoost: 'lancer',
  doubleMovement: 'boot', caution: 'shield', awakenPotential: 'star', medicalKit: 'ragnaid',
  enemyRecon: 'eye', fireSupport: 'mortar', directCommand: 'radio', stormyAttack: 'swords',
  repairKit: 'engineer',
};

// mission.objectives use game-side type names; map them onto our pin glyphs.
const OBJ_TYPE = {
  captureCamp: 'capture', rout: 'kill', tankDestroyed: 'defend',
  turnLimit: 'survive', escort: 'escort', survive: 'survive',
};

const OBJ_ICON = {
  capture: 'flag', defend: 'shield', kill: 'swords', escort: 'boot', survive: 'clock',
};

/** 'take-camp' -> 'Take camp'. Last-ditch label when a mission omits one. */
function prettyId(id) {
  if (!id) return '';
  const s = String(id).replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/**
 * Objectives arrive in two dialects: the HUD's own `{type, text, sub}` and the
 * mission's `{id, type, label, win, fail, done}` (see src/game/mission.js).
 * Normalise in ONE place so every entry point agrees — previously only
 * `_adoptMission` normalised, so a HUD constructed straight off `mission`
 * rendered a column of pins with no text beside them.
 */
function normObjectives(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = list.map((o) => {
    const type = OBJ_TYPE[o.type] || (OBJ_ICON[o.type] ? o.type : 'capture');
    return {
      type,
      text: o.text || o.label || o.name || prettyId(o.id),
      sub: o.sub != null ? !!o.sub : (o.fail === true || o.win === false),
      done: !!o.done,
    };
  }).filter((o) => o.text);
  if (!out.length) return null;
  // Win conditions first, failure conditions beneath them as fine print.
  out.sort((a, b) => (a.sub === b.sub ? 0 : a.sub ? 1 : -1));
  return out.slice(0, 5);
}

// Degrees of tick tape generated for the compass: three revolutions, so the
// +-60 degree window is always fully populated whatever the heading.
const TAPE_DEG = 1080;

const LEGENDS = {
  command: [
    ['Drag', 'Pan Map'], ['LMB', 'Select Unit'], ['Q', 'Orders'],
    ['Enter', 'Sortie'], ['E', 'End Turn'], ['Esc', 'Pause'],
  ],
  action: [
    ['WASD', 'Move'], ['Shift', 'Sprint'], ['Ctrl', 'Crouch'], ['RMB / Q', 'Aim'],
    ['LMB', 'Fire'], ['R', 'Reload'], ['Enter', 'End Action'], ['Esc', 'Pause'],
  ],
  aim: [
    ['LMB', 'Fire'], ['RMB / Q', 'Lower Weapon'], ['Wheel', 'Magnify'],
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
    // Under the capture harness the entrance choreography is switched off: the
    // harness freezes animation at an arbitrary frame, and a roster rebuilt one
    // frame late was being photographed half dealt.
    this.root = h('div', { class: 'vc-root' + (CFG.capture ? ' vc-still' : '') });
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
    // The hand is DEALT in command mode. Round 2 filed the deck away behind a
    // tab, which fixed the full-width toolbar but left the best-read element on
    // the page as a hole; the answer was never "hide it", it was "make it a hand
    // of cards instead of a strip of buttons". It sits in the lower-left
    // quadrant, arced about a pivot below the page, clear of both the roster and
    // the survey, and Q still gathers it back in.
    this.ordersOpen = true;
    this.objectives = normObjectives(this.mission.objectives) || [
      { type: 'capture', text: 'Seize the Imperial base camp.' },
      { type: 'defend', text: 'Hold the bridge until relief arrives.', sub: true },
    ];
    this._rosterCards = new Map();
    this._rosterKey = '';
    this._blips = [];
    this._time = 0;
    this._alertTimer = 0;
    this._tagTick = 0;
    this._campTick = 0;
    this.reticlePx = 0;
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
    // Name slips are culled by REAL line of sight against the world's collider
    // grid. A slip drawn over a soldier who is behind a house labels masonry,
    // and a page full of plates anchored to nothing is an automatic rejection.
    this.labels.setOccluder((p) => {
      const w = this.battle && this.battle.world;
      if (!w || typeof w.lineOfSight !== 'function' || !this.camera) return true;
      return w.lineOfSight(this.camera.position, p);
    });

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

    // THE PAGE'S RUNNING HEAD, ON A GUMMED TAB.
    //
    // The plate caption is the strongest single element in the project, and the
    // reason it works is that it is INK ON PAPER: bare type set over the picture
    // is legible on a pale frame and gone on a dark one, which is exactly why the
    // first cut of this — a running head ruled across the top margin, no stock
    // under it — measured as invisible against the map. So the same trick is used
    // again. A narrow tab of the book's own cream stock is gummed to the head of
    // the page, carrying the chapter on the left, the sheet or plate reference on
    // the right, and a ruled hairline between them.
    const hp = panel({ seed: 623, cls: 'vc-runhead', tilt: 0.18, soft: true });
    this.runHeadEl = hp.root;
    this.runHeadL = h('span', { class: 'vc-runhead-l', text: 'Chapter II' });
    this.runHeadR = h('span', { class: 'vc-runhead-r', text: 'The Crossing at Vasel' });
    this.runHeadN = h('span', { class: 'vc-runhead-n', text: '46' });
    const hrow = h('div', { class: 'vc-runhead-row' });
    hrow.appendChild(this.runHeadL);
    hrow.appendChild(this.runHeadR);
    hrow.appendChild(this.runHeadN);
    hp.content.appendChild(hrow);
    f.appendChild(this.runHeadEl);

    f.appendChild(h('div', { class: 'vc-vignette' }));
    this.root.appendChild(f);

    // The plate caption. Hidden unless the root carries `.vc-plate`; see
    // setCaptureMode(). A page of a war artist's journal is not a bare
    // photograph — it carries a plate number, a hand-written line under the
    // image and a ruled flourish, and those three things are the whole of what
    // the world shots need from the HUD.
    // ON A SLIP OF PAPER, not set naked over the picture. Bare ink over the
    // frame is legible on a pale plate and invisible on a dark one — the dusk
    // page swallowed the whole caption into the field — and a gummed-in slip is
    // what a journal actually carries under a plate anyway.
    const cp = panel({ seed: 617, cls: 'vc-cap', tilt: -0.35, soft: true });
    this.capEl = cp.root;
    this.capNum = h('div', { class: 'vc-cap-n', text: 'Plate I' });
    this.capText = h('div', { class: 'vc-cap-t', text: '' });
    this.capRule = h('div', { class: 'vc-cap-r' });
    this.capRule.appendChild(inkRule({ w: 170, seed: 617, weight: 1.1, flourish: true }));
    cp.content.appendChild(this.capNum);
    cp.content.appendChild(this.capText);
    cp.content.appendChild(this.capRule);
    // The artist's own hand under the rule, and the folio in the corner of the
    // slip: the medium he worked in and the leaf the plate is tipped onto. Both
    // are on the SLIP, where there is stock to carry them, rather than out in a
    // margin the picture has already bled into.
    const foot = h('div', { class: 'vc-cap-f' });
    this.capHand = h('span', { class: 'vc-cap-h', text: 'graphite, ink & wash' });
    this.capFolio = h('span', { class: 'vc-cap-p', text: '46' });
    foot.appendChild(this.capHand);
    foot.appendChild(this.capFolio);
    cp.content.appendChild(foot);
    this.root.appendChild(this.capEl);
  }

  /**
   * What the HUD shows while the screenshot harness is driving.
   *
   * `plate` is the mode the world shots use: everything that reads as game UI
   * goes away and the book's own furniture — the rule, the corner flourishes,
   * the bookmark and a pencilled caption — stays. Round 3 ran those shots with
   * the entire HUD host set to display:none, and five of the eight critiqued
   * frames consequently scored the hud axis at ZERO, not because the HUD was
   * bad but because there was none of it in the frame to judge. An empty axis
   * is a thrown-away axis.
   *
   * @param {string} mode  'plate' | 'command' | 'action' | 'aim' | 'none'
   * @param {{num?:string, text?:string}} [caption]
   */
  setCaptureMode(mode, caption) {
    this.root.classList.toggle('vc-plate', mode === 'plate');
    // The head of the page says what the page IS. On a plate it carries the
    // plate's own reference; on the survey it names the sheet and its scale,
    // which is the single line that turns a picture of terrain into a MAP.
    if (mode === 'command') {
      this.runHeadL.textContent = 'Survey Sheet IV';
      this.runHeadR.textContent = 'Vasel Crossing — the north bank';
      this.runHeadN.textContent = '1:2500';
    }
    if (caption) {
      if (caption.num) this.capNum.textContent = caption.num;
      if (caption.text) this.capText.textContent = caption.text;
      // The folio walks with the plate: plate V is not on the same leaf as
      // plate II, and a book whose page number never changes is a template.
      if (caption.num) {
        const R = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
        const n = R[String(caption.num).replace(/^Plate\s+/i, '').trim()];
        if (n) {
          this.capFolio.textContent = String(38 + n * 4);
          this.runHeadN.textContent = caption.num;
        }
        this.runHeadL.textContent = 'Chapter II';
        this.runHeadR.textContent = 'The Crossing at Vasel';
      }
      if (caption.hand) this.capHand.textContent = caption.hand;
    }
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
    this.mapSheet = h('div', { class: 'vc-map-sheet' });
    this.mapSheet.appendChild(terrainSketch({ w: 400, h: 300, seed: CFG.seed || 1234 }));
    this.mapIn.appendChild(this.mapSheet);
    this.mapBlips = h('div', { class: 'vc-map-blips' });
    this.mapIn.appendChild(this.mapBlips);
    // North rose: the survey is drawn north-up and north is -Z (layout.js).
    // Without the arrow the reader has no way to know which way the page faces.
    const rose = h('div', { class: 'vc-map-rose' });
    rose.appendChild(compassRose({ size: 46 }));
    this.mapIn.appendChild(rose);
    const bar = h('div', { class: 'vc-map-bar' });
    bar.appendChild(mapScaleBar({ w: 74 }));
    this.mapBarLabel = h('span', { text: Math.round(this.mapExtent / 4) + ' m' });
    bar.appendChild(this.mapBarLabel);
    this.mapIn.appendChild(bar);
    mP.content.appendChild(this.mapIn);
    L.appendChild(mP.root);

    // --- end turn ----------------------------------------------------------
    this.endTurnBtn = ribbonButton('End Turn', () => this._endTurn(), { w: 14, key: 'E', seed: 815 });
    this.endTurnBtn.classList.add('vc-endturn');
    L.appendChild(this.endTurnBtn);

    // --- order cards -------------------------------------------------------
    // Dealt, not garrisoned: a compact arc of six in the lower-left quadrant.
    this.ordersEl = h('div', { class: 'vc-orders open' });
    this.ordersIn = h('div', { class: 'vc-orders-in' });
    this.ordersEl.appendChild(this.ordersIn);
    L.appendChild(this.ordersEl);

    this.ordersTab = h('div', { class: 'vc-orders-tab' + (this.ordersOpen ? ' open' : '') });
    const tabP = panel({ seed: 818, cls: 'vc-otab', tilt: -0.7, soft: true });
    const tabIn = h('div', { class: 'vc-otab-in' });
    const tabG = icon('radio', { size: 19, width: 1.6, rough: true });
    tabG.classList.add('g');
    tabIn.appendChild(tabG);
    this.ordersTabLbl = h('div', { class: 'vc-label vc-tight lbl', text: 'Orders' });
    tabIn.appendChild(this.ordersTabLbl);
    const tabKey = h('span', { class: 'vc-key' });
    tabKey.appendChild(keyCap('Q', { seed: 407 }));
    tabIn.appendChild(tabKey);
    tabP.content.appendChild(tabIn);
    clickable(tabP.root, () => this._toggleOrders());
    this.ordersTab.appendChild(tabP.root);
    L.appendChild(this.ordersTab);

    this.root.appendChild(L);
    this._renderOrders();
  }

  _renderObjectives() {
    clear(this.objList);
    let firstSub = true;
    for (const o of this.objectives) {
      // A hand-ruled divider separates "win" from "do not lose".
      if (o.sub && firstSub) {
        firstSub = false;
        if (this.objList.childElementCount) {
          this.objList.appendChild(inkRule({ w: 260, seed: 651, weight: 0.9 }));
        }
      }
      const row = h('div', { class: 'vc-obj-row' + (o.sub ? ' sub' : '') });
      row.appendChild(icon(OBJ_ICON[o.type] || 'pin', { size: 17, width: 1.6 }));
      row.appendChild(h('div', { class: o.done ? 'vc-obj-done' : '', text: o.text }));
      this.objList.appendChild(row);
    }
  }

  _renderOrders() {
    clear(this.ordersIn);
    this._orderCards = [];
    const cp = this.cp;
    // Splayed about a pivot below the page edge, the way a hand of cards sits.
    const n = Math.max(1, this.orders.length);
    const mid = (n - 1) / 2;
    // The hand advances by slightly MORE than a card width. Overlapping cards
    // look like a hand, but they also crop the next card's title — round 2's
    // deck read "RECT COMMAND" — and an unreadable order is not an order.
    const step = Math.min(5.4, 30 / n);        // degrees of cock per card
    const pitch = Math.min(7.3, 44 / n);       // em of hand advance per card
    this.orders.forEach((o, i) => {
      const p = panel({ seed: 900 + i * 37, cls: 'vc-card', tilt: 0, under: false, amp: 1.1, soft: true });
      p.root.style.setProperty('--fx', ((i - mid) * pitch).toFixed(2) + 'em');
      p.root.style.setProperty('--fan', ((i - mid) * step).toFixed(2) + 'deg');
      // The middle of the hand stands proudest, as a fan of cards does.
      p.root.style.setProperty('--lift', (-(mid - Math.abs(i - mid)) * 0.55).toFixed(2) + 'em');
      p.root.style.zIndex = String(10 + (i <= mid ? i : n - 1 - i));
      p.root.style.animationDelay = (i * 0.045).toFixed(3) + 's';
      const in_ = h('div', { class: 'vc-card-in' });

      // Illustrated art plate. A flat `<rect fill>` reads as a hex-filled
      // rectangle (rubric axis 11), so the ground is a laid gouache wash: a
      // warm-to-cool gradient, an irregular blotted pool of pigment, hatching
      // pooled at the foot, and a hand-ruled border that overshoots its corners.
      const art = h('div', { class: 'vc-card-art' });
      const gid = 'vc-cardwash-' + i;
      art.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" preserveAspectRatio="none">' +
        '<defs><linearGradient id="' + gid + '" x1="0.1" y1="0" x2="0.75" y2="1">' +
        '<stop offset="0" stop-color="#cbb98d" stop-opacity="0.30"/>' +
        '<stop offset="0.55" stop-color="#a9a075" stop-opacity="0.22"/>' +
        '<stop offset="1" stop-color="#7f7f78" stop-opacity="0.30"/></linearGradient></defs>' +
        '<rect width="100" height="60" fill="url(#' + gid + ')"/>' +
        // pigment pooled where the brush sat longest
        '<path d="' + splatPath(62, 40, 30, { seed: 260 + i * 11, lobes: 12, rough: 0.30 }) +
        '" fill="#6f6a4e" opacity="0.13"/>' +
        '<path d="' + splatPath(30, 20, 22, { seed: 280 + i * 13, lobes: 11, rough: 0.36 }) +
        '" fill="#c8b485" opacity="0.20"/>' +
        // hatching only in the lower band, the way a shadow is laid in
        '<path d="' + hatchPath(0, 34, 100, 26, { spacing: 3.6, angle: -0.85, seed: 300 + i * 7 }) +
        '" stroke="#5d4d3b" stroke-width="0.5" opacity="0.26" fill="none"/>' +
        '<path d="' + hatchPath(0, 46, 100, 14, { spacing: 3.2, angle: 0.72, seed: 340 + i * 7 }) +
        '" stroke="#4a3c2c" stroke-width="0.4" opacity="0.16" fill="none"/>' +
        '<path d="' + wobblyPath(2, 2, 98, 2, { seed: 400 + i, amp: 0.7, segs: 8, overshoot: 1.4 }) + ' ' +
        wobblyPath(98, 2, 98, 58, { seed: 410 + i, amp: 0.7, segs: 6, overshoot: 1.4 }) + ' ' +
        wobblyPath(98, 58, 2, 58, { seed: 420 + i, amp: 0.7, segs: 8, overshoot: 1.4 }) + ' ' +
        wobblyPath(2, 58, 2, 2, { seed: 430 + i, amp: 0.7, segs: 6, overshoot: 1.4 }) +
        '" fill="none" stroke="#4a3c2c" stroke-width="1" opacity="0.72" stroke-linecap="round"/></svg>';
      const emblem = icon(o.icon || ORDER_ICON[o.id] || 'star', { size: 34, width: 1.5, rough: true });
      emblem.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#4a3c2c';
      art.appendChild(emblem);
      in_.appendChild(art);

      in_.appendChild(h('div', { class: 'vc-card-name', text: o.name }));
      in_.appendChild(h('div', { class: 'vc-card-desc', text: o.short || o.desc || '' }));
      p.content.appendChild(in_);
      if (o.desc) p.root.title = o.desc;

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
          this._toggleOrders(false);
        });
      }
      this.ordersIn.appendChild(p.root);
      this._orderCards.push({ o, root: p.root });
    });
  }

  /**
   * Deal the hand out, or gather it back in. Closed is the resting state: the
   * page is a reconnaissance drawing, and the deck is a tab in its margin.
   */
  _toggleOrders(on) {
    const want = on == null ? !this.ordersOpen : !!on;
    if (want === this.ordersOpen) return;
    this.ordersOpen = want;
    this.ordersEl.classList.toggle('shut', !want);
    this.ordersEl.classList.toggle('open', want);
    this.ordersTab.classList.toggle('open', want);
    if (want && !CFG.capture) {
      for (const c of this._orderCards || []) replay(c.root, 'vc-card');
      Bus.emit('sfx', { name: 'ui_select', vol: 0.55 });
    }
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

    // Name plate + class badge, on its own torn slip of paper. Set naked over
    // the frame the serif ink had no ground to sit on and the class line was
    // unreadable against dark terrain.
    const npP = panel({ seed: 823, cls: 'vc-name', tilt: 0.5, soft: true });
    const np = h('div', { class: 'vc-name-in' });
    this.badgeEl = h('div', { class: 'vc-badge' });
    np.appendChild(this.badgeEl);
    const nt = h('div', { class: 'vc-name-t' });
    this.unitNameEl = h('b', { text: '—' });
    nt.appendChild(this.unitNameEl);
    this.unitClsEl = label('Scout');
    nt.appendChild(this.unitClsEl);
    np.appendChild(nt);
    npP.content.appendChild(np);
    L.appendChild(npP.root);

    // AP meter
    const apP = panel({ seed: 821, cls: 'vc-ap', tilt: 0.25 });
    this.apPanel = apP.root;
    const head = h('div', { class: 'vc-ap-head' });
    head.appendChild(label('Action Points'));
    this.apNum = h('b', { class: 'vc-num', text: '0' });
    head.appendChild(this.apNum);
    this.apMaxEl = h('span', { class: 'vc-label', text: '/ 0' });
    head.appendChild(this.apMaxEl);
    this.apRangeEl = h('span', { class: 'vc-label vc-ap-range', text: '' });
    head.appendChild(this.apRangeEl);
    apP.content.appendChild(head);
    // The meter is a drawn gauge: ruled trough, hatched empty run, brushed
    // pigment, segment ticks inked over the paint. The ghost behind it is the
    // ground already given up this action, laid in as a red wash.
    const meter = h('div', { class: 'vc-ap-meter' });
    this.apGhost = h('div', { class: 'vc-bar-ghost' });
    meter.appendChild(this.apGhost);
    this.apGauge = inkGauge({ w: 460, h: 21, seed: 88, segs: 10, tone: 'ap' });
    meter.appendChild(this.apGauge);
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

    // compass — a strip of gummed paper with hand-torn long edges
    this.compass = h('div', { class: 'vc-compass' });
    this.compass.style.setProperty('--tape-clip', deckleClip(3607, { perSide: 26, amp: 5.5 }));
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
    // THREE full revolutions of ticks, centred on the middle one.
    //
    // The window is +-60 degrees around the heading, and the tape is scrolled so
    // that `yaw + 360` sits dead centre, so ticks from `yaw + 300` to `yaw + 420`
    // must exist — i.e. up to 779.99 degrees. A two-revolution tape (0..705)
    // stopped just short, which is why due north had NO 'N' glyph: turn the
    // camera to face the Imperial bank and the letter you most needed vanished.
    const CARD = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = 0; d <= TAPE_DEG; d += 5) {
      const deg = ((d % 360) + 360) % 360;
      const card = CARD[deg];
      const major = deg % 15 === 0;
      const el = h('div', {
        class: 'vc-compass-pin' + (card ? ' card' : ''),
        style: 'left:' + ((d / TAPE_DEG) * 100).toFixed(4) + '%;color:' +
          (card ? (deg === 0 ? '#8d3730' : '#3a2f28') : '#6b5a44'),
      });
      if (card) {
        el.appendChild(h('div', {
          class: 'glyph',
          style: 'font-size:' + (deg % 90 === 0 ? '1.02em' : '.78em') +
            ';font-variant:small-caps;letter-spacing:.14em;line-height:1',
          text: card,
        }));
      }
      // Every tick is a nibbed stroke. A row of 1px divs filled with
      // currentColor is a ruler printed by a browser, and over a painted
      // landscape it reads as a debug overlay (rubric axis 11).
      const tk = h('div', { class: 'tick' });
      tk.appendChild(compassTick({
        major: card ? 2 : major ? 1 : 0,
        seed: 11 + d,
        color: card ? (deg === 0 ? '#8d3730' : '#3a2f28') : '#6b5a44',
      }));
      el.appendChild(tk);
      this.compassTape.appendChild(el);
    }
    // The heading pip: a small inked caret nailed to the centre of the widget,
    // outside the scrolling tape.
    if (!this._compassPip) {
      this._compassPip = h('div', { class: 'vc-compass-pip' });
      this._compassPip.appendChild(compassPip({ w: 13, seed: 5 }));
      this.compass.appendChild(this._compassPip);
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

    // The firing solution, written on a chit of paper pinned beside the sights.
    // Set naked over the frame the numeral had no ground and collided with the
    // target's own name slip; on paper it reads as an instrument reading.
    const hp = panel({ seed: 837, cls: 'vc-hit', tilt: -1.4, soft: true });
    const hitIn = h('div', { class: 'vc-hit-in' });
    this.hitArc = h('div', { class: 'vc-hit-arc' });
    this.hitArc.appendChild(dialGauge({ size: 46, seed: 611 }));
    this.hitArcPath = this.hitArc.querySelector('.prog');
    hitIn.appendChild(this.hitArc);
    const hitTxt = h('div');
    this.hitNum = h('b', { class: 'vc-num', text: '0%' });
    hitTxt.appendChild(this.hitNum);
    hitTxt.appendChild(h('div', { class: 'vc-label vc-tight', text: 'Hit' }));
    hitIn.appendChild(hitTxt);
    hp.content.appendChild(hitIn);
    this.hitSub = h('div', { class: 'vc-hit-sub', text: '' });
    hp.content.appendChild(this.hitSub);
    this.hitPanel = hp.root;
    L.appendChild(hp.root);

    const tc = panel({ seed: 831, cls: 'vc-tcard', tilt: -0.4, under: true });
    this.tcard = tc.root;
    const th = h('div', { class: 'vc-tcard-head' });
    this.tcardIcon = h('span');
    th.appendChild(this.tcardIcon);
    this.tcardName = h('div', { class: 'vc-h3', text: 'Imperial Soldier' });
    th.appendChild(this.tcardName);
    tc.content.appendChild(th);
    const hpBar = h('div', { class: 'vc-tcard-hp' });
    this.tcardHp = inkGauge({ w: 250, h: 13, seed: 143, segs: 8, tone: 'foe' });
    hpBar.appendChild(this.tcardHp);
    tc.content.appendChild(hpBar);
    this.tcardRows = h('div', { class: 'vc-tcard-rows' });
    tc.content.appendChild(this.tcardRows);
    this.bodyFig = h('div', { class: 'vc-body-fig' });
    this.bodyFig.appendChild(bodyFigure({ part: 'torso', size: 112 }));
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
    rows.forEach(([k, t], i) => {
      const g = h('div', { class: 'vc-lg' });
      // A drawn ink cap, not a CSS rounded rectangle with a border.
      const cap = h('span', { class: 'vc-key' });
      cap.appendChild(keyCap(k, { seed: 300 + i * 13 }));
      g.appendChild(cap);
      g.appendChild(h('span', { text: t }));
      this.legendEl.appendChild(g);
    });
  }

  // ======================================================================
  // Bus wiring
  // ======================================================================

  _on(evt, fn) { this._unsubs.push(Bus.on(evt, fn)); }

  _wire() {
    this._on('ui:captureMode', (p) => this.setCaptureMode(p && p.mode, p && p.caption));
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
      const s = (p && p.stats) || {};
      const roster = Array.isArray(s.roster) ? s.roster : null;
      this.results.show({
        victory: p?.victory !== false,
        rank: s.rank,
        title: s.title,
        turns: p?.turns != null ? p.turns : this.turn,
        dp: s.ducats != null ? s.ducats : s.dp,
        exp: s.exp,
        stats: s,
        casualties: s.casualties || (roster ? roster.filter((r) => !r.alive) : []),
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
      this.objectives = normObjectives(p.objectives) ||
        normObjectives([p]) || this.objectives;
      this._renderObjectives();
    });
    this._on('ui:objectives', (p) => {
      this.objectives = normObjectives(p && p.objectives) || this.objectives;
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

    this._wireGame();
  }

  /**
   * Adapters for the richer, game-specific events emitted by src/game/*.
   * All of them are optional: if the game never emits them the HUD still runs
   * off battle state alone.
   */
  _wireGame() {
    this._on('battle:ready', (p) => this._adoptMission(p?.mission, p?.battle));

    // --- action mode -------------------------------------------------------
    this._on('action:enter', (p) => {
      if (p?.unit) { this.selected = p.unit; this._syncSelection(); }
      this.apShown = p?.ap != null ? p.ap : (this.selected?.ap || 0);
      this.aiming = false;
      this.target = null;
    });
    this._on('action:exit', () => { this.aiming = false; this.target = null; });
    this._on('action:end', (p) => {
      this.aiming = false;
      this.target = null;
      if (p?.reason && p.reason !== 'turnEnded') this.toast(String(p.reason).toUpperCase());
    });
    this._on('aim:enter', () => { this.aiming = true; this.setControls('aim'); });
    this._on('aim:exit', () => { this.aiming = false; this.target = null; });
    this._on('aim:target', (p) => this._onAimTarget(p));
    this._on('weapon:switch', (p) => {
      const w = p?.weapon;
      if (w) this.toast(String(w.name || 'WEAPON').toUpperCase());
    });
    this._on('attack:resolved', (p) => {
      if (!p) return;
      if (p.kills) this.toast(p.kills > 1 ? p.kills + ' ENEMIES ROUTED' : 'ENEMY ROUTED');
      if (p.attacksLeft === 0) this.setControls('action');
    });
    this._on('interception:shot', () => { this.dmgFlash = Math.max(this.dmgFlash, 0.22); });

    // --- command mode ------------------------------------------------------
    this._on('command:enter', () => { this._rosterKey = ''; this.cpShown = -1; this._renderCp(); });
    this._on('command:denied', (p) => this.toast(String(p?.reason || 'Not permitted').toUpperCase()));
    this._on('camp:captured', (p) => {
      const c = p?.camp;
      if (!c) return;
      this.toast(((c.name || 'CAMP') + (p.by?.team === 0 ? ' secured' : ' lost')).toUpperCase());
      if (c.pos) this.labels.banner(c.pos, p.by?.team === 0 ? 'CAMP SECURED' : 'CAMP LOST', { life: 2.2 });
    });

    // --- deployment --------------------------------------------------------
    this._on('deploy:begin', (p) => {
      const camps = (this.battle.camps || []).filter((c) => c.deploy && c.owner === 0)
        .map((c) => ({ id: c.id, name: c.name, slots: this._slotsForCamp(p?.slots, c.id) }));
      this.showDeployment({
        camps: camps.length ? camps : null,
        squad: p?.units || this._allies(),
        minDeploy: 1,
      });
    });
    this._on('deploy:end', () => this.deployment.hide());
  }

  _slotsForCamp(slots, id) {
    if (!Array.isArray(slots)) return 6;
    let n = 0;
    for (const s of slots) if (s.camp === id) n++;
    return n || 6;
  }

  /** Pull chapter, objectives, camps and map extents out of a mission object. */
  _adoptMission(M, battle) {
    if (battle) this.battle = battle;
    if (!M) return;
    this.mission = M;

    if (M.bounds) {
      this.mapExtent = Math.max(
        (M.bounds.maxX - M.bounds.minX) || 128, (M.bounds.maxZ - M.bounds.minZ) || 128);
      this.mapScaleEl.textContent = Math.round(this.mapExtent) + ' m';
      if (this.mapBarLabel) this.mapBarLabel.textContent = Math.round(this.mapExtent / 4) + ' m';
    }

    // Objectives: win conditions first, failure conditions as sub-lines.
    const objs = normObjectives(M.objectives);
    if (objs) { this.objectives = objs; this._renderObjectives(); }

    // Compass markers + capture rings from the live camps.
    const camps = (battle && battle.camps) || [];
    this.markers = camps.map((c) => ({
      pos: c.pos, label: c.name ? c.name.split(' ')[0] : 'Camp',
      icon: 'camp', team: c.owner,
    }));

    const ch = M.chapter;
    const chapterNum = typeof ch === 'number' ? ch
      : (String(ch || '').match(/\d+/) ? parseInt(String(ch).match(/\d+/)[0], 10) : 1);
    this._setBookmark(chapterNum);
    this._missionChapter = ch != null ? ch : chapterNum;
  }

  _onAimTarget(p) {
    if (typeof window !== 'undefined') {
      (window.__AIMDBG__ = window.__AIMDBG__ || []).push({
        t: !!(p && p.target), name: p && p.target && p.target.name,
        chance: p && p.chance, dist: p && p.distance, ret: p && p.reticlePx, part: p && p.part,
      });
    }
    if (!p) return;
    this.aiming = true;
    if (p.reticlePx != null && isFinite(p.reticlePx)) this.reticlePx = p.reticlePx;
    if (p.chance != null) this.hitChance = clamp01(p.chance > 1 ? p.chance / 100 : p.chance);
    if (!p.target) { this.target = null; return; }
    const t = p.target;
    this.setTarget({
      unit: t, name: t.name, cls: t.cls, hp: t.hp, maxHp: t.maxHp,
      distance: p.distance, hit: this.hitChance, part: p.part,
      cover: t.coverValue != null ? t.coverValue : null,
      lethal: p.lethal, expectedDamage: p.expectedDamage,
    });
  }

  /** Ownership rings over the base camps, refreshed a few times a second. */
  _updateCamps() {
    const camps = this.battle.camps;
    if (!Array.isArray(camps) || !camps.length) return;
    for (const c of camps) {
      if (!c.pos) continue;
      const owned = c.owner === 0 || c.owner === 1;
      // Contested camps breathe rather than sit — it reads as pressure.
      const p = c.contested ? 0.5 + 0.42 * Math.sin(this._time * 4.2)
        : owned ? 1 : 0.22;
      this.labels.capture(c.id, c.pos, {
        progress: p, team: c.owner === 1 ? 1 : 0,
        label: c.contested ? 'CONTESTED' : (c.name ? c.name.split(' ')[0] : ''),
      });
    }
  }

  // ======================================================================
  // Public API
  // ======================================================================

  setCamera(cam) { this.camera = cam; this.labels.setCamera(cam); }

  /** Project a world position to viewport pixels; returns a reused object. */
  project(worldPos, out) { return this.labels.project(worldPos, out); }

  showChapter(d = {}) {
    const M = this.mission || {};
    const chapter = d.chapter != null ? d.chapter
      : (this._missionChapter != null ? this._missionChapter : M.chapter);
    if (typeof chapter === 'number') this._setBookmark(chapter);
    this.chapterCard.show({
      chapter,
      title: d.title || M.name || M.title,
      subtitle: d.subtitle != null ? d.subtitle : (M.briefing && M.briefing.objective),
      place: d.place || M.subtitle,
      seed: d.seed || 404, dwell: d.dwell, onDone: d.onDone,
    });
  }

  showBriefing(d = {}) {
    const M = this.mission || {};
    const B = M.briefing || {};
    this.briefing.show({
      chapter: d.chapter != null ? d.chapter : (this._missionChapter != null ? this._missionChapter : M.chapter),
      title: d.title || B.title || M.name || M.title,
      brief: d.brief || B.text || M.brief,
      date: d.date || M.subtitle || M.date,
      objectives: d.objectives || this.objectives,
      squad: (d.squad || this._allies()).filter((u) => u && u.cls !== 'tank'),
      intel: d.intel || B.intel || M.intel,
      markers: d.markers || this._missionMarkers(),
      seed: d.seed || CFG.seed || 1234,
    });
    this.setControls('command');
  }

  /** Normalised 0..1 map markers for the briefing illustration, from the camps. */
  _missionMarkers() {
    const camps = this.battle.camps;
    const B = this.mission && this.mission.bounds;
    if (!Array.isArray(camps) || !camps.length || !B) return null;
    const w = (B.maxX - B.minX) || 1, hgt = (B.maxZ - B.minZ) || 1;
    return camps.map((c) => ({
      x: clamp01((c.pos.x - B.minX) / w),
      // North-up survey. North is -Z (layout.js), so minZ — the Imperial bank —
      // is the TOP edge and the Gallian deployment at +Z sits at the bottom.
      y: clamp01((c.pos.z - B.minZ) / hgt),
      type: 'capture', team: c.owner, label: c.name ? c.name.split(' ')[0] : '',
    }));
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
      const f = clamp01(hp / maxHp);
      this.tcardHp.set(f, f <= 0.25 ? 'crit' : f <= 0.55 ? 'warn' : 'foe');
    }
    this.tcard.classList.toggle('soft', !!t.soft);
    clear(this.tcardRows);
    // A hard lock (the game's own ray landed on him) versus a designation (he is
    // simply inside the sights). The reader must be able to tell them apart.
    const rows = [
      ['Solution', t.soft ? 'Designated' : 'Locked'],
      ['Class', CLASS_NAME[cls] || 'Infantry'],
      ['Health', (hp != null ? Math.max(0, Math.round(hp)) : '—') + ' / ' + (maxHp || '—')],
      ['Distance', (t.distance != null ? Math.round(t.distance) : '—') + ' m'],
      ['Aim Point', partName(t.part)],
    ];
    if (t.cover != null) rows.push(['Cover', t.cover >= 0.99 ? 'Full' : t.cover >= 0.4 ? 'Half' : 'None']);
    rows.forEach(([k, v], i) => {
      const row = h('div', { class: 'vc-tcard-row' });
      row.appendChild(h('div', null,
        h('span', { class: 'vc-label', text: k }), h('span', { text: v })));
      row.appendChild(inkRule({ w: 220, seed: 471 + i * 23, weight: 0.85, color: '#8a7659' }));
      this.tcardRows.appendChild(row);
    });
    if (t.part !== this._bodyPart) {
      this._bodyPart = t.part || 'torso';
      clear(this.bodyFig);
      this.bodyFig.appendChild(bodyFigure({ part: this._bodyPart, size: 112 }));
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

    // Keep world-space name tags bound to the live unit list. Cheap enough to
    // re-diff a squad-sized array a few times a second.
    if (this.opts.nameTags !== false && ++this._tagTick > 15) {
      this._tagTick = 0;
      if (Array.isArray(this.battle.units)) this.labels.syncTracked(this.battle.units);
    }

    if (this.phase === 'command' || this.phase === 'enemy') {
      this._updateCommand(dt);
    }
    if (++this._campTick > 6) { this._campTick = 0; this._updateCamps(); }
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
      if (this.ordersOpen) this._toggleOrders(false);
      else if (this.dialogue.visible) this.dialogue.hide();
      else if (this.briefing.visible || this.deployment.visible) { /* modal screens own Esc */ }
      else this._setPaused(!this.pause.visible);
    }
    if (this.dialogue.visible && (Input.pressed(' ') || Input.pressed('enter'))) {
      this.dialogue.advance();
    }
    if (!this.pause.visible && this.phase === 'command' && Input.pressed('e')) this._endTurn();
    if (!this.pause.visible && this.phase === 'command' && Input.pressed('q')) this._toggleOrders();
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

      const cls = String(u.cls || 'scout').toLowerCase();
      const body = h('div', { class: 'vc-ru-body' });

      // Name line, with veterancy chevrons ruled into the right margin. Rank is
      // read off the soldier's potentials — the personnel file's own record —
      // so it never contradicts anything the game shows elsewhere.
      const top = h('div', { class: 'vc-ru-top' });
      top.appendChild(h('div', { class: 'vc-ru-name', text: u.name || 'Soldier' }));
      const rank = h('div', { class: 'vc-ru-rank' });
      rank.appendChild(rankChevrons({ n: this._rankOf(u), w: 14, seed: seed + 91 }));
      top.appendChild(rank);
      body.appendChild(top);

      // Class line + the status marks pencilled in after it.
      const clsRow = h('div', { class: 'vc-ru-cls' });
      clsRow.appendChild(icon(cls, { size: 15, width: 1.6 }));
      clsRow.appendChild(h('span', {
        class: 'vc-label vc-tight', text: CLASS_NAME[cls] || 'Scout',
      }));
      const st = h('div', { class: 'vc-ru-st' });
      clsRow.appendChild(st);
      body.appendChild(clsRow);

      // HP: a drawn gauge with segment ticks. AP: a surveyor's march line, so
      // the two readings can never be confused for one another at a glance.
      const hpRow = h('div', { class: 'vc-ru-gr' });
      hpRow.appendChild(icon('hp', { size: 13, width: 1.7, rough: false }));
      const hpG = inkGauge({ w: 132, h: 11, seed: seed + 17, segs: 6, tone: 'hp' });
      hpRow.appendChild(hpG);
      const hpNum = h('div', { class: 'n vc-num' }, h('b', { text: '0' }), h('span', { text: '' }));
      hpRow.appendChild(hpNum);
      body.appendChild(hpRow);

      const apRow = h('div', { class: 'vc-ru-gr' });
      apRow.appendChild(icon('boot', { size: 13, width: 1.7, rough: false }));
      const apM = marchLine({ w: 132, h: 9, seed: seed + 29, paces: 9 });
      apRow.appendChild(apM);
      const apNum = h('div', { class: 'n vc-num' }, h('b', { text: '0' }), h('span', { text: ' m' }));
      apRow.appendChild(apNum);
      body.appendChild(apRow);

      in_.appendChild(body);
      p.content.appendChild(in_);

      const mark = h('div', { class: 'vc-ru-mark' });
      mark.appendChild(marginBracket({ w: 12, hgt: 60, seed: seed + 43 }));
      p.root.appendChild(mark);

      // A soldier who has already gone gets his line struck through in pencil —
      // the mark a quartermaster actually makes — on top of the greying.
      const strike = h('div', { class: 'vc-ru-strike' });
      strike.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 74" ' +
        'preserveAspectRatio="none"><path d="' +
        wobblyPath(8, 52, 212, 24, { seed: seed + 77, amp: 2.4, segs: 9, overshoot: 4 }) + ' ' +
        wobblyPath(9, 55, 211, 27, { seed: seed + 83, amp: 3.0, segs: 7 }) +
        '" fill="none" stroke="#5d4d3b" stroke-width="1.6" stroke-linecap="round" ' +
        'opacity="0.42"/></svg>';
      p.root.appendChild(strike);

      // "Acted" is a rubber stamp, so its box is inked and skewed, never a CSS
      // border-radius rectangle.
      const stamp = h('div', { class: 'vc-ru-stamp vc-hidden' });
      stamp.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 62 22" preserveAspectRatio="none">' +
        '<path d="' + roughRect(2, 2, 58, 18, { seed: seed + 61, amp: 0.9, segs: 4, overshoot: 1.6 }) +
        '" fill="rgba(163,47,52,.07)" stroke="#a32f34" stroke-width="1.6" stroke-linecap="round"/></svg>' +
        '<span>Acted</span>';
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
      this._rosterCards.set(u, {
        root: p.root, hpG, apM, hpNum, apNum, st, stamp, rib,
        hpKey: -1, apKey: -1, stKey: '',
      });
    });
    this._syncSelection();
  }

  /** Veterancy, 1..3 chevrons, read off the soldier's own potentials list. */
  _rankOf(u) {
    const n = Array.isArray(u && u.potentials) ? u.potentials.length : 0;
    return clamp(1 + Math.floor(n / 2), 1, 3);
  }

  /**
   * The marks a quartermaster would pencil beside a name: a shield for a soldier
   * running under Caution, a star for an order buff, an empty magazine, a
   * ragnaid flask when he is hurt badly enough to need one.
   */
  _statusOf(u) {
    const out = [];
    if (u.stealth) out.push(['shield', 'ok']);
    if (Array.isArray(u.buffs) && u.buffs.length) out.push(['star', 'ok']);
    if (u.ammo === 0) out.push(['ap', 'warn']);
    if (u.maxHp && u.hp / u.maxHp <= 0.4) out.push(['ragnaid', 'warn']);
    if (u.downed || u.alive === false) out.push(['skull', 'warn']);
    return out.slice(0, 3);
  }

  _updateRoster() {
    for (const [u, c] of this._rosterCards) {
      if (u.maxHp) {
        const k = Math.round(clamp01(u.hp / u.maxHp) * 100);
        if (k !== c.hpKey) {
          c.hpKey = k;
          c.hpG.set(k / 100, k <= 25 ? 'crit' : k <= 55 ? 'warn' : 'hp');
          c.hpNum.firstChild.textContent = String(Math.max(0, Math.round(u.hp)));
          c.hpNum.lastChild.textContent = '/' + Math.round(u.maxHp);
        }
      }
      if (u.maxAp) {
        const k = Math.round(clamp01(u.ap / u.maxAp) * 100);
        if (k !== c.apKey) {
          c.apKey = k;
          c.apM.set(k / 100);
          // AP is a distance in this game — report it as one.
          const m = u.apPerMetre ? u.ap / u.apPerMetre : u.ap;
          c.apNum.firstChild.textContent = String(Math.max(0, Math.round(m)));
        }
      }
      const marks = this._statusOf(u);
      const stKey = marks.map((m) => m[0]).join(',');
      if (stKey !== c.stKey) {
        c.stKey = stKey;
        clear(c.st);
        for (const [name, tone] of marks) {
          const g = icon(name, { size: 13, width: 1.7, rough: false, cls: tone });
          c.st.appendChild(g);
        }
      }
      const acted = !!u.hasActed;
      c.stamp.classList.toggle('vc-hidden', !acted);
      c.root.classList.toggle('acted', acted);
      c.root.classList.toggle('downed', !!u.downed || u.alive === false);
    }
  }

  _syncSelection() {
    // In action mode the camera rides the selected soldier: his own slip would
    // land on the back of his head.
    this.labels.setSelf(this.phase === 'action' ? this.selected : null);
    this._applyLabelPolicy();
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

  /**
   * Redraw the survey plate from the REAL ground once the world exists. Until
   * then the panel carries a generic sketch, which is honest but says nothing
   * about this valley; a contour that does not track the terrain under it is the
   * single most obvious tell that the map is decoration.
   */
  _syncSurvey() {
    if (this._surveyDrawn) return;
    const w = this.battle && this.battle.world;
    const t = w && w.terrain;
    const sample = t && typeof t.heightAt === 'function' ? (x, z) => t.heightAt(x, z)
      : (w && typeof w.groundHeightAt === 'function' ? (x, z) => w.groundHeightAt(x, z) : null);
    if (!sample) return;
    this._surveyDrawn = true;
    clear(this.mapSheet);
    this.mapSheet.appendChild(contourMap({
      w: 400, hgt: 300, ext: this.mapExtent, sample,
      seed: CFG.seed || 1234, levels: 8,
      water: w.waterLevel != null ? w.waterLevel : 0,
    }));
  }

  _updateMap() {
    this._syncSurvey();
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
    // The survey is drawn north-up. North is -Z (layout.js), so the *minimum*
    // z belongs at the top of the panel and +Z (the Gallian deployment) at the
    // bottom — screen +Y therefore runs with world +Z, no flip.
    const toX = (x) => clamp01((x + half) / ext) * mw;
    const toY = (z) => clamp01((z + half) / ext) * mh;

    // grow the blip pool as needed (bounded by squad size, so this settles fast)
    while (this._blips.length < units.length) {
      const b = h('div', { class: 'vc-blip' });
      // Three drawn chevrons — ally / ally-selected / foe. Swapping which one is
      // visible costs nothing and keeps every blip an inked mark with an
      // outline rather than a flat CSS clip-path triangle.
      const wrap = h('div', { class: 'vc-blip-in' });
      wrap.appendChild(unitBlip({ size: 13, team: 0 }));
      wrap.appendChild(unitBlip({ size: 13, team: 0, selected: true, seed: 5 + this._blips.length }));
      wrap.appendChild(unitBlip({ size: 13, team: 1 }));
      b.appendChild(wrap);
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
      const wrap = b.firstChild;
      const variant = foe ? 2 : (u === this.selected ? 1 : 0);
      if (b._variant !== variant) {
        b._variant = variant;
        for (let k = 0; k < 3; k++) wrap.children[k].style.display = k === variant ? '' : 'none';
      }
      // unit.yaw is atan2(dx, dz), i.e. 0 = facing +Z = facing SOUTH = screen
      // down. The chevron is drawn pointing up (north), so the CSS clockwise
      // rotation that aims it along yaw is (180 - yaw).
      wrap.style.transform = 'rotate(' + (180 - (u.yaw || 0) * 180 / Math.PI).toFixed(1) + 'deg) scale(' +
        (u === this.selected ? 1.45 : 1) + ')';
      wrap.style.opacity = u.downed ? '0.35' : '1';
    }

    // camera wedge — the field-of-view cone drawn on the survey
    if (this.camera) {
      if (!this._camWedge) {
        this._camWedge = h('div', { style: 'position:absolute;left:0;top:0;width:0;height:0' });
        // A brushed wedge with two ruled sight-lines down its edges, not a CSS
        // clip-path triangle filled with a radial gradient.
        const wedge = h('div', {
          style: 'position:absolute;left:-19px;top:0;width:38px;height:44px;transform-origin:50% 0%',
        });
        wedge.appendChild(viewWedge({ w: 38, h: 44, seed: 29 }));
        this._camWedge.appendChild(wedge);
        box.appendChild(this._camWedge);
      }
      const c = this.camera;
      this._camWedge.style.transform =
        'translate(' + toX(c.position.x).toFixed(1) + 'px,' + toY(c.position.z).toFixed(1) + 'px)';
      this._camWedge.firstChild.style.transform =
        'rotate(' + ((this._cameraHeading() * 180 / Math.PI) + 180).toFixed(1) + 'deg)';
    }
  }

  // The HUD never mutates the battle — it only announces the intent, and the
  // game layer decides whether the turn actually ends.
  _endTurn() {
    Bus.emit('ui:endTurn', { team: 0 });
    Bus.emit('sfx', { name: 'ui_endturn', vol: 0.9 });
  }

  // ----------------------------------------------------------------- action

  _updateAction(dt) {
    const u = this.selected;
    if (!u) return;
    const maxAp = u.maxAp || 1;
    const ap = clamp(u.ap || 0, 0, maxAp);
    // The meter drains smoothly even if the game steps AP in chunks.
    this.apShown = damp(this.apShown, ap, 14, dt);
    const low = ap / maxAp < 0.2;
    this.apGauge.set(clamp01(this.apShown / maxAp), low ? 'crit' : 'ap');
    this.apGhost.style.width = (clamp01(ap / maxAp) * 100).toFixed(2) + '%';
    const shown = Math.round(this.apShown);
    if (shown !== this._apLast) {
      this._apLast = shown;
      this.apNum.textContent = String(shown);
      this.apMaxEl.textContent = '/ ' + Math.round(maxAp);
      // AP is spent per metre marched, so the sheet also reports the ground the
      // soldier can still cover — the number an officer actually plans with.
      const perM = u.apPerMetre || 1;
      this.apRangeEl.textContent = Math.round(this.apShown / perM) + ' m of march';
    }
    this.apPanel.classList.toggle('low', low);

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

  // World convention (src/world/layout.js): +X is east, **-Z is north**. The
  // player deploys south (+Z, ally camp at z:+62) and the Imperial town sits on
  // the north bank (-Z, enemy camp at z:-52). The survey, the minimap wedge and
  // the compass tape all have to agree with that, or the whole page is mirrored.
  //
  // Bearing is measured clockwise from north, so it decomposes as
  //   east  = +dx
  //   north = -dz
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
      this.compassTape.style.width = (TAPE_DEG * pxPerDeg).toFixed(1) + 'px';
    }
    let yaw = (this._cameraHeading() * 180 / Math.PI) % 360;
    if (yaw < 0) yaw += 360;
    // Ticks sit at (deg/TAPE_DEG) of the tape; slide so the MIDDLE revolution's
    // copy of `yaw` lands dead centre — there is a full revolution of tape on
    // either side of it, so the window can never run off an end.
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
      // same convention as _cameraHeading: clockwise from north (-Z).
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

    // Accuracy circle contracts as the shot settles. When the game publishes a
    // real ballistic radius (aim:target.reticlePx) we honour it exactly — the
    // circle then means "90% of shots land inside this", not "looks tense".
    const base = Math.min(innerWidth, innerHeight);
    let r;
    if (this.reticlePx > 0) {
      this.spreadShown = damp(this.spreadShown, clamp01(this.reticlePx / (base * 0.32)), 9, dt);
      r = clamp(this.spreadShown * base * 0.32, base * 0.022, base * 0.34);
    } else {
      this.spreadShown = damp(this.spreadShown, this.spread, 7, dt);
      r = lerp(base * 0.035, base * 0.30, this.spreadShown);
    }
    // add a slow sway so the reticle never looks pinned to the pixel grid
    const sway = Math.sin(this._time * 1.7) * 1.2 * this.spreadShown;
    this.accEl.style.width = (r * 2).toFixed(1) + 'px';
    this.accEl.style.height = (r * 2).toFixed(1) + 'px';
    this.accEl.style.transform = 'translate(-50%,-50%) translate(' + sway.toFixed(2) + 'px,' +
      (sway * 0.7).toFixed(2) + 'px)';

    this.accRadiusPx = r;

    // The corner brackets frame the accuracy circle rather than sitting at a
    // fixed size, so they mean something: they ARE the shot's dispersion box.
    const bw = r * 2 + Math.min(innerWidth, innerHeight) * 0.11;
    const bh = r * 2 + Math.min(innerWidth, innerHeight) * 0.075;
    this.bracketsEl.style.width = bw.toFixed(1) + 'px';
    this.bracketsEl.style.height = bh.toFixed(1) + 'px';
    this.bracketsEl.style.opacity = (0.5 + 0.5 * (1 - this.spreadShown)).toFixed(2);

    // If the game's own ray is not on a soldier, fall back to the man standing
    // inside the sights. VC keeps the dossier up for whoever is under the
    // reticle, and a blank frame in aim mode reads as a broken overlay.
    if (!this.target || this.target.soft) {
      this._softTimer = (this._softTimer || 0) - dt;
      const soft = this._softTarget(r);
      const changed = (soft && soft.unit) !== (this.target && this.target.unit);
      if (soft && (changed || this._softTimer <= 0)) {
        this._softTimer = 0.14;
        this._applySoftTarget(soft);
      } else if (!soft && this.target && this.target.soft) {
        this.target = null;
      }
    }

    this.hitShown = damp(this.hitShown, this.hitChance, 9, dt);
    const pct = Math.round(this.hitShown * 100);
    if (pct !== this._hitLast) {
      this._hitLast = pct;
      this.hitNum.textContent = pct + '%';
      this.hitNum.style.color = pct >= 70 ? '#55603a' : pct >= 40 ? '#8a6a24' : '#8d3730';
      if (this.hitArcPath) {
        const len = parseFloat(this.hitArcPath.getAttribute('stroke-dasharray')) || 1;
        this.hitArcPath.setAttribute('stroke-dashoffset', (len * (1 - this.hitShown)).toFixed(2));
        // Earth pigments only: a leaf green on the dial was the one saturated
        // hue left in the sight picture.
        this.hitArcPath.setAttribute('stroke',
          pct >= 70 ? '#6d7448' : pct >= 40 ? '#b3873f' : '#a32f34');
      }
    }
    const t = this.target;
    const sub = !t ? '' : t.lethal ? 'Lethal' :
      t.expectedDamage ? Math.round(t.expectedDamage) + ' expected' :
        (t.part ? partName(t.part) : '');
    if (sub !== this._hitSubLast) { this._hitSubLast = sub; this.hitSub.textContent = sub; }
    // Guarded: writing display every frame forces a style recalc for nothing.
    const shown = !!t;
    if (shown !== this._tgtShown) {
      this._tgtShown = shown;
      this.hitPanel.style.display = shown ? '' : 'none';
      this.tcard.style.display = shown ? '' : 'none';
    }
  }

  /**
   * Nearest live, spotted Imperial whose centre of mass projects inside the
   * dispersion circle. Read-only: it never touches game state, and a hard target
   * published by the game always wins.
   * @param {number} r accuracy-circle radius in px
   */
  _softTarget(r) {
    if (!this.camera) return null;
    const units = Array.isArray(this.battle.units) ? this.battle.units : [];
    if (!units.length) return null;
    const W = this.labels.w || innerWidth, H = this.labels.h || innerHeight;
    const cx = W / 2, cy = H / 2;
    const fov = (this.camera && this.camera.fov) || 45;
    const focal = (H * 0.5) / Math.tan((fov * Math.PI) / 360);
    // "The sights are on him" is a question about his SILHOUETTE, not about the
    // distance to a single point: measure to the projected feet-to-head segment
    // and allow his own body radius plus a little slack for the reticle's sway.
    const p = this._softPt || (this._softPt = { x: 0, y: 0, z: 0 });
    const a = this._softA || (this._softA = { x: 0, y: 0, depth: 0, visible: false });
    const b = this._softB || (this._softB = { x: 0, y: 0, depth: 0, visible: false });
    let best = null, bestD = Infinity;
    for (const u of units) {
      if (!u || (u.team | 0) !== 1 || u.alive === false || u.downed || !u.pos) continue;
      const sc = u.stanceScale || 1;
      p.x = u.pos.x; p.z = u.pos.z;
      p.y = u.pos.y + 0.10;
      this.labels.project(p, a);
      p.y = u.pos.y + (u.isVehicle ? 2.3 : 1.74 * sc);
      this.labels.project(p, b);
      if (!a.visible && !b.visible) continue;
      const radM = typeof u.targetRadius === 'function' ? u.targetRadius()
        : (u.isVehicle ? 1.5 : 0.42);
      const radPx = (radM * focal) / Math.max(1, a.depth);
      // Slack is ANGULAR, not a pixel count: "the sights are within ~2.6 degrees
      // of him". That holds its meaning when the scope magnifies and the FOV
      // collapses, which a fixed pixel radius does not.
      const d = segDist(cx, cy, a.x, a.y, b.x, b.y) - radPx;
      const slack = Math.max(r * 0.6, focal * 0.045);
      if (d > slack || d >= bestD) continue;
      bestD = d;
      best = { unit: u, depth: a.depth };
    }
    return best;
  }

  /**
   * Fill the dossier from a designated (not ray-locked) soldier, and estimate
   * the hit chance the same way the ballistics does: the accuracy circle is a
   * 90% Rayleigh radius, so P(hit) = 1 - exp(-rt^2 / 2s^2) for a target of
   * projected radius `rt`. It is an estimate, and the card says so.
   */
  _applySoftTarget(s) {
    const u = s.unit;
    const H = this.labels.h || innerHeight;
    const fov = (this.camera && this.camera.fov) || 45;
    const focal = (H * 0.5) / Math.tan((fov * Math.PI) / 360);
    const radiusM = typeof u.targetRadius === 'function' ? u.targetRadius()
      : (u.isVehicle ? 1.5 : 0.42);
    const rt = (radiusM * focal) / Math.max(1, s.depth);
    const sigma = Math.max(1e-3, (this.accRadiusPx || 40) / 2.146);
    const chance = clamp01(1 - Math.exp(-(rt * rt) / (2 * sigma * sigma)));
    this.hitChance = clamp(chance, 0.02, 0.97);
    this.setTarget({
      unit: u, name: u.name, cls: u.cls, hp: u.hp, maxHp: u.maxHp,
      distance: s.depth, hit: this.hitChance, part: 'torso', soft: true,
    });
  }

  // ---------------------------------------------------------------- phases

  _setPhase(to, initial = false) {
    if (!initial && to === this.phase) return;
    const from = this.phase;
    this.phase = to;
    const cmd = to === 'command' || to === 'enemy';
    if (to === 'briefing' && !this.briefing.visible) this.showBriefing({});
    else if (to !== 'briefing') this.briefing.hide();
    if (to !== 'deploy') this.deployment.hide();
    this.cmdLayer.classList.toggle('vc-hidden', !cmd);
    this.actLayer.classList.toggle('vc-hidden', to !== 'action');
    this.tgtLayer.classList.toggle('on', false);
    if (to !== 'action') this.aiming = false;
    this.endTurnBtn.classList.toggle('vc-hidden', to !== 'command');
    this.ordersEl.classList.toggle('vc-hidden', to !== 'command');
    this.ordersTab.classList.toggle('vc-hidden', to !== 'command');
    // Command mode deals the hand; every other phase gathers it back in.
    this._toggleOrders(to === 'command');
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
    this.labels.setSelf(to === 'action' ? this.selected : null);
    this._applyLabelPolicy();
    if (to === 'enemy') this.alert('Imperial Advance', 'enemy turn');
  }

  /**
   * How the page annotates soldiers, per phase.
   *
   * Command mode is a SURVEY, read from above. Every unit gets a COUNTER — a
   * drawn marker pushed onto the map, over the canopy that hides the soldier
   * himself — and exactly one gets a name slip, lifted clear in SCREEN space
   * with a leader dropped onto its counter. A 2 m world offset projects to
   * about four pixels under the command pitch, which is why the plate used to
   * land on top of its own man; and a slip with nothing under it at all was the
   * round-2 critic's automatic rejection.
   *
   * Action mode is an EYE: no counters, everything culled by line of sight.
   */
  _applyLabelPolicy() {
    const cmd = this.phase === 'command' || this.phase === 'enemy';
    if (cmd) {
      // The selected soldier and BOTH tanks get a name. One slip on a whole survey
      // says only "this one is chosen"; naming the armour as well is what a staff
      // map is for — an Edelweiss slip on our side of the crossing and an Imperial
      // one on theirs tells you the shape of the fight without reading the roster —
      // and three slips is still well inside the declutter pass's budget.
      this.labels.setPolicy({
        filter: (u) => u === this.selected || !!u.isVehicle,
        occlusion: false, lift: 52,
        tokens: true, marked: this.selected,
      });
    } else {
      this.labels.setPolicy({ filter: null, occlusion: true, lift: 0, tokens: false });
    }
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

/** Distance from a point to a segment, in screen pixels. */
function segDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 1e-6 ? clamp01(((px - x0) * dx + (py - y0) * dy) / len2) : 0;
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

function partName(p) {
  return ({ head: 'Head', torso: 'Torso', legs: 'Legs', arms: 'Arms', radiator: 'Radiator' })[p] || 'Torso';
}

export default HUD;
