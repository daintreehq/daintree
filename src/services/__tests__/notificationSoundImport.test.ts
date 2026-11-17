/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_SOUND_MAX_FRAMES,
  CUSTOM_SOUND_MAX_SOURCE_BYTES,
} from "@shared/types/ipc/notificationSounds";
import { isNotificationWav } from "@shared/utils/notificationSoundWav";
import {
  SoundImportError,
  downmixToMono,
  encodeImportedSound,
  importNotificationSound,
  soundImportErrorMessage,
} from "../notificationSoundImport";

function decodedAudio(channels: number[][]) {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    getChannelData: (c: number) => Float32Array.from(channels[c]),
  };
}

const decodeAudioData = vi.fn();
const contextArgs: unknown[][] = [];

function audioFile(name = "bell.mp3", size = 1024): File {
  const file = new File([new Uint8Array(4)], name, { type: "audio/mpeg" });
  Object.defineProperty(file, "size", { value: size });
  Object.defineProperty(file, "arrayBuffer", {
    value: vi.fn(() => Promise.resolve(new ArrayBuffer(4))),
  });
  return file;
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof SoundImportError ? error.reason : "other";
  }
  return undefined;
}

describe("notificationSoundImport", () => {
  beforeEach(() => {
    decodeAudioData.mockReset();
    contextArgs.length = 0;
    vi.stubGlobal(
      "OfflineAudioContext",
      vi.fn(function (this: unknown, ...args: unknown[]) {
        contextArgs.push(args);
        return { decodeAudioData };
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  it("averages every channel into one", () => {
    expect(
      Array.from(
        downmixToMono(
          decodedAudio([
            [1, 0.5],
            [0, -0.5],
          ])
        )
      )
    ).toEqual([0.5, 0]);
    expect(Array.from(downmixToMono(decodedAudio([[0.25, -1]])))).toEqual([0.25, -1]);
  });

  it("decodes at 44.1 kHz and encodes the canonical mono WAV", async () => {
    decodeAudioData.mockResolvedValue(
      decodedAudio([
        [0.5, 0.5],
        [-0.5, 0.5],
      ])
    );

    const payload = await encodeImportedSound(audioFile("Door bell.mp3"));

    expect(contextArgs[0]).toEqual([1, 1, 44_100]);
    expect(payload.label).toBe("Door bell");
    expect(isNotificationWav(payload.wav)).toBe(true);
    expect(payload.wav.byteLength).toBe(44 + 2 * 2);
  });

  it("refuses a file over the size limit before reading it", async () => {
    const file = audioFile("huge.wav", CUSTOM_SOUND_MAX_SOURCE_BYTES + 1);

    expect(await refusal(encodeImportedSound(file))).toBe("too-large");
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it("refuses a sound longer than three seconds instead of cutting it short", async () => {
    decodeAudioData.mockResolvedValue({
      numberOfChannels: 1,
      length: CUSTOM_SOUND_MAX_FRAMES + 1,
      getChannelData: () => new Float32Array(CUSTOM_SOUND_MAX_FRAMES + 1),
    });

    expect(await refusal(encodeImportedSound(audioFile()))).toBe("too-long");
  });

  it("accepts exactly three seconds", async () => {
    decodeAudioData.mockResolvedValue({
      numberOfChannels: 1,
      length: CUSTOM_SOUND_MAX_FRAMES,
      getChannelData: () => new Float32Array(CUSTOM_SOUND_MAX_FRAMES),
    });

    const payload = await encodeImportedSound(audioFile());

    expect(isNotificationWav(payload.wav)).toBe(true);
  });

  it.each([
    ["a decode failure", () => decodeAudioData.mockRejectedValue(new DOMException("bad"))],
    ["no audio in it", () => decodeAudioData.mockResolvedValue(decodedAudio([[]]))],
  ])("refuses %s as unreadable", async (_, arrange) => {
    arrange();

    expect(await refusal(encodeImportedSound(audioFile()))).toBe("undecodable");
  });

  it("refuses an empty file as unreadable without decoding it", async () => {
    expect(await refusal(encodeImportedSound(audioFile("empty.wav", 0)))).toBe("undecodable");
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it("hands Main the encoded sound and returns what it stored", async () => {
    decodeAudioData.mockResolvedValue(decodedAudio([[0.1, 0.2]]));
    const importSound = vi.fn().mockResolvedValue({ id: "custom:x", label: "bell" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electron = { notificationSounds: { importSound } };

    await expect(importNotificationSound(audioFile())).resolves.toEqual({
      id: "custom:x",
      label: "bell",
    });
    expect(isNotificationWav(importSound.mock.calls[0][0].wav)).toBe(true);
  });

  it("says why a file was refused, and offers a retry for anything else", () => {
    expect(soundImportErrorMessage(new SoundImportError("too-long"))).toMatch(/3 seconds/);
    expect(soundImportErrorMessage(new SoundImportError("too-large"))).toMatch(/8 MB/);
    expect(soundImportErrorMessage(new Error("EACCES"))).toMatch(/Try again/);
  });
});
