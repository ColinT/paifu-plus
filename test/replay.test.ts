import { describe, it, expect } from 'vitest';
import { parseStream } from '../src/stream/parse.js';
import { gameToTenhou } from '../src/core/tenhou.js';
import { buildReplay } from '../src/replay/replay.js';

/** Round-trip: a transcribed game → tenhou JSON → replayed back should end with
 *  the same discard rivers, proving the replay engine reconstructs turn order. */
describe('replay engine', () => {
  it('round-trips a ryuukyoku with a pon back to the same rivers', () => {
    // East discards 5z; South (holds 5z5z) pons it, then discards 1s.
    const s = 'e1 5z123456789p1234z 5z5z123456789s12z 123456789s1234z 123456789p1234z 5z p 1s ryuukyoku';
    const game = parseStream(s).game;
    const replay = buildReplay(gameToTenhou(game));
    const last = replay.kyokus[0].steps.at(-1)!;

    for (let p = 0; p < 4; p++) {
      const expected = game.kyokus[0].players[p].turns.filter((t) => t.discard !== undefined).length;
      expect(last.players[p].river.length).toBe(expected);
    }
    // South claimed East's 5z → South has a meld and East's 5z is marked called.
    expect(last.players[1].melds.some((m) => m.type === 'pon')).toBe(true);
    expect(last.players[0].river[0].called).toBe(true);
  });

  it('produces a step per action and ends with an "end" step', () => {
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z ryuukyoku';
    const replay = buildReplay(gameToTenhou(parseStream(s).game));
    const steps = replay.kyokus[0].steps;
    expect(steps[0].action).toBe('haipai');
    expect(steps[steps.length - 1].action).toBe('end');
    expect(steps.length).toBeGreaterThan(2);
  });

  it('folds the dealer opening tile into the deal — first move is the discard', () => {
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z ryuukyoku';
    const steps = buildReplay(gameToTenhou(parseStream(s).game)).kyokus[0].steps;
    expect(steps[0].action).toBe('haipai');
    // Dealer holds 14 at the deal (13 haipai + the folded opening tile).
    expect(steps[0].players[0].hand.length).toBe(14);
    expect(steps[0].players[0].drawn).not.toBeNull();
    // The dealer's first move is a discard, not a phantom draw of the 14th tile.
    expect(steps[1].action).toBe('discard');
    expect(steps[1].active).toBe(0);
    // No draw step is ever attributed to the dealer's opening turn.
    expect(steps.some((st) => st.action === 'draw' && st.active === 0 && steps.indexOf(st) === 1)).toBe(false);
  });

  it('reconstructs a tsumo win (final draw, no discard)', () => {
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 23499m456678p23s 1z 9p 8p 9s 8s 4s tsumo';
    const replay = buildReplay(gameToTenhou(parseStream(s).game));
    const k = replay.kyokus[0];
    expect(k.steps[k.steps.length - 1].action).toBe('end');
  });
});
