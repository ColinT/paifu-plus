/** Build a tile as an image element: an outer sizing box + an inner face layer
 *  (face symbol over the tile front). The inner layer is what rotates, so the
 *  outer box can reserve the correct footprint for side-seat (rotated) tiles. */

import type { TenhouTile } from '../core/tiles.js';
import { tileFaceUrl, frontUrl } from '../core/tileImage.js';
import { tileLabel } from '../core/tileDisplay.js';

export function tileImg(t: TenhouTile, cls = ''): HTMLElement {
  const outer = document.createElement('span');
  outer.className = `bt ${cls}`.trim();
  outer.title = tileLabel(t);
  const inner = document.createElement('i');
  inner.className = 'tf';
  const face = tileFaceUrl(t);
  inner.style.backgroundImage = face ? `url(${face}), url(${frontUrl})` : `url(${frontUrl})`;
  outer.append(inner);
  return outer;
}
