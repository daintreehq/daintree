/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type GainMock = {
  gain: { setTargetAtTime: ReturnType<typeof vi.fn>; value: number };
  connect: ReturnType<typeof vi.fn>;
};

type SourceMock = {
  buffer: AudioBuffer | null;
  detune: { value: number };
  detuneAtStart: number | null;
  connect: ReturnType<typeof vi.fn>;
  gainNode: GainMock | null;
  start: (when?: number) => void;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
};

function createMockAudioContext() {
  const mockStart = vi.fn();
  // suspend() and resume() settle asynchronously and in call order, as Web
  // Audio control messages do: `state` still reads "running" while a suspend
  // is in flight, and a resume issued behind it lands after it.
  let controlQueue: Promise<void> = Promise.resolve();
  const enqueue = (next: string) =>
    (controlQueue = controlQueue.then(() => {
      state = next;
    }));
  const mockResume = vi.fn(() => enqueue("running"));
  const mockSuspend = vi.fn(() => enqueue("suspended"));
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockDecodeAudioData = vi.fn();
  const sources: SourceMock[] = [];

  let state = "running";
  // Holds the gain node returned by the most recent createGain() call so
  // source.connect(gainNode) can capture it without an unsafe cast.
  let pendingGainNode: GainMock | null = null;

  const ctx = {
    get state() {
      return state;
    },
    set state(v: string) {
      state = v;
    },
    currentTime: 0,
    destination: {},
    createBufferSource: vi.fn(() => {
      const source: SourceMock = {
        buffer: null,
        detune: { value: 0 },
        detuneAtStart: null,
        connect: vi.fn(() => {
          if (pendingGainNode) {
            source.gainNode = pendingGainNode;
            pendingGainNode = null;
          }
        }),
        gainNode: null,
        start: (when?: number) => {
          source.detuneAtStart = source.detune.value;
          mockStart(when);
        },
        stop: vi.fn(),
        onended: null,
      };
      sources.push(source);
      return source;
    }),
    createGain: vi.fn(() => {
      const gainNode: GainMock = {
        gain: { setTargetAtTime: vi.fn(), value: 1 },
        connect: vi.fn(),
      };
      pendingGainNode = gainNode;
      return gainNode;
    }),
    decodeAudioData: mockDecodeAudioData,
    resume: mockResume,
    suspend: mockSuspend,
    close: mockClose,
  };

  return { ctx, mockStart, mockResume, mockSuspend, mockClose, mockDecodeAudioData, sources };
}

describe("WebAudioService", () => {
  let activeService: typeof import("@/services/WebAudioService") | undefined;

  afterEach(() => {
    // vi.resetModules() leaves the previous instance's idle timer armed.
    activeService?.dispose();
    activeService = undefined;
    vi.useRealTimers();
  });

  async function setupTest(opts: { ctxState?: string } = {}) {
    vi.resetModules();
    vi.restoreAllMocks();

    const { ctx, ...mocks } = createMockAudioContext();
    if (opts.ctxState) ctx.state = opts.ctxState;

    vi.stubGlobal("AudioContext", function () {
      return ctx;
    });

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electron = {
      sound: { getSoundDir: vi.fn().mockResolvedValue("/app/resources/sounds") },
      notificationSounds: { getCustomDir: vi.fn().mockResolvedValue("/user/sounds/custom") },
    };

    const service = await import("@/services/WebAudioService");
    activeService = service;

    const fakeBuffer = { duration: 1, length: 44100 } as AudioBuffer;
    function mockSuccessfulFetch() {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
      });
      mocks.mockDecodeAudioData.mockResolvedValueOnce(fakeBuffer);
    }

    return { service, ctx, mockFetch, mockSuccessfulFetch, fakeBuffer, ...mocks };
  }

  it("plays a sound by fetching via daintree-file:// and decoding", async () => {
    const { service, mockFetch, mockSuccessfulFetch, mockDecodeAudioData, mockStart, sources } =
      await setupTest();
    mockSuccessfulFetch();

    await service.playSound("chime.wav");

    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("daintree-file://"));
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("chime.wav"));
    expect(mockDecodeAudioData).toHaveBeenCalled();
    expect(sources[0]!.connect).toHaveBeenCalled();
    expect(sources[0]!.gainNode).toBeTruthy();
    expect(mockStart).toHaveBeenCalledWith(0);
  });

  it("fetches an imported sound from the custom directory by its uuid", async () => {
    const { service, mockFetch, mockSuccessfulFetch, mockStart } = await setupTest();
    mockSuccessfulFetch();
    const uuid = "0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e6f";

    await service.playSound(`custom:${uuid}`);

    const url = new URL(mockFetch.mock.calls[0]![0] as string);
    expect(url.searchParams.get("path")).toBe(`/user/sounds/custom/${uuid}.wav`);
    expect(url.searchParams.get("root")).toBe("/user/sounds/custom");
    expect(mockStart).toHaveBeenCalledWith(0);
  });

  it("keeps only the most recently played imports decoded, and every bundled sound", async () => {
    const { service, mockFetch, mockSuccessfulFetch } = await setupTest();
    const ids = Array.from(
      { length: 9 },
      (_, i) => `custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e${String(i).padStart(2, "0")}`
    );
    for (let i = 0; i < 12; i++) mockSuccessfulFetch();

    await service.playSound("chime.wav");
    for (const id of ids.slice(0, 8)) await service.playSound(id);
    // Playing the oldest import again makes the next-oldest the one to go.
    await service.playSound(ids[0]!);
    await service.playSound(ids[8]!);
    expect(mockFetch).toHaveBeenCalledTimes(10);

    await service.playSound(ids[0]!);
    await service.playSound("chime.wav");
    expect(mockFetch).toHaveBeenCalledTimes(10);

    await service.playSound(ids[1]!);
    expect(mockFetch).toHaveBeenCalledTimes(11);
  });

  it("asks for the imports directory once, and again after dispose", async () => {
    const { service, mockSuccessfulFetch } = await setupTest();
    const getCustomDir = window.electron.notificationSounds.getCustomDir as ReturnType<
      typeof vi.fn
    >;
    for (let i = 0; i < 3; i++) mockSuccessfulFetch();

    await service.playSound("custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e01");
    await service.playSound("custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e02");
    expect(getCustomDir).toHaveBeenCalledTimes(1);

    service.dispose();
    await service.playSound("custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e03");
    expect(getCustomDir).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a directory looked up by a play that began before dispose", async () => {
    const { service, mockSuccessfulFetch } = await setupTest();
    const getCustomDir = window.electron.notificationSounds.getCustomDir as ReturnType<
      typeof vi.fn
    >;
    mockSuccessfulFetch();
    mockSuccessfulFetch();

    const pending = service.playSound("custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e01");
    service.dispose();
    await pending;
    await service.playSound("custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e02");

    expect(getCustomDir).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a bundled directory looked up across dispose", async () => {
    const { service, mockSuccessfulFetch } = await setupTest();
    const getSoundDir = window.electron.sound.getSoundDir as ReturnType<typeof vi.fn>;
    let resolveDir!: (dir: string) => void;
    getSoundDir.mockReturnValueOnce(new Promise<string>((r) => (resolveDir = r)));
    mockSuccessfulFetch();
    mockSuccessfulFetch();

    const pending = service.playSound("chime.wav");
    await vi.waitFor(() => expect(getSoundDir).toHaveBeenCalledTimes(1));
    service.dispose();
    resolveDir("/stale/sounds");
    await pending;
    await service.playSound("ping.wav");

    expect(getSoundDir).toHaveBeenCalledTimes(2);
  });

  it("decodes again after dispose rather than keeping a decode that finished after it", async () => {
    const { service, mockFetch, mockDecodeAudioData } = await setupTest();
    const ok = () => ({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)) });
    mockFetch.mockResolvedValue(ok());
    let finishDecode!: (buffer: AudioBuffer) => void;
    mockDecodeAudioData.mockReturnValueOnce(
      new Promise<AudioBuffer>((r) => {
        finishDecode = r;
      })
    );
    mockDecodeAudioData.mockResolvedValue({ duration: 1, length: 1 } as AudioBuffer);

    const pending = service.playSound("chime.wav");
    await vi.waitFor(() => expect(mockDecodeAudioData).toHaveBeenCalledTimes(1));
    service.dispose();
    finishDecode({ duration: 1, length: 1 } as AudioBuffer);
    await pending;
    await service.playSound("chime.wav");

    expect(mockDecodeAudioData).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a directory or buffer that arrives after dispose", async () => {
    const { service, mockSuccessfulFetch } = await setupTest();
    const getCustomDir = window.electron.notificationSounds.getCustomDir as ReturnType<
      typeof vi.fn
    >;
    let resolveDir!: (dir: string) => void;
    getCustomDir.mockReturnValueOnce(new Promise<string>((r) => (resolveDir = r)));
    mockSuccessfulFetch();
    mockSuccessfulFetch();
    const id = "custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e01";

    const pending = service.playSound(id);
    await vi.waitFor(() => expect(getCustomDir).toHaveBeenCalledTimes(1));
    service.dispose();
    resolveDir("/stale/custom");
    await pending;
    await service.playSound(id);

    expect(getCustomDir).toHaveBeenCalledTimes(2);
  });

  it("caches decoded buffers on second play", async () => {
    const { service, mockFetch, mockSuccessfulFetch, mockDecodeAudioData, ctx } = await setupTest();
    mockSuccessfulFetch();

    await service.playSound("chime.wav");
    await service.playSound("chime.wav");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockDecodeAudioData).toHaveBeenCalledTimes(1);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(2);
  });

  it("cancelSound fades out via gain ramp and schedules stop after the tail", async () => {
    const { service, mockSuccessfulFetch, sources, ctx } = await setupTest();
    mockSuccessfulFetch();

    await service.playSound("chime.wav");
    service.cancelSound();

    const gainNode = sources[0]!.gainNode!;
    expect(gainNode.gain.setTargetAtTime).toHaveBeenCalledWith(0, ctx.currentTime, 0.015);
    expect(sources[0]!.stop).toHaveBeenCalledWith(ctx.currentTime + 0.1);
  });

  it("evicts the oldest voice via fade when MAX_VOICES (4) is exceeded", async () => {
    const { service, mockSuccessfulFetch, sources, ctx } = await setupTest();
    for (let i = 0; i < 5; i++) mockSuccessfulFetch();

    for (let i = 0; i < 5; i++) {
      await service.playSound(`voice${i}.wav`);
    }

    expect(sources).toHaveLength(5);
    // First voice is evicted via fadeOut
    expect(sources[0]!.gainNode!.gain.setTargetAtTime).toHaveBeenCalledWith(
      0,
      ctx.currentTime,
      0.015
    );
    expect(sources[0]!.stop).toHaveBeenCalledWith(ctx.currentTime + 0.1);
    // Voices 1-4 are untouched
    for (let i = 1; i < 5; i++) {
      expect(sources[i]!.stop).not.toHaveBeenCalled();
    }
  });

  it("onended removes the correct voice by identity", async () => {
    const { service, mockSuccessfulFetch, sources } = await setupTest();
    for (let i = 0; i < 3; i++) mockSuccessfulFetch();

    await service.playSound("a.wav");
    await service.playSound("b.wav");
    await service.playSound("c.wav");

    expect(sources).toHaveLength(3);
    sources[1]!.onended?.();

    // Cancel should now only fade voices A and C — voice B was already removed
    service.cancelSound();
    expect(sources[0]!.stop).toHaveBeenCalled();
    expect(sources[1]!.stop).not.toHaveBeenCalled();
    expect(sources[2]!.stop).toHaveBeenCalled();
  });

  it("handles fetch failure gracefully", async () => {
    const { service, mockFetch, ctx } = await setupTest();
    mockFetch.mockResolvedValueOnce({ ok: false });

    await service.playSound("missing.wav");

    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it("resumes a suspended AudioContext", async () => {
    const { service, mockSuccessfulFetch, mockResume } = await setupTest({
      ctxState: "suspended",
    });
    mockSuccessfulFetch();

    await service.playSound("resume-test.wav");

    expect(mockResume).toHaveBeenCalled();
  });

  it("applies detune to the source before start when provided", async () => {
    const { service, mockSuccessfulFetch, sources, mockStart } = await setupTest();
    mockSuccessfulFetch();

    await service.playSound("pulse.wav", { detune: 12 });

    // Snapshot captured at start() proves detune was assigned BEFORE start,
    // not after — the entire premise of this feature.
    expect(sources[0]!.detuneAtStart).toBe(12);
    expect(mockStart).toHaveBeenCalledWith(0);
  });

  it("plays at the level Main sent, so decay and the volume setting are audible", async () => {
    const { service, mockSuccessfulFetch, sources } = await setupTest();
    mockSuccessfulFetch();

    await service.playSound("waiting.wav", { volume: 0.35 });

    expect(sources[0]!.gainNode!.gain.value).toBeCloseTo(0.35);
  });

  it.each([
    [undefined, 1],
    [1.7, 1],
    [-0.2, 0],
    [Number.NaN, 1],
  ])("clamps a trigger level of %s to %s", async (volume, expected) => {
    const { service, mockSuccessfulFetch, sources } = await setupTest();
    mockSuccessfulFetch();

    await service.playSound("waiting.wav", { volume });

    expect(sources[0]!.gainNode!.gain.value).toBe(expected);
  });

  it("cancelSound during async decode aborts the pending playback", async () => {
    const { service, mockFetch, mockDecodeAudioData, sources, ctx } = await setupTest();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
    });
    let resolveDecode!: (buffer: AudioBuffer) => void;
    mockDecodeAudioData.mockReturnValueOnce(
      new Promise<AudioBuffer>((r) => {
        resolveDecode = r;
      })
    );

    const playPromise = service.playSound("chime.wav");
    service.cancelSound();
    resolveDecode({ duration: 1, length: 44100 } as AudioBuffer);
    await playPromise;

    expect(sources).toHaveLength(0);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it("does not pollute activeVoices when source.start throws", async () => {
    const { service, ctx, mockSuccessfulFetch, sources } = await setupTest();
    for (let i = 0; i < 5; i++) mockSuccessfulFetch();

    const originalCreate = ctx.createBufferSource;
    let throwOnce = true;
    ctx.createBufferSource = vi.fn(() => {
      const source = originalCreate();
      if (throwOnce) {
        throwOnce = false;
        source.start = vi.fn(() => {
          throw new Error("InvalidStateError");
        });
      }
      return source;
    });

    await service.playSound("first.wav");
    expect(sources).toHaveLength(1);

    // Four more successful plays must not be evicted by the failed voice
    await service.playSound("a.wav");
    await service.playSound("b.wav");
    await service.playSound("c.wav");
    await service.playSound("d.wav");

    // Voices a/b/c/d should still be live (no fade) — failed first voice was popped
    expect(sources[1]!.stop).not.toHaveBeenCalled();
    expect(sources[2]!.stop).not.toHaveBeenCalled();
    expect(sources[3]!.stop).not.toHaveBeenCalled();
    expect(sources[4]!.stop).not.toHaveBeenCalled();
  });

  it("dispose closes the AudioContext", async () => {
    const { service, mockSuccessfulFetch, mockClose } = await setupTest();
    mockSuccessfulFetch();

    await service.playSound("dispose-test.wav");
    service.dispose();

    expect(mockClose).toHaveBeenCalled();
  });

  describe("idle suspend", () => {
    it("suspends the context once playback has been silent for the idle period", async () => {
      vi.useFakeTimers();
      const { service, mockSuccessfulFetch, mockSuspend, sources, ctx } = await setupTest();
      mockSuccessfulFetch();

      await service.playSound("chime.wav");
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS * 2);
      // Still playing: a live voice must never be cut off.
      expect(mockSuspend).not.toHaveBeenCalled();

      sources[0]!.onended?.();
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS - 1);
      expect(mockSuspend).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(mockSuspend).toHaveBeenCalledTimes(1);
      await vi.runAllTimersAsync();
      expect(ctx.state).toBe("suspended");

      // Suspended once, not re-armed on a silent context.
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS * 10);
      expect(mockSuspend).toHaveBeenCalledTimes(1);
    });

    it("resumes before scheduling the next sound so it is not dropped", async () => {
      vi.useFakeTimers();
      const { service, mockSuccessfulFetch, mockResume, mockStart, sources, ctx } =
        await setupTest();
      mockSuccessfulFetch();
      await service.playSound("chime.wav");
      sources[0]!.onended?.();
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS);
      await vi.runAllTimersAsync();
      expect(ctx.state).toBe("suspended");

      await service.playSound("chime.wav");

      expect(mockResume).toHaveBeenCalledTimes(1);
      expect(mockResume.mock.invocationCallOrder[0]).toBeLessThan(
        mockStart.mock.invocationCallOrder[1]!
      );
      expect(ctx.state).toBe("running");
    });

    it("resumes a play that lands while the suspend is still in flight", async () => {
      vi.useFakeTimers();
      const { service, mockSuccessfulFetch, mockResume, sources, ctx } = await setupTest();
      mockSuccessfulFetch();
      await service.playSound("chime.wav");
      sources[0]!.onended?.();
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS);
      // suspend() issued but not settled: state still reads "running".
      expect(ctx.state).toBe("running");

      await service.playSound("chime.wav");

      expect(mockResume).toHaveBeenCalledTimes(1);
      expect(ctx.state).toBe("running");
    });

    it("restarts the idle period on every play", async () => {
      vi.useFakeTimers();
      const { service, mockSuccessfulFetch, mockSuspend, sources } = await setupTest();
      mockSuccessfulFetch();
      await service.playSound("chime.wav");
      sources[0]!.onended?.();
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS - 1000);

      await service.playSound("chime.wav");
      sources[1]!.onended?.();
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS - 1000);
      expect(mockSuspend).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(mockSuspend).toHaveBeenCalledTimes(1);
    });

    it("dispose cancels a pending idle suspend", async () => {
      vi.useFakeTimers();
      const { service, mockSuccessfulFetch, mockSuspend, sources } = await setupTest();
      mockSuccessfulFetch();
      await service.playSound("chime.wav");
      sources[0]!.onended?.();

      service.dispose();
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS * 2);

      expect(mockSuspend).not.toHaveBeenCalled();
    });
    it("waits for resume to settle before starting the next sound", async () => {
      vi.useFakeTimers();
      const { service, ctx, mockSuccessfulFetch, mockResume, mockStart, sources } =
        await setupTest();
      mockSuccessfulFetch();
      await service.playSound("chime.wav");
      sources[0]!.onended?.();
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS);
      await vi.runAllTimersAsync();
      expect(ctx.state).toBe("suspended");

      let settle!: () => void;
      mockResume.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settle = () => {
              ctx.state = "running";
              resolve();
            };
          })
      );
      const play = service.playSound("chime.wav");
      await vi.advanceTimersByTimeAsync(0);
      expect(mockStart).toHaveBeenCalledTimes(1);

      settle();
      await play;
      expect(mockStart).toHaveBeenCalledTimes(2);
    });

    it("does not suspend while a fetch is in flight, and does once it fails", async () => {
      vi.useFakeTimers();
      const { service, mockFetch, mockSuspend } = await setupTest();
      let fail!: () => void;
      mockFetch.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error("offline"));
        })
      );

      const play = service.playSound("slow.wav");
      await vi.advanceTimersByTimeAsync(service.IDLE_SUSPEND_MS * 2);
      expect(mockSuspend).not.toHaveBeenCalled();

      fail();
      await play;
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS);
      expect(mockSuspend).toHaveBeenCalledTimes(1);
    });

    it("waits for a cancelled voice to finish its fade before arming", async () => {
      vi.useFakeTimers();
      const { service, mockSuccessfulFetch, mockSuspend, sources } = await setupTest();
      mockSuccessfulFetch();
      await service.playSound("chime.wav");

      service.cancelSound();
      // The fade's `ended` has not arrived yet.
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS * 2);
      expect(mockSuspend).not.toHaveBeenCalled();

      sources[0]!.onended?.();
      vi.advanceTimersByTime(service.IDLE_SUSPEND_MS);
      expect(mockSuspend).toHaveBeenCalledTimes(1);
    });
  });
});
