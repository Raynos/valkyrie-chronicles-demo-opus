// src/game/mission.js — "The Bridge at Vasel".
//
// The playable mission. Squad 7 holds the south bank of the Vasel river; the Imperials own the
// ruined mill town on the north bank and the only crossing still standing. Take their camp.
//
// COORDINATE FRAME — this must agree with src/world/layout.js, which carves the terrain:
//   +X is east, -Z is NORTH. The player deploys SOUTH, at positive Z (ally zone ~ (-2, 62)).
//   The river runs west-east across z ~ 4..6; the road crosses it on the stone bridge at
//   roughly (4, 5). The ruined village pad is centred (30, -40) r 26 and the Imperial base
//   camp sits inside it at (30, -46). Landmarks: windmill knoll (-42,-48), southern ridge
//   (-34, 58) — the deployment overlook and the best ground for your own marksman — and the
//   eastern rise (64,-26), which is where their sniper will be looking down from.
//   Playable extent is MAP_SIZE 180, i.e. +/-90 m.
//
// Every authored position is snapped to the nearest walkable nav cell by Battle.addUnit, so
// the mission survives whatever the heightfield actually produced for this seed.

import * as THREE from 'three';
import { Bus } from '../core/bus.js';

export const MISSION_VASEL = {
  id: 'vasel-bridge',
  name: 'The Bridge at Vasel',
  chapter: 'Chapter 4',
  subtitle: 'EW 1935 — Vasel, Gallia',

  bounds: { minX: -88, maxX: 88, minZ: -88, maxZ: 88 },
  navCell: 1.5,

  // THE START LINE. Battle.startLineOffset() walks the real nav path from the staging post
  // toward the flag and slides the whole squad this far along it, leaving the camp, the flag,
  // the capture ring and the reinforcement spawn exactly where they are authored.
  //
  // It was 22 m, and 22 m put the front rank at z ~ 40 — 22 m short of the deck. A scout's
  // ENTIRE sortie is 1062 AP at 20 AP/m = 53 m, so the first sortie went 22 m of empty pasture
  // + the 26 m deck and ran dry ON THE NORTH ABUTMENT, in the open, 14 m from two dug-in
  // Sturmtruppen. That is not a hard crossing, it is a rigged one: the AP always died at the
  // worst square on the map. 38 m puts the front rank at the south bridgehead, so ONE sortie
  // buys the whole deck plus most of the far bank — enough to reach the abutment cover in
  // props.js `_buildCrossingCover()` and go to ground there. The crossing becomes one decision
  // you can afford instead of three you cannot.
  //
  // 38 was measured first and is TOO FAR: the slots fan out over the camp's 9 m radius, so at
  // 38 three of the nine landed ON THE DECK — the squad opens the mission standing in the
  // middle of the span with no cover and the whole ruins line looking at it. 30 puts the front
  // rank at the south bridgehead and the rear rank 20 m behind it, which is the picture the
  // opening shot is already framing.
  //
  // Round 21 tried 32 m and rejected it because the squad opened inside five Imperials' sight
  // with a free volley coming. That was measured BEFORE the bridgehead picket was pulled back
  // to the ruins line (below), which moved the nearest Sturmtruppe from 14 m off the deck exit
  // to 42 m off the start line — outside its 26 m sight entirely.
  startLineAdvance: 30,

  cpPlayer: 7,
  cpEnemy: 6,
  deployMax: 6,
  slotsPerCamp: 8,
  autoDeploy: true,
  rankTurns: { A: 6, B: 10, C: 15 },
  // Squad 7 is attacking; the garrison is dug in and only counter-attacks locally. This
  // scales how hard each side's AI is pulled toward the objective it does not yet hold.
  aggression: { 0: 1.0, 1: 0.5 },
  // How far an objective is allowed to pull a soldier. Squad 7 must cross the whole valley;
  // the Imperials only chase what comes within reach of the ground they are holding.
  pushRange: { 0: 999, 1: 52 },
  // Where a side falls back to when it has no reachable objective. This used to be the north
  // bridgehead (8,-14) — i.e. the AI's standing order was to go and stand in the doorway the
  // player has to come through, at point-blank range, with no cover for either side. It is now
  // the RUINS LINE, 8 m further back, where their own parapets are: the abutment is a lodgement
  // to be contested rather than a plug.
  holdPoints: { 1: [10, -22] },
  baseExp: 1120,
  baseDucats: 5200,
  timeOfDay: 0.34,               // late morning, long soft shadows toward the north-east

  briefing: {
    title: 'THE BRIDGE AT VASEL',
    objective: 'Stand a Scout, Trooper or Engineer on the Imperial flag.',
    failure: 'The Edelweiss is destroyed, or the mission runs past 20 turns.',
    intel: [
      'The Vasel bridge is the last intact crossing for forty kilometres.',
      'Imperial infantry hold the mill town in company strength with one medium tank.',
      'There is a gravel ford about twenty metres upstream. Knee deep. Slower, and it puts you '
      + 'on their flank instead of in front of them.',
      'Sandbags on the deck and at the far abutment. Bound from one to the next — do not run the '
      + 'whole span in the open.',
      'A marksman has been reported in the church tower — do not cross the open square standing up.',
      'Their camp falls the moment one of you ends a sortie on the flag with no Imperial beside it.',
    ],
    text:
      'Squad 7 has been ordered to seize the crossing at Vasel before the Imperials can blow it. '
      + 'The far bank is a burned-out mill town: broken walls, a church, and a great deal of open '
      + 'square between you and their camp. Get one soldier onto the flag in the middle of that '
      + 'camp and hold the few metres around it — the rest of the garrison cannot stop you from '
      + 'across the square, only from on top of you. Twenty turns. Bring the tank home.',
  },

  // -------------------------------------------------------------------------
  // Base camps
  // -------------------------------------------------------------------------
  // `radius` is the camp FOOTPRINT — deployment slots, the dug-in defence bonus, the ground
  // the AI walks to. `captureRadius` is the FLAG RING: the ground you have to stand on to
  // take the camp, and the only ground an enemy can stand on to stop you. Contesting on the
  // footprint made this mission mathematically unwinnable for twenty rounds — three Imperials
  // live inside the 9 m circle and never leave it. See FLAG_RING in battle.js.
  camps: [
    {
      // The ally deployment zone from layout.js.
      id: 'gallian', name: 'Gallian Staging Post',
      pos: [-2, 62], radius: 9.0, captureRadius: 3.6, owner: 0, deploy: true,
    },
    {
      // layout.objectives 'camp', inside the ruined village on the north bank.
      id: 'imperial', name: 'Imperial Base Camp',
      pos: [30, -46], radius: 9.0, captureRadius: 3.6, owner: 1, deploy: true,
    },
  ],

  // -------------------------------------------------------------------------
  // Squad 7
  // -------------------------------------------------------------------------
  roster: [
    {
      cls: 'tank', name: 'Edelweiss', team: 0, pos: [-1, 56], yaw: Math.PI,
      commander: true, deployable: false, variant: 'edelweiss', hpScale: 1.0,
      bio: 'Lt. Welkin Gunther commanding. The heart of Squad 7 — lose it and the mission is over.',
    },
    {
      cls: 'scout', name: 'Alicia Melchiott', team: 0, pos: [-8, 58], yaw: Math.PI,
      potentials: ['natureLover', 'hardWorker', 'fancyFootwork'],
      bio: 'Baker, town watch volunteer, and the fastest pair of legs in the squad.',
    },
    {
      cls: 'scout', name: 'Edy Nelson', team: 0, pos: [4, 59], yaw: Math.PI,
      potentials: ['fancyFootwork', 'nightOwl', 'pacifist'],
      bio: 'Wants to be a star. Will not stop talking about it.',
    },
    {
      cls: 'shock', name: 'Rosie Stark', team: 0, pos: [2, 64], yaw: Math.PI,
      potentials: ['braveHeart', 'campDefender', 'undertaker'],
      bio: 'Lounge singer. Hits like a howitzer. Do not get on her wrong side.',
    },
    {
      cls: 'lancer', name: 'Largo Potter', team: 0, pos: [-7, 66], yaw: Math.PI,
      potentials: ['tankHunter', 'ironWill', 'chronicPain'],
      bio: 'Career soldier, farmer, and the only man here who can open a tank like a tin.',
    },
    {
      cls: 'engineer', name: 'Isara Gunther', team: 0, pos: [-2, 69], yaw: Math.PI,
      potentials: ['fieldMedic', 'hardWorker', 'pollenAllergy'],
      bio: 'Darcsen engineer. Built half of the Edelweiss with her own hands.',
    },
    {
      cls: 'sniper', name: 'Marina Wulfstan', team: 0, pos: [-16, 64], yaw: Math.PI,
      potentials: ['sharpshooter', 'mountainBorn', 'loneWolf'],
      bio: 'Speaks to nobody. Has never needed a second shot.',
    },
  ],

  // -------------------------------------------------------------------------
  // Imperial garrison — 10 infantry + 1 medium tank
  // -------------------------------------------------------------------------
  enemies: [
    // THE RUINS LINE — the far bank's defence, pulled back off the bridge mouth.
    //
    // These two Sturmtruppen used to stand at (3,-6) and (10,-10): the first of them 1.7 m from
    // the north end of the deck, both of them ON the road the player must use, at 14-22 m from
    // a 26 m stretch of open masonry. Measured: four of six soldiers died there during the
    // PLAYER'S OWN turn, mid-run, with no cover reachable and no decision available. A picket in
    // the doorway is not difficulty, it is a coin flip you lose.
    //
    // At (3,-19.5) and (14,-20.5) they still cover the whole deck and the abutment — 12-28 m,
    // which is well inside a shocktrooper's reach — but they are dug in behind their own
    // parapets (props.js `_buildEmplacements` builds them there so the danger READS), they can
    // be answered from the abutment cover, and taking the far bank is now a lodgement fight
    // instead of a sprint into a muzzle.
    { cls: 'shock', name: 'Imperial Sturmtruppe', team: 1, pos: [3, -19.5], yaw: 0, potentials: ['campDefender'] },
    { cls: 'shock', name: 'Imperial Sturmtruppe', team: 1, pos: [14, -20.5], yaw: 0, potentials: ['braveHeart'] },
    // The west-bank picket, who is now the man watching the FORD (layout.js `this.ford`) as
    // well as the bridge. He is the reason the second route is a decision and not a freebie.
    { cls: 'scout', name: 'Imperial Späher', team: 1, pos: [-9, -4], yaw: 0, potentials: ['natureLover'] },

    // The mill-town line: the first row of ruins along the road into the village.
    { cls: 'lancer', name: 'Imperial Lanzentruppe', team: 1, pos: [17, -25], yaw: 0, potentials: ['tankHunter'] },
    { cls: 'shock', name: 'Imperial Sturmtruppe', team: 1, pos: [6.5, -26], yaw: 0 },
    { cls: 'scout', name: 'Imperial Späher', team: 1, pos: [27, -17], yaw: -0.6, potentials: ['fancyFootwork'] },

    // Marksman on the eastern rise, looking straight down the village approach.
    { cls: 'sniper', name: 'Imperial Scharfschütze', team: 1, pos: [50, -28], yaw: 0.6, potentials: ['mountainBorn', 'sharpshooter'] },

    // Camp garrison. All three stand in the camp but OFF the flag ring (>= 5.5 m from the
    // pole at (30,-46)), so the garrison is something you fight rather than a permanent
    // veto on the objective. Jaeger used to spawn 2.3 m from the pole and never move.
    { cls: 'lancer', name: 'Imperial Lanzentruppe', team: 1, pos: [23, -41], yaw: 0 },
    { cls: 'engineer', name: 'Imperial Pionier', team: 1, pos: [35, -52], yaw: 0, potentials: ['fieldMedic'] },
    { cls: 'shock', name: 'Hauptmann Jaeger', team: 1, pos: [34, -50], yaw: 0, ace: true, hpScale: 1.6, aimScale: 1.2, potentials: ['campDefender', 'braveHeart', 'undertaker'] },

    // The armour, sitting behind the square where it can cover the whole approach.
    { cls: 'tank', name: 'Imperial Medium', team: 1, pos: [25, -33], yaw: 0, variant: 'lupus' },
  ],

  // -------------------------------------------------------------------------
  // Reinforcements
  // -------------------------------------------------------------------------
  waves: [
    {
      turn: 4, team: 1, camp: 'imperial', label: 'Imperial reserve platoon',
      units: [
        { cls: 'shock', name: 'Imperial Sturmtruppe' },
        { cls: 'scout', name: 'Imperial Späher' },
      ],
    },
    {
      turn: 8, team: 1, camp: 'imperial', label: 'Imperial counter-attack',
      units: [
        { cls: 'shock', name: 'Imperial Sturmtruppe' },
        { cls: 'lancer', name: 'Imperial Lanzentruppe' },
      ],
    },
    // Gallian relief only arrives if you have actually taken ground.
    {
      turn: 6, team: 0, camp: 'imperial', requiresCamp: 'imperial', label: 'Squad 7 second section',
      units: [
        { cls: 'shock', name: 'Wavy Cranston' },
        { cls: 'engineer', name: 'Nancy Dufour' },
      ],
    },
  ],

  // -------------------------------------------------------------------------
  // Win / lose
  // -------------------------------------------------------------------------
  objectives: [
    // Battle.publishObjectives() rewrites this label live — "Stand on their flag: Scout,
    // Trooper or Engineer" / "Clear 2 Imperials off their flag" / "…secured" — so the player
    // is told what the game is waiting for instead of guessing. This is the fallback text.
    { id: 'take-camp', type: 'captureCamp', campId: 'imperial', team: 0, win: true,
      label: 'Stand on their flag: Scout, Trooper or Engineer' },
    { id: 'rout', type: 'rout', team: 1, win: true, label: 'Or destroy every Imperial in the sector' },
    { id: 'lose-tank', type: 'tankDestroyed', team: 0, fail: true, label: 'The Edelweiss must survive' },
    { id: 'lose-camp', type: 'captureCamp', campId: 'gallian', team: 1, fail: true,
      label: 'Do not let them take the staging post' },
    { id: 'timeout', type: 'turnLimit', turns: 20, fail: true, label: 'Twenty turns' },
  ],

  // -------------------------------------------------------------------------
  // Scripted opening
  // -------------------------------------------------------------------------
  // Camera beats are ABSOLUTE world heights, and the valley floor here is not flat: the river
  // pool sits at y=2, the banks at y=7..9, the bridge deck at y=6. A `look` height below the
  // terrain under it aims the shot at the dirt, which is what the first cut of this sequence
  // did three times out of four. Every beat below is checked against the heightfield.
  opening: [
    // Eye level on the lip of the south bank, looking north down the road to the crossing —
    // the same framing as the `overview` capture, so the game opens on its own hero shot.
    { t: 0.0, type: 'camera', pos: [-15, 10.8, 41], look: [8, 9.5, -16], fov: 40, dur: 5.0 },
    { t: 0.3, type: 'title', text: 'THE BRIDGE AT VASEL', sub: 'EW 1935 — Vasel, Gallia' },
    { t: 1.2, type: 'line', who: 'Welkin', text: 'That is the last bridge standing for forty kilometres.' },
    // Down on the water downstream, looking straight through the arches.
    { t: 4.6, type: 'camera', pos: [30, 5.5, 20], look: [5, 5.0, 2], fov: 34, dur: 5.0 },
    { t: 5.0, type: 'line', who: 'Alicia', text: 'And the whole town is looking straight down it.' },
    // Their camp, in the ruins — standing height in the square, not hovering over it.
    { t: 8.4, type: 'camera', pos: [44, 12.4, -62], look: [24, 12.2, -40], fov: 38, dur: 4.2 },
    { t: 8.8, type: 'line', who: 'Imperial officer', text: 'Halten Sie die Brücke. Niemand kommt durch.' },
    // Back to the squad on the start line. `startLineAdvance` slides the squad 30 m up the
    // road from the authored camp, so the last beat has to frame the SOUTH BRIDGEHEAD, not
    // the staging post 30 m behind it — the old beat (86 -> look 62) now looks at an empty
    // pasture with the squad out of shot.
    { t: 12.0, type: 'camera', pos: [-12, 14.5, 50], look: [3, 8.5, 27], fov: 34, dur: 3.0 },
    { t: 12.4, type: 'line', who: 'Welkin', text: 'Squad 7 — take that camp. Watch the square.' },
    { t: 15.0, type: 'end' },
  ],

  dsePerTurn: 300,
};

export const MISSIONS = { [MISSION_VASEL.id]: MISSION_VASEL };

// ---------------------------------------------------------------------------
// Opening-script runner
// ---------------------------------------------------------------------------

const _p = new THREE.Vector3();
const _l = new THREE.Vector3();
const _pFrom = new THREE.Vector3();
const _lFrom = new THREE.Vector3();

/**
 * Drives the scripted opening: moves the camera along authored beats and publishes `dialogue`
 * / `title` events for the UI. Fully skippable. If no camera is supplied it still emits the
 * dialogue so the sequence works headless.
 */
export class MissionScript {
  constructor(battle, camera, script = battle.mission.opening) {
    this.battle = battle;
    this.camera = camera;
    this.script = (script || []).slice().sort((a, b) => a.t - b.t);
    this.t = 0;
    this.index = 0;
    this.running = false;
    this.move = null;
    this.onEnd = null;
  }

  start() {
    if (!this.script.length) { this.finish(); return this; }
    this.running = true;
    this.t = 0;
    this.index = 0;
    Bus.emit('script:begin', { mission: this.battle.mission.id });
    return this;
  }

  skip() {
    if (!this.running) return;
    Bus.emit('script:skip', {});
    this.finish();
  }

  finish() {
    this.running = false;
    this.move = null;
    Bus.emit('script:end', {});
    if (this.onEnd) this.onEnd();
    else this.battle.startDeployment();
  }

  update(dt) {
    if (!this.running) return;
    this.t += dt;
    while (this.index < this.script.length && this.script[this.index].t <= this.t) {
      this.fire(this.script[this.index++]);
      if (!this.running) return;
    }
    if (this.move && this.camera) {
      const m = this.move;
      m.e = Math.min(1, m.e + dt / m.dur);
      const k = m.e * m.e * (3 - 2 * m.e);
      this.camera.position.lerpVectors(_pFrom.copy(m.fromPos), _p.copy(m.toPos), k);
      _l.lerpVectors(_lFrom.copy(m.fromLook), m.toLook, k);
      this.camera.lookAt(_l);
      if (m.fov) {
        this.camera.fov += (m.fov - this.camera.fov) * Math.min(1, dt * 3);
        this.camera.updateProjectionMatrix();
      }
    }
    if (this.index >= this.script.length && (!this.move || this.move.e >= 1)) this.finish();
  }

  fire(beat) {
    switch (beat.type) {
      case 'camera': {
        if (!this.camera) break;
        const toPos = new THREE.Vector3(beat.pos[0], beat.pos[1], beat.pos[2]);
        const toLook = new THREE.Vector3(beat.look[0], beat.look[1], beat.look[2]);
        this.move = {
          fromPos: this.camera.position.clone(),
          fromLook: this.move ? this.move.toLook.clone() : toLook.clone(),
          toPos, toLook, dur: beat.dur || 3, e: 0, fov: beat.fov,
        };
        Bus.emit('camera:script', { pos: toPos, look: toLook, dur: beat.dur || 3, fov: beat.fov });
        break;
      }
      case 'line':
        Bus.emit('dialogue', { who: beat.who, text: beat.text, dur: beat.dur || 3.2 });
        Bus.emit('sfx', { name: 'dialogue' });
        break;
      case 'title':
        Bus.emit('title', { text: beat.text, sub: beat.sub });
        break;
      case 'end':
        this.finish();
        break;
      default:
        Bus.emit(beat.type, beat);
        break;
    }
  }
}

/** Convenience for main.js: build the mission, then run the opening into deployment. */
export function startMission(battle, camera, missionId = MISSION_VASEL.id) {
  battle.mission = MISSIONS[missionId] || MISSION_VASEL;
  battle.setup();
  const script = new MissionScript(battle, camera);
  return script.start();
}

export default MISSION_VASEL;
