#!/usr/bin/env node
// Does renderScale:0.5 visibly soften the picture on a Retina display?
// shoot.mjs always captures at deviceScaleFactor 1, where renderScale is a no-op.
// The user looks at the game on a 2x display, where it is NOT. Capture both.
import { chromium } from 'playwright';

const PORT = 5173;
const shots = [
  ['dpr2-rs0.5', '?capture&shot=overview'],            // what the user actually sees
  ['dpr2-rs1',   '?capture&shot=overview&rs=1'],       // full retina
];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
         '--enable-unsafe-webgpu', '--disable-frame-rate-limit'],
});
for (const [name, q] of shots) {
  const page = await browser.newPage({ viewport: { width: 1496, height: 721 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__READY__ === true, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const dpr = await page.evaluate(() => ({
    devicePixelRatio,
    canvasW: document.querySelector('canvas')?.width,
    cssW: document.querySelector('canvas')?.clientWidth,
  }));
  console.log(name, JSON.stringify(dpr));
  await page.screenshot({ path: `/private/tmp/claude-501/-Users-raynos-projects-game-demos-valkyrie-chronicles-demo-opus/6eff4297-f6c9-4e75-9298-1409c01bca6e/scratchpad/bisect-out/${name}.png` });
  await page.close();
}
await browser.close();
