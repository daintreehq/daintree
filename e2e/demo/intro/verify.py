#!/usr/bin/env python3
"""Check an assembled intro against the voice-over and render a scene-midpoint contact sheet.

Usage: verify.py <video> [audio] [sheet.png]
"""
import json
import os
import subprocess
import sys

video = sys.argv[1]
audio = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("DEMO_AUDIO", "")
if not audio:
    sys.exit("usage: verify.py <video> <voice-over.wav> [sheet.png]   (or set DEMO_AUDIO)")
sheet = sys.argv[3] if len(sys.argv) > 3 else os.path.splitext(video)[0] + "-sheet.png"

SCENES = [
    ("A grid", 0, 27), ("B pilot", 27, 57), ("C scale", 57, 83.5), ("D worktrees", 83.5, 108.5),
    ("E workflow", 108.5, 143.8), ("F fleet", 143.8, 170.5), ("G review", 170.5, 217.2),
    ("H plugins", 217.2, 285.7), ("I outro", 285.7, 304.6),
]


def probe(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames",
        "-of", "json", path,
    ])
    return json.loads(out)


v = probe(video)
a = probe(audio)
vdur = float(v["format"]["duration"])
adur = float(a["format"]["duration"])
streams = {s["codec_type"]: s for s in v["streams"]}
vs = streams.get("video", {})
problems = []
if abs(vdur - adur) > 1 / 29.97:
    problems.append(f"duration {vdur:.3f}s differs from audio {adur:.3f}s")
if (vs.get("width"), vs.get("height")) != (3840, 2160):
    problems.append(f"resolution {vs.get('width')}x{vs.get('height')}")
if vs.get("r_frame_rate") not in ("30000/1001",):
    problems.append(f"frame rate {vs.get('r_frame_rate')}")
if "audio" not in streams:
    problems.append("no audio stream")

print(f"video {vdur:.3f}s  audio {adur:.3f}s  {vs.get('codec_name')} {vs.get('width')}x{vs.get('height')} @ {vs.get('r_frame_rate')}  audio={streams.get('audio', {}).get('codec_name')}")

tmp = os.path.splitext(sheet)[0] + "_frames"
os.makedirs(tmp, exist_ok=True)
for i, (name, start, end) in enumerate(SCENES):
    t = (start + end) / 2
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.3f}", "-i", video,
        "-frames:v", "1", "-vf",
        f"scale=960:-1,drawtext=text='{name} @{t:.1f}s':x=12:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6",
        os.path.join(tmp, f"{i:02d}.png"),
    ], check=True)
subprocess.run([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate", "1",
    "-i", os.path.join(tmp, "%02d.png"), "-vf", "tile=3x3", "-frames:v", "1", sheet,
], check=True)
print("sheet", sheet)
print("OK" if not problems else "PROBLEMS: " + "; ".join(problems))
sys.exit(1 if problems else 0)
