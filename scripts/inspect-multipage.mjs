import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
import path from 'path';

const cmapDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps') + path.sep;
const file = process.argv[2];
const wantPages = (process.argv[3] || '').split(',').filter(Boolean).map(Number);

const data = new Uint8Array(fs.readFileSync(path.join('samples', file)));
const doc = await getDocument({ data, cMapUrl: cmapDir, cMapPacked: true }).promise;
console.log('PAGES:', doc.numPages);

const pages = wantPages.length ? wantPages : [1];
for (const pnum of pages) {
  const page = await doc.getPage(pnum);
  const tc = await page.getTextContent();
  const items = tc.items.map((it) => ({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), s: it.str }));
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  let lastY = null, line = ''; const lines = [];
  for (const it of items) { if (lastY === null || Math.abs(it.y - lastY) > 3) { if (line) lines.push({ y: lastY, t: line }); line = ''; lastY = it.y; } line += it.s; }
  if (line) lines.push({ y: lastY, t: line });
  const ops = await page.getOperatorList();
  let imgCount = 0; for (const fn of ops.fnArray) if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintJpegXObject) imgCount++;
  console.log(`\n===== PAGE ${pnum} | text items ${tc.items.length} | image paints ${imgCount} =====`);
  for (const l of lines) console.log(String(l.y).padStart(4), JSON.stringify(l.t));
}
