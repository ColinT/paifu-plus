// Copy pdfjs CMap tables into public/ so the browser importer can decode CJK
// text. Run automatically before dev/build (see package.json).
import fs from 'node:fs';
import path from 'node:path';

const src = path.join('node_modules', 'pdfjs-dist', 'cmaps');
const dst = path.join('public', 'cmaps');
if (!fs.existsSync(src)) { console.error('pdfjs cmaps not found; run npm install first'); process.exit(0); }
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log(`copied cmaps → ${dst} (${fs.readdirSync(dst).length} files)`);
