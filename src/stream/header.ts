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
  /** Per current-seat (E,S,W,N) haipai tile notation; '' ⇒ a `?` placeholder. */
  haipai: string[];
  /** Per current-seat player name to prefix ("name:tiles"); '' ⇒ bare tiles. */
  names: string[];
}

/**
 * Rewrite the dora + haipai of the `kyokuIndex`-th hand in `text` from `edit`,
 * preserving the round token and all play tokens. Returns `text` unchanged if
 * that hand's round token isn't present yet (nothing to anchor to).
 */
export function spliceRoundHeader(text: string, kyokuIndex: number, edit: HeaderEdit): string {
  const tk = tokenize(text);
  const round = tk.filter((t) => RE_ROUND.test(t.text))[kyokuIndex];
  if (!round) return text;
  const ri = tk.indexOf(round);

  // Walk forward over the header region (dora/ura tokens + four haipai seats).
  let seat = 0, headerEnd = round.end;
  for (let i = ri + 1; i < tk.length && seat < 4; i++) {
    const t = tk[i];
    if (RE_ROUND.test(t.text)) break;                 // next kyoku begins
    if (isDoraTok(t.text)) { headerEnd = t.end; continue; }
    if (t.text === '?') { seat++; headerEnd = t.end; continue; }
    const colon = t.text.indexOf(':');
    const body = colon >= 0 ? t.text.slice(colon + 1) : t.text;
    headerEnd = t.end;
    if (parseTileNotation(body).length) seat++;       // a filled seat (else a bare name token)
  }

  let head = '';
  if (edit.dora.trim()) head += ` di${edit.dora.trim()}`;
  for (let s = 0; s < 4; s++) {
    const tiles = (edit.haipai[s] || '').trim();
    const name = (edit.names[s] || '').trim();
    head += ' ' + (tiles ? (name ? `${name}:${tiles}` : tiles) : '?');
  }
  return text.slice(0, round.end) + head + text.slice(headerEnd);
}
