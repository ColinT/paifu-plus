import { describe, it, expect } from 'vitest';
import { parseStream } from '../src/stream/parse.js';
import { gameToPdf, EMBED_NAME } from '../src/pdf/export.js';

describe('gameToPdf', () => {
  it('produces a valid PDF that embeds the tenhou log (Japanese names included)', async () => {
    const s = 'e1 佐藤:123456789m1234z1z 鈴木:123456789p1234z 高橋:123456789s1234z 田中:123456789p1234z 1z ryuukyoku';
    const game = parseStream(s).game;
    const bytes = await gameToPdf(game);
    const head = new TextDecoder().decode(bytes.slice(0, 5));
    expect(head).toBe('%PDF-');
    // the embedded-file name appears (uncompressed) in the PDF's name tree
    const latin = Buffer.from(bytes).toString('latin1');
    expect(latin).toContain(EMBED_NAME);
    expect(bytes.byteLength).toBeGreaterThan(500);
  });
});
