import puppeteer from 'puppeteer';
import fs from 'node:fs';

const SRC = '/home/hayron/Zlides22/Zlides/frontend_svelte/public/brand/zlides-wordmark-final.png';

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
    const rows = [];
    for (let y = 110; y <= 200; y += 5) {
      for (let x = 495; x <= 590; x += 5) {
        const i = (y * W + x) * 4;
        const a = px[i + 3];
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const chroma = mx - mn;
        const lum = Math.round((r + g + b) / 3);
        rows.push(x + ',' + y + ' rgba(' + r + ',' + g + ',' + b + ',' + a + ') c=' + chroma + ' l=' + lum);
      }
    }
    return rows;
  }, dataUri);
  console.log(report.join('\n'));
} finally {
  await browser.close();
}
