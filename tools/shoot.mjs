#!/usr/bin/env node
// Screenshot harness for the visual-critic loop.
//
//   node tools/shoot.mjs <shotName> [outPath] [--wait ms] [--w 1920] [--h 1080]
//
// Loads the game with ?capture&shot=<name>, which puts the game into a
// deterministic scripted pose (see src/game/captureShots.js), waits for
// window.__READY__, then writes a PNG.
//
// Shot names are declared in src/game/captureShots.js. `node tools/shoot.mjs --list`
// prints them.

import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(`--${n}`);

const shot = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || 'overview';
const outPath = resolve(args.filter((a) => !a.startsWith('--'))[1] || `shots/${shot}.png`);
const W = parseInt(flag('w', '1920'), 10);
const H = parseInt(flag('h', '1080'), 10);
const WAIT = parseInt(flag('wait', '2500'), 10);
const PORT = parseInt(flag('port', '5173'), 10);
/** The port we actually ended up talking to — see ensureServer(). */
let port = PORT;

async function portOpen(p) {
  return new Promise((res) => {
    const s = net.createConnection({ port: p, host: '127.0.0.1' }, () => { s.end(); res(true); });
    s.on('error', () => res(false));
    s.setTimeout(600, () => { s.destroy(); res(false); });
  });
}

let server = null;

/** Spawn a dev server on `p` and wait for it to answer on 127.0.0.1. */
async function trySpawn(p) {
  // `--host 127.0.0.1` matters: vite's default binds `localhost`, which on macOS
  // resolves to ::1 only, and Playwright/this probe both talk v4.
  const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(p), '--strictPort'], {
    cwd: process.cwd(), stdio: 'ignore', detached: false,
  });
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
  // The requested port can be held by a server we cannot reach (another
  // project's vite bound to ::1 only), in which case --strictPort makes ours
  // exit immediately. Walk forward until one comes up rather than reporting the
  // useless "vite failed to start".
  for (let p = PORT; p < PORT + 12; p++) {
    if (p !== PORT && await portOpen(p)) continue;   // someone else's, skip
    if (await trySpawn(p)) return;
  }
  throw new Error(`vite failed to start on ports ${PORT}..${PORT + 11}`);
}

const main = async () => {
  await ensureServer();
  const browser = await chromium.launch({
    args: [
      '--use-gl=angle', '--use-angle=metal',
      '--enable-gpu', '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu', '--disable-frame-rate-limit',
    ],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  const url = `http://127.0.0.1:${port}/?capture&shot=${encodeURIComponent(shot)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForFunction('window.__READY__ === true', { timeout: 45000 });
  } catch {
    errors.push('TIMEOUT waiting for window.__READY__');
  }
  await page.waitForTimeout(WAIT);

  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath });

  const stats = await page.evaluate(() => window.__STATS__ || null).catch(() => null);
  await browser.close();
  // Leave the dev server UP by default. Killing it here was costing ~13 s per
  // invocation: vite transforms all 64 ES modules on first request, and a fresh
  // server has a cold transform cache, so every shot re-paid a cost that a warm
  // server serves from memory. Measured at 1920x1080:
  //   cold server + cold browser   18.8 s   (goto 3.3 s, boot->__READY__ 13.1 s)
  //   warm server                   6.0 s   (goto 2.6 s, boot->__READY__  3.1 s)
  // The server is reused by the next invocation via portOpen(), so leaving it
  // running is what makes the next shot fast. `--kill-server` opts out for CI
  // or when you genuinely want a clean process tree.
  if (server && has('kill-server')) server.kill();

  console.log(JSON.stringify({ shot, out: outPath, errors, stats }, null, 2));
  if (errors.length) process.exitCode = 2;
};

main().catch((e) => { console.error(e); if (server && has("kill-server")) server.kill(); process.exit(1); });
