"""
River (discard pile) tile COUNTER — near seat, tray-anchored.

Counting beats reading (see hand_count.py): river tile identity isn't OCR-viable
(tiles butt white-to-white with no seam edges at this resolution), but the near
seat's discard COUNT is directly useful (turn number, riichi discard index, call
timing cross-check) and doesn't need identity.

Anchor: the compass homography (compass.calibrate_camera), NOT a hand-tuned
screen-space ROI. An axis-aligned ROI box (the first version of this module) is
fragile: its fixed multipliers of `side` catch the wrong content depending on
camera framing (PiP box, wall, tray edge — see scratchpad/river/pipeline_{N,S,E}
diagnostics from the ROI-based version, which picked the WRONG blob on 3 of 4
seats). Instead: deskew with the tray homography, ORIENTED so +Y in the deskewed
square always means "toward the camera" in the original frame (see
compass._orient_river_ward — every over-shoulder shot has the near seat's
hand/wall/river BELOW the tray at larger image-y; the raw quad-fit's cyclic-
corner winding does NOT give this consistently, so it must be canonicalized once
at calibration time). compass.deskew_river_band then extends the warp downward
past the tray square into the near river band, in the SAME oriented coordinate
frame for every camera.

No temporal median: the river GROWS over time, so unlike the concealed hand
(present, same content, every frame — median just erases the transient occluding
arm) a multi-frame median of the river blends different discard states and
blurs/erases tiles that aren't in every frame. Read a SINGLE frame instead
(pick_river_frame picks the latest frame matching the seat's dominant camera
framing — no blending across content).

Pipeline per frame:
  1. compass.deskew_river_band(frame, H, side) -> extended warp; river band =
     the part below the tray square (rows >= side).
  2. wall_zone_mask on the river-band crop: the wall's visible orange edge,
     dilated to also cover its white top face (same white plastic as a tile
     face — colour alone can't tell them apart, only the orange side can).
  3. river_row_candidates (adapted from hand_count._row_candidates), wall zone
     excluded BEFORE row-extraction morphology.
  4. the largest surviving candidate -> hand_count._quad_from_comp (front-face
     quad) -> hand_count._count_seams (white-seam valley counting, N = seams+1).

Known limits (first pass, revised after the ROI version's diagnostics exposed
false picks): homography accuracy degrades with distance from the tray (the
quad-fit IoU is often weak even at the tray itself — see compass.calibrate_camera
docstring), so the river band is only APPROXIMATELY rectified; only a single row
is counted (no multi-row wrap handling); riichi (rotated) and exposed/called
tiles are not distinguished from a normal discard; single-frame seam counts are
noisy (see hand_count's own cv caveat) — river_timeline's per-bin consensus
should use several single-frame reads, not a blend of them.
"""
from __future__ import annotations

import cv2
import numpy as np

import compass
import hand_count as HC
import pass2_hands as PH

DEFAULTS = {
    "river_mult": 1.8,      # * side, how far below the tray to extend the warp
    "pad_x": 0.15,           # * side, x-margin either side of the tray width
    "wall_dilate_px": 35,    # grows the orange wall edge to also cover its white top face
    "min_long_frac": 0.10,   # row candidate: min length as a fraction of band width
    "framing_ncc": 0.70,     # min NCC to the seat's dominant framing (single-frame pick)
}


def _cfg(cfg):
    d = dict(DEFAULTS)
    d.update((cfg or {}).get("pass3", {}).get("river_count", {}))
    return d


def wall_zone_mask(bgr, dilate_px):
    """The wall's visible orange edge, dilated to also cover its adjoining white
    top face (indistinguishable from a tile face by colour alone). Zero this out
    of the whitish mask before row extraction so the wall can't fuse into or be
    mistaken for the discard row."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    H, S, _ = cv2.split(hsv)
    edge = ((H > 5) & (H < 30) & (S > 60)).astype(np.uint8) * 255
    return cv2.dilate(edge, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_px, dilate_px)))


def river_row_candidates(bgr, wall_zone, min_long_frac):
    """Row-shaped whitish blobs with the wall zone excluded BEFORE morphological
    closing (excluding after would still let a wall-fused blob include wall
    pixels). Same recipe as hand_count._row_candidates, wall-aware."""
    m = PH.whitish(bgr)
    m[PH.tile_edges(bgr) > 0] = 0
    m[wall_zone > 0] = 0
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 1)))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, st, ce = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if a < 0.0015 * m.size:
            continue
        pts = np.column_stack(np.where(lab == i)[::-1]).astype(np.float32)
        (_, _), (bw, bh), _ = cv2.minAreaRect(pts)
        if max(bw, bh) < min_long_frac * m.shape[1]:
            continue
        comp = cv2.morphologyEx((lab == i).astype(np.uint8) * 255, cv2.MORPH_CLOSE,
                                cv2.getStructuringElement(cv2.MORPH_RECT, (15, 9)))
        out.append((comp, int(x), int(y), int(w), int(h), int(a)))
    return out


def _ink_density(bgr, comp):
    """Fraction of a candidate's own footprint that is character-ink edge (Canny,
    via pass2_hands.tile_edges but WITHOUT its dilation, so it stays a tight ink
    measure rather than a barrier mask). A face-up discard tile is covered in
    printed strokes; a wall tile's visible face is its blank back — this is the
    signal that tells them apart when area/shape can't (both are white, row-
    shaped blobs of similar size)."""
    mask = comp > 0
    if mask.sum() < 20:
        return 0.0
    g = cv2.GaussianBlur(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), (3, 3), 0)
    v = float(np.median(g))
    edges = cv2.Canny(g, int(max(0, 0.66 * v)), int(min(255, 1.33 * v)))
    return float((edges[mask] > 0).mean())


def select_river_candidate(bgr, cands, min_ink=0.08):
    """Pick the candidate that's an actual DISCARD row, not a wall segment that
    slipped past wall_zone_mask. Area/shape can't tell a blank wall-back blob
    from a printed tile-face blob (both are white and row-shaped) — ink density
    can: a wall's visible face is blank (a wall seam or compression noise can
    still trip a LOW ink fraction, ~0.02-0.06), a discard's is covered in
    character strokes (~0.08-0.15+). min_ink=0.08 sits in that gap. A product
    score (ink*area) was tried and REJECTED: a big near-blank wall blob's small
    incidental ink times its large area can still beat a smaller genuinely-
    inked blob (observed on seat W: wall ink=0.055 area=10759 -> 587 beat tile
    ink=0.10 area=5006 -> 513) — so ink is a hard FILTER first, area only
    breaks ties among candidates that already cleared it. Falls back to the
    largest candidate if none clears the ink floor (better than returning
    nothing on a genuinely hard frame)."""
    if not cands:
        return None
    scored = [(c, _ink_density(bgr, c[0])) for c in cands]
    inked = [c for c, s in scored if s >= min_ink]
    pool = inked or [c for c, _ in scored]
    return max(pool, key=lambda c: c[5])


def river_band_crop(bgr, calib, cfg=None):
    """Deskew via the ORIENTED tray homography and return just the river band
    (below the tray square). Returns (band_bgr, full_warp, side_px) or None."""
    if calib is None:
        return None
    P = _cfg(cfg)
    warp, px = compass.deskew_river_band(bgr, calib["H"], calib["side"], P["river_mult"], P["pad_x"])
    side = calib["side"]
    band = warp[side:, :]
    return band, warp, side


def count_river(bgr, calib, cfg=None):
    """Rough near-river tile count in a single frame, by seam-counting the
    largest wall-excluded row candidate in the deskewed river band. Returns
    {count, score, band, warp, quad} or None if no candidate / uncalibrated.
    Noisy per-frame — prefer count_river_at / river_timeline for reliability."""
    if calib is None:
        return None
    P = _cfg(cfg)
    out = river_band_crop(bgr, calib, cfg)
    if out is None:
        return None
    band, warp, side = out
    if band.size == 0:
        return None
    wall_zone = wall_zone_mask(band, P["wall_dilate_px"])
    cands = river_row_candidates(band, wall_zone, P["min_long_frac"])
    if not cands:
        return {"count": 0, "score": None, "band": band, "warp": warp, "quad": None}
    comp, cx, cy, cw, ch, area = select_river_candidate(band, cands)
    try:
        quad = HC._quad_from_comp(band, comp, n_tiles=6)
        L = float(np.hypot(*(quad[1] - quad[0])))
        Wd, Hd = max(1, int(round(L))), PH.CELL_H
        dst = np.float32([[0, 0], [Wd, 0], [Wd, Hd], [0, Hd]])
        strip = cv2.warpPerspective(band, cv2.getPerspectiveTransform(quad, dst), (Wd, Hd))
        n_tiles, seams, cv_ = HC._count_seams(strip, max_tiles=10)
    except Exception:
        return None
    return {"count": n_tiles, "score": round(cv_, 3), "band": band, "warp": warp,
            "quad": quad, "strip": strip}


def pick_river_frame(seat_frames, framing_ncc=0.70):
    """Pick ONE frame — chronologically latest among those matching the seat's
    dominant camera framing — rather than blending frames. A temporal median
    would blur/erase tiles that aren't present in every frame, since the river
    GROWS over the window (unlike the concealed hand, whose content is constant
    and only transiently arm-occluded). Returns (t, bgr) or None."""
    sf = sorted(seat_frames, key=lambda x: x[0])
    if not sf:
        return None
    ref = compass._region(sf[-1][1])
    good = [(t, im) for t, im in sf if compass._ncc(ref, compass._region(im)) >= framing_ncc]
    pool = good or sf
    return pool[-1]


def count_river_at(seat_frames, calib, cfg=None):
    """Count from a single, non-blended frame (pick_river_frame) at the latest
    moment covered by `seat_frames`. Returns {count, t} or None."""
    if calib is None or not seat_frames:
        return None
    P = _cfg(cfg)
    picked = pick_river_frame(seat_frames, P["framing_ncc"])
    if picked is None:
        return None
    t, im = picked
    r = count_river(im, calib, cfg)
    if r is None:
        return None
    r["t"] = round(t, 1)
    return r


def _isotonic_nondecreasing(values):
    """Pool-Adjacent-Violators: the closest (least-squares) non-decreasing fit to
    a noisy sequence. Used instead of a running MAX: a river only ever grows, so
    the true count IS monotonic, but a raw running max latches onto the single
    worst overcount forever (one bad frame permanently inflates every bin after
    it). PAVA instead pools a violating run and averages it, so one noisy spike
    gets smoothed against its neighbours rather than becoming a permanent floor."""
    vals = [float(v) for v in values]
    weights = [1.0] * len(vals)
    i = 0
    while i < len(vals) - 1:
        if vals[i] > vals[i + 1]:
            merged = (vals[i] * weights[i] + vals[i + 1] * weights[i + 1]) / (weights[i] + weights[i + 1])
            vals[i:i + 2] = [merged]
            weights[i:i + 2] = [weights[i] + weights[i + 1]]
            i = max(0, i - 1)
        else:
            i += 1
    out = []
    for v, w in zip(vals, weights):
        out.extend([v] * int(w))
    return out


def river_timeline(seat_frames, calib, cfg=None, bin_s=20.0):
    """Per-seat river count over time: one single-frame (non-blended) read per
    time bin, then an isotonic (non-decreasing) fit across bins — a river only
    ever grows, so any dip between consecutive bins is occlusion/mis-
    segmentation, not a real shrink, but a raw running MAX would let one bad
    overcount permanently inflate every later bin; PAVA smooths a spike against
    its neighbours instead. Returns [{t, count, raw_count}, ...] in time order."""
    if calib is None:
        return []
    sf = sorted(seat_frames, key=lambda x: x[0])
    if not sf:
        return []
    t0 = sf[0][0]
    bins = {}
    for t, im in sf:
        bins.setdefault(int((t - t0) // bin_s), []).append((t, im))
    reads = []
    for b in sorted(bins):
        r = count_river_at(bins[b], calib, cfg)
        if r is not None:
            reads.append(r)
    if not reads:
        return []
    smoothed = _isotonic_nondecreasing([r["count"] for r in reads])
    return [{"t": r["t"], "count": int(round(s)), "raw_count": r["count"]}
            for r, s in zip(reads, smoothed)]
