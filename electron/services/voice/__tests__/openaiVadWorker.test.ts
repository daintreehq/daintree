import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  close: vi.fn(),
  postMessage: vi.fn(),
  create: vi.fn(),
}));
vi.mock("node:worker_threads", () => ({ parentPort: mocks }));
vi.mock("avr-vad", () => ({ RealTimeVAD: { new: mocks.create } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function send(message: { type: "destroy" } | { type: "audio"; pcm: ArrayBuffer }) {
  mocks.on.mock.calls.find(([event]) => event === "message")![1](message);
}
function model() {
  return { start: vi.fn(), processAudio: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});

describe("OpenAI VAD worker shutdown", () => {
  it("waits for pending initialization, releases the model, and never starts it after destroy", async () => {
    const vad = model();
    const loading = deferred<typeof vad>();
    mocks.create.mockReturnValue(loading.promise);
    await import("../openaiVadWorker.js");
    send({ type: "destroy" });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.close).not.toHaveBeenCalled();
    loading.resolve(vad);
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    expect(vad.destroy).toHaveBeenCalledTimes(1);
    expect(vad.start).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalledWith({ type: "ready" });
  });

  it("drains native inference before releasing the model and closes only after release", async () => {
    const vad = model();
    const inference = deferred<void>();
    const release = deferred<void>();
    vad.processAudio.mockReturnValue(inference.promise);
    vad.destroy.mockReturnValue(release.promise);
    mocks.create.mockResolvedValue(vad);
    await import("../openaiVadWorker.js");
    await vi.waitFor(() => expect(vad.start).toHaveBeenCalledTimes(1));
    send({ type: "audio", pcm: new ArrayBuffer(1024) });
    await vi.waitFor(() => expect(vad.processAudio).toHaveBeenCalledTimes(1));
    send({ type: "destroy" });
    send({ type: "destroy" });
    send({ type: "audio", pcm: new ArrayBuffer(1024) });
    expect(vad.destroy).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    inference.resolve();
    await vi.waitFor(() => expect(vad.destroy).toHaveBeenCalledTimes(1));
    expect(mocks.close).not.toHaveBeenCalled();
    release.resolve();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    expect(vad.processAudio).toHaveBeenCalledTimes(1);
  });
});
