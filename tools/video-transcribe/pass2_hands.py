"""
Pass 2 — read a player's hand from a close-up frame.

The broadcast cuts to each seat's hand in close-up (the on-table nameplate says
whose). Given such a frame + the seat, this segments the row of face-up tiles and
classifies each with the ORB matcher over `tiles/`, escalating unrecognised tiles
as labeled crops (which grow the library).

Segmentation: the hand sits on the felt at an angle and recedes in perspective,
so we (1) mask bright tile faces, (2) rectify the row to horizontal using its
dominant orientation, (3) split into tiles at the dark gaps between faces
(gap-based, so varying tile widths from perspective are fine).

Recognition uses ORB (rotation/scale robust) — the hand is tilted and perspective-
skewed, so the overlay's fixed-scale template matcher would not do.

Status: recognition + the labeling loop are solid; segmentation is calibrated
per-broadcast and is the part that most benefits from `--debug` tuning. Steep
close-ups (large tilt) need the rectify step; near-horizontal hands segment as-is.
"""
from __future__ import annotations

import argparse
import json
import os

import cv2
import numpy as np

import tiles
from frames import make_source
from pass0_overlay import crop, scale_region, source_link

SEATS = ("E", "S", "W", "N")


_CLAHE = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))


def whitish(bgr):
    """Mask of white tile-face pixels, chosen ADAPTIVELY per frame (no fixed
    0-255 cutoffs).

    Discriminator is 'whiteness' = min(R,G,B): a pixel is only white if ALL
    channels are high, which rejects the bluish felt (low R) and the orange edge
    (low B) — a plain HSV low-sat test fails here because this felt is only weakly
    saturated and merges with the tiles. The level is adaptive: the full frame is
    trimodal (dark foreground / felt / bright tiles), so we take the brightest
    class of a 3-way multi-Otsu (with CLAHE evening out exposure so shadowed tiles
    survive), falling back to binary Otsu if multi-Otsu can't split."""
    mn = _CLAHE.apply(bgr.min(axis=2).astype("uint8"))
    try:
        from skimage.filters import threshold_multiotsu
        t = threshold_multiotsu(mn, classes=3)
        m = ((mn > t[-1]).astype("uint8")) * 255
    except Exception:
        _, m = cv2.threshold(mn, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), "uint8"))


def close_row(mask):
    """Bridge the thin dark gaps between adjacent tiles so the row is one blob."""
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_RECT, (17, 5)))


def select_haipai(mask, n_tiles, min_long_frac=0.20):
    """Pick the blob shaped like a haipai. A row of N tiles (each 3 wide : 4 high)
    has overall aspect ~3N/4, so we score each component's rotated-box long/short
    ratio against that target — a nameplate (~4:1) or logo (~1:1) won't match.
    Returns (component_mask | None, candidates)."""
    target = 3.0 * n_tiles / 4.0
    ncomp, lab, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    H, W = mask.shape[:2]
    cand = []
    for i in range(1, ncomp):
        if stats[i, cv2.CC_STAT_AREA] < 0.0015 * mask.size:
            continue
        bottom = int(stats[i, cv2.CC_STAT_TOP] + stats[i, cv2.CC_STAT_HEIGHT])
        if bottom > 0.85 * H:              # bottom score-bar overlay, not a hand
            continue
        pts = np.column_stack(np.where(lab == i)[::-1]).astype(np.float32)
        (_, _), (w, h), _ = cv2.minAreaRect(pts)
        long, short = max(w, h), max(1.0, min(w, h))
        if long < min_long_frac * W:
            continue
        cand.append({"id": i, "ratio": round(long / short, 1), "bottom": bottom,
                     "long": int(long), "short": int(short)})
    # Aspect ~3N/4 alone also matches the walls, so among aspect-plausible blobs
    # pick the LOWEST one on screen — the near (player's own) hand is closest to
    # the camera, i.e. at the bottom of the frame; walls sit higher up.
    plausible = [c for c in cand if 0.6 * target <= c["ratio"] <= 1.5 * target]
    pool = plausible or cand
    best = max(pool, key=lambda c: c["bottom"]) if pool else None
    comp = ((lab == best["id"]).astype("uint8") * 255) if best else None
    return comp, {"target": round(target, 1), "picked": best, "candidates": cand}


CELL_W, CELL_H = 44, 64  # deskewed per-tile size (tile face aspect ~ w<h)


def _order_quad(p):
    """Order 4 points TL,TR,BR,BL (works for a row that is wider than tall)."""
    p = np.array(p, float)
    p = p[np.argsort(p[:, 0])]                        # by x: two left, two right
    (tl, bl) = p[:2][np.argsort(p[:2, 1])]            # left: top, bottom
    (tr, br) = p[2:][np.argsort(p[2:, 1])]            # right: top, bottom
    return np.float32([tl, tr, br, bl])


def _fill_holes(m):
    """Fill the dark character islands inside the white tile faces."""
    ff = m.copy()
    h, w = m.shape
    cv2.floodFill(ff, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 255)
    return m | cv2.bitwise_not(ff)


def row_quad(mask, n_tiles):
    """Reconstruct the tile row's FRONT (symbol) face as a rectangular prism seen
    in perspective — a bounding rectangle would swallow the top and end faces.

    Clean the shape (fill character holes, shave the thin inter-tile fingers),
    then: the lowest point is the near front-bottom corner and the highest is the
    opposite (back-top) corner. Which side the lowest sits relative to the highest
    tells us the camera side; the near END face there gives the prism's height and
    thickness. From those + the two opposite corners we rebuild the front face,
    with equal-height left/right edges."""
    m = _fill_holes(mask)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    nc, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    if nc > 1:
        m = ((lab == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))) * 255).astype("uint8")
    found = cv2.findNonZero(m)
    pts = (found if found is not None else cv2.findNonZero(mask)).reshape(-1, 2).astype(float)

    p_low = pts[np.argmax(pts[:, 1])]        # near front-bottom corner
    p_high = pts[np.argmin(pts[:, 1])]       # topmost — only tells us the camera side
    cam_left = p_low[0] < p_high[0]
    # near END face (on the low side) -> the prism height (tile face height)
    edge_x = pts[:, 0].min() if cam_left else pts[:, 0].max()
    col = pts[np.abs(pts[:, 0] - edge_x) <= 3]
    H = col[:, 1].max() - col[:, 1].min()
    # the far front-top corner is the FAR-most point of the shape (rightmost when
    # the camera is left) — that sits on the last tile's top corner, so no
    # extrapolation is needed; the far bottom is one tile-height straight down.
    far_top = pts[np.argmax(pts[:, 0])] if cam_left else pts[np.argmin(pts[:, 0])]
    ft_near = p_low + [0, -H]                 # front-top on the near end
    fb_far = far_top + [0, H]                 # front-bottom on the far end
    quad = _order_quad(np.array([ft_near, far_top, fb_far, p_low]))
    return quad, (float(quad[:, 0].min()), float(quad[:, 0].max()))


def segment_tiles(crop_bgr, n_tiles):
    """Deskew the haipai to a rectangle, then split into n_tiles equal columns.

    Warping the row's quadrilateral to a rectangle removes tilt AND perspective
    in one step, so the split is a trivial equal division and every tile crop is
    upright at a normalized scale (much friendlier to recognition)."""
    mask = close_row(whitish(crop_bgr))
    comp, cand = select_haipai(mask, n_tiles)
    if comp is None:
        return [], mask, None, None, cand
    quad, _ = row_quad(comp, n_tiles)
    crops, warp = deskew_split(crop_bgr, quad, n_tiles)
    return crops, comp, quad, warp, cand


def _dp_borders(dark, n_tiles, lam=2.0):
    """Solve for the n_tiles-1 borders by dynamic programming: minimize
    Sum darkness(border) + lam * (width deviation / pitch)^2. So each border is
    pulled toward a dark VALLEY (a white seam) while the quadratic term keeps the
    tiles ~evenly spaced. Where a seam is weak (e.g. two dense souzu whose gap
    nearly fills in), the spacing prior gracefully holds the border near its
    expected place instead of snapping to a wrong valley. Each border is searched
    only within +/-0.6 pitch of its expected position (keeps it ordered and fast)."""
    W = len(dark)
    d = (dark - dark.min()) / (dark.max() - dark.min() + 1e-9)   # 0=white, 1=symbol
    pitch = W / n_tiles
    win = int(0.6 * pitch)
    cand = [np.unique(np.clip(np.arange(round(i * pitch) - win, round(i * pitch) + win + 1), 1, W - 1))
            for i in range(1, n_tiles)]
    prev_pos, prev_cost, ptr = np.array([0.0]), np.array([0.0]), []
    for i in range(n_tiles - 1):
        xi = cand[i].astype(float)
        span = lam * ((xi[None, :] - prev_pos[:, None] - pitch) / pitch) ** 2
        span[xi[None, :] <= prev_pos[:, None]] = 1e18            # keep borders in order
        tot = prev_cost[:, None] + span
        bp = np.argmin(tot, axis=0)
        prev_cost = tot[bp, np.arange(len(xi))] + d[xi.astype(int)]
        ptr.append((xi, bp)); prev_pos = xi
    final = prev_cost + lam * ((W - prev_pos - pitch) / pitch) ** 2
    j, b = int(np.argmin(final)), []
    for i in reversed(range(n_tiles - 1)):
        xi, bp = ptr[i]; b.append(int(xi[j])); j = int(bp[j])
    return [0] + sorted(b) + [W]


def split_by_symbols(warp, n_tiles):
    """Cut the deskewed strip at the real tile seams, not on a blind even grid.

    Residual skew makes an even N-split straddle boundaries — a cell ends up half
    one tile, half the next, and classifies to neither. The column-darkness profile
    dips at the white seams between tiles and rises over the symbols; a DP solver
    (`_dp_borders`) places the n_tiles-1 borders at those valleys under a soft
    equal-spacing prior."""
    H, W = warp.shape[:2]
    gray = cv2.cvtColor(warp, cv2.COLOR_BGR2GRAY).astype(float)
    dark = 255 - gray[int(0.18 * H):int(0.82 * H), :].mean(axis=0)
    dark = np.convolve(dark, np.ones(7) / 7, mode="same")
    borders = _dp_borders(dark, n_tiles)
    return [cv2.resize(warp[:, borders[i]:borders[i + 1]], (CELL_W, CELL_H)) for i in range(n_tiles)]


def deskew_split(img, quad, n_tiles):
    """Warp the haipai quad to a rectangle and cut it at the tile symbols.
    quad is (TL,TR,BR,BL) in image pixels. Returns (crops, warp)."""
    W, H = CELL_W * n_tiles, CELL_H
    dst = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    warp = cv2.warpPerspective(img, cv2.getPerspectiveTransform(quad, dst), (W, H))
    return split_by_symbols(warp, n_tiles), warp


def _motion_band(shape):
    """Lower-centre region where the near hand sits (relative to frame size)."""
    h, w = shape[:2]
    return (slice(int(0.45 * h), int(0.78 * h)), slice(int(0.28 * w), int(0.88 * w)))


def scan_median(source, at, half, step, n_tiles):
    """Colour-free hand removal via the temporal dimension.

    The hand MOVES and the tiles are ~static, so the per-pixel median over nearby
    frames averages the transient hand away and keeps the tiles. We sample a
    window around the operator's `at` (a hint, not gospel), measure per-frame
    motion (deviation from the median) in the near-hand band, keep the STILL
    frames, and return the median over just those — a clean, hand-free image to
    segment. Robust to gloves / any skin tone (unlike skin-colour subtraction).

    Returns (median_img, best_t, per-frame motions)."""
    times, t = [], at - half
    while t <= at + half + 1e-6:
        times.append(round(t, 2)); t += step
    imgs = [source.grab(tt) for tt in times]
    stack = np.stack(imgs).astype(np.float32)
    med0g = cv2.cvtColor(np.median(stack, axis=0).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
    band = _motion_band(imgs[0].shape)
    motions = [float(np.abs(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32) - med0g)[band].mean())
               for im in imgs]
    lo, hi = min(motions), np.median(motions)
    thr = lo + 0.5 * (hi - lo)                       # keep the low-motion (settled) frames
    still = [im for im, m in zip(imgs, motions) if m <= thr]
    med = np.median(np.stack(still).astype(np.float32) if len(still) >= 3 else stack, axis=0)
    best_t = times[int(np.argmin(motions))]
    return med.astype(np.uint8), best_t, list(zip(times, [round(m, 1) for m in motions]))


# Deskewed cells are upright and fixed-scale, so the normalized-correlation
# template matcher (not ORB) is the right classifier — cross-frame matches land
# at ~0.95+, wrong tiles well below, so this threshold cleanly flags unknowns.
TILE_THRESH = 0.85


def read_hand(lib, crop_bgr, n_tiles):
    """Classify each of the n_tiles deskewed cells. Returns (codes, crops, meta)."""
    crops, mask, quad, warp, cand = segment_tiles(crop_bgr, n_tiles)
    codes = [tiles.classify(t, lib, thresh=TILE_THRESH) for t in crops]
    return codes, crops, {"quad": quad, "warp": warp, "cand": cand}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--url")
    ap.add_argument("--video")
    ap.add_argument("--image", help="classify a local frame PNG directly")
    ap.add_argument("--at", type=float, help="timestamp (s) for --url/--video")
    ap.add_argument("--clip-start", type=float, default=0.0)
    ap.add_argument("--seat", type=int, help="0-3 whose hand this is (else unknown)")
    ap.add_argument("--count", type=int, default=13, help="tile count (14 for the dealer's haipai)")
    ap.add_argument("--region", help="hand-band bbox 'x,y,w,h' (ref coords); else config.hand_band")
    ap.add_argument("--quad", help="operator-supplied haipai corners in ref coords, "
                                   "TL,TR,BR,BL as 'x0,y0,x1,y1,x2,y2,x3,y3' (reliable deskew)")
    ap.add_argument("--tiles", default="tiles")
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--scan", type=float, default=0.0,
                    help="±seconds to scrub around --at for the cleanest (hand-free) frame")
    ap.add_argument("--scan-step", type=float, default=0.3, help="scan sample interval (s)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--debug", action="store_true", help="save mask/segmentation viz")
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)

    if args.image:
        img = cv2.imread(args.image)
    else:
        url = args.url
        if not url and not args.video:
            src = cfg.get("source", {})
            if src.get("type") == "youtube" and src.get("id"):
                url = f"https://www.youtube.com/watch?v={src['id']}"
        source = make_source(url=url, video=args.video, clip_start=args.clip_start, height=args.height)
        if args.scan > 0:
            img, chosen, motions = scan_median(source, args.at, args.scan, args.scan_step, args.count)
            if args.debug:
                print(f"scan: temporal median over {len(motions)} frames; stillest t={chosen}")
                for tt, m in motions:
                    print(f"   t={tt} motion={m}")
            args.at = chosen  # deep links point at the settled moment
        else:
            img = source.grab(args.at)

    h, w = img.shape[:2]
    sx, sy = w / cfg["ref_width"], h / cfg["ref_height"]
    lib = tiles.load_library(args.tiles)
    hand_crop = None

    if args.quad:
        # operator-anchored corners -> reliable deskew, no auto row-detection
        p = [float(v) for v in args.quad.split(",")]
        quad = np.float32([[p[i] * sx, p[i + 1] * sy] for i in range(0, 8, 2)])
        tile_crops, warp = deskew_split(img, quad, args.count)
        codes = [tiles.classify(t, lib, thresh=TILE_THRESH) for t in tile_crops]
        meta = {"quad": quad, "warp": warp}
    else:
        # No crop by default — the haipai fills much of the frame, and a fixed box
        # can clip it. The aspect filter finds the haipai among all bright blobs.
        # --region is an optional manual restriction.
        if args.region:
            R = scale_region([int(v) for v in args.region.split(",")], w, h,
                             cfg["ref_width"], cfg["ref_height"])
            hand_crop = crop(img, R)
        else:
            hand_crop = img
        codes, tile_crops, meta = read_hand(lib, hand_crop, args.count)
        if args.debug:
            print(f"debug: aspect target={meta['cand']['target']} picked={meta['cand']['picked']}")
            for c in meta["cand"]["candidates"]:
                print(f"   cand {c}")

    out_dir = os.path.dirname(args.out) if args.out else "out"
    unlabeled = os.path.join(out_dir, "unlabeled")
    hand, questions = [], []
    for i, ((code, score), tc) in enumerate(zip(codes, tile_crops)):
        if code is None:
            os.makedirs(unlabeled, exist_ok=True)
            p = os.path.join(unlabeled, f"hand_{args.seat}_{i}.png")
            cv2.imwrite(p, tc)
            questions.append({"kind": "tile", "seat": args.seat, "index": i,
                              "prompt": f"Unrecognised hand tile #{i} (best match {score}). "
                                        f"Label: python tiles.py add --code <t> --image {p}",
                              "link": source_link(cfg, args.at) if args.at else None})
            hand.append(None)
        else:
            hand.append(code)

    if args.debug and meta["warp"] is not None:
        os.makedirs(out_dir, exist_ok=True)
        viz = (hand_crop if hand_crop is not None else img).copy()
        cv2.polylines(viz, [meta["quad"].astype(int)], True, (0, 0, 255), 2)
        cv2.imwrite(os.path.join(out_dir, "hand_quad.png"), viz)
        warp = meta["warp"].copy()
        for i in range(1, args.count):
            cv2.line(warp, (i * CELL_W, 0), (i * CELL_W, CELL_H), (0, 0, 255), 1)
        cv2.imwrite(os.path.join(out_dir, "hand_deskewed.png"), warp)
        print(f"debug: deskewed {warp.shape[1]}x{warp.shape[0]}, {args.count} cells -> {out_dir}")

    result = {"seat": SEATS[args.seat] if args.seat is not None else None,
              "tiles_found": len(tile_crops), "hand": hand,
              "recognised": sum(1 for c in hand if c is not None), "questions": questions}
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        os.makedirs(out_dir, exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
    print(text)


if __name__ == "__main__":
    main()
