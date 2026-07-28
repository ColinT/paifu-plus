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
    W = mask.shape[1]
    cand = []
    for i in range(1, ncomp):
        if stats[i, cv2.CC_STAT_AREA] < 0.0015 * mask.size:
            continue
        pts = np.column_stack(np.where(lab == i)[::-1]).astype(np.float32)
        (_, _), (w, h), _ = cv2.minAreaRect(pts)
        long, short = max(w, h), max(1.0, min(w, h))
        if long < min_long_frac * W:
            continue
        cand.append({"id": i, "ratio": round(long / short, 1),
                     "long": int(long), "short": int(short)})
    # Aspect ~3N/4 alone also matches the walls, so among aspect-plausible blobs
    # pick the one with the LARGEST tiles (short side) — the near hand is closest
    # to the camera, so its tiles are biggest.
    plausible = [c for c in cand if 0.6 * target <= c["ratio"] <= 1.5 * target]
    pool = plausible or cand
    best = max(pool, key=lambda c: c["short"]) if pool else None
    comp = ((lab == best["id"]).astype("uint8") * 255) if best else None
    return comp, {"target": round(target, 1), "picked": best, "candidates": cand}


CELL_W, CELL_H = 44, 64  # deskewed per-tile size (tile face aspect ~ w<h)


def _fit_line(x, y, iters=3):
    """Least-squares line y=mx+b, re-fit on inliers to reject background outliers."""
    m, b = np.polyfit(x, y, 1)
    for _ in range(iters):
        res = np.abs(y - (m * x + b))
        keep = res <= max(4.0, 2.0 * np.median(res))
        if keep.sum() < 3:
            break
        m, b = np.polyfit(x[keep], y[keep], 1)
    return m, b


def row_quad(mask, n_tiles):
    """4 corners (TL,TR,BR,BL) of the tile row.

    The BOTTOM edge is reliable (a reaching hand/arm merges into the TOP of the
    blob, not the bottom), so we anchor on it: fit the bottom line robustly, take
    the x-extent from its inliers (this also drops a merged nameplate whose bottom
    sits at a different y), then derive the expected tile height from the known N
    and the 3:4 tile aspect (height = 4/3 * width, width = row_len / N). The TOP
    edge is fitted only over columns whose measured height is plausible (<=1.5x
    expected) — which rejects the arm, where the top balloons upward — and we fall
    back to a parallel edge if too little survives. Two fitted lines keep the
    perspective (trapezoid), not just a parallelogram."""
    xr, yt, yb = [], [], []
    for x in range(mask.shape[1]):
        ys = np.where(mask[:, x] > 0)[0]
        if len(ys):
            xr.append(x); yt.append(ys[0]); yb.append(ys[-1])
    xr, yt, yb = np.array(xr, float), np.array(yt, float), np.array(yb, float)
    # Keep columns whose height is near the median (the tile row) and fit both
    # edges + the x-extent from those. NOTE: this reduces — but does not fully
    # solve — contamination from a reaching arm, which can form its own
    # plausible-height band beside the row on the full frame. For a clean result
    # use --quad; robust auto-isolation of the arm needs skin removal or a learned
    # detector (see README).
    h = yb - yt
    good = h <= 1.5 * np.median(h)
    if good.sum() < 3:
        good = np.ones_like(h, bool)
    xg = xr[good]
    xs, xe = float(xg.min()), float(xg.max())
    mt, bt = _fit_line(xg, yt[good])
    mb, bb = _fit_line(xg, yb[good])
    quad = np.float32([[xs, mt * xs + bt], [xe, mt * xe + bt],
                       [xe, mb * xe + bb], [xs, mb * xs + bb]])
    return quad, (xs, xe)


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


def deskew_split(img, quad, n_tiles):
    """Warp the haipai quad to a rectangle and cut it into n_tiles equal columns.
    quad is (TL,TR,BR,BL) in image pixels. Returns (crops, warp)."""
    W, H = CELL_W * n_tiles, CELL_H
    dst = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    warp = cv2.warpPerspective(img, cv2.getPerspectiveTransform(quad, dst), (W, H))
    return [warp[:, i * CELL_W:(i + 1) * CELL_W] for i in range(n_tiles)], warp


def frame_score(img, n_tiles):
    """How cleanly this frame's haipai segments. The hand is a MOVING object and
    the tiles are ~static, so across nearby frames the frame where the hand is
    clear of the row is the one whose picked blob is most row-shaped: aspect
    closest to 3N/4 (a touching hand merges in and distorts the ratio). Returns
    (score, info); higher is cleaner."""
    comp, info = select_haipai(close_row(whitish(img)), n_tiles)
    if comp is None or info.get("picked") is None:
        return -1e9, info
    return -abs(info["picked"]["ratio"] - info["target"]), info


def scan_best_frame(source, at, half, step, n_tiles):
    """Sample frames in [at-half, at+half] every `step` s; return (best_img, t,
    scores). Picks the cleanest by frame_score — a temporal, colour-free way to
    catch a moment when the hand isn't touching the tiles."""
    times, t = [], at - half
    while t <= at + half + 1e-6:
        times.append(round(t, 2)); t += step
    best, scores = None, []
    for tt in times:
        img = source.grab(tt)
        s, info = frame_score(img, n_tiles)
        scores.append((tt, round(s, 1), info.get("picked")))
        if best is None or s > best[1]:
            best = (img, s, tt)
    return best[0], best[2], scores


def read_hand(lib_orb, crop_bgr, n_tiles):
    """Classify each of the n_tiles deskewed cells. Returns (codes, crops, meta)."""
    crops, mask, quad, warp, cand = segment_tiles(crop_bgr, n_tiles)
    codes = [tiles.classify_orb(t, lib_orb) for t in crops]
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
            img, chosen, scores = scan_best_frame(source, args.at, args.scan, args.scan_step, args.count)
            if args.debug:
                print(f"scan: chose t={chosen} from {len(scores)} frames")
                for tt, s, pk in scores:
                    print(f"   t={tt} score={s} picked={pk}")
            args.at = chosen  # deep links point at the frame actually used
        else:
            img = source.grab(args.at)

    h, w = img.shape[:2]
    sx, sy = w / cfg["ref_width"], h / cfg["ref_height"]
    lib_orb = tiles.load_library_orb(args.tiles)
    hand_crop = None

    if args.quad:
        # operator-anchored corners -> reliable deskew, no auto row-detection
        p = [float(v) for v in args.quad.split(",")]
        quad = np.float32([[p[i] * sx, p[i + 1] * sy] for i in range(0, 8, 2)])
        tile_crops, warp = deskew_split(img, quad, args.count)
        codes = [tiles.classify_orb(t, lib_orb) for t in tile_crops]
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
        codes, tile_crops, meta = read_hand(lib_orb, hand_crop, args.count)
        if args.debug:
            print(f"debug: aspect target={meta['cand']['target']} picked={meta['cand']['picked']}")
            for c in meta["cand"]["candidates"]:
                print(f"   cand {c}")

    out_dir = os.path.dirname(args.out) if args.out else "out"
    unlabeled = os.path.join(out_dir, "unlabeled")
    hand, questions = [], []
    for i, ((code, inliers), tc) in enumerate(zip(codes, tile_crops)):
        if code is None:
            os.makedirs(unlabeled, exist_ok=True)
            p = os.path.join(unlabeled, f"hand_{args.seat}_{i}.png")
            cv2.imwrite(p, tc)
            questions.append({"kind": "tile", "seat": args.seat, "index": i,
                              "prompt": f"Unrecognised hand tile #{i} (ORB {inliers}). "
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
