/** Minimal modal dialog: a dimmed overlay with a centered panel. Closes on the
 *  ✕ button, Escape, or a backdrop click. */

import { el } from './dom.js';
import { icon } from './icon.js';

export interface DialogHandle { close: () => void; panel: HTMLElement; }

export function openDialog(opts: { title: string; body: (Node | string)[] }): DialogHandle {
  const closeBtn = el('button', { class: 'dialog-x', title: 'Close', onClick: () => close() }, [icon('close')]);
  const panel = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'dialog-head' }, [el('span', { class: 'dialog-title' }, [opts.title]), closeBtn]),
    el('div', { class: 'dialog-body' }, opts.body),
  ]);
  const overlay = el('div', { class: 'dialog-overlay', onClick: (e: Event) => { if (e.target === overlay) close(); } }, [panel]);

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }

  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return { close, panel };
}
