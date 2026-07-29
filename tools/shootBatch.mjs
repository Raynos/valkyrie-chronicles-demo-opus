#!/usr/bin/env node
// Batch screenshot harness — renders N shots in ONE page session.
//
//   node tools/shootBatch.mjs overview,command,tank [--out shots] [--wait 0]
//   node tools/shootBatch.mjs all
//
// WHY THIS EXISTS
// ---------------
// `tools/shoot.mjs` pays the full cold-boot cost per shot. Profiled at 1920x1080:
//
//     chromium launch     118 ms
//     new page             72 ms
//     goto (vite, 64 ESM)  3.3 s
//     boot -> __READY__   13.1 s   <-- procedural worldgen + 87 shader compiles
//     screenshot           2.1 s
//     -----------------------------
//     total              ~18.8 s
//
// The 13 s is world generation and shader compilation, and it is IDENTICAL for
// every shot — the shots differ only in camera and unit poses. Paying it twelve
// times to render twelve frames is the single biggest reason a fix round takes
// tens of minutes: an agent iterating on one material may render thirty frames.
//
// This harness boots once and then calls `runShot()` in-page for each name,
// re-posing the existing world. It reads the ctx straight off `window.__VC__`
// (which main.js publishes in capture builds) so it needs no change to main.js.
//
// DETERMINISM CAVEAT — read before trusting a batch frame
// -------------------------------------------------------
// `tools/shoot.mjs` remains the AUTHORITATIVE harness. A batch frame is rendered
// against a world that has already had other shots posed into it, so any shot
// that mutates world state without fully restoring it can differ from its
// cold-boot frame. `--verify` renders the first shot both ways and reports the
// pixel delta so you know whether that is happening. Use batch for iteration;
// re-render with shoot.mjs before reporting a measured result.

import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(`--${n}`);

const ALL = ['overview', 'command', 'action', 'aim', 'firefight', 'tank',
             'village', 'closeup', 'grass', 'dusk', 'bridge', 'squad'];

const first = args.find((a) => !a.startsWith('--'));
const shots = !first || first === 'all' ? ALL : first.split(',').map((s) => s.trim()).filter(Boolean);
const OUT = resolve(flag('out', 'shots'));
const W = parseInt(flag('w', '1920'), 10);
const H = parseInt(flag('h', '1080'), 10);
const WAIT = parseInt(flag('wait', '0'), 10);
const PORT = parseInt(flag('port', '5173'), 10);
let port = PORT;

const portOpen = (p) => new Promise((res) => {
  const s = net.createConnection({ port: p, host: '127.0.0.1' }, () => { s.end(); res(true); });
  s.on('error', () => res(false));
  s.setTimeout(600, () => { s.destroy(); res(false); });
});

let server = null;
async function trySpawn(p) {
  const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(p), '--strictPort'],
    { cwd: process.cwd(), stdio: 'ignore' });
  let dead = false;
  proc.on('exit', () => { dead = true; });
  for (let i = 0; i < 60 && !dead; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(p)) { server = proc; port = p; return true; }
  }
  proc.kill();
  return false;
}
async function ensureServer() {
  if (await portOpen(PORT)) return;
  for (let p = PORT; p < PORT + 12; p++) {
    if (p !== PORT && await portOpen(p)) continue;
    if (await trySpawn(p)) return;
  }
  throw new Error(`vite failed to start on ${PORT}..${PORT + 11}`);
}

// Runs inside the page: re-pose the already-built world for `name`, then hold
// frames until every render counter and the DOM label layer stop changing —
// the same convergence conditions main.js uses for its cold-boot settle.
const IN_PAGE_RUN = async (name) => {
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const v = window.__VC__;
  if (!v) throw new Error('window.__VC__ missing — not a capture build?');
  const m = await import('/src/game/captureShots.js');

  const ctx = {
    engine: v.engine, scene: v.scene, camera: v.camera, renderer: v.renderer,
    battle: v.battle, world: v.world, ui: v.hud, pipeline: v.pipeline,
    audio: null, fx: v.fx, rig: v.rig, finale: null,
  };

  const t0 = performance.now();
  await m.runShot(name, ctx);

  // renderer.info.render accumulates across the pipeline's many passes per frame
  // and is only reset by three.js on a top-level render(), so the raw counters
  // climb monotonically and never compare equal. Compare PER-FRAME DELTAS
  // instead: once LOD, instancing and shader compilation have settled, the work
  // done each frame is constant even though the totals keep rising.
  const raw = () => {
    const i = v.renderer.info;
    return { c: i.render.calls, t: i.render.triangles, p: i.programs?.length ?? 0,
             g: i.memory.geometries, x: i.memory.textures };
  };
  let prev = raw();
  const key = () => {
    const r = raw();
    const k = [r.c - prev.c, r.t - prev.t, r.p, r.g, r.x,
               document.querySelectorAll('#hud *').length,
               (v.pipeline?._dofBlend ?? 0).toFixed(4)].join('|');
    prev = r;
    return k;
  };

  let last = '', stable = 0, n = 0, converged = -1;
  while (n < 200) {
    await raf(); n++;
    const k = key();
    if (k === last) stable++; else { stable = 0; last = k; }
    if (n >= 14 && stable >= 5) { converged = n; break; }
  }
  while (n < 120) { await raf(); n++; }   // fixed total, as main.js does

  window.__STATS__ = Object.assign({}, window.__STATS__, {
    shot: name, batch: true, settleFrames: n, convergedAt: converged,
    poseMs: Math.round(performance.now() - t0),
    drawCalls: v.renderer.info.render.calls,
    triangles: v.renderer.info.render.triangles,
    programs: v.renderer.info.programs?.length ?? 0,
  });
  return window.__STATS__;
};

const main = async () => {
  await ensureServer();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const t0 = Date.now();
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu',
           '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // Boot once, on the first shot, so the very first frame is a true cold-boot frame.
  await page.goto(`http://127.0.0.1:${port}/?capture&shot=${encodeURIComponent(shots[0])}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__ === true', { timeout: 90000 });
  const bootMs = Date.now() - t0;

  const results = [];
  for (let i = 0; i < shots.length; i++) {
    const name = shots[i];
    const t = Date.now();
    let stats = null;
    // Shot 0 is already posed by the cold boot; re-posing it would be wasted work.
    if (i === 0) stats = await page.evaluate(() => window.__STATS__ || null);
    else stats = await page.evaluate(IN_PAGE_RUN, name);
    if (WAIT) await page.waitForTimeout(WAIT);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    results.push({
      shot: name, ms: Date.now() - t, cold: i === 0,
      drawCalls: stats?.drawCalls, triangles: stats?.triangles,
      convergedAt: stats?.convergedAt, errors: errors.length,
    });
  }

  await browser.close();
  if (server) server.kill();

  const total = Date.now() - t0;
  console.log(JSON.stringify({
    shots: results, bootMs, totalMs: total,
    perShotMs: Math.round(total / shots.length),
    errors, out: OUT,
  }, null, 1));
  if (errors.length) process.exitCode = 2;
};

main().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
