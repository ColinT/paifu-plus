"""
Frame sources — grab a single frame at an absolute timestamp.

A broadcast VOD can be 4+ hours; we never download the whole thing. For a
YouTube URL, yt-dlp resolves the direct (byte-range-capable) media URL once, then
ffmpeg input-seeks and pulls a single frame via HTTP range requests — so peak
disk stays ~one frame no matter how long the video is. If a format won't
range-seek cleanly, it falls back to downloading a ~2s section (a few MB, deleted
immediately).

This same by-timestamp fetch is what a hosted "frame endpoint" (hosting model B)
would expose, so the pipeline is agnostic to where it runs.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

import cv2


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg not found on PATH (needed to extract frames).")
    return exe


def _read_png(path: str):
    img = cv2.imread(path)
    if img is None:
        raise RuntimeError(f"could not read extracted frame: {path}")
    return img


def _grab_from(input_url: str, t: float, extra_in=None):
    """ffmpeg input-seek to t and write one frame to a temp png -> BGR image."""
    fd, png = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        cmd = [_ffmpeg(), "-y"]
        if extra_in:
            cmd += extra_in
        cmd += ["-ss", f"{t:.3f}", "-i", input_url, "-frames:v", "1", "-q:v", "2", png]
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if r.returncode != 0 or not os.path.exists(png) or os.path.getsize(png) == 0:
            return None
        return _read_png(png)
    finally:
        try:
            os.remove(png)
        except OSError:
            pass


class LocalFrameSource:
    """Frames from a local video file. `clip_start` maps absolute source time to
    this file's timeline when the file is a trimmed clip."""

    def __init__(self, path: str, clip_start: float = 0.0):
        self.path = path
        self.clip_start = clip_start

    def grab(self, abs_t: float):
        img = _grab_from(self.path, abs_t - self.clip_start)
        if img is None:
            raise RuntimeError(f"no frame at t={abs_t} in {self.path}")
        return img


class YouTubeFrameSource:
    """Single frames from a YouTube URL without downloading the whole video."""

    def __init__(self, url: str, height: int = 720):
        self.url = url
        self.height = height
        self._media = None  # resolved direct media URL (cached)

    @property
    def _fmt(self) -> str:
        return f"bv*[height<={self.height}]/b[height<={self.height}]"

    def _resolve(self) -> str:
        if self._media:
            return self._media
        out = subprocess.run(
            [sys.executable, "-m", "yt_dlp", "-f", self._fmt, "-g", self.url],
            capture_output=True, text=True, check=True,
        )
        urls = [u for u in out.stdout.splitlines() if u.strip().startswith("http")]
        if not urls:
            raise RuntimeError("yt-dlp did not return a media URL")
        self._media = urls[0]  # video-only stream is enough (no audio needed)
        return self._media

    def _grab_section(self, abs_t: float):
        """Fallback: fetch a tiny keyframed section around abs_t, then extract."""
        d = tempfile.mkdtemp()
        try:
            sec = f"*{max(0.0, abs_t - 1):.2f}-{abs_t + 1:.2f}"
            subprocess.run(
                [sys.executable, "-m", "yt_dlp", "-f", self._fmt,
                 "--download-sections", sec, "--force-keyframes-at-cuts",
                 "-o", os.path.join(d, "seg.%(ext)s"), self.url],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
            )
            segs = [f for f in os.listdir(d) if not f.endswith(".part")]
            if not segs:
                raise RuntimeError("section download produced no file")
            # section starts ~1s before abs_t, so grab ~1s in
            img = _grab_from(os.path.join(d, segs[0]), 1.0)
            if img is None:
                raise RuntimeError(f"no frame in section around t={abs_t}")
            return img
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def grab(self, abs_t: float):
        img = _grab_from(self._resolve(), abs_t)  # range-seek, no full download
        if img is None:
            img = self._grab_section(abs_t)        # format won't seek -> tiny section
        return img


def make_source(url=None, video=None, clip_start=0.0, height=720):
    if url:
        return YouTubeFrameSource(url, height=height)
    if video:
        return LocalFrameSource(video, clip_start=clip_start)
    raise ValueError("need --url or --video")
