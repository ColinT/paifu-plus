/**
 * Render a Game as a PAIFUN-style paifu PDF (the layout used by 最高位戦
 * transcripts and tenhou): one kyoku per page, a header with the round and dora
 * indicators, then four player bands (E/S/W/N) each showing 配牌 / ツモ / 捨牌 /
 * 最終形 rows of tile images, riichi tiles laid sideways, tsumogiri marked with
 * ↓, and win / deal-in markers.
 *
 * Tiles and text are rasterised to PNG on a canvas (so we need no embedded CJK
 * font — the JA labels use the system Japanese font) and placed with pdf-lib.
 * Browser-only (needs canvas/Image). The tenhou/6 JSON is embedded so the PDF
 * re-imports losslessly.
 */

import { PDFDocument, rgb, type PDFImage } from 'pdf-lib';
import type { Game, Kyoku, PlayerHand } from '../core/model.js';
import { gameToTenhou } from '../core/tenhou.js';
import { compareTiles, isRedFive, type TenhouTile } from '../core/tiles.js';
import { tileFaceUrl, frontUrl } from '../core/tileImage.js';

export const EMBED_NAME = 'paifuplus.json';
export type PaifuLang = 'en' | 'ja';

const WINDS_JA = ['東', '南', '西', '北'];
const WINDS_EN = ['East', 'South', 'West', 'North'];
const INK = '#111';

/** Position of the rotated (called) tile in a meld, by the discarder's seat
 *  relative to the caller: kamicha → left, toimen → middle, shimocha → right. */
function calledPosition(seat: number, fromSeat: number, n: number): number {
  const d = ((fromSeat - seat) + 4) % 4;
  if (d === 3) return 0;
  if (d === 2) return 1;
  return n - 1;
}

/** Meld tiles with the right tile(s) rotated: one for chi/pon, two for an
 *  open/added kan (minkan/kakan), none for a concealed kan (ankan). */
function meldCells(call: PlayerHand['calls'][number], callerSeat: number): { t: TenhouTile; landscape: boolean }[] {
  const n = call.tiles.length;
  if (call.type === 'ankan' || call.fromSeat === undefined) return call.tiles.map((t) => ({ t, landscape: false }));
  const rot = call.type === 'daiminkan' || call.type === 'kakan' ? 2 : 1;
  const pos = Math.min(calledPosition(callerSeat, call.fromSeat, n), n - rot);
  const others = [...call.tiles];
  if (call.calledTile !== undefined) { const i = others.indexOf(call.calledTile); if (i >= 0) others.splice(i, 1); }
  const called = call.calledTile ?? call.tiles[0];
  const cells: { t: TenhouTile; landscape: boolean }[] = [];
  let oi = 0;
  for (let k = 0; k < n; k++) cells.push(k >= pos && k < pos + rot ? { t: called, landscape: true } : { t: others[oi++] ?? called, landscape: false });
  return cells;
}

interface Labels {
  haipai: string; tsumo: string; sutehai: string; final: string;
  start: string; delta: string; end: string; dora: string; ura: string;
  riichi: string; ron: string; tsumoWin: string; dealin: string; draw: string;
  round: (wind: number, num: number, honba: number, sticks: number) => string;
  seat: (s: number) => string;
}

const LABELS: Record<PaifuLang, Labels> = {
  ja: {
    haipai: '配牌', tsumo: 'ツモ', sutehai: '捨牌', final: '最終形',
    start: '持点', delta: '動き', end: '合計', dora: 'ドラ', ura: '裏',
    riichi: 'ﾘｰﾁ', ron: 'ロン', tsumoWin: 'ツモ', dealin: 'ﾌﾘｺﾐ', draw: '流局',
    round: (w, n, honba, sticks) => `${WINDS_JA[w]}${n}局${honba}本場　供託${sticks}点`,
    seat: (s) => `${WINDS_JA[s]}家`,
  },
  en: {
    haipai: 'Haipai', tsumo: 'Draws', sutehai: 'Discards', final: 'Final',
    start: 'Start', delta: 'Δ', end: 'End', dora: 'Dora', ura: 'Ura',
    riichi: 'Riichi', ron: 'Ron', tsumoWin: 'Tsumo', dealin: 'Deal-in', draw: 'Draw',
    round: (w, n, honba, sticks) => `${WINDS_EN[w]} ${n}${honba ? ` · ${honba} honba` : ''}${sticks ? ` · ${sticks} sticks` : ''}`,
    seat: (s) => WINDS_EN[s],
  },
};

const FONT = '"Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, "MS Gothic", "Noto Sans JP", system-ui, sans-serif';

// ---- canvas rasterisation (cached) ----

const imgElCache = new Map<string, Promise<HTMLImageElement>>();
function loadImg(url: string): Promise<HTMLImageElement> {
  let p = imgElCache.get(url);
  if (!p) {
    p = new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    imgElCache.set(url, p);
  }
  return p;
}

function dataUrlBytes(u: string): Uint8Array {
  const bin = atob(u.slice(u.indexOf(',') + 1));
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

// Supersample for crisp raster. Tiles are placed at ~15-20pt but were being
// rasterised at 4× a 60px base (~240px) — hugely oversized, so every viewer had
// to downscale big images on each scroll (the reported lag). 2× keeps them
// sharp to ~600% zoom while cutting each PNG's pixel count 4×.
const SS = 2;

/** Rasterise a tile (body + face + aka pip), portrait or landscape. */
async function tileDataUrl(t: TenhouTile, landscape: boolean): Promise<string> {
  const w = 60, h = 80; // base px, 0.75 aspect
  const cv = document.createElement('canvas');
  cv.width = (landscape ? h : w) * SS;
  cv.height = (landscape ? w : h) * SS;
  const ctx = cv.getContext('2d')!;
  ctx.scale(SS, SS);
  if (landscape) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
  ctx.drawImage(await loadImg(frontUrl), 0, 0, w, h);
  const faceUrl = tileFaceUrl(t);
  if (faceUrl) { const fw = w * 0.74, fh = h * 0.74; ctx.drawImage(await loadImg(faceUrl), (w - fw) / 2, (h - fh) / 2, fw, fh); }
  if (t >= 100 || isRedFive(t)) {
    const r = w * 0.07, cx = w - w * 0.16, cy = h * 0.11;
    ctx.beginPath(); ctx.arc(cx, cy, r + 0.6, 0, 7); ctx.fillStyle = '#f4f0eb'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fillStyle = '#ce1914'; ctx.fill();
  }
  return cv.toDataURL('image/png');
}

/** Rasterise a run of text; returns the data URL and its pixel aspect (w/h). */
function textDataUrl(str: string, px: number, color: string, bold: boolean): { url: string; aspect: number } {
  const font = `${bold ? '700 ' : ''}${px}px ${FONT}`;
  const cv = document.createElement('canvas');
  let ctx = cv.getContext('2d')!;
  ctx.font = font;
  const w = Math.max(1, Math.ceil(ctx.measureText(str).width));
  const h = Math.ceil(px * 1.35);
  cv.width = w * SS; cv.height = h * SS;
  ctx = cv.getContext('2d')!;
  ctx.scale(SS, SS);
  ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'middle';
  ctx.fillText(str, 0, h / 2);
  return { url: cv.toDataURL('image/png'), aspect: w / h };
}

// ---- hand reconstruction (final shape) ----

function reconstructHand(p: PlayerHand): TenhouTile[] {
  const hand = [...p.haipai];
  for (const t of p.turns) if (t.draw !== undefined) hand.push(t.draw);
  const remove = (tile: TenhouTile) => { const i = hand.indexOf(tile); if (i >= 0) hand.splice(i, 1); };
  for (const t of p.turns) if (t.discard !== undefined) remove(t.tsumogiri ? t.draw! : t.discard);
  for (const c of p.calls) for (const mt of c.tiles) remove(mt);
  return hand.sort(compareTiles);
}

// ---- main ----

export async function gameToPaifuPdf(game: Game, lang: PaifuLang): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const L = LABELS[lang];

  const imgCache = new Map<string, PDFImage>();
  const embed = async (url: string): Promise<PDFImage> => {
    let img = imgCache.get(url);
    if (!img) { img = await doc.embedPng(dataUrlBytes(url)); imgCache.set(url, img); }
    return img;
  };
  const tile = async (t: TenhouTile, landscape = false) => embed(await tileDataUrl(t, landscape));
  const textCache = new Map<string, { img: PDFImage; aspect: number }>();
  const text = async (str: string, px: number, color = INK, bold = false) => {
    const key = `${px}|${color}|${bold ? 'b' : ''}|${str}`;
    let e = textCache.get(key);
    if (!e) { const { url, aspect } = textDataUrl(str, px, color, bold); e = { img: await embed(url), aspect }; textCache.set(key, e); }
    return e;
  };

  const PW = 595.28, PH = 841.89, M = 28;
  const CW = PW - 2 * M;

  for (const k of game.kyokus) await renderKyoku(k);

  const json = JSON.stringify(gameToTenhou(game));
  await doc.attach(new TextEncoder().encode(json), EMBED_NAME, { mimeType: 'application/json', description: 'PaifuPlus game data (re-importable)' });
  doc.setTitle((game.meta.title[0] || 'PaifuPlus paifu'));
  doc.setCreator('PaifuPlus');
  doc.setProducer('PaifuPlus');
  return doc.save({ useObjectStreams: false });

  // --- per-kyoku page ---
  async function renderKyoku(k: Kyoku) {
    const page = doc.addPage([PW, PH]);
    const drawImgTL = (img: PDFImage, x: number, topY: number, w: number, h: number) => page.drawImage(img, { x, y: topY - h, width: w, height: h });
    const drawText = async (str: string, x: number, topY: number, px: number, color?: string, bold?: boolean) => {
      const e = await text(str, px, color, bold); const h = px, w = h * e.aspect; drawImgTL(e.img, x, topY, w, h); return w;
    };

    const labelW = 46, rowGap = 3, bandGap = 10, headerH = 13, GAP = 8, boxPad = 8;
    const boxBorder = rgb(0.72, 0.72, 0.72);

    let y = PH - M;
    // ---- game-info box: title, round line, and dora / ura indicators, kept in
    // its own bordered section so the tiles never bleed into a player's band ----
    {
      const padTop = 7, padBot = 7, lineGap = 4;
      const hasTitle = !!game.meta.title[0];
      const titleH = hasTitle ? 12 + lineGap : 0;
      const dth = 16, dtw = dth * 0.75;
      const lineH = k.doraIndicators.length ? 18 : 13;
      const boxTop = y;
      const boxBottom = boxTop - padTop - titleH - lineH - padBot;
      page.drawRectangle({ x: M - 4, y: boxBottom, width: CW + 8, height: boxTop - boxBottom, borderColor: boxBorder, borderWidth: 0.75 });
      let cy = boxTop - padTop;
      if (hasTitle) { await drawText(game.meta.title[0], M + boxPad, cy, 12, INK, true); cy -= titleH; }
      const rw = await drawText(L.round(Math.floor(k.round / 4), (k.round % 4) + 1, k.honba, k.riichiSticks), M + boxPad, cy, 12, INK, true);
      if (k.doraIndicators.length) {
        let dx = Math.max(M + boxPad + 200, M + boxPad + rw + 20);
        dx += (await drawText(L.dora, dx, cy, 11, INK)) + 4;
        for (const d of k.doraIndicators) { drawImgTL(await tile(d), dx, cy + 2, dtw, dth); dx += dtw + 1; }
        if (k.uraIndicators.length) {
          dx += 6; dx += (await drawText(L.ura, dx, cy, 11, INK)) + 4;
          for (const u of k.uraIndicators) { drawImgTL(await tile(u), dx, cy + 2, dtw, dth); dx += dtw + 1; }
        }
      }
      y = boxBottom - bandGap;
    }

    // Compute a tile size that fits the widest row and the four bands that
    // remain below the info box.
    const rowsOf = (p: PlayerHand) => {
      const draws = p.turns.length;                       // ツモ cells (incl. ↓ / gaps)
      const disc = p.turns.filter((t) => t.discard !== undefined).length;
      const final = reconstructHand(p).length + p.calls.reduce((s, c) => s + c.tiles.length + 1, 0) + 3;
      return Math.max(p.haipai.length, draws, disc, final);
    };
    const maxCells = Math.max(1, ...k.players.map(rowsOf));
    const availRowW = CW - labelW;
    let tileW = Math.min(20, availRowW / maxCells);
    let tileH = tileW / 0.75;
    const budget = y - M; // vertical room left below the info box for four bands
    const bandH = () => headerH + 8 + 2 * GAP + 4 * (tileH + rowGap);
    while (bandH() * 4 + bandGap * 4 > budget && tileH > 8) { tileH -= 0.5; tileW = tileH * 0.75; }

    // Players in current-seat order E,S,W,N (fixed index (round+seat)%4).
    for (let s = 0; s < 4; s++) {
      const p = k.players[(k.round + s) % 4];
      y = await renderBand(p, s, y);
      y -= bandGap;
    }

    async function renderBand(p: PlayerHand, seat: number, top: number): Promise<number> {
      let yy = top;
      // header: seat + name + scores + result marker
      const win = k.result;
      const isWinner = win.kind !== 'ryuukyoku' && (win.wins ? win.wins.some((w) => w.winner === p.seat) : win.winner === p.seat);
      const isLoser = win.kind === 'ron' && win.loser === p.seat;
      const delta = p.scoreDelta;
      const marker = isWinner ? (win.kind === 'tsumo' ? L.tsumoWin : L.ron) : isLoser ? L.dealin : '';
      // Left: seat + name (+ result marker).
      let hx = M + boxPad + (await drawText(`${L.seat(seat)}  ${p.name}`, M + boxPad, yy, 10, INK)) + 8;
      if (marker) await drawText(marker, hx, yy, 10, isLoser ? '#c51405' : '#1668c5', true);
      // Right: a small bordered score table — 持点 / 動き / 合計 (start / Δ / total),
      // each row label-left, value-right. Sits in the empty top-right of the band.
      {
        const tblW = 96, rowH = 10, tPad = 3, fs = 8;
        const tblH = tPad * 2 + 3 * rowH;
        const tblX = M + CW - tblW, tblTop = top + 2;
        page.drawRectangle({ x: tblX, y: tblTop - tblH, width: tblW, height: tblH, borderColor: boxBorder, borderWidth: 0.75 });
        const rows: [string, string][] = [
          [L.start, `${p.startScore}`],
          [L.delta, `${delta >= 0 ? '+' : ''}${delta}`],
          [L.end, `${p.startScore + delta}`],
        ];
        let ry = tblTop - tPad - (rowH - fs) / 2;
        for (const [lab, val] of rows) {
          await drawText(lab, tblX + 5, ry, fs, INK);
          const ve = await text(val, fs, INK); const vw = fs * ve.aspect;
          drawImgTL(ve.img, tblX + tblW - 5 - vw, ry, vw, fs);
          ry -= rowH;
        }
      }
      yy -= headerH;

      const rowLabel = async (lab: string) => { await drawText(lab, M, yy - (tileH - 9) / 2, 9, INK); };
      const placeTiles = async (cells: { t?: TenhouTile; landscape?: boolean; arrow?: boolean; label?: string; labelAbove?: string }[], labelH = 0) => {
        let x = M + labelW;
        for (const c of cells) {
          if (c.arrow) {
            const ap = tileH * 0.66; const e = await text('↓', ap, INK, true); const aw = ap * e.aspect;
            drawImgTL(e.img, x + (tileW - aw) / 2, yy - (tileH - ap) / 2, aw, ap);
            x += tileW + 1; continue;
          }
          if (c.t === undefined) { x += tileW + 1; continue; }
          const ls = !!c.landscape;
          const w = ls ? tileH : tileW, h = ls ? tileW : tileH;
          drawImgTL(await tile(c.t, ls), x, yy - (ls ? (tileH - h) / 2 : 0), w, h);
          if (c.label && labelH) { const lp = labelH; const le = await text(c.label, lp, INK, true); const lw = lp * le.aspect; drawImgTL(le.img, x + (w - lw) / 2, yy - h - 1, lw, lp); }
          if (c.labelAbove) { const lp = 8; const le = await text(c.labelAbove, lp, INK, true); const lw = lp * le.aspect; drawImgTL(le.img, x + (w - lw) / 2, yy + lp + 1, lw, lp); }
          x += w + 1;
        }
      };
      const winTile = win.kind === 'ryuukyoku' ? undefined
        : win.wins?.length ? win.wins.find((w) => w.winner === p.seat)?.winningTile
        : win.winner === p.seat ? win.winningTile : undefined;

      // 配牌 (a gap follows to set the opening hand apart)
      await rowLabel(L.haipai);
      await placeTiles([...p.haipai].sort(compareTiles).map((t) => ({ t })));
      yy -= tileH + rowGap + GAP;

      // ツモ (draws; ↓ = tsumogiri; gap for called turns)
      await rowLabel(L.tsumo);
      await placeTiles(p.turns.map((t) => t.tsumogiri ? { arrow: true } : t.draw !== undefined ? { t: t.draw } : {}));
      yy -= tileH; // draws and discards sit flush together

      // 捨牌 (discards; a ﾘｰﾁ / ﾌﾘｺﾐ label sits under the tile, no rotation).
      // The deal-in tile is the loser's last discard (the tile that was ronned).
      await rowLabel(L.sutehai);
      const discs = p.turns.filter((t) => t.discard !== undefined);
      await placeTiles(discs.map((t, i) => ({
        t: t.tsumogiri ? t.draw! : t.discard!,
        label: (isLoser && i === discs.length - 1) ? L.dealin : t.riichi ? L.riichi : undefined,
      })), 8);
      yy -= tileH + 8 + rowGap + GAP; // 8 = riichi/deal-in label strip below; GAP sets the final shape apart

      // 最終形: concealed shape, then the winning tile (labelled ロン / ツモ above
      // it), then called melds — laid out as the winner would hold them.
      await rowLabel(L.final);
      const concealed = reconstructHand(p);
      if (isWinner && win.kind === 'tsumo' && winTile !== undefined) { const i = concealed.indexOf(winTile); if (i >= 0) concealed.splice(i, 1); }
      const finalCells: { t?: TenhouTile; landscape?: boolean; labelAbove?: string }[] = concealed.map((t) => ({ t }));
      if (isWinner && winTile !== undefined) { finalCells.push({}); finalCells.push({ t: winTile, labelAbove: win.kind === 'tsumo' ? L.tsumoWin : L.ron }); }
      for (const c of p.calls) { finalCells.push({}); finalCells.push(...meldCells(c, p.seat)); }
      await placeTiles(finalCells);
      yy -= tileH + rowGap;

      // Box the whole band.
      const boxTop = top + 4, boxBottom = yy + 2;
      page.drawRectangle({ x: M - 4, y: boxBottom, width: CW + 8, height: boxTop - boxBottom, borderColor: boxBorder, borderWidth: 0.75 });

      return yy;
    }
  }
}
