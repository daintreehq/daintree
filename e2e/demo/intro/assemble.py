#!/usr/bin/env python3
"""Cut each scene take at its audio window and lay them on the voice-over timeline.

Each take's first frame is audio second (start - lead). Gaps and missing scenes
become black. Output: 3840x2160 29.97 fps, HEVC master plus an H.264 copy, with
the original audio muxed in.
"""
import glob
import json
import os
import subprocess
import sys

OUT = os.path.join(os.getcwd(), "artifacts", "intro")
AUDIO = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DEMO_AUDIO", "")
if not AUDIO:
    sys.exit("usage: assemble.py <voice-over.wav>   (or set DEMO_AUDIO)")
DURATION = float(subprocess.check_output([
    "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", AUDIO
]).decode().strip())
W, H = 3840, 2160

scenes = sorted(
    (json.load(open(p)) for p in glob.glob(os.path.join(OUT, "*.json"))),
    key=lambda s: s["start"],
)
parts = []
cursor = 0.0
for i, s in enumerate(scenes):
    start = max(s["start"], cursor)
    end = scenes[i + 1]["start"] if i + 1 < len(scenes) else DURATION
    end = min(end, s["end"] + 0.9, DURATION) if i + 1 == len(scenes) else end
    if start > cursor + 0.001:
        parts.append(("black", cursor, start))
    parts.append(("scene", start, end, s))
    cursor = end
if cursor < DURATION:
    parts.append(("black", cursor, DURATION))

segs = []
for n, p in enumerate(parts):
    seg = os.path.join(OUT, f"seg_{n:02d}.mov")
    if p[0] == "black":
        _, a, b = p
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
               f"color=c=black:s={W}x{H}:r=30000/1001", "-t", f"{b - a:.6f}"]
    else:
        _, a, b, s = p
        # A scene may carry an edit list: each entry says "audio second audioStart plays from
        # file second fileStart", running until the next entry. That is how waits get cut out.
        edl = sorted(s.get("edl") or [{"audioStart": s["start"], "fileStart": s["lead"]}],
                     key=lambda e: e["audioStart"])
        pieces = []
        for k, e in enumerate(edl):
            seg_a = max(a, e["audioStart"])
            seg_b = min(b, edl[k + 1]["audioStart"] if k + 1 < len(edl) else b)
            if seg_b - seg_a <= 0.001:
                continue
            pieces.append((seg_a, seg_b, e["fileStart"] + (seg_a - e["audioStart"])))
        if len(pieces) > 1:
            sub = []
            for j, (pa, pb, fs) in enumerate(pieces):
                sp = os.path.join(OUT, f"seg_{n:02d}_{j:02d}.mov")
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{fs:.6f}", "-i", s["file"],
                                "-t", f"{pb - pa:.6f}", "-vf", f"scale={W}:{H}:flags=lanczos,fps=30000/1001",
                                "-an", "-c:v", "hevc_videotoolbox", "-b:v", "70M", "-tag:v", "hvc1",
                                "-pix_fmt", "yuv420p", sp], check=True)
                sub.append(sp)
                print(f"  cut {pa:8.3f} -> {pb:8.3f} from file {fs:.3f}")
            sl = os.path.join(OUT, f"seg_{n:02d}_list.txt")
            with open(sl, "w") as f:
                f.writelines(f"file '{x}'\n" for x in sub)
            seg = os.path.join(OUT, f"seg_{n:02d}.mov")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", sl,
                            "-c", "copy", seg], check=True)
            segs.append(seg)
            print(f"{p[0]:5s} {p[1]:8.3f} -> {p[2]:8.3f} ({len(pieces)} cuts)")
            continue
        offset = pieces[0][2] if pieces else a - (s["start"] - s["lead"])
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{offset:.6f}", "-i", s["file"],
               "-t", f"{b - a:.6f}", "-vf", f"scale={W}:{H}:flags=lanczos,fps=30000/1001"]
    cmd += ["-an", "-c:v", "hevc_videotoolbox", "-b:v", "70M", "-tag:v", "hvc1",
            "-pix_fmt", "yuv420p", seg]
    subprocess.run(cmd, check=True)
    segs.append(seg)
    print(f"{p[0]:5s} {p[1]:8.3f} -> {p[2]:8.3f}")

lst = os.path.join(OUT, "concat.txt")
with open(lst, "w") as f:
    f.writelines(f"file '{s}'\n" for s in segs)
video = os.path.join(OUT, "video-only.mov")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
                "-c", "copy", video], check=True)

master = os.path.join(OUT, "daintree-intro-4k-hevc.mov")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-i", AUDIO,
                "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "pcm_s24le",
                "-t", f"{DURATION:.6f}", master], check=True)
h264 = os.path.join(OUT, "daintree-intro-4k-h264.mp4")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-i", AUDIO,
                "-map", "0:v", "-map", "1:a", "-c:v", "h264_videotoolbox", "-b:v", "60M",
                "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k",
                "-t", f"{DURATION:.6f}", "-movflags", "+faststart", h264], check=True)
print("audio", DURATION)
for f in (master, h264):
    print(f, subprocess.check_output(["ffprobe", "-v", "error", "-show_entries",
          "format=duration:stream=codec_name,width,height,r_frame_rate", "-of", "compact", f]).decode())
