/**
 * Game model → linear transcription DSL (the inverse of {@link ./parse.ts}).
 *
 * Used to populate the editor's stream textarea when a log is loaded via the
 * replay tool, so the user gets an editable text transcription rather than a
 * blank box. It reuses the replay engine to recover play order (draws, calls,
 * kans interleaved across seats), then renders each event as a DSL token.
 *
 * It is a best-effort, human-readable transcription: it round-trips the common
 * cases (draws, discards, riichi, tsumogiri, chi/pon/daiminkan, ankan, tsumo,
 * ryuukyoku). A few DSL limitations remain the parser's, not the emitter's —
 * notably ron winner attribution (the DSL infers it) and added-kan (kakan).
 */

import type { Game, Kyoku, Seat } from '../core/model.js';
import { tilesToNotation, indicatorToDora, isAka, type TenhouTile } from '../core/tiles.js';
import { gameToTenhou } from '../core/tenhou.js';
import { buildReplay } from '../replay/replay.js';
import type { KyokuReplay } from '../replay/replay.js';

const WINDS = ['e', 's', 'w', 'n'];

function roundToken(round: number, honba: number, sticks: number): string {
  const wind = WINDS[Math.floor(round / 4)] ?? 'e';
  let s = `${wind}${(round % 4) + 1}`;
  if (honba || sticks) s += `.${honba}`;
  if (sticks) s += `.${sticks}`;
  return s;
}

const isDefaultName = (n: string): boolean => !n || /^(Player |P)\d$/.test(n);

/** Relative position of the discarder as seen from the caller (parser prefix). */
function relPrefix(caller: Seat, from: Seat): string {
  const d = ((caller - from) + 4) % 4;
  return d === 1 ? 'k' : d === 2 ? 't' : 's'; // kamicha / toimen / shimocha
}

/** Ron result token with the winning seat(s): "eron", "neron" (double ron). */
function ronToken(k: Kyoku): string {
  const winners = k.result.wins?.length ? k.result.wins.map((w) => w.winner) : (k.result.winner !== undefined ? [k.result.winner] : []);
  const letters = winners.map((w) => WINDS[((w - k.round) % 4 + 4) % 4]);
  const uniq = [...new Set(letters)].sort((a, b) => WINDS.indexOf(a) - WINDS.indexOf(b));
  return uniq.join('') + 'ron';
}

/** Serialise dora/ura indicators. Normally emits the compact dora form (d6p);
 *  an aka indicator can't be expressed that way, so those emit the indicator
 *  form (di0p) instead, per indicator, preserving order. */
function doraToken(inds: TenhouTile[], plain: 'd' | 'u', ind: 'di' | 'ui'): string {
  if (inds.every((i) => !isAka(i))) return plain + tilesToNotation(inds.map(indicatorToDora));
  return inds.map((i) => (isAka(i) ? ind + tilesToNotation([i]) : plain + tilesToNotation([indicatorToDora(i)]))).join(' ');
}

export function kyokuToStream(k: Kyoku, rk: KyokuReplay): string {
  const toks: string[] = [];
  toks.push(roundToken(k.round, k.honba, k.riichiSticks));
  if (k.doraIndicators.length) toks.push(doraToken(k.doraIndicators, 'd', 'di'));

  // Haipai in current-seat order (E, S, W, N). The dealer's 14th tile (their
  // first draw) is folded into the haipai, matching the parser's convention.
  for (let s = 0 as Seat; s < 4; s++) {
    const fixed = ((k.round + s) % 4) as Seat;
    const p = k.players[fixed];
    const tiles = [...p.haipai];
    if (s === 0 && p.turns[0]?.draw !== undefined) tiles.push(p.turns[0].draw);
    const note = tilesToNotation(tiles);
    const name = isDefaultName(p.name) ? '' : p.name.replace(/\s+/g, '_');
    // "name:score:tiles" when either differs from default (score 25000); else the
    // compact "name:tiles" or bare tiles.
    if (p.startScore !== 25000) toks.push(`${name}:${p.startScore}:${note}`);
    else toks.push(name ? `${name}:${note}` : note);
  }

  // Play order from the replay engine. The dealer's opening tile is already
  // folded into the deal (haipai step), so every 'draw' step here is a real
  // wall draw to emit.
  for (let i = 1; i < rk.steps.length; i++) {
    const step = rk.steps[i];
    if (step.action === 'end') break;

    if (step.action === 'draw') {
      if (step.tile !== undefined) toks.push(tilesToNotation([step.tile]));
    } else if (step.action === 'discard') {
      const river = step.players[step.active].river;
      const last = river[river.length - 1];
      if (!last) continue;
      if (last.riichi) toks.push('r' + tilesToNotation([last.tile]));
      else if (last.tsumogiri) toks.push('x' + tilesToNotation([last.tile]));
      else toks.push(tilesToNotation([last.tile]));
    } else if (step.action === 'call') {
      const melds = step.players[step.active].melds;
      const meld = melds[melds.length - 1];
      if (!meld) continue;
      const caller = step.active as Seat;
      const from = (meld.from ?? step.active) as Seat;
      if (meld.type === 'chi') toks.push('chi');
      else if (meld.type === 'pon') toks.push(relPrefix(caller, from) + 'pon');
      else if (meld.type === 'daiminkan') toks.push(relPrefix(caller, from) + 'kan');
      else toks.push('kan'); // kakan (best effort)
    } else if (step.action === 'kan') {
      toks.push('kan'); // ankan
    }
  }

  if (k.uraIndicators.length) toks.push(doraToken(k.uraIndicators, 'u', 'ui'));
  if (k.result.kind === 'tsumo') toks.push('tsumo');
  else if (k.result.kind === 'ron') toks.push(ronToken(k));
  else toks.push('ryuukyoku');
  return toks.join(' ');
}

export function gameToStream(game: Game): string {
  const replay = buildReplay(gameToTenhou(game));
  return game.kyokus.map((k, i) => kyokuToStream(k, replay.kyokus[i])).join('\n');
}
