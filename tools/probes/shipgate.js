// r26 SHIP GATE — still winnable and loseable after the r26 gameplay fixes?
// checkObjectives() runs at TURN BOUNDARIES, not per frame, so every check must end a turn.
const out = { errors: [] };
const { Battle } = await import('/src/game/battle.js');
const { MISSION_VASEL } = await import('/src/game/mission.js');
const { moveWithCollision } = await import('/src/game/nav.js');
const DT = 1 / 60;
vc.engine.paused = true; vc.battle.over = true;
const CAP = vc.CFG.capture; vc.CFG.capture = false;

const mk = () => {
  const b = new Battle(vc.world, vc.scene, { camera: vc.camera, mission: MISSION_VASEL, seed: vc.CFG.seed });
  b.setup(); b.attachCamera(vc.camera); b.beginBattle(); return b;
};
const res = (b) => (b.result ? {
  victory: b.result.victory, rank: b.result.rank, objective: b.result.objective,
  turns: b.result.turns, losses: b.result.losses, kills: b.result.kills, cpSpent: b.result.cpSpent,
} : null);
const runToEnd = (b, cap = 12000) => { let f = 0; while (!b.over && f < cap) { b.update(DT); f++; } return f; };
const sect = (n, fn) => { try { out[n] = fn(); } catch (e) { out[n] = 'THREW: ' + (e && e.stack || e); out.errors.push(n); } };

// ---- 1. WIN: stand a capturer on the flag, end the turn, expect victory ------
sect('win', () => {
  const b = mk(); const r = {};
  const camp = b.camps.find((c) => c.id === 'imperial');
  const cap = b.units.find((u) => u.team === 0 && !u.isVehicle && ['scout', 'shock', 'engineer'].includes(u.cls));
  r.capturer = cap.name + ' (' + cap.cls + ')';
  r.pathFromCapturer = b.nav.findPath({ x: cap.pos.x, z: cap.pos.z }, camp.pos, {}) ? 'reachable' : 'NULL — UNREACHABLE';
  // Clear the defenders so the flag is uncontested, then stand on the pole.
  b.units.filter((u) => u.team === 1 && !u.isVehicle).forEach((u) => u.takeDamage(99999, cap));
  cap.pos.x = camp.pos.x; cap.pos.z = camp.pos.z;
  r.onFlag = b.onFlag ? b.onFlag(cap, camp) : 'n/a';
  b.endTurn();                        // -> enemy phase; objectives evaluate at boundaries
  r.frames = runToEnd(b);
  r.over = b.over; r.result = res(b);
  b.dispose(); return r;
});

// ---- 2. LOSE: destroy the Edelweiss (a stated fail condition) ----------------
sect('loseTank', () => {
  const b = mk(); const r = {};
  const t = b.units.find((u) => u.isVehicle && u.team === 0);
  t.takeDamage(999999, b.units.find((u) => u.team === 1 && u.isVehicle) || null);
  r.tankAlive = t.alive;
  b.endTurn();
  r.frames = runToEnd(b);
  r.over = b.over; r.result = res(b);
  b.dispose(); return r;
});

// ---- 3. LOSE: the whole squad falls -----------------------------------------
sect('loseSquad', () => {
  const b = mk(); const r = {};
  const foe = b.units.find((u) => u.team === 1);
  b.units.filter((u) => u.team === 0 && !u.isVehicle).forEach((u) => u.takeDamage(99999, foe));
  b.endTurn();
  r.frames = runToEnd(b);
  r.over = b.over; r.result = res(b);
  b.dispose(); return r;
});

// ---- 4. The tank's NEW collider must not seal the bridge ---------------------
sect('bridgeStillPassable', () => {
  const b = mk(); const r = {};
  const camp = b.camps.find((c) => c.id === 'imperial');
  r.deployToCamp = b.nav.findPath({ x: 2.75, z: 52.25 }, camp.pos, {}) ? 'ok' : 'NULL';
  r.bridgeSToN = b.nav.findPath({ x: 4, z: 24 }, { x: 4, z: -2 }, {}) ? 'ok' : 'NULL';
  const u = b.units.find((x) => x.team === 0 && !x.isVehicle);
  u.pos.x = 4; u.pos.z = 8;
  const z0 = u.pos.z;
  let billed = 0;
  for (let i = 0; i < 300; i++) billed += moveWithCollision(u.pos, 0, -0.055, 0.36, b.nav, vc.world, 1.75);
  r.netNorth = +(z0 - u.pos.z).toFixed(2);
  r.billed = +billed.toFixed(2);
  r.intended = 16.5;
  r.endedAt = { x: +u.pos.x.toFixed(2), z: +u.pos.z.toFixed(2) };
  b.dispose(); return r;
});

vc.CFG.capture = CAP;
return out;
