/**
 * Node CLI: convert one or more PAIFUN PDF pages into a tenhou/6 JSON log.
 *   npx tsx scripts/convert-cli.ts samples/ketteisen1-1.pdf [more.pdf ...]
 * Multi-page PDFs are treated as one kyoku per page.
 */
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractPage } from '../src/pdf/extract.js';
import { parseKyoku } from '../src/pdf/parse.js';
import { gameToTenhou } from '../src/core/tenhou.js';
import type { Game, Kyoku } from '../src/core/model.js';

const cmapDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps') + path.sep;
const md5 = (b: Uint8Array) => crypto.createHash('md5').update(b).digest('hex').slice(0, 10);

async function loadKyokus(file: string): Promise<Kyoku[]> {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await getDocument({ data, cMapUrl: cmapDir, cMapPacked: true }).promise;
  const out: Kyoku[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const raw = await extractPage(page as any, OPS as any, md5);
    try {
      out.push(parseKyoku(raw));
    } catch (e) {
      console.error(`  ! page ${p} of ${path.basename(file)}: ${(e as Error).message}`);
    }
  }
  return out;
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: convert-cli <pdf...>'); process.exit(1); }

  const kyokus: Kyoku[] = [];
  for (const f of files) kyokus.push(...(await loadKyokus(f)));
  kyokus.sort((a, b) => a.round - b.round || a.honba - b.honba);

  // Names by fixed index from the first kyoku.
  const names = kyokus.length
    ? (kyokus[0].players.map((p) => p.name) as [string, string, string, string])
    : (['', '', '', ''] as [string, string, string, string]);

  const game: Game = {
    meta: { title: ['PAIFUN import', ''], names, rule: { disp: '', aka: 0 } },
    kyokus,
  };

  const log = gameToTenhou(game);
  const outFile = 'out.tenhou.json';
  fs.writeFileSync(outFile, JSON.stringify(log));
  console.log(`\nparsed ${kyokus.length} kyoku(s) → ${outFile}`);
  // brief human summary
  for (const k of kyokus) {
    const r = k.result;
    console.log(`  round ${k.round} honba ${k.honba}: ${r.kind}` +
      (r.winner != null ? ` winner=P${r.winner}${r.loser != null ? ` from=P${r.loser}` : ''} tile=${r.winningTile ?? '?'}` : '') +
      ` deltas=[${r.deltas.join(',')}]`);
  }
  console.log('\n--- tenhou JSON (first kyoku) ---');
  console.log(JSON.stringify(log.log[0]));
}

main();
