import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// inline copy of the tile table for cross-referencing (keep in sync with src/pdf/tileHashes.ts)
const PORTRAIT = { '5d027c18d8':'1m','330858f1f8':'2m','ddc9df43bb':'3m','f4e77c078c':'4m','f57dd0196d':'5m','7fc3a99459':'5m*','19481ddc8a':'6m','e398c082b1':'7m','29f63b7bad':'8m','97334621e1':'9m','4a72cf9698':'1p','44049c411f':'2p','6bb997486b':'3p','c375c84202':'4p','20bebe2b52':'5p','2ef6d6f3c1':'6p','0b116e2f56':'7p','58c1e321c9':'8p','5ace38e2ee':'9p','dc1046fb00':'1s','39744bbbbc':'2s','76227a4ace':'3s','9472c85b35':'4s','2f69759175':'5s','bf842de9c2':'6s','d47e660b2f':'7s','20d8a4cc2c':'8s','f72b43f932':'9s','b5cf7d046c':'E','1d42bff19c':'S','fff3043152':'W','d14217155f':'N','26a4dc27eb':'chun','72f6445067':'ARROW','e169ea36ab':'BLANK' };

const cmapDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps') + path.sep;
const get = (page, name) => new Promise((res) => { try { const o = page.objs.get(name, res); if (o) res(o); } catch { res(null); } });
const [file, pageArg] = process.argv.slice(2);
const data = new Uint8Array(fs.readFileSync(path.join('samples', file)));
const doc = await getDocument({ data, cMapUrl: cmapDir, cMapPacked: true }).promise;
const page = await doc.getPage(Number(pageArg));
const ops = await page.getOperatorList();

const stack = []; let ctm = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
const paints = [];
for (let i = 0; i < ops.fnArray.length; i++) { const fn = ops.fnArray[i], a = ops.argsArray[i];
  if (fn === OPS.save) stack.push(ctm.slice()); else if (fn === OPS.restore) ctm = stack.pop() || [1,0,0,1,0,0];
  else if (fn === OPS.transform) ctm = mul(ctm, a);
  else if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintJpegXObject)
    paints.push({ name: a[0], x: Math.round(ctm[4]), y: Math.round(ctm[5]) }); }

const hashByName = {}, landByName = {};
for (const p of paints) { if (!(p.name in hashByName)) { const o = await get(page, p.name); const buf = Buffer.from(o.data.buffer ? o.data.buffer : o.data);
  hashByName[p.name] = crypto.createHash('md5').update(buf).digest('hex').slice(0, 10); landByName[p.name] = o.width > o.height; } }

// stats: how many hashes are in our table?
const uniqHashes = [...new Set(Object.values(hashByName))];
const known = uniqHashes.filter((h) => h in PORTRAIT).length;
console.log(`page ${pageArg}: ${uniqHashes.length} unique images, ${known} match PAIFUN table, ${uniqHashes.length - known} new`);
console.log('NEW hashes:', uniqHashes.filter((h) => !(h in PORTRAIT)).join(' ') || '(none)');

const rows = [];
for (const p of paints) { let r = rows.find((r) => Math.abs(r.y - p.y) < 6); if (!r) { r = { y: p.y, items: [] }; rows.push(r); } r.items.push(p); }
rows.sort((a, b) => b.y - a.y);
for (const r of rows) r.items.sort((a, b) => a.x - b.x);
console.log('\nROWS (label = tile[LAND], gaps shown):');
for (const r of rows) {
  let prevX = null;
  const seq = r.items.map((p) => { const h = hashByName[p.name]; let lab = PORTRAIT[h] || '?' + h.slice(0, 5); if (landByName[p.name]) lab += '/L';
    let gap = prevX !== null && (p.x - prevX) > 22 ? ' | ' : ' '; prevX = p.x; return gap + lab; });
  console.log(`y=${String(r.y).padStart(3)} n=${String(r.items.length).padStart(2)}:${seq.join('')}`);
}
