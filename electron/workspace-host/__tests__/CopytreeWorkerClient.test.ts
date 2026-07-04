import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/CopyTreeService.js", () => ({
  copyTreeService: {
    generate: vi.fn(),
    testConfig: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logWarn: vi.fn(),
}));

import { copyTreeService } from "../../services/CopyTreeService.js";
import { CopytreeWorkerClient } from "../CopytreeWorkerClient.js";
import type { CopytreeWorkerRequest } from "../copytreeWorkerProtocol.js";

class FakeWorker extends EventEmitter {
  postMessage = vi.fn();
  unref = vi.fn();
}

function makeClient(worker: FakeWorker = new FakeWorker()) {
  const factory = vi.fn(() => worker as unknown as Worker);
  return { client: new CopytreeWorkerClient(factory), factory, worker };
}

const inlineResult = { content: "inline", fileCount: 1 };
const inlineTestResult = {
  includedFiles: 2,
  includedSize: 10,
  excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
};

beforeEach(() => {
  vi.mocked(copyTreeService.generate).mockResolvedValue(inlineResult);
  vi.mocked(copyTreeService.testConfig).mockResolvedValue(inlineTestResult);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("CopytreeWorkerClient", () => {
  it("runs on the worker and resolves with the worker's result", async () => {
    const { client, factory, worker } = makeClient();

    const promise = client.generate("/root", {}, undefined, "op-1");
    expect(factory).toHaveBeenCalledTimes(1);
    const sent = worker.postMessage.mock.calls[0][0] as CopytreeWorkerRequest;
    expect(sent).toMatchObject({ type: "generate", id: "op-1", rootPath: "/root" });

    const workerResult = { content: "from-worker", fileCount: 3 };
    worker.emit("message", { type: "generate-result", id: "op-1", result: workerResult });

    await expect(promise).resolves.toEqual(workerResult);
    expect(copyTreeService.generate).not.toHaveBeenCalled();
  });

  it("relays worker progress to the caller's onProgress", async () => {
    const { client, worker } = makeClient();
    const onProgress = vi.fn();

    const promise = client.generate("/root", {}, onProgress, "op-1");
    const progress = { stage: "Scanning", progress: 0.5, message: "half" };
    worker.emit("message", { type: "progress", id: "op-1", progress });
    worker.emit("message", {
      type: "generate-result",
      id: "op-1",
      result: { content: "", fileCount: 0 },
    });

    await promise;
    expect(onProgress).toHaveBeenCalledWith(progress);
  });

  it("reuses one persistent worker across requests", async () => {
    const { client, factory, worker } = makeClient();

    const first = client.generate("/root", {}, undefined, "op-1");
    const second = client.testConfig("/root", {}, "op-2");
    worker.emit("message", {
      type: "generate-result",
      id: "op-1",
      result: { content: "", fileCount: 0 },
    });
    worker.emit("message", { type: "test-config-result", id: "op-2", result: inlineTestResult });

    await Promise.all([first, second]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("falls back in-thread when DAINTREE_DISABLE_COPYTREE_WORKER=1", async () => {
    vi.stubEnv("DAINTREE_DISABLE_COPYTREE_WORKER", "1");
    const { client, factory } = makeClient();

    await expect(client.generate("/root", {}, undefined, "op-1")).resolves.toEqual(inlineResult);
    expect(factory).not.toHaveBeenCalled();
    expect(copyTreeService.generate).toHaveBeenCalledWith("/root", {}, undefined, "op-1");
  });

  it("falls back in-thread when the worker fails to spawn, and stays there", async () => {
    const factory = vi.fn(() => {
      throw new Error("no worker for you");
    });
    const client = new CopytreeWorkerClient(factory);

    await expect(client.generate("/root", {}, undefined, "op-1")).resolves.toEqual(inlineResult);
    await expect(client.testConfig("/root", {}, "op-2")).resolves.toEqual(inlineTestResult);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(copyTreeService.generate).toHaveBeenCalledTimes(1);
    expect(copyTreeService.testConfig).toHaveBeenCalledTimes(1);
  });

  it("rejects in-flight operations and pins the fallback when the worker dies", async () => {
    const { client, factory, worker } = makeClient();

    const promise = client.generate("/root", {}, undefined, "op-1");
    worker.emit("error", new Error("worker crashed"));
    await expect(promise).rejects.toThrow("worker crashed");

    await expect(client.generate("/root", {}, undefined, "op-2")).resolves.toEqual(inlineResult);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("rejects the pending test-config when the worker reports an error result", async () => {
    const { client, worker } = makeClient();

    const promise = client.testConfig("/root", {}, "op-1");
    worker.emit("message", { type: "test-config-error", id: "op-1", error: "boom" });
    await expect(promise).rejects.toThrow("boom");
  });

  it("routes cancel to both the worker op and the in-thread service", async () => {
    const { client, worker } = makeClient();

    const promise = client.generate("/root", {}, undefined, "op-1");
    client.cancel("op-1");

    expect(copyTreeService.cancel).toHaveBeenCalledWith("op-1");
    const cancelMessage = worker.postMessage.mock.calls
      .map((c) => c[0] as CopytreeWorkerRequest)
      .find((m) => m.type === "cancel");
    expect(cancelMessage).toEqual({ type: "cancel", id: "op-1" });

    worker.emit("message", {
      type: "generate-result",
      id: "op-1",
      result: { content: "", fileCount: 0, error: "Context generation cancelled" },
    });
    await expect(promise).resolves.toMatchObject({ error: "Context generation cancelled" });
  });

  it("does not post a cancel message for unknown operations", () => {
    const { client, worker } = makeClient();
    client.cancel("nope");
    expect(copyTreeService.cancel).toHaveBeenCalledWith("nope");
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it("falls back in-thread for an op whose postMessage throws, leaving no pending entry", async () => {
    const worker = new FakeWorker();
    worker.postMessage.mockImplementation(() => {
      throw new Error("worker port closed");
    });
    const { client } = makeClient(worker);

    await expect(client.generate("/root", {}, undefined, "op-1")).resolves.toEqual(inlineResult);
    expect(copyTreeService.generate).toHaveBeenCalledWith("/root", {}, undefined, "op-1");

    await expect(client.testConfig("/root", {}, "op-2")).resolves.toEqual(inlineTestResult);
    expect(copyTreeService.testConfig).toHaveBeenCalledWith("/root", {}, "op-2");

    // No leaked pending entries: late worker messages for those ids are no-ops.
    expect(() =>
      worker.emit("message", {
        type: "generate-result",
        id: "op-1",
        result: { content: "", fileCount: 0 },
      })
    ).not.toThrow();
  });

  it("releases the result buffer reference the moment it transfers", async () => {
    const { client, worker } = makeClient();

    const promise = client.generate("/root", {}, undefined, "op-1");
    expect(client.getGovernanceSnapshot().queueDepth).toBe(1);

    const bigResult = { content: "X".repeat(1024), fileCount: 100 };
    worker.emit("message", { type: "generate-result", id: "op-1", result: bigResult });
    await expect(promise).resolves.toEqual(bigResult);

    // The pending map entry (the client's only reference to the payload) is
    // gone; a duplicate late result for the same id is an inert no-op.
    expect(client.getGovernanceSnapshot().queueDepth).toBe(0);
    expect(() =>
      worker.emit("message", { type: "generate-result", id: "op-1", result: bigResult })
    ).not.toThrow();
    expect(client.getGovernanceSnapshot().queueDepth).toBe(0);
  });

  it("drops messages from a dead worker generation so stale results cannot land", async () => {
    const { client, worker } = makeClient();

    const promise = client.generate("/root", {}, undefined, "op-1");
    worker.emit("exit", 3);
    await expect(promise).rejects.toThrow("exited with code 3");
    expect(client.getGovernanceSnapshot().queueDepth).toBe(0);

    // The dead worker instance flushes a late result after the client moved
    // on — the generation fence drops it at the listener boundary. A retried
    // op with the SAME id (caller retry) runs on the fallback and must not be
    // settled by the stale payload.
    const retry = client.generate("/root", {}, undefined, "op-1");
    worker.emit("message", {
      type: "generate-result",
      id: "op-1",
      result: { content: "STALE", fileCount: 0 },
    });
    await expect(retry).resolves.toEqual(inlineResult);
  });

  it("cancellation drops the pending entry once the worker confirms, retaining nothing", async () => {
    const { client, worker } = makeClient();

    const promise = client.generate("/root", {}, undefined, "op-1");
    client.cancel("op-1");
    worker.emit("message", { type: "generate-error", id: "op-1", error: "cancelled" });
    await expect(promise).rejects.toThrow("cancelled");
    expect(client.getGovernanceSnapshot().queueDepth).toBe(0);
  });

  it("reports governance snapshots across the worker lifecycle", async () => {
    const { client, worker } = makeClient();

    const before = client.getGovernanceSnapshot();
    expect(before).toMatchObject({
      kind: "copytree-worker",
      alive: false,
      state: "not-spawned",
      queueDepth: 0,
      eligibility: { trim: false, dispose: false, restart: false },
    });

    const promise = client.generate("/root", {}, undefined, "op-1");
    expect(client.getGovernanceSnapshot()).toMatchObject({ alive: true, state: "running" });
    worker.emit("message", {
      type: "generate-result",
      id: "op-1",
      result: { content: "", fileCount: 0 },
    });
    await promise;

    worker.emit("exit", 1);
    expect(client.getGovernanceSnapshot()).toMatchObject({
      alive: false,
      state: "fallback-pinned",
    });
  });

  it("times out a wedged worker op: rejects, drops the pending entry, posts a cancel", async () => {
    vi.useFakeTimers();
    try {
      const { client, worker } = makeClient();

      const promise = client.generate("/root", {}, undefined, "op-1");
      const rejection = expect(promise).rejects.toThrow("did not respond");
      await vi.advanceTimersByTimeAsync(125_000);
      await rejection;

      const cancelMessage = worker.postMessage.mock.calls
        .map((c) => c[0] as CopytreeWorkerRequest)
        .find((m) => m.type === "cancel");
      expect(cancelMessage).toEqual({ type: "cancel", id: "op-1" });

      // A late result after the timeout finds no pending entry.
      expect(() =>
        worker.emit("message", {
          type: "generate-result",
          id: "op-1",
          result: { content: "", fileCount: 0 },
        })
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
