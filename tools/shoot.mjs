#!/usr/bin/env node
// Screenshot client for the visual-critic loop. THIS IS THE ONLY SHOT TOOL.
//
//   node tools/shoot.mjs bridge                     # -> shots/bridge.png
//   node tools/shoot.mjs bridge /tmp/b.png          # explicit out path
//   node tools/shoot.mjs tank,closeup,bridge        # several, one request each
//   node tools/shoot.mjs all --out shots            # all twelve
//   node tools/shoot.mjs --list                     # shot names
//   node tools/shoot.mjs --stop                     # kill the daemon
//   node tools/shoot.mjs --verify bridge            # prove determinism (see below)
//
// It does no rendering itself. It talks to tools/renderd.mjs, a RESIDENT browser
// holding the booted world, and starts that daemon on first use. Read renderd.mjs
// for why — the short version is that the ~7 s of chromium launch + worldgen + 87
// shader compiles is identical for every shot, and paying it per render made every
// harness cost ~12.5 s regardless of which one you used:
//
//     old shoot.mjs      12.5 s / shot
//     old shootBatch     12.2 s / shot (single), ~3.0 s amortised over 12
//     this               ~0.6 s / shot after a one-time ~7 s boot
//
// `--wait` is accepted and ignored: it was measured to buy nothing (`--wait 0` and
// `--wait 3500` produced byte-identical frames) because the daemon holds frames
// until the render counters, the label layer and the temporal DoF converge, then
// freezes the engine before the shutter. `--no-freeze` and `--kill-server` are
// gone; the frozen shutter is what makes frames comparable across rounds, and the
// dev server is deliberately never killed.

import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(`--${n}`);

const PORT = parseInt(flag('port', '5200'), 10);
const ALL = ['overview', 'command', 'action', 'aim', 'firefight', 'tank',
             'village', 'closeup', 'grass', 'dusk', 'bridge', 'squad'];

if (has('list')) { console.log(ALL.join('\n')); process.exit(0); }

const portOpen = (p) => new Promise((res) => {
  const s = net.createConnection({ port: p, host: '127.0.0.1' }, () => { s.end(); res(true); });
  s.on('error', () => res(false));
  s.setTimeout(600, () => { s.destroy(); res(false); });
});

const req = async (path) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
};

/** Start renderd detached and wait for it to answer /health. */
async function ensureDaemon() {
  if (await portOpen(PORT)) return false;
  const proc = spawn(process.execPath, ['tools/renderd.mjs', '--port', String(PORT)], {
    cwd: process.cwd(), stdio: 'ignore', detached: true,
  });
  proc.unref();
  for (let i = 0; i < 160; i++) {                 // up to 80 s for the cold boot
    await new Promise((r) => setTimeout(r, 500));
    if (await portOpen(PORT)) { try { await req('/health'); return true; } catch {} }
  }
  throw new Error(`renderd did not come up on ${PORT} — run \`node tools/renderd.mjs\` to see why`);
}

/**
 * COLD render — one throwaway browser, one shot, no daemon. ~12.5 s.
 *
 * This is the AUTHORITATIVE path and the reason it still exists is measured, not
 * sentimental. Cold renders are byte-identical run to run (0.000% of pixels
 * differing, max delta 0) because a cold boot rebuilds the world's stateful
 * animation — cloud drift, water surface, wind phase, particle pools — from a seed.
 * The resident daemon cannot rewind that state, so it sits at a broad, very
 * low-amplitude offset from cold (measured on `bridge`: 67% of pixels differ but by
 * a mean of only 1.71 LSB) and drifts ~0.37% when another shot is posed in between.
 *
 * Which to use:
 *   ITERATING on a material, a mesh, a shader — resident (the default). 1.6 s, and
 *   a 1.7 LSB broad offset cannot mislead you about form, silhouette or hue, which
 *   move by 10-40 LSB when they change at all.
 *   QUOTING A NUMBER IN A CRITIQUE, or diffing this round against the last — cold.
 *   A cross-round regression smaller than the resident offset is unknowable, which
 *   is the exact trap docs/HARNESS.md's determinism section was written about.
 */
async function coldShoot(shot, out) {
  const { chromium } = await import('playwright');
  const t = Date.now();
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu',
           '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:5173/?capture&shot=${encodeURIComponent(shot)}`, { waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction('window.__READY__ === true', { timeout: 90000 }); }
  catch { errors.push('TIMEOUT waiting for window.__READY__'); }
  const outPath = resolve(out || `shots/${shot}.png`);
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath });
  const stats = await page.evaluate(() => window.__STATS__ || null).catch(() => null);
  await browser.close();
  return { shot, out: outPath, ms: Date.now() - t, cold: true,
           drawCalls: stats?.drawCalls, triangles: stats?.triangles, errors };
}

const main = async () => {
  if (has('stop')) {
    if (!(await portOpen(PORT))) { console.log(JSON.stringify({ renderd: 'not running' })); return; }
    console.log(JSON.stringify(await req('/quit')));
    return;
  }

  const positional = args.filter((a, i) => !a.startsWith('--') &&
    !(i > 0 && args[i - 1].startsWith('--') && ['port', 'out', 'wait', 'w', 'h'].includes(args[i - 1].slice(2))));
  const first = positional[0] || 'overview';
  const shots = first === 'all' ? ALL : first.split(',').map((s) => s.trim()).filter(Boolean);
  const outDir = flag('out', null);
  const explicitOut = positional[1] || null;

  // --cold bypasses the daemon entirely. It still needs vite, which the daemon (or
  // a previous run) normally leaves up; start one if this is a fresh machine.
  if (has('cold')) {
    if (!(await portOpen(5173))) {
      const p = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
        { cwd: process.cwd(), stdio: 'ignore', detached: true });
      p.unref();
      for (let i = 0; i < 80 && !(await portOpen(5173)); i++) await new Promise((r) => setTimeout(r, 250));
    }
    const t0 = Date.now();
    const results = [];
    for (const shot of shots) {
      const out = explicitOut && shots.length === 1 ? explicitOut
        : outDir ? `${outDir}/${shot}.png` : `shots/${shot}.png`;
      results.push(await coldShoot(shot, out));
    }
    const errs = results.flatMap((r) => r.errors);
    console.log(JSON.stringify(shots.length === 1 ? results[0]
      : { shots: results.map(({ shot, ms, errors: e }) => ({ shot, ms, errors: e.length })),
          totalMs: Date.now() - t0, cold: true, errors: errs }, null, 1));
    if (errs.length) process.exitCode = 2;
    return;
  }

  const booted = await ensureDaemon();

  // --verify: prove the resident path is byte-identical to itself across separate
  // requests, which is the property the whole regression-diff method rests on.
  // (Cross-checking against a cold boot is `--verify-cold`, below.)
  if (has('verify')) {
    const shot = shots[0];
    const a = await req(`/shoot?shot=${shot}&out=${encodeURIComponent(`/tmp/claude-501/verify-a-${shot}.png`)}`);
    // Pose a DIFFERENT shot in between, so the second render has to come back
    // through resetShotState() rather than just re-screenshotting a live frame.
    await req(`/shoot?shot=${shot === 'aim' ? 'bridge' : 'aim'}&out=${encodeURIComponent('/tmp/claude-501/verify-mid.png')}`);
    const b = await req(`/shoot?shot=${shot}&out=${encodeURIComponent(`/tmp/claude-501/verify-b-${shot}.png`)}`);
    const A = readFileSync(a.out), B = readFileSync(b.out);
    const identical = A.length === B.length && A.equals(B);
    console.log(JSON.stringify({ verify: shot, identical, bytes: [A.length, B.length],
      note: identical ? 'resident path is reproducible across an intervening shot'
                      : 'NOT reproducible — resetShotState() is missing something this shot mutates' }, null, 1));
    if (!identical) process.exitCode = 3;
    return;
  }

  const t0 = Date.now();
  const results = [];
  for (const shot of shots) {
    const out = explicitOut && shots.length === 1 ? explicitOut
      : outDir ? `${outDir}/${shot}.png` : `shots/${shot}.png`;
    results.push(await req(`/shoot?shot=${shot}&out=${encodeURIComponent(out)}`));
  }
  const totalMs = Date.now() - t0;
  const errors = results.flatMap((r) => r.errors || []);

  console.log(JSON.stringify(shots.length === 1
    ? { ...results[0], daemonBooted: booted }
    : { shots: results.map(({ shot, ms, drawCalls, triangles, convergedAt, errors: e }) =>
          ({ shot, ms, drawCalls, triangles, convergedAt, errors: e.length })),
        totalMs, perShotMs: Math.round(totalMs / shots.length), daemonBooted: booted, errors },
    null, 1));
  if (errors.length) process.exitCode = 2;
};

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
