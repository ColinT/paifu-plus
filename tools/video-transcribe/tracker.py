"""
Temporal hand tracker — turns sporadic per-seat hand reads into a transcript.

The camera never shows a clean static haipai; every close-up is already mid-turn.
So we don't reconstruct a hand from any single frame. Instead we watch each seat's
hand across the frames where its angle recurs and DIFF successive reads into events:

  draw       a tile is newly present that wasn't in the running hand
  tedashi    a tile leaves the hand (a hand tile was discarded)
  tsumogiri  the just-drawn tile is discarded immediately (hand otherwise unchanged)
  backfill   a tile appears that must have been held earlier but was never seen
             (occluded / off-frame) — propagated back into the haipai estimate

Reads are noisy and partial (occlusion, blur, tiles held off-row), so the tracker is
CONSERVATIVE: it only commits an event on an unambiguous single-tile delta and
otherwise emits a timestamped QUESTION (deep link) for the operator, exactly like the
rest of the pipeline. Calls (chi/pon/kan) and river reconciliation are TODO — this is
the concealed-hand core.

Tiles are tenhou codes (ints). A "hand" is a Counter (multiset) of them.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Optional

CONF = 0.85          # min per-tile confidence to treat a read as certain


@dataclass
class Observation:
    """One frame's read of one seat's concealed hand."""
    seat: int
    t: float                                  # video timestamp (s)
    tiles: list[int]                          # recognized tile codes this frame
    conf: list[float] = field(default_factory=list)   # per-tile score (parallel)
    drawn: Optional[int] = None               # isolated / rightmost tile, if flagged as the draw

    def certain(self) -> Counter:
        """Multiset of tiles read with enough confidence to reason about."""
        cs = self.conf or [1.0] * len(self.tiles)
        return Counter(t for t, c in zip(self.tiles, cs) if c >= CONF)


@dataclass
class Event:
    t: float
    seat: int
    kind: str                                 # haipai|draw|tedashi|tsumogiri|backfill|question
    tile: Optional[int] = None
    note: str = ""
    link: Optional[str] = None


class Tracker:
    """Maintains a running concealed-hand estimate per seat and an event log."""

    def __init__(self, n_seats: int = 4, link_fn=None):
        self.hand: dict[int, Counter] = {s: Counter() for s in range(n_seats)}
        self.haipai: dict[int, Counter] = {s: Counter() for s in range(n_seats)}
        self.last_t: dict[int, Optional[float]] = {s: None for s in range(n_seats)}
        self.events: list[Event] = []
        self._link = link_fn or (lambda t: None)

    def _emit(self, t, seat, kind, tile=None, note=""):
        self.events.append(Event(t, seat, kind, tile, note, self._link(t)))

    def _backfill(self, seat, tile, t):
        """A tile seen now but never before must have been held earlier (occluded /
        off-frame): add it to the hand AND retroactively to the haipai estimate."""
        self.hand[seat][tile] += 1
        self.haipai[seat][tile] += 1
        self._emit(t, seat, "backfill", tile, f"{_name(tile)} held earlier, unseen")

    def observe(self, obs: Observation):
        seat, seen = obs.seat, obs.certain()

        # First sighting of this seat: seed the hand + haipai estimate. If this frame
        # already shows a drawn tile (the reveal is mid-turn), it isn't part of the
        # DEALT haipai — record it as a draw and leave it out of the haipai estimate.
        if self.last_t[seat] is None:
            self.hand[seat] = Counter(seen)
            haip = Counter(seen)
            if obs.drawn is not None and haip[obs.drawn] > 0:
                haip[obs.drawn] -= 1
                haip += Counter()               # drop zero/negative entries
            self.haipai[seat] = haip
            self.last_t[seat] = obs.t
            self._emit(obs.t, seat, "haipai", note=_hand_str(haip))
            if obs.drawn is not None:
                self._emit(obs.t, seat, "draw", obs.drawn, _name(obs.drawn))
            return

        prev = Counter(self.hand[seat])         # copy — never alias the live hand
        gained = seen - prev                    # in this read, not in the running hand
        lost = prev - seen                      # in the running hand, absent from this read

        if obs.drawn is None:
            # No draw flagged: new tiles are BACKFILL. A missing tile is ambiguous
            # (occluded vs discarded) so we do NOT delete it — just flag a question.
            for tile in gained.elements():
                self._backfill(seat, tile, obs.t)
            if lost:
                self._emit(obs.t, seat, "question",
                           note=f"gone - occluded or discarded? {_hand_str(lost)}")
            self.last_t[seat] = obs.t
            return

        drawn = obs.drawn
        if drawn not in seen:
            # drew it and put it straight to the river: tsumogiri (hand unchanged).
            self._emit(obs.t, seat, "tsumogiri", drawn, _name(drawn))
            for tile in gained.elements():      # anything else new is backfill
                self._backfill(seat, tile, obs.t)
            self.last_t[seat] = obs.t
            return

        # Kept the draw. Turn structure = +draw, -discard; the discard is the tile that
        # left the hand once the draw is accounted for.
        self._emit(obs.t, seat, "draw", drawn, _name(drawn))
        self.hand[seat][drawn] += 1
        disc = (prev + Counter([drawn])) - seen
        if sum(disc.values()) == 1:
            d = next(iter(disc.elements()))
            self.hand[seat][d] -= 1
            if self.hand[seat][d] <= 0:
                del self.hand[seat][d]
            self._emit(obs.t, seat, "tedashi", d, _name(d))
        elif sum(disc.values()) > 1:
            self._emit(obs.t, seat, "question",
                       note=f"drew {_name(drawn)} but multiple left: {_hand_str(disc)}")
        for tile in (gained - Counter([drawn])).elements():   # extra new tiles = backfill
            self._backfill(seat, tile, obs.t)
        self.last_t[seat] = obs.t

    def transcript(self):
        return list(self.events)

    def haipai_estimate(self, seat):
        """Best reconstruction of the seat's DEALT hand: the first read (minus any
        tile that was already a draw) plus every tile later backfilled as held."""
        return Counter(self.haipai[seat])


def _name(code):
    if code is None:
        return "?"
    suit = "mpsz"[(code // 10) - 1]
    return f"{code % 10}{suit}"


def _hand_str(counter):
    return " ".join(_name(t) for t in sorted(counter.elements()))


if __name__ == "__main__":
    # Self-test on a realistic North sequence (seat 3). The reveal is already mid-turn
    # (the 2s is a fresh draw), the on-screen hand is 12 (one haipai tile off-frame),
    # and later turns exercise draw/tedashi, tsumogiri, and backfill+occlusion.
    N = 3
    reveal = [36, 37, 38, 39, 12, 13, 14, 15, 18, 27, 28, 32]        # 6s7s8s9s 2m3m4m5m8m 7p8p 2s
    tk = Tracker()
    tk.observe(Observation(N, 709.0, reveal, drawn=32))              # 2s was the draw
    # next sight: the off-frame 13th haipai tile (1s) is now visible -> backfill;
    # drew 5s and discarded 2m (tedashi)
    h2 = [36, 37, 38, 39, 13, 14, 15, 18, 27, 28, 32, 31, 35]        # -2m +1s +5s
    tk.observe(Observation(N, 760.0, h2, drawn=35))
    # drew 9m, tsumogiri it (hand unchanged)
    tk.observe(Observation(N, 800.0, h2, drawn=19))
    # a partial read: 3s never seen appears (backfill); 9s missing (occluded, not deleted)
    h4 = [t for t in h2 if t != 39] + [33]
    tk.observe(Observation(N, 840.0, h4, drawn=None))

    print("transcript:")
    for e in tk.transcript():
        print(f"  t={e.t:6.1f} seat{e.seat} {e.kind:9s} {_name(e.tile) if e.tile else '':4s} {e.note}")
    print("\nreconstructed North haipai:", _hand_str(tk.haipai_estimate(N)),
          f"({sum(tk.haipai_estimate(N).values())} tiles)")
    print("current North hand:        ", _hand_str(tk.hand[N]),
          f"({sum(tk.hand[N].values())} tiles)")
