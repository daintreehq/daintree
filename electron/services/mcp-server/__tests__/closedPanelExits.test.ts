import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecentTerminalExits } from "../../pty/RecentTerminalExits.js";
import {
  FINAL_READ_BUDGET_MS,
  waitForClosedPanelExits,
  type ClosedPanelExitDeps,
  type ClosedPanelExitRecord,
} from "../closedPanelExits.js";
import type { EndTrashGraceStatus } from "../../../../shared/types/pty-host.js";

const GRACE_MS = 20_000;
const SHUTDOWN_MS = 300;
const KILL_ESCALATION_MS = 500;

interface FakeTerminal {
  generation: number;
  trashed: boolean;
  ignoresGracefulShutdown: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The pty-host as a wait sees it: a closed panel's process runs through the
 * trash grace, then a graceful shutdown that a stubborn process ignores until
 * the kill escalates. An exit reaches main as the host's `exit` event and the
 * record goes with it, as a plain shell's does.
 */
class FakeHost {
  readonly exits = new RecentTerminalExits();
  readonly terminals = new Map<string, FakeTerminal>();
  readonly endGraceCalls: Array<[string, number]> = [];
  failReads = false;

  spawn(id: string, generation: number, ignoresGracefulShutdown = false): void {
    this.terminals.set(id, { generation, trashed: false, ignoresGracefulShutdown });
  }

  close(id: string): void {
    const terminal = this.terminals.get(id)!;
    terminal.trashed = true;
    terminal.graceTimer = setTimeout(() => this.expire(id), GRACE_MS);
  }

  exit(id: string, exitCode = 0, signal?: number): void {
    const terminal = this.terminals.get(id);
    if (terminal === undefined) return;
    clearTimeout(terminal.graceTimer);
    this.terminals.delete(id);
    this.exits.record({ terminalId: id, launchGeneration: terminal.generation, exitCode, signal });
  }

  /** The host dropping a record without ever seeing its process exit. */
  forget(id: string): void {
    const terminal = this.terminals.get(id);
    clearTimeout(terminal?.graceTimer);
    this.terminals.delete(id);
  }

  private expire(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal === undefined) return;
    terminal.trashed = false;
    clearTimeout(terminal.graceTimer);
    if (terminal.ignoresGracefulShutdown) {
      setTimeout(() => this.exit(id, 0, 9), SHUTDOWN_MS + KILL_ESCALATION_MS);
    } else {
      setTimeout(() => this.exit(id, 0), SHUTDOWN_MS);
    }
  }

  deps(): ClosedPanelExitDeps {
    return {
      findExit: (id, generation) => this.exits.find(id, generation),
      onExit: (listener) => this.exits.onExit(listener),
      readRecord: async (id): Promise<ClosedPanelExitRecord | null> => {
        if (this.failReads) throw new Error("timed out");
        const terminal = this.terminals.get(id);
        return terminal === undefined
          ? null
          : { isExited: false, launchGeneration: terminal.generation };
      },
      endTrashGrace: async (id, generation): Promise<EndTrashGraceStatus | null> => {
        this.endGraceCalls.push([id, generation]);
        const terminal = this.terminals.get(id);
        if (terminal === undefined || !terminal.trashed) return "not-trashed";
        if (terminal.generation !== generation) return "generation-mismatch";
        this.expire(id);
        return "started";
      },
    };
  }
}

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(ms);
  expect(settled).toBe(true);
  return promise;
}

describe("waitForClosedPanelExits (#15728)", () => {
  let host: FakeHost;

  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a closed panel exited once its process ends, without waiting out the deadline", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    const wait = waitForClosedPanelExits(
      [{ terminalId: "t1", launchGeneration: 3 }],
      { timeoutMs: 30_000, endGrace: false },
      host.deps()
    );
    await vi.advanceTimersByTimeAsync(1_000);
    host.exit("t1", 130);

    const result = await settleWithin(wait, 0);
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "exited", exitCode: 130 }]);
  });

  it("reports a process that ignores the graceful shutdown as running at the deadline", async () => {
    host.spawn("t1", 3, true);
    host.close("t1");
    const wait = waitForClosedPanelExits(
      [{ terminalId: "t1", launchGeneration: 3 }],
      { timeoutMs: 5_000, endGrace: false },
      host.deps()
    );

    const result = await settleWithin(wait, 5_000);
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "running" }]);
    expect(host.endGraceCalls).toEqual([]);
  });

  it("ends the grace early on request, so the same stubborn process is killed and reported exited", async () => {
    host.spawn("t1", 3, true);
    host.close("t1");
    const wait = waitForClosedPanelExits(
      [{ terminalId: "t1", launchGeneration: 3 }],
      { timeoutMs: 5_000, endGrace: true },
      host.deps()
    );

    const result = await settleWithin(wait, SHUTDOWN_MS + KILL_ESCALATION_MS);
    expect(host.endGraceCalls).toEqual([["t1", 3]]);
    expect(result.processes).toEqual([
      { terminalId: "t1", outcome: "exited", exitCode: 0, signal: 9, graceEnded: true },
    ]);
  });

  it("still reports an exit seen during the grace after the trash let the panel go", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    await vi.advanceTimersByTimeAsync(GRACE_MS + SHUTDOWN_MS);
    expect(host.terminals.has("t1")).toBe(false);

    const wait = waitForClosedPanelExits(
      [{ terminalId: "t1", launchGeneration: 3 }],
      { timeoutMs: 5_000, endGrace: true },
      host.deps()
    );

    const result = await settleWithin(wait, 0);
    expect(result.processes).toEqual([
      { terminalId: "t1", outcome: "exited", exitCode: 0, graceEnded: false },
    ]);
    expect(host.endGraceCalls).toEqual([]);
  });

  it("never reads a record that vanished without an exit as one", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    host.forget("t1");

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 5_000, endGrace: false },
        host.deps()
      ),
      0
    );
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "unknown" }]);
  });

  it("reports an id that now names another incarnation as unknown, and never ends its grace", async () => {
    host.spawn("t1", 4);
    host.close("t1");

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 5_000, endGrace: true },
        host.deps()
      ),
      0
    );
    expect(result.processes).toEqual([
      { terminalId: "t1", outcome: "unknown", graceEnded: false },
    ]);
    expect(host.endGraceCalls).toEqual([]);
  });

  it("keeps a still-unanswered read at the deadline as unknown, not running", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    host.failReads = true;

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 2_000, endGrace: false },
        host.deps()
      ),
      2_000
    );
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "unknown" }]);
  });

  it("gives a final read that never answers a bounded budget past the deadline", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    const deps = host.deps();
    let reads = 0;
    const hung: ClosedPanelExitDeps = {
      ...deps,
      readRecord: (id) => (++reads === 1 ? deps.readRecord(id) : new Promise(() => {})),
    };

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 1_000, endGrace: false },
        hung
      ),
      1_000 + FINAL_READ_BUDGET_MS
    );
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "unknown" }]);
  });

  it("does not end the grace of a panel whose closed incarnation main never knew", async () => {
    host.spawn("t1", 3);
    host.close("t1");

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: undefined }],
        { timeoutMs: 0, endGrace: true },
        host.deps()
      ),
      0
    );
    expect(host.endGraceCalls).toEqual([]);
    expect(result.processes).toEqual([
      { terminalId: "t1", outcome: "running", graceEnded: false },
    ]);
  });

  it("waits for every panel under one deadline and answers each in the order asked", async () => {
    host.spawn("a", 1);
    host.spawn("b", 2, true);
    host.close("a");
    host.close("b");
    const wait = waitForClosedPanelExits(
      [
        { terminalId: "b", launchGeneration: 2 },
        { terminalId: "a", launchGeneration: 1 },
      ],
      { timeoutMs: 3_000, endGrace: false },
      host.deps()
    );
    await vi.advanceTimersByTimeAsync(500);
    host.exit("a", 1);

    const result = await settleWithin(wait, 2_500);
    expect(result.processes).toEqual([
      { terminalId: "b", outcome: "running" },
      { terminalId: "a", outcome: "exited", exitCode: 1 },
    ]);
  });

  it("keeps an exit that lands while the first read is out", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    const deps = host.deps();
    const racing: ClosedPanelExitDeps = {
      ...deps,
      findExit: vi.fn<ClosedPanelExitDeps["findExit"]>(() => undefined),
      readRecord: async (id) => {
        const record = await deps.readRecord(id);
        host.exit("t1", 0);
        return record;
      },
    };

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 5_000, endGrace: false },
        racing
      ),
      0
    );
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "exited", exitCode: 0 }]);
  });

  it("stops waiting when the call is cancelled and reports what it saw", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    const controller = new AbortController();
    const wait = waitForClosedPanelExits(
      [{ terminalId: "t1", launchGeneration: 3 }],
      { timeoutMs: 30_000, endGrace: false, signal: controller.signal },
      host.deps()
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();

    const result = await settleWithin(wait, 0);
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "running" }]);
  });
});
