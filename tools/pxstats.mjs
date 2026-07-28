#!/usr/bin/env node
// Pixel statistics for a PNG — mean RGB, hue balance, darkest/brightest,
// histogram of the violet-ness of the frame. Used to prove the colour grade
// actually moved, rather than eyeballing it.
//
//   node tools/pxstats.mjs shots/overview.png [--crop x0,y0,x1,y1]
//
// Coordinates for --crop are fractions of the image (0..1).

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let p = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced png unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth + ' unsupported');
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (ch < 0) throw new Error('color type ' + colorType + ' unsupported');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d > 1e-6) {
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
  }
  hh *= 60; if (hh < 0) hh += 360;
  return [hh, mx > 0 ? d / mx : 0, mx];
}

export function stats(file, crop) {
  const { w, h, ch, data } = decodePng(readFileSync(file));
  let x0 = 0, y0 = 0, x1 = w, y1 = h;
  if (crop) {
    x0 = Math.round(crop[0] * w); y0 = Math.round(crop[1] * h);
    x1 = Math.round(crop[2] * w); y1 = Math.round(crop[3] * h);
  }
  let sr = 0, sg = 0, sb = 0, n = 0;
  let minL = 1e9, minPix = null, maxL = -1, maxPix = null;
  let violet = 0, warm = 0, green = 0, clipped = 0;
  const lumHist = new Array(16).fill(0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      sr += r; sg += g; sb += b; n++;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (l < minL) { minL = l; minPix = [r, g, b]; }
      if (l > maxL) { maxL = l; maxPix = [r, g, b]; }
      lumHist[Math.min(15, (l / 16) | 0)]++;
      if (r > 250 && g > 250 && b > 250) clipped++;
      const [hh, ss] = rgb2hsv(r, g, b);
      if (ss > 0.10 && hh >= 240 && hh <= 330) violet++;
      if (ss > 0.10 && (hh < 70 || hh > 330)) warm++;
      if (ss > 0.10 && hh >= 70 && hh < 175) green++;
    }
  }
  const mr = sr / n, mg = sg / n, mb = sb / n;
  return {
    file, w, h, px: n,
    meanRGB: [+mr.toFixed(1), +mg.toFixed(1), +mb.toFixed(1)],
    'R-B': +(mr - mb).toFixed(1),
    'R-G': +(mr - mg).toFixed(1),
    meanHue: +rgb2hsv(mr, mg, mb)[0].toFixed(1),
    meanSat: +rgb2hsv(mr, mg, mb)[1].toFixed(3),
    darkest: minPix, darkestLum: +minL.toFixed(1),
    brightest: maxPix, brightestLum: +maxL.toFixed(1),
    pctViolet: +(100 * violet / n).toFixed(1),
    pctWarm: +(100 * warm / n).toFixed(1),
    pctGreen: +(100 * green / n).toFixed(1),
    pctClippedWhite: +(100 * clipped / n).toFixed(2),
    lumHist: lumHist.map((v) => +(100 * v / n).toFixed(1)),
  };
}

const args = process.argv.slice(2);
if (args.length && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const ci = args.indexOf('--crop');
  const crop = ci >= 0 ? args[ci + 1].split(',').map(Number) : null;
  const files = args.filter((a, i) => !a.startsWith('--') && !(ci >= 0 && i === ci + 1));
  for (const f of files) console.log(JSON.stringify(stats(f, crop)));
}
