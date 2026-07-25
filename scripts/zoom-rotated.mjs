import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const cmapDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps') + path.sep;
const get = (page, name) => new Promise((res) => { try { const o = page.objs.get(name, res); if (o) res(o); } catch { res(null); } });
const files = ['ketteisen1-1.pdf', 'ketteisen1-2.pdf', 'ketteisen1-4.pdf'];
const targetHash = process.argv[2];

let obj = null;
for (const f of files) {
  const data = new Uint8Array(fs.readFileSync(path.join('samples', f)));
  const doc = await getDocument({ data, cMapUrl: cmapDir, cMapPacked: true }).promise;
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  const names = [];
  for (let i = 0; i < ops.fnArray.length; i++) { const fn = ops.fnArray[i];
    if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintJpegXObject) { const n = ops.argsArray[i][0]; if (!names.includes(n)) names.push(n); } }
  for (const n of names) { const o = await get(page, n); const buf = Buffer.from(o.data.buffer ? o.data.buffer : o.data);
    if (crypto.createHash('md5').update(buf).digest('hex').slice(0, 10) === targetHash) obj = o; }
  if (obj) break;
}
const o = obj, w = o.width, h = o.height, src = o.data, per = src.length / (w * h);
const px = (x, y) => { const q = y * w + x; if (per >= 4) return [src[q*4],src[q*4+1],src[q*4+2]]; if (per >= 3) return [src[q*3],src[q*3+1],src[q*3+2]]; return [src[q],src[q],src[q]]; };
// render at 4 rotations so orientation is obvious
const scale = 7, pad = 10, labelH = 16;
const cell = Math.max(w, h) * scale;
const cv = createCanvas(4 * (cell + pad) + pad, cell + labelH + pad), g = cv.getContext('2d');
g.fillStyle = '#999'; g.fillRect(0, 0, cv.width, cv.height); g.font = '12px monospace'; g.fillStyle = '#000';
g.fillText(`${targetHash}  0/90/180/270`, 4, 2);
const rots = [ (x,y)=>[x,y], (x,y)=>[y, w-1-x], (x,y)=>[w-1-x, h-1-y], (x,y)=>[h-1-y, x] ];
rots.forEach((map, ri) => {
  const ox = pad + ri * (cell + pad), oy = labelH;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r,gg,b] = px(x,y); const [dx,dy] = map(x,y);
    g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(ox + dx*scale, oy + dy*scale, scale, scale); }
});
fs.writeFileSync('scripts/rot.png', cv.toBuffer('image/png'));
console.log('wrote scripts/rot.png', `${w}x${h}`);
