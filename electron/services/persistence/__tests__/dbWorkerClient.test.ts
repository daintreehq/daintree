import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbWorkerRequest, DbWorkerResponse } from "../dbWorkerProtocol.js";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    getAppPath: () => "/fake/appPath",
  },
}));

import { DbWorkerClient } from "../dbWorkerClient.js";

class FakeWorker extends EventEmitter {
  posted: DbWorkerRequest[] = [];
  unrefCalls = 0;

  constructor(private readonly onPost?: (worker: FakeWorker, msg: DbWorkerRequest) => void) {
    super();
  }

  postMessage(msg: DbWorkerRequest): void {
    this.posted.push(msg);
    this.onPost?.(this, msg);
  }

  unref(): void {
    this.unrefCalls++;
  }

  respond(response: DbWorkerResponse): void {
    this.emit("message", response);
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

function echoWorker(result: unknown = null): FakeWorker {
  return new FakeWorker((worker, msg) => {
    setImmediate(() => worker.respond({ id: msg.id, ok: true, result }));
  });
}

// In-memory stand-in for the main connection's PRAGMA user_version fence.
function fakeFenceDb(initialEpoch = 0, onAdvance?: () => void) {
  const state = { epoch: initialEpoch };
  const handle = {
    pragma: (source: string) => {
      if (source === "user_version") return state.epoch;
      if (source.startsWith("user_version = ")) {
        state.epoch = Number(source.slice("user_version = ".length));
        onAdvance?.();
      }
      return undefined;
    },
  };
  return { state, handle };
}

const checkpointOp = { op: "checkpoint", mode: "TRUNCATE" } as const;

describe("DbWorkerClient", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the fallback on main when the kill switch is set, without spawning", async () => {
    const spawnWorker = vi.fn();
    const fallback = vi.fn(() => "main-result");
    const client = new DbWorkerClient({
      spawnWorker,
      isDbReady: () => true,
      isDisabled: () => true,
    });

    await expect(client.run(checkpointOp, fallback)).resolves.toBe("main-result");
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("runs the fallback when the main DB has not been opened yet", async () => {
    const spawnWorker = vi.fn();
    const fallback = vi.fn(() => "main-result");
    const client = new DbWorkerClient({
      spawnWorker,
      isDbReady: () => false,
      isDisabled: () => false,
    });

    await expect(client.run(checkpointOp, fallback)).resolves.toBe("main-result");
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("resolves with the worker result and skips the fallback on success", async () => {
    const worker = echoWorker("worker-result");
    const fallback = vi.fn();
    const client = new DbWorkerClient({
      spawnWorker: () => worker.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
    });

    await expect(client.run(checkpointOp, fallback)).resolves.toBe("worker-result");
    expect(fallback).not.toHaveBeenCalled();
    expect(worker.unrefCalls).toBe(1);
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ op: "checkpoint", mode: "TRUNCATE" });
  });

  it("preserves request order across sequential calls", async () => {
    const worker = echoWorker();
    const client = new DbWorkerClient({
      spawnWorker: () => worker.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
    });

    await Promise.all([
      client.run({ op: "ringWriteAll", ring: "a", records: ["1"], maxRecords: 5 }, () => null),
      client.run({ op: "ringWriteAll", ring: "a", records: ["2"], maxRecords: 5 }, () => null),
      client.run({ op: "ringWriteAll", ring: "a", records: ["3"], maxRecords: 5 }, () => null),
    ]);

    const ids = worker.posted.map((msg) => msg.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(worker.posted.map((msg) => (msg.op === "ringWriteAll" ? msg.records[0] : ""))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("falls back to main when the worker reports an op failure", async () => {
    const worker = new FakeWorker((w, msg) => {
      setImmediate(() => w.respond({ id: msg.id, ok: false, error: "disk I/O error" }));
    });
    const fallback = vi.fn(() => "main-result");
    const client = new DbWorkerClient({
      spawnWorker: () => worker.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
    });

    await expect(client.run(checkpointOp, fallback)).resolves.toBe("main-result");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("falls back to main and advances the fence when the worker dies mid-request", async () => {
    const worker = new FakeWorker((w) => {
      setImmediate(() => w.emit("exit", 1));
    });
    const fence = fakeFenceDb(0);
    const fallback = vi.fn(() => "main-result");
    const client = new DbWorkerClient({
      spawnWorker: () => worker.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
      getMainSqlite: () => fence.handle,
    });

    await expect(client.run(checkpointOp, fallback)).resolves.toBe("main-result");
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fence.state.epoch).toBe(1);
  });

  it("caps spawn attempts and degrades to main-only after repeated spawn failures", async () => {
    const spawnWorker = vi.fn(() => {
      throw new Error("spawn failed");
    });
    const fallback = vi.fn(() => "main-result");
    const client = new DbWorkerClient({
      spawnWorker,
      isDbReady: () => true,
      isDisabled: () => false,
    });

    for (let i = 0; i < 5; i++) {
      await expect(client.run(checkpointOp, fallback)).resolves.toBe("main-result");
    }
    expect(fallback).toHaveBeenCalledTimes(5);
    expect(spawnWorker).toHaveBeenCalledTimes(3);
  });

  it("falls back on timeout and stops using the wedged worker afterwards", async () => {
    const worker = new FakeWorker(); // never responds
    const fallback = vi.fn(() => "main-result");
    const client = new DbWorkerClient({
      spawnWorker: () => worker.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
      requestTimeoutMs: 10,
    });

    await expect(client.run(checkpointOp, fallback)).resolves.toBe("main-result");
    expect(worker.posted).toHaveLength(1);

    await expect(client.run(checkpointOp, fallback)).resolves.toBe("main-result");
    expect(worker.posted).toHaveLength(1);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("shutdown sends close after queued work and routes later runs to the fallback", async () => {
    const worker = echoWorker();
    const fallback = vi.fn(() => "main-result");
    const client = new DbWorkerClient({
      spawnWorker: () => worker.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
    });

    await client.run({ op: "ringWriteAll", ring: "a", records: ["1"], maxRecords: 5 }, fallback);
    await client.shutdown();

    expect(worker.posted.map((msg) => msg.op)).toEqual(["ringWriteAll", "close"]);

    await expect(client.run(checkpointOp, fallback)).resolves.toBe("main-result");
    expect(worker.posted).toHaveLength(2);
  });

  it("shutdown is a no-op when the worker never spawned", async () => {
    const spawnWorker = vi.fn();
    const client = new DbWorkerClient({
      spawnWorker,
      isDbReady: () => true,
      isDisabled: () => false,
    });

    await expect(client.shutdown()).resolves.toBeUndefined();
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("stamps worker requests with the fence epoch read from the main connection", async () => {
    const fence = fakeFenceDb(7);
    const worker = echoWorker();
    const client = new DbWorkerClient({
      spawnWorker: () => worker.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
      getMainSqlite: () => fence.handle,
    });

    await client.run({ op: "ringWriteAll", ring: "a", records: ["1"], maxRecords: 5 }, () => null);
    expect(worker.posted[0]!.fence).toBe(7);
  });

  it("advances the fence BEFORE replaying fallbacks, in submission order, on timeout-degrade", async () => {
    const events: string[] = [];
    const fence = fakeFenceDb(0, () => events.push("fence-advanced"));
    const worker = new FakeWorker(); // wedged — never responds
    const client = new DbWorkerClient({
      spawnWorker: () => worker.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
      getMainSqlite: () => fence.handle,
      requestTimeoutMs: 10,
    });

    const first = client.run(
      { op: "ringWriteAll", ring: "a", records: ["1"], maxRecords: 5 },
      () => {
        events.push("fallback-1");
        return null;
      }
    );
    const second = client.run(
      { op: "ringWriteAll", ring: "a", records: ["2"], maxRecords: 5 },
      () => {
        events.push("fallback-2");
        return null;
      }
    );
    await Promise.all([first, second]);

    // The fence moves before any fallback write, so the wedged worker's queued
    // snapshots can never clobber them; fallbacks replay in submission order.
    expect(events).toEqual(["fence-advanced", "fallback-1", "fallback-2"]);
    expect(fence.state.epoch).toBe(1);
    expect(worker.posted.map((msg) => msg.fence)).toEqual([0, 0]);
  });

  it("advances the fence when the shutdown drain times out", async () => {
    const fence = fakeFenceDb(0);
    const worker = new FakeWorker((w, msg) => {
      if (msg.op !== "close") {
        setImmediate(() => w.respond({ id: msg.id, ok: true, result: null }));
      }
      // close is swallowed — the worker outlives the drain cap.
    });
    const client = new DbWorkerClient({
      spawnWorker: () => worker.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
      getMainSqlite: () => fence.handle,
      shutdownDrainTimeoutMs: 20,
    });

    await client.run(checkpointOp, () => null);
    expect(fence.state.epoch).toBe(0);

    await client.shutdown();
    // A late worker commit after the timed-out drain would carry the old
    // epoch and no-op against this advanced fence.
    expect(fence.state.epoch).toBe(1);
  });
});
