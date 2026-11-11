import puppeteer from 'puppeteer';
import fs from 'node:fs';

const SRC = '/home/hayron/Zlides22/Zlides/frontend_svelte/public/brand/zlides-wordmark-alpha.png';
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
    // Tight global key on the two checker shades (neutral grays only).
    const shades = [[67, 67, 67], [94, 94, 95]];
    let keyed = 0;
    for (let p = 0; p < W * H; p++) {
      const i = p * 4;
      if (px[i + 3] === 0) continue;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn > 8) continue; // warm/colored pixels are content
      for (const [cr, cg, cb] of shades) {
        if (Math.abs(r - cr) < 6 && Math.abs(g - cg) < 6 && Math.abs(b - cb) < 6) {
          px[i + 3] = 0;
          keyed++;
          break;
        }
      }
    }
    ctx.putImageData(d, 0, 0);
    return { w: W, h: H, keyed, total: W * H, dataUrl: c.toDataURL('image/png') };
  }, dataUri);
  fs.writeFileSync(OUT, Buffer.from(report.dataUrl.split(',')[1], 'base64'));
  console.log('pass2 keyed:', report.keyed, 'of', report.total, '(' + (100 * report.keyed / report.total).toFixed(2) + '%)');
  console.log('written:', OUT, fs.statSync(OUT).size, 'bytes');
} finally {
  await browser.close();
}
