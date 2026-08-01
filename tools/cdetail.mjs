import { readFileSync } from 'node:fs';
import { decodePng } from '/Users/raynos/projects/game-demos/valkyrie-chronicles-demo-opus/tools/pxstats.mjs';
for (const f of process.argv.slice(2)) {
  const { w, h, ch, data } = decodePng(readFileSync(f));
  const L = new Float32Array(w*h);
  for (let i=0,p=0;i<w*h;i++,p+=ch) L[i]=0.2126*data[p]+0.7152*data[p+1]+0.0722*data[p+2];
  const x0=Math.floor(w*0.25),x1=Math.floor(w*0.75),y0=Math.floor(h*0.25),y1=Math.floor(h*0.75);
  let s=0,n=0;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const c=L[y*w+x];
    s+=Math.abs(4*c-L[y*w+x-1]-L[y*w+x+1]-L[(y-1)*w+x]-L[(y+1)*w+x]); n++;
  }
  console.log(f.split('/').pop().padEnd(20),'CENTRE detail', (s/n).toFixed(2));
}
