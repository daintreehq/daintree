import {
  CUSTOM_SOUND_MAX_FRAMES,
  CUSTOM_SOUND_MAX_SECONDS,
  CUSTOM_SOUND_MAX_SOURCE_BYTES,
  CUSTOM_SOUND_SAMPLE_RATE,
  type CustomNotificationSound,
  type ImportNotificationSoundPayload,
} from "@shared/types/ipc/notificationSounds";
import { encodeNotificationWav, notificationSoundLabel } from "@shared/utils/notificationSoundWav";

export type SoundImportRefusal = "too-large" | "too-long" | "undecodable";

const REFUSAL_MESSAGES: Record<SoundImportRefusal, string> = {
  "too-large": "Choose a file under 8 MB",
  "too-long": "Choose a sound that's 3 seconds or shorter",
  undecodable: "That file couldn't be read as audio",
};

export class SoundImportError extends Error {
  constructor(readonly reason: SoundImportRefusal) {
    super(REFUSAL_MESSAGES[reason]);
    this.name = "SoundImportError";
  }
}

export function soundImportErrorMessage(error: unknown): string {
  if (error instanceof SoundImportError) return error.message;
  return "Couldn't save that sound. Try again.";
}

type DecodedAudio = Pick<AudioBuffer, "numberOfChannels" | "length" | "getChannelData">;

// How long to wait for a file's duration before decoding it anyway.
const DURATION_PROBE_TIMEOUT_MS = 5_000;
// Containers can report encoder padding in their duration, so only a clearly
// longer file is refused before decoding; the decoded length is the exact check.
const DURATION_PROBE_TOLERANCE_SECONDS = 0.5;

/** Average every channel into one, the way the stored mono file will play it. */
export function downmixToMono(buffer: DecodedAudio): Float32Array {
  const mono = new Float32Array(buffer.length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    buffer.getChannelData(c).forEach((sample, i) => {
      mono[i] = (mono[i] ?? 0) + sample / channels;
    });
  }
  return mono;
}

/**
 * The file's duration from its metadata alone, or null when the media element
 * can't tell. Decoding materialises every sample at 44.1 kHz, so a long recording
 * that compresses under the size limit is refused here instead of after hundreds
 * of megabytes of decoding.
 */
async function probeDuration(file: File): Promise<number | null> {
  let url: string;
  try {
    url = URL.createObjectURL(file);
  } catch {
    return null;
  }
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  try {
    return await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), DURATION_PROBE_TIMEOUT_MS);
      audio.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve(Number.isFinite(audio.duration) ? audio.duration : null);
      };
      audio.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      audio.src = url;
    });
  } finally {
    audio.onloadedmetadata = null;
    audio.onerror = null;
    // load() after dropping the source aborts a load the timeout gave up on.
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Decode any audio this window can read and re-encode it as the WAV every
 * bundled sound already is: decoding at 44.1 kHz resamples it, and the channels
 * are averaged to mono. Over three seconds is refused rather than cut short.
 */
export async function encodeImportedSound(file: File): Promise<ImportNotificationSoundPayload> {
  if (file.size > CUSTOM_SOUND_MAX_SOURCE_BYTES) throw new SoundImportError("too-large");
  if (file.size === 0) throw new SoundImportError("undecodable");
  const duration = await probeDuration(file);
  if (duration !== null && duration > CUSTOM_SOUND_MAX_SECONDS + DURATION_PROBE_TOLERANCE_SECONDS) {
    throw new SoundImportError("too-long");
  }

  let decoded: AudioBuffer;
  try {
    const context = new OfflineAudioContext(1, 1, CUSTOM_SOUND_SAMPLE_RATE);
    decoded = await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new SoundImportError("undecodable");
  }
  if (decoded.length === 0 || decoded.numberOfChannels === 0) {
    throw new SoundImportError("undecodable");
  }
  if (decoded.length > CUSTOM_SOUND_MAX_FRAMES) throw new SoundImportError("too-long");

  return {
    label: notificationSoundLabel(file.name),
    wav: encodeNotificationWav(downmixToMono(decoded)),
  };
}

export async function importNotificationSound(file: File): Promise<CustomNotificationSound> {
  const payload = await encodeImportedSound(file);
  return window.electron.notificationSounds.importSound(payload);
}
