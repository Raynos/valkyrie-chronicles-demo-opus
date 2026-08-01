#!/usr/bin/env node
// Art-style metrics for a PNG, chosen to measure the specific things the Valkyria look
// depends on and the specific things the demo's post chain destroys.
//
//   node artstats.mjs <file.png> [...]
//
//   sat        mean HSV saturation over non-paper pixels (chroma; the demo caps this)
//   satC/satE  saturation in the CENTRE 50% box vs the OUTER frame margin.
//              The real game paints the centre and lets the edges fall to paper, so
//              satC/satE should be WELL ABOVE 1. A global wash makes it ~1.
//   detail     mean |Laplacian| of luminance — local contrast / texture energy.
//              This is exactly what a wash quantiser with a detail budget crushes.
//   p1..p99    luminance percentile spread (tonal range actually used)
//   ink        % pixels that are both dark (L<70) and a local minimum — outline density
//   hue        mean hue of the saturated pixels, and the green/warm split

import { readFileSync } from 'node:fs';
import { decodePng } from '/Users/raynos/projects/game-demos/valkyrie-chronicles-demo-opus/tools/pxstats.mjs';

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, mx === 0 ? 0 : d / mx, mx / 255];
}

function analyse(path) {
  const { w, h, ch, data } = decodePng(readFileSync(path));
  const at = (x, y) => { const i = (y * w + x) * ch; return [data[i], data[i + 1], data[i + 2]]; };

  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = at(x, y); L[y * w + x] = lum(r, g, b);
  }

  let satSum = 0, satN = 0;
  let satCSum = 0, satCN = 0, satESum = 0, satEN = 0;
  let hueSum = 0, hueN = 0, warmN = 0, greenN = 0;
  const cx0 = w * 0.25, cx1 = w * 0.75, cy0 = h * 0.25, cy1 = h * 0.75;
  const ex = w * 0.12, ey = h * 0.12;

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = at(x, y);
    const [hu, s] = hsv(r, g, b);
    satSum += s; satN++;
    const inC = x > cx0 && x < cx1 && y > cy0 && y < cy1;
    const inE = x < ex || x > w - ex || y < ey || y > h - ey;
    if (inC) { satCSum += s; satCN++; }
    if (inE) { satESum += s; satEN++; }
    if (s > 0.18) {
      hueSum += hu; hueN++;
      if (hu >= 50 && hu <= 160) greenN++; else if (hu < 50 || hu > 330) warmN++;
    }
  }

  // Laplacian detail energy, and ink density
  let lapSum = 0, lapN = 0, ink = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const c = L[y * w + x];
    const lap = Math.abs(4 * c - L[y * w + x - 1] - L[y * w + x + 1] - L[(y - 1) * w + x] - L[(y + 1) * w + x]);
    lapSum += lap; lapN++;
    if (c < 70 && lap > 12) ink++;
  }

  const sorted = Float32Array.from(L).sort();
  const pc = (p) => sorted[Math.floor(p * (sorted.length - 1))];

  return {
    file: path.split('/').pop(),
    sat: +(satSum / satN).toFixed(3),
    satC: +(satCSum / satCN).toFixed(3),
    satE: +(satESum / satEN).toFixed(3),
    ratio: +((satCSum / satCN) / (satESum / satEN)).toFixed(2),
    detail: +(lapSum / lapN).toFixed(2),
    p1: Math.round(pc(0.01)), p50: Math.round(pc(0.5)), p99: Math.round(pc(0.99)),
    range: Math.round(pc(0.99) - pc(0.01)),
    ink: +((ink / lapN) * 100).toFixed(2),
    hue: Math.round(hueSum / Math.max(1, hueN)),
    grn: +((greenN / Math.max(1, hueN)) * 100).toFixed(0),
    warm: +((warmN / Math.max(1, hueN)) * 100).toFixed(0),
  };
}

const files = process.argv.slice(2);
const rows = [];
for (const f of files) { try { rows.push(analyse(f)); } catch (e) { console.error(f, e.message); } }
const cols = ['file', 'sat', 'satC', 'satE', 'ratio', 'detail', 'p1', 'p50', 'p99', 'range', 'ink', 'hue', 'grn', 'warm'];
const wid = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
console.log(cols.map((c, i) => c.padEnd(wid[i])).join('  '));
for (const r of rows) console.log(cols.map((c, i) => String(r[c]).padEnd(wid[i])).join('  '));
