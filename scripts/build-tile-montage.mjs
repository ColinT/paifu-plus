import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const cmapDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps') + path.sep;
const get = (page, name) => new Promise((res) => { try { const o = page.objs.get(name, res); if (o) res(o); } catch { res(null); } });
const files = ['ketteisen1-1.pdf', 'ketteisen1-2.pdf', 'ketteisen1-4.pdf'];

const uniq = new Map(); // hash -> {obj, files:Set, land}
for (const f of files) {
  const data = new Uint8Array(fs.readFileSync(path.join('samples', f)));
  const doc = await getDocument({ data, cMapUrl: cmapDir, cMapPacked: true }).promise;
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  const names = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintJpegXObject) {
      const n = ops.argsArray[i][0]; if (!names.includes(n)) names.push(n);
    }
  }
  for (const n of names) {
    const o = await get(page, n);
    const buf = Buffer.from(o.data.buffer ? o.data.buffer : o.data);
    const h = crypto.createHash('md5').update(buf).digest('hex').slice(0, 10);
    if (!uniq.has(h)) uniq.set(h, { obj: o, files: new Set(), land: o.width > o.height });
    uniq.get(h).files.add(f);
  }
}

const entries = [...uniq.entries()];
const portrait = entries.filter(([, v]) => !v.land);
const landscape = entries.filter(([, v]) => v.land);
console.log(`unique images: ${entries.length} (portrait ${portrait.length}, landscape ${landscape.length})`);

function renderMontage(list, cols, cell, outName) {
  const pad = 6, labelH = 22;
  const rows = Math.ceil(list.length / cols);
  const cw = cols * (cell + pad) + pad, ch = rows * (cell + labelH + pad) + pad;
  const cv = createCanvas(cw, ch), g = cv.getContext('2d');
  g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, cw, ch);
  g.font = '13px monospace'; g.textBaseline = 'top'; g.imageSmoothingEnabled = false;
  list.forEach(([h, v], idx) => {
    const cx = pad + (idx % cols) * (cell + pad), cy = pad + Math.floor(idx / cols) * (cell + labelH + pad);
    g.fillStyle = '#000'; g.fillText(h, cx, cy);
    const yy = cy + labelH; g.fillStyle = '#fff'; g.fillRect(cx, yy, cell, cell);
    const o = v.obj, w = o.width, ht = o.height, src = o.data, per = src.length / (w * ht);
    const tmp = createCanvas(w, ht), tg = tmp.getContext('2d'), id = tg.createImageData(w, ht);
    for (let q = 0; q < w * ht; q++) {
      let r, gg, b, a = 255;
      if (per >= 4) { r = src[q * 4]; gg = src[q * 4 + 1]; b = src[q * 4 + 2]; a = src[q * 4 + 3]; }
      else if (per >= 3) { r = src[q * 3]; gg = src[q * 3 + 1]; b = src[q * 3 + 2]; }
      else { r = gg = b = src[q]; }
      id.data[q * 4] = r; id.data[q * 4 + 1] = gg; id.data[q * 4 + 2] = b; id.data[q * 4 + 3] = a;
    }
    tg.putImageData(id, 0, 0);
    const s = Math.min(cell / w, cell / ht);
    g.drawImage(tmp, cx + (cell - w * s) / 2, yy, w * s, ht * s);
  });
  fs.writeFileSync(outName, cv.toBuffer('image/png'));
}

// Sort portrait roughly by look (suit clusters) is hard without labels; keep hash order.
renderMontage(portrait.slice(0, 18), 3, 150, 'scripts/montage-p1.png');
renderMontage(portrait.slice(18), 3, 150, 'scripts/montage-p2.png');
renderMontage(landscape, 3, 150, 'scripts/montage-landscape.png');
console.log('wrote scripts/montage-portrait.png and scripts/montage-landscape.png');
// dump for reference
console.log('PORTRAIT:', portrait.map(([h]) => h).join(' '));
console.log('LANDSCAPE:', landscape.map(([h]) => h).join(' '));
