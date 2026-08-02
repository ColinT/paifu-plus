"""
Compass calibration — per-camera top-down rectification anchored on the central
dice tray (the "compass").

Why: reading the discard river needs the table registered top-down, but this
broadcast has no overhead shot — only four fixed over-shoulder camera mounts. The
central dice tray is bolted to the table centre and visible from every seat, so it
is the one stable landmark. Calibrate a homography per camera ONCE (tray -> square)
and reuse it for the whole game: any frame from that camera rectifies to top-down,
and the four rivers land in fixed quadrants around the tray.

Pipeline per camera (validated on the 最高位戦/WRC playoff, all 4 seats):
  1. gather the round's frames for this camera (see cluster_seats)
  2. NCC-purify to a single-camera set, median-composite (erases moving arms)
  3. detect the tray blob by a 3-way score: tile-growth proximity + temporal
     staticness + fill-ratio circularity  (colour-independent; the tray colour
     varies per camera so colour can't anchor it)
  4. deskew by line-intersection + IoU-quad: extend Hough edges to the crop
     border, keep only those hugging the tray blob, form quads from the two
     dominant angle families, pick the quad with best IoU vs the blob, then
     getPerspectiveTransform(quad -> square)

Everything is data-driven (no hardcoded pixel positions): a static-overlay mask
(logo/scorebar) from temporal variance across mixed perspectives, and a letterbox
border mask from edge-connected near-black pixels. Tunables live in the config's
"pass3.compass" block.
"""
from __future__ import annotations

import itertools

import cv2
import numpy as np

from pass2_hands import whitish, row_quad

# ---- defaults (overridable via cfg["pass3"]["compass"]) -------------------
DEFAULTS = {
    "ncc_keep": 0.65,          # NCC vs median: keep frames >= this (single-camera set)
    "tray_min_area_frac": 0.003,
    "tray_max_area_frac": 0.12,
    "candidate_disk": 90,      # px radius for heat-proximity scoring
    "edge_band": 17,           # px; band around the blob contour for edge-adjacent lines
    "line_tol_deg": 18,        # family half-width around each dominant peak
    "max_family": 10,          # keep the longest N lines per family
    "iou_min": 0.40,           # below this the quad fit is untrustworthy -> question
    "dark_v": 45,              # exclude V<this (shadow/letterbox) before segmentation
    "tray_erode": 5,           # erode tray pixels to break felt-bleed bridges
    "agree_disk": 25,          # px radius for per-frame candidate agreement splat
    "agree_min_fill": 0.35,    # only compact per-frame candidates vote for agreement
    "heat_bonus": 0.15,        # additive weight of river-growth heat (a tiebreaker, not a factor)
}


def _cfg(cfg):
    d = dict(DEFAULTS)
    d.update((cfg or {}).get("pass3", {}).get("compass", {}))
    return d


# ---- data-driven masks ----------------------------------------------------

def static_overlay_mask(frames, thresh=12, min_area=400):
    """Pixels that don't change across a MIX of camera perspectives = burned-in
    broadcast overlays (logo, scorebar, chrome). When the camera angle varies the
    table content moves, so only composited overlays stay low-variance. Pass frames
    spanning multiple seats/shots for this to isolate overlays (not table content)."""
    h, w = frames[0].shape[:2]
    s = np.zeros((h, w), np.float64)
    s2 = np.zeros((h, w), np.float64)
    n = 0
    for im in frames:
        g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float64)
        s += g; s2 += g * g; n += 1
    mean = s / n
    std = np.sqrt(np.clip(s2 / n - mean * mean, 0, None))
    m = ((std < thresh) & (mean > 18)).astype(np.uint8) * 255  # exclude black border here
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n_, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    clean = np.zeros_like(m)
    for i in range(1, n_):
        if st[i, 4] >= min_area:
            clean[lab == i] = 255
    return cv2.dilate(clean, np.ones((9, 9), np.uint8))


def overlay_edge_mask(frames, thresh=0.9, canny=(50, 150), dilate_px=7):
    """Broadcast chrome as EDGES present in >= thresh of the frames (pooled across
    perspectives). Companion to static_overlay_mask (pixel-level) but in edge space —
    sharper on thin text/logo outlines. Reusable: subtract it from any Canny map to
    strip logo / scorebar / header / PiP-border edges before line / tile / seam
    analysis (hand-extent vertical lines, river seams, compass Hough). Compute ONCE per
    broadcast from a multi-perspective frame set and pass the result in.

    A pixel is chrome if it is a Canny edge in >= thresh of the frames: composited
    overlays sit at a fixed screen position across all shots, whereas table edges move
    with the camera, so only chrome clears the frequency bar."""
    h, w = frames[0].shape[:2]
    acc = np.zeros((h, w), np.float32)
    n = 0
    for im in frames:
        acc += (cv2.Canny(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), *canny) > 0).astype(np.float32)
        n += 1
    m = ((acc / max(n, 1)) >= thresh).astype(np.uint8) * 255
    return cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_px, dilate_px)))


def cross_perspective_overlay_mask(seat_medians, thresh=12, close_px=9, dilate_px=11, blur=3):
    """Broadcast chrome as pixels that look the SAME across the four seat cameras.
    Composited overlays (logo, scorebar, round header, PiP border) sit at a fixed
    screen position and colour regardless of camera angle, so their cross-perspective
    std is ~0; real table content differs per seat, so its std is high. Sharper than
    static_overlay_mask because it compares clean per-seat median composites (arms
    already erased) rather than a noisy mix of raw frames.

    seat_medians: list of per-seat median BGR frames (>=2). Returns a uint8 mask
    (255 = chrome) suitable as an overlay gate for compass candidate rejection."""
    g = [cv2.cvtColor(m, cv2.COLOR_BGR2GRAY).astype(np.float32) for m in seat_medians]
    std = cv2.GaussianBlur(np.stack(g).std(0), (0, 0), blur)
    m = ((std < thresh).astype(np.uint8)) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((close_px, close_px), np.uint8))
    return cv2.dilate(m, np.ones((dilate_px, dilate_px), np.uint8))


def clean_edges(bgr, overlay_edge=None, border=True, canny=(50, 150)):
    """Canny edges of `bgr` with broadcast chrome + letterbox border removed — the
    standard chrome-free edge map for line / seam / tile analysis. Pass a precomputed
    `overlay_edge` (from overlay_edge_mask) to strip fixed overlays; border=True also
    drops letterbox-border edges. One place, reused by every edge-based operation."""
    e = cv2.Canny(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), *canny)
    if overlay_edge is not None:
        e[overlay_edge > 0] = 0
    if border:
        e[cv2.dilate(border_mask(bgr, edge_px=60), np.ones((5, 5), np.uint8)) > 0] = 0
    return e


def border_mask(frame, edge_px=40):
    """Letterbox/pillarbox: near-black pixels flood-filled from the frame edge,
    restricted to within edge_px of a border so it can't eat interior content."""
    g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    dark = (g < 16).astype(np.uint8)
    h, w = dark.shape
    ff = dark.copy()
    m = np.zeros((h + 2, w + 2), np.uint8)
    for x in range(w):
        if dark[0, x]: cv2.floodFill(ff, m, (x, 0), 2)
        if dark[h - 1, x]: cv2.floodFill(ff, m, (x, h - 1), 2)
    for y in range(h):
        if dark[y, 0]: cv2.floodFill(ff, m, (0, y), 2)
        if dark[y, w - 1]: cv2.floodFill(ff, m, (w - 1, y), 2)
    b = (ff == 2).astype(np.uint8) * 255
    edge = np.zeros_like(b)
    edge[:edge_px] = 1; edge[-edge_px:] = 1; edge[:, :edge_px] = 1; edge[:, -edge_px:] = 1
    return b * edge


# ---- small helpers --------------------------------------------------------

def _region(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)[60:520, 100:1180]
    return (g - g.mean()) / (g.std() + 1e-6)


def _ncc(a, b):
    return float((a * b).mean())


def _lncc(ag, bg, mask):
    m = mask > 0
    if m.sum() < 50:
        return 0.0
    a = ag[m].astype(np.float32); b = bg[m].astype(np.float32)
    a = (a - a.mean()) / (a.std() + 1e-6); b = (b - b.mean()) / (b.std() + 1e-6)
    return float((a * b).mean())


def _maxn(v):
    v = np.clip(np.asarray(v, float), 0, None)
    m = v.max()
    return v / m if m > 0 else v


def _tile_mask(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    H, S, V = cv2.split(hsv)
    felt = (H > 95) & (H < 130) & (S > 55)
    wall = (H > 5) & (H < 30) & (S > 60)
    dark = V < 50
    return ((whitish(img) > 0) & (~felt) & (~wall) & (~dark)).astype(np.float32)


def _tray_pixels(img, static, border, dark_v):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    H, S, V = cv2.split(hsv)
    felt = (H > 95) & (H < 130) & (S > 55)
    wall = (H > 5) & (H < 30) & (S > 60)
    tile = whitish(img) > 0
    dark = V < dark_v
    m = ((~felt) & (~tile) & (~wall) & (~dark)).astype(np.uint8) * 255
    if static is not None: m[static > 0] = 0
    if border is not None: m[border > 0] = 0
    h, w = m.shape
    v = np.zeros_like(m)
    v[int(.06 * h):int(.78 * h), int(.03 * w):int(.98 * w)] = 1
    v[int(.50 * h):, :int(.24 * w)] = 0                       # exclude PiP face video
    m *= v
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((13, 13), np.uint8))
    return cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))


def _hough(img, excl=None):
    e = cv2.Canny(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), 40, 120)
    if excl is not None:
        e[excl > 0] = 0
    L = cv2.HoughLinesP(e, 1, np.pi / 180, threshold=40, minLineLength=40, maxLineGap=10)
    return np.zeros((0, 4)) if L is None else np.asarray(L).reshape(-1, 4).astype(float)


def _ang(l):
    return np.degrees(np.arctan2(l[3] - l[1], l[2] - l[0])) % 180


def _angdist(a, b):
    d = abs(a - b) % 180
    return min(d, 180 - d)


def _inter(a, b):
    p = np.cross(np.cross([a[0], a[1], 1.], [a[2], a[3], 1.]),
                 np.cross([b[0], b[1], 1.], [b[2], b[3], 1.]))
    return None if abs(p[2]) < 1e-6 else np.array([p[0] / p[2], p[1] / p[2]])


def _cull(fam, k):
    return fam if len(fam) < k else sorted(
        fam, key=lambda l: np.hypot(l[2] - l[0], l[3] - l[1]), reverse=True)[:k]


# ---- purify + median ------------------------------------------------------

def purified_median(frames, keep_ncc):
    """NCC-purify a camera's frame set to one coherent camera, return the median.
    frames: list of (t, bgr). Erases moving arms; drops mixed-in other-seat frames."""
    imgs = [im for _, im in frames]
    med0 = np.median(np.stack([im.astype(np.float32) for im in imgs]), 0).astype(np.uint8)
    mr = _region(med0)
    keep = [(t, im) for t, im in frames if _ncc(mr, _region(im)) >= keep_ncc]
    if len(keep) < 4:
        keep = list(frames)
    keep = sorted(keep, key=lambda x: x[0])                    # chronological (heat needs it)
    med = np.median(np.stack([im.astype(np.float32) for _, im in keep]), 0).astype(np.uint8)
    return med, keep


# ---- compass detection (3-way score) --------------------------------------

def _hull_roundness(cm, cx, cy, area):
    """Radial-spread roundness on the candidate's convex hull: from the centroid,
    measure the nearest and furthest distances to the hull boundary. A circle has
    near == far (spread 0); an elongated/oblique blob has a big gap. Returns
    1/(1+spread/equiv_r) in (0,1], 1.0 = perfectly round. Scale-free via the
    equivalent-circle radius, so it ranks a grazing-view tray (a fat ellipse) above
    a jagged sliver even though neither is a clean disk."""
    cont = cv2.findContours(cm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
    if not cont:
        return 0.0
    hull = cv2.convexHull(max(cont, key=cv2.contourArea)).reshape(-1, 2).astype(np.float32)
    if len(hull) < 3:
        return 0.0
    far = float(np.max(np.hypot(hull[:, 0] - cx, hull[:, 1] - cy)))          # always a vertex
    near = float(cv2.pointPolygonTest(hull, (float(cx), float(cy)), True))   # signed dist to boundary
    near = abs(near)
    equiv_r = np.sqrt(area / np.pi)
    spread = (far - near) / (equiv_r + 1e-6)
    return 1.0 / (1.0 + max(0.0, spread))


def _tray_candidates(img, static, border, P):
    """Segment compact tray-colour blobs in a single frame. Erodes to break
    felt-bleed bridges (a reflective tray leaks into the felt without it).
    Returns (labels, [(label, cx, cy, area, roundness), ...])."""
    mm = _tray_pixels(img, static, border, P["dark_v"])
    e = int(P.get("tray_erode", 0))
    if e > 1:
        mm = cv2.erode(mm, np.ones((e, e), np.uint8))
    n, lc, st, ce = cv2.connectedComponentsWithStats(mm, 8)
    h, w = mm.shape
    out = []
    for i in range(1, n):
        a = st[i, 4]
        if a < P["tray_min_area_frac"] * w * h or a > P["tray_max_area_frac"] * w * h:
            continue
        cm = (lc == i).astype(np.uint8)
        cx, cy = int(round(ce[i][0])), int(round(ce[i][1]))
        fill = _hull_roundness(cm, cx, cy, a)                   # 1.0 = perfect circle
        out.append((i, cx, cy, int(a), float(fill)))
    return lc, out


def _agreement_heat(keep, static, border, P):
    """Where do compact tray candidates land the SAME across the shot's frames?
    The tray is bolted to the table centre so it recurs at one fixed spot every
    frame; a one-off reflection/button does not. Splat each frame's compact
    candidates and blur -> a stable-location prior that breaks fill/heat ties."""
    h, w = keep[0][1].shape[:2]
    acc = np.zeros((h, w), np.float32)
    for _, im in keep:
        _, cands = _tray_candidates(im, static, border, P)
        for _, cx, cy, _, fill in cands:
            if fill >= P["agree_min_fill"]:
                cv2.circle(acc, (cx, cy), P["agree_disk"], fill, -1)
    return cv2.GaussianBlur(acc, (0, 0), 20)


def detect_compass(med, keep, static, border, P, xoverlay=None):
    """Return (blob_mask, score, centroid) for the tray in the median frame.
    4-way score = tile-growth proximity + temporal staticness + fill circularity
    + cross-frame agreement (stable-location prior). `xoverlay` (a cross-perspective
    overlay mask) gates out chrome: candidates centred on it are rejected."""
    medg = cv2.cvtColor(med, cv2.COLOR_BGR2GRAY)
    grays = [cv2.cvtColor(im, cv2.COLOR_BGR2GRAY) for _, im in keep]
    masks = [_tile_mask(im) for _, im in keep]
    half = max(1, len(masks) // 2)
    heat = cv2.GaussianBlur(
        np.clip(np.mean(masks[half:], 0) - np.mean(masks[:half], 0), 0, 1)
        * np.mean(masks[half:], 0), (0, 0), 8)
    agree = _agreement_heat(keep, static, border, P) if len(keep) >= 4 else None
    lc, cands = _tray_candidates(med, static, border, P)
    h, w = medg.shape
    C = []
    for i, cx, cy, a, fill in cands:
        if xoverlay is not None and 0 <= cy < h and 0 <= cx < w and xoverlay[cy, cx] > 0:
            continue                                           # cross-perspective chrome
        z = np.zeros((h, w), np.uint8)
        cv2.circle(z, (cx, cy), P["candidate_disk"], 1, -1)
        hs = float((heat * z).sum() / (z.sum() + 1))
        cm = (lc == i).astype(np.uint8)
        ss = float(np.mean([_lncc(g, medg, cm) for g in grays]))
        ag = float(agree[cy, cx]) if agree is not None else 0.0
        C.append([i, cx, cy, int(a), hs, ss, fill, ag])
    if not C:
        return None, (0.0, 0.0), None
    hn = _maxn([c[4] for c in C]); sn = _maxn([c[5] for c in C])
    cn = _maxn([c[6] for c in C]); an = _maxn([c[7] for c in C])
    use_agree = agree is not None and float(np.max([c[7] for c in C])) > 0
    # The tray is the ONLY candidate that is static AND recurs at one spot AND is
    # round; each false blob fails at least one. A product (AND) of those three
    # enforces that, where an average would let a strong 2-of-3 blob win. Heat
    # (river-growth proximity) is noisier and per-camera-variable, so it only adds
    # a small tiebreaker bonus rather than gating the decision.
    hb = P.get("heat_bonus", 0.15)
    for k, c in enumerate(C):
        core = sn[k] * cn[k] * (an[k] if use_agree else 1.0)
        c.append(core + hb * hn[k])
    C.sort(key=lambda c: c[8], reverse=True)
    win = C[0]
    runner = C[1][8] if len(C) > 1 else 0.0
    blob = (lc == win[0]).astype(np.uint8) * 255
    return blob, (win[8], runner), (win[1], win[2])


# ---- quad deskew ----------------------------------------------------------

def quad_homography(med, blobmask, static, border, P):
    """Line-intersection + IoU-quad rectification. Returns (H_full, side, iou)
    where H_full maps FULL-FRAME coords -> a side x side top-down tray square,
    or None if no quad could be formed."""
    cont = max(cv2.findContours(blobmask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0],
               key=cv2.contourArea).reshape(-1, 2)
    x0 = max(0, int(cont[:, 0].min() - 40)); y0 = max(0, int(cont[:, 1].min() - 40))
    x1 = int(cont[:, 0].max() + 40); y1 = int(cont[:, 1].max() + 40)
    crop = med[y0:y1, x0:x1]
    ch, cw = crop.shape[:2]
    area = cw * ch
    blobc = (blobmask[y0:y1, x0:x1] > 0)
    excl = cv2.bitwise_or(
        static if static is not None else np.zeros_like(blobmask),
        border if border is not None else np.zeros_like(blobmask))[y0:y1, x0:x1].copy()
    excl[:3, :] = 255; excl[-3:, :] = 255; excl[:, :3] = 255; excl[:, -3:] = 255
    Lall = _hough(crop, excl)
    if len(Lall) < 4:
        return None
    # keep only lines running along the blob edge (drops off-tray tile lines)
    bc = blobc.astype(np.uint8)
    band = cv2.dilate(bc, np.ones((P["edge_band"], P["edge_band"]), np.uint8)) - \
        cv2.erode(bc, np.ones((P["edge_band"], P["edge_band"]), np.uint8))

    def on_edge(l, frac=0.5, npt=24):
        xs = np.linspace(l[0], l[2], npt).astype(int)
        ys = np.linspace(l[1], l[3], npt).astype(int)
        ok = (xs >= 0) & (xs < cw) & (ys >= 0) & (ys < ch)
        xs, ys = xs[ok], ys[ok]
        return len(xs) > 0 and band[ys, xs].mean() >= frac

    L = [l for l in Lall if on_edge(l)]
    if len(L) < 4:
        L = list(Lall)
    # two dominant angle families
    bins = np.zeros(180)
    for l in L:
        bins[int(_ang(l))] += np.hypot(l[2] - l[0], l[3] - l[1])
    bins = np.convolve(np.r_[bins[-5:], bins, bins[:5]], np.ones(5) / 5, 'same')[5:-5]
    p1 = int(np.argmax(bins))
    b2 = bins.copy()
    for dd in range(-20, 21):
        b2[(p1 + dd) % 180] = 0
    p2 = int(np.argmax(b2))
    tol = P["line_tol_deg"]
    famA = _cull([l for l in L if _angdist(_ang(l), p1) <= tol], P["max_family"])
    famB = _cull([l for l in L if _angdist(_ang(l), p2) <= tol], P["max_family"])
    best = None; best_iou = -1.0
    for a1, a2 in itertools.combinations(famA, 2):
        for b1, b2l in itertools.combinations(famB, 2):
            P4 = [_inter(a1, b1), _inter(a1, b2l), _inter(a2, b2l), _inter(a2, b1)]
            if any(p is None for p in P4):
                continue
            P4 = np.array(P4)
            if (P4[:, 0].min() < -15 or P4[:, 0].max() > cw + 15
                    or P4[:, 1].min() < -15 or P4[:, 1].max() > ch + 15):
                continue
            ct = P4.mean(0)
            poly = P4[np.argsort(np.arctan2(P4[:, 1] - ct[1], P4[:, 0] - ct[0]))]
            ar = cv2.contourArea(poly.astype(np.float32))
            if ar < 0.04 * area or ar > 0.9 * area or not cv2.isContourConvex(poly.astype(np.int32)):
                continue
            qm = np.zeros((ch, cw), np.uint8)
            cv2.fillPoly(qm, [poly.astype(np.int32)], 1)
            iou = np.logical_and(qm > 0, blobc).sum() / max(1, np.logical_or(qm > 0, blobc).sum())
            if iou > best_iou:
                best_iou = iou; best = poly
    if best is None:                                          # grazing view fallback
        best = cv2.boxPoints(cv2.minAreaRect(cont - [x0, y0]))
        ct = best.mean(0)
        best = best[np.argsort(np.arctan2(best[:, 1] - ct[1], best[:, 0] - ct[0]))]
        best_iou = 0.0
    # cyclic corners -> square (winding-matched; a diamond breaks TL/TR heuristics)
    src = best.astype(np.float32).copy()
    side = int(round(np.mean([np.linalg.norm(src[k] - src[(k + 1) % 4]) for k in range(4)])))
    dst = np.float32([[0, 0], [side, 0], [side, side], [0, side]])
    if np.sign(cv2.contourArea(src, True)) != np.sign(cv2.contourArea(dst, True)):
        src = src[::-1].copy()
    Hq = cv2.getPerspectiveTransform(src, dst)
    Tc = np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], float)  # frame -> crop
    return Hq @ Tc, side, float(best_iou)


def _rot90_about(cx, cy, k):
    """3x3 homogeneous matrix for a k*90deg CW rotation of image coords about
    (cx,cy). k is taken mod 4."""
    k = k % 4
    if k == 0:
        return np.eye(3)
    if k == 1:
        return np.array([[0, -1, cx + cy], [1, 0, cy - cx], [0, 0, 1]], float)
    if k == 2:
        return np.array([[-1, 0, 2 * cx], [0, -1, 2 * cy], [0, 0, 1]], float)
    return np.array([[0, 1, cx - cy], [-1, 0, cy + cx], [0, 0, 1]], float)


def _orient_river_ward(H, centroid, side):
    """Rotate the deskewed square (by a multiple of 90deg, about its own centre)
    so that +Y in OUTPUT space always means 'toward the camera' in the ORIGINAL
    frame — i.e. where the near seat's own river sits (see near_hand_roi: the
    near seat's hand/wall/river is always BELOW the tray, at larger image-y, in
    every over-shoulder shot). Without this, the deskewed square's orientation is
    whatever the quad's cyclic-corner winding happened to produce (arbitrary per
    calibration), so 'the river is below the square' would only hold for some
    cameras by chance. Returns (H_oriented, k) — k is the rotation applied, kept
    for debugging."""
    H = np.asarray(H, float)
    cx0, cy0 = centroid
    probe = np.array([cx0, cy0 + max(60.0, 0.5 * side), 1.0])   # a bit toward-camera in the ORIGINAL frame
    p = H @ probe
    p = p[:2] / p[2]
    c = side / 2.0
    d = p - np.array([c, c])
    # d'_y after a k*90 CW rotation, for k=0..3 respectively:
    k = int(np.argmax([d[1], d[0], -d[1], -d[0]]))
    return (_rot90_about(c, c, k) @ H), k


# ---- top-level per-camera calibration -------------------------------------

def calibrate_camera(frames, static, cfg, xoverlay=None):
    """Calibrate one camera from its frame set. frames: list of (t, bgr).
    `xoverlay` (cross_perspective_overlay_mask) gates chrome candidates.
    Returns dict: {H (3x3 list, frame->square, ORIENTED so +Y=toward camera),
    side, iou, comb, runner, centroid, orient_k, t, n} or None."""
    P = _cfg(cfg)
    med, keep = purified_median(frames, P["ncc_keep"])
    border = border_mask(med)
    blob, score, centroid = detect_compass(med, keep, static, border, P, xoverlay)
    if blob is None:
        return None
    out = quad_homography(med, blob, static, border, P)
    if out is None:
        return None
    H, side, iou = out
    H, orient_k = _orient_river_ward(H, centroid, side)
    comb, runner = score
    return {
        "H": H.tolist(), "side": int(side), "iou": round(iou, 3),
        "comb": round(comb, 3), "runner": round(runner, 3),
        "centroid": [int(centroid[0]), int(centroid[1])], "orient_k": orient_k,
        "t": int(np.median([t for t, _ in keep])), "n": len(keep),
    }


def deskew_river_band(img, H, side, mult=1.8, pad_x=0.15):
    """Deskew using an ORIENTED tray homography (see _orient_river_ward — +Y in
    H's output already means 'toward camera'), extending the canvas downward
    only to reach the near seat's river. Returns the extended warp: rows
    [0,side) are the tray; rows [side, side*(1+mult)) are the (homography-
    extrapolated, so accuracy degrades with distance) river band. pad_x adds a
    small x-margin since the river can run wider than the tray."""
    H = np.asarray(H, float)
    px = int(round(pad_x * side))
    T = np.array([[1, 0, px], [0, 1, 0], [0, 0, 1]], float)
    out_w = side + 2 * px
    out_h = int(round(side * (1 + mult)))
    return cv2.warpPerspective(img, T @ H, (out_w, out_h)), px


def deskew(img, H, side, pad=0.0):
    """Apply a calibrated homography to rectify a frame top-down. pad>0 adds a
    margin (fraction of side) so the surrounding river shows around the tray."""
    H = np.asarray(H, float)
    p = int(round(pad * side))
    T = np.array([[1, 0, p], [0, 1, p], [0, 0, 1]], float)
    return cv2.warpPerspective(img, T @ H, (side + 2 * p, side + 2 * p))


# ---- seat clustering ------------------------------------------------------

DEFAULT_SEAT_GEOMETRY_MAP = {"N": "N", "low_cy": "W", "dominant": "S", "other": "E"}


def _empty_bucket():
    return {"frames": [], "tilt_deg": None, "shoulder": None}


def _pack_bucket(frames_with_angle):
    """Build a bucket dict from [(t, bgr, tilt_angle), ...]. tilt_deg is the
    bucket's median haipai-row tilt (the same signal used to cluster in the
    first place — kept here so callers don't have to recompute it). shoulder
    is derived from its sign: negative = over-left-shoulder camera, positive =
    over-right-shoulder. This is NOT a geometric derivation — the sign
    convention only holds because it was confirmed against known frames this
    session; if that confirmation is ever found wrong, both this and every
    caller relying on "shoulder" need re-checking together."""
    if not frames_with_angle:
        return _empty_bucket()
    tilt = float(np.median([a for _, _, a in frames_with_angle]))
    return {
        "frames": [(t, im) for t, im, a in frames_with_angle],
        "tilt_deg": round(tilt, 1),
        "shoulder": "left" if tilt < 0 else "right",
    }


def _cluster_cameras(frames, cfg):
    """Split over-shoulder frames into 4 STABLE camera clusters by geometry alone.
    frames: list of (t, bgr). Returns {cluster: bucket}, bucket =
    {"frames": [(t, bgr), ...], "tilt_deg": float, "shoulder": "left"|"right"}.

    Clustering (repeatable across broadcasts with 4 fixed over-shoulder mounts —
    same camera always lands in the same cluster):
      - "N"       = strongly positive haipai-row tilt (the one opposite-tilt camera)
      - "low_cy"  = of the negative-tilt cameras, the one whose compass sits
                    higher in-frame (smaller cy)
      - "dominant"/"other" = the remaining two negative-tilt, same-height cameras,
                    split by self-NCC: the majority-shot camera scores high

    tilt_deg/shoulder are per-camera-VIEW properties (they affect how to read
    the hand, river, wall — everything in that camera's frame, not just the
    tray), which is why they're attached at the bucket level here rather than
    e.g. folded into compass calibration (a tray-specific concept).

    IMPORTANT: cluster labels are NOT seat identities. Which physical seat each
    cluster belongs to depends on camera mount handedness, which varies per
    broadcast — see seat_frames() for the label -> true-seat mapping."""
    pos_min = (cfg or {}).get("pass3", {}).get("pos_angle_min", 18)
    tagged = []
    for t, im in frames:
        try:
            q, _, _ = row_quad(im, 13)
            a = np.degrees(np.arctan2(q[1][1] - q[0][1], q[1][0] - q[0][0]))
            cy = q.reshape(4, 2).mean(0)[1]
        except Exception:
            continue
        if abs(a) < 8:
            continue
        tagged.append((t, im, float(a), float(cy)))
    N_ta = [(t, im, a) for t, im, a, cy in tagged if a > pos_min]
    neg = [(t, im, a, cy) for t, im, a, cy in tagged if a < -10]
    out = {"N": _pack_bucket(N_ta), "low_cy": _empty_bucket(),
           "dominant": _empty_bucket(), "other": _empty_bucket()}
    if len(neg) >= 4:
        cys = np.array([[c] for _, _, _, c in neg], np.float32)
        _, lab, cen = cv2.kmeans(
            cys, 2, None,
            (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.3),
            8, cv2.KMEANS_PP_CENTERS)
        lab = lab.ravel()
        low = int(np.argmin(cen.ravel()))               # smaller cy = higher on screen
        low_cy_ta = [(t, im, a) for (t, im, a, _), l in zip(neg, lab) if l == low]
        rest = [(t, im, a) for (t, im, a, _), l in zip(neg, lab) if l != low]
        out["low_cy"] = _pack_bucket(low_cy_ta)
        if rest:
            sm = np.median(np.stack([im.astype(np.float32) for _, im, _ in rest]), 0).astype(np.uint8)
            smr = _region(sm)
            dominant_ta = [(t, im, a) for t, im, a in rest if _ncc(smr, _region(im)) >= 0.65]
            other_ta = [(t, im, a) for t, im, a in rest if _ncc(smr, _region(im)) < 0.65]
            out["dominant"] = _pack_bucket(dominant_ta)
            out["other"] = _pack_bucket(other_ta)
    return out


def seat_frames(frames, cfg):
    """Split over-shoulder frames into the 4 true seats N/W/S/E.
    frames: list of (t, bgr). Returns {seat: bucket}, bucket =
    {"frames": [(t, bgr), ...], "tilt_deg": float, "shoulder": "left"|"right"}.

    Clusters cameras by geometry (_cluster_cameras — stable, repeatable), then
    maps each cluster to its TRUE seat via cfg["pass3"]["seat_geometry_map"]
    (cluster label -> seat letter), defaulting to DEFAULT_SEAT_GEOMETRY_MAP.
    That default is only a guess — camera mount handedness is NOT guaranteed
    consistent across broadcasts, so it MUST be confirmed and overridden per
    broadcast (cross-check each cluster's nameplate / dealer-highlight against
    cfg["pass3"]["seats"]; see README). Getting this wrong silently mislabels
    every downstream seat-keyed result (calibration, hand counts, riichi)."""
    clusters = _cluster_cameras(frames, cfg)
    remap = dict(DEFAULT_SEAT_GEOMETRY_MAP)
    remap.update((cfg or {}).get("pass3", {}).get("seat_geometry_map", {}))
    out = {"N": _empty_bucket(), "W": _empty_bucket(), "S": _empty_bucket(), "E": _empty_bucket()}
    for cluster_label, bucket in clusters.items():
        seat = remap.get(cluster_label, cluster_label)
        out[seat] = bucket
    return out
