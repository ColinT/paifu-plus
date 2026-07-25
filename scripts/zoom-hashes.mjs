import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const cmapDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps') + path.sep;
const get = (page, name) => new Promise((res) => { try { const o = page.objs.get(name, res); if (o) res(o); } catch { res(null); } });
const files = ['ketteisen1-1.pdf', 'ketteisen1-2.pdf', 'ketteisen1-4.pdf'];
const want = process.argv.slice(2);

const byHash = {};
for (const f of files) {
  const data = new Uint8Array(fs.readFileSync(path.join('samples', f)));
  const doc = await getDocument({ data, cMapUrl: cmapDir, cMapPacked: true }).promise;
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  const names = [];
  for (let i = 0; i < ops.fnArray.length; i++) { const fn = ops.fnArray[i];
    if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintJpegXObject) { const n = ops.argsArray[i][0]; if (!names.includes(n)) names.push(n); } }
  for (const n of names) { const o = await get(page, n); const buf = Buffer.from(o.data.buffer ? o.data.buffer : o.data);
    const h = crypto.createHash('md5').update(buf).digest('hex').slice(0, 10); if (!(h in byHash)) byHash[h] = o; }
}

const scale = 7, pad = 8, labelH = 18;
const list = want.filter((h) => byHash[h]);
const maxW = Math.max(...list.map((h) => byHash[h].width));
const maxH = Math.max(...list.map((h) => byHash[h].height));
const cw = list.length * (maxW * scale + pad) + pad, ch = maxH * scale + labelH + pad * 2;
const cv = createCanvas(cw, ch), g = cv.getContext('2d');
g.fillStyle = '#999'; g.fillRect(0, 0, cw, ch); g.font = '12px monospace'; g.textBaseline = 'top';
list.forEach((h, idx) => {
  const o = byHash[h], w = o.width, ht = o.height, src = o.data, per = src.length / (w * ht);
  const ox = pad + idx * (maxW * scale + pad);
  g.fillStyle = '#000'; g.fillText(h, ox, 2);
  g.fillStyle = '#fff'; g.fillRect(ox, labelH, w * scale, ht * scale);
  for (let y = 0; y < ht; y++) for (let x = 0; x < w; x++) { const q = y * w + x; let r, gg, b;
    if (per >= 4) { r = src[q * 4]; gg = src[q * 4 + 1]; b = src[q * 4 + 2]; } else if (per >= 3) { r = src[q * 3]; gg = src[q * 3 + 1]; b = src[q * 3 + 2]; } else { r = gg = b = src[q]; }
    g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(ox + x * scale, labelH + y * scale, scale, scale); }
});
fs.writeFileSync('scripts/zoom.png', cv.toBuffer('image/png'));
console.log('wrote scripts/zoom.png for', list.join(', '));
