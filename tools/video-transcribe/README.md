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
| Overlay: round, honba, riichi sticks, dora, names, scores, **per-seat riichi** | **Yes** — clean, fixed-position graphics | OCR / red-badge detection of fixed crop regions (pass 0) |
| Result graphic (win / yaku / han-fu / deltas) | Yes, per round | OCR (pass 1) |
| Riichi declaration | Yes — red リーチ badge + 1000 stick + score −1000 + overlay counter | overlay badge (done in pass 0), all cross-checking |
| Calls (pon/chi/kan) | Sometimes — face-up melds, when on-screen | rotation encodes `fromSeat` (as in the PDF importer) |
| Each seat's hand (haipai / final) | Yes — the director cuts to each hand in close-up | classify (needs the seat-ID from the on-table nameplate), occlusion-aware |
| Discards (河) | **Hard on this broadcast** — see directing note | no stable river shot; human-assisted or heavy table-registration |
| Opponents' concealed draws | **No** — never face-visible | left blank by design (NOT a question) |

**Directing style (observed on `zzLJcZeDdnM`, E1).** There is **no locked overhead
table shot**. The broadcast is a directed sequence of **per-player hand close-ups**
(the camera faces one player's hand at a time; the on-table nameplate identifies
whose) plus centre/dead-wall shots, cutting every few seconds. Consequences:

1. **The 河 (discard river) is never a clean, stable, dedicated subject.** Reading
   the discard *sequence* from the felt would need per-frame table registration on
   a constantly-cutting camera, with the river often off-frame or occluded — so
   discards are the **hardest** thing here, not the easiest. Realistically:
   human-assisted (deep-linked questions) unless/until a registration pass is built.
2. **The persistent overlay is the reliable channel.** Round, scores, honba,
   sticks, dora, and **per-seat riichi** all read cleanly from fixed regions and
   *update live* — so riichi timing and score deltas come from the overlay, no felt
   CV. (Cross-check at E1 t=880: riichi `[_,_,✓,✓]` = 2 sticks = two seats at 29000.)
3. **Hands are readable** (each shown in close-up) → better support for
   haipai/final-hand than for discards. Opponents' concealed **draws** remain
   unobservable; never raise a "missing draw" question for them.

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
  scores / **per-seat riichi** / dealer. Done. The cheap, reliable skeleton.
  → `pass0_overlay.py` (+ `tiles.py` for the dora indicator)
- **Pass 1 — overlay event timeline + result.** Done → `pass1_events.py`. Samples
  a round window, keeps points-conservation-valid frames (which also recovers the
  stick count), and diffs consecutive states → **riichi-declared(seat, t)** and
  **score-change** events, then classifies the net round result (tsumo/ron/draw)
  from the deltas. No felt CV. Yaku/han-fu aren't on the overlay → left as a
  question (or a later result-graphic reader).
- **Pass 2 — hands (haipai / final).** Segmentation built → `pass2_hands.py` (+ ORB
  matcher in `tiles.py`). The close-ups are tilted with perspective foreshortening,
  so we **deskew first**: fit the row's 4 corners, warp that quadrilateral to a
  rectangle (removing tilt AND perspective), then — since it's a haipai with a
  **known N** (14 dealer / 13 else) — split into N equal columns. Every cell comes
  out upright at a normalized scale, then classified via **ORB**; unknowns escalate
  as labeled crops. Corners: `--quad TL,TR,BR,BL` (operator-anchored, reliable) is
  the recommended path. Auto-detection runs on the **full frame** (no crop — the
  haipai fills much of it) and picks the haipai among bright blobs by **shape**: a
  row of N tiles (3 wide : 4 high each) has overall aspect ~3N/4, and among
  aspect-plausible blobs the near hand is the one with the **largest tiles**
  (biggest short side, closest to camera). The mask is **adaptive/normalized**
  (`whitish`): whiteness = `min(R,G,B)` (rejects the bluish felt and orange edge),
  CLAHE-normalized, thresholded by the brightest class of a 3-way multi-Otsu — no
  fixed 0-255 cutoffs, so shadowed tiles survive and the felt is excluded. This
  reliably finds the near hand and its **bottom edge**; the residual issue is the
  player's **reaching hand/arm** (skin is bright too) merging into the top of the
  blob and corrupting the fitted top edge. Planned fix: reconstruct the top edge
  from the reliable bottom edge + known N + the 3:4 tile aspect, rather than
  fitting it to the contaminated blob. Until then use `--quad`. Recognition needs
  the `tiles/` library grown via the labeling loop; seat id is `--seat` for now.
- **Pass 3 — discards (河).** The genuinely hard one on this broadcast (no stable
  river shot): either heavy per-frame table-registration + replay de-dup, or
  human-assisted entry via deep-linked questions. Deferred pending a decision.

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

## Frame fetching (long VODs, small disk)

A broadcast can be 4+ hours, so we never download the whole video. `frames.py`
fetches **single frames by timestamp**: yt-dlp resolves the direct media URL once,
then ffmpeg range-seeks one frame over HTTP (~6s/frame, peak disk ~one frame). A
format that won't range-seek falls back to a ~2s section (a few MB, auto-deleted).
Local files are also supported (`--video`), mainly for offline calibration.

## Tile recognition (`tiles.py`)

Text-OCR can't read tile art, so tiles are matched against a **reference library**
`tiles/<code>/<n>.png` (tenhou codes: 11-19 man, 21-29 pin, 31-39 sou, 41-47
honor). `classify()` scores a crop by normalized correlation against every
reference; below threshold it returns unknown so the caller asks a question.

The library is **self-improving**: an unknown-tile question saves the crop under
`out/unlabeled/`, and answering it feeds the crop back as a new reference —

```bash
python tiles.py add --code 17 --image out/unlabeled/dora_690.png   # 17 = 7m
python tiles.py list
```

Pass 0 uses this for the dora indicator (upright, consistent scale — ideal for
template matching). Rotated/scaled tiles in hands and rivers (passes 2/3) will
layer a scale/rotation-invariant matcher (ORB) over the **same** library.

## Usage

```bash
# deps: Python 3.10+, ffmpeg on PATH, yt-dlp (installed via requirements)
pip install -r requirements.txt

# pass 0: read the overlay at one or more round-start timestamps (absolute seconds)
python pass0_overlay.py --config config/ketteisen-wrc.json \
    --url https://www.youtube.com/watch?v=zzLJcZeDdnM --at 690 [--at ...] \
    --out out/headers.json

# --url defaults to the config's source.id, so this is equivalent:
python pass0_overlay.py --config config/ketteisen-wrc.json --at 690 --out out/headers.json

# calibrate crop regions against a frame (saves each crop, no OCR):
python pass0_overlay.py --config ... --at 690 --dump-regions --out out/x

# pass 1: overlay event timeline for one round (riichi / score / result)
python pass1_events.py --config config/ketteisen-wrc.json \
    --start 661 --end 980 --step 8 --out out/e1_events.json
```
