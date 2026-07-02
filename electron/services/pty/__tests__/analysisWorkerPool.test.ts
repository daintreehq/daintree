import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnalysisWorkerPool, type WorkerLike } from "../analysis/AnalysisWorkerPool.js";
import type { WorkerAnalysisDelegate } from "../analysis/WorkerAnalysisBackend.js";
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
    await expect(promise).resolves.toBe("SNAPSHOT");
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
    await expect(persistReq).resolves.toBe("PERSISTED");
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
});
