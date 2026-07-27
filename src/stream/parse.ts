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
 *   dora      d5m           the DORA tile (not the indicator); stored as the
 *                           indicator internally. Initial, before haipai; or
 *                           kandora after a kan.
 *   ura       u5m           the ura-DORA tile (near a riichi win)
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

import type { Game, Kyoku, PlayerHand, Turn, Call, Seat, KyokuResult, Agari } from '../core/model.js';
import { parseTileNotation, normalizeRed, tilesToNotation, doraToIndicator } from '../core/tiles.js';
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
  /** For a still-open final hand: whose turn it is (current seat 0=E..3=N) and
   *  whether they're about to draw or discard. Absent once the hand ends. */
  pending?: { seat: number; expect: 'draw' | 'discard' };
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
/** Current-hand seat for a ron winner letter (e=East .. n=North). */
const SEAT_LETTER: Record<string, Seat> = { e: 0, s: 1, w: 2, n: 3 };

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
  startScore: number;
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
  let pendingName = '';
  let pendingScore: number | null = null;
  let turn: Seat = 0;
  let expect: Expect = 'discard';
  const isPhase = (p: Phase) => (phase as Phase) === p;
  const isExpect = (e: Expect) => (expect as Expect) === e;
  let lastDiscard: { seat: Seat; tile: TenhouTile } | null = null;
  let lastDiscardTurn: Turn | null = null;

  const freshPlayers = (): PS[] => Array.from({ length: 4 }, () => ({ name: '', hand: [], haipai: [], turns: [], calls: [], riichi: false, startScore: 25000 }));

  function closeKyoku(result?: KyokuResult) {
    if (!players) return;
    const ordered = new Array<PlayerHand>(4);
    for (let s = 0 as Seat; s < 4; s++) {
      const p = players[s];
      const fi = fixedIndex(s, round);
      // Calls carry the discarder as a CURRENT-hand seat during parsing; the model
      // (and every consumer: meld rendering, tenhou export) expects a FIXED seat.
      // Remap now, or a called meld is drawn from the wrong side in any non-E1 hand.
      for (const c of p.calls) if (c.fromSeat !== undefined) c.fromSeat = fixedIndex(c.fromSeat, round);
      ordered[fi] = {
        seat: fi, name: p.name || `Player ${fi + 1}`,
        startScore: p.startScore, scoreDelta: 0,
        haipai: p.haipai.slice(), turns: p.turns, calls: p.calls,
      };
    }
    const res: KyokuResult = result ?? { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] };
    // Each riichi declared this kyoku puts a 1000 stick on the table: debit the
    // declarer. agariDeltas already credits the winner with every stick collected
    // (this kyoku's + carried), and at a draw the sticks just carry on — but the
    // declarer's −1000 was never applied, so deltas didn't balance. Fix that here.
    for (let s = 0 as Seat; s < 4; s++) {
      if (!players[s].riichi) continue;
      const fi = fixedIndex(s, round);
      res.deltas[fi] -= 1000;
      if (res.wins?.length) res.wins[0].deltas[fi] -= 1000; // keep per-win deltas summing to the combined total
    }
    for (let i = 0; i < 4; i++) ordered[i].scoreDelta = res.deltas[i] ?? 0; // reflect result in each player's score
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
  // Indicator-form dora/ura: the tile shown in the dead wall, not the dora it
  // points to. Lets a red-five indicator be transcribed (dia5p / di0p), which
  // "d" cannot express since it converts dora → indicator and drops the aka.
  const asDoraInd = (t: string) => /^(dorai|di)([0-9a].*[mpsz])$/i.exec(t);
  const asUraInd = (t: string) => /^(urai|ui)([0-9a].*[mpsz])$/i.exec(t);
  const asRiichi = (t: string) => /^(riichi|r)([0-9].*[mpsz])$/i.exec(t);
  const asTsumogiri = (t: string) => /^(tsumogiri|x)([0-9].*[mpsz])?$/i.exec(t);
  // Result token: tsumo, a draw, or a ron optionally prefixed with the winning
  // seat(s) — "eron", "neron" (double), "newron"/"tripleron" (triple).
  const asResult = (t: string) => /^(tsumo|ryuukyoku|ryukyoku|draw|exhaustive|tripleron|[eswn]{0,3}ron)$/i.exec(t);
  const asOwnKan = (t: string) => /^(kakan|ankan)([0-9].*[mpsz])?$/i.exec(t);

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
    phase = 'haipai'; haipaiSeat = 0; pendingName = ''; pendingScore = null; turn = 0; expect = 'discard'; lastDiscard = null;
  }

  function doDraw(p: PS, tok: Tok, tile: TenhouTile | null) {
    // begin a new turn with a wall draw (tile may be null = unknown '?')
    if (tile !== null) p.hand.push(tile);
    p.turns.push({ draw: tile ?? undefined });
    expect = 'discard';
    void tok;
  }

  function doDiscard(p: PS, tok: Tok, opts: { tile: TenhouTile | null; tsumogiri: boolean; riichi: boolean }) {
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
    // Discarding a tile not in the (partly recorded) hand: assume it came from
    // the unrecorded haipai and backfill it, keeping the reconstruction sound.
    if (tile !== null && !removeFromHand(p, tile)) backfillOrigin(p, tile, tok);
    lastDiscard = tile !== null ? { seat: playerSeat(p), tile } : null;
    lastDiscardTurn = turnObj;
    expect = 'draw';
    turn = next(turn);
  }

  const playerSeat = (p: PS): Seat => (players!.indexOf(p) as Seat);

  /** Backfill missing copies of a tile into a player's hand + haipai (used when a
   *  call is explicitly attributed but the hand wasn't fully entered). Silent —
   *  a partly-entered haipai is the normal live-recording state. */
  function ensureTiles(p: PS, tile: TenhouTile, need: number, _tok: Tok) {
    const deficit = need - countMatch(p, tile);
    for (let i = 0; i < deficit; i++) { p.hand.push(tile); p.haipai.push(tile); }
  }

  /** A tile discarded but not in the (partly recorded) hand must have come from
   *  the unrecorded haipai — record it there so the reconstruction stays
   *  consistent. Warn only if that would push the hand past a legal size. */
  function backfillOrigin(p: PS, tile: TenhouTile, tok: Tok) {
    const expected = playerSeat(p) === 0 ? 14 : 13;
    const copies = p.haipai.filter((h) => normalizeRed(h) === normalizeRed(tile)).length;
    if (p.haipai.length >= expected || copies >= 4) {
      warn(tok, `${['E', 'S', 'W', 'N'][playerSeat(p)]} discards ${tilesToNotation([tile])} but doesn't hold it (draw/discard out of step?)`);
      return;
    }
    p.haipai.push(tile);
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

    // `di`/`ui` take the INDICATOR tile directly (what sits in the dead wall);
    // stored as-is so a red-five indicator survives. Checked before d/u.
    const dim = asDoraInd(t);
    if (dim) { dora.push(...parseTileNotation(dim[2])); continue; }
    const uim = asUraInd(t);
    if (uim) { ura.push(...parseTileNotation(uim[2])); continue; }

    // `d`/`u` take the DORA tile (what the player sees as the bonus); tenhou
    // stores the indicator, so convert dora → indicator here.
    const dm = asDora(t);
    if (dm) { dora.push(...parseTileNotation(dm[2]).map(doraToIndicator)); continue; }
    const um = asUra(t);
    if (um) { ura.push(...parseTileNotation(um[2]).map(doraToIndicator)); continue; }

    if (isPhase('haipai')) {
      const advance = () => { pendingName = ''; pendingScore = null; haipaiSeat++; if (haipaiSeat === 4) { phase = 'play'; turn = 0; expect = 'discard'; midTurnSeat = 0; } };
      // '?' skips this seat's haipai (unknown — reconstructed later from calls).
      // A name/score typed just before it (e.g. "Okada 24000 ?") still applies.
      if (t === '?') {
        missing++;
        if (pendingName) players![haipaiSeat].name = pendingName;
        if (pendingScore !== null) players![haipaiSeat].startScore = pendingScore;
        warn(tok, `${['E', 'S', 'W', 'N'][haipaiSeat]} haipai skipped`, 'info'); advance(); continue;
      }
      // A seat may be "name:score:tiles" / "name:tiles" (colon) or those parts as
      // separate tokens before the haipai (e.g. "Okada 24000 996p…"). Score is a
      // bare integer; omit it to default to 25000.
      const parts = t.split(':');
      let name = '', scoreStr = '', body = t;
      if (parts.length === 3) { [name, scoreStr, body] = parts; }
      else if (parts.length === 2) { [name, body] = parts; }
      const tiles = parseTileNotation(body);
      if (!tiles.length) {
        // A standalone score (bare integer) vs a name token before the haipai.
        if (parts.length === 1 && /^\d+$/.test(t)) pendingScore = parseInt(t, 10);
        else pendingName = t;
        continue;
      }
      // A bare single tile can't be a haipai (those are 13–14 tiles): the haipai
      // section is over. Leave the remaining seats unknown and reprocess this
      // token as the first play — so live-recorded discards aren't eaten as haipai.
      if (tiles.length === 1 && parts.length === 1 && !pendingName && pendingScore === null) { phase = 'play'; turn = 0; expect = 'discard'; midTurnSeat = 0; }
      else {
      const p = players![haipaiSeat];
      p.name = name || pendingName;
      if (scoreStr && /^\d+$/.test(scoreStr)) p.startScore = parseInt(scoreStr, 10);
      else if (pendingScore !== null) p.startScore = pendingScore;
      p.hand = tiles.slice();
      const expected = haipaiSeat === 0 ? 14 : 13;
      // Only flag too MANY tiles; a short haipai is expected while recording and
      // gets reconciled from the discards/calls.
      if (tiles.length > expected) warn(tok, `${['E', 'S', 'W', 'N'][haipaiSeat]} haipai has ${tiles.length} tiles (expected ${expected})`);
      // Dealer holds 14 tiles: haipai is the first 13, the 14th is the first
      // draw. Keep ALL 14 in the tracked hand (only the emitted haipai is 13),
      // otherwise a later discard of the 14th tile looks illegal.
      if (haipaiSeat === 0 && tiles.length >= 14) { p.haipai = p.hand.slice(0, 13); p.turns.push({ draw: p.hand[13] }); }
      else p.haipai = p.hand.slice();
      advance();
      continue;
      }
    }

    // phase === 'play'
    const res = asResult(t);
    if (res) { handleResult(tok, res); continue; }

    // Explicit own-turn kan with a forced kind (and optional tile): "kakan",
    // "ankan", "kakan2s". Checked before parseCall so it wins over the generic
    // kan keyword.
    const ownKan = asOwnKan(t);
    if (ownKan && isExpect('discard')) {
      const tile = ownKan[2] ? parseTileNotation(ownKan[2])[0] : undefined;
      handleOwnTurnKan(tok, { tile, forceKind: ownKan[1].toLowerCase() as 'ankan' | 'kakan' });
      continue;
    }

    const call = parseCall(t);
    if (call) {
      // A bare kan on your own turn (after drawing) is an ankan/kakan (inferred).
      if (call.kind === 'kan' && isExpect('discard') && !call.rel && call.abs === undefined) { handleOwnTurnKan(tok, {}); continue; }
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

  function handleOwnTurnKan(tok: Tok, opts: { tile?: TenhouTile; forceKind?: 'ankan' | 'kakan' }) {
    if (!players || midTurnSeat === null) { warn(tok, 'kan with no active turn'); return; }
    const p = players[midTurnSeat];
    const drawn = p.turns[p.turns.length - 1]?.draw;
    // Kan tile: explicit if given (disambiguates when several are possible),
    // else the just-drawn tile.
    const tile = opts.tile ?? drawn;
    if (tile === undefined) { warn(tok, 'own-turn kan needs a known drawn tile or an explicit tile (e.g. kakan2s)'); return; }
    const inHand = countMatch(p, tile);
    const hasPon = p.calls.find((c) => c.type === 'pon' && normalizeRed(c.calledTile!) === normalizeRed(tile));
    const wantKakan = opts.forceKind === 'kakan' || (opts.forceKind === undefined && !!hasPon);
    const kanTurn = p.turns.length - 1;
    if (wantKakan) {
      if (!hasPon) { warn(tok, `no pon of ${tilesToNotation([tile])} to add a kan to`); return; }
      hasPon.type = 'kakan'; hasPon.tiles = [tile, tile, tile, tile]; hasPon.kanTurn = kanTurn; removeFromHand(p, tile);
    } else if (opts.forceKind === 'ankan' || inHand >= 4) {
      if (inHand < 4) { warn(tok, `need 4 concealed ${tilesToNotation([tile])} for an ankan`); return; }
      for (let i = 0; i < 4; i++) removeFromHand(p, tile);
      p.calls.push({ type: 'ankan', tiles: [tile, tile, tile, tile], turn: kanTurn });
    } else { warn(tok, `cannot kan ${tilesToNotation([tile])} (need 4 concealed or an existing pon)`); return; }
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

  /** True if seat w's concealed hand + the discard forms a valid winning hand. */
  function ronWins(w: Seat, winningTile: TenhouTile): boolean {
    const p = players![w];
    if (p.hand.length + 3 * p.calls.length !== 13) return false; // hand not fully known yet
    return scoreWin({
      concealed: p.hand.slice(), melds: p.calls.map((c) => ({ type: c.type, tiles: c.tiles })), winningTile, isTsumo: false,
      seatWind: 27 + w, roundWind: 27 + Math.floor(round / 4), doraIndicators: dora, uraIndicators: ura, riichi: p.riichi, rules: {},
    }).valid;
  }

  /** Score one ron hand into an Agari (isolated, fixed-index deltas). */
  function scoreRon(tok: Tok, w: Seat, winningTile: TenhouTile, from: Seat, honbaArg: number, sticksArg: number): Agari {
    const p = players![w];
    // A partially recorded haipai leaves the hand short; say so plainly rather
    // than reporting "no yaku". Fill in the haipai (quick-edit fields) to score.
    if (p.hand.length + 3 * p.calls.length !== 13) {
      warn(tok, `${['E', 'S', 'W', 'N'][w]}'s hand is incomplete (${p.hand.length + 3 * p.calls.length}/13 tiles) — fill in the haipai to score`, 'info');
      return { winner: fixedIndex(w, round), winningTile, deltas: [0, 0, 0, 0] };
    }
    const sr = scoreWin({
      concealed: p.hand.slice(), melds: p.calls.map((c) => ({ type: c.type, tiles: c.tiles })), winningTile, isTsumo: false,
      seatWind: 27 + w, roundWind: 27 + Math.floor(round / 4),
      doraIndicators: dora, uraIndicators: ura, riichi: p.riichi, rules: {},
    });
    if (!sr.valid) {
      warn(tok, `${['E', 'S', 'W', 'N'][w]} has no yaku on ${tilesToNotation([winningTile])} — deltas not computed`);
      return { winner: fixedIndex(w, round), winningTile, deltas: [0, 0, 0, 0] };
    }
    const { deltas } = agariDeltas({ winner: w, from, dealerSeat: 0, isTsumo: false, base: sr.base, honba: honbaArg, sticks: sticksArg });
    return { winner: fixedIndex(w, round), winningTile, han: sr.han, fu: sr.fu, yaku: sr.yaku, scoreText: sr.text, deltas: toFixedDeltas(deltas) };
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
    } else if (/ron$/.test(kind)) {
      if (!lastDiscard) { warn(tok, 'ron with no discard to claim'); closeKyoku({ kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }); return; }
      const from = lastDiscard.seat;
      const winTile = lastDiscard.tile;
      // Determine winner seat(s): explicit prefix, tripleron, or inferred single.
      let winners: Seat[];
      if (kind === 'tripleron') winners = ([0, 1, 2, 3] as Seat[]).filter((s) => s !== from);
      else {
        const prefix = kind.slice(0, -3); // strip "ron"
        if (prefix) winners = [...prefix].map((ch) => SEAT_LETTER[ch]).filter((s, i, a) => a.indexOf(s) === i && s !== from);
        else {
          // Bare "ron": the winner is whoever's hand actually completes on the
          // discard — not a turn-order guess. Fall back with a clear hint if the
          // hands are too incomplete to tell.
          const complete = ([0, 1, 2, 3] as Seat[]).filter((s) => s !== from && ronWins(s, winTile));
          if (complete.length === 1) winners = complete;
          else {
            winners = [((midTurnSeat !== null && isExpect('draw') ? turn : (midTurnSeat ?? turn)) as Seat)].filter((s) => s !== from);
            warn(tok, "couldn't tell who won this ron — prefix the winner's seat (e.g. wron for West)", 'info');
          }
        }
      }
      if (!winners.length) { warn(tok, 'ron names no valid winner'); closeKyoku({ kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }); return; }
      // Riichi sticks go to the winner nearest the discarder's right (head bump).
      const order = [...winners].sort((a, b) => ((a - from + 4) % 4) - ((b - from + 4) % 4));
      const agaris = order.map((w, i) => scoreRon(tok, w, winTile, from, honba, i === 0 ? sticks : 0));
      const combined: [number, number, number, number] = [0, 0, 0, 0];
      for (const a of agaris) for (let i = 0; i < 4; i++) combined[i] += a.deltas[i];
      const primary = agaris[0];
      result = {
        kind: 'ron', winner: primary.winner, loser: fixedIndex(from, round), winningTile: winTile,
        deltas: combined, han: primary.han, fu: primary.fu, yaku: primary.yaku, scoreText: primary.scoreText,
        wins: agaris.length > 1 ? agaris : undefined,
      };
    } else {
      // ryuukyoku: tenpai payments from each hand's shape.
      const tenpaiCS = ([0, 1, 2, 3] as Seat[]).map((s) => isTenpai(counts(players![s].hand), players![s].calls.length));
      const deltas = toFixedDeltas(ryuukyokuDeltas(tenpaiCS));
      const tenpai = ([0, 1, 2, 3] as Seat[]).filter((s) => tenpaiCS[s]).map((s) => fixedIndex(s, round));
      result = { kind: 'ryuukyoku', deltas, tenpai };
    }
    closeKyoku(result);
  }

  // Whose turn it is in a still-open final hand (for the live turn indicator):
  // the seat about to draw, or the one mid-turn about to discard.
  let pending: StreamParseResult['pending'];
  if (players && isPhase('play')) {
    const acting = (isExpect('draw') ? turn : (midTurnSeat ?? turn)) as Seat;
    pending = { seat: acting, expect: expect as 'draw' | 'discard' };
  }

  // finalize a trailing open hand
  if (players) closeKyoku();

  const names = (kyokus[0]?.players.map((p) => p.name) ?? ['P1', 'P2', 'P3', 'P4']) as [string, string, string, string];
  const game: Game = { meta: { title: ['Transcribed', ''], names, rule: { disp: '', aka: 0 } }, kyokus };
  return { game, diagnostics: diags, missing, pending };
}
