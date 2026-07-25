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
