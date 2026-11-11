import puppeteer from 'puppeteer';
import fs from 'node:fs';

const SRC = '/home/hayron/Zlides22/Zlides/frontend_svelte/public/brand/zlides-wordmark-final.png';
const OUT = '/home/hayron/Zlides22/Zlides/frontend_svelte/public/brand/zlides-wordmark-final.png';

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

    const boxes = [
      { x0: 455, x1: 610, y0: 90, y1: 230 },   // d counter
      { x0: 655, x1: 805, y0: 90, y1: 200 },   // e counter
    ];
    let keyed = 0;
    const samples = [];
    for (const box of boxes) {
      for (let y = box.y0; y <= box.y1; y++) {
        for (let x = box.x0; x <= box.x1; x++) {
          const i = (y * W + x) * 4;
          if (px[i + 3] === 0) continue;
          const r = px[i], g = px[i + 1], bch = px[i + 2];
          const mx = Math.max(r, g, bch);
          const mn = Math.min(r, g, bch);
          const chroma = mx - mn;
          const lum = (r + g + bch) / 3;
          if (x === 570 && (y === 120 || y === 125)) samples.push(x + ',' + y + ' rgba(' + r + ',' + g + ',' + bch + ') c=' + chroma + ' l=' + lum);
          if (chroma < 30 && lum >= 4 && lum <= 150) {
            px[i + 3] = 0;
            keyed++;
          }
        }
      }
    }
    ctx.putImageData(d, 0, 0);
    return { w: W, h: H, keyed, samples, dataUrl: c.toDataURL('image/png') };
  }, dataUri);
  fs.writeFileSync(OUT, Buffer.from(report.dataUrl.split(',')[1], 'base64'));
  console.log('pass4b keyed:', report.keyed);
  console.log('sample pixels:', report.samples.join(' | '));
  console.log('written:', OUT, fs.statSync(OUT).size, 'bytes');
} finally {
  await browser.close();
}
