import puppeteer from 'puppeteer';
import fs from 'node:fs';

const SRC = '/home/hayron/Zlides22/Zlides/frontend_svelte/public/brand/zlides-wordmark.png';
const OUT = '/home/hayron/Zlides22/Zlides/frontend_svelte/public/favicon-256.png';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  const dataUri = 'data:image/png;base64,' + fs.readFileSync(SRC).toString('base64');
  const report = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    // Measure source alpha
    const m = document.createElement('canvas');
    m.width = img.naturalWidth; m.height = img.naturalHeight;
    const mctx = m.getContext('2d', { willReadFrequently: true });
    mctx.drawImage(img, 0, 0);
    const md = mctx.getImageData(0, 0, m.width, m.height).data;
    const colCount = new Array(m.width).fill(0);
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        if (md[(y * m.width + x) * 4 + 3] > 16) colCount[x]++;
      }
    }
    // Sand wisps bridge glyphs, so no zero-gap exists: split at the minimum-ink
    // column inside the Z/l inter-glyph zone (Z spans roughly x<210).
    let zLeft = 0;
    let zRight = 205;
    {
      let minCol = Infinity, minX = 205;
      for (let x = 130; x <= 290; x++) {
        if (colCount[x] < minCol) { minCol = colCount[x]; minX = x; }
      }
      if (minCol <= m.height * 0.05) zRight = minX;
    }
    // Row bounds within that x-range
    let top = m.height, bottom = 0;
    for (let y = 0; y < m.height; y++) {
      for (let x = zLeft; x <= zRight; x++) {
        if (md[(y * m.width + x) * 4 + 3] > 0) { if (y < top) top = y; if (y > bottom) bottom = y; break; }
      }
    }
    // Draw onto 256x256 transparent canvas, fit into 216 box, centered
    const cropW = zRight - zLeft + 1, cropH = bottom - top + 1;
    const S = 256, box = 216;
    const scale = Math.min(box / cropW, box / cropH);
    const dw = cropW * scale, dh = cropH * scale;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, zLeft, top, cropW, cropH, (S - dw) / 2, (S - dh) / 2, dw, dh);
    return { zLeft, zRight, top, bottom, cropW, cropH, dataUrl: c.toDataURL('image/png') };
  }, dataUri);
  fs.writeFileSync(OUT, Buffer.from(report.dataUrl.split(',')[1], 'base64'));
  console.log('Z bounds: x', report.zLeft, '..', report.zRight, ' y', report.top, '..', report.bottom, ' crop', report.cropW + 'x' + report.cropH);
  console.log('written:', OUT, fs.statSync(OUT).size, 'bytes');
} finally {
  await browser.close();
}
