import {
  CUSTOM_SOUND_MAX_FRAMES,
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

/** Average every channel into one, the way the stored mono file will play it. */
export function downmixToMono(buffer: DecodedAudio): Float32Array {
  const mono = new Float32Array(buffer.length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < mono.length; i++) mono[i] /= channels;
  }
  return mono;
}

/**
 * Decode any audio this window can read and re-encode it as the WAV every
 * bundled sound already is: decoding at 44.1 kHz resamples it, and the channels
 * are averaged to mono. Over three seconds is refused rather than cut short.
 */
export async function encodeImportedSound(file: File): Promise<ImportNotificationSoundPayload> {
  if (file.size > CUSTOM_SOUND_MAX_SOURCE_BYTES) throw new SoundImportError("too-large");
  if (file.size === 0) throw new SoundImportError("undecodable");

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
