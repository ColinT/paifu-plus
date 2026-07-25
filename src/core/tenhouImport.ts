/**
 * Decode a tenhou.net/6 JSON log back into the intermediate Game model.
 *
 * This is the inverse of {@link ./tenhou.ts gameToTenhou}: it lets the replay
 * tool hand a loaded log back to the editor (and keeps editor⇄replay in sync).
 * It is intentionally faithful to this app's own emitter — chi/pon/daiminkan/
 * kakan live in the draw stream, ankan in the discard stream — while still
 * tolerating external logs that place added/closed kans in the discard slot.
 */

import type { TenhouTile } from './tiles.js';
import type { Game, Kyoku, PlayerHand, Call, CallType, Turn, Seat, KyokuResult, EndKind, Agari } from './model.js';
import type { TenhouLog } from './tenhou.js';

const normRed = (t: TenhouTile) => (t === 51 ? 15 : t === 52 ? 25 : t === 53 ? 35 : t);

/** Split a meld string into its ordered tiles and the position/letter of the call marker. */
function scanMeld(s: string): { tiles: TenhouTile[]; letter: string; letterPos: number } {
  const tiles: TenhouTile[] = [];
  let letter = ''; let letterPos = -1;
  const re = /([a-z])?(\d\d)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) { letter = m[1].toLowerCase(); letterPos = tiles.length; }
    tiles.push(Number(m[2]) as TenhouTile);
  }
  return { tiles, letter, letterPos };
}

const CALL_TYPE: Record<string, CallType> = { c: 'chi', p: 'pon', m: 'daiminkan', k: 'kakan', a: 'ankan' };

function decodeMeld(s: string, seat: Seat, turn: number): Call {
  const { tiles, letter, letterPos } = scanMeld(s);
  const type = CALL_TYPE[letter] ?? 'ankan';
  if (type === 'ankan') return { type, tiles, turn };
  const calledTile = tiles[letterPos];
  // Letter's tile-position encodes the source: 0=kamicha, 1=toimen, 2/3=shimocha.
  // Chi is always from kamicha.
  const rel = type === 'chi' ? 0 : letterPos <= 0 ? 0 : letterPos === 1 ? 1 : 2;
  const fromSeat = (((seat + 3 - rel) % 4) + 4) % 4 as Seat; // kamicha=seat-1, toimen=seat-2, shimocha=seat-3
  return { type, tiles, calledTile, fromSeat, turn };
}

/** A kan sitting in the discard slot (ankan "…a…", added-kan "…k…", or "…m…"). */
function isKanInDiscard(v: unknown): v is string {
  return typeof v === 'string' && /[akm]/i.test(v);
}

function decodePlayer(
  seat: Seat, name: string, startScore: number, delta: number,
  haipai: TenhouTile[], draws: (number | string)[], discards: (number | string)[],
): PlayerHand {
  const turns: Turn[] = [];
  const calls: Call[] = [];
  const n = Math.max(draws.length, discards.length);
  let lastDraw: TenhouTile | undefined;

  for (let i = 0; i < n; i++) {
    const turn: Turn = {};
    const d = draws[i];
    if (typeof d === 'number') { turn.draw = d; lastDraw = d; }
    else if (typeof d === 'string') { calls.push(decodeMeld(d, seat, turns.length)); } // chi/pon/daiminkan: called turn, no wall draw

    const s = discards[i];
    if (s === undefined) {
      // no discard this turn (winning tsumo turn) — keep the draw, omit discard
    } else if (isKanInDiscard(s)) {
      const meld = decodeMeld(s, seat, turns.length);
      if (meld.type === 'kakan') {
        // Added kan sits after this turn's wall draw and upgrades the open pon.
        const pon = calls.find((c) => c.type === 'pon' && c.calledTile !== undefined && normRed(c.calledTile) === normRed(meld.calledTile!));
        if (pon) { pon.type = 'kakan'; pon.tiles = meld.tiles; pon.kanTurn = turns.length; }
        else calls.push(meld);
      } else {
        calls.push(meld); // ankan: no discard this turn
      }
    } else {
      let riichi = false; let str = String(s);
      if (str.startsWith('r')) { riichi = true; str = str.slice(1); }
      const code = Number(str);
      if (code === 60) { turn.tsumogiri = true; turn.discard = lastDraw; }
      else turn.discard = code as TenhouTile;
      if (riichi) turn.riichi = true;
    }
    turns.push(turn);
  }

  return { seat, name, startScore, scoreDelta: delta, haipai: [...haipai], turns, calls };
}

function parseYaku(strs: unknown[]): { name: string; han: number }[] {
  const out: { name: string; han: number }[] = [];
  for (const y of strs) {
    if (typeof y !== 'string') continue;
    const m = y.match(/^(.*?)\((\d+)飜\)$/);
    if (m) out.push({ name: m[1], han: Number(m[2]) });
  }
  return out;
}

function lastDrawOf(p: PlayerHand): TenhouTile | undefined {
  for (let i = p.turns.length - 1; i >= 0; i--) if (p.turns[i].draw !== undefined) return p.turns[i].draw;
  return undefined;
}
function lastDiscardOf(p: PlayerHand): TenhouTile | undefined {
  for (let i = p.turns.length - 1; i >= 0; i--) {
    const t = p.turns[i];
    if (t.discard !== undefined) return t.tsumogiri ? t.draw ?? t.discard : t.discard;
  }
  return undefined;
}

function decodeResult(raw: unknown, players: PlayerHand[]): KyokuResult {
  const combined = [0, 0, 0, 0] as [number, number, number, number];
  if (!Array.isArray(raw)) return { kind: 'ryuukyoku', deltas: combined };
  const kindStr = String(raw[0] ?? '');

  if (kindStr.includes('流') || !kindStr.includes('和')) {
    if (Array.isArray(raw[1])) for (let i = 0; i < 4; i++) combined[i] = Math.round((raw[1] as number[])[i] ?? 0);
    return { kind: 'ryuukyoku', deltas: combined };
  }

  // Agari: one or more (deltas, detail) pairs — a pair per winning hand.
  const pairs: { deltas: [number, number, number, number]; detail: unknown[] }[] = [];
  for (let i = 1; i + 1 < raw.length; i += 2) {
    const d = raw[i]; const det = raw[i + 1];
    if (!Array.isArray(d) || !Array.isArray(det)) break;
    const dd = [0, 0, 0, 0] as [number, number, number, number];
    for (let j = 0; j < 4; j++) dd[j] = Math.round((d as number[])[j] ?? 0);
    pairs.push({ deltas: dd, detail: det });
  }
  if (!pairs.length) return { kind: 'ryuukyoku', deltas: combined };
  for (const p of pairs) for (let i = 0; i < 4; i++) combined[i] += p.deltas[i];

  const from = Number(pairs[0].detail[1]) as Seat;
  const kind: EndKind = (Number(pairs[0].detail[0]) as Seat) === from ? 'tsumo' : 'ron';
  const agaris: Agari[] = pairs.map((p): Agari => {
    const w = Number(p.detail[0]) as Seat;
    const scoreText = typeof p.detail[3] === 'string' ? p.detail[3] : undefined;
    const yaku = parseYaku(p.detail.slice(4));
    const winningTile = kind === 'tsumo' ? lastDrawOf(players[w]) : lastDiscardOf(players[from]);
    const a: Agari = { winner: w, winningTile, yaku, scoreText, deltas: p.deltas };
    const fh = scoreText?.match(/(\d+)符(\d+)飜/);
    if (fh) { a.fu = Number(fh[1]); a.han = Number(fh[2]); }
    else if (yaku.length) a.han = yaku.reduce((s, y) => s + y.han, 0);
    return a;
  });

  const primary = agaris[0];
  const res: KyokuResult = {
    kind, winner: primary.winner, winningTile: primary.winningTile,
    deltas: combined, yaku: primary.yaku, scoreText: primary.scoreText, han: primary.han, fu: primary.fu,
  };
  if (kind === 'ron') res.loser = from;
  if (agaris.length > 1) res.wins = agaris;
  return res;
}

function decodeKyoku(entry: unknown[], names: string[]): Kyoku {
  const [round, honba, riichiSticks] = (entry[0] as number[]) ?? [0, 0, 0];
  const scores = (entry[1] as number[]) ?? [25000, 25000, 25000, 25000];
  const doraIndicators = ((entry[2] as TenhouTile[]) ?? []).slice();
  const uraIndicators = ((entry[3] as TenhouTile[]) ?? []).slice();

  const result = decodeResultDeltas(entry[16]);
  const players = Array.from({ length: 4 }, (_, p) => decodePlayer(
    p as Seat, names[p] ?? `Player ${p + 1}`, scores[p] ?? 25000, result.deltas[p],
    (entry[4 + p * 3] as TenhouTile[]) ?? [],
    (entry[5 + p * 3] as (number | string)[]) ?? [],
    (entry[6 + p * 3] as (number | string)[]) ?? [],
  )) as [PlayerHand, PlayerHand, PlayerHand, PlayerHand];

  return {
    round, honba, riichiSticks, doraIndicators, uraIndicators, players,
    result: decodeResult(entry[16], players),
  };
}

/** Pre-read just the deltas so per-player scoreDelta is available while decoding
 *  streams. Sums every delta array (agari lists one per winning hand). */
function decodeResultDeltas(raw: unknown): { deltas: [number, number, number, number] } {
  const deltas = [0, 0, 0, 0] as [number, number, number, number];
  if (!Array.isArray(raw)) return { deltas };
  if (String(raw[0] ?? '').includes('和')) {
    for (let i = 1; i + 1 < raw.length; i += 2) {
      const d = raw[i];
      if (Array.isArray(d)) for (let j = 0; j < 4; j++) deltas[j] += Math.round((d as number[])[j] ?? 0);
    }
  } else if (Array.isArray(raw[1])) {
    for (let j = 0; j < 4; j++) deltas[j] = Math.round((raw[1] as number[])[j] ?? 0);
  }
  return { deltas };
}

export function tenhouToGame(log: TenhouLog | any): Game {
  const names: string[] = Array.isArray(log?.name) ? log.name : ['Player 1', 'Player 2', 'Player 3', 'Player 4'];
  const title: string[] = Array.isArray(log?.title) ? log.title : [String(log?.title ?? 'Imported log'), ''];
  const rule = log?.rule && typeof log.rule === 'object' ? log.rule : { disp: '', aka: 0 };
  const entries: unknown[][] = Array.isArray(log?.log) ? log.log : [];
  const kyokus = entries.map((e) => decodeKyoku(e, names));
  return {
    meta: {
      title: title.length ? title : ['Imported log', ''],
      names: [names[0] ?? 'Player 1', names[1] ?? 'Player 2', names[2] ?? 'Player 3', names[3] ?? 'Player 4'],
      rule: { disp: rule.disp ?? '', aka: rule.aka ?? 0 },
    },
    kyokus: kyokus.length ? kyokus : [],
  };
}
