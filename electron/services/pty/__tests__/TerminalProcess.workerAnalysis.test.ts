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
