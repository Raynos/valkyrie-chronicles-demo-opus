import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const OUT = resolve(process.argv[2] || './out.png');
const PORT = process.env.PORT || 5199;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e)}`));

await page.goto(`http://localhost:${PORT}/src/render/_devtest.html`, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction('window.__READY__ === true', { timeout: 30000 });
} catch { logs.push('[TIMEOUT] never reached __READY__'); }
await page.waitForTimeout(1500);

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT });
const info = await page.evaluate(() => (window.__INFO__ ? window.__INFO__() : null)).catch(() => null);
await browser.close();

console.log(JSON.stringify({ out: OUT, info, logs: logs.slice(0, 60) }, null, 2));
