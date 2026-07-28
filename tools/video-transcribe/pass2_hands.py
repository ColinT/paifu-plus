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


def whitish(bgr):
    """Mask of bright tile-face pixels (white faces, not orange edges / blue felt)."""
    b, g, r = cv2.split(bgr.astype(int))
    m = (r > 150) & (g > 150) & (b > 135)
    m = (m.astype("uint8")) * 255
    return cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), "uint8"))


def largest_component(mask):
    """Keep only the biggest blob — the tile row, dropping the separate white
    sponsor logo / nameplate that also pass the whitish test."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return mask
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return ((lab == biggest).astype("uint8")) * 255


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


def row_quad(mask):
    """4 corners (TL,TR,BR,BL) of the tile row, from its top/bottom edge lines.
    Seams are vertical (camera setup) so the left/right edges are the x-extent;
    top and bottom are fitted lines, so a converging (perspective) row is a
    general quadrilateral, not just a parallelogram."""
    cols = mask.sum(axis=0).astype(float)
    present = np.where(cols > 0.15 * cols.max())[0]
    xs, xe = int(present.min()), int(present.max())
    xr, yt, yb = [], [], []
    for x in range(xs, xe + 1):
        ys = np.where(mask[:, x] > 0)[0]
        if len(ys):
            xr.append(x); yt.append(ys[0]); yb.append(ys[-1])
    xr = np.array(xr, float)
    mt, bt = _fit_line(xr, np.array(yt, float))  # top edge line (outlier-robust)
    mb, bb = _fit_line(xr, np.array(yb, float))  # bottom edge line
    quad = np.float32([[xs, mt * xs + bt], [xe, mt * xe + bt],
                       [xe, mb * xe + bb], [xs, mb * xs + bb]])
    return quad, (xs, xe)


def segment_tiles(crop_bgr, n_tiles):
    """Deskew the haipai to a rectangle, then split into n_tiles equal columns.

    Warping the row's quadrilateral to a rectangle removes tilt AND perspective
    in one step, so the split is a trivial equal division and every tile crop is
    upright at a normalized scale (much friendlier to recognition)."""
    mask = largest_component(whitish(crop_bgr))
    if mask.max() == 0:
        return [], mask, None, None
    quad, _ = row_quad(mask)
    W, H = CELL_W * n_tiles, CELL_H
    dst = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    warp = cv2.warpPerspective(crop_bgr, cv2.getPerspectiveTransform(quad, dst), (W, H))
    crops = [warp[:, i * CELL_W:(i + 1) * CELL_W] for i in range(n_tiles)]
    return crops, mask, quad, warp


def deskew_split(img, quad, n_tiles):
    """Warp the haipai quad to a rectangle and cut it into n_tiles equal columns.
    quad is (TL,TR,BR,BL) in image pixels. Returns (crops, warp)."""
    W, H = CELL_W * n_tiles, CELL_H
    dst = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    warp = cv2.warpPerspective(img, cv2.getPerspectiveTransform(quad, dst), (W, H))
    return [warp[:, i * CELL_W:(i + 1) * CELL_W] for i in range(n_tiles)], warp


def read_hand(lib_orb, crop_bgr, n_tiles):
    """Classify each of the n_tiles deskewed cells. Returns (codes, crops, meta)."""
    crops, mask, quad, warp = segment_tiles(crop_bgr, n_tiles)
    codes = [tiles.classify_orb(t, lib_orb) for t in crops]
    return codes, crops, {"quad": quad, "warp": warp}


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
        region = ([int(v) for v in args.region.split(",")] if args.region
                  else cfg["regions"].get("hand_band"))
        if not region:
            raise SystemExit("no hand region: pass --quad, --region x,y,w,h, or add regions.hand_band")
        R = scale_region(region, w, h, cfg["ref_width"], cfg["ref_height"])
        hand_crop = crop(img, R)
        codes, tile_crops, meta = read_hand(lib_orb, hand_crop, args.count)

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
