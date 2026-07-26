/**
 * Generate aka-dora tile art from the plain face SVGs.
 *
 * PaifuPlus supports aka dora on any tile (encoded as plain code + 100). Rather
 * than recolour at render time with CSS filters (which fights anti-aliasing and
 * the symbols' white detail), we pre-generate a red variant of each face SVG by
 * recolouring every non-white ink colour to the aka red, keeping the shapes,
 * gradients, opacity and white highlights intact. The variant is written as
 * `1NN.svg` (its aka code) so the tile-image glob picks it up automatically.
 *
 * Run: node scripts/gen-aka-tiles.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'tiles');
const AKA = '#ce1914';

// Every plain tile except the fives (aka fives use the native 51/52/53 art).
const codes = [];
for (const base of [10, 20, 30]) for (let r = 1; r <= 9; r++) if (r !== 5) codes.push(base + r);
for (let h = 1; h <= 7; h++) codes.push(40 + h);

const isWhite = (hex) => /^f{2}f{2}f{2}$/i.test(hex) || /^fff$/i.test(hex);
let n = 0;
for (const code of codes) {
  const src = readFileSync(join(DIR, `${code}.svg`), 'utf8');
  const out = src.replace(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (m, hex) => (isWhite(hex) ? m : AKA));
  writeFileSync(join(DIR, `1${code}.svg`), out);
  n++;
}
console.log(`Generated ${n} aka tile SVGs (1${codes[0]}.svg … 1${codes.at(-1)}.svg).`);
