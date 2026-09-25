import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Opus always runs its granule clock at 48 kHz, whatever rate the input had. */
const OPUS_GRANULE_RATE = 48000;
const CAPTURE = Buffer.from("OggS", "latin1");
const OPUS_HEAD = Buffer.from("OpusHead", "latin1");

/**
 * Re-encode any recording to mono Ogg Opus, the format the tour plays and the
 * format speech-to-text is asked to read, so word times are measured on the
 * exact bytes that ship.
 */
export async function encodeOggOpus(input: string, output: string): Promise<void> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      input,
      "-ac",
      "1",
      "-c:a",
      "libopus",
      "-b:a",
      "48k",
      output,
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("ffmpeg was not found on PATH; install it to align your own recordings.");
    }
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`ffmpeg could not encode ${input}${stderr ? `: ${stderr}` : ""}`);
  }
}

/**
 * Playable length of an Ogg Opus stream in seconds: the final granule position
 * of its logical stream minus the encoder's pre-skip, over the 48 kHz Opus
 * clock. Read from the bytes, so no ffprobe is needed.
 */
export function oggOpusDuration(bytes: Buffer): number {
  const first = bytes.indexOf(CAPTURE);
  if (first !== 0 || bytes.length < 27) throw new Error("Not an Ogg stream");
  const serial = bytes.readUInt32LE(first + 14);
  const headAt = bytes.indexOf(OPUS_HEAD, first);
  if (headAt < 0 || headAt + 12 > bytes.length) throw new Error("Not an Ogg Opus stream");
  const preSkip = bytes.readUInt16LE(headAt + 10);

  // The last page of the stream carries the final granule; a page whose
  // granule is -1 finishes no packet, so keep walking back past it.
  for (let at = bytes.lastIndexOf(CAPTURE); at > first; at = bytes.lastIndexOf(CAPTURE, at - 1)) {
    if (at + 27 > bytes.length || bytes[at + 4] !== 0) continue;
    if (bytes.readUInt32LE(at + 14) !== serial) continue;
    const granule = bytes.readBigInt64LE(at + 6);
    if (granule < 0n) continue;
    const samples = Number(granule) - preSkip;
    if (samples <= 0) break;
    return samples / OPUS_GRANULE_RATE;
  }
  throw new Error("Ogg Opus stream has no audio pages");
}
