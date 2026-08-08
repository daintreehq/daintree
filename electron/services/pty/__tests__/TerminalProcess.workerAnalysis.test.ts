import { describe, it, expect, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import { AnalysisWorkerPool, type WorkerLike } from "../analysis/AnalysisWorkerPool.js";
import type { SpawnContext } from "../terminalSpawn.js";
import type { HostToWorkerMessage, WorkerToHostMessage } from "../analysisWorkerProtocol.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

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

  emit(event: "message", msg: WorkerToHostMessage): void {
    for (const cb of this.listeners.get(event) ?? []) {
      (cb as (a: unknown) => void)(msg);
    }
  }
}

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };
  return pty as IPty;
}

function createWorkerModeTerminal() {
  const workers: FakeWorker[] = [];
  const pool = new AnalysisWorkerPool(1, () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const agentStateService = {
    handleActivityState: vi.fn(),
    updateAgentState: vi.fn(),
  };
  const ctx: SpawnContext = { shell: "/bin/zsh", args: ["-l"], env: {} };
  const terminal = new TerminalProcess(
    "t1",
    { cwd: process.cwd(), cols: 80, rows: 24, kind: "terminal" as const },
    { emitData: () => {}, onExit: () => {} },
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agentStateService: agentStateService as any,
      ptyPool: null,
      processTreeCache: null,
      analysisWorkerPool: pool,
    },
    ctx,
    createMockPty()
  );
  return { terminal, worker: workers[0], agentStateService, pool };
}

describe("TerminalProcess worker-mode analysis events", () => {
  it("rejects a stale waiting-timeout from an old monitor generation", () => {
    const { terminal, worker, agentStateService } = createWorkerModeTerminal();
    const spawnedAt = terminal.getInfo().spawnedAt;

    worker.emit("message", {
      type: "waiting-timeout",
      terminalId: "t1",
      spawnedAt: spawnedAt - 1,
    });
    expect(agentStateService.updateAgentState).not.toHaveBeenCalled();

    worker.emit("message", { type: "waiting-timeout", terminalId: "t1", spawnedAt });
    expect(agentStateService.updateAgentState).toHaveBeenCalledTimes(1);
    expect(agentStateService.updateAgentState).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1" }),
      { type: "watchdog-timeout" },
      "timeout",
      0.6
    );
  });

  it("rejects stale activity-state with the same session guard", () => {
    const { terminal, worker, agentStateService } = createWorkerModeTerminal();
    const spawnedAt = terminal.getInfo().spawnedAt;

    worker.emit("message", {
      type: "activity-state",
      terminalId: "t1",
      spawnedAt: spawnedAt - 1,
      state: "busy",
      metadata: { trigger: "output" },
    });
    expect(agentStateService.handleActivityState).not.toHaveBeenCalled();

    worker.emit("message", {
      type: "activity-state",
      terminalId: "t1",
      spawnedAt,
      state: "busy",
      metadata: { trigger: "output" },
    });
    expect(agentStateService.handleActivityState).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalProcess mirror geometry divergence (#11719)", () => {
  function memorySample(cols: number, rows: number, replayInFlight = false): WorkerToHostMessage {
    return {
      type: "memory-sample",
      heapUsedBytes: 1,
      externalBytes: 1,
      sessionCount: 1,
      sessions: [{ terminalId: "t1", bufferLines: 10, cols, rows, replayInFlight }],
      sampledAt: 1,
    };
  }

  function geometryMessages(worker: FakeWorker) {
    return worker.posted.filter((m) => m.type === "resize" || m.type === "ensure-geometry");
  }

  it("re-asserts the grid when the PTY is already at the requested size", () => {
    const { terminal, worker } = createWorkerModeTerminal();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The mock PTY is 80x24, so this takes the "unchanged" branch — the only
    // branch a re-assertion of the current size ever reaches.
    expect(terminal.resize(80, 24).outcome).toBe("unchanged");
    // Nothing has said the mirror drifted, so no worker traffic is generated.
    expect(geometryMessages(worker)).toHaveLength(0);

    // The worker reports a mirror on a different grid.
    worker.emit("message", memorySample(120, 40));
    expect(geometryMessages(worker)).toHaveLength(1);

    // And a later re-assertion is still able to repair, rather than being
    // short-circuited by the PTY dims already matching.
    expect(terminal.resize(80, 24).outcome).toBe("unchanged");
    expect(geometryMessages(worker).length).toBeGreaterThan(1);
    warn.mockRestore();
  });

  it("logs a divergence once per episode and clears it on agreement", () => {
    const { worker } = createWorkerModeTerminal();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const divergenceWarnings = () =>
      warn.mock.calls.filter((call) => String(call[0]).includes("Mirror grid diverged")).length;

    worker.emit("message", memorySample(120, 40));
    expect(divergenceWarnings()).toBe(1);
    const logged = String(warn.mock.calls[warn.mock.calls.length - 1]![0]);
    // Both grids in one line: the whole point is settling the next report from
    // a user's log rather than from code archaeology.
    expect(logged).toContain("120x40");
    expect(logged).toContain("80x24");

    // The check rides the sample cadence, so an unchanged split must not
    // re-log on every tick.
    worker.emit("message", memorySample(120, 40));
    expect(divergenceWarnings()).toBe(1);

    // Converged: the episode closes...
    worker.emit("message", memorySample(80, 24));
    expect(divergenceWarnings()).toBe(1);

    // ...and a fresh split is a fresh episode.
    worker.emit("message", memorySample(120, 40));
    expect(divergenceWarnings()).toBe(2);
    warn.mockRestore();
  });

  it("keeps retrying the repair while a split persists, unlike the log", () => {
    const { worker } = createWorkerModeTerminal();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Deduping the repair alongside the log would re-seal the divergence: the
    // first repair's post can be dropped, and nothing else re-drives it.
    worker.emit("message", memorySample(120, 40));
    worker.emit("message", memorySample(120, 40));
    worker.emit("message", memorySample(120, 40));

    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("Mirror grid diverged"))
    ).toHaveLength(1);
    expect(geometryMessages(worker).length).toBeGreaterThan(1);
    warn.mockRestore();
  });

  it("does not report a mirror parked by a session replay", () => {
    const { worker } = createWorkerModeTerminal();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // A replay deliberately parks the mirror on the snapshot's capture grid
    // (#11552), so disagreement here is healthy. Crying wolf would make the
    // log useless for the thing it exists to settle.
    worker.emit("message", memorySample(40, 12, true));

    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("Mirror grid diverged"))
    ).toHaveLength(0);
    expect(geometryMessages(worker)).toHaveLength(0);
  });

  it("reports a rows-only split, which a cols-only check would miss", () => {
    const { worker } = createWorkerModeTerminal();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Columns agree; rows do not. Cols-only diagnostics would call this healthy
    // even though cursor addressing and full-screen TUIs are already corrupt.
    worker.emit("message", memorySample(80, 40));
    expect(
      warn.mock.calls.filter((call) => String(call[0]).includes("Mirror grid diverged")).length
    ).toBe(1);
    warn.mockRestore();
  });
});
