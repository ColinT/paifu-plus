"""
Pass 0 — read the broadcast overlay into round headers.

Given a video and one or more round-start timestamps, this reads the fixed
overlay graphics (round, honba, riichi sticks, dora, player names, scores) and
emits a partial tenhou-style header per timestamp, plus a list of timestamped
QUESTIONS for anything it could not read with confidence.

This is the cheap, near-solved skeleton the later passes hang off. It does NOT
read the felt (hands, discards) — see README for the pipeline.

Usage:
    python pass0_overlay.py --config config/ketteisen-wrc.json \
        --video clip.mp4 --clip-start 658 --at 690 --out out/headers.json

--at is the ABSOLUTE timestamp in the source video (what a viewer sees). If the
video file is a trimmed clip, pass --clip-start (the clip's start offset in the
source) so links resolve to the original video's timeline.
"""
from __future__ import annotations

import argparse
import json
import os

import cv2
import numpy as np

from frames import make_source

# ---- tile / round vocab ---------------------------------------------------

WINDS = {"東": 0, "南": 4, "西": 8, "北": 12}  # base tenhou round index per wind
DIGITS = {"１": "1", "２": "2", "３": "3", "４": "4", "0": "0"}  # full-width fixups

# man/pin/sou face -> tenhou tile code base; suit char -> tens digit
NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
SUIT = {"萬": 10, "万": 10, "筒": 20, "索": 30}
HONOR = {"東": 41, "南": 42, "西": 43, "北": 44, "白": 45, "發": 46, "发": 46, "中": 47}
TILE_ALLOW = "".join(list(NUM) + list(SUIT) + list(HONOR))


# ---- frame + OCR helpers --------------------------------------------------

def scale_region(region, img_w, img_h, ref_w, ref_h):
    sx, sy = img_w / ref_w, img_h / ref_h
    x, y, w, h = region
    return [int(x * sx), int(y * sy), int(w * sx), int(h * sy)]


def crop(img, region):
    x, y, w, h = region
    return img[max(0, y):y + h, max(0, x):x + w]


def binarize(sub, upscale):
    """White-text-on-dark -> upscaled black-on-white binary (helps EasyOCR a lot).
    Otsu is per-crop, so keep crops tight to one background (per-column, not a
    full band) or contrast suffers."""
    g = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, None, fx=upscale, fy=upscale, interpolation=cv2.INTER_CUBIC)
    _, th = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if th.mean() < 127:            # text was the bright minority -> make it dark
        th = cv2.bitwise_not(th)
    return th


def ocr_region(reader, img, region, allowlist=None, upscale=3, prep=True):
    """OCR one region. Returns list of (cx_in_region, cy, text, conf)."""
    sub = crop(img, region)
    if sub.size == 0:
        return []
    big = binarize(sub, upscale) if prep else cv2.resize(
        sub, None, fx=upscale, fy=upscale, interpolation=cv2.INTER_CUBIC)
    res = reader.readtext(big, allowlist=allowlist) if allowlist else reader.readtext(big)
    out = []
    for bbox, text, conf in res:
        cx = (bbox[0][0] + bbox[2][0]) / 2 / upscale
        cy = (bbox[0][1] + bbox[2][1]) / 2 / upscale
        out.append((cx, cy, text.strip(), float(conf)))
    return out


def column_regions(band, n=4):
    """Split a full-width band [x,y,w,h] into n equal column sub-regions."""
    x, y, w, h = band
    cw = w // n
    return [[x + i * cw, y, cw, h] for i in range(n)]


def join_tokens(toks):
    """Concatenate a region's tokens left-to-right (text, mean_conf)."""
    if not toks:
        return None, 0.0
    text = " ".join(t for _, _, t, _ in sorted(toks, key=lambda z: z[0]) if t)
    conf = sum(c for *_, c in toks) / len(toks)
    return (text or None), conf


# ---- field parsers --------------------------------------------------------

def parse_round(reader, img, region):
    toks = ocr_region(reader, img, region, prep=False)  # stylized kanji: binarize hurts
    text = "".join(t for _, _, t, _ in toks)
    conf = min([c for *_, c in toks], default=0.0)
    wind = next((w for w in WINDS if w in text), None)
    digit = next((ch for ch in text if ch.isdigit()), None)
    if wind is None or digit is None:
        return None, conf, text
    return WINDS[wind] + (int(digit) - 1), conf, text


def parse_int(reader, img, region):
    toks = ocr_region(reader, img, region, allowlist="0123456789", upscale=4)
    if not toks:
        return None, 0.0, ""
    cx, cy, text, conf = max(toks, key=lambda t: t[3])
    digits = "".join(ch for ch in text if ch.isdigit())
    return (int(digits) if digits else None), conf, text


def parse_dora(reader, img, region):
    """Best-effort: text-OCR the dora indicator tile. Man/honor faces sometimes
    read; pin/sou dot-patterns generally do not (that needs the tile classifier
    shared with pass 2/3). Returns (tile_code|None, conf, raw)."""
    toks = ocr_region(reader, img, region, allowlist=TILE_ALLOW, upscale=4)
    text = "".join(t for _, _, t, _ in toks)
    conf = max([c for *_, c in toks], default=0.0)
    for ch in text:  # honor first (single char)
        if ch in HONOR:
            return HONOR[ch], conf, text
    num = next((ch for ch in text if ch in NUM), None)
    suit = next((ch for ch in text if ch in SUIT), None)
    if num and suit:
        return SUIT[suit] + NUM[num], conf, text
    return None, conf, text


def parse_scores(reader, img, region):
    scores, confs = [], []
    for col in column_regions(region):
        toks = ocr_region(reader, img, col, allowlist="0123456789,")
        best = max(toks, key=lambda t: t[3], default=None)
        digits = "".join(ch for ch in best[2] if ch.isdigit()) if best else ""
        if len(digits) < 4:  # single token fell short — stitch tokens in reading order
            digits = "".join(ch for _, _, t, _ in sorted(toks) for ch in t if ch.isdigit())
        scores.append(int(digits) if len(digits) >= 4 else None)
        confs.append(best[3] if best else 0.0)
    return scores, confs


def parse_names(reader, img, region, prep=False):
    names, confs = [], []
    for col in column_regions(region):
        text, conf = join_tokens(ocr_region(reader, img, col, prep=prep))
        names.append(text); confs.append(conf)
    return names, confs


def detect_dealer(img, region, n=4):
    """Column with the strongest red underline = current dealer. Returns index|None."""
    x, y, w, h = region
    sub = img[max(0, y):y + h, max(0, x):x + w]
    if sub.size == 0:
        return None, [0] * n
    b, g, r = sub[:, :, 0].astype(int), sub[:, :, 1].astype(int), sub[:, :, 2].astype(int)
    red = (r > 120) & (r - g > 60) & (r - b > 60)
    cw = w // n
    counts = [int(red[:, i * cw:(i + 1) * cw].sum()) for i in range(n)]
    best = int(np.argmax(counts))
    return (best if counts[best] > 15 else None), counts


# ---- main -----------------------------------------------------------------

def source_link(cfg, abs_t):
    src = cfg.get("source", {})
    if src.get("type") == "youtube" and src.get("id"):
        return f"https://youtu.be/{src['id']}?t={int(abs_t)}"
    return {"file": src.get("file"), "offsetSec": round(abs_t, 2)}


def read_overlay(reader, reader_en, cfg, img, abs_t):
    h, w = img.shape[:2]
    R = {k: scale_region(v, w, h, cfg["ref_width"], cfg["ref_height"])
         for k, v in cfg["regions"].items()}
    questions = []

    def ask(kind, prompt, seat=None, candidates=None):
        questions.append({k: v for k, v in {
            "kind": kind, "seat": seat, "t": round(abs_t, 2),
            "prompt": prompt, "candidates": candidates,
            "link": source_link(cfg, abs_t),
        }.items() if v is not None})

    rnd, rc, rraw = parse_round(reader, img, R["round"])
    if rnd is None or rc < 0.4:
        ask("round", f"Round unreadable (OCR='{rraw}', conf={rc:.2f}).")

    honba, hc, _ = parse_int(reader, img, R["honba"])
    sticks, sc, _ = parse_int(reader, img, R["sticks"])
    if honba is None:
        ask("honba", "Honba count unreadable.")
    if sticks is None:
        ask("sticks", "Riichi-stick count unreadable.")

    dora, dc, draw = parse_dora(reader, img, R["dora"])
    if dora is None or dc < 0.4:
        ask("dora", f"Dora indicator unreadable (OCR='{draw}') — enter the tile.")

    names, nconf = parse_names(reader, img, R["jp_names"])          # kanji: ja model
    scores, sconf = parse_scores(reader_en, img, R["scores"])       # digits: en model
    romaji, rmconf = parse_names(reader_en, img, R["romaji"])       # latin: en model
    for i in range(4):
        # Confident in either script (kanji or romaji) is enough to skip the ask;
        # the romaji (Latin) read is usually the reliable one.
        if max(nconf[i], rmconf[i]) < 0.5:
            ask("name", f"Confirm player name (seat {i}).", seat=i,
                candidates=[n for n in (names[i], romaji[i]) if n])
        if scores[i] is None:
            ask("score", f"Score unreadable (seat {i}).", seat=i)

    # Constraint check: points are conserved. sum(standings) + sticks*1000 must
    # equal 4 x start_score at all times — catches a silently-misread score even
    # when its OCR confidence was high.
    start = cfg.get("start_score")
    if start and all(s is not None for s in scores):
        total = sum(scores) + (sticks or 0) * 1000
        if total != 4 * start:
            ask("consistency",
                f"Points don't reconcile: Σscores={sum(scores)} + {sticks or 0}×1000 "
                f"sticks = {total} ≠ {4 * start}. Verify the scores and stick count.")

    dealer, red_counts = detect_dealer(img, R["dealer_line"])
    if rnd is not None:
        expected = rnd % 4
        if dealer is not None and dealer != expected:
            ask("dealer", f"Dealer underline (seat {dealer}) disagrees with round "
                          f"({expected}). Verify seating/round.")
        if dealer is None:
            dealer = expected  # fall back to round math

    return {
        "t": round(abs_t, 2),
        "link": source_link(cfg, abs_t),
        "header": {
            "round": rnd, "honba": honba, "riichiSticks": sticks,
            "dora": [dora] if dora is not None else [],
            "names": names, "romaji": romaji, "scores": scores,
            "dealerSeat": dealer,
        },
        "confidence": {
            "round": round(rc, 2), "dora": round(dc, 2),
            "names": [round(c, 2) for c in nconf],
            "scores": [round(c, 2) for c in sconf],
        },
        "questions": questions,
        "raw": {"round": rraw, "dora": draw, "red_counts": red_counts},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--url", help="YouTube URL (frames fetched by timestamp, no full download)")
    ap.add_argument("--video", help="local video file (alternative to --url)")
    ap.add_argument("--at", type=float, action="append", required=True,
                    help="absolute source timestamp (s) of a round overlay; repeatable")
    ap.add_argument("--clip-start", type=float, default=0.0,
                    help="for --video only: the clip's start offset in the source")
    ap.add_argument("--height", type=int, default=720, help="stream height to fetch")
    ap.add_argument("--out", default=None)
    ap.add_argument("--dump-regions", action="store_true",
                    help="save each crop under out/regions_<t>/ for calibration, then exit")
    ap.add_argument("--gpu", action="store_true")
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)

    # default source from config (its youtube id) when neither --url nor --video given
    url = args.url
    if not url and not args.video:
        src = cfg.get("source", {})
        if src.get("type") == "youtube" and src.get("id"):
            url = f"https://www.youtube.com/watch?v={src['id']}"
    source = make_source(url=url, video=args.video,
                         clip_start=args.clip_start, height=args.height)

    if args.dump_regions:
        for t in args.at:
            img = source.grab(t)
            h, w = img.shape[:2]
            d = os.path.join(os.path.dirname(args.out or "out"), f"regions_{int(t)}")
            os.makedirs(d, exist_ok=True)
            cv2.imwrite(os.path.join(d, "_full.png"), img)
            for k, v in cfg["regions"].items():
                cv2.imwrite(os.path.join(d, f"{k}.png"),
                            crop(img, scale_region(v, w, h, cfg["ref_width"], cfg["ref_height"])))
            print("dumped", d)
        return

    import easyocr
    reader = easyocr.Reader(["ja"], gpu=args.gpu, verbose=False)      # kanji fields
    reader_en = easyocr.Reader(["en"], gpu=args.gpu, verbose=False)   # digits + romaji

    results = []
    for t in args.at:
        img = source.grab(t)
        results.append(read_overlay(reader, reader_en, cfg, img, t))

    payload = {"broadcast": cfg.get("broadcast"), "rounds": results}
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        nq = sum(len(r["questions"]) for r in results)
        print(f"wrote {args.out}: {len(results)} round(s), {nq} question(s)")
    else:
        print(text)


if __name__ == "__main__":
    main()
