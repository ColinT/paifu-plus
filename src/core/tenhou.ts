/**
 * Emit tenhou.net/6 JSON from the intermediate Game model.
 *
 * Format reference (empirically verified against tenhou's own logs and the
 * tensoul converter):
 *
 *   { title, name, rule, log: [ kyoku, kyoku, ... ] }
 *
 * Each kyoku is:
 *   [ [round, honba, riichiSticks],
 *     [score0..3],
 *     [doraIndicators...],
 *     [uraIndicators...],
 *     [p0 haipai], [p0 draws], [p0 discards],
 *     [p1 ...], [p2 ...], [p3 ...],
 *     [result] ]
 *
 * Draws/discards are parallel per-turn streams. A call that consumes an
 * opponent tile (chi/pon/daiminkan) occupies the DRAW slot as a meld string;
 * an ankan occupies a DISCARD slot. Tsumogiri = 60, riichi discards are
 * "r"-prefixed.
 */

import type { TenhouTile } from './tiles.js';
import type { Game, Kyoku, PlayerHand, Call, Seat } from './model.js';

export interface TenhouLog {
  title: string[];
  name: string[];
  rule: { disp?: string; aka?: number };
  log: unknown[][];
}

const TSUMOGIRI = 60;

/** Relative index of the discarder as seen from the caller: 0=kamicha,1=toimen,2=shimocha. */
function relativeSeat(caller: Seat, from: Seat): number {
  return ((caller - from + 4) % 4) - 1;
}

/**
 * Build the meld string for a call, following the tenhou/6 convention where the
 * letter's position among the tiles encodes which player the tile came from.
 */
export function meldString(call: Call, callerSeat: Seat): string {
  const t = (x: TenhouTile) => String(x);
  // Remove ONE copy of the called tile (a pon/kan is identical tiles, so
  // filtering by value would wrongly drop them all).
  const removeOne = (arr: TenhouTile[], val: TenhouTile): TenhouTile[] => {
    const c = [...arr]; const i = c.indexOf(val); if (i >= 0) c.splice(i, 1); return c;
  };
  switch (call.type) {
    case 'chi': {
      // Chi is always from kamicha; called tile listed first after 'c'.
      const called = call.calledTile!;
      const others = removeOne(call.tiles, called);
      return 'c' + t(called) + others.map(t).join('');
    }
    case 'pon': {
      const called = call.calledTile!;
      const parts = removeOne(call.tiles, called).map(t);
      const idx = Math.max(0, relativeSeat(callerSeat, call.fromSeat!));
      parts.splice(idx, 0, 'p' + t(called));
      return parts.join('');
    }
    case 'daiminkan': {
      const called = call.calledTile!;
      const parts = removeOne(call.tiles, called).map(t);
      const idx = relativeSeat(callerSeat, call.fromSeat!);
      parts.splice(idx === 2 ? 3 : Math.max(0, idx), 0, 'm' + t(called));
      return parts.join('');
    }
    case 'kakan': {
      // Added kan: a 'k'+addedTile inserted into the existing pon shape.
      const added = call.calledTile!;
      const parts = removeOne(call.tiles, added).map(t);
      const idx = Math.max(0, relativeSeat(callerSeat, call.fromSeat!));
      parts.splice(idx, 0, 'k' + t(added));
      return parts.join('');
    }
    case 'ankan': {
      // Closed kan lives in the discard stream: four tiles then 'a' + last.
      const tiles = call.tiles.map(t);
      const last = tiles.pop()!;
      return tiles.join('') + 'a' + last;
    }
  }
}

function buildStreams(p: PlayerHand): { draws: (number | string)[]; discards: (number | string)[] } {
  const draws: (number | string)[] = [];
  const discards: (number | string)[] = [];

  const callByTurn = new Map<number, Call>();
  for (const c of p.calls) callByTurn.set(c.turn, c);

  p.turns.forEach((turn, i) => {
    const call = callByTurn.get(i);

    // Draw slot: a wall draw, or a call meld string (chi/pon/daiminkan) that
    // replaces the wall draw for this turn.
    if (call && (call.type === 'chi' || call.type === 'pon' || call.type === 'daiminkan' || call.type === 'kakan')) {
      draws.push(meldString(call, p.seat));
    } else if (turn.draw !== undefined) {
      draws.push(turn.draw);
    }

    // Discard slot.
    if (call && call.type === 'ankan') {
      discards.push(meldString(call, p.seat));
    } else if (turn.discard !== undefined) {
      let d: number | string = turn.tsumogiri ? TSUMOGIRI : turn.discard;
      if (turn.riichi) d = 'r' + d;
      discards.push(d);
    }
  });

  return { draws, discards };
}

function resultArray(k: Kyoku): unknown[] {
  const r = k.result;
  if (r.kind === 'ryuukyoku') {
    return ['流局', r.deltas];
  }
  // 和了 (agari): [winner, from, winner, scoreString, ...yaku(飜)]
  const winner = r.winner!;
  const from = r.kind === 'tsumo' ? winner : r.loser!;
  const gained = r.deltas[winner];
  // The scoring engine's string already carries the correct hand value; fall
  // back to the raw delta only when scoring wasn't computed.
  const scoreStr = r.scoreText ?? `${gained >= 0 ? '+' : ''}${gained}点`;
  const yakuStrs = (r.yaku ?? []).map((y) => `${y.name}(${y.han}飜)`);
  return ['和了', r.deltas, [winner, from, winner, scoreStr, ...yakuStrs]];
}

export function kyokuToLog(k: Kyoku): unknown[] {
  const entry: unknown[] = [
    [k.round, k.honba, k.riichiSticks],
    k.players.map((p) => p.startScore),
    k.doraIndicators,
    k.uraIndicators,
  ];
  for (const p of k.players) {
    const { draws, discards } = buildStreams(p);
    entry.push(p.haipai, draws, discards);
  }
  entry.push(resultArray(k));
  return entry;
}

export function gameToTenhou(game: Game): TenhouLog {
  return {
    title: game.meta.title,
    name: game.meta.names,
    rule: game.meta.rule,
    log: game.kyokus.map(kyokuToLog),
  };
}
