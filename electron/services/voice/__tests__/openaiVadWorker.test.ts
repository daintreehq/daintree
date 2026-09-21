import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  postMessage: vi.fn(),
  create: vi.fn(),
}));
const avrVad = () => ({ RealTimeVAD: { new: mocks.create } });

type ProcessHandler = (arg: unknown) => void;

let exitSpy: MockInstance<typeof process.exit>;
let processHandlers: Map<string, ProcessHandler>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function send(message: { type: "destroy" } | { type: "audio"; pcm: ArrayBuffer }) {
  mocks.on.mock.calls.find(([event]) => event === "message")![1]({ data: message });
}
function model() {
  return { start: vi.fn(), processAudio: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
}

/**
 * Imports the entry the way a utility process runs it. Its crash handlers are
 * captured rather than installed, so they never land on the test runner.
 */
async function loadWorker(): Promise<void> {
  const onSpy = vi.spyOn(process, "on").mockImplementation(((
    event: string,
    handler: ProcessHandler
  ) => {
    processHandlers.set(event, handler);
    return process;
  }) as typeof process.on);
  try {
    await import("../openaiVadWorker.js");
  } finally {
    onSpy.mockRestore();
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  processHandlers = new Map();
  vi.doMock("avr-vad", avrVad);
  Object.defineProperty(process, "parentPort", {
    value: { on: mocks.on, postMessage: mocks.postMessage },
    configurable: true,
  });
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  delete (process as { parentPort?: unknown }).parentPort;
});

describe("OpenAI VAD process shutdown", () => {
  it("waits for pending initialization, releases the model, and never starts it after destroy", async () => {
    const vad = model();
    const loading = deferred<typeof vad>();
    mocks.create.mockReturnValue(loading.promise);
    await loadWorker();
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    send({ type: "destroy" });
    await Promise.resolve();
    await Promise.resolve();
    expect(exitSpy).not.toHaveBeenCalled();
    loading.resolve(vad);
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(vad.destroy).toHaveBeenCalledTimes(1);
    expect(vad.start).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalledWith({ type: "ready" });
    expect(mocks.postMessage).toHaveBeenCalledWith({ type: "drained" });
  });

  it("drains native inference before releasing the model and exits only after release", async () => {
    const vad = model();
    const inference = deferred<void>();
    const release = deferred<void>();
    vad.processAudio.mockReturnValue(inference.promise);
    vad.destroy.mockReturnValue(release.promise);
    mocks.create.mockResolvedValue(vad);
    await loadWorker();
    await vi.waitFor(() => expect(vad.start).toHaveBeenCalledTimes(1));
    send({ type: "audio", pcm: new ArrayBuffer(1024) });
    await vi.waitFor(() => expect(vad.processAudio).toHaveBeenCalledTimes(1));
    send({ type: "destroy" });
    send({ type: "destroy" });
    send({ type: "audio", pcm: new ArrayBuffer(1024) });
    expect(vad.destroy).not.toHaveBeenCalled();
    inference.resolve();
    await vi.waitFor(() => expect(vad.destroy).toHaveBeenCalledTimes(1));
    expect(mocks.postMessage).not.toHaveBeenCalledWith({ type: "drained" });
    expect(exitSpy).not.toHaveBeenCalled();
    release.resolve();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(mocks.postMessage).toHaveBeenCalledWith({ type: "drained" });
    expect(vad.processAudio).toHaveBeenCalledTimes(1);
  });

  it("never creates the model when destroy lands before avr-vad has loaded", async () => {
    const loaded = deferred<void>();
    vi.doMock("avr-vad", async () => {
      await loaded.promise;
      return avrVad();
    });
    await loadWorker();
    send({ type: "destroy" });
    loaded.resolve();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.postMessage).toHaveBeenCalledWith({ type: "drained" });
  });

  it("reports a failed model release and exits non-zero", async () => {
    const vad = model();
    vad.destroy.mockRejectedValue(new Error("release failed"));
    mocks.create.mockResolvedValue(vad);
    await loadWorker();
    await vi.waitFor(() => expect(vad.start).toHaveBeenCalledTimes(1));
    send({ type: "destroy" });
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(mocks.postMessage).toHaveBeenCalledWith({ type: "error", message: "release failed" });
    expect(mocks.postMessage).not.toHaveBeenCalledWith({ type: "drained" });
  });
});

describe("OpenAI VAD process failures", () => {
  it("reports a native load failure as an error message instead of failing the entry", async () => {
    vi.doMock("avr-vad", () => {
      throw new Error("dlopen onnxruntime_binding.node failed");
    });
    await loadWorker();
    await vi.waitFor(() =>
      expect(mocks.postMessage).toHaveBeenCalledWith({
        type: "error",
        message: expect.any(String),
      })
    );
    expect(mocks.postMessage).not.toHaveBeenCalledWith({ type: "ready" });
    // The entry evaluated and is still listening, so destroy still exits cleanly.
    send({ type: "destroy" });
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
  });

  it("reports a model creation failure", async () => {
    mocks.create.mockRejectedValue(new Error("session creation rejected"));
    await loadWorker();
    await vi.waitFor(() =>
      expect(mocks.postMessage).toHaveBeenCalledWith({
        type: "error",
        message: "session creation rejected",
      })
    );
    expect(mocks.postMessage).not.toHaveBeenCalledWith({ type: "ready" });
  });

  it("exits on an uncaught exception or unhandled rejection rather than lingering", async () => {
    mocks.create.mockReturnValue(new Promise(() => {}));
    await loadWorker();
    processHandlers.get("uncaughtException")!(new Error("boom"));
    expect(mocks.postMessage).toHaveBeenCalledWith({ type: "error", message: "boom" });
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));

    exitSpy.mockClear();
    processHandlers.get("unhandledRejection")!(new Error("rejected"));
    expect(mocks.postMessage).toHaveBeenCalledWith({ type: "error", message: "rejected" });
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
  });
});
