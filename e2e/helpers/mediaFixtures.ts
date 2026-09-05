import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

/**
 * Real media fixtures for the direct-streaming mechanism check (#12242).
 *
 * Generated rather than committed: the shapes that matter are container
 * layouts, and a binary blob in the repo would tell a reader nothing about why
 * it is shaped that way. `ffmpeg-static` is already a devDependency (the demo
 * reel probes recordings with it), so nothing new is installed.
 *
 * These are the shapes the experiment has to survive. A trailing-`moov` mp4 is
 * the load-bearing one: its index sits at EOF, so nothing plays until the media
 * loader fetches the end of the file and then goes back for the payload — which
 * is exactly the follow-up range a non-`standard` scheme never issued.
 */
export interface MediaFixture {
  /** Stable id used in test names and in the reported results table. */
  name: string;
  /** Absolute path on disk, inside the fixture root. */
  filePath: string;
  /** Size in bytes, from a post-generation stat. */
  size: number;
  kind: "video" | "audio";
  /** Verified by walking the box list, never assumed from the ffmpeg flags. */
  moov?: "leading" | "trailing";
}

function ffmpeg(): string {
  if (!ffmpegPath) {
    throw new Error(
      "ffmpeg-static did not resolve a binary — the media mechanism check cannot generate its fixtures."
    );
  }
  return ffmpegPath;
}

function run(args: string[]): void {
  execFileSync(ffmpeg(), ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/**
 * Walk the top-level ISO-BMFF box list and report whether `moov` precedes
 * `mdat`. Reading the boxes is the only honest way to know: `+faststart` is a
 * request, not a guarantee, and a fixture that silently came out the other way
 * round would quietly turn the decisive test case into a trivial one.
 */
export function readMoovPlacement(filePath: string): "leading" | "trailing" {
  const fd = openSync(filePath, "r");
  try {
    const size = statSync(filePath).size;
    const header = Buffer.alloc(16);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, header, 0, 16, offset);
      if (read < 8) break;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      // `1` means the real size is the 64-bit `largesize` that follows; `0`
      // means the box runs to EOF. Both appear in files this size.
      let headerBytes = 8;
      if (boxSize === 1) {
        if (read < 16) break;
        boxSize = Number(header.readBigUInt64BE(8));
        headerBytes = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset;
      }
      if (type === "moov") return "leading";
      if (type === "mdat") return "trailing";
      if (boxSize < headerBytes) break;
      offset += boxSize;
    }
    throw new Error(`no moov/mdat box found in ${filePath}`);
  } finally {
    closeSync(fd);
  }
}

function sized(name: string, filePath: string, kind: "video" | "audio"): MediaFixture {
  return { name, filePath, size: statSync(filePath).size, kind };
}

/**
 * Generate the fixture set into `dir`. Returns them in the order the spec
 * reports them.
 *
 * `largeTargetBytes` sizes the big recording the byte-accounting runs against.
 * It is built by remuxing one encoded clip end to end with `-c copy`, so the
 * cost is a file write rather than an encode, and every frame is real encoded
 * media rather than padding a decoder would refuse.
 */
export function createMediaFixtures(
  dir: string,
  options: { largeTargetBytes?: number } = {}
): { fixtures: MediaFixture[]; large: MediaFixture; ffmpegVersion: string } {
  mkdirSync(dir, { recursive: true });
  const at = (name: string) => path.join(dir, name);

  const version = execFileSync(ffmpeg(), ["-version"], { encoding: "utf8" }).split("\n")[0].trim();

  // Default muxing leaves moov after mdat — the QuickTime/OBS layout.
  run([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=15:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    at("trailing-moov.mp4"),
  ]);
  run([
    "-i",
    at("trailing-moov.mp4"),
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    at("leading-moov.mp4"),
  ]);
  run([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=15:duration=3",
    "-c:v",
    "libvpx",
    "-b:v",
    "200k",
    at("clip.webm"),
  ]);
  run(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", at("tone.m4a")]);
  run(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", at("tone.mp3")]);

  const fixtures: MediaFixture[] = [
    {
      ...sized("trailing-moov mp4", at("trailing-moov.mp4"), "video"),
      moov: readMoovPlacement(at("trailing-moov.mp4")),
    },
    {
      ...sized("leading-moov mp4", at("leading-moov.mp4"), "video"),
      moov: readMoovPlacement(at("leading-moov.mp4")),
    },
    sized("webm", at("clip.webm"), "video"),
    sized("m4a", at("tone.m4a"), "audio"),
    sized("mp3", at("tone.mp3"), "audio"),
  ];

  // One high-bitrate seed clip, then looped by remux until it clears the
  // target. Encoding a gigabyte directly would dominate the run for no gain —
  // the byte accounting only cares that the file is far larger than the ranges
  // playback actually pulls.
  const seed = at("seed.mp4");
  run([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30:duration=5",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    "8M",
    seed,
  ]);
  const targetBytes = options.largeTargetBytes ?? 600 * 1024 * 1024;
  const loops = Math.max(1, Math.ceil(targetBytes / statSync(seed).size));
  const largePath = at("large-trailing-moov.mp4");
  run(["-stream_loop", String(loops - 1), "-i", seed, "-c", "copy", largePath]);
  const large: MediaFixture = {
    ...sized("large trailing-moov mp4", largePath, "video"),
    moov: readMoovPlacement(largePath),
  };

  return { fixtures, large, ffmpegVersion: version };
}
