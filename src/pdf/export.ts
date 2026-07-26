/**
 * Render a Game to our own PDF (not the Paifun layout). It draws a readable,
 * ASCII-safe summary and, crucially, embeds the tenhou/6 JSON as a file
 * attachment so the PDF round-trips: importing it back reads the attachment
 * rather than re-parsing the page. See readEmbeddedLog in ./browser.ts.
 *
 * Standard PDF fonts can't encode CJK, so visible text is sanitised to ASCII
 * (Japanese names fall back to "Player N"); the full data lives in the embedded
 * JSON, which is encoding-agnostic.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Game, Kyoku } from '../core/model.js';
import { gameToTenhou } from '../core/tenhou.js';
import { tilesToNotation } from '../core/tiles.js';

export const EMBED_NAME = 'paifuplus.json';

const WINDS = ['East', 'South', 'West', 'North'];
const roundName = (r: number) => `${WINDS[Math.floor(r / 4)] ?? '?'} ${(r % 4) + 1}`;

const LIMITS: Record<string, string> = {
  '数え役満': 'Counted yakuman', '三倍満': 'Sanbaiman', '倍満': 'Baiman', '跳満': 'Haneman', '満貫': 'Mangan', '役満': 'Yakuman',
};
function scoreEnglish(scoreText?: string): string {
  if (!scoreText) return '';
  let value = '';
  const fh = scoreText.match(/^(\d+)符(\d+)飜/);
  if (fh) value = `${fh[2]} han, ${fh[1]} fu`;
  else { const lim = scoreText.match(/^(数え役満|三倍満|倍満|跳満|満貫|役満)/); if (lim) value = LIMITS[lim[1]]; }
  const pts = scoreText.match(/(\d+(?:-\d+)?)点(∀)?/);
  let points = '';
  if (pts) points = pts[2] ? `${pts[1]} all` : `${pts[1].replace('-', '/')} pts`;
  return [value, points].filter(Boolean).join(', ');
}

/** Strip anything a standard PDF font can't draw; fall back to a seat name. */
const ascii = (s: string) => (s ?? '').replace(/[^\x20-\x7E]/g, '');
const dispName = (name: string, seat: number) => ascii(name).trim() || `Player ${seat + 1}`;

function discardNotation(k: Kyoku, seat: number): string {
  const tiles = k.players[seat].turns
    .filter((t) => t.discard !== undefined)
    .map((t) => (t.tsumogiri ? (t.draw ?? t.discard!) : t.discard!));
  return tiles.length ? tilesToNotation(tiles) : '—';
}

function resultLine(k: Kyoku, names: string[]): string {
  const r = k.result;
  if (r.kind === 'ryuukyoku') return 'Exhaustive draw' + (r.tenpai?.length ? ` (${r.tenpai.length} tenpai)` : '');
  const winners = r.wins?.length ? r.wins.map((w) => w.winner) : (r.winner !== undefined ? [r.winner] : []);
  const wn = winners.map((s) => names[s]).join(' + ');
  const tile = r.winningTile !== undefined ? ' ' + tilesToNotation([r.winningTile]) : '';
  const sc = r.wins?.length
    ? r.wins.map((w) => scoreEnglish(w.scoreText)).filter(Boolean).join(' / ')
    : scoreEnglish(r.scoreText);
  const scPart = sc ? ` — ${sc}` : '';
  if (r.kind === 'tsumo') return `${wn} tsumo${tile}${scPart}`;
  return `${wn} ron${tile}${r.loser !== undefined ? ` off ${names[r.loser]}` : ''}${scPart}`;
}

export async function gameToPdf(game: Game): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = 48, W = 595.28, H = 841.89, RIGHT = W - M;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const ensure = (need: number) => { if (y - need < M) { page = doc.addPage([W, H]); y = H - M; } };
  function line(text: string, opts: { size?: number; font?: PDFFont; indent?: number; gap?: number } = {}) {
    const size = opts.size ?? 10, f = opts.font ?? font, indent = opts.indent ?? 0;
    const maxW = RIGHT - M - indent;
    const words = text.split(' ');
    let cur = '';
    const flush = () => { ensure(size + 4); page.drawText(cur, { x: M + indent, y: y - size, size, font: f }); y -= size + 4; cur = ''; };
    for (const w of words) {
      const trial = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(trial, size) > maxW && cur) flush();
      cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) flush();
    if (opts.gap) y -= opts.gap;
  }

  const meta = game.meta;
  const names = [0, 1, 2, 3].map((s) => dispName(meta.names[s] ?? '', s));

  line(ascii(meta.title[0]) || 'PaifuPlus record', { size: 18, font: bold, gap: 4 });
  line(`Players — E: ${names[0]}   S: ${names[1]}   W: ${names[2]}   N: ${names[3]}`, { size: 10 });
  line(`Red fives: ${meta.rule.aka ? 'yes' : 'no'}${meta.rule.disp ? `   Rule: ${ascii(meta.rule.disp)}` : ''}`, { size: 9, gap: 10 });

  game.kyokus.forEach((k, i) => {
    ensure(70);
    const seatName = (curSeat: number) => names[(k.round + curSeat) % 4]; // current E,S,W,N
    line(`${roundName(k.round)}${k.honba ? ` · ${k.honba} honba` : ''}`, { size: 13, font: bold, gap: 2 });
    if (k.doraIndicators.length) line(`Dora: ${tilesToNotation(k.doraIndicators)}${k.uraIndicators.length ? `   Ura: ${tilesToNotation(k.uraIndicators)}` : ''}`, { size: 9 });
    line(`Result: ${resultLine(k, names)}`, { size: 10, gap: 2 });
    for (let s = 0; s < 4; s++) {
      const fixed = (k.round + s) % 4;
      line(`${WINDS[s][0]} ${seatName(s)}: ${discardNotation(k, fixed)}`, { size: 9, indent: 10 });
    }
    y -= 10;
    if (i < game.kyokus.length - 1) { ensure(8); page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) }); y -= 8; }
  });

  ensure(20);
  line('Generated by PaifuPlus — this PDF embeds the game data and can be re-imported.', { size: 8, font, gap: 0 });

  // Embed the tenhou/6 JSON as an attachment for lossless re-import.
  const json = JSON.stringify(gameToTenhou(game));
  await doc.attach(new TextEncoder().encode(json), EMBED_NAME, {
    mimeType: 'application/json',
    description: 'PaifuPlus game data (re-importable)',
  });

  doc.setTitle(ascii(meta.title[0]) || 'PaifuPlus record');
  doc.setCreator('PaifuPlus');
  doc.setProducer('PaifuPlus');

  // Skip object streams so the embedded-file entry stays in plaintext objects,
  // keeping extraction (and inspection) straightforward.
  return doc.save({ useObjectStreams: false });
}
