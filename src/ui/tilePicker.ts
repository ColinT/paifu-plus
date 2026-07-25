/** A small modal tile picker. Resolves to a tile code, 'delete', or null. */

import type { TenhouTile } from '../core/tiles.js';
import { allPickableTiles, tileGlyph, tileLabel, tileSuitClass } from '../core/tileDisplay.js';

export type PickResult = TenhouTile | 'delete' | null;

export function pickTile(opts: { allowDelete?: boolean; title?: string } = {}): Promise<PickResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal tile-picker';

    const h = document.createElement('div');
    h.className = 'modal-title';
    h.textContent = opts.title ?? 'Pick a tile';
    modal.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'tile-grid';
    for (const t of allPickableTiles()) {
      const b = document.createElement('button');
      const { suit, red } = tileSuitClass(t);
      b.className = `tile suit-${suit}${red ? ' aka' : ''}`;
      b.innerHTML = `<span class="glyph">${tileGlyph(t)}</span><span class="lab">${tileLabel(t)}</span>`;
      b.onclick = () => { done(t); };
      grid.appendChild(b);
    }
    modal.appendChild(grid);

    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    if (opts.allowDelete) {
      const del = document.createElement('button');
      del.className = 'btn danger';
      del.textContent = 'Delete tile';
      del.onclick = () => done('delete');
      foot.appendChild(del);
    }
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => done(null);
    foot.appendChild(cancel);
    modal.appendChild(foot);

    overlay.appendChild(modal);
    overlay.onclick = (e) => { if (e.target === overlay) done(null); };
    document.body.appendChild(overlay);

    function done(r: PickResult) { overlay.remove(); resolve(r); }
  });
}
