"""
Pass 3 — discards / the river (河), as a turn SKELETON.

Standalone river-tile OCR is NOT viable in this broadcast (tiles ~40px, motion-
blur + compression: two identical honours in one frame correlate ~0.78 while
different tiles hit ~0.74-0.82 — no discriminative margin). So Pass 3 does NOT try
to read discard identities off the felt. Instead it produces the reliable parts:

  1. CALIBRATION — a per-camera top-down homography anchored on the central dice
     tray (see compass.py). Saved once per broadcast, reused for the whole game.
  2. RIICHI — per seat, from the persistent overlay badge (pass0_overlay), not from
     geometry (rotated-tile detection failed the same no-seam wall as the river).
     Persistence-filtered (>= min sightings) with the onset timestamp.
  3. DISCARD COUNT / TIMING — best-effort per-seat count of the near river over the
     window (append-only, so the delta between sightings is the robust signal).

Discard IDENTITIES come from the hand tracker (tedashi/tsumogiri, pass2/tracker)
for the near seat, and become timestamped HITL questions for opponents. This
matches the human-in-the-loop design.

Usage:
    # calibrate the 4 cameras from a round window and save the transforms
    python pass3_river.py --config config/ketteisen-wrc.json \
        --from 688 --to 900 --step 6 --calib-out out/e1_calib.json --out out/e1_river.json

    # or reuse a saved calibration
    python pass3_river.py --config config/ketteisen-wrc.json \
        --from 688 --to 900 --step 6 --calib out/e1_calib.json --out out/e1_river.json

Frames are fetched by timestamp (no full download). For offline testing pass
--frames-dir DIR to read *.png whose filename contains the timestamp instead.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re

import cv2
import numpy as np

import compass
import pass0_overlay as ov
from frames import make_source


def _load_cfg(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _modal_shape(out):
    """Keep only frames of the most common shape — the pipeline needs uniform full
    frames; stray crops/overhead stills of other sizes are dropped."""
    if not out:
        return out
    from collections import Counter
    shp = Counter(im.shape[:2] for _, im in out).most_common(1)[0][0]
    return [(t, im) for t, im in out if im.shape[:2] == shp]


def gather(source, cfg, args):
    """Return [(t, bgr)] over the window, from the video source or --frames-dir."""
    out = []
    if args.frames_dir:
        for f in sorted(glob.glob(os.path.join(args.frames_dir, "*.png"))):
            m = re.search(r"(\d+(?:\.\d+)?)", os.path.basename(f))
            if not m:
                continue
            t = float(m.group(1))
            if args.from_t <= t <= args.to_t:
                im = cv2.imread(f)
                if im is not None:
                    out.append((t, im))
        return _modal_shape(out)
    t = args.from_t
    while t <= args.to_t:
        try:
            out.append((float(t), source.grab(float(t))))
        except Exception:
            pass
        t += args.step
    return _modal_shape(out)


def read_riichi(frames, cfg, min_sightings=2):
    """Per-seat riichi from the overlay badge, persistence-filtered. Returns
    {seat_index: onset_t} for seats that declared, plus per-frame counts.

    Uses a stricter red-fraction than pass0's detect_riichi: a riichi badge fills a
    large patch of its cell (~30%), whereas a DEALER's red underline/marker bleeds a
    small amount (~2-7%) into the band every frame — at detect_riichi's 2% threshold
    the dealer reads as a permanent false-positive riichi. red_frac (config
    pass3.riichi_red_frac, default 0.10) sits in the gap and rejects the bleed."""
    ref_w, ref_h = cfg["ref_width"], cfg["ref_height"]
    reg = cfg["regions"].get("riichi")
    if reg is None:
        return {}, []
    red_frac = cfg.get("pass3", {}).get("riichi_red_frac", 0.10)
    seen = {i: [] for i in range(4)}
    timeline = []
    for t, im in sorted(frames, key=lambda x: x[0]):
        h, w = im.shape[:2]
        r = ov.scale_region(reg, w, h, ref_w, ref_h)
        counts, cell = ov._red_counts(im, r)
        thresh = max(30, red_frac * cell)
        flags = [c > thresh for c in counts]
        timeline.append((t, flags))
        for i, on in enumerate(flags):
            if on:
                seen[i].append(t)
    onsets = {i: min(ts) for i, ts in seen.items() if len(ts) >= min_sightings}
    return onsets, timeline


def near_river_extent(med, calib, cfg):
    """Best-effort near-seat discard extent from a camera's median, in tray widths.
    The near player's river sits between the tray and the camera (lower in the raw
    frame). We measure the tile-mask run just below the tray centroid, normalised by
    the tray side, as a coarse discard-progress signal (append-only: the DELTA over
    time is what matters, not the absolute). Returns a float (>=0) or None."""
    if calib is None:
        return None
    cx, cy = calib["centroid"]
    side = calib["side"]
    h, w = med.shape[:2]
    y0 = int(cy + 0.25 * side); y1 = min(h, int(cy + 1.6 * side))
    x0 = max(0, int(cx - 0.9 * side)); x1 = min(w, int(cx + 0.9 * side))
    if y1 <= y0 or x1 <= x0:
        return None
    band = med[y0:y1, x0:x1]
    tm = compass._tile_mask(band)                       # white tile pixels, felt/wall/dark removed
    cols = tm.sum(0)
    xs = np.where(cols > 0.15 * tm.shape[0])[0]
    if len(xs) == 0:
        return 0.0
    return round(float(xs.max() - xs.min()) / side, 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--url")
    ap.add_argument("--video")
    ap.add_argument("--frames-dir", help="offline: read *.png (timestamp in filename)")
    ap.add_argument("--from", dest="from_t", type=float, required=True)
    ap.add_argument("--to", dest="to_t", type=float, required=True)
    ap.add_argument("--step", type=float, default=6.0)
    ap.add_argument("--clip-start", type=float, default=0.0)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--calib", help="reuse a saved calibration JSON (skip calibration)")
    ap.add_argument("--calib-out", help="write the computed calibration here")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    cfg = _load_cfg(args.config)
    seat_names = cfg.get("pass3", {}).get("seats", {})
    iou_min = compass._cfg(cfg)["iou_min"]

    source = None
    if not args.frames_dir:
        url = args.url
        if not url and not args.video:
            src = cfg.get("source", {})
            if src.get("type") == "youtube" and src.get("id"):
                url = f"https://www.youtube.com/watch?v={src['id']}"
        source = make_source(url=url, video=args.video,
                             clip_start=args.clip_start, height=args.height)

    frames = gather(source, cfg, args)
    if len(frames) < 8:
        raise SystemExit(f"only {len(frames)} frames gathered; widen the window/step")

    # --- calibration (compute or load) ---
    if args.calib:
        with open(args.calib, encoding="utf-8") as f:
            calib = json.load(f)["seats"]
    else:
        static = compass.static_overlay_mask([im for _, im in frames])
        seats = compass.seat_frames(frames, cfg)
        # cross-perspective overlay mask (chrome = same across the 4 seat cameras)
        seat_meds = [np.median(np.stack([im.astype(np.float32) for _, im in bucket["frames"]]), 0).astype(np.uint8)
                     for bucket in seats.values() if len(bucket["frames"]) >= 4]
        xoverlay = compass.cross_perspective_overlay_mask(seat_meds) if len(seat_meds) >= 2 else None
        calib = {}
        for seat, bucket in seats.items():
            fr = bucket["frames"]
            if len(fr) < 4:
                calib[seat] = None
                continue
            calib[seat] = compass.calibrate_camera(fr, static, cfg, xoverlay)
            if calib[seat] is not None:
                calib[seat]["shoulder"] = bucket["shoulder"]
                calib[seat]["tilt_deg"] = bucket["tilt_deg"]
        if args.calib_out:
            os.makedirs(os.path.dirname(args.calib_out) or ".", exist_ok=True)
            with open(args.calib_out, "w", encoding="utf-8") as f:
                json.dump({"broadcast": cfg.get("broadcast"), "seats": calib}, f,
                          ensure_ascii=False, indent=2)

    # --- riichi from overlay (persistence-filtered) ---
    onsets, _ = read_riichi(frames, cfg)

    # --- assemble skeleton + questions ---
    SEAT_IDX = {"E": 0, "S": 1, "W": 2, "N": 3}  # tenhou seat order; adjust per broadcast seating
    questions = []

    def link(t):
        return ov.source_link(cfg, t)

    seats_out = {}
    for seat in ["E", "S", "W", "N"]:
        c = calib.get(seat)
        name = seat_names.get(seat, {}).get("name") if isinstance(seat_names.get(seat), dict) else None
        idx = SEAT_IDX[seat]
        entry = {"seat": seat, "player": name, "calibrated": c is not None}
        if c is None:
            questions.append({"kind": "calibration", "seat": seat,
                              "prompt": f"Compass calibration failed for {seat} ({name}); "
                                        f"provide a clean round-start frame."})
        else:
            entry["calibration"] = {"iou": c["iou"], "comb": c["comb"], "t": c["t"], "side": c["side"],
                                     "shoulder": c.get("shoulder"), "tilt_deg": c.get("tilt_deg")}
            if c["iou"] < iou_min:
                questions.append({"kind": "calibration", "seat": seat, "t": c["t"],
                                  "prompt": f"Low-confidence compass fit for {seat} "
                                            f"(IoU {c['iou']}); verify the deskew.",
                                  "link": link(c["t"])})
        # riichi (overlay). discard-index needs the counter once orientation is fixed.
        if idx in onsets:
            entry["riichi"] = {"declared": True, "onsetT": onsets[idx], "discardIndex": None,
                               "link": link(onsets[idx])}
            questions.append({"kind": "riichi_index", "seat": seat, "t": onsets[idx],
                              "prompt": f"Confirm {name or seat}'s riichi discard index "
                                        f"(river count at t={onsets[idx]}).",
                              "link": link(onsets[idx])})
        else:
            entry["riichi"] = {"declared": False}
        # discard identities are not readable off the felt -> HITL
        questions.append({"kind": "discards", "seat": seat,
                          "prompt": f"Discard identities for {name or seat} are not OCR-readable; "
                                    f"fill from the hand tracker (near seat) or by hand."})
        seats_out[seat] = entry

    payload = {
        "broadcast": cfg.get("broadcast"),
        "window": {"from": args.from_t, "to": args.to_t, "step": args.step, "frames": len(frames)},
        "seats": seats_out,
        "questions": questions,
        "notes": "Pass 3 = calibration + riichi + count skeleton. Discard identities are "
                 "human-in-the-loop (river OCR not viable). See README.",
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        ncal = sum(1 for s in seats_out.values() if s["calibrated"])
        print(f"wrote {args.out}: {ncal}/4 seats calibrated, {len(questions)} question(s)")
        if args.calib_out and not args.calib:
            print(f"wrote {args.calib_out}: per-camera transforms")
    else:
        print(text)


if __name__ == "__main__":
    main()
