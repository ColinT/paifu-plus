/** Client-only sharing: encode a log (+ comments) into a URL-safe string, and a
 *  stable id for keying locally-stored comments. No backend. */

export interface Comment { ky: number; step: number; text: string; }
export interface SharePayload { log: unknown; comments?: Comment[] }

function b64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeShare(payload: SharePayload): string { return b64urlEncode(JSON.stringify(payload)); }
export function decodeShare(s: string): SharePayload | null {
  try { const p = JSON.parse(b64urlDecode(s)); if (p && p.log) return p; } catch { /* ignore */ }
  return null;
}

/** Full shareable URL embedding the log + comments in the fragment. */
export function shareUrl(payload: SharePayload): string {
  return `${location.origin}${location.pathname}#replay=${encodeShare(payload)}`;
}

/** Read a shared payload from the current URL fragment, if any. */
export function readShareFromUrl(): SharePayload | null {
  const m = /[#&]replay=([^&]+)/.exec(location.hash);
  return m ? decodeShare(m[1]) : null;
}

/** Stable short id for a log (FNV-1a), used to key locally-stored comments. */
export function logId(log: unknown): string {
  const s = JSON.stringify(log);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

const key = (id: string) => `paifu-comments-${id}`;
export function loadComments(id: string): Comment[] {
  try { const raw = localStorage.getItem(key(id)); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
export function saveComments(id: string, comments: Comment[]): void {
  try { localStorage.setItem(key(id), JSON.stringify(comments)); } catch { /* quota / disabled */ }
}
