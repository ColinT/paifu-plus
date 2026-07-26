/**
 * Tile face images (FluffyStuff riichi-mahjong-tiles, CC0 public domain).
 *
 * The bundled SVGs in ../assets/tiles are the FACE SYMBOLS only (transparent
 * body); the tile body is `front.svg`. A complete tile is drawn by layering the
 * face over the front — done in CSS via two stacked background images, which
 * keeps each SVG an isolated resource (their gradient IDs collide, so merging
 * them into one document would break).
 */

import type { TenhouTile } from './tiles.js';

const mods = import.meta.glob('../assets/tiles/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const byCode: Record<number, string> = {};
let front = '';
for (const [path, url] of Object.entries(mods)) {
  const name = path.split('/').pop()!.replace('.svg', '');
  if (name === 'front') front = url;
  else if (/^\d+$/.test(name)) byCode[Number(name)] = url;
}

export const frontUrl = front;
// Native red fives (51/52/53) render with the generated aka art made from the
// PLAIN five (115/125/135), so they carry only the single CSS pip — the native
// red-five art has its own pip baked in, which would double up.
const AKA_FIVE: Record<number, number> = { 51: 115, 52: 125, 53: 135 };
/** URL of the face symbol for a tenhou tile code. Aka dora on any tile (code +
 *  100) has pre-generated red art (1NN.svg); fall back to the plain face. */
export function tileFaceUrl(t: TenhouTile): string | undefined {
  const k = AKA_FIVE[t] ?? t;
  return byCode[k] ?? byCode[k >= 100 ? k - 100 : k];
}
