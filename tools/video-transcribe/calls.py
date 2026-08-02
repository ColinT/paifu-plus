"""
Call detection (chi / pon / kan).

This broadcast shows NO call overlay (unlike riichi's red badge), and the overhead
reveal is not guaranteed to exist in every broadcast. So calls are detected via two
broadcast-agnostic channels, strongest first:

  1. DISCARD-ORDER INFERENCE (primary; no CV of the meld needed).
     Normal turn order is a fixed round-robin over the four physical seats. A
     pon/kan/chi lets the caller take a discard and play OUT OF TURN, skipping the
     players between the discarder and the caller. So an out-of-turn discard in the
     per-seat discard timing (which Pass 3's river skeleton produces: count+timing)
     INFERS that a call happened, by whom (the out-of-turn discarder) and from whom
     (the player whose discard was claimed). No meld read, no overhead required.

  2. GEOMETRIC EXPOSED-MELD detection (evidence + meld identity).
     A called meld is a tile group set apart from the concealed hand. The signature
     depends on the view:
       - reveal (overhead): concealed tiles sit individually separated (narrow
         runs) while the meld is 3+ tiles butted into one wide SOLID run -> a run
         wider than ~2.5x the single-tile width is a meld.
       - over_shoulder: the concealed hand is itself a butted wall, so the meld is
         instead a run set apart by a felt GAP (offset from the main row).
     Used to confirm an inferred call and to read the meld's tiles (large/upright
     at the reveal -> classifiable by tiles.py, unlike river tiles).

Meld TILE IDENTITY comes from channel 2; channel 1 gives occurrence/who/whom even
when the meld is never cleanly visible.
"""
from __future__ import annotations

import cv2
import numpy as np

from pass2_hands import whitish


# ============================ 1. discard-order inference ====================

def infer_calls_from_discards(discards, n_seats=4):
    """Infer calls from the global discard sequence.

    discards: iterable of (t, seat) — one entry per discard, seat is the physical
      table index 0..n_seats-1 in turn order (shimocha = (seat+1)%n_seats). Need
      not be pre-sorted.

    Returns a list of inferred call events:
      {"t", "caller", "from", "skipped": [seats], "type_hint"}
    where type_hint is "chi/pon/kan?" if the claim was from the caller's kamicha
    (left neighbour — chi is only legal from there) else "pon/kan?".

    Rationale: with no call, the next discarder is always (prev+1)%n. Any deviation
    is only possible via a call, so an out-of-turn discard pinpoints one.
    """
    seq = sorted(discards, key=lambda d: d[0])
    calls = []
    for i in range(1, len(seq)):
        t_prev, prev = seq[i - 1]
        t_cur, cur = seq[i]
        expected = (prev + 1) % n_seats
        if cur == expected:
            continue
        # players skipped between the expected next and the actual caller
        skipped = []
        s = expected
        while s != cur:
            skipped.append(s)
            s = (s + 1) % n_seats
        kamicha = (cur - 1) % n_seats                 # caller's left neighbour
        type_hint = "chi/pon/kan?" if prev == kamicha else "pon/kan?"
        calls.append({"t": round(float(t_cur), 2), "caller": cur, "from": prev,
                      "skipped": skipped, "type_hint": type_hint})
    return calls


# ============================ 1b. count-based reconstruction ================

_LEGAL_CONCEALED = (13, 10, 7, 4, 1)   # at rest, = 13 - 3*melds


def melds_from_hand_count(concealed, holding_draw=False):
    """Number of called sets implied by a concealed-hand tile COUNT (not identity).
    A closed hand rests at 13 (14 while holding a draw); each chi/pon/kan drops the
    concealed count by 3 (an ankan counts as one meld too). A rough count is snapped
    to the nearest legal value, so counting need not be exact.
    Returns melds in 0..4, or None if the count is implausibly far from any legal value."""
    c = concealed - 1 if holding_draw else concealed
    nearest = min(_LEGAL_CONCEALED, key=lambda v: abs(v - c))
    if abs(nearest - c) > 1:
        return None                       # too far from legal -> unreliable read
    return (13 - nearest) // 3


def discard_count_skew(discard_counts):
    """Per-seat discard counts -> seats whose count deviates from the round-robin
    expectation (max spread should be <=1 with no calls). Returns the spread and the
    seats above/below, a coarse 'a call happened' signal complementing the timing one."""
    lo, hi = min(discard_counts), max(discard_counts)
    return {"spread": hi - lo,
            "ahead": [i for i, c in enumerate(discard_counts) if c == hi and hi - lo > 1],
            "behind": [i for i, c in enumerate(discard_counts) if c == lo and hi - lo > 1]}


def reconstruct_calls(discards, hand_meld_counts=None, n_seats=4):
    """Fuse the discard-order inference with per-seat meld counts (from hand-counts)
    to reconstruct calls, checking legality. Returns
      {"calls": [...], "per_seat_melds": {...}, "questions": [...]}.

    discards: [(t, seat)] as for infer_calls_from_discards (may be empty).
    hand_meld_counts: optional {seat: melds} observed from concealed-hand counts.
    """
    inferred = infer_calls_from_discards(discards, n_seats)
    by_seat = {}
    for c in inferred:
        by_seat.setdefault(c["caller"], []).append(c)
    questions = []
    per_seat = {}
    for seat in range(n_seats):
        obs = hand_meld_counts.get(seat) if hand_meld_counts else None
        seen = len(by_seat.get(seat, []))
        per_seat[seat] = {"melds_from_hand": obs, "calls_from_discards": seen}
        if obs is not None and obs != seen:
            questions.append({
                "kind": "call_reconcile", "seat": seat,
                "prompt": f"Seat {seat}: hand-count implies {obs} meld(s) but "
                          f"{seen} call(s) inferred from discards. Verify calls/timing."})
    return {"calls": inferred, "per_seat_melds": per_seat, "questions": questions}


# ============================ 2. geometric meld detection ===================

def tile_profile(strip):
    """Column tile-density profile (0..1) along a hand-row strip. Robust white
    measure: whiteness=min(R,G,B) relative to the strip's own bright level (p95),
    minus felt — no fixed cutoffs, no dependence on exposure."""
    hsv = cv2.cvtColor(strip, cv2.COLOR_BGR2HSV)
    H, S, V = cv2.split(hsv)
    felt = (H > 95) & (H < 130) & (S > 55)
    wht = strip.min(2).astype(np.float32)
    thr = 0.55 * float(np.percentile(wht, 95))
    m = ((wht > thr) & (~felt)).astype(np.float32)
    return np.convolve(m.mean(0), np.ones(5) / 5, "same")


def _runs(prof, on=0.35, min_run_frac=0.03):
    on_mask = prof > on
    n = len(prof)
    runs = []
    i = 0
    while i < n:
        if on_mask[i]:
            j = i
            while j < n and on_mask[j]:
                j += 1
            if (j - i) >= min_run_frac * n:
                runs.append((i, j))
            i = j
        else:
            i += 1
    return runs


def detect_melds(strip, view="reveal", meld_factor=2.5, gap_frac=0.03):
    """Detect exposed meld run(s) in a hand-row strip. Returns
    {"called", "runs", "melds", "single_w"} with meld runs as (x0, x1) px spans.

    view="reveal": meld = a solid run >= meld_factor x the median single-tile width
      (concealed tiles are individually separated at the reveal).
    view="over_shoulder": meld = a run set apart from the widest (concealed) run by
      a felt gap >= gap_frac of the strip width.
    """
    prof = tile_profile(strip)
    runs = _runs(prof)
    if not runs:
        return {"called": False, "runs": runs, "melds": [], "single_w": 0.0}
    widths = np.array([b - a for a, b in runs], float)
    if view == "reveal":
        narrow = [w for w in widths if w <= np.percentile(widths, 60)]
        single = float(np.median(narrow) if narrow else widths.min())
        melds = [runs[k] for k in range(len(runs)) if widths[k] >= meld_factor * single]
    else:  # over_shoulder: concealed is the widest run; melds are runs after a real gap
        single = float(np.median(widths))
        concealed = int(np.argmax(widths))
        gap_px = gap_frac * len(prof)
        melds = []
        for k in range(len(runs)):
            if k == concealed:
                continue
            # separated from the concealed run by a felt gap on the near side
            near = runs[concealed]
            gap = runs[k][0] - near[1] if runs[k][0] > near[1] else near[0] - runs[k][1]
            if gap >= gap_px:
                melds.append(runs[k])
    return {"called": len(melds) > 0, "runs": runs, "melds": melds,
            "single_w": round(single, 1)}


def read_meld_tiles(strip, meld_span, lib, n_tiles=3):
    """Classify the tiles in a detected meld span against the reference library
    (tiles.py). Meld tiles are large/upright at the reveal, so template matching
    works here where it fails on the river. Returns [(code, score), ...]."""
    import tiles
    x0, x1 = meld_span
    sub = strip[:, max(0, x0):x1]
    if sub.size == 0:
        return []
    w = (x1 - x0) // n_tiles
    out = []
    for i in range(n_tiles):
        cell = sub[:, i * w:(i + 1) * w]
        if cell.size == 0:
            out.append((None, 0.0))
            continue
        code, score = tiles.classify(cell, lib)
        out.append((code, round(float(score), 3)))
    return out


# ============================ self-test =====================================

if __name__ == "__main__":
    # Turn order E(0) S(1) W(2) N(3). Simulate an E4-1-like sequence where the
    # dealer (say seat 3, Kihara) pons seat 1's (Yamada's) 發 and discards out of
    # turn, skipping seat 2.
    #   normal: 0,1,2,3,0,1, [pon by 3 off 1's discard], 3, 0, ...
    discards = [(1830, 0), (1838, 1), (1846, 2), (1854, 3),
                (1862, 0), (1870, 1),          # seat 1 discards the 發 ...
                (1874, 3),                       # seat 3 pons -> discards out of turn (skips 2)
                (1882, 0), (1890, 1)]
    calls = infer_calls_from_discards(discards)
    print("inferred calls:")
    for c in calls:
        print(f"  t={c['t']} caller=seat{c['caller']} from=seat{c['from']} "
              f"skipped={c['skipped']} {c['type_hint']}")
    assert len(calls) == 1 and calls[0]["caller"] == 3 and calls[0]["from"] == 1
    assert calls[0]["skipped"] == [2]
    print("discard-order inference OK")

    # hand-count -> melds (count, not read); legality snaps a rough count
    assert melds_from_hand_count(13) == 0
    assert melds_from_hand_count(10) == 1
    assert melds_from_hand_count(11, holding_draw=True) == 1   # 11-1=10 -> 1 meld
    assert melds_from_hand_count(9) == 1                       # rough 9 snaps to 10
    assert melds_from_hand_count(7) == 2
    assert melds_from_hand_count(5) == 3                        # 5 snaps to 4 -> 3 melds
    assert melds_from_hand_count(20) is None                   # out of range -> unreliable
    print("hand-count -> melds OK")

    # fusion: Kihara (seat3) hand-count says 1 meld, discards infer 1 call -> consistent
    r = reconstruct_calls(discards, hand_meld_counts={0: 0, 1: 0, 2: 0, 3: 1})
    assert not r["questions"], r["questions"]
    # mismatch -> a reconciliation question
    r2 = reconstruct_calls(discards, hand_meld_counts={0: 0, 1: 0, 2: 0, 3: 2})
    assert any(q["kind"] == "call_reconcile" and q["seat"] == 3 for q in r2["questions"])
    # discard-count skew flags an imbalance
    assert discard_count_skew([6, 6, 4, 7])["spread"] == 3
    print("reconstruct_calls + discard-count skew OK")
