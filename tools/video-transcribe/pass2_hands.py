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


def rectify(crop_bgr, mask):
    """Rotate crop+mask so the tile row is horizontal (via the mask's principal axis)."""
    pts = cv2.findNonZero(mask)
    if pts is None or len(pts) < 50:
        return crop_bgr, mask, 0.0
    (cx, cy), (w, h), ang = cv2.minAreaRect(pts)
    if w < h:  # normalize so angle refers to the long axis
        ang += 90
    if ang > 45:
        ang -= 90
    M = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
    hgt, wid = mask.shape
    rc = cv2.warpAffine(crop_bgr, M, (wid, hgt), flags=cv2.INTER_LINEAR)
    rm = cv2.warpAffine(mask, M, (wid, hgt), flags=cv2.INTER_NEAREST)
    return rc, rm, float(ang)


def segment_tiles(crop_bgr, min_w_frac=0.02):
    """Return ordered per-tile sub-crops (BGR) from a hand-region crop."""
    mask = largest_component(whitish(crop_bgr))
    rc, rm, ang = rectify(crop_bgr, mask)
    rows = rm.sum(axis=1)
    if rows.max() == 0:
        return [], rc, rm, ang, [], (0, 0)
    band = np.where(rows > 0.3 * rows.max())[0]
    y0, y1 = int(band.min()), int(band.max())
    cols = rm[y0:y1 + 1, :].sum(axis=0).astype(float)
    if cols.max() == 0:
        return [], rc, rm, ang, [], (y0, y1)
    # horizontal extent of the row, then split at seams (local minima of the
    # face-mask column profile) — the thin dark gaps between touching tiles.
    present = np.where(cols > 0.15 * cols.max())[0]
    xs, xe = int(present.min()), int(present.max())
    k = max(3, int(0.01 * rc.shape[1]))
    sm = np.convolve(cols, np.ones(k) / k, mode="same")
    minw = max(6, int(min_w_frac * rc.shape[1]))
    thr = 0.75 * sm[xs:xe + 1].max()
    seams = []
    for x in range(xs + 1, xe):
        if sm[x] < thr and sm[x] <= sm[x - 1] and sm[x] <= sm[x + 1]:
            if not seams or x - seams[-1] >= minw:
                seams.append(x)
    bounds = [xs] + seams + [xe]
    segs = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)
            if bounds[i + 1] - bounds[i] >= minw]
    tiles_out = [rc[max(0, y0 - 4):y1 + 4, a:b] for a, b in segs]
    return tiles_out, rc, rm, ang, segs, (y0, y1)


def read_hand(lib_orb, crop_bgr):
    """Classify each segmented tile. Returns (codes, per-tile crops, segs meta)."""
    seg = segment_tiles(crop_bgr)
    tiles_out, rc, rm, ang, segs, band = seg
    codes = []
    for t in tiles_out:
        code, inliers = tiles.classify_orb(t, lib_orb)
        codes.append((code, inliers))
    return codes, tiles_out, {"angle": ang, "segments": segs, "band": band, "rectified": rc}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--url")
    ap.add_argument("--video")
    ap.add_argument("--image", help="classify a local frame PNG directly")
    ap.add_argument("--at", type=float, help="timestamp (s) for --url/--video")
    ap.add_argument("--clip-start", type=float, default=0.0)
    ap.add_argument("--seat", type=int, help="0-3 whose hand this is (else unknown)")
    ap.add_argument("--region", help="hand-band bbox 'x,y,w,h' (ref coords); else config.hand_band")
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
    reg_spec = args.region or None
    if reg_spec:
        region = [int(v) for v in reg_spec.split(",")]
    else:
        region = cfg["regions"].get("hand_band")
        if not region:
            raise SystemExit("no hand region: pass --region x,y,w,h or add regions.hand_band to config")
    R = scale_region(region, w, h, cfg["ref_width"], cfg["ref_height"])
    hand_crop = crop(img, R)

    lib_orb = tiles.load_library_orb(args.tiles)
    codes, tile_crops, meta = read_hand(lib_orb, hand_crop)

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

    if args.debug:
        os.makedirs(out_dir, exist_ok=True)
        cv2.imwrite(os.path.join(out_dir, "hand_crop.png"), hand_crop)
        cv2.imwrite(os.path.join(out_dir, "hand_rectified.png"), meta["rectified"])
        viz = meta["rectified"].copy()
        y0, y1 = meta["band"]
        for (a, b) in meta["segments"]:
            cv2.rectangle(viz, (a, y0), (b, y1), (0, 0, 255), 2)
        cv2.imwrite(os.path.join(out_dir, "hand_segments.png"), viz)
        print(f"debug: angle={meta['angle']:.1f} segments={len(meta['segments'])} -> {out_dir}")

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
