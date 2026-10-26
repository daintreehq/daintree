// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { levelFromPeak, startMicTest, SILENCE_AFTER_MS } from "../voiceMicTest";

let peak = 0;
let trackStop: ReturnType<typeof vi.fn>;
let contextClose: ReturnType<typeof vi.fn>;

function installMedia(
  opts: { label?: string; actualId?: string; error?: Error; contextState?: string } = {}
) {
  trackStop = vi.fn();
  contextClose = vi.fn().mockResolvedValue(undefined);
  const track = {
    label: opts.label ?? "MacBook Pro Microphone",
    stop: trackStop,
    getSettings: () => ({ deviceId: opts.actualId ?? "mic-1" }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const getUserMedia = opts.error
    ? vi.fn().mockRejectedValue(opts.error)
    : vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal(
    "AudioContext",
    class {
      state = opts.contextState ?? "running";
      resume = vi.fn().mockResolvedValue(undefined);
      close = contextClose;
      createAnalyser() {
        return {
          fftSize: 0,
          getFloatTimeDomainData: (b: Float32Array) => b.fill(peak),
        };
      }
      createMediaStreamSource() {
        return { connect: vi.fn() };
      }
    }
  );
  return getUserMedia;
}

describe("levelFromPeak", () => {
  it("maps silence to 0 and full scale to 1", () => {
    expect(levelFromPeak(0)).toBe(0);
    expect(levelFromPeak(1)).toBe(1);
    expect(levelFromPeak(0.1)).toBeCloseTo(2 / 3, 2);
  });
});

describe("startMicTest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    peak = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks for the selected device as an ideal constraint and no video", async () => {
    const gum = installMedia();
    const h = await startMicTest({ deviceId: "mic-1", onSample: vi.fn(), onEnded: vi.fn() });
    expect(gum).toHaveBeenCalledWith({ audio: { deviceId: { ideal: "mic-1" } }, video: false });
    h.stop();
  });

  it("reports sound, then releases the stream and context on stop", async () => {
    installMedia();
    const onSample = vi.fn();
    const h = await startMicTest({ deviceId: "", onSample, onEnded: vi.fn() });
    peak = 0.2;
    vi.advanceTimersByTime(100);
    expect(onSample).toHaveBeenLastCalledWith(
      expect.objectContaining({ heardSound: true, silent: false })
    );
    h.stop();
    h.stop();
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(contextClose).toHaveBeenCalledTimes(1);
    const calls = onSample.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(onSample.mock.calls.length).toBe(calls);
  });

  it("flags silence once nothing has been heard for the silence window", async () => {
    installMedia({ label: "AirPods Pro" });
    const onSample = vi.fn();
    const h = await startMicTest({ deviceId: "", onSample, onEnded: vi.fn() });
    expect(h.opened.bluetooth).toBe(true);
    vi.advanceTimersByTime(SILENCE_AFTER_MS - 100);
    expect(onSample).toHaveBeenLastCalledWith(expect.objectContaining({ silent: false }));
    vi.advanceTimersByTime(200);
    expect(onSample).toHaveBeenLastCalledWith(expect.objectContaining({ silent: true }));
    h.stop();
  });

  it("never flags silence once sound was heard, even when later samples are zero", async () => {
    installMedia();
    const onSample = vi.fn();
    const h = await startMicTest({ deviceId: "", onSample, onEnded: vi.fn() });
    peak = 0.2;
    vi.advanceTimersByTime(100);
    peak = 0;
    vi.advanceTimersByTime(SILENCE_AFTER_MS + 500);
    expect(onSample).toHaveBeenLastCalledWith(
      expect.objectContaining({ heardSound: true, silent: false })
    );
    h.stop();
  });

  it("counts a quiet but live mic as sound", async () => {
    installMedia();
    const onSample = vi.fn();
    const h = await startMicTest({ deviceId: "", onSample, onEnded: vi.fn() });
    peak = 0.0015;
    vi.advanceTimersByTime(SILENCE_AFTER_MS + 500);
    expect(onSample).toHaveBeenLastCalledWith(
      expect.objectContaining({ heardSound: true, silent: false })
    );
    h.stop();
  });

  it("does not read a suspended context's zeros as silence", async () => {
    installMedia({ contextState: "suspended" });
    const onSample = vi.fn();
    const h = await startMicTest({ deviceId: "", onSample, onEnded: vi.fn() });
    vi.advanceTimersByTime(SILENCE_AFTER_MS * 2);
    expect(onSample).not.toHaveBeenCalled();
    h.stop();
  });

  it("keeps the communications alias in the request and never calls it a substitution", async () => {
    const gum = installMedia({ actualId: "real-headset" });
    const h = await startMicTest({
      deviceId: "communications",
      onSample: vi.fn(),
      onEnded: vi.fn(),
    });
    expect(gum).toHaveBeenCalledWith({
      audio: { deviceId: { ideal: "communications" } },
      video: false,
    });
    expect(h.opened.substituted).toBe(false);
    h.stop();
  });

  it("reports no substitution when the selected device opened", async () => {
    installMedia();
    const h = await startMicTest({ deviceId: "mic-1", onSample: vi.fn(), onEnded: vi.fn() });
    expect(h.opened.substituted).toBe(false);
    h.stop();
  });

  it("notes when another device opened than the one selected", async () => {
    installMedia({ actualId: "other" });
    const h = await startMicTest({ deviceId: "mic-1", onSample: vi.fn(), onEnded: vi.fn() });
    expect(h.opened.substituted).toBe(true);
    h.stop();
  });

  it("rejects denied for a refusal and unavailable otherwise", async () => {
    installMedia({ error: new DOMException("no", "NotAllowedError") });
    await expect(startMicTest({ deviceId: "", onSample: vi.fn(), onEnded: vi.fn() })).rejects.toBe(
      "denied"
    );
    installMedia({ error: new DOMException("none", "NotFoundError") });
    await expect(startMicTest({ deviceId: "", onSample: vi.fn(), onEnded: vi.fn() })).rejects.toBe(
      "unavailable"
    );
  });

  it("ends and releases at the time limit", async () => {
    installMedia();
    const onEnded = vi.fn();
    await startMicTest({ deviceId: "", onSample: vi.fn(), onEnded });
    vi.advanceTimersByTime(60_000);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
  });
});
