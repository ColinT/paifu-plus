import { describe, it, expect } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractPage } from '../src/pdf/extract.js';
import { parseKyoku } from '../src/pdf/parse.js';
import { gameToTenhou } from '../src/core/tenhou.js';
import type { Kyoku, Game } from '../src/core/model.js';

const cmapDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps') + path.sep;
const hashImage = (o: any): string => {
  const d = o?.data;
  if (!d) return '';
  const b = d instanceof Uint8Array ? d : new Uint8Array(d.buffer ?? d);
  return crypto.createHash('md5').update(b).digest('hex').slice(0, 10);
};

async function parseFile(file: string): Promise<Kyoku[]> {
  const data = new Uint8Array(fs.readFileSync(path.join('samples', file)));
  const doc = await getDocument({ data, cMapUrl: cmapDir, cMapPacked: true }).promise;
  const out: Kyoku[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const raw = await extractPage(page as any, OPS as any, hashImage);
    out.push(parseKyoku(raw));
  }
  return out;
}

describe('最高位戦 PAIFUN samples', () => {
  it('ketteisen1-1: East-1 exhaustive draw', async () => {
    const [k] = await parseFile('ketteisen1-1.pdf');
    expect([k.round, k.honba]).toEqual([0, 0]);
    expect(k.result.kind).toBe('ryuukyoku');
    expect(k.result.deltas).toEqual([1000, -3000, 1000, 1000]);
    for (const p of k.players) expect(p.haipai).toHaveLength(13);
  });

  it('ketteisen1-2: North riichi, South rons 7p off North', async () => {
    const [k] = await parseFile('ketteisen1-2.pdf');
    expect([k.round, k.honba]).toEqual([0, 1]);
    expect(k.result.kind).toBe('ron');
    expect(k.result.winner).toBe(1);
    expect(k.result.loser).toBe(3);
    expect(k.result.winningTile).toBe(27); // 7p
    expect(k.result.deltas).toEqual([0, 9300, 0, -9300]);
    for (const p of k.players) expect(p.haipai).toHaveLength(13);
    // North (P3) declared riichi.
    const north = k.players[3];
    expect(north.turns.some((t) => t.riichi)).toBe(true);
  });

  it('ketteisen1-4: East (dealer) tsumo on 2m with a pon', async () => {
    const [k] = await parseFile('ketteisen1-4.pdf');
    expect([k.round, k.honba]).toEqual([2, 0]);
    expect(k.result.kind).toBe('tsumo');
    expect(k.result.winner).toBe(2);
    expect(k.result.winningTile).toBe(12); // 2m
    expect(k.result.deltas).toEqual([-500, -500, 2500, -1500]);
    for (const p of k.players) expect(p.haipai).toHaveLength(13);
    // Winner has a pon of chun (47).
    const winner = k.players[2];
    expect(winner.calls.some((c) => c.type === 'pon' && c.calledTile === 47)).toBe(true);
  });

  it('emits structurally valid tenhou/6 JSON', async () => {
    const kyokus = await parseFile('ketteisen1-2.pdf');
    const game: Game = {
      meta: { title: ['t', ''], names: kyokus[0].players.map((p) => p.name) as [string, string, string, string], rule: { aka: 0 } },
      kyokus,
    };
    const log = gameToTenhou(game);
    expect(log.log).toHaveLength(1);
    const entry = log.log[0] as unknown[];
    expect(entry).toHaveLength(17); // round,scores,dora,ura, 4×(haipai,draws,discards), result
    expect((entry[0] as number[])[0]).toBe(0);
  });
});
