import puppeteer from 'puppeteer';
import fs from 'node:fs';

const SRC = '/home/hayron/Zlides22/Zlides/frontend_svelte/public/brand/zlides-wordmark.png';
const OUT = '/home/hayron/Zlides22/Zlides/frontend_svelte/public/brand/zlides-wordmark-alpha.png';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  const dataUri = 'data:image/png;base64,' + fs.readFileSync(SRC).toString('base64');
  const report = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.getElementById('c');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    const W = c.width, H = c.height;
    const samples = [];
    for (const [x, y] of [[0,0],[1,0],[0,1],[1,1],[W-2,H-1],[W-1,H-1],[W-1,0],[0,H-1]]) {
      const i = (y*W + x) * 4;
      samples.push([px[i], px[i+1], px[i+2]]);
    }
    const isBg = (r, g, b) => {
      const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
      if (mx - mn > 30) return false;
      return samples.some(([cr, cg, cb]) => Math.abs(r-cr) < 32 && Math.abs(g-cg) < 32 && Math.abs(b-cb) < 32);
    };
    const seen = new Uint8Array(W * H);
    const stack = [];
    for (let x = 0; x < W; x++) { stack.push(x, 0, x, H-1); }
    for (let y = 0; y < H; y++) { stack.push(0, y, W-1, y); }
    let keyed = 0;
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const p = y*W + x;
      if (seen[p]) continue;
      const i = p*4;
      if (!isBg(px[i], px[i+1], px[i+2])) continue;
      seen[p] = 1;
      px[i+3] = 0;
      keyed++;
      stack.push(x+1, y, x-1, y, x, y+1, x, y-1);
    }
    ctx.putImageData(d, 0, 0);
    return { w: W, h: H, samples, keyed, total: W*H, dataUrl: c.toDataURL('image/png') };
  }, dataUri);

  const b64 = report.dataUrl.split(',')[1];
  fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
  console.log('size:', report.w, 'x', report.h);
  console.log('corner samples:', JSON.stringify(report.samples));
  console.log('keyed:', report.keyed, '/', report.total, '(' + (100*report.keyed/report.total).toFixed(1) + '%)');
  console.log('written:', OUT, fs.statSync(OUT).size, 'bytes');
} finally {
  await browser.close();
}
