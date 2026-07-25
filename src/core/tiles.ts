/**
 * Tile encoding for the tenhou.net/6 JSON format.
 *
 * A tile is represented by its tenhou numeric code:
 *   man (m):    11-19   (1m..9m)
 *   pin (p):    21-29   (1p..9p)
 *   sou (s):    31-39   (1s..9s)
 *   honors (z): 41-47   (East, South, West, North, Haku, Hatsu, Chun)
 *   red fives:  51 (0m), 52 (0p), 53 (0s)
 *
 * These integers are exactly what appears in the tenhou log arrays, so the
 * emitter can use them directly.
 */

export type Suit = 'm' | 'p' | 's' | 'z';
export type TenhouTile = number;

const SUIT_BASE: Record<Exclude<Suit, 'z'>, number> = { m: 10, p: 20, s: 30 };
const RED_CODE: Record<Exclude<Suit, 'z'>, number> = { m: 51, p: 52, s: 53 };

/** Build a tenhou tile code from suit + rank. `red` makes a 5 into an aka-five. */
export function tile(suit: Suit, rank: number, red = false): TenhouTile {
  if (suit === 'z') {
    if (rank < 1 || rank > 7) throw new Error(`honor rank out of range: ${rank}`);
    return 40 + rank;
  }
  if (rank < 1 || rank > 9) throw new Error(`${suit} rank out of range: ${rank}`);
  if (red) {
    if (rank !== 5) throw new Error(`red tile must be a 5, got ${rank}${suit}`);
    return RED_CODE[suit];
  }
  return SUIT_BASE[suit] + rank;
}

export function isRedFive(t: TenhouTile): boolean {
  return t === 51 || t === 52 || t === 53;
}

/** Normalize a red five to its plain-5 code (51 -> 15, 52 -> 25, 53 -> 35). */
export function normalizeRed(t: TenhouTile): TenhouTile {
  switch (t) {
    case 51: return 15;
    case 52: return 25;
    case 53: return 35;
    default: return t;
  }
}

const HONOR_NAMES = ['', 'E', 'S', 'W', 'N', 'haku', 'hatsu', 'chun'];

/** Human-readable label, e.g. 15 -> "5m", 51 -> "0m", 41 -> "E". */
export function tileLabel(t: TenhouTile): string {
  if (t === 51) return '0m';
  if (t === 52) return '0p';
  if (t === 53) return '0s';
  if (t >= 41 && t <= 47) return HONOR_NAMES[t - 40];
  const suit = Math.floor(t / 10);
  const rank = t % 10;
  const s = suit === 1 ? 'm' : suit === 2 ? 'p' : suit === 3 ? 's' : '?';
  return `${rank}${s}`;
}

/**
 * Parse standard mahjong tile notation into tenhou codes, e.g.
 *   "123m456p789s"  → 1m2m3m 4p5p6p 7s8s9s
 *   "0m"            → red five man (51)
 *   "1234567z"      → E S W N haku hatsu chun (41..47)
 * Digits accumulate until a suit letter (m/p/s/z) flushes them. Unknown
 * characters (spaces, commas) are ignored, so it's forgiving for fast entry.
 */
export function parseTileNotation(input: string): TenhouTile[] {
  const out: TenhouTile[] = [];
  let digits: number[] = [];
  for (const ch of input.toLowerCase()) {
    if (ch >= '0' && ch <= '9') { digits.push(ch.charCodeAt(0) - 48); continue; }
    if (ch === 'm' || ch === 'p' || ch === 's' || ch === 'z') {
      for (const d of digits) {
        if (ch === 'z') { if (d >= 1 && d <= 7) out.push(40 + d); }
        else if (d === 0) out.push(ch === 'm' ? 51 : ch === 'p' ? 52 : 53);
        else out.push((ch === 'm' ? 10 : ch === 'p' ? 20 : 30) + d);
      }
      digits = [];
    }
    // any other char (space, comma, etc.) is ignored
  }
  return out;
}

/** Format tenhou codes as notation, grouping consecutive same-suit tiles: [11,12,13,21] → "123m1p". */
export function tilesToNotation(tiles: TenhouTile[]): string {
  let out = '', curSuit = '', buf = '';
  const flush = () => { if (buf) { out += buf + curSuit; buf = ''; } };
  for (const t of tiles) {
    let suit: string, digit: string;
    if (t === 51) { suit = 'm'; digit = '0'; }
    else if (t === 52) { suit = 'p'; digit = '0'; }
    else if (t === 53) { suit = 's'; digit = '0'; }
    else if (t >= 41) { suit = 'z'; digit = String(t - 40); }
    else { const s = Math.floor(t / 10); suit = s === 1 ? 'm' : s === 2 ? 'p' : 's'; digit = String(t % 10); }
    if (suit !== curSuit) { flush(); curSuit = suit; }
    buf += digit;
  }
  flush();
  return out;
}

/** Parse a short label like "5m", "0p", "E" back into a tenhou code. */
export function parseLabel(label: string): TenhouTile {
  const l = label.trim();
  const honors: Record<string, number> = {
    E: 41, S: 42, W: 43, N: 44, haku: 45, hatsu: 46, chun: 47,
  };
  if (l in honors) return honors[l];
  const m = /^([0-9])([mps])$/.exec(l);
  if (!m) throw new Error(`bad tile label: ${label}`);
  const rank = Number(m[1]);
  const suit = m[2] as Exclude<Suit, 'z'>;
  if (rank === 0) return RED_CODE[suit];
  return tile(suit, rank);
}
