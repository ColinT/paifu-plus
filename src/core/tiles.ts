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
 *
 * PaifuPlus additionally supports aka dora on ANY tile (a house rule tenhou's
 * format can't express). Such a tile is encoded as its plain code + 100
 * (e.g. 147 = aka chun, 113 = aka 3m); aka fives keep the native 51/52/53.
 * The +100 codes flow through as opaque numbers and are stripped to the plain
 * tile only at the tenhou-JSON boundary.
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

/** True for any aka dora: a red five (51/52/53) or an aka on another tile (+100). */
export function isAka(t: TenhouTile): boolean {
  return t === 51 || t === 52 || t === 53 || t >= 100;
}

/** The aka variant of a plain tile: a five → its native red-five code, any other
 *  tile → plain code + 100. Idempotent on tiles that are already aka. */
export function makeAka(code: TenhouTile): TenhouTile {
  if (code === 15 || code === 51) return 51;
  if (code === 25 || code === 52) return 52;
  if (code === 35 || code === 53) return 53;
  return code >= 100 ? code : code + 100;
}

/** Strip any aka marking to the plain tile code (51 -> 15, 147 -> 47). */
export function normalizeRed(t: TenhouTile): TenhouTile {
  if (t >= 100) return t - 100;
  switch (t) {
    case 51: return 15;
    case 52: return 25;
    case 53: return 35;
    default: return t;
  }
}

/** Drop only arbitrary (+100) aka, keeping native red-fives — for tenhou export. */
export function stripAka(t: TenhouTile): TenhouTile {
  return t >= 100 ? t - 100 : t;
}

/** The dora tile shown by an indicator (next in sequence, wrapping):
 *  6p→7p, 9m→1m, N(44)→E(41), chun(47)→haku(45). */
export function indicatorToDora(t: TenhouTile): TenhouTile {
  const n = normalizeRed(t);
  if (n >= 41 && n <= 44) return n === 44 ? 41 : n + 1; // winds
  if (n >= 45 && n <= 47) return n === 47 ? 45 : n + 1; // dragons
  const base = Math.floor(n / 10) * 10, r = n % 10;      // number tiles 1..9
  return base + (r === 9 ? 1 : r + 1);
}

/** The indicator that reveals a given dora (inverse of {@link indicatorToDora}):
 *  7p→6p, 1m→9m, E(41)→N(44), haku(45)→chun(47). */
export function doraToIndicator(t: TenhouTile): TenhouTile {
  const n = normalizeRed(t);
  if (n >= 41 && n <= 44) return n === 41 ? 44 : n - 1;
  if (n >= 45 && n <= 47) return n === 45 ? 47 : n - 1;
  const base = Math.floor(n / 10) * 10, r = n % 10;
  return base + (r === 1 ? 9 : r - 1);
}

const HONOR_NAMES = ['', 'E', 'S', 'W', 'N', 'haku', 'hatsu', 'chun'];

/** Human-readable label, e.g. 15 -> "5m", 51 -> "0m", 41 -> "E", 147 -> "aka chun". */
export function tileLabel(t: TenhouTile): string {
  if (t >= 100) return 'aka ' + tileLabel(t - 100);
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
 *   "a7z" / "aka7z" → aka dora chun (147); "a" prefixes the next tile
 * Digits accumulate until a suit letter (m/p/s/z) flushes them. An "a" marks
 * the next tile as aka. Other characters (spaces, commas, the "k" in "aka")
 * are ignored, so it's forgiving for fast entry.
 */
export function parseTileNotation(input: string): TenhouTile[] {
  const out: TenhouTile[] = [];
  let digits: { d: number; aka: boolean }[] = [];
  let akaPending = false;
  for (const ch of input.toLowerCase()) {
    if (ch === 'a') { akaPending = true; continue; }
    if (ch >= '0' && ch <= '9') { digits.push({ d: ch.charCodeAt(0) - 48, aka: akaPending }); akaPending = false; continue; }
    if (ch === 'm' || ch === 'p' || ch === 's' || ch === 'z') {
      for (const { d, aka } of digits) {
        let code: number | null = null;
        if (ch === 'z') { if (d >= 1 && d <= 7) code = 40 + d; }
        else if (d === 0) code = ch === 'm' ? 51 : ch === 'p' ? 52 : 53;
        else code = (ch === 'm' ? 10 : ch === 'p' ? 20 : 30) + d;
        if (code === null) continue;
        out.push(aka ? makeAka(code) : code);
      }
      digits = []; akaPending = false;
    }
    // any other char (space, comma, the "k" of "aka", etc.) is ignored and
    // does NOT clear a pending aka flag
  }
  return out;
}

/** Format tenhou codes as notation, grouping consecutive same-suit tiles:
 *  [11,12,13,21] → "123m1p"; aka tiles get an "a" prefix ([147] → "a7z"). */
export function tilesToNotation(tiles: TenhouTile[]): string {
  let out = '', curSuit = '', buf = '';
  const flush = () => { if (buf) { out += buf + curSuit; buf = ''; } };
  for (const t of tiles) {
    let suit: string, digit: string, aka = false;
    if (t === 51) { suit = 'm'; digit = '0'; }
    else if (t === 52) { suit = 'p'; digit = '0'; }
    else if (t === 53) { suit = 's'; digit = '0'; }
    else {
      let base = t;
      if (t >= 100) { aka = true; base = t - 100; }
      if (base >= 41) { suit = 'z'; digit = String(base - 40); }
      else { const s = Math.floor(base / 10); suit = s === 1 ? 'm' : s === 2 ? 'p' : 's'; digit = String(base % 10); }
    }
    if (suit !== curSuit) { flush(); curSuit = suit; }
    buf += (aka ? 'a' : '') + digit;
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
