/**
 * Parse a single PAIFUN (最高位戦-style) kyoku page (a RawPage) into a Kyoku
 * model. Layout facts this relies on (validated against ketteisen1-1/2/4):
 *
 *  - Header: title (top), a "東N局M本場供託K点" round line, and up to 2 dora
 *    indicator tiles in a row above the first player band (absent in no-dora
 *    variants).
 *  - Four player bands top→bottom = current seats East, South, West, North.
 *    Each band has a 持点 (start score), a seat+name+動き line, a 合計 (end
 *    score), and four tile rows labelled 配牌 / ツモ / 捨牌 / 最終形.
 *  - ツモ row: a ↓ arrow = tsumogiri (drew and discarded the same tile).
 *  - Riichi/win/deal-in tiles are marked by the x-position of the ﾘｰﾁ / ロン /
 *    ツモ / ﾌﾘｺﾐ text aligning with a tile in the relevant row.
 *  - Calls: a landscape (rotated) tile in the 最終形 row, set off by an x-gap,
 *    is a chi/pon/minkan called tile; four identical grouped tiles are an ankan.
 *
 * The fixed player index (tenhou seat 0..3, constant across the game) is
 * recovered from the current seat and the round: index = (seat - round) mod 4.
 */

import type { TenhouTile } from '../core/tiles.js';
import type { Kyoku, PlayerHand, Turn, Call, Seat, KyokuResult, EndKind } from '../core/model.js';
import type { RawPage, RawTile, RawText } from './extract.js';
import { classifyHash } from './tileHashes.js';

// ---------- text helpers ----------

const Z2H: Record<string, string> = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9', '＋': '+', '－': '-', '　': ' ' };
function normDigits(s: string): string {
  return s.replace(/[０-９＋－　]/g, (c) => Z2H[c] ?? c);
}
function toInt(s: string): number {
  const n = parseInt(normDigits(s).replace(/[^0-9+-]/g, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

interface Line { y: number; text: string; items: RawText[]; }

function groupLines(texts: RawText[], tol = 3): Line[] {
  const sorted = [...texts].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    let line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (!line) { line = { y: it.y, text: '', items: [] }; lines.push(line); }
    line.items.push(it);
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.text = l.items.map((i) => i.str).join('');
    l.y = Math.round(l.items.reduce((s, i) => s + i.y, 0) / l.items.length);
  }
  return lines.sort((a, b) => b.y - a.y);
}

// ---------- tile row helpers ----------

interface TileCell { x: number; tile: TenhouTile | null; arrow: boolean; landscape: boolean; hash: string; }

function toCell(t: RawTile): TileCell {
  const k = classifyHash(t.hash);
  if (k.kind === 'arrow') return { x: t.x, tile: null, arrow: true, landscape: false, hash: t.hash };
  if (k.kind === 'tile') return { x: t.x, tile: k.tile, arrow: false, landscape: k.landscape || t.landscape, hash: t.hash };
  return { x: t.x, tile: null, arrow: false, landscape: t.landscape, hash: t.hash }; // unknown
}

function clusterRows(tiles: RawTile[], tol = 6): { y: number; cells: TileCell[] }[] {
  const rows: { y: number; cells: TileCell[] }[] = [];
  for (const t of tiles) {
    let r = rows.find((r) => Math.abs(r.y - t.y) <= tol);
    if (!r) { r = { y: t.y, cells: [] }; rows.push(r); }
    r.cells.push(toCell(t));
  }
  for (const r of rows) { r.cells.sort((a, b) => a.x - b.x); r.y = Math.round(r.y); }
  return rows.sort((a, b) => b.y - a.y);
}

// ---------- round parsing ----------

const ROUND_WIND: Record<string, number> = { '東': 0, '南': 4, '西': 8, '北': 12 };

function parseRound(lines: Line[]): { round: number; honba: number; sticks: number } {
  for (const l of lines) {
    const m = /([東南西北])([０-９\d]+)局([０-９\d]+)本場.*?供託([０-９\d]+)/.exec(l.text);
    if (m) {
      const round = ROUND_WIND[m[1]] + (toInt(m[2]) - 1);
      return { round, honba: toInt(m[3]), sticks: toInt(m[4]) };
    }
  }
  throw new Error('could not find round line (東N局...)');
}

// ---------- band model ----------

const SEAT_OF: Record<string, Seat> = { '東': 0, '南': 1, '西': 2, '北': 3 };

interface BandInfo {
  seat: Seat;            // current-hand seat (0=E..3=N)
  name: string;
  startScore: number;
  endScore: number;
  topY: number;          // 持点 line y (band upper bound)
}

function parseBands(lines: Line[]): BandInfo[] {
  const bands: BandInfo[] = [];
  // 持点 lines mark band tops.
  const mochiten = lines.filter((l) => /持点/.test(l.text)).map((l) => ({ y: l.y, v: toInt(l.text) }));
  for (const l of lines) {
    const m = /([東南西北])家\s*([^\d０-９]+?)動き/.exec(l.text);
    if (!m) continue;
    const seat = SEAT_OF[m[1]];
    const name = m[2].replace(/\s+/g, ' ').trim();
    const top = mochiten.reduce((best, mm) => (mm.y >= l.y && mm.y < best.y ? mm : best), { y: Infinity, v: 0 });
    const totalLine = lines.filter((x) => /合計/.test(x.text) && x.y < l.y).sort((a, b) => b.y - a.y)[0];
    bands.push({
      seat, name,
      startScore: top.v,
      endScore: totalLine ? toInt(totalLine.text) : top.v,
      topY: Number.isFinite(top.y) ? top.y : l.y + 10,
    });
  }
  return bands.sort((a, b) => b.topY - a.topY); // East (highest y) first
}

// ---------- main parse ----------

export interface ParseOptions {
  /** Score scale: multiply parsed scores/deltas by this (最高位戦 uses 1). */
  scoreScale?: number;
}

export function parseKyoku(page: RawPage, opts: ParseOptions = {}): Kyoku {
  const scale = opts.scoreScale ?? 1;
  const lines = groupLines(page.texts);
  const { round, honba, sticks } = parseRound(lines);
  const bands = parseBands(lines);
  if (bands.length !== 4) throw new Error(`expected 4 player bands, found ${bands.length}`);

  // Band vertical boundaries: band k spans (topY[k+1], topY[k]].
  const tops = bands.map((b) => b.topY);
  const bandRange = (k: number): [number, number] => [k + 1 < 4 ? tops[k + 1] : -Infinity, tops[k]];

  // Dora indicators: tile rows above the first band top.
  const allRows = clusterRows(page.tiles);
  const doraRow = allRows.find((r) => r.y > tops[0]);
  const doraIndicators = doraRow ? doraRow.cells.filter((c) => c.tile !== null).map((c) => c.tile!) : [];
  // PAIFUN shows [dora indicator, ura indicator]; ura is meaningful only on a
  // riichi win but is always printed, so keep both and split.
  const dora = doraIndicators.slice(0, 1);
  const ura = doraIndicators.slice(1, 2);

  // Row-label y's per band.
  const players: PlayerHand[] = [];
  const seatWinner: { seat: Seat; kind: EndKind }[] = [];
  let riichiSeat: Seat | null = null;
  let loserSeat: Seat | null = null;
  let winTile: TenhouTile | undefined;

  for (let k = 0; k < 4; k++) {
    const band = bands[k];
    const [lo, hi] = bandRange(k);
    const inBand = (y: number) => y > lo && y < hi;

    // Row labels live in the left header column (small x); win/call markers sit
    // over the tiles (larger x). Separating them by x is what keeps the ツモ row
    // label from being confused with the ツモ win marker, etc.
    const LEFT_LABEL_X = 100;
    const labelItems = page.texts.filter((t) => inBand(t.y) && t.x < LEFT_LABEL_X);
    const markerItems = page.texts.filter((t) => inBand(t.y) && t.x >= LEFT_LABEL_X);
    const labelY = (needle: RegExp): number | null => {
      const it = labelItems.filter((t) => needle.test(t.str.replace(/\s/g, ''))).sort((a, b) => b.y - a.y)[0];
      return it ? it.y : null;
    };
    const yHaipai = labelY(/配/);
    const yTsumo = labelY(/ツ/);
    const ySutehai = labelY(/捨/);
    const yFinal = labelY(/最/);

    const bandRows = allRows.filter((r) => inBand(r.y));
    const nearest = (ly: number | null) => {
      if (ly == null) return undefined;
      return bandRows.reduce<{ d: number; row?: typeof bandRows[number] }>((best, r) => {
        const d = Math.abs(r.y - ly);
        return d < best.d ? { d, row: r } : best;
      }, { d: Infinity }).row;
    };

    const haipaiRow = nearest(yHaipai);
    const tsumoRow = nearest(yTsumo);
    const sutehaiRow = nearest(ySutehai);
    const finalRow = nearest(yFinal);

    const haipaiTiles = (haipaiRow?.cells ?? []).filter((c) => c.tile !== null && !c.landscape);
    const tsumoCells = (tsumoRow?.cells ?? []);
    const sutehaiCells = (sutehaiRow?.cells ?? []).filter((c) => c.tile !== null);

    // Draw stream: for a 14-tile dealer haipai, the extra tile is the first draw
    // (shown merged into the opening hand); prepend it and keep 13 as haipai.
    let haipai = haipaiTiles.map((c) => c.tile!) as TenhouTile[];
    const drawCells: { tile: TenhouTile | null; arrow: boolean }[] = [];
    if (haipai.length === 14) {
      drawCells.push({ tile: haipai[13], arrow: false }); // best-effort; user can correct in editor
      haipai = haipai.slice(0, 13);
    }
    for (const c of tsumoCells) drawCells.push({ tile: c.tile, arrow: c.arrow });

    // Pair draw[i] with discard[i]. An arrow draw = tsumogiri (drew & threw same).
    const turns: Turn[] = [];
    const n = Math.max(drawCells.length, sutehaiCells.length);
    for (let i = 0; i < n; i++) {
      const dc = drawCells[i];
      const sd = sutehaiCells[i];
      if (sd) {
        if (dc && dc.arrow) turns.push({ draw: sd.tile!, discard: sd.tile!, tsumogiri: true });
        else if (dc && dc.tile !== null) turns.push({ draw: dc.tile, discard: sd.tile! });
        else turns.push({ discard: sd.tile! }); // called turn (no wall draw)
      } else if (dc && dc.tile !== null) {
        turns.push({ draw: dc.tile }); // winning tsumo draw, no discard
      }
    }

    // riichi: ﾘｰﾁ marker aligned by x to a discard tile.
    const riichiMark = markerItems.find((t) => /ﾘｰﾁ|リーチ/.test(t.str));
    if (riichiMark && sutehaiCells.length) {
      let best = { d: Infinity, i: -1 };
      sutehaiCells.forEach((c, i) => { const d = Math.abs(c.x - riichiMark.x); if (d < best.d) best = { d, i }; });
      if (best.i >= 0 && turns[best.i]) { turns[best.i].riichi = true; riichiSeat = band.seat; }
    }

    // Win / deal-in markers (over the tiles, x >= LEFT_LABEL_X).
    const hasRon = markerItems.some((t) => /ロン/.test(t.str));
    const hasTsumoWin = markerItems.some((t) => /ツモ/.test(t.str));
    if (hasRon) seatWinner.push({ seat: band.seat, kind: 'ron' });
    else if (hasTsumoWin) seatWinner.push({ seat: band.seat, kind: 'tsumo' });
    if (markerItems.some((t) => /ﾌﾘｺﾐ|フリコミ/.test(t.str))) loserSeat = band.seat;

    // Calls: landscape tiles in the final row (chi/pon/minkan) and 4-of-a-kind (ankan).
    const calls = detectCalls(finalRow?.cells ?? [], markerItems);

    players.push({
      seat: band.seat,
      name: band.name,
      startScore: band.startScore * scale,
      scoreDelta: (band.endScore - band.startScore) * scale,
      haipai,
      turns,
      calls,
      finalHand: (finalRow?.cells ?? []).filter((c) => c.tile !== null).map((c) => c.tile!),
    });
  }

  // Result. The winning tile is derived from the reconstructed streams (robust)
  // rather than from marker alignment: tsumo = winner's last draw; ron = the
  // deal-in player's last discard (its actual tile, even if tsumogiri).
  const win = seatWinner[0];
  let result: KyokuResult;
  const deltas = orderByFixed(players, round, (p) => p.scoreDelta) as [number, number, number, number];
  if (win) {
    if (win.kind === 'tsumo') {
      const wp = players.find((p) => p.seat === win.seat);
      winTile = wp?.turns[wp.turns.length - 1]?.draw;
    } else {
      const lp = loserSeat != null ? players.find((p) => p.seat === loserSeat) : undefined;
      const last = lp?.turns[lp.turns.length - 1];
      winTile = last ? (last.tsumogiri ? last.draw : last.discard) : undefined;
    }
    result = { kind: win.kind, winner: fixedIndex(win.seat, round), loser: loserSeat != null ? fixedIndex(loserSeat, round) : undefined, winningTile: winTile, deltas };
  } else {
    result = { kind: 'ryuukyoku', deltas };
  }

  // Order players by fixed tenhou index.
  const ordered = new Array<PlayerHand>(4);
  for (const p of players) ordered[fixedIndex(p.seat, round)] = { ...p, seat: fixedIndex(p.seat, round) as Seat };

  void riichiSeat;
  return {
    round, honba, riichiSticks: sticks,
    doraIndicators: dora, uraIndicators: ura,
    players: ordered as [PlayerHand, PlayerHand, PlayerHand, PlayerHand],
    result,
  };
}

function fixedIndex(seat: Seat, round: number): Seat {
  return (((seat - round) % 4) + 4) % 4 as Seat;
}
function orderByFixed<T>(players: PlayerHand[], round: number, pick: (p: PlayerHand) => T): T[] {
  const out = new Array<T>(4);
  for (const p of players) out[fixedIndex(p.seat, round)] = pick(p);
  return out;
}

/** Detect melds from the final-hand row: landscape called tiles and ankan quads. */
function detectCalls(cells: TileCell[], bandTexts: RawText[]): Call[] {
  const calls: Call[] = [];
  const hasChi = bandTexts.some((t) => /チー/.test(t.str));
  const hasAnkan = bandTexts.some((t) => /暗槓/.test(t.str));
  const hasMinkan = bandTexts.some((t) => /明槓|加槓|追槓/.test(t.str));

  // A landscape tile marks a called meld; group it with its same-face neighbours.
  cells.forEach((c, i) => {
    if (!c.landscape || c.tile === null) return;
    const face = c.tile;
    const group = cells.filter((x) => x.tile === face);
    const type: Call['type'] = hasChi ? 'chi' : hasMinkan ? 'daiminkan' : 'pon';
    calls.push({ type, tiles: group.map((g) => g.tile!), calledTile: face, turn: 0, fromSeat: undefined });
    void i;
  });

  if (hasAnkan) {
    // Four identical tiles with no landscape member.
    const counts = new Map<TenhouTile, number>();
    for (const c of cells) if (c.tile !== null && !c.landscape) counts.set(c.tile, (counts.get(c.tile) ?? 0) + 1);
    for (const [face, n] of counts) if (n >= 4) calls.push({ type: 'ankan', tiles: [face, face, face, face], turn: 0 });
  }

  return calls;
}
