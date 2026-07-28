// Temporary visual harness for src/ui. Not part of the game build.
import * as THREE from 'three';
import { Bus } from '../core/bus.js';
import { HUD } from './hud.js';

const qs = new URLSearchParams(location.search);
const mode = qs.get('mode') || 'command';

const NAMES_A = ['Welkin Gunther', 'Alicia Melchiott', 'Isara Gunther', 'Largo Potter',
  'Rosie Stark', 'Edy Nelson', 'Jann Walker', 'Marina Wulfstan'];
const CLS = ['scout', 'scout', 'engineer', 'lancer', 'shock', 'shock', 'lancer', 'sniper'];

const mk = (name, cls, team, i) => ({
  name, cls, team,
  hp: team ? 90 - i * 9 : 100 - i * 11, maxHp: 100,
  ap: team ? 300 : 900 - i * 80, maxAp: team ? 400 : 900,
  pos: new THREE.Vector3(team ? 12 + i * 4 : -14 + i * 3.2, 0.2, team ? -18 + i * 2.5 : 10 - i * 2.1),
  yaw: i * 0.7, alive: true, downed: i === 6 && !team, hasActed: i % 3 === 0,
  ammo: 14 - i, magSize: 20, weapon: { name: 'Gallian-2', ammo: 14 - i, mag: 20 },
});

const units = NAMES_A.map((n, i) => mk(n, CLS[i], 0, i))
  .concat(['Imperial Trooper', 'Imperial Lancer', 'Imperial Scout', 'Imperial Ace']
    .map((n, i) => mk(n, ['shock', 'lancer', 'scout', 'sniper'][i], 1, i)));

const battle = {
  phase: 'command', turn: 4, cp: { 0: 7, 1: 6 }, units, selected: units[0],
  endTurn() { console.log('endTurn'); },
};

const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.15, 900);
camera.position.set(-6, 14, 26);
camera.lookAt(0, 1, -4);
camera.updateMatrixWorld(true);

const hud = new HUD(battle, {
  camera,
  mission: {
    chapter: 4, title: 'The Bridge at Vasel', date: 'EW 1935 · Squad 7',
    brief: 'Imperial armour holds the north bank. Take the crossing before the ' +
      'garrison can bring the bridge down, and seize their forward camp.',
    intel: ['One heavy tank sighted behind sandbags.', 'Fog expected at dawn.'],
    camps: [{ id: 'south', name: 'South Camp', slots: 4 }, { id: 'quay', name: 'River Quay', slots: 3 }],
  },
  autoChapter: false,
});

hud.markers = [
  { pos: new THREE.Vector3(0, 1, -40), label: 'Bridge', icon: 'flag' },
  { pos: new THREE.Vector3(34, 1, -12), label: 'Enemy', icon: 'pin', team: 1 },
];
hud.setCapture('camp-n', new THREE.Vector3(4, 1.2, -8), { progress: 0.62, team: 0, label: 'Camp' });
hud.labels.syncTracked(units);

if (mode === 'command') {
  Bus.emit('phase:change', { from: 'menu', to: 'command' });
  setTimeout(() => hud.toast('SQUAD 7 REPORTING'), 100);
}

if (mode === 'action') {
  battle.phase = 'action';
  Bus.emit('phase:change', { from: 'command', to: 'action' });
  Bus.emit('unit:selected', { unit: units[0] });
  Bus.emit('ui:aim', { aiming: true, spread: 0.18, hit: 0.72 });
  hud.setTarget({
    unit: units[8], name: 'Imperial Trooper', cls: 'shock', hp: 62, maxHp: 100,
    distance: 34, hit: 0.72, part: 'head', spread: 0.18, cover: 0.5,
  });
  setTimeout(() => {
    Bus.emit('unit:damaged', { unit: units[8], amount: 47, crit: true, worldPos: units[8].pos });
    Bus.emit('interception', { shooter: units[9], target: units[0] });
  }, 200);
}

if (mode === 'chapter') hud.showChapter({ chapter: 4, title: 'The Bridge at Vasel', place: 'Gallia · Vasel', subtitle: 'The 3rd Regiment marches at dawn.', dwell: 60000 });
if (mode === 'briefing') hud.showBriefing({});
if (mode === 'deploy') hud.showDeployment({});
if (mode === 'results') {
  battle.phase = 'result';
  hud.showResults({
    victory: true, rank: 'A', turns: 4, dp: 1400, exp: 2380,
    casualties: [{ name: 'Jann Walker' }], stats: { kills: 11, captured: 2, shots: 48, hits: 33 },
  });
}
if (mode === 'pause') hud._setPaused(true);
if (mode === 'dialogue') {
  hud.say([
    { name: 'Welkin', seed: 'Welkin Gunther', cls: 'scout', text: 'The bridge is the only crossing for twenty kilometres. If they blow it, Vasel falls.' },
    { name: 'Alicia', seed: 'Alicia Melchiott', cls: 'scout', text: 'Then we take it first. Squad 7, on me!' },
  ]);
}

let last = performance.now();
function loop(t) {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  hud.update(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

setTimeout(() => { window.__READY__ = true; }, 800);
