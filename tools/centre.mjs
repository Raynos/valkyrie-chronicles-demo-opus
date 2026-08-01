import { readFileSync } from 'node:fs';
import { decodePng } from '/Users/raynos/projects/game-demos/valkyrie-chronicles-demo-opus/tools/pxstats.mjs';
for (const f of process.argv.slice(2)) {
  const { w, h, ch, data } = decodePng(readFileSync(f));
  const L = [];
  for (let y = Math.floor(h*0.25); y < h*0.75; y++)
    for (let x = Math.floor(w*0.25); x < w*0.75; x++) {
      const i = (y*w+x)*ch;
      L.push(0.2126*data[i] + 0.7152*data[i+1] + 0.0722*data[i+2]);
    }
  L.sort((a,b)=>a-b);
  const pc = p => Math.round(L[Math.floor(p*(L.length-1))]);
  console.log(f.split('/').pop().padEnd(20), 'CENTRE p0.1', pc(0.001), 'p1', pc(0.01), 'p5', pc(0.05), 'p50', pc(0.5), 'p99', pc(0.99));
}
