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
    getChannelData: (c: number) => Float32Array.from(channels[c] ?? []),
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
    const threeChannels = decodedAudio([
      [0.75, 0],
      [0, 0],
      [0, -0.75],
    ]);
    expect(Array.from(downmixToMono(threeChannels))).toEqual([0.25, -0.25]);
  });

  it("encodes the averaged samples, not one channel", async () => {
    decodeAudioData.mockResolvedValue(decodedAudio([[0.5], [0]]));

    const { wav } = await encodeImportedSound(audioFile());

    expect(new DataView(wav.buffer).getInt16(44, true)).toBe(Math.trunc(0.25 * 0x7fff));
  });

  describe("duration from metadata", () => {
    let duration: number | null | "never";
    const load = vi.fn();

    beforeEach(() => {
      duration = null;
      // jsdom has no object URLs; outside this block the probe finds none and decodes.
      Object.defineProperty(URL, "createObjectURL", {
        value: vi.fn(() => "blob:sound"),
        configurable: true,
      });
      Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
      const realCreate = document.createElement.bind(document);
      const createElement = (tag: string): HTMLElement => {
        if (tag !== "audio") return realCreate(tag);
        const audio = {
          preload: "",
          duration: Number.NaN,
          onloadedmetadata: null as null | (() => void),
          onerror: null as null | (() => void),
          removeAttribute: vi.fn(),
          load,
          set src(_: string) {
            queueMicrotask(() => {
              if (duration === "never") return;
              if (duration === null) {
                audio.onerror?.();
                return;
              }
              audio.duration = duration;
              audio.onloadedmetadata?.();
            });
          },
        };
        return audio as unknown as HTMLElement;
      };
      vi.spyOn(document, "createElement").mockImplementation(
        createElement as typeof document.createElement
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    });

    it("refuses a long recording before reading or decoding it", async () => {
      duration = 3600;
      const file = audioFile("lecture.opus", 2 * 1024 * 1024);

      expect(await refusal(encodeImportedSound(file))).toBe("too-long");
      expect(file.arrayBuffer).not.toHaveBeenCalled();
      expect(decodeAudioData).not.toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sound");
    });

    it("leaves a duration within the encoder-padding margin to the exact decoded check", async () => {
      duration = 3.2;
      decodeAudioData.mockResolvedValue(decodedAudio([[0.1]]));

      await expect(encodeImportedSound(audioFile())).resolves.toBeTruthy();
    });

    it("decodes when the metadata can't say", async () => {
      decodeAudioData.mockResolvedValue(decodedAudio([[0.1]]));

      await expect(encodeImportedSound(audioFile())).resolves.toBeTruthy();
      expect(decodeAudioData).toHaveBeenCalled();
    });

    it("gives up on metadata that never arrives, aborts that load, and decodes", async () => {
      vi.useFakeTimers();
      try {
        duration = "never";
        load.mockClear();
        decodeAudioData.mockResolvedValue(decodedAudio([[0.1]]));

        const pending = encodeImportedSound(audioFile());
        await vi.advanceTimersByTimeAsync(4_999);
        expect(decodeAudioData).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        await expect(pending).resolves.toBeTruthy();
        expect(load).toHaveBeenCalled();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sound");
      } finally {
        vi.useRealTimers();
      }
    });
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

  it("reads a file exactly at the size limit", async () => {
    decodeAudioData.mockResolvedValue(decodedAudio([[0.1]]));

    await expect(
      encodeImportedSound(audioFile("max.wav", CUSTOM_SOUND_MAX_SOURCE_BYTES))
    ).resolves.toBeTruthy();
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
    ["no samples in it", () => decodeAudioData.mockResolvedValue(decodedAudio([[]]))],
    [
      "no channels in it",
      () =>
        decodeAudioData.mockResolvedValue({
          numberOfChannels: 0,
          length: 4,
          getChannelData: () => new Float32Array(4),
        }),
    ],
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
    const sent = importSound.mock.calls[0]?.[0] as { label: string; wav: Uint8Array };
    expect(sent.label).toBe("bell");
    expect(isNotificationWav(sent.wav)).toBe(true);
  });

  it("says why a file was refused, and offers a retry for anything else", () => {
    expect(soundImportErrorMessage(new SoundImportError("too-long"))).toMatch(/3 seconds/);
    expect(soundImportErrorMessage(new SoundImportError("too-large"))).toMatch(/8 MB/);
    expect(soundImportErrorMessage(new SoundImportError("undecodable"))).toMatch(/read as audio/);
    expect(soundImportErrorMessage(new Error("EACCES"))).toMatch(/Try again/);
  });
});
