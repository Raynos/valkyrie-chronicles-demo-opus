#!/usr/bin/env node
// Scene introspection harness for the lighting loop.
//
//   node tools/probe.mjs <shotName> <scriptFile> [--wait 3000]
//
// Loads ?capture&shot=<name>, waits for window.__READY__, then evaluates
// <scriptFile> INSIDE the page with `vc` (= window.__VC__) in scope and prints
// whatever it returns as JSON. The pipeline publishes __VC__ under ?capture.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a) => !a.startsWith('--'));
const shot = pos[0] || 'tank';
const scriptFile = pos[1];
const WAIT = parseInt(flag('wait', '3000'), 10);
const PORT = parseInt(flag('port', '5173'), 10);
let port = PORT;

async function portOpen(p) {
  return new Promise((res) => {
    const s = net.createConnection({ port: p, host: '127.0.0.1' }, () => { s.end(); res(true); });
    s.on('error', () => res(false));
    s.setTimeout(600, () => { s.destroy(); res(false); });
  });
}
let server = null;
async function trySpawn(p) {
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
  for (let p = PORT; p < PORT + 12; p++) {
    if (p !== PORT && await portOpen(p)) continue;
    if (await trySpawn(p)) return;
  }
  throw new Error(`vite failed to start on ports ${PORT}..${PORT + 11}`);
}

const main = async () => {
  await ensureServer();
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu',
           '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://127.0.0.1:${port}/?capture&shot=${encodeURIComponent(shot)}`,
    { waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction('window.__READY__ === true', { timeout: 45000 }); }
  catch { errors.push('TIMEOUT waiting for __READY__'); }
  await page.waitForTimeout(WAIT);

  const body = readFileSync(scriptFile, 'utf8');
  let out;
  try {
    out = await page.evaluate(`(async () => { const vc = window.__VC__; ${body}\n})()`);
  } catch (e) { out = { PROBE_ERROR: String(e && e.stack || e) }; }

  // Optional diagnostic frame, taken AFTER the script has mutated the scene.
  const outPng = flag('out', null);
  if (outPng) { await page.waitForTimeout(400); await page.screenshot({ path: outPng }); }

  await browser.close();
  if (server) server.kill();
  console.log(JSON.stringify({ shot, errors, out }, null, 2));
};

main().catch((e) => { console.error(e); if (server) server.kill(); process.exit(1); });
