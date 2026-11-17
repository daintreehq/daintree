/**
 * Notification sounds a picker can choose: the bundled six, plus files the user
 * imported on this device. An import is stored under a generated id, never under
 * the path it came from, and its WAV lives in this device's app data.
 */

/** The bundled sounds a notification picker offers, in picker order. */
export const BUNDLED_NOTIFICATION_SOUNDS: readonly { file: string; label: string }[] = [
  { file: "chime.wav", label: "Chime" },
  { file: "ping.wav", label: "Ping" },
  { file: "complete.wav", label: "Complete" },
  { file: "waiting.wav", label: "Waiting" },
  { file: "error.wav", label: "Error" },
  { file: "pulse.wav", label: "Pulse" },
];

const CUSTOM_SOUND_ID_PREFIX = "custom:";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Imports are stored the way every bundled sound already is, so the OS fallback
 * player (WAV-only on Windows) can play them with no window open.
 */
export const CUSTOM_SOUND_SAMPLE_RATE = 44_100;
export const CUSTOM_SOUND_MAX_SECONDS = 3;
export const CUSTOM_SOUND_MAX_FRAMES = CUSTOM_SOUND_SAMPLE_RATE * CUSTOM_SOUND_MAX_SECONDS;
export const WAV_HEADER_BYTES = 44;
/** A stored import: a canonical 16-bit mono header plus at most three seconds of samples. */
export const CUSTOM_SOUND_MAX_WAV_BYTES = WAV_HEADER_BYTES + CUSTOM_SOUND_MAX_FRAMES * 2;
/** Refused before reading, so a huge file is never decoded just to find it's too long. */
export const CUSTOM_SOUND_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const CUSTOM_SOUND_MAX_LABEL_LENGTH = 60;

/** The uuid inside a well-formed custom sound id, or null for anything else. */
export function parseCustomSoundId(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(CUSTOM_SOUND_ID_PREFIX)) return null;
  const uuid = value.slice(CUSTOM_SOUND_ID_PREFIX.length);
  return UUID_V4.test(uuid) ? uuid : null;
}

export function isCustomSoundId(value: unknown): value is string {
  return parseCustomSoundId(value) !== null;
}

export function customSoundId(uuid: string): string {
  return `${CUSTOM_SOUND_ID_PREFIX}${uuid}`;
}

/** The stored WAV's filename inside the custom sounds directory. */
export function customSoundFileName(id: string): string | null {
  const uuid = parseCustomSoundId(id);
  return uuid ? `${uuid}.wav` : null;
}

/** A sound value a project may keep: a bundled choice, or a well-formed import id. */
export function isSelectableNotificationSound(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return BUNDLED_NOTIFICATION_SOUNDS.some((s) => s.file === value) || isCustomSoundId(value);
}

export interface CustomNotificationSound {
  id: string;
  label: string;
}

export interface CustomNotificationSoundEntry extends CustomNotificationSound {
  /** False when the stored file has gone missing since it was imported. */
  available: boolean;
}

export interface ImportNotificationSoundPayload {
  /** The original file's name, for display only. */
  label: string;
  /** Canonical 16-bit PCM mono 44.1 kHz WAV bytes, encoded in the window. */
  wav: Uint8Array;
}
