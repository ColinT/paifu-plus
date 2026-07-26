/** Build a tile as an image element: an outer sizing box + an inner face layer
 *  (face symbol over the tile front). The inner layer is what rotates, so the
 *  outer box can reserve the correct footprint for side-seat (rotated) tiles. */

import type { TenhouTile } from '../core/tiles.js';
import { tileFaceUrl, frontUrl } from '../core/tileImage.js';
import { tileLabel } from '../core/tileDisplay.js';

export function tileImg(t: TenhouTile, cls = ''): HTMLElement {
  const outer = document.createElement('span');
  // Aka dora (+100) has pre-generated red art, so it renders like any tile; the
  // .aka class only adds the accessibility dot.
  const aka = t >= 100;
  outer.className = `bt ${aka ? 'aka ' : ''}${cls}`.trim();
  outer.title = tileLabel(t);
  const inner = document.createElement('i');
  inner.className = 'tf';
  const face = tileFaceUrl(t);
  inner.style.backgroundImage = face ? `url(${face}), url(${frontUrl})` : `url(${frontUrl})`;
  outer.append(inner);
  return outer;
}

/** A face-down tile: the blank front SVG, tinted into a "back" via a CSS filter
 *  (the tile set ships no back art). Same footprint as a real tile. */
export function tileBack(cls = ''): HTMLElement {
  const outer = document.createElement('span');
  outer.className = `bt back ${cls}`.trim();
  outer.title = 'concealed';
  const inner = document.createElement('i');
  inner.className = 'tf';
  inner.style.backgroundImage = `url(${frontUrl})`;
  outer.append(inner);
  return outer;
}
