/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Minimal MediaRecorder stand-in — the real class isn't provided by jsdom.
class MockMediaRecorder {
  static isTypeSupported = vi.fn(() => true);

  static instances: MockMediaRecorder[] = [];

  state: "inactive" | "recording" = "inactive";
  ondataavailable:
    | ((event: { data: { size: number; arrayBuffer: () => Promise<ArrayBuffer> } }) => void)
    | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  start = vi.fn((_timeslice?: number) => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    // onstop fires after the last ondataavailable per W3C spec — simulate by
    // letting the caller drive ondataavailable before invoking onstop.
    if (this.onstop) this.onstop();
  });

  constructor(
    public readonly stream: MediaStream,
    public readonly options: { mimeType?: string }
  ) {
    MockMediaRecorder.instances.push(this);
  }

  emitChunk(buffer: ArrayBuffer): void {
    if (!this.ondataavailable) return;
    this.ondataavailable({
      data: {
        size: buffer.byteLength,
        arrayBuffer: () => Promise.resolve(buffer),
      },
    });
  }
}

class MockMediaStreamTrack {
  stop = vi.fn();
}

class MockMediaStream {
  private readonly tracks: MockMediaStreamTrack[];
  constructor() {
    this.tracks = [new MockMediaStreamTrack()];
  }
  getTracks(): MockMediaStreamTrack[] {
    return this.tracks;
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

interface DemoApi {
  sendCaptureChunk: ReturnType<typeof vi.fn>;
  sendCaptureFinished: ReturnType<typeof vi.fn>;
  onCaptureStart: ReturnType<typeof vi.fn>;
  onCaptureStop: ReturnType<typeof vi.fn>;
}

function createDemoApi(): {
  demo: DemoApi;
  triggerStart: (payload: { captureId: string; fps: number }) => void;
  triggerStop: (payload: { captureId: string }) => void;
} {
  let startHandler: ((payload: { captureId: string; fps: number }) => void) | null = null;
  let stopHandler: ((payload: { captureId: string }) => void) | null = null;
  const demo: DemoApi = {
    sendCaptureChunk: vi.fn(),
    sendCaptureFinished: vi.fn(),
    onCaptureStart: vi.fn((cb) => {
      startHandler = cb;
      return () => {
        startHandler = null;
      };
    }),
    onCaptureStop: vi.fn((cb) => {
      stopHandler = cb;
      return () => {
        stopHandler = null;
      };
    }),
  };
  return {
    demo,
    triggerStart: (payload) => {
      if (startHandler) startHandler(payload);
    },
    triggerStop: (payload) => {
      if (stopHandler) stopHandler(payload);
    },
  };
}

const getDisplayMedia = vi.fn();

describe("initDemoCapture", () => {
  let stream: MockMediaStream;

  beforeEach(() => {
    MockMediaRecorder.instances = [];
    MockMediaRecorder.isTypeSupported.mockReturnValue(true);
    stream = new MockMediaStream();
    getDisplayMedia.mockReset();
    getDisplayMedia.mockResolvedValue(stream);

    // @ts-expect-error -- assign to browser globals in jsdom
    global.MediaRecorder = MockMediaRecorder;
    // @ts-expect-error -- assign to browser globals in jsdom
    global.navigator.mediaDevices = { getDisplayMedia };
  });

  afterEach(() => {
    // @ts-expect-error -- reset globals
    delete global.MediaRecorder;
  });

  it("returns no-op cleanup when window.electron.demo is absent", async () => {
    vi.resetModules();
    // @ts-expect-error -- clear electron
    window.electron = undefined;
    const { initDemoCapture } = await import("../demoCapture");
    const cleanup = initDemoCapture();
    expect(cleanup).toBeTypeOf("function");
    cleanup();
  });

  it("starts MediaRecorder on DEMO_CAPTURE_START and streams chunks to main", async () => {
    vi.resetModules();
    const { demo, triggerStart } = createDemoApi();
    // @ts-expect-error -- inject demo api
    window.electron = { demo };
    const { initDemoCapture } = await import("../demoCapture");
    const cleanup = initDemoCapture();

    triggerStart({ captureId: "cap-1", fps: 30 });
    await flushMicrotasks();

    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { frameRate: 30 },
      audio: false,
    });
    const recorder = MockMediaRecorder.instances[0]!;
    expect(recorder.options.mimeType).toBe("video/webm;codecs=vp9");
    expect(recorder.start).toHaveBeenCalledWith(1000);
    expect(recorder.state).toBe("recording");

    const buffer = new Uint8Array([1, 2, 3]).buffer;
    recorder.emitChunk(buffer);
    await flushMicrotasks();

    expect(demo.sendCaptureChunk).toHaveBeenCalledWith("cap-1", buffer);

    cleanup();
  });

  it("DEMO_CAPTURE_STOP calls recorder.stop which triggers onstop → sendCaptureFinished", async () => {
    vi.resetModules();
    const { demo, triggerStart, triggerStop } = createDemoApi();
    // @ts-expect-error -- inject demo api
    window.electron = { demo };
    const { initDemoCapture } = await import("../demoCapture");
    const cleanup = initDemoCapture();

    triggerStart({ captureId: "cap-2", fps: 60 });
    await flushMicrotasks();

    const recorder = MockMediaRecorder.instances[0]!;
    triggerStop({ captureId: "cap-2" });

    expect(recorder.stop).toHaveBeenCalled();
    expect(demo.sendCaptureFinished).toHaveBeenCalledWith("cap-2");
    // Media stream tracks should be stopped.
    const [track] = stream.getTracks();
    expect(track!.stop).toHaveBeenCalled();

    cleanup();
  });

  it("DEMO_CAPTURE_STOP with no active session is idempotent (acks finished)", async () => {
    vi.resetModules();
    const { demo, triggerStop } = createDemoApi();
    // @ts-expect-error -- inject demo api
    window.electron = { demo };
    const { initDemoCapture } = await import("../demoCapture");
    const cleanup = initDemoCapture();

    triggerStop({ captureId: "nothing-running" });
    expect(demo.sendCaptureFinished).toHaveBeenCalledWith("nothing-running");

    cleanup();
  });

  it("stop for a stale captureId is ignored", async () => {
    vi.resetModules();
    const { demo, triggerStart, triggerStop } = createDemoApi();
    // @ts-expect-error -- inject demo api
    window.electron = { demo };
    const { initDemoCapture } = await import("../demoCapture");
    const cleanup = initDemoCapture();

    triggerStart({ captureId: "cap-a", fps: 30 });
    await flushMicrotasks();

    triggerStop({ captureId: "cap-b" });
    const recorder = MockMediaRecorder.instances[0]!;
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(demo.sendCaptureFinished).not.toHaveBeenCalled();

    cleanup();
  });

  it("getDisplayMedia rejection sends capture finished so main can unblock", async () => {
    vi.resetModules();
    getDisplayMedia.mockRejectedValueOnce(new Error("NotAllowedError"));
    const { demo, triggerStart } = createDemoApi();
    // @ts-expect-error -- inject demo api
    window.electron = { demo };
    const { initDemoCapture } = await import("../demoCapture");
    const cleanup = initDemoCapture();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    triggerStart({ captureId: "cap-err", fps: 30 });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(demo.sendCaptureFinished).toHaveBeenCalledWith("cap-err");
    errorSpy.mockRestore();

    cleanup();
  });

  it("unsupported mime type bails out and signals finished", async () => {
    vi.resetModules();
    MockMediaRecorder.isTypeSupported.mockReturnValue(false);
    const { demo, triggerStart } = createDemoApi();
    // @ts-expect-error -- inject demo api
    window.electron = { demo };
    const { initDemoCapture } = await import("../demoCapture");
    const cleanup = initDemoCapture();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    triggerStart({ captureId: "cap-nope", fps: 30 });
    await flushMicrotasks();

    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(demo.sendCaptureFinished).toHaveBeenCalledWith("cap-nope");
    errorSpy.mockRestore();

    cleanup();
  });

  it("second DEMO_CAPTURE_START while active is ignored", async () => {
    vi.resetModules();
    const { demo, triggerStart } = createDemoApi();
    // @ts-expect-error -- inject demo api
    window.electron = { demo };
    const { initDemoCapture } = await import("../demoCapture");
    const cleanup = initDemoCapture();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    triggerStart({ captureId: "cap-1", fps: 30 });
    await flushMicrotasks();
    triggerStart({ captureId: "cap-2", fps: 30 });
    await flushMicrotasks();

    expect(MockMediaRecorder.instances).toHaveLength(1);
    warnSpy.mockRestore();

    cleanup();
  });

  it("cleanup stops an in-flight recorder and its tracks", async () => {
    vi.resetModules();
    const { demo, triggerStart } = createDemoApi();
    // @ts-expect-error -- inject demo api
    window.electron = { demo };
    const { initDemoCapture } = await import("../demoCapture");
    const cleanup = initDemoCapture();

    triggerStart({ captureId: "cap-cleanup", fps: 30 });
    await flushMicrotasks();

    const recorder = MockMediaRecorder.instances[0]!;
    cleanup();

    expect(recorder.stop).toHaveBeenCalled();
  });
});
