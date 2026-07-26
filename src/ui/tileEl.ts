/** Build a tile as an image element: an outer sizing box + an inner face layer
 *  (face symbol over the tile front). The inner layer is what rotates, so the
 *  outer box can reserve the correct footprint for side-seat (rotated) tiles. */

import type { TenhouTile } from '../core/tiles.js';
import { tileFaceUrl, frontUrl } from '../core/tileImage.js';
import { tileLabel } from '../core/tileDisplay.js';

export function tileImg(t: TenhouTile, cls = ''): HTMLElement {
  const outer = document.createElement('span');
  // Arbitrary aka (+100) has no art: render the plain tile body and re-colour
  // the symbol solid red by masking (see .bt.aka in the CSS), plus a dot.
  const aka = t >= 100;
  outer.className = `bt ${aka ? 'aka ' : ''}${cls}`.trim();
  outer.title = tileLabel(t);
  const inner = document.createElement('i');
  inner.className = 'tf';
  const face = tileFaceUrl(t);
  if (aka) {
    inner.style.backgroundImage = `url(${frontUrl})`;          // tile body only
    if (face) inner.style.setProperty('--face', `url(${face})`); // symbol shape → CSS mask
  } else {
    inner.style.backgroundImage = face ? `url(${face}), url(${frontUrl})` : `url(${frontUrl})`;
  }
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
