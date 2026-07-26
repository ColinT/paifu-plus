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
/** URL of the face symbol for a tenhou tile code (red fives have their own art;
 *  arbitrary aka tiles use the plain face and are tinted red in CSS). */
export function tileFaceUrl(t: TenhouTile): string | undefined { return byCode[t >= 100 ? t - 100 : t]; }
