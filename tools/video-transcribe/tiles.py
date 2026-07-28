"""
Tile classifier — identify a tile face from a cropped image.

Text-OCR can't read tile art (dot/bamboo patterns), so tiles are matched against
a small **reference library** instead: `tiles/<code>/<n>.png`, keyed by tenhou
tile code (11-19 man, 21-29 pin, 31-39 sou, 41-47 honor). A query crop is scored
by normalized correlation against every reference; the best wins, or — below
threshold — it returns None so the caller escalates a question.

The library is **self-improving**: when the operator answers an "unknown tile"
question, the saved crop is added as a new reference for that code (see
`add_reference` / the `add` CLI), so accuracy grows with use.

Scope note: normalized template matching suits UPRIGHT, consistent-scale tiles —
i.e. the overlay dora indicator (pass 0). Rotated/scaled tiles in hands and rivers
(passes 2/3) will want a scale/rotation-invariant matcher (ORB/feature-based)
layered on top of this same library; the reference format is shared.
"""
from __future__ import annotations

import argparse
import glob
import os

import cv2

TILE_W, TILE_H = 48, 60  # normalized template size (tile aspect ~0.8)


def preprocess(img_bgr):
    """Crop -> normalized grayscale template (size + lighting invariant-ish)."""
    g = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, (TILE_W, TILE_H), interpolation=cv2.INTER_AREA)
    return cv2.equalizeHist(g)


def load_library(lib_dir):
    """dict: tenhou code -> list of templates, from tiles/<code>/<n>.png."""
    lib = {}
    for path in glob.glob(os.path.join(lib_dir, "*", "*.png")):
        try:
            code = int(os.path.basename(os.path.dirname(path)))
        except ValueError:
            continue
        img = cv2.imread(path)
        if img is not None:
            lib.setdefault(code, []).append(preprocess(img))
    return lib


def _corr(a, b):
    return float(cv2.matchTemplate(a, b, cv2.TM_CCOEFF_NORMED)[0][0])


def classify(crop_bgr, lib, thresh=0.5):
    """(code, score). code is None (unknown) when the best score < thresh."""
    if not lib or crop_bgr is None or crop_bgr.size == 0:
        return None, 0.0
    q = preprocess(crop_bgr)
    best_code, best = None, -1.0
    for code, refs in lib.items():
        s = max(_corr(q, r) for r in refs)
        if s > best:
            best, best_code = s, code
    return (best_code if best >= thresh else None), round(best, 3)


## ---- ORB feature matching (scale/rotation robust; for felt tiles) ----------
# Template matching suits upright, fixed-scale tiles (the overlay dora). Tiles in
# hands and rivers are rotated and perspective-skewed, so those use ORB features
# + a Lowe ratio test, with a homography-inlier count as the geometric score.

_ORB = cv2.ORB_create(nfeatures=400)
_BF = cv2.BFMatcher(cv2.NORM_HAMMING)


def _orb_features(crop_bgr):
    g = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    return _ORB.detectAndCompute(g, None)  # (keypoints, descriptors)


def load_library_orb(lib_dir):
    """dict: code -> list of (keypoints, descriptors) for ORB matching."""
    lib = {}
    for path in glob.glob(os.path.join(lib_dir, "*", "*.png")):
        try:
            code = int(os.path.basename(os.path.dirname(path)))
        except ValueError:
            continue
        img = cv2.imread(path)
        if img is None:
            continue
        kp, des = _orb_features(img)
        if des is not None and len(kp) >= 4:
            lib.setdefault(code, []).append((kp, des))
    return lib


def _orb_score(q_kp, q_des, r_kp, r_des):
    """Geometric-consistent match count between query and one reference."""
    if q_des is None or r_des is None or len(q_des) < 4 or len(r_des) < 4:
        return 0
    good = []
    for m in _BF.knnMatch(q_des, r_des, k=2):
        if len(m) == 2 and m[0].distance < 0.75 * m[1].distance:
            good.append(m[0])
    if len(good) < 4:
        return len(good)
    import numpy as np
    src = np.float32([q_kp[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([r_kp[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    _, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    return int(mask.sum()) if mask is not None else len(good)


def classify_orb(crop_bgr, lib_orb, min_inliers=8):
    """(code, inliers). code is None when the best geometric match is too weak."""
    if not lib_orb or crop_bgr is None or crop_bgr.size == 0:
        return None, 0
    q_kp, q_des = _orb_features(crop_bgr)
    best_code, best = None, 0
    for code, refs in lib_orb.items():
        s = max((_orb_score(q_kp, q_des, rk, rd) for rk, rd in refs), default=0)
        if s > best:
            best, best_code = s, code
    return (best_code if best >= min_inliers else None), best


def add_reference(lib_dir, code, crop_bgr):
    """Save a labeled crop as a new reference for `code`; returns its path."""
    d = os.path.join(lib_dir, str(int(code)))
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{len(glob.glob(os.path.join(d, '*.png')))}.png")
    cv2.imwrite(path, crop_bgr)
    return path


def _main():
    ap = argparse.ArgumentParser(description="tile reference library + classifier")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add", help="add a labeled reference tile")
    a.add_argument("--code", type=int, required=True)
    a.add_argument("--image", required=True)
    a.add_argument("--lib", default="tiles")
    c = sub.add_parser("classify", help="classify a tile crop")
    c.add_argument("--image", required=True)
    c.add_argument("--lib", default="tiles")
    c.add_argument("--thresh", type=float, default=0.5)
    sub.add_parser("list", help="list library contents").add_argument("--lib", default="tiles")
    args = ap.parse_args()

    if args.cmd == "add":
        img = cv2.imread(args.image)
        if img is None:
            raise SystemExit(f"cannot read {args.image}")
        print("added", add_reference(args.lib, args.code, img))
    elif args.cmd == "classify":
        img = cv2.imread(args.image)
        if img is None:
            raise SystemExit(f"cannot read {args.image}")
        code, score = classify(img, load_library(args.lib), thresh=args.thresh)
        print(f"code={code} score={score}")
    elif args.cmd == "list":
        lib = load_library(args.lib)
        for code in sorted(lib):
            print(f"{code}: {len(lib[code])} ref(s)")


if __name__ == "__main__":
    _main()
