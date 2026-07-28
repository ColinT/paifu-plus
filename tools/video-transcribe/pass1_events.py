"""
Pass 1 — overlay event timeline + result.

The felt (discards) isn't reliably visible on this broadcast, but the persistent
overlay updates live. So we sample frames across a round, read the volatile state
(round / honba / scores / per-seat riichi), and diff consecutive states into a
timestamped event stream: riichi declarations and score changes (the round-end
payout falls out as the net delta). No felt CV.

Robustness comes from a points-conservation filter: a valid state has
`sum(scores) + sticks*1000 == 4*start_score`. Frames that don't conserve (OCR
flicker, mid-animation transitions) are dropped — and the filter also *recovers*
the stick count exactly (`sticks = (4*start - sum) / 1000`), so we don't rely on
the flaky tiny stick-counter OCR.

Usage:
    python pass1_events.py --config config/ketteisen-wrc.json \
        --start 661 --end 980 --step 8 --out out/e1_events.json
"""
from __future__ import annotations

import argparse
import json
import os

from frames import make_source
from pass0_overlay import (crop, detect_riichi, parse_int, parse_round,
                           parse_scores, scale_region, source_link)

SEATS = ("E", "S", "W", "N")


def read_state(reader, reader_en, cfg, img):
    """Volatile per-frame overlay state (the fields that change within a round)."""
    h, w = img.shape[:2]
    R = {k: scale_region(v, w, h, cfg["ref_width"], cfg["ref_height"])
         for k, v in cfg["regions"].items()}
    rnd, _, _ = parse_round(reader, img, R["round"])
    honba, _, _ = parse_int(reader, img, R["honba"])
    scores, sconf = parse_scores(reader_en, img, R["scores"])
    riichi, _ = detect_riichi(img, R["riichi"])
    return {"round": rnd, "honba": honba, "scores": scores,
            "riichi": riichi, "score_conf": sconf}


def validate(state, start):
    """A conservation-valid state -> (scores, sticks); else None.
    sticks is recovered from conservation, not OCR."""
    scores = state["scores"]
    if any(s is None for s in scores):
        return None
    rem = 4 * start - sum(scores)
    if rem < 0 or rem % 1000 != 0:
        return None
    return scores, rem // 1000


def diff_events(prev, cur, t, link):
    """Events from prev->cur valid state (both are (scores, sticks, riichi))."""
    events = []
    ps, _, pr = prev
    cs, _, cr = cur
    riichi_seats = set()
    for i in range(4):
        if not pr[i] and cr[i]:
            events.append({"kind": "riichi", "seat": i, "t": t, "link": link})
            riichi_seats.add(i)
    changed = [(i, cs[i] - ps[i]) for i in range(4) if cs[i] != ps[i]]
    # a lone -1000 on a seat that just declared riichi IS the riichi stick — fold it in
    if not (len(changed) == 1 and changed[0][1] == -1000 and changed[0][0] in riichi_seats):
        if changed:
            events.append({"kind": "score", "deltas": {SEATS[i]: d for i, d in changed},
                           "t": t, "link": link})
    return events


def classify_result(net):
    """Best-effort round result from net per-seat deltas (yaku left to a question)."""
    if all(d == 0 for d in net):
        return {"kind": "ryuukyoku", "deltas": net, "note": "all zero (draw)"}
    winner = max(range(4), key=lambda i: net[i])
    losers = [i for i in range(4) if net[i] < 0]
    if net[winner] <= 0:
        return {"kind": "unknown", "deltas": net}
    # small, spread deltas with no dominant winner look like a tenpai/noten draw
    if max(net) <= 3000 and len(losers) >= 1 and len([d for d in net if d > 0]) >= 2:
        return {"kind": "ryuukyoku?", "deltas": net, "note": "small deltas - draw or minor win"}
    kind = "ron" if len(losers) == 1 else "tsumo"
    return {"kind": kind, "winner": SEATS[winner],
            "loser": SEATS[losers[0]] if kind == "ron" else None, "deltas": net}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--url")
    ap.add_argument("--video")
    ap.add_argument("--clip-start", type=float, default=0.0)
    ap.add_argument("--start", type=float, required=True, help="round start (s)")
    ap.add_argument("--end", type=float, required=True, help="round end (s)")
    ap.add_argument("--step", type=float, default=8.0, help="sample interval (s)")
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--out", default=None)
    ap.add_argument("--gpu", action="store_true")
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
    start_score = cfg["start_score"]

    url = args.url
    if not url and not args.video:
        src = cfg.get("source", {})
        if src.get("type") == "youtube" and src.get("id"):
            url = f"https://www.youtube.com/watch?v={src['id']}"
    source = make_source(url=url, video=args.video,
                         clip_start=args.clip_start, height=args.height)

    import easyocr
    reader = easyocr.Reader(["ja"], gpu=args.gpu, verbose=False)
    reader_en = easyocr.Reader(["en"], gpu=args.gpu, verbose=False)

    times = []
    t = args.start
    while t <= args.end + 1e-6:
        times.append(round(t, 2))
        t += args.step

    events, prev = [], None
    first_valid = last_valid = None
    n_valid = 0
    for tt in times:
        img = source.grab(tt)
        st = read_state(reader, reader_en, cfg, img)
        v = validate(st, start_score)
        ok = v is not None
        print(f"t={tt:>7.1f}  valid={ok}  scores={st['scores']}  riichi={st['riichi']}")
        if not ok:
            continue
        n_valid += 1
        scores, sticks = v
        cur = (scores, sticks, st["riichi"])
        if prev is not None:
            events += diff_events(prev, cur, tt, source_link(cfg, tt))
        else:
            first_valid = (tt, scores)
        last_valid = (tt, scores)
        prev = cur

    questions = []
    result = None
    if first_valid and last_valid:
        net = [last_valid[1][i] - first_valid[1][i] for i in range(4)]
        result = classify_result(net)
        if result["kind"] in ("unknown", "ryuukyoku?") or any(k in result for k in ()):
            questions.append({"kind": "result",
                              "prompt": f"Verify round result/kind from the deltas {net}.",
                              "t": last_valid[0], "link": source_link(cfg, last_valid[0])})
        # yaku / han-fu aren't read from the felt; always confirm scoring detail
        questions.append({"kind": "yaku",
                          "prompt": "Enter yaku / han-fu (not read from the overlay).",
                          "t": last_valid[0], "link": source_link(cfg, last_valid[0])})

    payload = {
        "broadcast": cfg.get("broadcast"),
        "window": {"start": args.start, "end": args.end, "step": args.step},
        "sampled": len(times), "valid": n_valid,
        "startScores": first_valid[1] if first_valid else None,
        "finalScores": last_valid[1] if last_valid else None,
        "events": events,
        "result": result,
        "questions": questions,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"\nwrote {args.out}: {len(events)} event(s), {n_valid}/{len(times)} valid frames")
    else:
        print(text)


if __name__ == "__main__":
    main()
