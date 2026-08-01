#!/usr/bin/env node
// FRAME TIME AT A REAL DISPLAY RATIO — the one thing shoot.mjs structurally cannot measure.
//
// The capture harness renders at deviceScaleFactor 1, where `renderScale` /
// `budgetPx` is a no-op. A player on a Retina display gets 4x the pixels, and
// r24 raised the resolution without anyone re-measuring frame time afterwards
// (r22's "11-14 ms" numbers were taken at renderScale 0.5, i.e. a quarter of the
// pixels). This measures what the player's machine actually does.
//
//   node tools/frametime.mjs                       # default: dpr 2, three cameras
//   node tools/frametime.mjs --dpr 1 --frames 400
//   node tools/frametime.mjs --w 1920 --h 1080     # maximised-window case
//
// Reports mean / median / p95 / p99 and the fraction of frames over 16.7 ms.
// It samples requestAnimationFrame deltas in the LIVE game (not capture mode),
// after discarding a warmup, so shader compilation and world build are excluded.
import { chromium } from 'playwright';
import net from 'node:net';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const DPR = parseFloat(flag('dpr', '2'));
const W = parseInt(flag('w', '1496'), 10);
const H = parseInt(flag('h', '840'), 10);
const FRAMES = parseInt(flag('frames', '300'), 10);
const WARMUP = parseInt(flag('warmup', '120'), 10);
const REPS = parseInt(flag('reps', '3'), 10);
const PORT = parseInt(flag('port', '5173'), 10);

const portOpen = (p) => new Promise((res) => {
  const s = net.createConnection({ port: p, host: '127.0.0.1' }, () => { s.end(); res(true); });
  s.on('error', () => res(false));
  s.setTimeout(600, () => { s.destroy(); res(false); });
});
if (!(await portOpen(PORT))) {
  console.error(`No vite on ${PORT}. Start it, or run any shoot.mjs render first.`);
  process.exit(1);
}

const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(a.length * q))];
const stat = (ds) => {
  const s = [...ds].sort((a, b) => a - b);
  const mean = ds.reduce((x, y) => x + y, 0) / ds.length;
  return {
    n: ds.length,
    mean: +mean.toFixed(2), median: +pct(s, 0.5).toFixed(2),
    p95: +pct(s, 0.95).toFixed(2), p99: +pct(s, 0.99).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    over16_7: +(100 * ds.filter((d) => d > 16.7).length / ds.length).toFixed(1),
    fps: +(1000 / mean).toFixed(1),
  };
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
         '--enable-unsafe-webgpu', '--disable-frame-rate-limit'],
});

// Sampled inside the page: rAF deltas, warmup discarded.
const SAMPLE = async ({ frames, warmup }) => {
  const ds = [];
  let last = performance.now();
  let i = 0;
  await new Promise((done) => {
    const tick = () => {
      const now = performance.now();
      const dt = now - last; last = now;
      if (i++ > warmup) ds.push(dt);
      if (ds.length >= frames) return done();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const r = window.__VC__ && window.__VC__.renderer;
  return {
    ds,
    drawCalls: r ? r.info.render.calls : null,
    triangles: r ? r.info.render.triangles : null,
    programs: r ? (r.info.programs || []).length : null,
    canvasW: document.querySelector('canvas')?.width ?? null,
    canvasH: document.querySelector('canvas')?.height ?? null,
    cssW: document.querySelector('canvas')?.clientWidth ?? null,
  };
};

const out = { dpr: DPR, css: `${W}x${H}`, reps: REPS, frames: FRAMES, runs: [] };
for (let rep = 0; rep < REPS; rep++) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__VC__ && window.__VC__.renderer, { timeout: 120000 }).catch(() => {});
  // Get past the title/briefing spreads into live gameplay.
  for (const k of ['Enter', 'Enter', 'Enter', 'Enter']) {
    await page.keyboard.press(k).catch(() => {});
    await page.waitForTimeout(700);
  }
  const r = await page.evaluate(SAMPLE, { frames: FRAMES, warmup: WARMUP });
  out.runs.push({
    rep, ...stat(r.ds),
    drawCalls: r.drawCalls, triangles: r.triangles, programs: r.programs,
    backingStore: r.canvasW && r.canvasH ? `${r.canvasW}x${r.canvasH}` : null,
    cssWidth: r.cssW, pageErrors: errs.slice(0, 3),
  });
  await page.close();
}
await browser.close();

const means = out.runs.map((r) => r.mean);
out.repSpread = +(Math.max(...means) - Math.min(...means)).toFixed(2);
out.verdict = out.runs.every((r) => r.mean <= 16.7) ? 'HOLDS 60fps' : 'MISSES 60fps';
console.log(JSON.stringify(out, null, 2));
