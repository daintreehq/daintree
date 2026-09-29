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
      throw new Error("ffmpeg was not found on PATH; install it to align your own recordings.", {
        cause: error,
      });
    }
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`ffmpeg could not encode ${input}${stderr ? `: ${stderr}` : ""}`, {
      cause: error,
    });
  }
}

/**
 * Playable length of a single-stream Ogg Opus file in seconds: the final
 * granule position minus the encoder's pre-skip, over the 48 kHz Opus clock
 * (RFC 7845). Walks every page by its segment table, so a stray "OggS" inside
 * a packet can never be mistaken for a page. Chained or multiplexed streams,
 * as neither TTS nor our ffmpeg encode produces, are refused rather than
 * guessed at.
 */
export function oggOpusDuration(bytes: Buffer): number {
  let offset = 0;
  let serial: number | null = null;
  let preSkip: number | null = null;
  let finalGranule: bigint | null = null;
  let ended = false;

  while (offset < bytes.length) {
    if (ended)
      throw new Error("Ogg stream continues past its end page (chained streams unsupported)");
    if (offset + 27 > bytes.length || !bytes.subarray(offset, offset + 4).equals(CAPTURE)) {
      throw new Error(serial === null ? "Not an Ogg stream" : "Ogg stream is truncated or corrupt");
    }
    if (bytes[offset + 4] !== 0) throw new Error("Unsupported Ogg version");
    const headerType = bytes[offset + 5]!;
    const granule = bytes.readBigInt64LE(offset + 6);
    const pageSerial = bytes.readUInt32LE(offset + 14);
    const segmentCount = bytes[offset + 26]!;
    const bodyStart = offset + 27 + segmentCount;
    if (bodyStart > bytes.length) throw new Error("Ogg stream is truncated or corrupt");
    let bodyLength = 0;
    for (let i = 0; i < segmentCount; i++) bodyLength += bytes[offset + 27 + i]!;
    const bodyEnd = bodyStart + bodyLength;
    if (bodyEnd > bytes.length) throw new Error("Ogg stream is truncated or corrupt");

    if (serial === null) {
      if (!(headerType & 0x02)) throw new Error("Ogg stream does not open with a start page");
      serial = pageSerial;
      const head = bytes.subarray(bodyStart, bodyEnd);
      if (head.length < 19 || !head.subarray(0, 8).equals(OPUS_HEAD)) {
        throw new Error("Not an Ogg Opus stream");
      }
      preSkip = head.readUInt16LE(10);
    } else if (pageSerial !== serial) {
      throw new Error("Ogg file holds more than one stream (multiplexed streams unsupported)");
    }
    // -1 marks a page on which no packet finishes.
    if (granule >= 0n) finalGranule = granule;
    if (headerType & 0x04) ended = true;
    offset = bodyEnd;
  }

  // Without its end page the file was cut short at a page boundary, and the
  // last granule seen would under-report the length.
  if (serial !== null && !ended) throw new Error("Ogg stream is truncated (no end page)");
  if (finalGranule === null || preSkip === null) throw new Error("Ogg Opus stream has no audio");
  const samples = finalGranule - BigInt(preSkip);
  if (samples <= 0n) throw new Error("Ogg Opus stream has no audio");
  return Number(samples) / OPUS_GRANULE_RATE;
}
