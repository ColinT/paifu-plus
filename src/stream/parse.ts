/**
 * Linear game-transcription DSL → Game model.
 *
 * A whole game is typed as one stream of whitespace/comma separated tokens, in
 * order of play. Per hand:
 *
 *   <round> [dora] <E-haipai> <S-haipai> <W-haipai> <N-haipai>
 *   <discard> ( <draw> <discard> )*  ... <result>
 *
 * Tokens (case-insensitive, separators flexible):
 *   round     e1 | e1.0 | e1-0-1  (wind+num[.honba[.sticks]])
 *   dora      d5m           (initial, before haipai; or kandora after a kan)
 *   ura       u5m           (ura-dora indicator, near a riichi win)
 *   haipai    123m456p..    optionally name-prefixed  "Alice:123m..."
 *   draw      5m | ?        (? = unseen/missed, flagged)
 *   discard   3p | x | x3p | r3p | riichi 3p | ?   (x=tsumogiri, r=riichi)
 *   call      p|c|pon|chi|kan|k|mk. Optional caller prefix:
 *               relative to the discarder — shimocha spon/shimopon,
 *               toimen tpon/toimenpon, kamicha kpon/kamipon;
 *               or absolute seat — wp/westpon, eastpon, southpon, npon.
 *             An explicitly-attributed pon/kan backfills the caller's hand
 *             (and haipai) with the needed tiles if they weren't entered.
 *   result    tsumo | ron[seat] | ryuukyoku
 *
 * The parser tracks all four hands so calls attribute to the holder and
 * ankan/kakan are inferred. It never throws: problems become diagnostics and
 * parsing continues, so a partial/observed record still renders.
 */

import type { Game, Kyoku, PlayerHand, Turn, Call, Seat, KyokuResult } from '../core/model.js';
import { parseTileNotation, normalizeRed } from '../core/tiles.js';
import type { TenhouTile } from '../core/tiles.js';
import { scoreWin, agariDeltas, ryuukyokuDeltas, isTenpai, counts } from '../score/index.js';

export interface Diagnostic {
  start: number; end: number;
  severity: 'error' | 'warn' | 'info';
  message: string;
}

export interface StreamParseResult {
  game: Game;
  diagnostics: Diagnostic[];
  /** Number of `?` placeholders awaiting correction. */
  missing: number;
}

interface Tok { text: string; start: number; end: number; }

function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  const re = /[^\s,]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) toks.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return toks;
}

const WIND_LETTER: Record<string, number> = { e: 0, s: 4, w: 8, n: 12 };

function fixedIndex(seat: Seat, round: number): Seat { return ((round + seat) % 4) as Seat; }

/** Relative position of the DISCARDER as seen from the calling player. */
type RelPos = 'shimo' | 'toimen' | 'kami';
interface ParsedCall { kind: 'pon' | 'chi' | 'kan'; rel?: RelPos; abs?: Seat; }

/** Caller seat given the discarder and where the discarder sits relative to the caller. */
function callerFromRel(discarder: Seat, rel: RelPos): Seat {
  // shimo: discarder is the caller's shimocha ⇒ caller is the discarder's kamicha
  if (rel === 'shimo') return ((discarder + 3) % 4) as Seat;
  if (rel === 'toimen') return ((discarder + 2) % 4) as Seat;
  return ((discarder + 1) % 4) as Seat; // kami: caller is the discarder's shimocha
}

function interpPrefix(p: string): { rel?: RelPos; abs?: Seat } {
  switch (p) {
    case 'toimen': case 't': return { rel: 'toimen' };
    case 'kamicha': case 'kami': case 'k': return { rel: 'kami' };
    case 'shimocha': case 'shimo': case 's': return { rel: 'shimo' };
    case 'east': case 'e': return { abs: 0 };
    case 'south': return { abs: 1 };
    case 'west': case 'w': return { abs: 2 };
    case 'north': case 'n': return { abs: 3 };
    default: return {};
  }
}

const PREFIX = '(toimen|kamicha|kami|shimocha|shimo|east|south|west|north|[tksewn])';
/** Classify a call token: pon/chi/kan with an optional relative or absolute prefix. */
function parseCall(raw: string): ParsedCall | null {
  const t = raw.toLowerCase();
  if (/^(pon|p)$/.test(t)) return { kind: 'pon' };
  if (/^(chi|c)$/.test(t)) return { kind: 'chi' };
  if (/^(kan|mk|minkan|daiminkan|kakan|ankan|k)$/.test(t)) return { kind: 'kan' };
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^${PREFIX}(pon|p)$`).exec(t))) return { kind: 'pon', ...interpPrefix(m[1]) };
  if ((m = new RegExp(`^${PREFIX}(kan|mk|k)$`).exec(t))) return { kind: 'kan', ...interpPrefix(m[1]) };
  if ((m = new RegExp(`^${PREFIX}(chi|c)$`).exec(t))) return { kind: 'chi', ...interpPrefix(m[1]) };
  return null;
}

/** Mutable per-seat state during parsing (current-hand seats: 0=E..3=N). */
interface PS {
  name: string;
  hand: TenhouTile[];
  haipai: TenhouTile[];
  turns: Turn[];
  calls: Call[];
  riichi: boolean;
}

export function parseStream(input: string): StreamParseResult {
  const toks = tokenize(input);
  const diags: Diagnostic[] = [];
  const kyokus: Kyoku[] = [];
  let missing = 0;

  const warn = (t: Tok, message: string, severity: Diagnostic['severity'] = 'warn') => diags.push({ start: t.start, end: t.end, severity, message });

  // Current kyoku working state. (phase/expect read through helpers so TS does
  // not narrow them to a single literal across the closures that mutate them.)
  type Phase = 'need-round' | 'haipai' | 'play' | 'done';
  type Expect = 'draw' | 'discard';
  let round = 0, honba = 0, sticks = 0, startSticks = 0;
  let dora: TenhouTile[] = [], ura: TenhouTile[] = [];
  let players: PS[] | null = null;
  let phase: Phase = 'need-round';
  let haipaiSeat = 0;
  let turn: Seat = 0;
  let expect: Expect = 'discard';
  const isPhase = (p: Phase) => (phase as Phase) === p;
  const isExpect = (e: Expect) => (expect as Expect) === e;
  let lastDiscard: { seat: Seat; tile: TenhouTile } | null = null;
  let lastDiscardTurn: Turn | null = null;

  const freshPlayers = (): PS[] => Array.from({ length: 4 }, () => ({ name: '', hand: [], haipai: [], turns: [], calls: [], riichi: false }));

  function closeKyoku(result?: KyokuResult) {
    if (!players) return;
    const ordered = new Array<PlayerHand>(4);
    for (let s = 0 as Seat; s < 4; s++) {
      const p = players[s];
      const fi = fixedIndex(s, round);
      ordered[fi] = {
        seat: fi, name: p.name || `Player ${fi + 1}`,
        startScore: 25000, scoreDelta: 0,
        haipai: p.haipai.slice(), turns: p.turns, calls: p.calls,
      };
    }
    const res: KyokuResult = result ?? { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] };
    kyokus.push({ round, honba, riichiSticks: startSticks, doraIndicators: dora.slice(), uraIndicators: ura.slice(), players: ordered as [PlayerHand, PlayerHand, PlayerHand, PlayerHand], result: res });
    players = null; phase = 'need-round';
  }

  const removeFromHand = (p: PS, tile: TenhouTile): boolean => {
    let i = p.hand.indexOf(tile);
    if (i < 0) i = p.hand.findIndex((h) => normalizeRed(h) === normalizeRed(tile)); // fall back ignoring aka
    if (i < 0) return false;
    p.hand.splice(i, 1); return true;
  };
  const countMatch = (p: PS, tile: TenhouTile): number => p.hand.filter((h) => normalizeRed(h) === normalizeRed(tile)).length;
  const next = (s: Seat): Seat => ((s + 1) % 4) as Seat;

  // ---- token classifiers ----
  const asRound = (t: string) => /^[eswn][1-4]([._\-][0-9]+){0,2}$/i.exec(t.replace(/\s+/g, ''));
  const asDora = (t: string) => /^(kandora|dora|d)([0-9].*[mpsz])$/i.exec(t);
  const asUra = (t: string) => /^(ura|u)([0-9].*[mpsz])$/i.exec(t);
  const asRiichi = (t: string) => /^(riichi|r)([0-9].*[mpsz])$/i.exec(t);
  const asTsumogiri = (t: string) => /^(tsumogiri|x)([0-9].*[mpsz])?$/i.exec(t);
  const asResult = (t: string) => /^(tsumo|ron|ryuukyoku|ryukyoku|draw|exhaustive)$/i.exec(t);

  function startKyoku(rt: RegExpExecArray) {
    if (players) closeKyoku();
    const s = rt[0].replace(/\s+/g, '');
    const wind = s[0].toLowerCase();
    const rest = s.slice(1).split(/[._\-]/);
    round = WIND_LETTER[wind] + (parseInt(rest[0], 10) - 1);
    honba = rest[1] ? parseInt(rest[1], 10) : 0;
    sticks = rest[2] ? parseInt(rest[2], 10) : 0;
    startSticks = sticks;
    dora = []; ura = []; players = freshPlayers();
    phase = 'haipai'; haipaiSeat = 0; turn = 0; expect = 'discard'; lastDiscard = null;
  }

  function doDraw(p: PS, tok: Tok, tile: TenhouTile | null) {
    // begin a new turn with a wall draw (tile may be null = unknown '?')
    if (tile !== null) p.hand.push(tile);
    p.turns.push({ draw: tile ?? undefined });
    expect = 'discard';
    void tok;
  }

  function doDiscard(p: PS, _tok: Tok, opts: { tile: TenhouTile | null; tsumogiri: boolean; riichi: boolean }) {
    let turnObj = p.turns[p.turns.length - 1];
    // Dealer's very first action is a discard with the first draw folded into
    // the 14-tile haipai: create the turn now, moving the extra tile to draw.
    if (!turnObj || turnObj.discard !== undefined) { turnObj = {}; p.turns.push(turnObj); }
    let tile = opts.tile;
    if (opts.tsumogiri) {
      // discard equals the drawn tile; backfill an unknown draw if needed
      if (tile === null) tile = turnObj.draw ?? null;
      if (turnObj.draw === undefined && tile !== null) turnObj.draw = tile;
      turnObj.tsumogiri = true;
    }
    turnObj.discard = tile ?? undefined;
    if (opts.riichi) { turnObj.riichi = true; p.riichi = true; sticks += 1; }
    if (tile !== null) removeFromHand(p, tile);
    lastDiscard = tile !== null ? { seat: playerSeat(p), tile } : null;
    lastDiscardTurn = turnObj;
    expect = 'draw';
    turn = next(turn);
  }

  const playerSeat = (p: PS): Seat => (players!.indexOf(p) as Seat);

  /** Backfill missing copies of a tile into a player's hand + haipai (used when a
   *  call is explicitly attributed but the hand wasn't fully entered). */
  function ensureTiles(p: PS, tile: TenhouTile, need: number, tok: Tok) {
    const deficit = need - countMatch(p, tile);
    if (deficit > 0) { for (let i = 0; i < deficit; i++) { p.hand.push(tile); p.haipai.push(tile); } warn(tok, `backfilled ${deficit}×${tile} into ${['E', 'S', 'W', 'N'][playerSeat(p)]}'s hand`, 'info'); }
  }

  function handleCall(tok: Tok, call: ParsedCall) {
    if (!players || !lastDiscard) { warn(tok, 'call with no preceding discard'); return; }
    const isChi = call.kind === 'chi';
    const isKan = call.kind === 'kan';
    const tile = lastDiscard.tile;
    const fromSeat = lastDiscard.seat;

    // Determine caller: explicit (relative/absolute prefix) or inferred from hands.
    let caller: Seat | null = null;
    let explicit = false;
    if (call.rel) { caller = callerFromRel(fromSeat, call.rel); explicit = true; }
    else if (call.abs !== undefined) { caller = call.abs; explicit = true; }
    else if (isChi) { caller = next(fromSeat); }
    else {
      const need = isKan ? 3 : 2;
      const candidates = ([0, 1, 2, 3] as Seat[]).filter((s) => s !== fromSeat && countMatch(players![s], tile) >= need);
      if (candidates.length === 1) caller = candidates[0];
      else if (candidates.length === 0) { warn(tok, `no player can ${call.kind} ${tile}`); return; }
      else { warn(tok, `ambiguous ${call.kind}; prefix a seat (e.g. spon)`); caller = candidates[0]; }
    }
    if (caller === fromSeat) { warn(tok, 'a player cannot call their own discard'); return; }
    const cp = players[caller];
    if (lastDiscardTurn) lastDiscardTurn.called = true; // the claimed discard leaves the river
    if (explicit && !isChi) ensureTiles(cp, tile, isKan ? 3 : 2, tok);

    if (isKan) {
      // daiminkan: consume 3 from hand + the called tile
      for (let i = 0; i < 3; i++) removeFromHand(cp, tile);
      const t = p_turn(cp);
      cp.calls.push({ type: 'daiminkan', tiles: [tile, tile, tile, tile], calledTile: tile, fromSeat, turn: t });
      // rinshan draw + discard follow
      turn = caller; expect = 'draw';
    } else {
      const consume = isChi ? chiConsume(cp, tile, tok) : [tile, tile];
      for (const c of consume) removeFromHand(cp, c);
      const t = p_turn(cp);
      cp.calls.push({ type: isChi ? 'chi' : 'pon', tiles: isChi ? [tile, ...consume] : [tile, tile, tile], calledTile: tile, fromSeat, turn: t });
      turn = caller; expect = 'discard';
    }
    lastDiscard = null;
  }

  /** Index of the (about-to-be) turn where a call sits in the caller's stream. */
  const p_turn = (cp: PS): number => { cp.turns.push({}); return cp.turns.length - 1; };

  function chiConsume(cp: PS, tile: TenhouTile, tok: Tok): TenhouTile[] {
    // pick two hand tiles forming a run with `tile` (same suit, sequence)
    const n = normalizeRed(tile);
    if (n >= 41) { warn(tok, 'cannot chi an honour'); return []; }
    const suitBase = Math.floor(n / 10) * 10, r = n % 10;
    const opts = [ [r - 2, r - 1], [r - 1, r + 1], [r + 1, r + 2] ];
    for (const [a, b] of opts) {
      if (a < 1 || b > 9) continue;
      const ta = suitBase + a, tb = suitBase + b;
      if (cp.hand.some((h) => normalizeRed(h) === ta) && cp.hand.some((h) => normalizeRed(h) === tb)) return [ta, tb];
    }
    warn(tok, `chi tiles for ${tile} not in hand`);
    return [];
  }

  // We track who is mid-turn (drew but not yet discarded).
  let midTurnSeat: Seat | null = null;

  for (const tok of toks) {
    const t = tok.text;

    const rt = asRound(t);
    if (rt) { startKyoku(rt); continue; }

    if (isPhase('need-round')) { warn(tok, 'expected a round token (e.g. e1) to start a hand'); continue; }

    const dm = asDora(t);
    if (dm) { dora.push(...parseTileNotation(dm[2])); continue; }
    const um = asUra(t);
    if (um) { ura.push(...parseTileNotation(um[2])); continue; }

    if (isPhase('haipai')) {
      const advance = () => { haipaiSeat++; if (haipaiSeat === 4) { phase = 'play'; turn = 0; expect = 'discard'; midTurnSeat = 0; } };
      // '?' skips this seat's haipai (unknown — reconstructed later from calls).
      if (t === '?') { missing++; warn(tok, `${['E', 'S', 'W', 'N'][haipaiSeat]} haipai skipped`, 'info'); advance(); continue; }
      // name-prefixed haipai?  name:tiles
      const colon = t.indexOf(':');
      const name = colon >= 0 ? t.slice(0, colon) : '';
      const body = colon >= 0 ? t.slice(colon + 1) : t;
      const tiles = parseTileNotation(body);
      if (!tiles.length) { warn(tok, 'expected haipai tiles'); continue; }
      const p = players![haipaiSeat];
      p.name = name; p.hand = tiles.slice();
      const expected = haipaiSeat === 0 ? 14 : 13;
      if (tiles.length !== expected) warn(tok, `${['E', 'S', 'W', 'N'][haipaiSeat]} haipai has ${tiles.length} tiles (expected ${expected})`);
      // Dealer: fold the 14th tile in as the first draw.
      if (haipaiSeat === 0 && tiles.length >= 14) { const first = p.hand.pop()!; p.haipai = p.hand.slice(); p.turns.push({ draw: first }); }
      else p.haipai = p.hand.slice();
      advance();
      continue;
    }

    // phase === 'play'
    const res = asResult(t);
    if (res) { handleResult(tok, res); continue; }

    const call = parseCall(t);
    if (call) {
      // A bare kan on your own turn (after drawing) is an ankan/kakan.
      if (call.kind === 'kan' && isExpect('discard') && !call.rel && call.abs === undefined) { handleOwnTurnKan(tok, 'kan'); continue; }
      handleCall(tok, call); midTurnSeat = turn; continue;
    }

    // unknown / missed
    if (t === '?') {
      missing++;
      warn(tok, 'missed move — flagged for correction', 'info');
      if (isExpect('draw')) { doDraw(players![turn], tok, null); midTurnSeat = turn; }
      else { doDiscard(players![midTurnSeat ?? turn], tok, { tile: null, tsumogiri: false, riichi: false }); }
      continue;
    }

    // riichi discard
    const rr = asRiichi(t);
    if (rr && isExpect('discard')) { const tile = parseTileNotation(rr[2])[0]; doDiscard(players![midTurnSeat ?? turn], tok, { tile: tile ?? null, tsumogiri: false, riichi: true }); continue; }

    // tsumogiri discard
    const xm = asTsumogiri(t);
    if (xm && isExpect('discard')) { const tile = xm[2] ? parseTileNotation(xm[2])[0] : null; doDiscard(players![midTurnSeat ?? turn], tok, { tile: tile ?? null, tsumogiri: true, riichi: false }); continue; }

    // a bare tile
    const tiles = parseTileNotation(t);
    if (!tiles.length) { warn(tok, `unrecognized token "${t}"`); continue; }
    const tile = tiles[0];
    if (isExpect('draw')) { doDraw(players![turn], tok, tile); midTurnSeat = turn; }
    else { doDiscard(players![midTurnSeat ?? turn], tok, { tile, tsumogiri: false, riichi: false }); }
  }

  function handleOwnTurnKan(tok: Tok, _kw: string) {
    if (!players || midTurnSeat === null) { warn(tok, 'kan with no active turn'); return; }
    const p = players[midTurnSeat];
    const drawn = p.turns[p.turns.length - 1]?.draw;
    // Determine the kan tile: the just-drawn tile if it makes a set, else warn.
    const tile = drawn;
    if (tile === undefined) { warn(tok, 'own-turn kan needs a known drawn tile'); return; }
    const inHand = countMatch(p, tile);
    const hasPon = p.calls.find((c) => c.type === 'pon' && normalizeRed(c.calledTile!) === normalizeRed(tile));
    if (hasPon) {
      hasPon.type = 'kakan'; hasPon.tiles = [tile, tile, tile, tile]; removeFromHand(p, tile);
    } else if (inHand >= 4) {
      for (let i = 0; i < 4; i++) removeFromHand(p, tile);
      p.calls.push({ type: 'ankan', tiles: [tile, tile, tile, tile], turn: p.turns.length - 1 });
    } else { warn(tok, `cannot kan ${tile} (need 4 concealed or an existing pon)`); return; }
    // rinshan draw + discard follow for the same player
    expect = 'draw';
  }

  /** Map current-seat (0=E..3=N) deltas to fixed player-index order. */
  function toFixedDeltas(cs: number[]): [number, number, number, number] {
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let s = 0 as Seat; s < 4; s++) out[fixedIndex(s, round)] = cs[s];
    return out;
  }

  function scoreAgari(tok: Tok, w: Seat, isTsumo: boolean, winningTile: TenhouTile, fromSeat: Seat): Partial<KyokuResult> {
    const p = players![w];
    const concealed = p.hand.slice();
    if (isTsumo) { const i = concealed.indexOf(winningTile); if (i >= 0) concealed.splice(i, 1); }
    const sr = scoreWin({
      concealed, melds: p.calls.map((c) => ({ type: c.type, tiles: c.tiles })), winningTile, isTsumo,
      seatWind: 27 + w, roundWind: 27 + Math.floor(round / 4),
      doraIndicators: dora, uraIndicators: ura, riichi: p.riichi, rules: {},
    });
    if (!sr.valid) { warn(tok, 'no yaku — deltas not computed (fill in manually)'); return { deltas: [0, 0, 0, 0] }; }
    const { deltas } = agariDeltas({ winner: w, from: isTsumo ? w : fromSeat, dealerSeat: 0, isTsumo, base: sr.base, honba, sticks });
    return { deltas: toFixedDeltas(deltas), han: sr.han, fu: sr.fu, yaku: sr.yaku, scoreText: sr.text };
  }

  function handleResult(tok: Tok, rm: RegExpExecArray) {
    if (!players) return;
    const kind = rm[1].toLowerCase();
    let result: KyokuResult;
    if (kind === 'tsumo') {
      const w = (midTurnSeat ?? turn) as Seat;
      const winTile = players[w].turns[players[w].turns.length - 1]?.draw;
      const scored = winTile !== undefined ? scoreAgari(tok, w, true, winTile, w) : { deltas: [0, 0, 0, 0] as [number, number, number, number] };
      result = { kind: 'tsumo', winner: fixedIndex(w, round), winningTile: winTile, deltas: [0, 0, 0, 0], ...scored };
    } else if (kind === 'ron') {
      const w = (midTurnSeat !== null && isExpect('draw') ? turn : (midTurnSeat ?? turn)) as Seat;
      const winTile = lastDiscard?.tile;
      const from = lastDiscard?.seat ?? 0 as Seat;
      const scored = winTile !== undefined ? scoreAgari(tok, w, false, winTile, from) : { deltas: [0, 0, 0, 0] as [number, number, number, number] };
      result = { kind: 'ron', winner: fixedIndex(w, round), loser: lastDiscard ? fixedIndex(lastDiscard.seat, round) : undefined, winningTile: winTile, deltas: [0, 0, 0, 0], ...scored };
    } else {
      // ryuukyoku: tenpai payments from each hand's shape.
      const tenpaiCS = ([0, 1, 2, 3] as Seat[]).map((s) => isTenpai(counts(players![s].hand), players![s].calls.length));
      const deltas = toFixedDeltas(ryuukyokuDeltas(tenpaiCS));
      const tenpai = ([0, 1, 2, 3] as Seat[]).filter((s) => tenpaiCS[s]).map((s) => fixedIndex(s, round));
      result = { kind: 'ryuukyoku', deltas, tenpai };
    }
    closeKyoku(result);
  }

  // finalize a trailing open hand
  if (players) closeKyoku();

  const names = (kyokus[0]?.players.map((p) => p.name) ?? ['P1', 'P2', 'P3', 'P4']) as [string, string, string, string];
  const game: Game = { meta: { title: ['Transcribed', ''], names, rule: { disp: '', aka: 0 } }, kyokus };
  return { game, diagnostics: diags, missing };
}
