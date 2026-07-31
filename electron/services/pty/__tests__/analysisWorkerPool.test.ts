import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnalysisWorkerPool, type WorkerLike } from "../analysis/AnalysisWorkerPool.js";
import {
  WorkerAnalysisBackend,
  type AnalysisPoolHost,
  type WorkerAnalysisDelegate,
} from "../analysis/WorkerAnalysisBackend.js";
import { AnalysisWorkerRuntime } from "../analysis/AnalysisWorkerRuntime.js";
import type { HostToWorkerMessage, WorkerToHostMessage } from "../analysisWorkerProtocol.js";

class FakeWorker implements WorkerLike {
  posted: HostToWorkerMessage[] = [];
  private listeners = new Map<string, Array<(arg: never) => void>>();

  postMessage(msg: unknown): void {
    this.posted.push(msg as HostToWorkerMessage);
  }

  on(event: string, cb: (arg: never) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  unref(): void {}

  emit(event: "message", msg: WorkerToHostMessage): void;
  emit(event: "exit", code: number): void;
  emit(event: string, arg: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      (cb as (a: unknown) => void)(arg);
    }
  }

  messagesOfType<T extends HostToWorkerMessage["type"]>(
    type: T
  ): Extract<HostToWorkerMessage, { type: T }>[] {
    return this.posted.filter((m) => m.type === type) as Extract<
      HostToWorkerMessage,
      { type: T }
    >[];
  }
}

// A WorkerLike backed by a real in-process AnalysisWorkerRuntime — lets a test
// drive the full host→worker→host path (real headless serialize) without a
// worker_threads thread.
class RuntimeBackedWorker implements WorkerLike {
  private readonly runtime: AnalysisWorkerRuntime;
  private readonly msgListeners: Array<(msg: WorkerToHostMessage) => void> = [];

  constructor() {
    this.runtime = new AnalysisWorkerRuntime((msg) => {
      for (const cb of this.msgListeners) cb(msg);
    });
  }

  postMessage(msg: unknown): void {
    this.runtime.handleMessage(msg as HostToWorkerMessage);
  }

  on(event: string, cb: (arg: never) => void): void {
    if (event === "message") {
      this.msgListeners.push(cb as (msg: WorkerToHostMessage) => void);
    }
  }

  unref(): void {}
}

function makeDelegate(): WorkerAnalysisDelegate {
  return {
    onActivityState: vi.fn(),
    onWaitingTimeout: vi.fn(),
    onBootComplete: vi.fn(),
    onPtyResponse: vi.fn(),
    getProcessState: () => null,
    getAgentContext: () => ({ agentLive: false, agentState: undefined }),
  };
}

function makeSpec(terminalId: string) {
  return {
    terminalId,
    cols: 80,
    rows: 24,
    scrollback: 1000,
    restore: false,
    spawnedAt: 1000,
  };
}

describe("AnalysisWorkerPool", () => {
  let workers: FakeWorker[];
  let pool: AnalysisWorkerPool;

  beforeEach(() => {
    workers = [];
    pool = new AnalysisWorkerPool(2, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
  });

  afterEach(() => {
    pool.dispose();
    vi.useRealTimers();
  });

  it("assigns terminals sticky and spreads across workers up to the pool size", () => {
    const b1 = pool.createBackend(makeSpec("t1"), makeDelegate());
    const b2 = pool.createBackend(makeSpec("t2"), makeDelegate());
    const b3 = pool.createBackend(makeSpec("t3"), makeDelegate());
    expect(b1 && b2 && b3).toBeTruthy();
    expect(workers).toHaveLength(2);

    // Each backend posted exactly one create to its assigned worker; the
    // third terminal reuses an existing worker (least-loaded), never a third.
    const creates = workers.flatMap((w) => w.messagesOfType("create"));
    expect(creates.map((c) => c.terminalId).sort()).toEqual(["t1", "t2", "t3"]);

    // Sticky routing: data for t1 lands only on t1's worker.
    b1!.feedChunk("hello", { agentLive: false });
    const dataCarriers = workers.filter((w) => w.messagesOfType("data").length > 0);
    expect(dataCarriers).toHaveLength(1);
    expect(dataCarriers[0].messagesOfType("create").some((c) => c.terminalId === "t1")).toBe(true);
  });

  it("resolves requests via correlated responses", async () => {
    const backend = pool.createBackend(makeSpec("t1"), makeDelegate())!;
    const worker = workers[0];

    const promise = backend.serialize();
    const request = worker.messagesOfType("request")[0];
    expect(request.op).toBe("serialize");

    worker.emit("message", {
      type: "response",
      requestId: request.requestId,
      terminalId: "t1",
      result: "SNAPSHOT",
    });
    // The backend stamps the grid it was about to serialize at onto the worker's
    // payload, so a replay can size to it (#11552).
    await expect(promise).resolves.toEqual({ data: "SNAPSHOT", cols: 80, rows: 24 });
  });

  it("routes worker events to the owning backend", () => {
    const delegate = makeDelegate();
    pool.createBackend(makeSpec("t1"), delegate);
    const worker = workers[0];

    worker.emit("message", {
      type: "activity-state",
      terminalId: "t1",
      spawnedAt: 1000,
      state: "busy",
      metadata: { trigger: "output" },
    });
    expect(delegate.onActivityState).toHaveBeenCalledWith(1000, "busy", { trigger: "output" });

    worker.emit("message", { type: "pty-response", terminalId: "t1", data: "\x1b[1;1R" });
    expect(delegate.onPtyResponse).toHaveBeenCalledWith("\x1b[1;1R");
  });

  it("respawns a dead worker once and rebuilds its slots with fresh, persist-suppressed state", async () => {
    vi.useFakeTimers();
    const backend = pool.createBackend(makeSpec("t1"), makeDelegate())!;
    backend.startMonitor({ agentId: "claude", initialState: "idle", skipInitialStateEmit: false });
    const dead = workers[0];

    // In-flight request at crash time resolves empty instead of hanging.
    const inflight = backend.serialize();
    dead.emit("exit", 1);
    await expect(inflight).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(600);
    expect(workers).toHaveLength(2);
    const replacement = workers[1];

    // Fresh slot: create with restore:false, then monitor-start preserving the
    // agent id but with preserve-state semantics (no boot re-emit).
    const create = replacement.messagesOfType("create")[0];
    expect(create).toMatchObject({ terminalId: "t1", restore: false });
    const monitorStart = replacement.messagesOfType("monitor-start")[0];
    expect(monitorStart).toMatchObject({
      agentId: "claude",
      initialState: "idle",
      skipInitialStateEmit: true,
    });

    // Persistence stays suppressed (fresh empty buffer must not clobber the
    // on-disk snapshot) until real output dirties the new buffer.
    await expect(backend.serializeForPersistence()).resolves.toBeNull();
    expect(replacement.messagesOfType("request")).toHaveLength(0);

    backend.feedChunk("new output", { agentLive: true, agentState: "working" });
    const persistReq = backend.serializeForPersistence();
    const request = replacement.messagesOfType("request")[0];
    expect(request.op).toBe("serialize-persistence");
    replacement.emit("message", {
      type: "response",
      requestId: request.requestId,
      terminalId: "t1",
      result: "PERSISTED",
    });
    await expect(persistReq).resolves.toEqual({ data: "PERSISTED", cols: 80, rows: 24 });
    vi.useRealTimers();
  });

  it("seeds the respawned monitor busy when the host FSM is mid-work", async () => {
    vi.useFakeTimers();
    const delegate = makeDelegate();
    delegate.getAgentContext = () => ({ agentLive: true, agentState: "working" });
    const backend = pool.createBackend(makeSpec("t1"), delegate)!;
    backend.startMonitor({ agentId: "claude", initialState: "idle", skipInitialStateEmit: false });

    workers[0].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(600);
    const replacement = workers[1];

    // A monitor seeded idle would strand the host in "working": the monitor's
    // idle/completion transitions only run from its internal busy state.
    const monitorStart = replacement.messagesOfType("monitor-start")[0];
    expect(monitorStart).toMatchObject({
      agentId: "claude",
      initialState: "busy",
      skipInitialStateEmit: true,
    });
    vi.useRealTimers();
  });

  it("redistributes terminals to surviving workers once a slot's respawn budget is spent", async () => {
    vi.useFakeTimers();
    const b1 = pool.createBackend(makeSpec("t1"), makeDelegate())!;
    pool.createBackend(makeSpec("t2"), makeDelegate());
    expect(workers).toHaveLength(2);
    const first = workers[0];

    first.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(600);
    expect(workers).toHaveLength(3);

    // Second crash of the same slot exhausts the budget → t1 moves to the
    // surviving worker.
    workers[2].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(workers).toHaveLength(3);

    b1.feedChunk("after move", { agentLive: false });
    const survivor = workers[1];
    expect(survivor.messagesOfType("create").some((c) => c.terminalId === "t1")).toBe(true);
    expect(survivor.messagesOfType("data").some((d) => d.terminalId === "t1")).toBe(true);
    vi.useRealTimers();
  });

  it("frees the slot and stops routing after release", () => {
    const backend = pool.createBackend(makeSpec("t1"), makeDelegate())!;
    const worker = workers[0];
    backend.release();
    expect(worker.messagesOfType("free")).toHaveLength(1);

    backend.feedChunk("late", { agentLive: false });
    expect(worker.messagesOfType("data")).toHaveLength(0);
    expect(pool.getStats().terminals).toBe(0);
  });

  it("broadcasts the plugin agent registry to live and future workers", () => {
    pool.createBackend(makeSpec("t1"), makeDelegate());
    const registry = {} as Record<string, never>;
    pool.setPluginAgentRegistry(registry);
    expect(workers[0].messagesOfType("plugin-agent-registry")).toHaveLength(1);

    pool.createBackend(makeSpec("t2"), makeDelegate());
    expect(workers[1].messagesOfType("plugin-agent-registry")).toHaveLength(1);
  });

  it("holds feeds above the high watermark and flushes them coalesced once acks drop below low", () => {
    const backend = pool.createBackend(
      {
        ...makeSpec("t1"),
        flowControl: { highWatermark: 100, lowWatermark: 40, holdHardCap: 500 },
      },
      makeDelegate()
    )!;
    const worker = workers[0];

    backend.feedChunk("a".repeat(60), { agentLive: false });
    backend.feedChunk("b".repeat(60), { agentLive: false });
    expect(worker.messagesOfType("data")).toHaveLength(2);

    // Outstanding (120) is above the high watermark — further chunks coalesce
    // host-side instead of being posted.
    backend.feedChunk("c".repeat(30), { agentLive: false });
    backend.feedChunk("d".repeat(30), { agentLive: true, agentState: "working" });
    expect(worker.messagesOfType("data")).toHaveLength(2);

    // First ack leaves outstanding (70) above the low watermark — still held.
    worker.emit("message", { type: "data-ack", terminalId: "t1", bytes: 50, epoch: 0 });
    expect(worker.messagesOfType("data")).toHaveLength(2);

    // Second ack drops outstanding (20) below low — the hold flushes as ONE
    // data message carrying the concatenated payload and the latest flags.
    worker.emit("message", { type: "data-ack", terminalId: "t1", bytes: 50, epoch: 0 });
    const dataMessages = worker.messagesOfType("data");
    expect(dataMessages).toHaveLength(3);
    expect(dataMessages[2].data).toBe("c".repeat(30) + "d".repeat(30));
    expect(dataMessages[2].flags).toEqual({ agentLive: true, agentState: "working" });
  });

  it("drops the hold and rebuilds the slot fresh once the hard cap is exceeded", async () => {
    const backend = pool.createBackend(
      {
        ...makeSpec("t1"),
        flowControl: { highWatermark: 10, lowWatermark: 5, holdHardCap: 50 },
      },
      makeDelegate()
    )!;
    const worker = workers[0];

    backend.feedChunk("x".repeat(20), { agentLive: false }); // posted
    backend.feedChunk("y".repeat(30), { agentLive: false }); // held (30)
    expect(worker.messagesOfType("create")).toHaveLength(1);

    backend.feedChunk("z".repeat(30), { agentLive: false }); // held 60 > cap 50
    const creates = worker.messagesOfType("create");
    expect(creates).toHaveLength(2);
    expect(creates[1]).toMatchObject({ terminalId: "t1", restore: false });
    // The held data was dropped, never posted.
    expect(worker.messagesOfType("data")).toHaveLength(1);

    // Persistence suppressed until real output dirties the fresh buffer.
    await expect(backend.serializeForPersistence()).resolves.toBeNull();
    expect(worker.messagesOfType("request")).toHaveLength(0);

    // Ledger reset: the next chunk posts normally and clears suppression.
    backend.feedChunk("w", { agentLive: false });
    expect(worker.messagesOfType("data")).toHaveLength(2);
  });

  it("flushes the coalesced host-side hold before a serialize request reaches the worker", async () => {
    // End-to-end via a real runtime: data held above the high watermark must be
    // posted BEFORE the request, or the serialize would miss it (the runtime
    // barrier only orders already-posted messages — an unflushed hold is
    // invisible to it). This is the SessionSnapshotter pre-kill guarantee.
    const e2ePool = new AnalysisWorkerPool(1, () => new RuntimeBackedWorker());
    const backend = e2ePool.createBackend(
      {
        ...makeSpec("t1"),
        flowControl: { highWatermark: 10, lowWatermark: 5, holdHardCap: 100_000 },
      },
      makeDelegate()
    )!;

    backend.feedChunk("X".repeat(20), { agentLive: false }); // crosses high watermark
    backend.feedChunk("MARKER-held-bytes\r\n", { agentLive: false }); // held host-side

    const result = await backend.serializeForPersistence();
    expect(result?.data).toContain("MARKER-held-bytes");

    e2ePool.dispose();
  });

  it("discards a worker reply stamped with a superseded generation", async () => {
    const backend = pool.createBackend(makeSpec("t1"), makeDelegate())!;
    const worker = workers[0];

    const promise = backend.serialize();
    const request = worker.messagesOfType("request")[0];
    expect(request.generation).toBe(1);

    // A reply echoing an older worker generation must never settle the
    // request with its payload — it resolves empty instead.
    worker.emit("message", {
      type: "response",
      requestId: request.requestId,
      terminalId: "t1",
      result: "STALE-CONTENT",
      generation: 0,
    });
    await expect(promise).resolves.toBeNull();
  });

  it("stamps requests with the respawned worker's generation and accepts matching replies", async () => {
    vi.useFakeTimers();
    const backend = pool.createBackend(makeSpec("t1"), makeDelegate())!;
    workers[0].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(600);
    const replacement = workers[1];

    // Persistence is suppressed after a rebuild; dirty the buffer first.
    backend.feedChunk("output", { agentLive: false });
    const promise = backend.serialize();
    const request = replacement.messagesOfType("request")[0];
    expect(request.generation).toBe(2);

    replacement.emit("message", {
      type: "response",
      requestId: request.requestId,
      terminalId: "t1",
      result: "FRESH",
      generation: 2,
    });
    await expect(promise).resolves.toEqual({ data: "FRESH", cols: 80, rows: 24 });
    vi.useRealTimers();
  });

  it("reports per-slot governance snapshots with sessions, queue depth, and hard-capped eligibility", async () => {
    const b1 = pool.createBackend(makeSpec("t1"), makeDelegate())!;
    pool.createBackend(makeSpec("t2"), makeDelegate());
    pool.createBackend(makeSpec("t3"), makeDelegate());

    const pending = b1.serialize();
    const snapshots = pool.getGovernanceSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((s) => s.kind === "analysis-pool")).toBe(true);
    expect(snapshots.every((s) => s.alive)).toBe(true);
    // Persistent worker_threads: trim only — never dispose/restart (Electron
    // worker-churn crash makes terminate/recreate cycles off-limits).
    expect(
      snapshots.every((s) => s.eligibility.trim && !s.eligibility.dispose && !s.eligibility.restart)
    ).toBe(true);
    expect(snapshots.reduce((sum, s) => sum + s.activeSessionCount, 0)).toBe(3);
    expect(snapshots.reduce((sum, s) => sum + s.queueDepth, 0)).toBe(1);

    const request = workers.flatMap((w) => w.messagesOfType("request"))[0];
    workers.forEach((w) =>
      w.emit("message", {
        type: "response",
        requestId: request.requestId,
        terminalId: "t1",
        result: null,
        generation: request.generation,
      })
    );
    await pending;
    expect(pool.getGovernanceSnapshots().reduce((sum, s) => sum + s.queueDepth, 0)).toBe(0);
  });

  it("marks a slot dead in governance snapshots once its respawn budget is spent", async () => {
    vi.useFakeTimers();
    pool.createBackend(makeSpec("t1"), makeDelegate());
    pool.createBackend(makeSpec("t2"), makeDelegate());

    workers[0].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(600);
    workers[2].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(2000);

    const snapshots = pool.getGovernanceSnapshots();
    const dead = snapshots.filter((s) => !s.alive);
    expect(dead).toHaveLength(1);
    expect(dead[0].state).toBe("dead");
    expect(dead[0].activeSessionCount).toBe(0);
    vi.useRealTimers();
  });

  it("ignores a data-ack from a superseded generation after a fresh-slot rebuild", async () => {
    vi.useFakeTimers();
    const backend = pool.createBackend(
      {
        ...makeSpec("t1"),
        flowControl: { highWatermark: 100, lowWatermark: 40, holdHardCap: 100_000 },
      },
      makeDelegate()
    )!;

    // Worker loss → respawn bumps the feed epoch to 1 and rebuilds the slot.
    workers[0].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(600);
    const worker = workers[1];

    backend.feedChunk("a".repeat(60), { agentLive: false }); // posted, outstanding 60
    backend.feedChunk("b".repeat(60), { agentLive: false }); // posted, outstanding 120
    backend.feedChunk("HELD", { agentLive: false }); // held (120 >= 100)
    const dataBefore = worker.messagesOfType("data").length;

    // A late ack from the OLD generation (epoch 0) must be discarded — it must
    // not debit the fresh ledger or release the hold.
    worker.emit("message", { type: "data-ack", terminalId: "t1", bytes: 100, epoch: 0 });
    expect(worker.messagesOfType("data")).toHaveLength(dataBefore);

    // The current-generation ack (epoch 1) drops outstanding below low and
    // flushes the hold.
    worker.emit("message", { type: "data-ack", terminalId: "t1", bytes: 100, epoch: 1 });
    const dataMsgs = worker.messagesOfType("data");
    expect(dataMsgs).toHaveLength(dataBefore + 1);
    expect(dataMsgs[dataMsgs.length - 1].data).toBe("HELD");
    vi.useRealTimers();
  });

  describe("worker memory accounting", () => {
    const sample = (heapUsedBytes: number) => ({
      type: "memory-sample" as const,
      heapUsedBytes,
      externalBytes: 5_000_000,
      sessionCount: 1,
      sessions: [{ terminalId: "t1", bufferLines: 480, cols: 120 }],
      sampledAt: 111,
    });

    it("caches the latest sample per slot and exposes it with a receipt age", () => {
      pool.createBackend(makeSpec("t1"), makeDelegate());
      workers[0].emit("message", sample(10_000_000));
      workers[0].emit("message", sample(20_000_000));

      const accounting = pool.getMemoryAccounting();
      expect(accounting).toHaveLength(1);
      expect(accounting[0].alive).toBe(true);
      expect(accounting[0].heapUsedBytes).toBe(20_000_000);
      expect(accounting[0].externalBytes).toBe(5_000_000);
      expect(accounting[0].sessions).toEqual([{ terminalId: "t1", bufferLines: 480, cols: 120 }]);
      expect(Number.isFinite(accounting[0].ageMs)).toBe(true);
    });

    it("clears the sample on worker exit and fences samples from a superseded instance", async () => {
      vi.useFakeTimers();
      pool.createBackend(makeSpec("t1"), makeDelegate());
      const original = workers[0];
      original.emit("message", sample(10_000_000));
      expect(pool.getMemoryAccounting()[0].heapUsedBytes).toBe(10_000_000);

      // Exit: the isolate is gone — its memory must stop counting immediately.
      original.emit("exit", 1);
      expect(pool.getMemoryAccounting()[0].alive).toBe(false);
      expect(pool.getMemoryAccounting()[0].heapUsedBytes).toBe(0);
      expect(pool.getMemoryAccounting()[0].ageMs).toBe(Infinity);

      // Respawn, then a late sample from the SUPERSEDED instance arrives — it
      // must not be attributed to the fresh worker.
      await vi.advanceTimersByTimeAsync(600);
      original.emit("message", sample(99_000_000));
      expect(pool.getMemoryAccounting()[0].heapUsedBytes).toBe(0);

      // The fresh instance's own sample is accepted.
      workers[1].emit("message", sample(30_000_000));
      expect(pool.getMemoryAccounting()[0].heapUsedBytes).toBe(30_000_000);
      vi.useRealTimers();
    });

    it("fills the governance snapshot memory field from the cached sample", () => {
      pool.createBackend(makeSpec("t1"), makeDelegate());
      const before = pool.getGovernanceSnapshots()[0];
      expect(before.memory).toBeNull();
      expect(before.detail?.memorySampleAgeMs).toBeNull();

      workers[0].emit("message", sample(10_000_000));
      const after = pool.getGovernanceSnapshots()[0];
      expect(after.memory).toEqual({
        rssBytes: null,
        heapUsedBytes: 10_000_000,
        externalBytes: 5_000_000,
      });
      expect(typeof after.detail?.memorySampleAgeMs).toBe("number");
    });

    it("computes sample age from host receipt time, not the worker's sampledAt", () => {
      vi.useFakeTimers();
      pool.createBackend(makeSpec("t1"), makeDelegate());
      // A wildly wrong worker-side clock must not affect the age: receipt
      // time is the host's own clock.
      workers[0].emit("message", { ...sample(10_000_000), sampledAt: 0 });

      vi.advanceTimersByTime(3000);
      expect(pool.getMemoryAccounting()[0].ageMs).toBe(3000);
      vi.useRealTimers();
    });

    it("stops caching samples after pool disposal", () => {
      pool.createBackend(makeSpec("t1"), makeDelegate());
      workers[0].emit("message", sample(10_000_000));
      expect(pool.getMemoryAccounting()[0].heapUsedBytes).toBe(10_000_000);

      pool.dispose();
      // A late sample from the (still-running, never-terminated) worker must
      // not keep mutating disposed-pool state.
      workers[0].emit("message", sample(99_000_000));
      expect(pool.getMemoryAccounting()[0].heapUsedBytes).toBe(10_000_000);
    });
  });
});

describe("WorkerAnalysisBackend feed accounting", () => {
  function stubBackend() {
    const posted: HostToWorkerMessage[] = [];
    const control = { sendSucceeds: true };
    const pool: AnalysisPoolHost = {
      post: (_id, msg) => {
        posted.push(msg);
        return control.sendSucceeds;
      },
      request: () => Promise.resolve(null),
      unregister: () => {},
    };
    const backend = new WorkerAnalysisBackend(
      {
        terminalId: "t1",
        cols: 80,
        rows: 24,
        scrollback: 1000,
        restore: false,
        spawnedAt: 1,
        flowControl: { highWatermark: 100, lowWatermark: 40, holdHardCap: 100_000 },
      },
      makeDelegate(),
      pool
    );
    backend.init();
    const dataMessages = () => posted.filter((m) => m.type === "data") as Array<{ data: string }>;
    return { backend, control, dataMessages };
  }

  it("credits outstanding bytes only when the post was actually sent", () => {
    const { backend, control, dataMessages } = stubBackend();

    // A failed post must not credit outstanding — phantom bytes would push the
    // ledger over the high watermark and wrongly start holding real output.
    control.sendSucceeds = false;
    backend.feedChunk("X".repeat(200), { agentLive: false });
    control.sendSucceeds = true;

    // Outstanding is still 0, so this posts rather than coalescing into a hold.
    backend.feedChunk("Y".repeat(10), { agentLive: false });
    expect(dataMessages().some((m) => m.data.startsWith("Y"))).toBe(true);
  });
});
