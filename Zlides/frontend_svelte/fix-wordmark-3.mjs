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
    const at = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i+1], px[i+2], px[i+3]]; };

    const pockets = [
      { x0: 460, x1: 600, y0: 95, y1: 225 },
      { x0: 660, x1: 800, y0: 95, y1: 195 },
    ];
    const shades = [];
    for (const pk of pockets) {
      for (let y = pk.y0; y <= pk.y1; y += 2) {
        for (let x = pk.x0; x <= pk.x1; x += 2) {
          const [r, g, b, a] = at(x, y);
          if (a === 0) continue;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (mx - mn <= 12 && mx > 40) shades.push([r, g, b]);
        }
      }
    }
    const clusters = [];
    for (const s of shades) {
      let hit = clusters.find(cl => Math.abs(cl[0] - s[0]) < 16 && Math.abs(cl[1] - s[1]) < 16 && Math.abs(cl[2] - s[2]) < 16);
      if (hit) { hit[3]++; } else { clusters.push([...s, 1]); }
    }
    clusters.sort((a, b) => b[3] - a[3]);
    const top = clusters.slice(0, 8);

    const isBg = (r, g, b) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn > 14) return false;
      return top.some(([cr, cg, cb, n]) => n > 40 && Math.abs(r - cr) < 20 && Math.abs(g - cg) < 20 && Math.abs(b - cb) < 20);
    };
    const seen = new Uint8Array(W * H);
    const stack = [];
    let seeded = 0;
    for (const pk of pockets) {
      for (let y = pk.y0; y <= pk.y1; y++) {
        for (let x = pk.x0; x <= pk.x1; x++) {
          const [r, g, b, a] = at(x, y);
          if (a !== 0) continue;
          stack.push(x, y);
          seeded++;
        }
      }
    }
    for (const pk of pockets) {
      for (let y = pk.y0; y <= pk.y1; y++) {
        for (let x = pk.x0; x <= pk.x1; x++) {
          const [r, g, b] = at(x, y);
          if (isBg(r, g, b)) { stack.push(x, y); seeded++; }
        }
      }
    }
    let keyed = 0;
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const p = y * W + x;
      if (seen[p]) continue;
      const i = p * 4;
      if (px[i + 3] === 0) { seen[p] = 1; continue; }
      if (!isBg(px[i], px[i+1], px[i+2])) continue;
      seen[p] = 1;
      px[i + 3] = 0;
      keyed++;
      stack.push(x+1, y, x-1, y, x, y+1, x, y-1);
    }
    ctx.putImageData(d, 0, 0);
    return { w: W, h: H, seeded, keyed, top: top.map(t => t.join(',')), dataUrl: c.toDataURL('image/png') };
  }, dataUri);
  fs.writeFileSync(OUT, Buffer.from(report.dataUrl.split(',')[1], 'base64'));
  console.log('pocket shades:', report.top.join(' | '));
  console.log('seeded:', report.seeded, 'keyed:', report.keyed);
  console.log('written:', OUT, fs.statSync(OUT).size, 'bytes');
} finally {
  await browser.close();
}
