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

function readTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
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
  for (let i = 0; i < samples.length; i++) {
    const s = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    view.setInt16(WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
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
    readTag(bytes, 0) === "RIFF" &&
    view.getUint32(4, true) === bytes.byteLength - 8 &&
    readTag(bytes, 8) === "WAVE" &&
    readTag(bytes, 12) === "fmt " &&
    view.getUint32(16, true) === 16 &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === CUSTOM_SOUND_SAMPLE_RATE &&
    view.getUint32(28, true) === CUSTOM_SOUND_SAMPLE_RATE * BYTES_PER_SAMPLE &&
    view.getUint16(32, true) === BYTES_PER_SAMPLE &&
    view.getUint16(34, true) === 16 &&
    readTag(bytes, 36) === "data" &&
    view.getUint32(40, true) === dataBytes &&
    dataBytes % BYTES_PER_SAMPLE === 0
  );
}

/** A picker label from a file name: no extension, one safe line, bounded length. */
export function notificationSoundLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const withoutExtension = raw.replace(/\.[^./\\]{1,8}$/, "");
  return displaySafeText(withoutExtension)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CUSTOM_SOUND_MAX_LABEL_LENGTH)
    .trim();
}
