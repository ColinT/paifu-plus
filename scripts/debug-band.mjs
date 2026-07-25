import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
import path from 'path';

const cmapDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps') + path.sep;
const [file, pageArg, yLo, yHi] = process.argv.slice(2);
const data = new Uint8Array(fs.readFileSync(path.join('samples', file)));
const doc = await getDocument({ data, cMapUrl: cmapDir, cMapPacked: true }).promise;
const page = await doc.getPage(Number(pageArg || 1));
const tc = await page.getTextContent();
const lo = Number(yLo), hi = Number(yHi);
const items = tc.items
  .filter((it) => it.str && it.str.trim())
  .map((it) => ({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), s: it.str }))
  .filter((it) => it.y >= lo && it.y <= hi)
  .sort((a, b) => b.y - a.y || a.x - b.x);
console.log(`text items in y[${lo},${hi}] (x, y, str):`);
for (const it of items) console.log(`  x=${String(it.x).padStart(4)} y=${String(it.y).padStart(4)}  ${JSON.stringify(it.s)}`);
