"""
Concealed-hand tile COUNTER (+ optional identity).

Counting beats reading: a concealed hand rests at 13 tiles (14 while holding a
draw), and each chi/pon/kan drops the concealed count by 3. So COUNTING a seat's
concealed tiles yields the number of called sets — melds = (13 - count)/3 — even
when the tiles can't be identified. Counting is n-independent (the tile PITCH is
found from the row's periodicity), and a rough count is snapped to the legal set,
so it need not be exact.

Pipeline (reuses pass2_hands geometry):
  1. row_quad -> deskew the concealed row to a rectangle (the exposed meld is a
     separate blob, so select_haipai locks onto the concealed wall).
  2. estimate the tile pitch by autocorrelation of the column-darkness profile
     -> raw count = strip width / pitch.
  3. snap to the nearest legal hand size (incl. +1 for a held draw) -> count, melds.
  4. optional: with N known, reuse pass2.read_hand to identify the tiles (fixed-N
     split gives consistent framing, which is what recognition needs).

Identity is best-effort (in-play reads are noisy, some tiles unseeded) and every
low-confidence cell is flagged; the COUNT is the robust product.
"""
from __future__ import annotations

import itertools

import cv2
import numpy as np

import pass2_hands as P
import pass0_overlay as P0

# legal concealed-hand sizes at rest and while holding a draw
_REST = (13, 10, 7, 4, 1)
_LEGAL = sorted(set(_REST) | {c + 1 for c in _REST})   # + drawn tile


def _peaks(sig, min_dist, thr):
    """Distinct above-threshold regions of sig, thinned to a minimum separation
    (keep the strongest). A contiguous run that stays above `thr` is ONE region
    even if it has multiple local maxima inside it ("twin peaks" — a noisy
    double-bump that never quite dips back below threshold between the two
    humps). Scoring each local maximum independently was the old approach and
    is wrong here: two close twin peaks either collide under min_dist (only the
    taller survives, which need not sit at the true seam centre) or, if they
    happen to clear min_dist, get reported as two separate seams when they're
    really one. Instead: each contiguous above-threshold run is scored by its
    AREA over threshold (sum of sig-thr across the run, not a single point's
    height) and reported at its area-weighted CENTROID. No scipy dependency."""
    n = len(sig)
    regions = []          # (area, centroid)
    i = 0
    while i < n:
        if sig[i] >= thr:
            j = i
            while j < n and sig[j] >= thr:
                j += 1
            xs = np.arange(i, j)
            w = sig[i:j] - thr
            area = float(w.sum())
            if area > 0:
                regions.append((area, float((xs * w).sum() / area)))
            i = j
        else:
            i += 1
    regions.sort(key=lambda r: -r[0])
    kept = []
    for area, c in regions:
        if all(abs(c - k) >= min_dist for k in kept):
            kept.append(c)
    return sorted(int(round(c)) for c in kept)


def _count_seams(warp, max_tiles=14, shoulder=None, check_first=None, check_last=None):
    """Count the white SEAMS between tiles in a deskewed hand strip (unbiased, no N
    assumed); N = seams + 1. Returns (n_tiles, seam_positions, cv_spacing, x0, x1).
    (x0, x1) is the usable content range within `warp` — [0, W] unless an end
    artifact was dropped (see _drop_end_side_faces), in which case that end's
    pixels are excluded from x0/x1 entirely rather than silently absorbed into
    the neighbouring real tile's cell. Any caller that crops per-tile cells
    from `seams` MUST also crop to warp[:, x0:x1] first.

    A real inter-tile seam is white across the FULL tile height; a within-symbol
    stroke gap is dark somewhere in the column. So the seam signal uses per-column
    MAX darkness (255 - min brightness) — low only when the whole column is white —
    which rejects stroke gaps that a column-MEAN would fire on. Skin/finger columns
    (warm R-B) are excluded so an occluding thumb doesn't spawn false seams.

    max_tiles sets the window/min-spacing scale (both are W/max_tiles-derived) —
    it must match the true legal ceiling (14 = 13 + a held draw), NOT a generous
    safety margin: a larger max_tiles shrinks min-spacing and lets sou tiles'
    OWN internal glyph-to-glyph white gaps (a real gap, just not a tile boundary)
    register as extra false seams. Verified on 3 real hand strips + visual
    per-crop check: max_tiles=18 over-split dense sou tiles (gave N=15/16/17,
    over the legal max); max_tiles=14 correctly keeps each sou tile as one
    crop (N=14/14/15, confirmed against the actual tile faces, not just the
    count landing in range)."""
    H, W = warp.shape[:2]
    band = warp[int(0.10 * H):int(0.90 * H), :]
    gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY).astype(np.float32)
    darkmax = 255.0 - gray.min(axis=0)                         # low only if column all-white
    darkmax = np.convolve(darkmax, np.ones(3) / 3, mode="same").astype(np.float32)
    b, g, r = band[:, :, 0].astype(np.float32), band[:, :, 1], band[:, :, 2].astype(np.float32)
    skin = ((r - b).mean(axis=0) > 30)                          # warm columns = finger
    win = max(9, int(1.5 * W / max_tiles)) | 1
    row = darkmax.reshape(1, -1)
    k = np.ones((1, win), np.uint8)
    lo = cv2.erode(row, k).ravel()
    hi = cv2.dilate(row, k).ravel()
    norm = (darkmax - lo) / (hi - lo + 1e-6)                    # 0 at full-white seams
    seam_sig = 1.0 - norm
    seam_sig[skin] = 0.0                                        # no seams inside the finger
    min_dist = max(6, int(0.6 * W / max_tiles))
    # fixed few-px margin, not a W-fraction: a genuine bevel/face-transition seam can
    # sit as close as ~16px from a real row edge (confirmed on t779) -- a percentage
    # margin (previously 0.03*W) swallows that at any W>~500px. The only signal that
    # actually needs excluding is the warp's own boundary column, confirmed on 9
    # other sample hands to sit within 0-3px of x=0/W.
    seams = [s for s in _peaks(seam_sig, min_dist, 0.45) if 5 < s < W - 5]
    if not seams:
        return 1, [], 1.0, 0, W
    gaps = np.diff([0] + seams + [W])
    cv = float(np.std(gaps) / (np.mean(gaps) + 1e-6))
    n_tiles, seams, x0, x1 = _drop_end_side_faces(warp, seams, W, shoulder=shoulder,
                                                   check_first=check_first, check_last=check_last)
    seams = _merge_undersplit_seams(seams, x0, x1)
    n_tiles = len(seams) + 1
    return n_tiles, seams, cv, x0, x1


def _merge_undersplit_seams(seams, x0, x1, small_frac=0.7, combined_tol=0.21):
    """Undo a false seam that split ONE tile into two: if two ADJACENT cells are
    both significantly smaller than a typical cell in this hand, AND their combined
    width is close to typical, merge them (drop the seam between them). Catches a
    tile whose own internal glyph layout creates a spurious white gap strong enough
    to register as a seam -- confirmed on a real frame: a 4s tile's glyphs sit in a
    left-pair/right-pair layout, and the gap between the pairs was detected as an
    inter-tile seam, splitting one 4s tile into two 2s-look-alike halves 25px and
    20px wide (should have been one ~45px cell).

    Uses the MEDIAN cell width, not the mean: the mean is exactly what a bad split
    drags down, biasing "typical width" low and making the merged pair look further
    from "close to typical" than it should -- confirmed on the same frame, mean-based
    would have missed this fix (45 vs a mean of 37.3, outside a 15% band) while
    median-based catches it cleanly (45 vs a median of 40, inside it). Re-checks
    after each merge since undoing one split can occasionally reveal another.

    combined_tol=0.21, not 0.15: a segment-isolated split (see
    _count_hand_segments) can leave a combined width further from the local
    median than the single-row case this was first tuned on -- confirmed on a
    real 2-cluster hand (t1608), a genuine split-tile pair (26px+22px, should
    combine to 48px) sat at a 20% deviation from that cluster's own 40px
    median, just outside the original 15% band. Re-validated at 0.21 against
    the full 20-hand regression set: zero regressions elsewhere, the wider
    band never fires on any of the other already-correct hands.
    Returns the (possibly shorter) seams list."""
    seams = list(seams)
    changed = True
    while changed and len(seams) >= 1:
        changed = False
        bounds = [x0] + seams + [x1]
        widths = [bounds[i + 1] - bounds[i] for i in range(len(bounds) - 1)]
        if len(widths) < 2:
            break
        med = float(np.median(widths))
        if med <= 0:
            break
        for i in range(len(widths) - 1):
            w1, w2 = widths[i], widths[i + 1]
            if w1 < small_frac * med and w2 < small_frac * med and abs((w1 + w2) - med) <= combined_tol * med:
                del seams[i]
                changed = True
                break
    return seams


_HAKU_DARKMAX_THR = 120.0


def _haku_candidate_spans(darkmax, x0, x1, min_span_px):
    """Contiguous [lo,hi) runs within [x0,x1) where darkmax never rises above
    _HAKU_DARKMAX_THR -- a haku (blank, glyph-less) tile has no ink anywhere, so
    even its per-column MAX-darkness stays at background level across its WHOLE
    width, unlike any inked tile (confirmed on two real hands: every real tile's
    max darkmax cleared 230+, even a lightly-inked sou stroke, while confirmed
    haku spans stayed under 85). min_span_px filters out incidental short dips
    (not a real haku, just momentarily low) -- calibrated to the width a genuine
    haku span needs to be worth acting on, NOT full tile width, since a haku can
    be only half-visible between two real neighbours (confirmed: a real haku
    tile's own hidden sub-span was ~40px, but appeared bracketed within a wider,
    already-mis-seamed cell)."""
    below = darkmax < _HAKU_DARKMAX_THR
    spans = []
    i = x0
    while i < x1:
        if below[i]:
            j = i
            while j < x1 and below[j]:
                j += 1
            if j - i >= min_span_px:
                spans.append((i, j))
            i = j
        else:
            i += 1
    return spans


def _haku_boundary_dips(bgr, TL, TR, BR, BL, face_raw, col_lo, col_hi, x0, x1,
                         span_lo, span_hi, pad_frac=0.20, seg_w=10, half_band=2,
                         min_prominence=15.0, prom_win_px=25):
    """Find candidate TRUE tile-boundary x-positions bracketing a haku span, using
    a signal that works even though the span itself has no ink to contrast
    against (unlike _count_seams's darkness-based seam_sig, which can't tell a
    haku tile's interior from a genuine seam -- both read as uniformly white).

    The physical GAP between adjacent tiles still casts a small shadow visible in
    the felt margin just past the tile bottom, even between two tiles with
    identical (blank) face content -- confirmed visually on two real hands. So:
    (1) build a version of the row extended `pad_frac` further past the tile
    bottom (revealing that felt margin, which the normal warp/tall_warp don't
    include -- they're built tight to the tile face); (2) trace an approximate
    tile-bottom path across the padded region by running the SAME per-cell
    std-slope bottom detector (_cell_bottom_via_std_slope) on successive
    `seg_w`-px segments; (3) sample CLAHE-normalized whiteness (min(R,G,B), the
    same discriminator pass2_hands.whitish() uses) ALONG that connecting path
    (not a separate vertical profile per column) -- a small vertical band
    (`half_band` px above/below) is averaged per sample point, not a single
    pixel, to damp per-pixel noise while staying localized enough to still catch
    a several-px-wide notch. Confirmed on two real hands: a genuine tile gap
    produces a sharp, deep LOCAL MINIMUM in this path-sampled signal, clearly
    separated from the shallower wobble elsewhere along the path (including at a
    currently-existing but wrong/noise-driven seam position, which shows no such
    dip) -- REGARDLESS of whether the flanking tiles are inked or also blank.

    Searches a margin of one segment-scan width beyond [span_lo,span_hi) on each
    side so a dip sitting right at the span's own edge (the common case) isn't
    missed by an off-by-one window boundary. Returns a list of candidate x
    positions (local minima clearing `min_prominence` against their immediate
    neighbours), original `warp`/x0-relative coordinates, empty if the padded
    build fails or no confident dip is found.

    `prom_win_px` (the neighbourhood a candidate's prominence is measured
    against, and the minimum spacing between two kept dips) is a FIXED pixel
    scale, deliberately NOT tied to `seg_w` -- confirmed on a real hand: reusing
    `seg_w` for both the polyline's sampling step AND the prominence window
    means a finer seg_w (denser polyline) also narrows the noise-comparison
    window, making the detector MORE sensitive to small wobble and fragmenting
    one real notch into several redundant, lower-confidence candidates
    clustered together instead of cleanly isolating it. `prom_win_px` should
    span a real notch's width plus a margin (a few tile-pitch fractions), not
    shrink with sampling resolution."""
    down_L = (BL - TL) / max(1e-6, np.linalg.norm(BL - TL))
    down_R = (BR - TR) / max(1e-6, np.linalg.norm(BR - TR))
    extra = pad_frac * face_raw
    quad_ext = np.float32([TL, TR, BR + down_R * extra, BL + down_L * extra])
    built = _extent_desk(bgr, quad_ext)
    if built is None:
        return []
    desk_ext, _, _ = built
    tall_ext_region = desk_ext[:, col_lo:col_hi][:, x0:x1]
    Hr_ext = tall_ext_region.shape[0]
    if Hr_ext < 6:
        return []

    scan_lo = max(0, span_lo - x0 - seg_w)
    scan_hi = min(x1 - x0, span_hi - x0 + seg_w)
    if scan_hi - scan_lo < 2 * seg_w:
        return []

    xs, ys = [], []
    x = scan_lo
    while x + seg_w <= scan_hi:
        by = _cell_bottom_via_std_slope(tall_ext_region, x, x + seg_w, Hr_ext, search_frac=0.9)
        xs.append(x + seg_w // 2)
        ys.append(by)
        x += seg_w
    if len(xs) < 3:
        return []

    mn = tall_ext_region.min(axis=2).astype(np.uint8)
    white_clahe = _CLAHE.apply(mn).astype(np.float32)

    path_vals, path_x = [], []
    for k in range(1, len(xs)):
        x0s, y0s, x1s, y1s = xs[k - 1], ys[k - 1], xs[k], ys[k]
        seg_len = float(np.hypot(x1s - x0s, y1s - y0s))
        n_samples = max(2, int(seg_len))
        for t in np.linspace(0, 1, n_samples, endpoint=(k == len(xs) - 1)):
            px = x0s + t * (x1s - x0s)
            py = y0s + t * (y1s - y0s)
            xi = min(max(0, int(round(px))), white_clahe.shape[1] - 1)
            yi = int(round(py))
            y_lo, y_hi = max(0, yi - half_band), min(Hr_ext - 1, yi + half_band)
            path_vals.append(float(white_clahe[y_lo:y_hi + 1, xi].mean()))
            path_x.append(px)
    path_vals = np.array(path_vals)

    dips = []
    for i in range(1, len(path_vals) - 1):
        if path_vals[i] > path_vals[i - 1] or path_vals[i] > path_vals[i + 1]:
            continue
        lo_win = path_vals[max(0, i - prom_win_px):i + 1]
        hi_win = path_vals[i:min(len(path_vals), i + prom_win_px + 1)]
        prominence = min(float(lo_win.max()), float(hi_win.max())) - float(path_vals[i])
        if prominence >= min_prominence:
            dips.append((prominence, int(round(path_x[i] + x0))))
    dips.sort(key=lambda d: -d[0])
    kept = []
    for prom, xpos in dips:
        if all(abs(xpos - k) >= prom_win_px for k in kept):
            kept.append(xpos)
    return sorted(kept)


def _recover_haku_seams(bgr, TL, TR, BR, BL, face_raw, col_lo, col_hi, warp, seams, x0, x1):
    """Correct seams around haku (blank) tiles -- _count_seams's darkness-based
    signal cannot see a haku tile's own boundaries (no ink anywhere to contrast
    against, see _haku_boundary_dips's docstring), so it can silently (a) place a
    seam somewhere ARBITRARY inside a haku-adjacent-haku span (confirmed on a
    real hand: the local erode/dilate normalization it relies on goes numerically
    unstable when nothing nearby has real content to set a dynamic range), or
    (b) miss a haku tile ENTIRELY when it sits between two inked tiles (confirmed
    on a real hand: a ~40px haku hid inside a ~120px undivided span, invisible to
    the darkness signal since the flanking ink dominates that span's own max/min).

    For each haku-candidate span (from _haku_candidate_spans): drop any EXISTING
    seam strictly inside it (untrustworthy by construction -- see (a) above), then
    add seams at ALL confident boundary dips _haku_boundary_dips returns -- NOT
    capped at 2. Confirmed necessary on a real hand (t1518): a haku-adjacent-haku
    pair needed THREE corrected boundaries (entrance, the split between the two
    haku tiles, and exit), not just entrance+exit -- capping at 2 kept only the
    entrance-side dips (both near the same edge, since _haku_boundary_dips's
    return is sorted by x-position, not prominence) and lost the tile count.
    _haku_boundary_dips's own prominence/min-distance filtering is what keeps
    this safe (it only returns dips that already cleared a real confidence bar),
    so there is no separate cap needed here -- skip a dip only if it's within
    min_dist of an already-kept seam. Falls back to leaving a span's seams
    untouched if the dip detector can't build its padded search region or finds
    nothing confident -- conservative by design, since a missed correction is far
    cheaper than a fabricated one. Returns the corrected seams list."""
    H, W = warp.shape[:2]
    band = warp[int(0.10 * H):int(0.90 * H), :]
    gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY).astype(np.float32)
    darkmax = 255.0 - gray.min(axis=0)
    darkmax = np.convolve(darkmax, np.ones(3) / 3, mode="same").astype(np.float32)

    bounds = [x0] + list(seams) + [x1]
    if len(bounds) < 2:
        return seams
    med_width = float(np.median(np.diff(bounds)))
    min_span_px = max(15, int(0.5 * med_width))
    min_dist = max(6, int(0.6 * med_width))

    spans = _haku_candidate_spans(darkmax, x0, x1, min_span_px)
    if not spans:
        return seams

    seams = list(seams)
    for span_lo, span_hi in spans:
        dips = _haku_boundary_dips(bgr, TL, TR, BR, BL, face_raw, col_lo, col_hi, x0, x1, span_lo, span_hi)
        if not dips:
            continue
        seams = [s for s in seams if not (span_lo < s < span_hi)]
        for xpos in dips:
            if all(abs(xpos - s) >= min_dist for s in seams):
                seams.append(xpos)
    return sorted(seams)


def _is_side_face_end(cell, min_ang=15, max_ang=75, min_len_frac=0.3, corner_frac=0.3):
    """True if `cell` is a tile's SIDE face bleeding into the deskewed row —
    not a real tile face. At an oblique enough angle the OUTERMOST tile in the
    row extends past the front-face plane the homography was fit to, so its
    beveled side edge shows up as its own seam-bounded segment.

    COLOUR-AGNOSTIC by design: a broadcast typically shows two different tile
    sets with different edge-trim colours across a match (confirmed — not a
    hypothetical), so no fixed hue (even "per-broadcast, configurable") is
    reliable. Two colour-based attempts were tried and rejected: a fixed
    orange range (fails on any other trim colour), and a colour-agnostic
    "solid non-white/non-felt block with low edge density" structural measure
    (fails too — a bold ink character like chun/中 has similarly low edge
    density to a solid bevel block, and can have MORE non-white/non-felt
    pixels than the bevel itself, since coloured ink also isn't white).

    The signature that actually holds regardless of colour is GEOMETRIC: a
    straight diagonal edge reaching into a corner of the cell, where the bevel
    recedes away from the felt as the outermost tile is seen obliquely (exactly
    what compass_hough-style line detection finds — same technique the compass
    module uses for tray-quad fitting). A real character's ink strokes never
    form one straight line anchored at a corner. Verified on 2 confirmed
    artifacts (Hough finds a qualifying corner-diagonal in both) vs 2 confirmed
    real end tiles (finds none in either) — clean separation, no colour involved.

    Checks all FOUR corners, not just the bottom two: confirmed on a real frame
    that the bevel can show up at a TOP corner instead (the taller top_margin=0.3
    crop used for the final per-tile image -- not just the top-boundary search --
    can reveal a foreshortened top corner a shorter crop never exposed), and a
    bottom-only check was a false negative there."""
    H, W = cell.shape[:2]
    if W < 4 or H < 4:
        return True
    gray = cv2.cvtColor(cell, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 40, 120)
    min_len = max(8, int(min_len_frac * min(H, W)))
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=10, minLineLength=min_len, maxLineGap=6)
    if lines is None:
        return False
    corner_d = corner_frac * min(H, W)
    corners = ((0, 0), (W, 0), (0, H), (W, H))
    for x1, y1, x2, y2 in lines.reshape(-1, 4):
        ang = abs(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
        ang = min(ang, 180 - ang)
        if not (min_ang <= ang <= max_ang):
            continue
        for px, py in ((x1, y1), (x2, y2)):
            if min(np.hypot(px - cx, py - cy) for cx, cy in corners) < corner_d:
                return True
    return False


def _near_edge_onset_frac(cell, thr_frac=0.5):
    """Where (as a fraction, within the cell's BOTTOM HALF only) does the
    V-direction std-across-B/G/R profile first cross into its own elevated range
    and STAY elevated through the very bottom row. A real tile's transition into
    felt starts late (close to 1.0); a cell that's mostly a background/bevel
    gradient starts elevated much earlier (a low value).

    Restricted to the BOTTOM HALF only -- confirmed false positive on a real
    frame: a densely-inked tile (a dark, tightly-packed pin/sou tile) can keep
    this signal elevated for most of its UPPER half too, purely from its own
    glyph's ink density, not from any background gradient -- indistinguishable
    from a genuine artifact if the full height is considered. That ink-driven
    elevation doesn't reliably extend into the bottom half the same way, so
    restricting the search there removes the confound while still catching the
    real pattern (confirmed: the true artifact's early onset is still very
    visible within just the bottom half).

    Returns a fraction in [0,1]; 1.0 means "never elevated" (or too small a cell
    to judge) -- i.e. looks like a normal tile."""
    ch_full, cw = cell.shape[:2]
    if ch_full < 6:
        return 1.0
    y0 = ch_full // 2
    sub = cell[y0:, :, :]
    ch = sub.shape[0]
    if ch < 4:
        return 1.0
    Bv = sub[:, :, 0].astype(np.float32).mean(1)
    Gv = sub[:, :, 1].astype(np.float32).mean(1)
    Rv = sub[:, :, 2].astype(np.float32).mean(1)
    stdv = np.std(np.stack([Bv, Gv, Rv], 0), axis=0)
    k = max(3, int(0.05 * ch)) | 1
    stdv = np.convolve(stdv, np.ones(k) / k, "same")
    lo_v, hi_v = float(stdv.min()), float(stdv.max())
    if hi_v - lo_v < 1e-6:
        return 1.0
    thr = lo_v + thr_frac * (hi_v - lo_v)
    above = stdv > thr
    if not above[-1]:
        return 1.0
    i = ch - 1
    while i > 0 and above[i - 1]:
        i -= 1
    return i / ch


def _is_near_edge_artifact(warp, bounds, idx, gap_thr=0.15):
    """Is the candidate cell (index `idx` into the seam-bounded `bounds`) a
    NEAR-edge side-face artifact -- a DIFFERENT phenomenon from the far-edge
    corner bevel _is_side_face_end targets (see _drop_end_side_faces), confirmed
    on a real frame to show up as a full-height background gradient rather than a
    corner-anchored diagonal wedge, on the camera's NEAR (not far) end.

    Judged RELATIVELY, against the other cells in the SAME hand, not by a fixed
    absolute threshold: what "normal" looks like varies per camera/lighting, the
    same reasoning already used for _merge_undersplit_seams' width comparison.
    Flagged if the candidate's _near_edge_onset_frac is meaningfully EARLIER
    (elevated over more of its bottom half) than the hand's typical cell.
    Requires at least 3 cells total (2 others to compare against)."""
    n = len(bounds) - 1
    if n < 3:
        return False
    onsets = [_near_edge_onset_frac(warp[:, bounds[i]:bounds[i + 1]]) for i in range(n)]
    cand = onsets[idx]
    others = [o for i, o in enumerate(onsets) if i != idx]
    med_other = float(np.median(others))
    return cand < med_other - gap_thr


def _drop_end_side_faces(warp, seams, W, shoulder=None, check_first=None, check_last=None):
    """Check the first and last seam-bounded cell for the side-face artifact
    (_is_side_face_end) and EXCLUDE it from the usable range if found, rather
    than just dropping the inner seam next to it — dropping only the seam
    would merge the artifact's pixels into the neighbouring real tile's cell
    (whichever cell now starts/ends at 0/W absorbs them) instead of cropping
    them out.

    check_first/check_last override the shoulder-derived default for whether
    the geometric _is_side_face_end check runs on that end at all — needed by
    the multi-segment path (_count_hand_segments): a hand split into two
    physical clusters is seam-counted per-cluster, and a cluster's GAP-facing
    edge (an artificial cut, not the row's true near/far end) should still get
    the full geometric check regardless of `shoulder` (it's just as likely to
    slice through real tile content as any other cut), while the row's true
    FAR end must keep being exempted (see below) even when it happens to be a
    segment's own first/last cell. None (the default) reproduces the old
    shoulder-only behaviour exactly.

    An end cell far NARROWER than the row's other cells is also dropped, even
    if _is_side_face_end finds no qualifying line: confirmed on a real frame,
    a near-blank bevel-only sliver (17px vs a ~40px typical width here) has too
    little structure for Canny/Hough to find any line at all, so the geometric
    check alone was a false negative -- width is an independent, cheap signal
    that catches what the geometric check misses (same "far below the row's
    median" reasoning as _merge_undersplit_seams, just applied to an END cell
    instead of an adjacent pair). This width check runs on BOTH ends regardless
    of shoulder -- an implausibly narrow end sliver is suspicious either way.

    _is_side_face_end, by contrast, IS shoulder-gated (user correction,
    confirmed on a real frame: t1503, seat W/shoulder=left): the visible-bevel
    geometry it looks for is a NEAR-camera phenomenon -- the end of the row
    physically closest to the camera is viewed obliquely enough to show a
    corner-anchored diagonal side face; the far end is viewed closer to
    end-on and doesn't show this. So it only runs on the NEAR-camera cell
    (leftmost for shoulder="left", rightmost for shoulder="right" -- see
    `near_idx` below) -- checking the FAR cell too (the old, unconditional
    behaviour) produced a confirmed false positive on t1503: a complete, plain
    pin tile at the far/right end got misread as a side-face bevel and
    wrongly excluded. shoulder=None (camera side unknown, e.g. the ROI-
    fallback path) falls back to checking BOTH ends, same as the old
    behaviour, since there's no near/far distinction to gate on.

    When `shoulder` is given, the NEAR-camera cell ALSO gets the
    _is_near_edge_artifact check -- a geometrically different artifact from
    the corner bevel, confirmed on a real frame to need its own,
    hand-relative signal.

    Returns (n_tiles, seams, x0, x1); any per-tile cell must be sliced from
    warp[:, x0:x1], not warp[:, 0:W]."""
    if not seams:
        return 1, seams, 0, W
    bounds = [0] + seams + [W]
    widths = [bounds[i + 1] - bounds[i] for i in range(len(bounds) - 1)]
    med = float(np.median(widths)) if len(widths) > 1 else 0.0
    n = len(widths)
    near_idx = (n - 1) if shoulder == "right" else (0 if shoulder == "left" else None)
    x0, x1 = 0, W
    check_side_first = check_first if check_first is not None else (shoulder is None or near_idx == 0)
    drop_first = (check_side_first and _is_side_face_end(warp[:, bounds[0]:bounds[1]])) or (med > 0 and widths[0] < 0.5 * med)
    if not drop_first and near_idx == 0:
        drop_first = _is_near_edge_artifact(warp, bounds, 0)
    if drop_first:
        x0 = bounds[1]
        seams = seams[1:]
    if seams:
        check_side_last = check_last if check_last is not None else (shoulder is None or near_idx == n - 1)
        drop_last = (check_side_last and _is_side_face_end(warp[:, bounds[-2]:bounds[-1]])) or (med > 0 and widths[-1] < 0.5 * med)
        if not drop_last and near_idx == n - 1:
            drop_last = _is_near_edge_artifact(warp, bounds, n - 1)
        if drop_last:
            x1 = bounds[-2]
            seams = seams[:-1]
    return len(seams) + 1, seams, x0, x1


def _cell_bottom_via_std_slope(bgr, cx0, cx1, Hr, search_frac=0.65, smooth_k=3, d1_smooth_k=5):
    """Per-cell BOTTOM boundary via the cell's OWN centroid-column std-across-B/G/R
    profile (replaces a strip-wide Hough line, which failed outright on several real
    frames: the felt/tile boundary is slightly jagged -- each tile sits at a hair
    different height -- so no single straight segment was ever long enough to satisfy
    Hough's minLineLength, and `best_lower` came back None, silently leaving the full
    felt-including cell height uncropped).

    A tile face -- white background plus ink, whatever the glyph -- is near-GRAYSCALE
    (B~G~R, low std across channels); the felt beneath it is strongly blue (high std).
    So the tile-to-felt transition shows up as a RISE in this signal, and its
    steepest point -- the peak of the first derivative -- is the boundary (sharper
    and less threshold-dependent than a plateau/crossing search). Confirmed on a real
    13-cell hand: the peak lands right at the visible ink-to-felt edge in every cell
    where that edge is visible.

    Only the bottom `search_frac` of the cell is searched: wide enough that a
    shorter-than-average tile's boundary (which can sit higher than a strict
    bottom-half window) still falls inside the window, but this does NOT fully
    exclude colored ink -- KNOWN LIMITATION, confirmed on a real 13-cell hand: any
    tile with a red sub-character (e.g. a number tile's suit character, drawn in
    red below a black number) can have its black-to-red ink transition register a
    steeper std rise than the true ink-to-felt edge further down, so the peak
    locks onto the wrong (internal) transition -- red ink, like felt, is far from
    color-neutral, and this function has no way yet to tell "red ink edge" apart
    from "blue felt edge" (a per-channel check -- felt is B-dominant, ink is
    R-dominant -- would fix it but isn't implemented). This is WHY cell_crops
    treats a too-small combined (ty, by) span as THIS boundary being the
    unreliable one and falls back on it alone, rather than resetting both:
    _cell_top_via_band_d2 has shown no equivalent failure mode in the same data.
    Returns a y in [0, Hr]; returns Hr (no crop) in degenerate cases."""
    cw = cx1 - cx0
    if cw < 4 or Hr < 6:
        return Hr
    xc = (cx0 + cx1) // 2
    band_w = max(1, int(0.15 * cw))
    lo_c, hi_c = max(cx0, xc - band_w), min(cx1, xc + band_w + 1)
    search_y0 = int((1 - search_frac) * Hr)
    band = bgr[search_y0:Hr, lo_c:hi_c]
    if band.shape[0] < 6:
        return Hr
    Bc = band[:, :, 0].astype(np.float32).mean(1)
    Gc = band[:, :, 1].astype(np.float32).mean(1)
    Rc = band[:, :, 2].astype(np.float32).mean(1)
    chan_std = np.std(np.stack([Bc, Gc, Rc], 0), axis=0)
    sm = np.convolve(chan_std, np.ones(smooth_k) / smooth_k, "same") if smooth_k > 1 else chan_std
    d1 = np.gradient(sm)
    d1 = np.convolve(d1, np.ones(d1_smooth_k) / d1_smooth_k, "same")
    peak = int(np.argmax(d1))
    return search_y0 + peak


_CLAHE = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))


def _cell_top_via_band_d2(gray, cx0, cx1, Hr, thr_frac=0.5, smooth_k=3, d1_smooth_k=7):
    """Per-cell TOP boundary via the cell's OWN centroid-column brightness profile
    (replaces sampling a single strip-wide Hough line at this cell's x -- a real
    boundary line isn't always present in the Hough output, and Hough treats an
    occluded cell as an unrelated outlier; see conversation history).

    `gray` must already be CLAHE-normalized (see cell_crops, which builds it via
    _CLAHE.apply once per row rather than per-cell) -- CLAHE is for THIS search
    only, never for the actual cropped pixels returned to the caller (cell_crops
    slices the ORIGINAL, non-CLAHE tall_warp with the y this function returns).
    Confirmed necessary on a real frame (t1518, seat N, a sou tile with two rows
    of bamboo sticks): without CLAHE, the coarse anchor below sometimes lands
    inside a secondary brightness wiggle the glyph's own row-to-row gap creates,
    and the walk-up (also below) then finds ITS local d2 minimum first and stops
    immediately, without ever reaching the real plateau-to-glyph transition
    (confirmed: start_y and the returned y were IDENTICAL, i.e. zero movement).
    CLAHE's local contrast normalization suppresses that secondary wiggle
    relative to the real transition, fixing the anchor without changing the
    search logic itself.

    Only the TOP HALF of the cell is searched: most number tiles show a top
    symbol then a gap then a red character below, and the character's ink breaks
    a naive brightest-run search across the full height -- restricting to the top
    half keeps the search on the part that actually has a clean plateau-then-edge
    shape. Within that: (1) find the above-threshold ("whitest") run with the
    GREATEST AREA over threshold as a coarse anchor -- same area-over-threshold
    scoring _peaks() uses elsewhere in this file, and for the same reason: the
    WIDEST run isn't necessarily the real plateau. Confirmed on a real frame (a
    pin/dot tile, cell 7): a low, wide run near the bottom of the search window
    won on width alone while a taller, narrower run sitting right at the true
    top-of-tile plateau lost, dragging the chosen anchor down into the tile
    face and producing a wildly shallow crop (17 vs neighbouring cells' 38-48).
    Area-over-threshold weighs height as well as width, so a short/wide false
    run doesn't beat a tall/narrow real one. Its bottom edge is typically still
    short of the true corner, cut off wherever the profile first dips (often
    well before any real edge); (2) starting there, walk UPWARD until the
    heavily-smoothed SECOND derivative hits its first local minimum -- the
    corner where the flat bright plateau rolls into the transition, sharper
    than a threshold crossing and much less noise-sensitive than a raw
    first-derivative gradient peak. Confirmed on a finger-occluded cell to
    land in the same narrow band as its unoccluded neighbours, where every
    other method tried (Hough line, global d2 argmax, first-derivative
    gradient) treated it as a wild outlier.

    Returns a y in [0, Hr//2); falls back to 0 (no crop) in degenerate cases."""
    cw = cx1 - cx0
    if cw < 4:
        return 0
    xc = (cx0 + cx1) // 2
    band_w = max(1, int(0.15 * cw))
    lo_c, hi_c = max(cx0, xc - band_w), min(cx1, xc + band_w + 1)
    top_half = Hr // 2
    if top_half < 6:
        return 0
    profile = gray[:top_half, lo_c:hi_c].mean(axis=1)

    sm = np.convolve(profile, np.ones(smooth_k) / smooth_k, "same") if smooth_k > 1 else profile
    lo_v, hi_v = float(sm.min()), float(sm.max())
    thr = lo_v + thr_frac * (hi_v - lo_v)
    above = sm > thr
    runs, i = [], 0
    while i < len(above):
        if above[i]:
            j = i
            while j < len(above) and above[j]:
                j += 1
            runs.append((i, j))
            i = j
        else:
            i += 1
    if not runs:
        return 0
    start_y = max(runs, key=lambda r: float((sm[r[0]:r[1]] - thr).sum()))[1]

    d1 = np.gradient(sm)
    d1 = np.convolve(d1, np.ones(d1_smooth_k) / d1_smooth_k, "same")
    d2 = np.gradient(d1)
    y = min(start_y, len(d2) - 2)                   # keep y+1 in bounds (start_y may reach top_half)
    while y > 0:
        if d2[y] <= d2[y - 1] and d2[y] <= d2[y + 1]:
            return y
        y -= 1
    return 0


def cell_crops(warp, seams, x0, x1, tall_warp=None, tall_offset=0):
    """Split a deskewed hand strip into individual per-tile crops: each cell's TOP
    comes from _cell_top_via_band_d2 (per-cell brightness-band + second-derivative
    corner, robust to occlusion), its BOTTOM from _cell_bottom_via_std_slope
    (per-cell std-across-channels slope peak, robust to the felt/tile boundary being
    slightly jagged rather than one straight line -- see its docstring). seams/x0/x1
    are exactly _count_seams's return (original `warp` coordinates, end-artifact
    seams already excluded) -- call this on the SAME warp passed to _count_seams,
    not a pre-sliced one.

    No far-edge X-direction trim is applied (removed: on pin/dot tiles the
    std-across-channels signal it relied on is too weak and noisy to reliably find
    the felt/face boundary -- confirmed on t873/t891, where it cut into the tile's
    own dot pattern instead of the felt margin beyond it. The row's far-from-camera
    end cell may therefore still include some felt/background overshoot;
    _drop_end_side_faces already excludes cells that are ARTIFACTS in their own
    right, this only affects genuine end tiles seen at a steep angle).

    tall_warp/tall_offset: an optional TALLER version of `warp` -- same columns,
    built from a bigger-top_margin quad via _extent_desk sliced to `warp`'s own
    (x0,x1) via _product_extent_strip's returned column bounds -- used ONLY for the
    top-boundary search and the actual crop, since a tile's true top edge can sit
    above what a tightly (top_margin=0) fit quad captured, and re-deciding left/right
    extent on a padded quad isn't safe (see _product_extent_strip). `tall_offset` is
    how many extra rows `tall_warp` has prepended above `warp`'s row 0 (both share
    the same BOTTOM anchor). Omit to search/crop within `warp` itself. Returns a
    list of BGR crops, left to right."""
    if tall_warp is None:
        tall_warp, tall_offset = warp, 0
    H, W = warp.shape[:2]
    bounds = [x0] + list(seams) + [x1]
    tall_region = tall_warp[:, x0:x1]
    Hr_tall = tall_region.shape[0]
    # CLAHE for the top-boundary SEARCH only (see _cell_top_via_band_d2's docstring) --
    # the actual crop below still slices tall_warp, never this CLAHE'd version.
    gray_tall = _CLAHE.apply(cv2.cvtColor(tall_region, cv2.COLOR_BGR2GRAY)).astype(np.float32)
    cells = []
    n = len(bounds) - 1
    for i in range(n):
        cx0, cx1 = bounds[i], bounds[i + 1]
        rcx0, rcx1 = cx0 - x0, cx1 - x0
        ty = max(0, _cell_top_via_band_d2(gray_tall, rcx0, rcx1, Hr_tall))
        by = min(Hr_tall, _cell_bottom_via_std_slope(tall_region, rcx0, rcx1, Hr_tall))
        if by - ty < 0.5 * Hr_tall:              # implausible fit -> the BOTTOM boundary is the
            by = Hr_tall                         # unreliable one (see _cell_bottom_via_std_slope's
                                                  # docstring); don't discard an independently-good top
        cell = tall_warp[ty:by, cx0:cx1]
        cells.append(cell)
    return cells


import tiles

# ---- ORB candidate selection + bounded extent-extension --------------------

def _skin_mask(bgr, open_k=9):
    """Skin-toned (R-B>30, the same test _count_seams/_far_edge_overshoot use)
    pixels, OPENED (erode-then-dilate) first. Applied to a WHOLE frame -- unlike
    those two other uses, which are scoped inside an already-known row/cell where
    "reddish" reliably means finger -- raw R-B>30 also fires on thin red-ink tile
    glyphs and header/logo/scoreboard text, not just skin. Confirmed on a real
    frame (t682): zeroing those THIN strokes out of the candidate mask fragmented
    a real row and caused a regression. A hand/finger is a wide, solid blob (tens
    of px across); ink strokes and small text are only a few px wide, so opening
    erases the thin false positives while preserving genuine skin blobs at their
    original extent."""
    b, g, r = bgr[:, :, 0].astype(np.float32), bgr[:, :, 1], bgr[:, :, 2].astype(np.float32)
    skin = ((r - b) > 30).astype(np.uint8) * 255
    return cv2.morphologyEx(skin, cv2.MORPH_OPEN, np.ones((open_k, open_k), np.uint8)) > 0


def _row_candidates(bgr, min_long_frac=0.15):
    """All row-shaped white blobs (not just select_haipai's single pick), as
    (component_mask, x, y, w, h, area). Skin-toned pixels (a hand/finger reaching
    over the row) are excluded from the mask BEFORE row-bridging/connected-
    components -- confirmed on a real frame (t1503): without this, a hand fused
    with the real row into one blobby, non-row-shaped candidate (only 14.9% of
    its own pixels fell inside its fitted quad; minAreaRect aspect 2.42:1 vs a
    real row's ~9-10:1) that lost to the wall on score."""
    m = P.whitish(bgr)
    m[P.tile_edges(bgr) > 0] = 0
    m[_skin_mask(bgr)] = 0
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


def _merge_collinear_candidates(bgr, cands, max_ang_diff=5.0, max_perp_dist=10.0, max_gap=30.0):
    """Merge row candidates that are fragments of the SAME physical row, split
    apart because the gap between them exceeded _row_candidates' 25px horizontal
    bridging kernel -- confirmed on a real frame (t1596): a player visibly
    arranging/spacing out their tiles (not tightly packed like a normal
    concealed hand) fractured the row into pieces too far apart to bridge,
    and every fragment individually scored 0 in select_hand_quad (too short to
    carry enough recognizable content on its own), so the whole hand was lost
    to a `None` read even though real, legible tile content (pin tiles, 東,
    南 honors) was sitting right there.

    Two candidates are judged the SAME row by COLLINEARITY of their LEFT/RIGHT
    edge centroids (the midpoint of each quad's TL-BL and TR-BR edges), not
    just proximity: order the pair left-to-right by centroid x, then check (1)
    the row-axis angle through each candidate's own two edge-centroids agrees
    within `max_ang_diff`, (2) the right candidate's LEFT edge-centroid lies
    close (within `max_perp_dist`) to the LINE through the left candidate's own
    axis -- not just close in raw distance, since every row-shaped blob in one
    frame tends to share roughly the camera's skew angle, so angle agreement
    alone is a weak filter (confirmed: candidates from clearly different
    physical rows on the same t1596 frame matched angle within ~2 degrees but
    sat 140-175px perpendicular off any shared line), and (3) the facing-edge
    gap is small (within `max_gap`). Validated on the real 2-fragment case:
    the genuine pair scored ang_diff=1.2deg, perp_dist=2.3px, gap=17.7px --
    every other of the 9 other pairs on that frame failed perp_dist by 15px+.
    Validated on the full 20-hand regression set: zero regressions (no false
    merge fires on any already-correct hand), one fix (t1596: None -> a real
    partial read).

    Chains transitively via union-find (three-or-more collinear fragments all
    merge into one), and unions the matched candidates' MASKS (not just their
    bounding boxes) so the merged component's own convex-hull/axis fit (in
    _quad_from_comp) naturally spans the real gap between fragments, the same
    way a single unfragmented row's hull always has. Returns a new candidate
    list; non-merged candidates pass through unchanged."""
    n = len(cands)
    if n < 2:
        return cands
    quads = [_quad_from_comp(bgr, comp, 13) for comp, *_ in cands]

    def edge_centroids(q):
        TL, TR, BR, BL = q
        return (TL + BL) / 2, (TR + BR) / 2

    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        pi, pj = find(i), find(j)
        if pi != pj:
            parent[pi] = pj

    for i, j in itertools.combinations(range(n), 2):
        li, ri = edge_centroids(quads[i])
        lj, rj = edge_centroids(quads[j])
        ci, cj = (li + ri) / 2, (lj + rj) / 2
        if ci[0] <= cj[0]:
            a_left, b_left, a_right, b_right = li, ri, lj, rj
        else:
            a_left, b_left, a_right, b_right = lj, rj, li, ri
        u = (b_left - a_left) / (np.linalg.norm(b_left - a_left) + 1e-9)          # left cand's own axis
        u2 = (b_right - a_right) / (np.linalg.norm(b_right - a_right) + 1e-9)     # right cand's own axis
        ang_left = np.degrees(np.arctan2(u[1], u[0]))
        ang_right = np.degrees(np.arctan2(u2[1], u2[0]))
        ang_diff = abs(((ang_left - ang_right) + 90) % 180 - 90)
        if ang_diff > max_ang_diff:
            continue
        w = a_right - a_left
        perp = np.linalg.norm(w - np.dot(w, u) * u)          # right cand's near edge vs left cand's axis LINE
        if perp > max_perp_dist:
            continue
        gap = np.linalg.norm(a_right - b_left)                # facing-edge gap
        if gap > max_gap:
            continue
        union(i, j)

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    out = []
    for members in groups.values():
        if len(members) == 1:
            out.append(cands[members[0]])
            continue
        mask = np.zeros_like(cands[members[0]][0])
        for m in members:
            mask = cv2.bitwise_or(mask, cands[m][0])
        ys, xs = np.where(mask > 0)
        x, y, w, h = int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)
        a = int((mask > 0).sum())
        out.append((mask, x, y, w, h, a))
    return out


def _quad_from_comp(bgr, comp, n_tiles=13, top_margin=0.10):
    """Front-face quad (TL,TR,BR,BL) from a given row component — the row_quad recipe
    applied to a specific blob (axis from the furthest hull pair, Hough skew, face band).

    top_margin adds a fixed 10% of headroom above the FACE_ASPECT*pitch estimate
    before it's subtracted from the bottom extent (dy) to get the top edge.
    Without it, a pitch estimate that's even slightly short (e.g. a camera angle
    where L/n_tiles underestimates the true per-tile width) clips the TOP of the
    character. A content-adaptive version (large safety margin + trim back down
    by row colour) was tried and REVERTED: it regressed two different real hand
    strips (one still clipped, one newly clipped) — worse than this simple fixed
    padding, which is not perfect either but doesn't actively regress. Bottom
    stays anchored at dy (unaffected; only the top was ever observed to
    under-reach)."""
    pts = cv2.findNonZero(comp).reshape(-1, 2).astype(float)
    hull = cv2.convexHull(pts.astype(np.float32)).reshape(-1, 2).astype(float)
    d2 = ((hull[:, None] - hull[None]) ** 2).sum(-1)
    i, j = np.unravel_index(int(np.argmax(d2)), d2.shape)
    a, b = hull[i], hull[j]
    if a[0] > b[0]:
        a, b = b, a
    mid, L = (a + b) / 2, float(np.hypot(*(b - a)))
    xs, ys = pts[:, 0], pts[:, 1]
    pad = 20
    bbox = (max(0, int(xs.min() - pad)), max(0, int(ys.min() - pad)),
            min(bgr.shape[1], int(xs.max() + pad)), min(bgr.shape[0], int(ys.max() + pad)))
    ang = P._hough_angle(bgr, bbox)
    if ang is None:
        ang = np.degrees(np.arctan2(b[1] - a[1], b[0] - a[0]))
    th = np.radians(ang)
    u = np.array([np.cos(th), np.sin(th)])
    a2, b2 = mid - (L / 2) * u, mid + (L / 2) * u
    slope = np.tan(th)
    dy = float((ys - (a2[1] + slope * (xs - a2[0]))).max())
    face = P.FACE_ASPECT * (L / n_tiles) * (1.0 + top_margin)
    top, bot = np.array([0.0, dy - face]), np.array([0.0, dy])
    return np.float32([a2 + top, b2 + top, b2 + bot, a2 + bot])


def _pad_quad(quad, frac=0.7, n_tiles=13):
    """Extend a quad's two ENDS along the row axis by frac of a tile pitch, so a
    shadowed end tile the blob under-reached has room to be captured; the felt this
    over-includes is then trimmed by _trim_to_tiles."""
    TL, TR, BR, BL = quad
    axis = TR - TL
    L = float(np.hypot(*axis)) + 1e-6
    u = axis / L
    d = frac * L / n_tiles * u
    return np.float32([TL - d, TR + d, BR + d, BL - d])


def _trim_to_tiles(warp):
    """Trim leading/trailing FELT columns while KEEPING shadowed tiles. Brightness
    can't separate a shadowed tile from lit felt, but STRUCTURE can: a tile column has
    symbol strokes (high vertical variance) even when shadowed, whereas felt is
    uniform (low variance). Smoothed over ~a tile width, the tile RUN reads high-
    activity and the felt ends read low; trim the ends below a relative threshold."""
    H, W = warp.shape[:2]
    gray = cv2.cvtColor(warp, cv2.COLOR_BGR2GRAY).astype(np.float32)[int(0.12 * H):int(0.88 * H), :]
    std = gray.std(axis=0)                                       # per-column vertical structure
    k = max(3, int(0.045 * W)) | 1                              # ~half a tile
    act = np.convolve(std, np.ones(k) / k, mode="same")
    tile_level = float(np.median(np.sort(act)[-max(1, W // 2):]))
    thr = 0.4 * tile_level
    lo, hi = 0, W - 1
    while lo < hi and act[lo] < thr:
        lo += 1
    while hi > lo and act[hi] < thr:
        hi -= 1
    return warp[:, lo:hi + 1] if (hi - lo) > 0.3 * W else warp


_OVERLAY_KEYS = ("round", "honba", "sticks", "dora", "jp_names", "scores",
                 "romaji", "dealer_line", "riichi")


def _overlay_rects(cfg, Wf, Hf):
    """Fixed broadcast-overlay boxes (round/score/dora/riichi graphics -- same
    screen position regardless of camera angle), scaled from cfg's reference
    frame to this frame's actual size. Each as (x0,y0,x1,y1)."""
    rects = []
    for k in _OVERLAY_KEYS:
        x, y, w, h = P0.scale_region(cfg["regions"][k], Wf, Hf, cfg["ref_width"], cfg["ref_height"])
        rects.append((x, y, x + w, y + h))
    return rects


def _rects_overlap(a, b):
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1


def _best_run_sum(scores, run_floor):
    """Longest-then-strongest contiguous run of cells each clearing `run_floor` raw
    ORB inliers. `None` entries (overlay-excluded cells) are skipped WITHOUT
    breaking the run, so an overlay graphic sitting mid-row doesn't fragment an
    otherwise-solid candidate. Returns (run_length, run_sum) of the best run found
    (by sum, not length -- see select_hand_quad for why sum is the right key)."""
    best_len, best_sum = 0, 0
    cur_len, cur_sum = 0, 0
    for s in scores:
        if s is None:
            continue
        if s >= run_floor:
            cur_len += 1
            cur_sum += s
        else:
            if cur_sum > best_sum:
                best_len, best_sum = cur_len, cur_sum
            cur_len, cur_sum = 0, 0
    if cur_sum > best_sum:
        best_len, best_sum = cur_len, cur_sum
    return best_len, best_sum


def select_hand_quad(bgr, lib_orb, n_tiles=13, cfg=None, min_inliers=6,
                      run_floor=3, min_run_len=3, min_run_sum=15):
    """Pick WHICH region is the near hand, by CONTENT: score each row candidate by ORB
    inliers vs the tile library (walls/backs/arm/PiP/logo/river don't match tile faces,
    so they lose) and return the winning component's front-face quad. Content-based,
    replaces the geometric near_hand_roi.

    Always uses _quad_from_comp's default top_margin (0.10) for candidate scoring --
    NOT configurable here, on purpose: the scoring warp is built by mapping each
    candidate's proposed quad onto a fixed Wd x Hd box, so top_margin changes what
    content lands in that box and can flip WHICH candidate wins, not just how the
    winner is cropped (confirmed: top_margin=0 here picked an entirely different,
    wrong row on a real frame). count_hand derives a top_margin=0 (and, separately,
    a top_margin=0.3) quad ALGEBRAICALLY from this function's already-selected
    winner instead of re-running selection at a different margin.

    Scoring is BEST-CONTIGUOUS-RUN-SUM, not gated total sum (the latter was tried
    first and replaced -- see below). Two guards, both confirmed necessary on real
    WIDE (full-table, not close-up) frames: (1) per-cell `run_floor` -- classify_orb
    returns the raw RANSAC inlier count even for sub-threshold matches, so summing
    it unconditionally lets a long candidate with MANY weak, individually-
    meaningless matches (confirmed: the WALL, tile backs turned away) out-
    accumulate a short but genuinely-recognized real hand; only cells clearing
    `run_floor` extend a run. (2) OVERLAY-region exclusion -- a cell whose footprint
    (mapped back through the candidate's own inverse perspective transform)
    overlaps a fixed broadcast-overlay box (cfg["regions"], e.g. the dora graphic)
    is excluded from scoring entirely (skipped without breaking a run), since
    overlay graphics can genuinely ORB-match a tile template. cfg=None skips this
    guard (used when no broadcast config is available).

    Why best-run-SUM instead of a flat per-cell `min_inliers` gate summed across
    the whole candidate (the original approach): a hard per-cell floor (e.g. >=6)
    rejects a real hand row whose individual cells are all in the 3-5 range (a
    lower-resolution/blurrier camera angle can genuinely never clear 6 anywhere,
    confirmed on a real frame) while a SINGLE spurious high-confidence match on a
    non-hand region (a blurry table edge, confirmed 12 inliers on one cell) then
    wins outright since it's the only nonzero total. Summing ALL cells >= a low
    floor (no run/contiguity requirement) reintroduces the wall-accumulation
    problem (1) was meant to fix. The best-run-sum compromise rewards BROAD,
    CONTIGUOUS, only-moderately-confident support (a real row) over an isolated
    spike (noise), while tolerating trailing felt/padding cells a loosely-bound
    candidate box includes beyond the real tiles (confirmed: an otherwise-correct
    candidate's box overran the row by ~4 empty cells; a whole-candidate median/
    mean was tried and rejected it -- too easily dragged down by that padding).
    `min_run_len`/`min_run_sum` are the absolute floor on the WINNING candidate's
    best run for a non-None return; both were tuned against a real broadcast-
    overlay graphic (a scoreboard) that produced a short run of weak matches
    (len 4, sum 13) sitting just below genuine hands' weakest confirmed run
    (len 3, sum 15) -- min_run_sum is what actually separates them, min_run_len
    alone does not (the false positive and a genuine partial hand shared len 4).
    Validated across the full 20-hand regression set (10 original + 10 new-range):
    zero regressions relative to the prior gated-sum scoring, plus 3 confirmed
    fixes (two frames that wrongly returned None, one that picked the wrong
    candidate) and the scoreboard false positive correctly still rejected.
    Returns the quad (TL,TR,BR,BL) or None (best run too short/weak to trust)."""
    Hf, Wf = bgr.shape[:2]
    overlay_rects = _overlay_rects(cfg, Wf, Hf) if cfg is not None else []
    best_quad, best_len, best_sum = None, 0, -1
    for comp, x, y, w, h, a in _merge_collinear_candidates(bgr, _row_candidates(bgr)):
        try:
            quad = _quad_from_comp(bgr, comp, n_tiles)
            L = float(np.hypot(*(quad[1] - quad[0])))
            Wd, Hd = max(1, int(round(L))), P.CELL_H
            dst = np.float32([[0, 0], [Wd, 0], [Wd, Hd], [0, Hd]])
            Mfwd = cv2.getPerspectiveTransform(quad, dst)
            warp = cv2.warpPerspective(bgr, Mfwd, (Wd, Hd))
            n_cells = max(1, warp.shape[1] // 44)
            Minv = np.linalg.inv(Mfwd) if overlay_rects else None
            scores = []
            for c in range(n_cells):
                if overlay_rects:
                    corners_dst = np.float32([[c * 44, 0], [(c + 1) * 44, 0],
                                               [(c + 1) * 44, Hd], [c * 44, Hd]]).reshape(-1, 1, 2)
                    corners_src = cv2.perspectiveTransform(corners_dst, Minv).reshape(-1, 2)
                    cell_rect = (*corners_src.min(0), *corners_src.max(0))
                    if any(_rects_overlap(cell_rect, orect) for orect in overlay_rects):
                        scores.append(None)
                        continue
                scores.append(tiles.classify_orb(warp[:, c * 44:(c + 1) * 44], lib_orb, min_inliers=min_inliers)[1])
            run_len, run_sum = _best_run_sum(scores, run_floor)
            if run_sum > best_sum:
                best_quad, best_len, best_sum = quad, run_len, run_sum
        except Exception:
            continue
    return best_quad if (best_len >= min_run_len and best_sum >= min_run_sum) else None


def _content_row_band(gray, H):
    """Find the vertical [y0,y1) row-band that actually contains character/tile
    structure, ADAPTIVELY -- not a fixed fraction of H. A fixed top/bottom fraction
    is fragile: H (== the quad's Hface) is itself a pitch-based ESTIMATE, and how
    much blank felt/padding margin surrounds the true content varies with that
    estimate's error and with top_margin -- confirmed on two different real frames,
    the fixed-fraction version put two DIFFERENT quads (differing only in
    top_margin, or just differing per-frame at the SAME margin) onto different
    slices of content, silently changing the extent decision by tens of pixels.
    Row-wise column-variation (std across columns) is high where
    character strokes create edges and low over blank felt/padding -- the same
    activity-vs-uniformity signal _trim_to_tiles already uses column-wise, applied
    row-wise here -- so thresholding it adapts to wherever the content actually
    sits, regardless of how much blank margin surrounds it. Falls back to the old
    fixed 15%-85% fraction if the signal is too degenerate to trust (e.g. a
    near-blank strip)."""
    row_act = gray.std(axis=1)
    k = max(3, int(0.05 * H)) | 1
    row_act_s = np.convolve(row_act, np.ones(k) / k, mode="same")
    thr = 0.35 * float(row_act_s.max())
    idx = np.where(row_act_s > thr)[0]
    if idx.size < 4:
        return int(0.15 * H), int(0.85 * H)
    y0, y1 = int(idx.min()), int(idx.max()) + 1
    if y1 - y0 < 0.3 * H:                     # degenerate -> fall back to the old fixed fraction
        return int(0.15 * H), int(0.85 * H)
    return y0, y1


def _extent_desk(bgr, quad):
    """Warp `bgr` to a full-frame-width deskewed strip along quad's row axis, at
    quad's own Hface (|BL-TL|). The column mapping (row-axis u, frame-width
    extension smin/smax/Wr) depends only on TL[0]/TR[0]/BL[0] -- and top_margin
    NEVER changes a quad's X coordinates, only TL/TR's Y (see _quad_from_comp) --
    so two quads differing only in top_margin produce a desk with an IDENTICAL
    column-to-frame mapping (same Wr, same physical position per column). This is
    what lets count_hand slice a SECOND, taller desk (a bigger top_margin, built
    purely for the top-boundary search) with the exact column bounds a first,
    unpadded desk's extent decision already chose -- see _product_extent_strip's
    returned (col_lo, col_hi). Returns (desk, Wr, Hr) or None."""
    Hf, Wf = bgr.shape[:2]
    TL, TR, BR, BL = quad.astype(float)
    u = (TR - TL) / (np.linalg.norm(TR - TL) + 1e-9)
    if abs(u[0]) < 1e-3:
        return None
    Hface = np.linalg.norm(BL - TL)
    scc = [(0 - TL[0]) / u[0], (Wf - TL[0]) / u[0], (0 - BL[0]) / u[0], (Wf - BL[0]) / u[0]]
    smin, smax = min(scc), max(scc)
    ext = np.float32([TL + smin * u, TL + smax * u, BL + smax * u, BL + smin * u])
    Wr, Hr = int(smax - smin), int(round(Hface))
    if Wr < 60 or Hr < 12:
        return None
    Hmat = cv2.getPerspectiveTransform(ext, np.float32([[0, 0], [Wr, 0], [Wr, Hr], [0, Hr]]))
    desk = cv2.warpPerspective(bgr, Hmat, (Wr, Hr))
    return desk, Wr, Hr


def _product_extent_strip(bgr, quad):
    """Deskew the ORB hand quad EXTENDED to the full frame width along its row axis,
    then crop to the true tile extent by finding the WIDEST low-color-saturation
    valley in the per-column std-across-B/G/R signal.

    Why std-across-channels, not whiteness x vertical-density (the previous
    approach): a tile face -- white background plus dark ink, whatever the glyph --
    is inherently near-GRAYSCALE (B~G~R), while everything that needs excluding is
    comparatively colorful: blue felt, wood-grain wall, a broadcast overlay
    graphic, and (usefully, with no separate skin-detection needed) a skin-toned
    finger. So real tile content sits in a single wide, naturally low-std VALLEY,
    and Otsu's method on that 1D signal cleanly separates it from the high-std
    background on both sides -- confirmed on two real frames where the previous
    (periodicity/autocorrelation-based) approach was fragile: one where a
    sparse-glyph tile (a bare "一" stroke) scored too weak to pass a darkness
    threshold, one where a man-to-pin tile-type transition broke a "regular
    spacing" check -- both cases the std-valley recovers correctly in one pass,
    with no periodicity assumption at all.
    Known misses: an occluded end tile is unrecoverable from that single frame
    (-> consensus across frames).

    `quad` should be an UNPADDED (top_margin=0) quad -- a taller quad shifts
    _content_row_band's row-sampling in ways that can perturb this decision too.
    Returns (strip, col_lo, col_hi): the extent-cropped deskewed strip (tile faces,
    height=tile face), and its column bounds within the full-width desk (see
    _extent_desk) -- callers needing a taller, same-columns desk (e.g. for a
    top-boundary search) slice `_extent_desk(bgr, taller_quad)[0]` with these
    directly rather than re-deciding the extent on the taller one. Returns
    (None, 0, 0) on failure."""
    built = _extent_desk(bgr, quad)
    if built is None:
        return None, 0, 0
    desk, Wr, Hr = built
    gray = cv2.cvtColor(desk, cv2.COLOR_BGR2GRAY).astype(np.float32)
    y0, y1 = _content_row_band(gray, Hr)
    band = desk[y0:y1, :]
    Bc = band[:, :, 0].astype(np.float32).mean(0)
    Gc = band[:, :, 1].astype(np.float32).mean(0)
    Rc = band[:, :, 2].astype(np.float32).mean(0)
    chan_std = np.std(np.stack([Bc, Gc, Rc], 0), axis=0)
    chan_std = np.convolve(chan_std, np.ones(3) / 3, mode="same")
    cs_u8 = np.clip(chan_std, 0, 255).astype(np.uint8)
    otsu_thr, _ = cv2.threshold(cs_u8.reshape(-1, 1), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    below = chan_std < otsu_thr
    runs, i = [], 0
    while i < Wr:
        if below[i]:
            j = i
            while j < Wr and below[j]:
                j += 1
            runs.append((i, j)); i = j
        else:
            i += 1
    if not runs:
        return desk, 0, Wr
    Lf, Rf = max(runs, key=lambda r: r[1] - r[0])       # widest low-std valley
    if Rf - Lf <= 20:
        return desk, 0, Wr
    return desk[:, Lf:Rf], Lf, Rf


def _extent_segments(bgr, quad, bridge_max=35):
    """Like _product_extent_strip, but a concealed hand can be split into MULTIPLE
    physically separate clusters on the table with a visible felt gap between them
    (confirmed on a real frame: the near-camera half and far half of the SAME
    13-tile hand sat ~19px apart in these desk coordinates). Picking only the
    single widest low-std valley (the original approach) keeps whichever cluster
    happens to be wider and silently drops the other tiles.

    Bridging is SEED-GATED, not just gap-width gated: naively bridging any two
    valleys under `bridge_max` apart (tried first) wrongly merged in unrelated
    low-std content on OTHER frames that happened to sit within `bridge_max` of
    the real hand by coincidence (confirmed regressions: a tray/dial area on one
    frame, background past the row's true end on another) -- neither is part of
    the hand. The SEED -- the original ORB-selected candidate's own (unextended)
    row span (_quad_from_comp's own length, before this function's full-frame
    extension), mapped into these desk coordinates -- anchors which valley is
    "the hand": the valley with the most overlap against the seed is the primary
    cluster, and an ADJACENT valley only bridges in if its own MIDPOINT also
    falls inside the seed span (i.e. the candidate's own row-fit already
    "expected" real content there) and its gap to its neighbour is small.
    Validated on the full 20-hand regression set: recovers a missing second
    cluster with zero regressions elsewhere (a plain gap-size threshold alone
    was tried first and regressed 4 previously-correct hands).

    Returns (desk, segments): `segments` is a left-to-right list of (L, R)
    column ranges in `desk`, ONE PER PHYSICAL CLUSTER -- deliberately NOT
    flattened into a single merged range, so the caller (_count_hand_segments)
    can seam-count and side-trim each cluster independently rather than seam-
    counting across the felt gap between them (which reads as its own
    false seam-bounded "cell" -- confirmed). A single-cluster hand (the common
    case) returns a single-element list, reproducing the old single-range
    behaviour exactly. Returns (None, []) on failure."""
    built = _extent_desk(bgr, quad)
    if built is None:
        return None, []
    desk, Wr, Hr = built
    gray = cv2.cvtColor(desk, cv2.COLOR_BGR2GRAY).astype(np.float32)
    y0, y1 = _content_row_band(gray, Hr)
    band = desk[y0:y1, :]
    Bc = band[:, :, 0].astype(np.float32).mean(0)
    Gc = band[:, :, 1].astype(np.float32).mean(0)
    Rc = band[:, :, 2].astype(np.float32).mean(0)
    chan_std = np.std(np.stack([Bc, Gc, Rc], 0), axis=0)
    chan_std = np.convolve(chan_std, np.ones(3) / 3, mode="same")
    cs_u8 = np.clip(chan_std, 0, 255).astype(np.uint8)
    otsu_thr, _ = cv2.threshold(cs_u8.reshape(-1, 1), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    below = chan_std < otsu_thr
    runs, i = [], 0
    while i < Wr:
        if below[i]:
            j = i
            while j < Wr and below[j]:
                j += 1
            runs.append((i, j)); i = j
        else:
            i += 1
    if not runs:
        return desk, [(0, Wr)]

    TL, TR, BR, BL = quad
    u = (TR - TL) / (np.linalg.norm(TR - TL) + 1e-9)
    Hf, Wf = bgr.shape[:2]
    scc = [(0 - TL[0]) / u[0], (Wf - TL[0]) / u[0], (0 - BL[0]) / u[0], (Wf - BL[0]) / u[0]]
    smin = min(scc)
    seed_lo = -smin
    seed_hi = float(np.linalg.norm(TR - TL)) - smin

    def overlap(LR):
        L, R = LR
        return max(0, min(R, seed_hi) - max(L, seed_lo))
    primary = max(runs, key=overlap)
    if overlap(primary) <= 0:
        Lf, Rf = max(runs, key=lambda r: r[1] - r[0])   # nothing overlaps the seed -- fall back
        if Rf - Lf <= 20:
            return desk, [(0, Wr)]
        return desk, [(Lf, Rf)]

    idx = runs.index(primary)
    segs = [list(primary)]
    j = idx - 1
    while j >= 0:
        L, R = runs[j]
        mid = (L + R) / 2
        if segs[0][0] - R < bridge_max and seed_lo <= mid <= seed_hi:
            segs.insert(0, [L, R]); j -= 1
        else:
            break
    j = idx + 1
    while j < len(runs):
        L, R = runs[j]
        mid = (L + R) / 2
        if L - segs[-1][1] < bridge_max and seed_lo <= mid <= seed_hi:
            segs.append([L, R]); j += 1
        else:
            break
    segs = [(L, R) for L, R in segs if R - L > 20]
    if not segs:
        return desk, [(0, Wr)]
    return desk, segs


def _count_hand_segments(bgr, TL, TR, BR, BL, face_raw, desk, segments, shoulder, quad_top):
    """Seam-count and side-trim each physical cluster in `segments` INDEPENDENTLY
    (never across the felt gap between clusters -- see _extent_segments), then
    concatenate their per-tile cell crops into one hand. Mirrors the single-
    segment path in count_hand but generalizes it to N clusters.

    Edge role per cluster: the geometric _is_side_face_end check is gated
    PURELY by `shoulder` DIRECTION, applied uniformly to every cluster's
    corresponding edge -- NOT by whether an edge happens to be the row's true
    end vs an inner gap-facing edge (an earlier version of this function tried
    that "true end vs gap edge" split and was wrong -- user correction,
    confirmed on a real 2-cluster hand, t1608, shoulder="left": checking a
    cluster's GAP-facing right edge geometrically produced a false positive
    that dropped a genuine end tile, "七", entirely). The oblique near-camera
    viewing angle that produces a real bevel is a property of the CAMERA, not
    of where a cut happens to fall -- it shows up on the same physical side
    (left for shoulder="left", right for shoulder="right") on EVERY cluster,
    true row end or internal gap edge alike, so every cluster checks only that
    one side. shoulder=None keeps the old both-ends-checked default (no
    direction to gate on). `_is_near_edge_artifact` (a different, near-camera-
    specific phenomenon) still only applies to the cluster containing the
    row's true near-camera end, via `seg_shoulder` below.

    Returns (raw, cv, x0, x1, warp, cells) in the same shape count_hand expects,
    where x0/x1/warp describe the FIRST cluster's own local crop (kept for
    call-site compatibility; `warp` is the visual concatenation of all clusters'
    trimmed strips)."""
    n_seg = len(segments)
    built_top = _extent_desk(bgr, quad_top)
    desk_top = built_top[0] if built_top is not None else None

    if shoulder == "left":
        check_first, check_last = True, False
    elif shoulder == "right":
        check_first, check_last = False, True
    else:
        check_first, check_last = True, True

    total_raw, all_gaps, out_cells, out_warps = 0, [], [], []
    for i, (L, R) in enumerate(segments):
        is_first, is_last = i == 0, i == n_seg - 1
        seg_shoulder = ("left" if (is_first and shoulder == "left") else
                         "right" if (is_last and shoulder == "right") else None)

        warp_seg = desk[:, L:R]
        raw, seams, cv, x0, x1 = _count_seams(warp_seg, shoulder=seg_shoulder,
                                               check_first=check_first, check_last=check_last)
        seams = _recover_haku_seams(bgr, TL, TR, BR, BL, face_raw, L, R, warp_seg, seams, x0, x1)
        raw = len(seams) + 1
        total_raw += raw
        gaps = np.diff([x0] + seams + [x1])
        all_gaps.extend(gaps.tolist())

        tall_warp, tall_offset = None, 0
        if desk_top is not None:
            tall_warp = desk_top[:, L:R]
            tall_offset = tall_warp.shape[0] - warp_seg.shape[0]
        out_cells.extend(cell_crops(warp_seg, seams, x0, x1, tall_warp=tall_warp, tall_offset=tall_offset))
        out_warps.append(warp_seg[:, x0:x1])

    cv = float(np.std(all_gaps) / (np.mean(all_gaps) + 1e-6)) if all_gaps else 1.0
    if len(out_warps) > 1:
        h = max(w.shape[0] for w in out_warps)
        sep = np.zeros((h, 3, 3), np.uint8)
        padded = [w if w.shape[0] == h else cv2.copyMakeBorder(w, 0, h - w.shape[0], 0, 0, cv2.BORDER_CONSTANT) for w in out_warps]
        parts = [padded[0]]
        for w in padded[1:]:
            parts.append(sep); parts.append(w)
        warp = np.hstack(parts)
    else:
        warp = out_warps[0]
    x0f, x1f = segments[0][0], segments[0][1]
    return total_raw, cv, x0f, x1f, warp, out_cells


def near_hand_roi(shape, calib):
    """Compass-derived near-hand region: in every over-shoulder view the near seat's
    concealed hand sits BELOW the central tray (closer to the camera). So restrict the
    row search to y >= the calibrated tray CENTROID, full width. This excludes the far
    wall (orange backs, above the tray) so row_quad's select_haipai doesn't lock onto
    it; select_haipai then picks the hand over the tray (the tray isn't a haipai-shaped
    white row). NB: start AT the centroid, not lower — a 0.40*H-style floor clips the
    hand top on cameras whose tray sits high in frame (e.g. the +26deg seat, cy~164).
    calib: a per-camera calibration dict with 'centroid' [cx,cy] and 'side'."""
    h, w = shape[:2]
    cy = calib["centroid"][1]
    y0 = int(max(0, min(0.75 * h, cy)))
    return (0, y0, w, h)


def count_hand(bgr, lib_orb=None, roi=None, shoulder=None, cfg=None):
    """Count the concealed tiles in the near seat's hand row by directly counting the
    white SEAMS between tiles (N = seams + 1) — unbiased, unlike a try-each-N search.

    Row selection: if `lib_orb` (a tiles.load_library_orb dict) is given, the hand is
    chosen by ORB content (select_hand_warp) — walls/arm/PiP/logo lose to real tile
    faces — with a felt-trimmed extent (see _product_extent_strip) that recovers
    shadowed end tiles. This is the general path (no ROI). Without lib_orb it falls
    back to row_quad's single pick; `roi` (near_hand_roi) then helps it avoid the
    wall on oblique frames.

    When `lib_orb` is given, also builds `cells`: individual per-tile crops via
    cell_crops (per-cell top/bottom boundary lines). `shoulder` ('left'/'right',
    from compass.seat_frames's bucket) is passed to _count_seams so it knows which
    end of the row is nearest the camera, for the near-edge artifact check.

    Left/right extent, seam/tile counting, and the top-boundary search each want a
    DIFFERENT amount of quad headroom, and they're not independent -- padding a
    quad's top can shift the extent decision in ways that silently change which
    run gets kept as "the tiles" (confirmed on a real frame: two quads differing
    only in top_margin picked different left edges). So: the base quad
    (top_margin=0) drives everything except the top boundary, and a second, taller
    quad (top_margin=0.3) -- sharing the exact same columns via _extent_desk's
    column-mapping invariant -- is built purely to give _cell_top_via_band_d2 more
    headroom above a tightly-fit tile top.

    Returns {count, raw, melds, holding_draw, score, warp[, cells]} or None. `score`
    is the seam-spacing coefficient of variation (lower = cleaner read; use for
    consensus)."""
    cells = None
    if lib_orb is not None:
        quad = select_hand_quad(bgr, lib_orb, cfg=cfg)  # candidate selection @ top_margin=0.10 (unchanged)
        if quad is None:
            return None
        # derive a top_margin=0 quad ALGEBRAICALLY from the selected winner, rather than
        # re-running selection at a different margin (that changes WHICH candidate wins --
        # see select_hand_quad's docstring). Only TL/TR's Y shifts; BL/BR (bottom anchor)
        # and every X coordinate are untouched, so this can't perturb which row it is.
        TL, TR, BR, BL = quad
        face_010 = BL[1] - TL[1]
        face_raw = face_010 / 1.10                    # undo _quad_from_comp's (1+0.10) factor
        quad_0 = np.float32([[TL[0], BL[1] - face_raw], [TR[0], BR[1] - face_raw], BR, BL])

        desk, segments = _extent_segments(bgr, quad_0)
        if desk is None or not segments:
            return None
        extra = 0.3 * face_raw                        # top_margin=0.3, purely for the top-boundary search
        quad_top = np.float32([[TL[0], BL[1] - face_raw - extra],
                                [TR[0], BR[1] - face_raw - extra], BR, BL])
        raw, cv, x0, x1, warp, cells = _count_hand_segments(
            bgr, TL, TR, BR, BL, face_raw, desk, segments, shoulder, quad_top)
        if warp is None or warp.shape[1] < 20:
            return None
    else:
        if roi is not None:
            x0, y0, x1, y1 = roi
            bgr = bgr[y0:y1, x0:x1]
        quad, _, _ = P.row_quad(bgr, 13)              # nominal band; seams are n-independent
        if quad is None:
            return None
        Ltop = float(np.hypot(*(quad[1] - quad[0])))
        W, H = max(1, int(round(Ltop))), P.CELL_H
        dst = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
        warp = cv2.warpPerspective(bgr, cv2.getPerspectiveTransform(quad, dst), (W, H))
        warp = P._trim_blank_edges(warp)
        raw, seams, cv, x0, x1 = _count_seams(warp, shoulder=shoulder)
        warp = warp[:, x0:x1]                           # exclude any dropped end-of-row side face
    count = min(_LEGAL, key=lambda v: abs(v - raw))
    if abs(count - raw) > 1:                           # implausible -> keep raw, no melds
        count = raw
    rest = count - 1 if count not in _REST and (count - 1) in _REST else count
    holding = rest != count
    melds = (13 - rest) // 3 if rest in _REST else None
    out = {"count": count, "raw": raw, "melds": melds, "holding_draw": holding,
           "score": round(cv, 3), "warp": warp}
    if cells is not None:
        out["cells"] = cells
    return out


def count_and_read(bgr, lib=None, roi=None):
    """Count, then (if a tile library is given) identify the tiles at the snapped N.
    Returns the count dict plus {tiles: [codes], n_read} when identity is attempted."""
    if roi is not None:
        x0, y0, x1, y1 = roi
        bgr = bgr[y0:y1, x0:x1]
    c = count_hand(bgr)
    if c is None:
        return None
    n = c["count"]
    if lib is not None and n and 1 <= n <= 14:
        codes, crops, meta = P.read_hand(lib, bgr, n)
        c["tiles"] = codes
        c["n_read"] = len(codes)
    return c


def consensus_count(seat_frames, calib=None, lib_orb=None, keep_frac=0.4, min_keep=3, shoulder=None, cfg=None):
    """Denoise the per-frame count over a set of one seat's frames (a window in which
    the count is stable). Some frames segment well and others don't, so: count each
    frame, keep the lowest-_seam-score reads (best fits), and take their legal-count
    MODE. Row selection uses ORB content when `lib_orb` is given (no ROI), else the
    compass ROI from `calib`. `shoulder` ('left'/'right', from the seat's
    compass.seat_frames bucket) is forwarded to count_hand for its far-edge crop.
    Returns {count, melds, n_reads, kept, agree, best_score} or None. `agree` is the
    fraction of kept reads sharing the mode."""
    from collections import Counter
    reads = []
    for t, im in seat_frames:
        if lib_orb is not None:
            r = count_hand(im, lib_orb=lib_orb, shoulder=shoulder, cfg=cfg)
        else:
            r = count_hand(im, roi=near_hand_roi(im.shape, calib))
        if r is not None:
            reads.append((r["score"], r["count"]))
    if not reads:
        return None
    reads.sort(key=lambda x: x[0])
    k = min(len(reads), max(min_keep, int(round(keep_frac * len(reads)))))
    kept = reads[:k]
    count, agree = Counter(c for _, c in kept).most_common(1)[0]
    rest = count - 1 if count not in _REST and (count - 1) in _REST else count
    melds = (13 - rest) // 3 if rest in _REST else None
    return {"count": count, "melds": melds, "n_reads": len(reads), "kept": k,
            "agree": round(agree / k, 2), "best_score": round(kept[0][0], 3)}


def count_timeline(seat_frames, calib=None, lib_orb=None, bin_s=20.0, shoulder=None):
    """Per-seat concealed-count over time (consensus within time bins). Each call
    steps the count DOWN by 3, so the timeline's step-downs ARE the calls (with
    timing). Returns [{t, count, melds, agree}, ...] in time order."""
    sf = sorted(seat_frames, key=lambda x: x[0])
    if not sf:
        return []
    t0 = sf[0][0]
    bins = {}
    for t, im in sf:
        bins.setdefault(int((t - t0) // bin_s), []).append((t, im))
    out = []
    for b in sorted(bins):
        c = consensus_count(bins[b], calib=calib, lib_orb=lib_orb, shoulder=shoulder)
        if c is not None:
            out.append({"t": round(bins[b][0][0], 1), "count": c["count"],
                        "melds": c["melds"], "agree": c["agree"]})
    return out


def calls_from_timeline(timeline):
    """A meld-count that increases between consecutive bins => a call happened in
    that interval. Returns [{after, before_melds, melds, at_t}] (coarse timing)."""
    ev = []
    prev = None
    for row in timeline:
        m = row["melds"]
        if m is None:
            continue
        if prev is not None and m > prev:
            ev.append({"at_t": row["t"], "melds": m, "prev_melds": prev})
        prev = m if prev is None else max(prev, m)   # melds are monotonic non-decreasing
    return ev


def count_hand_at(source, at, half=2.0, step=0.5, lib=None, roi=None):
    """Reliable count at a timestamp: pass2.scan_median samples a small window around
    `at`, drops the high-motion (arm-occluded / mid-cut) frames, and medians the
    settled ones -> a clean, arm-free hand image; then count_hand on THAT. This is
    the frame-selection that makes the count reliable (raw in-play frames mis-count).
    Keep the window inside one camera shot (small half) so the median isn't a blend
    of two cameras. Returns the count dict + {t: best_t, still_frac} or None."""
    med, best_t, motions = P.scan_median(source, at, half, step, 13)
    r = count_and_read(med, lib, roi) if lib is not None else count_hand(med, roi)
    if r is not None:
        ms = [m for _, m in motions]
        thr = min(ms) + 0.5 * (float(np.median(ms)) - min(ms))
        r["t"] = best_t
        r["still_frac"] = round(sum(m <= thr for m in ms) / len(ms), 2)
    return r


if __name__ == "__main__":
    import sys, glob, os
    # quick check over frames passed on the argv (or a default scratch dir)
    args = sys.argv[1:] or sorted(glob.glob(
        r"C:/Users/tongc/AppData/Local/Temp/claude/D--Git-paifu-plus/"
        r"3a62e320-d89b-4a73-830b-893957f9e19e/scratchpad/e4/e4_*.png"))[:1]
    for f in args:
        im = cv2.imread(f)
        if im is None:
            print("skip", f); continue
        r = count_hand(im)
        print(os.path.basename(f), "->", {k: v for k, v in (r or {}).items() if k != "warp"})
