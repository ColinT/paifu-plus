"""
CNN tile-FACE classifier — an ML alternative to ORB (tiles.classify_orb) for
identifying a deskewed tile crop's tenhou code, aimed at the low-resolution,
blur/compression-degraded crops this pipeline actually produces.

Why not ORB here: ORB needs sharp local corners/gradients (FAST) and clean
binary intensity comparisons (BRIEF) — both degrade badly under blur, and a
near-tied top-4 inlier count (seen on a real river crop: 17/16/15/11 across 4
DIFFERENT tiles) is the signature of a match that cleared the confidence
threshold by luck, not one that's actually discriminating. A CNN can instead be
trained ON degraded imagery directly, learning holistic features that survive
blur rather than relying on sharp keypoints.

Training data (34 classes = the base tenhou codes; AKA/red-five tiles 51/52/53
and the +100 aka-overlay codes are EXCLUDED for now — see aka note below):
  1. SYNTHETIC: the app's own tile-face SVGs (src/assets/tiles/<code>.svg,
     composited over front.svg — the exact art the replay UI renders), heavily
     augmented (blur, native-res down/upscale, noise, jpeg re-encode, small
     rotation, brightness/contrast jitter) to approximate broadcast degradation.
     Gives every class full, clean coverage — the ORB seed set is missing 1p-4p,
     3s, and East entirely.
  2. REAL: the existing ORB reference crops (tiles/<code>/*.png, ~138 images,
     28 of 34 codes) — actual broadcast pixels for domain grounding, lightly
     augmented (small dataset, don't want to just memorize exact pixels).

AKA note: native red-fives (tenhou 51/52/53) and the generic aka-overlay codes
(<code>+100) are excluded from THIS classifier's 34 classes for now, per an
explicit scope decision — a tile classified as plain 5m/5p/5s here may in fact
be the red version; distinguishing that is a separate (colour-based) question
layered on top later, not part of character-identity classification.
"""
from __future__ import annotations

import glob
import os
import random

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

CODES = [11, 12, 13, 14, 15, 16, 17, 18, 19,
         21, 22, 23, 24, 25, 26, 27, 28, 29,
         31, 32, 33, 34, 35, 36, 37, 38, 39,
         41, 42, 43, 44, 45, 46, 47]
CODE_TO_IDX = {c: i for i, c in enumerate(CODES)}
IDX_TO_CODE = {i: c for i, c in enumerate(CODES)}
N_CLASSES = len(CODES)
IMG_W, IMG_H = 44, 64          # matches pass2_hands.CELL_W, CELL_H (project's standard tile-face size)

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_REAL_DIR = os.path.join(_HERE, "tiles")
DEFAULT_SYNTH_DIR = os.path.join(_HERE, "tiles_synth")
DEFAULT_EXTERNAL_DIR = os.path.join(_HERE, "tiles_external")
DEFAULT_MODEL_PATH = os.path.join(_HERE, "tile_cnn.pt")


def code_name(code):
    """Tenhou code -> the project's own compact notation (tracker._name):
    <rank><suit>, suit in m/p/s/z (man/pin/sou/honor), honor rank 1-7 = East,
    South, West, North, White, Green, Red. e.g. 42 -> '2z' (South)."""
    if code is None:
        return "?"
    suit = "mpsz"[(code // 10) - 1]
    return "%d%s" % (code % 10, suit)


# ---- augmentation (approximates broadcast blur/compression/motion) --------

# three source regimes need three augmentation strengths:
#  - "light":  real ORB-seed crops — already actual broadcast pixels, just
#              enough jitter to not memorize exact images
#  - "medium": the external Chinese-tile-set photos — real photography, but a
#              different physical tile set/font, so the domain gap is style
#              not sharpness; needs more jitter than "light" but not the full
#              vector-to-photo degradation "heavy" applies
#  - "heavy":  synthetic SVG renders — start pixel-perfect vector art, need
#              the most aggressive degradation to approximate broadcast blur
_LEVELS = {
    "light":  dict(ds_p=0.4, ds_lo=0.55, ds_hi=1.0, blur=[1, 1, 3], noise_p=0.25,
                   rot=5, jpeg_p=0.25, jpeg_lo=45, jpeg_hi=90),
    "medium": dict(ds_p=0.6, ds_lo=0.4, ds_hi=0.95, blur=[1, 3, 3, 5], noise_p=0.4,
                    rot=7, jpeg_p=0.45, jpeg_lo=35, jpeg_hi=85),
    "heavy":  dict(ds_p=1.0, ds_lo=0.25, ds_hi=0.85, blur=[1, 3, 3, 5], noise_p=0.5,
                    rot=8, jpeg_p=0.6, jpeg_lo=25, jpeg_hi=80),
}


def _augment(gray, level="heavy"):
    P = _LEVELS[level]
    g = gray.astype(np.float32)
    h, w = g.shape

    # discrete 90deg-multiple rotation: tiles are LEGITIMATELY rotated in the
    # real domain (a riichi declaration tile, a called/exposed meld tile) —
    # this isn't synthetic noise, the classifier must recognize a tile
    # regardless of which way it's sitting. No flips: a mirrored character is
    # a shape that never occurs in reality, unlike a rotated one.
    k90 = random.choice([0, 1, 2, 3])
    if k90:
        g = np.rot90(g, k90).copy()
        if g.shape != (h, w):          # 90/270 swap W/H; resize back to the fixed input shape
            g = cv2.resize(g, (w, h), interpolation=cv2.INTER_LINEAR)

    # native-resolution simulation: down then upscale (the dominant real-world
    # degradation — this pipeline's crops are often natively ~40px soft)
    if random.random() < P["ds_p"]:
        s = random.uniform(P["ds_lo"], P["ds_hi"])
        small = cv2.resize(g, (max(4, int(w * s)), max(4, int(h * s))), interpolation=cv2.INTER_AREA)
        g = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    k = random.choice(P["blur"])
    if k > 1:
        g = cv2.GaussianBlur(g, (k, k), 0)
    alpha = random.uniform(0.65, 1.35)
    beta = random.uniform(-30, 30)
    g = np.clip(g * alpha + beta, 0, 255)
    if random.random() < P["noise_p"]:
        g = np.clip(g + np.random.normal(0, random.uniform(2, 10), g.shape), 0, 255)
    # small-angle jitter (imperfect deskew) + independent x/y scale (aspect-
    # ratio distortion, e.g. from homography error) + small off-center shift
    # (seam/quad-detection slop) — one combined affine warp
    ang = random.uniform(-P["rot"], P["rot"])
    sx = random.uniform(0.85, 1.15)
    sy = random.uniform(0.85, 1.15)
    tx = random.uniform(-0.06, 0.06) * w
    ty = random.uniform(-0.06, 0.06) * h
    M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
    M[0, 0] *= sx; M[0, 1] *= sx
    M[1, 0] *= sy; M[1, 1] *= sy
    M[0, 2] += tx
    M[1, 2] += ty
    g = cv2.warpAffine(g.astype(np.uint8), M, (w, h), borderMode=cv2.BORDER_REPLICATE)
    if random.random() < P["jpeg_p"]:
        q = random.randint(P["jpeg_lo"], P["jpeg_hi"])
        ok, enc = cv2.imencode(".jpg", g, [cv2.IMWRITE_JPEG_QUALITY, q])
        if ok:
            g = cv2.imdecode(enc, cv2.IMREAD_GRAYSCALE).astype(np.float32)
    return g.astype(np.uint8)


def _prep(gray):
    g = cv2.resize(gray, (IMG_W, IMG_H))
    x = g.astype(np.float32) / 255.0
    x = (x - 0.5) / 0.5
    return x


def _to_gray(img):
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img


# ---- dataset ----------------------------------------------------------------

class TileDataset(Dataset):
    """train=True/False split by shuffling the (path, code, level) list. Three
    source tiers, each expanded into many augmented samples per epoch at a
    level matched to how far that source is from real broadcast pixels (see
    _LEVELS): real ORB-seed crops (light), external Chinese-tile-set photos
    (medium), synthetic SVG renders (heavy)."""

    def __init__(self, real_dir=DEFAULT_REAL_DIR, synth_dir=DEFAULT_SYNTH_DIR,
                 external_dir=DEFAULT_EXTERNAL_DIR, train=True, val_frac=0.15, seed=0,
                 synth_mult=40, real_mult=8, external_mult=14):
        rng = random.Random(seed)
        samples = []   # (path, code, level, mult)
        for code in CODES:
            for p in sorted(glob.glob(os.path.join(real_dir, str(code), "*.png"))):
                samples.append((p, code, "light", real_mult))
            for p in sorted(glob.glob(os.path.join(external_dir, str(code), "*.jpg"))):
                samples.append((p, code, "medium", external_mult))
            sp = os.path.join(synth_dir, "%d.png" % code)
            if os.path.exists(sp):
                samples.append((sp, code, "heavy", synth_mult))
        rng.shuffle(samples)
        n_val = max(N_CLASSES, int(len(samples) * val_frac))
        self.samples = samples[n_val:] if train else samples[:n_val]
        self.train = train
        self._index = []
        for i, (_, _, _, mult) in enumerate(self.samples):
            m = mult if train else max(1, mult // 5)
            self._index += [i] * m

    def __len__(self):
        return len(self._index)

    def __getitem__(self, idx):
        path, code, level, _ = self.samples[self._index[idx]]
        img = cv2.imread(path)
        gray = _to_gray(img)
        if self.train:
            gray = cv2.resize(gray, (IMG_W, IMG_H))
            gray = _augment(gray, level=level)
        x = _prep(gray)
        return torch.from_numpy(x).unsqueeze(0), CODE_TO_IDX[code]


# ---- model --------------------------------------------------------------

class TileCNN(nn.Module):
    """MNIST-digit-classifier-style CNN: 3x (conv+relu+pool), adaptive pool
    (size-agnostic), 2 FC layers with dropout, softmax over 34 tile classes."""

    def __init__(self, n_classes=N_CLASSES):
        super().__init__()
        self.conv1 = nn.Conv2d(1, 16, 3, padding=1)
        self.conv2 = nn.Conv2d(16, 32, 3, padding=1)
        self.conv3 = nn.Conv2d(32, 64, 3, padding=1)
        self.pool = nn.MaxPool2d(2, 2)
        self.adapt = nn.AdaptiveAvgPool2d((4, 4))
        self.fc1 = nn.Linear(64 * 4 * 4, 128)
        self.fc2 = nn.Linear(128, n_classes)
        self.drop = nn.Dropout(0.3)

    def forward(self, x):
        x = self.pool(F.relu(self.conv1(x)))
        x = self.pool(F.relu(self.conv2(x)))
        x = self.pool(F.relu(self.conv3(x)))
        x = self.adapt(x)
        x = x.flatten(1)
        x = self.drop(F.relu(self.fc1(x)))
        return self.fc2(x)


# ---- train / evaluate -----------------------------------------------------

def train(epochs=15, batch_size=64, lr=1e-3, model_path=DEFAULT_MODEL_PATH,
          real_dir=DEFAULT_REAL_DIR, synth_dir=DEFAULT_SYNTH_DIR,
          external_dir=DEFAULT_EXTERNAL_DIR, seed=0):
    torch.manual_seed(seed)
    train_ds = TileDataset(real_dir, synth_dir, external_dir, train=True, seed=seed)
    val_ds = TileDataset(real_dir, synth_dir, external_dir, train=False, seed=seed)
    print("train samples/epoch=%d, val samples=%d" % (len(train_ds), len(val_ds)))
    train_dl = DataLoader(train_ds, batch_size=batch_size, shuffle=True, num_workers=0)
    val_dl = DataLoader(val_ds, batch_size=batch_size, shuffle=False, num_workers=0)

    model = TileCNN()
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    best_acc = 0.0
    for ep in range(epochs):
        model.train()
        tot_loss = 0.0
        for xb, yb in train_dl:
            opt.zero_grad()
            out = model(xb)
            loss = F.cross_entropy(out, yb)
            loss.backward()
            opt.step()
            tot_loss += float(loss) * xb.size(0)
        model.eval()
        correct = total = 0
        with torch.no_grad():
            for xb, yb in val_dl:
                pred = model(xb).argmax(1)
                correct += int((pred == yb).sum())
                total += yb.size(0)
        acc = correct / max(1, total)
        print("epoch %d: train_loss=%.4f val_acc=%.3f" % (ep, tot_loss / len(train_ds), acc))
        if acc >= best_acc:
            best_acc = acc
            torch.save({"state_dict": model.state_dict(), "codes": CODES}, model_path)
    print("best val_acc=%.3f, saved to %s" % (best_acc, model_path))
    return best_acc


# ---- inference ------------------------------------------------------------

_loaded = {}


def load_model(model_path=DEFAULT_MODEL_PATH):
    if model_path in _loaded:
        return _loaded[model_path]
    ckpt = torch.load(model_path, map_location="cpu")
    model = TileCNN(n_classes=len(ckpt["codes"]))
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    _loaded[model_path] = (model, ckpt["codes"])
    return model, ckpt["codes"]


def classify_cnn(crop_bgr, model_path=DEFAULT_MODEL_PATH, min_conf=0.0):
    """(code, confidence, top3) for a tile-face crop (BGR). confidence is the
    softmax probability of the winning class; top3 is [(code, prob), ...] for
    inspection. code is None if confidence < min_conf."""
    model, codes = load_model(model_path)
    gray = _to_gray(crop_bgr)
    x = _prep(cv2.resize(gray, (IMG_W, IMG_H)))
    with torch.no_grad():
        logits = model(torch.from_numpy(x).unsqueeze(0).unsqueeze(0))
        probs = F.softmax(logits, dim=1)[0].numpy()
    order = np.argsort(-probs)
    top3 = [(codes[i], float(probs[i])) for i in order[:3]]
    best_code, best_p = top3[0]
    return (best_code if best_p >= min_conf else None), best_p, top3


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=15)
    ap.add_argument("--real-dir", default=DEFAULT_REAL_DIR)
    ap.add_argument("--synth-dir", default=DEFAULT_SYNTH_DIR)
    ap.add_argument("--external-dir", default=DEFAULT_EXTERNAL_DIR)
    ap.add_argument("--model-out", default=DEFAULT_MODEL_PATH)
    args = ap.parse_args()
    train(epochs=args.epochs, real_dir=args.real_dir, synth_dir=args.synth_dir,
          external_dir=args.external_dir, model_path=args.model_out)
