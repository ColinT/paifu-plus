# video-transcribe

Assisted transcription of riichi mahjong **broadcast video** into PaifuPlus /
tenhou records. This is a **human-in-the-loop** tool: it extracts the parts of a
game it can read with confidence and escalates everything uncertain as a
**timestamped question** for a human to resolve later in the editor. It does not
attempt fully-automatic transcription.

It is a Python pipeline (the CV/OCR ecosystem lives in Python) that emits JSON the
TypeScript app already knows how to import (tenhou/6, plus a sidecar list of
questions).

## Why human-in-the-loop (what the camera can and can't see)

Established against a real broadcast (最高位戦 / WRC playoff, `zzLJcZeDdnM`):

| Data | Visible? | Approach |
| --- | --- | --- |
| Overlay: round, honba, riichi sticks, dora, names, scores | **Yes** — clean, fixed-position graphics | OCR of fixed crop regions (pass 0) |
| Result graphic (win / yaku / han-fu / deltas) | Yes, per round | OCR (pass 1) |
| Discards (河) | Yes — face-up, mostly stationary | detect + classify from each seat's pond (pass 2) |
| Calls (pon/chi/kan) | Yes — face-up, rotated | rotation encodes `fromSeat` (as in the PDF importer) |
| Riichi | Yes — sideways tile + 1000 stick + overlay counter | multiple signals |
| **Near (bottom) seat's** haipai + draws | Yes — angled toward camera | classify, but occlusion-aware |
| **Other three seats'** haipai | Only if the director cuts to each hand | per-seat timestamps where available, else unknown |
| **Opponents' concealed draws** | **No** — never face-visible | left blank by design (NOT a question) |

Two hard limits fall out of this:

1. **Only the near seat's hand is ever readable.** Opponents' hands are backfilled
   from their discards / melds / final hand, or left unknown.
2. **Opponents' draws are unobservable.** The transcript is **discard/call/result-
   centric**, not draw-centric, for 3 of 4 players. We never raise a "missing
   drawn tile" question for an opponent — only for observable-but-uncertain things.

## Questions (the escalation mechanism)

Anything the pipeline can't pin down becomes a structured question, not a guess.
Two sources feed the queue:

- **OCR/classifier low confidence** — "3m or 3p? [t=11:24]" (always include
  candidates; a multiple-choice is far faster to resolve than open text).
- **Rule-constraint violations** — a 5th copy of a tile, deltas not summing to
  zero, a river longer than 24, a call with no matching discard, honba/score not
  reconciling round-to-round. These are often more valuable than raw OCR doubt.

Each question carries a deep link back to the exact video moment:

```jsonc
{
  "round": 0, "seat": 0, "kind": "discard", "actionIndex": 7,
  "t": 684.3,                       // seconds into the source video
  "prompt": "Discard unreadable (occluded).",
  "candidates": ["3m", "3p"],       // optional, ranked
  "link": "https://youtu.be/zzLJcZeDdnM?t=684"
}
```

`link` is derived from the **source model** (see config): a YouTube URL yields a
`?t=` deep link; a local file yields `{file, offsetSec}` for an in-app `<video>`
seek. TODO(app): a review surface that lists questions and seeks an embedded
player to each `t`.

## Pipeline (phased — each phase is independently useful)

- **Pass 0 — overlays → round headers.** round / honba / sticks / dora / names /
  scores. Near-solved; the cheap skeleton for everything else. → `pass0_overlay.py`
- **Pass 1 — result graphics → `KyokuResult`** per round.
- **Pass 2 — rivers → discards + riichi + calls.** The heavy pass. Must handle
  camera cuts (gate on the canonical table view) and **de-duplicate instant
  replays** (a replayed discard must not be counted twice).
- **Pass 3 — near-seat haipai + draws;** opponents backfilled where possible.

Human input: the operator scrubs the video and supplies **round-start timestamps**
(and, where the broadcast shows them, per-seat haipai-reveal timestamps). The
pipeline treats these as *approximate* and refines within a window (picks the
least-occluded frame per tile slot — never trusts a single frame).

## Per-broadcast calibration

Like the PDF importer's tile hashes, this is tuned to **one** broadcast's tiles,
camera, and overlay layout. v1 targets `zzLJcZeDdnM` (最高位戦/WRC). Config lives in
`config/<broadcast>.json`: overlay crop regions, tileset art, source model.
Notes for this show: **30,000-point start** (not 25,000); tileset uses stylized
art and red 發/中; **aka (red fives) are handled from the start** — they are the
reason the app has its own save format.

## Decisions

- **Haipai: 1 timestamp per round** (the near seat). If a hand can't be
  reconstructed from that frame, the tool raises a question asking the operator
  to add more timestamps (a cleaner/later frame, or a per-seat reveal).
- **Source of truth: YouTube URL.** Questions link as `youtu.be/<id>?t=<sec>`.
  Caveat that drives hosting: a YouTube source **requires a server-side frame
  fetch** — a browser cannot read pixels from a YouTube player (cross-origin
  canvas taint), and cannot fetch googlevideo media directly (CORS). So the
  download+decode step (yt-dlp+ffmpeg) must run on a server; OCR itself need not.
- **Hosting: open.** Options: (A) local CLI (this tool, no infra); (B) static app
  + a thin serverless endpoint that turns `{videoId, timestamps}` into frames,
  with OCR running in the browser (Tesseract.js / onnxruntime-web); (C) full
  backend. The ML does **not** require Python — it's just the easiest home for
  the libraries.

## Usage

```bash
# deps: Python 3.10+, ffmpeg on PATH, yt-dlp (for URL sources)
pip install -r requirements.txt

# pass 0: read the overlay at one or more round-start timestamps
python pass0_overlay.py --config config/ketteisen-wrc.json \
    --video path/to/clip.mp4 --at 690 [--at ...] --out headers.json
```
