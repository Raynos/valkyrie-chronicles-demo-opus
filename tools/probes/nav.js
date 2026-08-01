const out = { errors: [] };
const nav = vc.battle.nav;
const camp = vc.battle.camps.find((c) => c.id === 'imperial');
const gall = vc.battle.camps.find((c) => c.id === 'gallian');
out.camps = vc.battle.camps.map((c) => ({ id: c.id, x: +c.pos.x.toFixed(1), z: +c.pos.z.toFixed(1), owner: c.owner }));
const start = { x: 2.75, y: 0, z: 52.25 };
const nw = (p) => { const i = nav.nearestWalkable(p.x, p.z); return i < 0 ? null : [+nav.worldX(i % nav.w).toFixed(1), +nav.worldZ((i / nav.w) | 0).toFixed(1)]; };
out.walkableStart = nav.walkableAt(start.x, start.z);
out.walkableCamp = nav.walkableAt(camp.pos.x, camp.pos.z);
out.nearestWalkableCamp = nw(camp.pos);
out.nearestWalkableStart = nw(start);

const tries = [
  ['start->camp', start, camp.pos, {}],
  ['start->camp maxNodes 200k', start, camp.pos, { maxNodes: 200000 }],
  ['start->campNear', start, { x: camp.pos.x, z: camp.pos.z + 6 }, { maxNodes: 200000 }],
  ['start->bridgeN', start, { x: 4, z: -2 }, { maxNodes: 200000 }],
  ['start->bridgeS', start, { x: 4, z: 24 }, { maxNodes: 200000 }],
  ['bridgeS->bridgeN', { x: 4, z: 24 }, { x: 4, z: -2 }, { maxNodes: 200000 }],
  ['bridgeN->camp', { x: 4, z: -2 }, camp.pos, { maxNodes: 200000 }],
];
out.paths = [];
for (const [name, a, bb, o] of tries) {
  const t0 = performance.now();
  let p = null, err = null;
  try { p = nav.findPath(a, bb, o); } catch (e) { err = String(e); }
  let len = 0;
  if (p) for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
  out.paths.push({ name, ok: !!p, nodes: p ? p.length : 0, metres: +len.toFixed(1),
    ms: +(performance.now() - t0).toFixed(1), err,
    head: p ? p.slice(0, 3).map((q) => [+q.x.toFixed(1), +q.z.toFixed(1)]) : null,
    tail: p ? p.slice(-3).map((q) => [+q.x.toFixed(1), +q.z.toFixed(1)]) : null });
}

// Reachability: flood from the start and ask how far the camp is.
try {
  nav.floodFill(start, 400, {});
  const gi = nav.nearestWalkable(camp.pos.x, camp.pos.z);
  out.floodToCamp = gi < 0 ? null : nav.reachDist(gi);
} catch (e) { out.errors.push('flood: ' + e); }

// What the AI would do in reverse.
try {
  const p2 = nav.findPath(camp.pos, start, { maxNodes: 200000 });
  out.reverse = p2 ? p2.length : null;
} catch (e) { out.errors.push('rev: ' + e); }
return out;
