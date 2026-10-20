import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbWorkerOp, DbWorkerRequest, DbWorkerResponse } from "../dbWorkerProtocol.js";

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
      client.run(
        { op: "ringWriteAll", ring: "a", rows: [{ recordId: null, record: "1" }], maxRecords: 5 },
        () => null
      ),
      client.run(
        { op: "ringWriteAll", ring: "a", rows: [{ recordId: null, record: "2" }], maxRecords: 5 },
        () => null
      ),
      client.run(
        { op: "ringWriteAll", ring: "a", rows: [{ recordId: null, record: "3" }], maxRecords: 5 },
        () => null
      ),
    ]);

    const ids = worker.posted.map((msg) => msg.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(
      worker.posted.map((msg) => (msg.op === "ringWriteAll" ? msg.rows[0]!.record : ""))
    ).toEqual(["1", "2", "3"]);
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

    await client.run(
      { op: "ringWriteAll", ring: "a", rows: [{ recordId: null, record: "1" }], maxRecords: 5 },
      fallback
    );
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

    await client.run(
      { op: "ringWriteAll", ring: "a", rows: [{ recordId: null, record: "1" }], maxRecords: 5 },
      () => null
    );
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
      { op: "ringWriteAll", ring: "a", rows: [{ recordId: null, record: "1" }], maxRecords: 5 },
      () => {
        events.push("fallback-1");
        return null;
      }
    );
    const second = client.run(
      { op: "ringWriteAll", ring: "a", rows: [{ recordId: null, record: "2" }], maxRecords: 5 },
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

  it("reports a strictly observational governance snapshot with no action eligibility", async () => {
    const worker = echoWorker();
    const client = new DbWorkerClient({
      spawnWorker: () => worker.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
    });

    // Before first use: no worker, nothing eligible.
    const before = client.getGovernanceSnapshot();
    expect(before.alive).toBe(false);
    expect(before.state).toBe("not-spawned");
    expect(before.eligibility).toEqual({ trim: false, dispose: false, restart: false });

    await client.run(checkpointOp, () => null);
    const after = client.getGovernanceSnapshot();
    expect(after.alive).toBe(true);
    expect(after.state).toBe("running");
    expect(after.queueDepth).toBe(0);
    expect(after.eligibility).toEqual({ trim: false, dispose: false, restart: false });
  });

  it("snapshot collection does not touch the fence or reorder queued writes", async () => {
    const fence = fakeFenceDb(3);
    const worker = echoWorker();
    const client = new DbWorkerClient({
      spawnWorker: () => worker.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
      getMainSqlite: () => fence.handle,
    });

    const first = client.run(
      { op: "ringWriteAll", ring: "a", rows: [{ recordId: null, record: "1" }], maxRecords: 5 },
      () => null
    );
    // Snapshot between two queued writes — a pure read must not advance the
    // fence (which would no-op the queued write) or perturb FIFO order.
    const mid = client.getGovernanceSnapshot();
    expect(mid.queueDepth).toBe(1);
    const second = client.run(
      { op: "ringWriteAll", ring: "a", rows: [{ recordId: null, record: "2" }], maxRecords: 5 },
      () => null
    );
    await Promise.all([first, second]);

    expect(fence.state.epoch).toBe(3);
    expect(worker.posted.map((msg) => msg.fence)).toEqual([3, 3]);
    expect(
      worker.posted.map((msg) => (msg.op === "ringWriteAll" ? msg.rows[0]!.record : ""))
    ).toEqual(["1", "2"]);
  });

  it("reports degraded and shutting-down states as governance-visible but untouchable", async () => {
    const wedged = new FakeWorker(); // never responds
    const client = new DbWorkerClient({
      spawnWorker: () => wedged.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
      requestTimeoutMs: 10,
    });

    await client.run(checkpointOp, () => null);
    const degraded = client.getGovernanceSnapshot();
    expect(degraded.state).toBe("degraded");
    expect(degraded.eligibility).toEqual({ trim: false, dispose: false, restart: false });

    const healthy = echoWorker();
    const shuttingDown = new DbWorkerClient({
      spawnWorker: () => healthy.asWorker(),
      isDbReady: () => true,
      isDisabled: () => false,
    });
    await shuttingDown.run(checkpointOp, () => null);
    await shuttingDown.shutdown();
    expect(shuttingDown.getGovernanceSnapshot().state).toBe("shutting-down");
  });

  describe("fallbacks superseded by a synchronous write", () => {
    const staleWrite: Extract<DbWorkerOp, { op: "ringWriteAll" }> = {
      op: "ringWriteAll",
      ring: "a",
      rows: [{ recordId: null, record: "old" }],
      maxRecords: 5,
    };

    function holdingClient(worker: FakeWorker, overrides: { requestTimeoutMs?: number } = {}) {
      const fence = fakeFenceDb(0);
      const client = new DbWorkerClient({
        spawnWorker: () => worker.asWorker(),
        isDbReady: () => true,
        isDisabled: () => false,
        getMainSqlite: () => fence.handle,
        ...overrides,
      });
      return { client, fence };
    }

    it("skips a ring fallback when the worker exits after a sync fence", async () => {
      const worker = new FakeWorker(); // holds the request
      const { client } = holdingClient(worker);
      const fallback = vi.fn(() => "resurrected");

      const pending = client.run(staleWrite, fallback);
      client.fence("a");
      worker.emit("exit", 1);

      await expect(pending).resolves.toBeUndefined();
      expect(fallback).not.toHaveBeenCalled();
    });

    it("skips a ring fallback when the worker errors after a sync fence", async () => {
      const worker = new FakeWorker();
      const { client } = holdingClient(worker);
      const fallback = vi.fn(() => "resurrected");

      const pending = client.run(staleWrite, fallback);
      client.fence("a");
      worker.emit("error", new Error("boom"));

      await expect(pending).resolves.toBeUndefined();
      expect(fallback).not.toHaveBeenCalled();
    });

    it("skips a ring fallback when the worker reports an op failure after a sync fence", async () => {
      const worker = new FakeWorker();
      const { client } = holdingClient(worker);
      const fallback = vi.fn(() => "resurrected");

      const pending = client.run(staleWrite, fallback);
      client.fence("a");
      worker.respond({ id: worker.posted[0]!.id, ok: false, error: "disk I/O error" });

      await expect(pending).resolves.toBeUndefined();
      expect(fallback).not.toHaveBeenCalled();
    });

    it("skips a ring fallback when the request times out after a sync fence", async () => {
      const worker = new FakeWorker();
      const { client } = holdingClient(worker, { requestTimeoutMs: 10 });
      const fallback = vi.fn(() => "resurrected");

      const pending = client.run(staleWrite, fallback);
      client.fence("a");

      await expect(pending).resolves.toBeUndefined();
      expect(fallback).not.toHaveBeenCalled();
    });

    it("skips a keyed-delta fallback when the worker exits after a sync fence", async () => {
      const worker = new FakeWorker();
      const { client } = holdingClient(worker);
      const fallback = vi.fn(() => "resurrected");

      const pending = client.run(
        { op: "ringApply", ring: "a", upserts: [{ recordId: "r1", record: "old" }], deletes: [] },
        fallback
      );
      client.fence("a");
      worker.emit("exit", 1);

      await expect(pending).resolves.toBeUndefined();
      expect(fallback).not.toHaveBeenCalled();
    });

    it("still runs the ring fallback when the worker fails without a sync fence", async () => {
      const worker = new FakeWorker();
      const { client, fence } = holdingClient(worker);
      const fallback = vi.fn(() => "main-result");

      const pending = client.run(staleWrite, fallback);
      worker.emit("exit", 1);

      await expect(pending).resolves.toBe("main-result");
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(fence.state.epoch).toBe(1);
    });

    it("still runs the fallback of a ring write queued after the sync fence", async () => {
      const worker = new FakeWorker();
      const { client } = holdingClient(worker);
      const stale = vi.fn(() => "stale");
      const fresh = vi.fn(() => "fresh");

      const first = client.run(staleWrite, stale);
      client.fence("a");
      const second = client.run(
        { ...staleWrite, rows: [{ recordId: null, record: "new" }] },
        fresh
      );
      worker.emit("exit", 1);

      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBe("fresh");
      expect(stale).not.toHaveBeenCalled();
      expect(fresh).toHaveBeenCalledTimes(1);
    });

    it("skips a ring fallback when the fence lands after the rejection but before it is handled", async () => {
      const worker = new FakeWorker();
      const { client } = holdingClient(worker);
      const fallback = vi.fn(() => "resurrected");

      const pending = client.run(staleWrite, fallback);
      worker.emit("exit", 1);
      client.fence("a");

      await expect(pending).resolves.toBeUndefined();
      expect(fallback).not.toHaveBeenCalled();
    });

    it("lets a main-only ring write after a timed-out shutdown drain supersede the pending one", async () => {
      const worker = new FakeWorker(); // never answers, not even close
      const fence = fakeFenceDb(0);
      const client = new DbWorkerClient({
        spawnWorker: () => worker.asWorker(),
        isDbReady: () => true,
        isDisabled: () => false,
        getMainSqlite: () => fence.handle,
        shutdownDrainTimeoutMs: 10,
      });
      const stale = vi.fn(() => "stale");
      const fresh = vi.fn(() => "fresh");

      const pending = client.run(staleWrite, stale);
      await client.shutdown();
      await expect(
        client.run({ ...staleWrite, rows: [{ recordId: null, record: "new" }] }, fresh)
      ).resolves.toBe("fresh");
      worker.emit("exit", 0);

      await expect(pending).resolves.toBeUndefined();
      expect(stale).not.toHaveBeenCalled();
      expect(fresh).toHaveBeenCalledTimes(1);
    });

    it("does not rewrite the fence for main-only ring writes once a timeout degrade drained the queue", async () => {
      const worker = new FakeWorker(); // wedged
      const { client, fence } = holdingClient(worker, { requestTimeoutMs: 10 });
      const fallback = vi.fn(() => "main-result");

      await client.run(staleWrite, fallback);
      expect(fence.state.epoch).toBe(1);

      for (let i = 0; i < 3; i++) {
        await expect(client.run(staleWrite, fallback)).resolves.toBe("main-result");
      }
      expect(fence.state.epoch).toBe(1);
      expect(fallback).toHaveBeenCalledTimes(4);
    });

    it("still runs the fallback of another ring's write after a sync fence", async () => {
      const worker = new FakeWorker();
      const { client } = holdingClient(worker);
      const fallback = vi.fn(() => "main-result");

      const pending = client.run({ ...staleWrite, ring: "b" }, fallback);
      client.fence("a");
      worker.emit("exit", 1);

      await expect(pending).resolves.toBe("main-result");
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it("still runs non-ring fallbacks after a sync fence", async () => {
      const worker = new FakeWorker();
      const { client } = holdingClient(worker);
      const fallback = vi.fn(() => "main-result");

      const pending = client.run(checkpointOp, fallback);
      client.fence("a");
      worker.emit("exit", 1);

      await expect(pending).resolves.toBe("main-result");
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it("does not treat the shutdown fence as superseding pending ring writes", async () => {
      const worker = new FakeWorker(); // swallows close, so the drain times out
      const fence = fakeFenceDb(0);
      const client = new DbWorkerClient({
        spawnWorker: () => worker.asWorker(),
        isDbReady: () => true,
        isDisabled: () => false,
        getMainSqlite: () => fence.handle,
        shutdownDrainTimeoutMs: 10,
      });
      const fallback = vi.fn(() => "main-result");

      const pending = client.run(staleWrite, fallback);
      await client.shutdown();
      worker.emit("exit", 0);

      await expect(pending).resolves.toBe("main-result");
      expect(fallback).toHaveBeenCalledTimes(1);
    });
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
