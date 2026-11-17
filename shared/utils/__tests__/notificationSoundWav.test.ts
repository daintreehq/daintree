import { describe, expect, it } from "vitest";
import {
  encodeNotificationWav,
  isNotificationWav,
  notificationSoundLabel,
  sanitizeSoundLabel,
} from "../notificationSoundWav.js";
import {
  CUSTOM_SOUND_MAX_FRAMES,
  CUSTOM_SOUND_MAX_WAV_BYTES,
  customSoundFileName,
  parseCustomSoundId,
} from "../../types/ipc/notificationSounds.js";

function sample(bytes: Uint8Array, index: number): number {
  return new DataView(bytes.buffer).getInt16(44 + index * 2, true);
}

describe("encodeNotificationWav / isNotificationWav", () => {
  it("round-trips: what the window encodes, Main accepts", () => {
    const wav = encodeNotificationWav(new Float32Array([0, 0.5, -0.5]));

    expect(wav.byteLength).toBe(44 + 3 * 2);
    expect(isNotificationWav(wav)).toBe(true);
  });

  it("clamps samples to the 16-bit range and writes silence for non-finite ones", () => {
    const wav = encodeNotificationWav(new Float32Array([1, -1, 2, -2, Number.NaN]));

    expect(sample(wav, 0)).toBe(0x7fff);
    expect(sample(wav, 1)).toBe(-0x8000);
    expect(sample(wav, 2)).toBe(0x7fff);
    expect(sample(wav, 3)).toBe(-0x8000);
    expect(sample(wav, 4)).toBe(0);
  });

  it("accepts exactly three seconds and refuses one frame more", () => {
    const atCap = encodeNotificationWav(new Float32Array(CUSTOM_SOUND_MAX_FRAMES));
    const overCap = encodeNotificationWav(new Float32Array(CUSTOM_SOUND_MAX_FRAMES + 1));

    expect(atCap.byteLength).toBe(CUSTOM_SOUND_MAX_WAV_BYTES);
    expect(isNotificationWav(atCap)).toBe(true);
    expect(isNotificationWav(overCap)).toBe(false);
  });

  it("refuses an empty sound", () => {
    expect(isNotificationWav(encodeNotificationWav(new Float32Array(0)))).toBe(false);
  });

  it.each([
    ["RIFF tag", 0, (v: DataView) => v.setUint8(0, 0x58)],
    ["RIFF length", 4, (v: DataView) => v.setUint32(4, 999, true)],
    ["format (not PCM)", 20, (v: DataView) => v.setUint16(20, 3, true)],
    ["channel count", 22, (v: DataView) => v.setUint16(22, 2, true)],
    ["sample rate", 24, (v: DataView) => v.setUint32(24, 48_000, true)],
    ["byte rate", 28, (v: DataView) => v.setUint32(28, 1, true)],
    ["block align", 32, (v: DataView) => v.setUint16(32, 4, true)],
    ["bits per sample", 34, (v: DataView) => v.setUint16(34, 8, true)],
    ["data length", 40, (v: DataView) => v.setUint32(40, 2, true)],
  ])("refuses a header with a wrong %s", (_, __, tamper) => {
    const wav = encodeNotificationWav(new Float32Array(4));
    tamper(new DataView(wav.buffer));

    expect(isNotificationWav(wav)).toBe(false);
  });

  it("refuses trailing bytes after the samples", () => {
    const wav = encodeNotificationWav(new Float32Array(4));
    const padded = new Uint8Array(wav.byteLength + 1);
    padded.set(wav);

    expect(isNotificationWav(padded)).toBe(false);
  });

  it("reads a view into a larger buffer at its own offset", () => {
    const wav = encodeNotificationWav(new Float32Array(4));
    const backing = new Uint8Array(wav.byteLength + 16);
    backing.set(wav, 16);

    expect(isNotificationWav(backing.subarray(16))).toBe(true);
  });
});

describe("notificationSoundLabel", () => {
  it("drops the extension once and keeps the name", () => {
    expect(notificationSoundLabel("Door bell.mp3")).toBe("Door bell");
    expect(notificationSoundLabel("v1.2 alert")).toBe("v1.2 alert");
    expect(notificationSoundLabel("Door.v2.wav")).toBe("Door.v2");
  });

  it("makes control and bidi characters harmless and collapses whitespace", () => {
    expect(notificationSoundLabel("a\nb\u202e\tc  \t d.wav")).toBe("a b c d");
  });

  it("bounds the length", () => {
    expect(notificationSoundLabel(`${"x".repeat(200)}.wav`)).toHaveLength(60);
  });

  it("stores a label Main can read back and save again without losing text", () => {
    const label = notificationSoundLabel("Door.v2.wav");

    expect(sanitizeSoundLabel(label)).toBe("Door.v2");
    expect(sanitizeSoundLabel(sanitizeSoundLabel(label))).toBe("Door.v2");
    expect(sanitizeSoundLabel(42)).toBe("");
  });
});

describe("custom sound ids", () => {
  const uuid = "0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e6f";

  it("derives the stored file name from the id's uuid alone", () => {
    expect(parseCustomSoundId(`custom:${uuid}`)).toBe(uuid);
    expect(customSoundFileName(`custom:${uuid}`)).toBe(`${uuid}.wav`);
  });

  it.each([
    `custom:${uuid}/../x`,
    `custom:../${uuid}`,
    `${uuid}`,
    "complete.wav",
    "custom:0b7c9a7e-4f1d-1c2a-9e3b-1a2b3c4d5e6f",
    42,
  ])("refuses %s", (value) => {
    expect(parseCustomSoundId(value)).toBeNull();
    expect(customSoundFileName(String(value))).toBeNull();
  });
});
