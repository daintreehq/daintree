/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";

function createMockAudioContext() {
  const mockStart = vi.fn();
  const mockConnect = vi.fn();
  const mockResume = vi.fn().mockResolvedValue(undefined);
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockDecodeAudioData = vi.fn();
  const sources: Array<{ stop: ReturnType<typeof vi.fn> }> = [];

  let state = "running";

  const ctx = {
    get state() {
      return state;
    },
    set state(v: string) {
      state = v;
    },
    destination: {},
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null as AudioBuffer | null,
        connect: mockConnect,
        start: mockStart,
        stop: vi.fn(),
        onended: null as (() => void) | null,
      };
      sources.push(source);
      return source;
    }),
    decodeAudioData: mockDecodeAudioData,
    resume: mockResume,
    close: mockClose,
  };

  return { ctx, mockStart, mockConnect, mockResume, mockClose, mockDecodeAudioData, sources };
}

describe("WebAudioService", () => {
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
    };

    const service = await import("@/services/WebAudioService");

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
    const { service, mockFetch, mockSuccessfulFetch, mockDecodeAudioData, mockConnect, mockStart } =
      await setupTest();
    mockSuccessfulFetch();

    await service.playSound("chime.wav");

    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("daintree-file://"));
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("chime.wav"));
    expect(mockDecodeAudioData).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledWith(0);
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

  it("cancelSound stops the active source", async () => {
    const { service, mockSuccessfulFetch, sources } = await setupTest();
    mockSuccessfulFetch();

    await service.playSound("chime.wav");
    service.cancelSound();

    expect(sources[0].stop).toHaveBeenCalled();
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

  it("dispose closes the AudioContext", async () => {
    const { service, mockSuccessfulFetch, mockClose } = await setupTest();
    mockSuccessfulFetch();

    await service.playSound("dispose-test.wav");
    service.dispose();

    expect(mockClose).toHaveBeenCalled();
  });
});
