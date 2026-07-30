#!/usr/bin/env node
// RESIDENT RENDER DAEMON — the only fast way to shoot this game.
//
//   node tools/renderd.mjs [--port 5200] [--vite 5173] [--w 1920] [--h 1080]
//
// Normally you do not run this by hand: `tools/shoot.mjs` starts it on demand and
// reuses it forever after. `node tools/shoot.mjs --stop` kills it.
//
// WHY THIS EXISTS
// ---------------
// Every previous harness paid the SAME fixed cost on every single render, and it
// dwarfed the render itself. Measured at 1920x1080 with a warm vite server:
//
//     node tools/shoot.mjs bridge        12.5 s
//     node tools/shootBatch.mjs bridge   12.2 s
//
// Both numbers are the same because both do the same thing: launch chromium,
// goto, generate the world, compile ~87 shaders, settle, screenshot, THROW THE
// WHOLE BROWSER AWAY. The old docs claimed 6 s warm; that was stale, and even 6 s
// is ~12x what the actual frame costs.
//
// Nothing about that cost is per-shot. The shots differ only in camera, sun and
// unit poses — a few hundred milliseconds of work against ~7 s of boot. So the
// browser and the built world become RESIDENT, and a shot request re-poses them:
//
//     boot (once per session)      ~7   s
//     per shot after that          ~0.6 s      <- 20x
//
// Three things had to be true first, and all three are now:
//
//  1. THE WORLD MUST RESET BETWEEN SHOTS. A resident world accumulates state, and
//     round 15 proved that bites: `aim` left action-mode's over-the-shoulder
//     camera latched and the next shot inherited it. captureShots.js's
//     resetShotState() now runs at the top of runShot(). Without it a resident
//     renderer is not a speedup, it is a correctness bug.
//  2. THE SETTLE MUST BE CONVERGENCE-DRIVEN, NOT A FIXED FRAME COUNT. The batch
//     harness ran a fixed 120 frames after converging at frame 14 — 106 frames,
//     ~1.8 s, of provably identical output. We stop `MARGIN` frames after the
//     convergence key goes stable, and assert byte-equality against the old
//     path (see tools/shoot.mjs --verify).
//  3. THE SHUTTER MUST STILL BE FROZEN. engine.paused = true before the
//     screenshot, exactly as before; that is what makes frames byte-identical
//     run to run, and it is unaffected by the browser being reused.
//
// Requests are SERIALISED. There is one page, so two concurrent /shoot calls
// would pose over each other. Many agents can share one daemon safely — they
// queue. That is also why the daemon is a better fit than one browser per agent:
// eight agents each booting their own chromium is 8x7 s of boot and 8x the VRAM.

import { chromium } from 'playwright';
import { mkdirSync, existsSync, writeFileSync, unlinkSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const PORT = parseInt(flag('port', '5200'), 10);
const VITE = parseInt(flag('vite', '5173'), 10);
const W = parseInt(flag('w', '1920'), 10);
const H = parseInt(flag('h', '1080'), 10);
/** Frames to hold after the convergence key stops changing. See MARGIN note above. */
const MARGIN = parseInt(flag('margin', '5'), 10);
/** Fixed settle frames per shot. Must stay fixed — see the SETTLE note in IN_PAGE_RUN. */
const SETTLE = parseInt(flag('settle', '24'), 10);
export const PIDFILE = '/tmp/claude-501/vc-renderd.json';

const ALL = ['overview', 'command', 'action', 'aim', 'firefight', 'tank',
             'village', 'closeup', 'grass', 'dusk', 'bridge', 'squad'];

const portOpen = (p) => new Promise((res) => {
  const s = net.createConnection({ port: p, host: '127.0.0.1' }, () => { s.end(); res(true); });
  s.on('error', () => res(false));
  s.setTimeout(600, () => { s.destroy(); res(false); });
});

// ---------------------------------------------------------------- vite
// NOTE: we never kill vite. tools/shootBatch.mjs used to `server.kill()` on exit,
// which meant a batch run POISONED the next render: vite transforms all 65 ES
// modules on first request, so the following `goto` re-paid the full cold
// transform. Leaving it up is the whole reason a warm boot is 7 s and not 20 s.
let vitePort = VITE;
async function ensureVite() {
  if (await portOpen(VITE)) return;
  for (let p = VITE; p < VITE + 12; p++) {
    if (p !== VITE && await portOpen(p)) continue;
    // `--host 127.0.0.1`: vite's default binds `localhost`, which on macOS
    // resolves to ::1 only, while playwright and our probe talk v4.
    const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(p), '--strictPort'],
      { cwd: process.cwd(), stdio: 'ignore', detached: true });
    proc.unref();
    let dead = false;
    proc.on('exit', () => { dead = true; });
    for (let i = 0; i < 80 && !dead; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await portOpen(p)) { vitePort = p; return; }
    }
  }
  throw new Error(`vite failed to start on ${VITE}..${VITE + 11}`);
}

// ---------------------------------------------------------------- in-page
// Re-pose the already-built world for `name`, then hold frames until the render
// counters, the DOM label layer and the pipeline's temporal DoF stop changing.
//
// renderer.info.render accumulates across the pipeline's many passes per frame and
// three.js only resets it on a top-level render(), so the raw counters climb
// monotonically and never compare equal. Compare PER-FRAME DELTAS: once LOD,
// instancing and shader compilation settle, the work done each frame is constant
// even though the totals keep rising.
const IN_PAGE_RUN = async ({ name, margin, settle }) => {
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const v = window.__VC__;
  if (!v) throw new Error('window.__VC__ missing — not a capture build?');
  const m = await import('/src/game/captureShots.js');

  const ctx = {
    engine: v.engine, scene: v.scene, camera: v.camera, renderer: v.renderer,
    battle: v.battle, world: v.world, ui: v.hud, pipeline: v.pipeline,
    audio: null, fx: v.fx, rig: v.rig, finale: null,
  };

  // RESTORE THE VIRTUAL CLOCK. main.js's determinism contract is "identical shot
  // name => identical frame count => identical pixels", and it holds that by
  // stubbing clock.getDelta to a fixed CAPTURE_DT (1/60) for the whole capture.
  // But the end of captureFlow() leaves `getDelta = () => 0` behind, so a resident
  // re-pose would settle at dt = 0 — and main.js's own FREEZE comment records that
  // dt = 0 is NOT inert: the foliage LOD re-streams around the camera on every
  // call, the shadow rig is handed dt = 1 in capture mode so it snaps, and the
  // material registry re-arms once a frame. Settling at dt = 0 for a
  // history-dependent number of calls is exactly why the first resident build
  // measured 0.17-0.97% of pixels differing between two renders of the same shot.
  //
  // Resetting time and frame to a fixed base as well is what makes the shot a pure
  // function of its name again: wind, water and particle phase are all driven from
  // engine.time, so inheriting the previous shot's clock is inheriting its phase.
  // MEASURED, and this is the load-bearing finding of the resident harness:
  //   settle at dt = 1/60 with engine.time reset to 0 .... 76% of pixels differ
  //   settle at dt = 0 (leave the frozen clock in place) ... 0.8% differ
  // Running the clock is WORSE, not better, because resetting `engine.time` does
  // not rewind the simulation — it only relabels it. Cloud drift, water surface,
  // wind phase and the particle pools are STATEFUL, not pure functions of t, so a
  // running settle advances them another N frames from wherever the previous shot
  // left them and every render lands somewhere new. A cold boot is deterministic
  // because it rebuilds that state from a seed; a resident world cannot rewind it.
  //
  // So the settle runs at dt = 0. main.js's FREEZE comment is right that dt = 0 is
  // not perfectly inert — the foliage LOD re-streams per call, the shadow rig snaps,
  // the material registry re-arms — and that residue is the remaining ~0.8%. It is
  // bounded, spatially confined to foliage and water, and it is why this harness is
  // the ITERATION path and `--cold` remains the AUTHORITATIVE one. See docs/HARNESS.md.
  v.engine.clock.getDelta = () => 0;

  // Un-freeze to re-pose: Engine.paused skips system updates, so mixers, wind and
  // LOD would not advance and the new pose would never settle.
  v.engine.paused = false;

  const t0 = performance.now();
  await m.runShot(name, ctx);

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

  // SETTLE A FIXED NUMBER OF FRAMES, not "until converged".
  //
  // Convergence detection is still run, but only as a REPORT (`convergedAt`) and a
  // warning signal — it must not decide when to stop. A convergence-driven stop
  // makes the frame count a function of machine load, and the frame count is
  // precisely what the determinism contract fixes. The old batch harness had this
  // right for the wrong reason: it ran a fixed 120 frames. 120 was ~106 frames of
  // provably identical output past convergence at frame 14, i.e. ~1.8 s of pure
  // waste per shot; but the fixed-ness itself was load-bearing.
  //
  // SETTLE is tuned down to the smallest count that is still byte-identical to the
  // 120-frame frame — verified per shot by tools/shoot.mjs --verify (reproducible
  // across an intervening shot) and --verify-cold (equivalent to a cold boot).
  let last = '', stable = 0, n = 0, converged = -1;
  while (n < settle) {
    await raf(); n++;
    const k = key();
    if (k === last) stable++; else { stable = 0; last = k; }
    if (converged < 0 && n >= 14 && stable >= margin) converged = n;
  }

  // RUN THE FINALE. This was missing, and it silently cost seven of the twelve
  // shots every piece of VFX they were written around.
  //
  // A shot's `finale` is the one or two frames of scripted VFX that must still be
  // burning when the shutter opens — a muzzle flash lives ~0.07 s, a tracer less,
  // so neither can survive the settle loop. main.js runs it AFTER the settle and
  // before the freeze (see its own finale block), and the resident path simply
  // never did: `ctx.finale` was initialised to null above and nothing ever called
  // it. So `firefight`, `action`, `aim`, `tank`, `dusk` and the rest rendered on
  // the fast path with no flash, no tracer and no impact — and every agent that
  // iterated on those shots was looking at a frame the shot's author never
  // intended, while `--cold` (which goes through main.js) showed the real thing.
  // That is a whole class of "the fix did not land" report explained.
  const fin = ctx.finale;
  if (fin) {
    for (let i = 0; i < fin.frames; i++) {
      try { fin.fn(i); } catch (e) { console.warn('[renderd] finale frame', i, e); }
      await raf();
    }
  }

  // Restore the frozen-shutter state main.js leaves behind, so a screenshot taken
  // now is the same draw every time and nothing advances between requests.
  v.engine.clock.getDelta = () => 0;
  v.engine.paused = true;

  window.__STATS__ = Object.assign({}, window.__STATS__, {
    shot: name, resident: true, settleFrames: n, convergedAt: converged,
    poseMs: Math.round(performance.now() - t0),
    drawCalls: v.renderer.info.render.calls,
    triangles: v.renderer.info.render.triangles,
    programs: v.renderer.info.programs?.length ?? 0,
  });
  return window.__STATS__;
};

// ---------------------------------------------------------------- staleness
/**
 * A cheap content digest of everything the page could have imported.
 *
 * mtime+size rather than file contents: this runs before every render and the
 * point is to be free. It cannot miss an edit made by a normal editor or by an
 * agent's Write/Edit, because both change size or mtime. It would miss a
 * same-size same-mtime rewrite, which nothing in this project does.
 */
function sourceDigest(root = resolve('src')) {
  const h = createHash('sha1');
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|glsl|json|css|html)$/.test(e.name)) continue;
      try { const s = statSync(p); h.update(`${p}:${s.size}:${s.mtimeMs}\n`); } catch {}
    }
  };
  walk(root);
  for (const f of ['index.html', 'vite.config.js']) {
    try { const s = statSync(resolve(f)); h.update(`${f}:${s.size}:${s.mtimeMs}\n`); } catch {}
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------- daemon
const main = async () => {
  if (await portOpen(PORT)) { console.error(`renderd already up on ${PORT}`); process.exit(0); }
  await ensureVite();

  const bootT = Date.now();
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu',
           '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  // Console errors are collected PER REQUEST, not for the life of the daemon —
  // otherwise shot 12 inherits shot 1's errors and every plate looks broken.
  let errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://127.0.0.1:${vitePort}/?capture&shot=overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__ === true', { timeout: 90000 });
  const bootMs = Date.now() - bootT;

  // Serialise: one page cannot serve two poses at once.
  let chain = Promise.resolve();
  const queue = (fn) => (chain = chain.then(fn, fn));

  let served = 0;
  let srcDigest = sourceDigest();
  let reloads = 0;

  /**
   * RELOAD THE PAGE WHEN src/ HAS CHANGED SINCE THE FRAME WE ARE SERVING.
   *
   * This daemon booted the page ONCE, and `main.js`'s pinModulesForCapture()
   * deliberately vetoes vite's full reload under ?capture (a mid-render reload
   * once wrote a garbage frame over a good one). Both decisions are individually
   * defensible and together they made the fast path serve THE CODE AS OF DAEMON
   * BOOT, FOREVER.
   *
   * The cost was invisible and large: an agent that edits a material, re-renders
   * on the fast path and looks at the result is looking at its own PRE-EDIT
   * output. It then reports "the fix did not land" — correctly, about a frame
   * that never contained the fix. Only `--cold` (a fresh browser) and an explicit
   * `--stop` were ever telling the truth. Rounds 16-18 iterated this way.
   *
   * The veto stays: reloading mid-render is the bug it was written for. Instead we
   * reload BETWEEN requests, inside the same serialising queue, when and only when
   * the source has actually changed. A recursive mtime+size digest over src/ costs
   * a few ms against a 1.6 s render, so it is free.
   */
  async function reloadIfStale() {
    const d = sourceDigest();
    if (d === srcDigest) return false;
    srcDigest = d;
    reloads++;

    // TEAR THE OLD DOCUMENT DOWN FIRST. `waitForFunction('window.__READY__ ===
    // true')` is satisfied INSTANTLY by the outgoing page, which still has
    // __READY__ = true from its own boot, so a naive goto+wait can return before
    // the new document has finished evaluating and we screenshot a half-built
    // world. Measured while building this: after reverting a magenta-skin test
    // edit, the "reloaded" frame still sat 11.9% away from the correct frame and
    // 84% away from the pre-edit one — a partial reload passed off as a fresh one.
    // about:blank guarantees __READY__ is undefined before we start waiting.
    await page.goto('about:blank');

    // Cache-bust the URL as well: an identical URL lets the browser reuse the
    // document, which is the other half of the same trap.
    await page.goto(`http://127.0.0.1:${vitePort}/?capture&shot=overview&_r=${reloads}`,
      { waitUntil: 'load' });
    await page.waitForFunction('window.__READY__ === true', { timeout: 90000 });
    return true;
  }

  async function doShoot({ shot, out }) {
    const t = Date.now();
    errors = [];
    const reloaded = await reloadIfStale();
    // A reload re-pays world generation and shader compilation, so it is the one
    // request that is not ~1.6 s. Report it rather than let a caller conclude the
    // daemon got slow.
    if (reloaded) errors = [];
    const stats = await page.evaluate(IN_PAGE_RUN, { name: shot, margin: MARGIN, settle: SETTLE });
    const outPath = resolve(out || `shots/${shot}.png`);
    if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath });
    served++;
    return {
      shot, out: outPath, ms: Date.now() - t,
      drawCalls: stats?.drawCalls, triangles: stats?.triangles,
      convergedAt: stats?.convergedAt, settleFrames: stats?.settleFrames,
      poseMs: stats?.poseMs, reloaded, errors: errors.slice(),
    };
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (u.pathname === '/health') {
      return send(200, { ok: true, bootMs, served, vitePort, w: W, h: H, margin: MARGIN, settle: SETTLE, shots: ALL });
    }
    if (u.pathname === '/quit') {
      send(200, { ok: true, served });
      queue(async () => {
        try { await browser.close(); } catch {}
        try { unlinkSync(PIDFILE); } catch {}
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500);
      });
      return;
    }
    if (u.pathname === '/shoot') {
      const shot = u.searchParams.get('shot') || 'overview';
      const out = u.searchParams.get('out');
      if (!ALL.includes(shot)) return send(400, { error: `unknown shot "${shot}"`, shots: ALL });
      return queue(async () => {
        try { send(200, await doShoot({ shot, out })); }
        catch (e) { send(500, { error: String(e && e.stack || e), shot }); }
      });
    }
    send(404, { error: 'use /shoot?shot=NAME&out=PATH, /health or /quit' });
  });

  server.listen(PORT, '127.0.0.1', () => {
    writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, port: PORT, vitePort, bootMs }));
    console.log(JSON.stringify({ renderd: 'up', port: PORT, vitePort, bootMs, w: W, h: H, settle: SETTLE }));
  });

  const bye = async () => { try { await browser.close(); } catch {}; try { unlinkSync(PIDFILE); } catch {}; process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
};

main().catch((e) => { console.error(e); process.exit(1); });
