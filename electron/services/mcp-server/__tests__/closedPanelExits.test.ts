import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecentTerminalExits } from "../../pty/RecentTerminalExits.js";
import {
  FINAL_READ_BUDGET_MS,
  resolveClosedTerminalGeneration,
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
  exited: boolean;
  ignoresGracefulShutdown: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The pty-host as a wait sees it: a closed panel's process runs through the
 * trash grace, then a graceful shutdown that a stubborn process ignores until
 * the kill escalates. An exit reaches main as the host's `exit` event; a plain
 * shell's record goes with it, while an agent pane's stays, marked exited,
 * until the trash lets it go.
 */
class FakeHost {
  readonly exits = new RecentTerminalExits();
  readonly terminals = new Map<string, FakeTerminal>();
  readonly endGraceCalls: Array<[string, number]> = [];
  readonly shutdownsStarted: string[] = [];
  reads = 0;
  failReads = false;

  spawn(id: string, generation: number, ignoresGracefulShutdown = false): void {
    this.terminals.set(id, { generation, trashed: false, exited: false, ignoresGracefulShutdown });
  }

  close(id: string): void {
    const terminal = this.terminals.get(id)!;
    terminal.trashed = true;
    terminal.graceTimer = setTimeout(() => this.expire(id), GRACE_MS);
  }

  /** The process ends; a plain shell's record goes with it. */
  exit(id: string, exitCode = 0, signal?: number): void {
    const terminal = this.terminals.get(id);
    if (terminal === undefined) return;
    clearTimeout(terminal.graceTimer);
    this.terminals.delete(id);
    this.exits.record({ terminalId: id, launchGeneration: terminal.generation, exitCode, signal });
  }

  /** An agent pane's process ends and its record stays, marked exited, in the trash. */
  exitKeepingRecord(id: string, exitCode = 0): void {
    const terminal = this.terminals.get(id)!;
    terminal.exited = true;
    this.exits.record({
      terminalId: id,
      launchGeneration: terminal.generation,
      exitCode,
      signal: undefined,
    });
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
    if (terminal.exited) {
      this.terminals.delete(id);
      return;
    }
    this.shutdownsStarted.push(id);
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
        this.reads++;
        if (this.failReads) throw new Error("timed out");
        const terminal = this.terminals.get(id);
        return terminal === undefined
          ? null
          : { isExited: terminal.exited, launchGeneration: terminal.generation };
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
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
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
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000);
    // The deadline falls after the grace ends and the graceful shutdown starts,
    // and before the kill escalates.
    const timeoutMs = 1_000 + SHUTDOWN_MS + 100;
    const wait = waitForClosedPanelExits(
      [{ terminalId: "t1", launchGeneration: 3 }],
      { timeoutMs, endGrace: false },
      host.deps()
    );

    const result = await settleWithin(wait, timeoutMs);
    expect(host.shutdownsStarted).toEqual(["t1"]);
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "running" }]);
    expect(host.endGraceCalls).toEqual([]);
  });

  it("reports a process that honours the graceful shutdown as exited under the same deadline", async () => {
    host.spawn("t1", 3, false);
    host.close("t1");
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000);
    const timeoutMs = 1_000 + SHUTDOWN_MS + 100;

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs, endGrace: false },
        host.deps()
      ),
      timeoutMs
    );
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "exited", exitCode: 0 }]);
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
    await vi.advanceTimersByTimeAsync(5_000);
    host.exitKeepingRecord("t1", 2);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(host.terminals.has("t1")).toBe(false);

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 5_000, endGrace: true },
        host.deps()
      ),
      0
    );
    expect(result.processes).toEqual([
      { terminalId: "t1", outcome: "exited", exitCode: 2, graceEnded: false },
    ]);
    expect(host.endGraceCalls).toEqual([]);
    expect(host.reads).toBe(0);
  });

  it("reads an exit off a record the host still holds marked exited when main kept none", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    host.terminals.get("t1")!.exited = true;

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 5_000, endGrace: false },
        host.deps()
      ),
      0
    );
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "exited" }]);
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
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "unknown", graceEnded: false }]);
    expect(host.endGraceCalls).toEqual([]);
  });

  it("ignores another incarnation's exit while it waits", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    const wait = waitForClosedPanelExits(
      [{ terminalId: "t1", launchGeneration: 3 }],
      { timeoutMs: 2_000, endGrace: false },
      host.deps()
    );
    await vi.advanceTimersByTimeAsync(500);
    host.exits.record({ terminalId: "t1", launchGeneration: 2, exitCode: 1, signal: undefined });

    const result = await settleWithin(wait, 1_500);
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "running" }]);
  });

  it("never matches a kept exit to a panel whose closed incarnation main didn't know", async () => {
    host.exits.record({ terminalId: "t1", launchGeneration: 1, exitCode: 0, signal: undefined });
    host.spawn("t1", 2);
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
    // Nor any record: the live one may be another incarnation's.
    expect(host.reads).toBe(0);
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "unknown", graceEnded: false }]);
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

  it("reads each panel once for a zero deadline", async () => {
    host.spawn("t1", 3);
    host.close("t1");

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 0, endGrace: false },
        host.deps()
      ),
      0
    );
    expect(host.reads).toBe(1);
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "running" }]);
  });

  it("holds a first read that never answers to the deadline plus the budget", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    const hung: ClosedPanelExitDeps = { ...host.deps(), readRecord: () => new Promise(() => {}) };

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 0, endGrace: true },
        hung
      ),
      // The read still out at the budget is given up a tick later.
      FINAL_READ_BUDGET_MS + 1
    );
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "unknown", graceEnded: false }]);
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

  it("leaves graceEnded out when the host never answered the request", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    const silent: ClosedPanelExitDeps = {
      ...host.deps(),
      endTrashGrace: () => new Promise(() => {}),
    };

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 1_000, endGrace: true },
        silent
      ),
      1_000 + FINAL_READ_BUDGET_MS
    );
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "running" }]);
  });

  it("asks before each grace is ended, and stops nothing once that is refused", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    const refused = new Error("not driving");

    const wait = waitForClosedPanelExits(
      [{ terminalId: "t1", launchGeneration: 3 }],
      {
        timeoutMs: 5_000,
        endGrace: true,
        authorizeEndGrace: () => {
          throw refused;
        },
      },
      host.deps()
    );

    await expect(settleWithin(wait, 0)).rejects.toBe(refused);
    expect(host.endGraceCalls).toEqual([]);
  });

  it("asks before each panel's grace, and sends none after the first refusal", async () => {
    for (const [id, generation] of [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ] as const) {
      host.spawn(id, generation);
      host.close(id);
    }
    const deps = host.deps();
    const delays: Record<string, number> = { a: 10, b: 20, c: 30 };
    const staggered: ClosedPanelExitDeps = {
      ...deps,
      readRecord: (id) =>
        new Promise((resolve) => setTimeout(() => resolve(deps.readRecord(id)), delays[id])),
      // The first request is never answered, so the refusal can't wait on it.
      endTrashGrace: (id, generation) => {
        host.endGraceCalls.push([id, generation]);
        return new Promise(() => {});
      },
    };
    let asked = 0;
    const refused = new Error("not driving");

    const wait = waitForClosedPanelExits(
      [
        { terminalId: "a", launchGeneration: 1 },
        { terminalId: "b", launchGeneration: 2 },
        { terminalId: "c", launchGeneration: 3 },
      ],
      {
        timeoutMs: 5_000,
        endGrace: true,
        authorizeEndGrace: () => {
          if (++asked === 2) throw refused;
        },
      },
      staggered
    );

    await expect(settleWithin(wait, 30)).rejects.toBe(refused);
    expect(asked).toBe(2);
    expect(host.endGraceCalls).toEqual([["a", 1]]);
  });

  it("starts nothing for a first read that answers after its budget", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    const deps = host.deps();
    let release: () => void = () => {};
    let reads = 0;
    const late: ClosedPanelExitDeps = {
      ...deps,
      readRecord: (id) => {
        if (++reads === 1) {
          return new Promise((resolve) => {
            release = () => resolve(deps.readRecord(id));
          });
        }
        // The final read lets the first one answer, after its budget lapsed.
        release();
        return deps.readRecord(id);
      },
    };
    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 1_000, endGrace: true },
        late
      ),
      1_000 + FINAL_READ_BUDGET_MS
    );
    expect(host.endGraceCalls).toEqual([]);
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "running", graceEnded: false }]);
  });

  it("starts no shutdown once the call is cancelled", async () => {
    host.spawn("t1", 3);
    host.close("t1");
    const controller = new AbortController();
    const deps = host.deps();
    const slow: ClosedPanelExitDeps = {
      ...deps,
      readRecord: async (id) => {
        controller.abort();
        return deps.readRecord(id);
      },
    };

    const result = await settleWithin(
      waitForClosedPanelExits(
        [{ terminalId: "t1", launchGeneration: 3 }],
        { timeoutMs: 30_000, endGrace: true, signal: controller.signal },
        slow
      ),
      0
    );
    expect(host.endGraceCalls).toEqual([]);
    expect(result.processes).toEqual([{ terminalId: "t1", outcome: "running", graceEnded: false }]);
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

describe("resolveClosedTerminalGeneration (#15728)", () => {
  function sources(
    live: number | null,
    exited: number | undefined,
    entry?: { generation: number; closeReason?: string }
  ) {
    return {
      liveGeneration: () => live,
      latestExitGeneration: () => exited,
      ledgerEntry: () => entry,
    };
  }

  it("names the running incarnation first", () => {
    expect(resolveClosedTerminalGeneration("t1", sources(4, 3, { generation: 4 }))).toBe(4);
  });

  it("names the one main saw exit once nothing runs", () => {
    expect(
      resolveClosedTerminalGeneration(
        "t1",
        sources(null, 3, { generation: 3, closeReason: "exit" })
      )
    ).toBe(3);
  });

  it("passes over a later launch the host refused, which ran nothing", () => {
    expect(
      resolveClosedTerminalGeneration(
        "t1",
        sources(null, 1, { generation: 2, closeReason: "spawn-failed:TERMINAL_ALREADY_LIVE" })
      )
    ).toBe(1);
  });

  it("names none while a later incarnation's exit hasn't arrived", () => {
    expect(resolveClosedTerminalGeneration("t1", sources(null, 1, { generation: 2 }))).toBe(
      undefined
    );
  });

  it("falls back to the ledger's launch only when an exit ended it", () => {
    expect(
      resolveClosedTerminalGeneration(
        "t1",
        sources(null, undefined, { generation: 5, closeReason: "exit" })
      )
    ).toBe(5);
    expect(
      resolveClosedTerminalGeneration(
        "t1",
        sources(null, undefined, { generation: 5, closeReason: "spawn-failed:SPAWN_ERROR" })
      )
    ).toBeUndefined();
    expect(resolveClosedTerminalGeneration("t1", sources(null, undefined))).toBeUndefined();
  });
});
