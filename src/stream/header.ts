/**
 * Surgical edits to a kyoku's "header" — its dora indicators and the four
 * haipai — inside a raw transcription, leaving the round token and every play
 * token untouched. This backs the quick-edit fields above the stream textarea:
 * a recorder rarely has time to key in all the haipai at the start of a hand, so
 * they can fill them (and the dora) in later without disturbing the live stream.
 *
 * The token boundaries mirror the parser: dora/ura tokens and the four haipai
 * (each "name:tiles", bare tiles, a separate name token, or "?") form the header
 * region that follows the round token, ending once four seats are accounted for.
 */
import { parseTileNotation } from '../core/tiles.js';

const RE_ROUND = /^[eswn][1-4]([._\-][0-9]+){0,2}$/i;
const RE_DORA = /^(kandora|dora|d)([0-9].*[mpsz])$/i;
const RE_URA = /^(ura|u)([0-9].*[mpsz])$/i;
const RE_DORAI = /^(dorai|di)([0-9a].*[mpsz])$/i;
const RE_URAI = /^(urai|ui)([0-9a].*[mpsz])$/i;
const isDoraTok = (t: string) => RE_DORA.test(t) || RE_URA.test(t) || RE_DORAI.test(t) || RE_URAI.test(t);

interface Tok { text: string; start: number; end: number; }
function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /[^\s,]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

export interface HeaderEdit {
  /** Dora-indicator notation (dead-wall tiles), emitted as a `di…` token. Empty ⇒ no dora token. */
  dora: string;
  /** Ura-dora-indicator notation, emitted as a `ui…` token. Empty ⇒ no ura token. */
  ura: string;
  /** Per current-seat (E,S,W,N) haipai tile notation; '' ⇒ a `?` placeholder. */
  haipai: string[];
  /** Per current-seat player name to prefix ("name:tiles"); '' ⇒ bare tiles. */
  names: string[];
}

/**
 * Rewrite the dora / ura / haipai of the `kyokuIndex`-th hand in `text` from
 * `edit`, preserving the round token and every play token. Dora/ura tokens are
 * consolidated into the header (their stream position doesn't affect parsing),
 * so a loaded game's trailing `u…` won't duplicate. Returns `text` unchanged if
 * that hand's round token isn't present yet (nothing to anchor to).
 */
export function spliceRoundHeader(text: string, kyokuIndex: number, edit: HeaderEdit): string {
  const tk = tokenize(text);
  const rounds = tk.filter((t) => RE_ROUND.test(t.text));
  const round = rounds[kyokuIndex];
  if (!round) return text;
  const ri = tk.indexOf(round);
  const nextRound = rounds[kyokuIndex + 1];
  const endTok = nextRound ? tk.indexOf(nextRound) : tk.length; // token index where this hand ends
  const kyokuEnd = nextRound ? nextRound.start : text.length;   // char offset where this hand ends

  // Walk forward over the header region (dora/ura tokens + four haipai seats).
  // A bare single tile is a discard (haipai are 13–14 tiles), so it ends the
  // header — matching the parser — and keeps live-recorded plays out of it.
  let seat = 0, headerEnd = round.end, hi = ri + 1;
  for (; hi < endTok && seat < 4; hi++) {
    const t = tk[hi];
    if (isDoraTok(t.text)) { headerEnd = t.end; continue; }
    if (t.text === '?') { seat++; headerEnd = t.end; continue; }
    const colon = t.text.indexOf(':');
    const body = colon >= 0 ? t.text.slice(colon + 1) : t.text;
    const n = parseTileNotation(body).length;
    if (n === 1 && colon < 0) break;                  // a bare discard — header is over
    headerEnd = t.end;
    if (n) seat++;                                    // a filled seat (else a bare name token)
  }

  let head = '';
  if (edit.dora.trim()) head += ` di${edit.dora.trim()}`;
  if (edit.ura.trim()) head += ` ui${edit.ura.trim()}`;
  for (let s = 0; s < 4; s++) {
    const tiles = (edit.haipai[s] || '').trim();
    const name = (edit.names[s] || '').trim().replace(/[\s:]+/g, '_');
    // "name:tiles" when the haipai is known; "name ?" keeps the name on a still-
    // unknown haipai (a bare "?" otherwise), so names can be filled in first.
    if (tiles) head += ` ${name ? `${name}:` : ''}${tiles}`;
    else head += name ? ` ${name} ?` : ' ?';
  }

  // Play region (after the header, up to the next hand), with any stray dora/ura
  // tokens removed — they now live in the rebuilt header.
  let rest = text.slice(headerEnd, kyokuEnd);
  const strays = tk.slice(hi, endTok).filter((t) => isDoraTok(t.text));
  for (let j = strays.length - 1; j >= 0; j--) {
    const s = strays[j].start - headerEnd, e = strays[j].end - headerEnd;
    const cut = s > 0 && rest[s - 1] === ' ' ? s - 1 : s; // also drop one leading space
    rest = rest.slice(0, cut) + rest.slice(e);
  }
  return text.slice(0, round.end) + head + rest + text.slice(kyokuEnd);
}
