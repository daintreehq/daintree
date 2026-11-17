import {
  CUSTOM_SOUND_MAX_LABEL_LENGTH,
  CUSTOM_SOUND_MAX_WAV_BYTES,
  CUSTOM_SOUND_SAMPLE_RATE,
  WAV_HEADER_BYTES,
} from "../types/ipc/notificationSounds.js";
import { displaySafeText } from "./displaySafeText.js";

const BYTES_PER_SAMPLE = 2;

function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
}

function readTag(view: DataView, offset: number): string {
  let tag = "";
  for (let i = 0; i < 4; i++) tag += String.fromCharCode(view.getUint8(offset + i));
  return tag;
}

/** Encode mono float samples (-1..1) as a 16-bit PCM WAV at the custom sound rate. */
export function encodeNotificationWav(samples: Float32Array): Uint8Array {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  writeTag(view, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeTag(view, 8, "WAVE");
  writeTag(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, CUSTOM_SOUND_SAMPLE_RATE, true);
  view.setUint32(28, CUSTOM_SOUND_SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeTag(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  samples.forEach((raw, i) => {
    const s = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    view.setInt16(WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  });
  return bytes;
}

/**
 * True only for exactly what {@link encodeNotificationWav} writes: one canonical
 * 44-byte header, 16-bit PCM, mono, 44.1 kHz, at least one frame and no more than
 * the three-second cap, with nothing after the samples.
 */
export function isNotificationWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < WAV_HEADER_BYTES + BYTES_PER_SAMPLE) return false;
  if (bytes.byteLength > CUSTOM_SOUND_MAX_WAV_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataBytes = bytes.byteLength - WAV_HEADER_BYTES;
  return (
    readTag(view, 0) === "RIFF" &&
    view.getUint32(4, true) === bytes.byteLength - 8 &&
    readTag(view, 8) === "WAVE" &&
    readTag(view, 12) === "fmt " &&
    view.getUint32(16, true) === 16 &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === CUSTOM_SOUND_SAMPLE_RATE &&
    view.getUint32(28, true) === CUSTOM_SOUND_SAMPLE_RATE * BYTES_PER_SAMPLE &&
    view.getUint16(32, true) === BYTES_PER_SAMPLE &&
    view.getUint16(34, true) === 16 &&
    readTag(view, 36) === "data" &&
    view.getUint32(40, true) === dataBytes &&
    dataBytes % BYTES_PER_SAMPLE === 0
  );
}

/**
 * A label as Main stores and shows it: one safe line, bounded length. Idempotent,
 * so a stored label read back and saved again never loses text.
 */
export function sanitizeSoundLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return displaySafeText(raw)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CUSTOM_SOUND_MAX_LABEL_LENGTH)
    .trim();
}

/** A picker label from the chosen file's name: its extension dropped, once. */
export function notificationSoundLabel(fileName: string): string {
  return sanitizeSoundLabel(fileName.replace(/\.[a-z0-9]{1,8}$/i, ""));
}
