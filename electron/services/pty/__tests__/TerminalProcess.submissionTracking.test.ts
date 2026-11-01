import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubProcessKillForFile } from "../../../__tests__/helpers/processKillGuard.js";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import { events } from "../../events.js";
import type { SpawnContext } from "../terminalSpawn.js";
import type { TerminalInputController } from "../TerminalInputController.js";
import { OUTPUT_PROGRESS_SAMPLE_MS } from "../OutputProgressTracker.js";

/**
 * #12337 end to end through the pty-host side of the submit path: a caller's
 * token in, a phase out, with the real `TerminalInputController` doing the
 * encoding and gating.
 *
 * Driven through `TerminalProcess` rather than against `WriteQueue` directly
 * because the interesting phases are decided by `performSubmit`'s guards, and
 * those only exist here.
 */

let ptyWriteMock: ReturnType<typeof vi.fn<(data: string) => void>>;
let ptyOnDataCallback: ((data: string) => void) | null = null;

vi.mock("../../../utils/windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/windowsTreeKill.js")>()),
  killWindowsProcessTrees: vi.fn(async () => []),
  killWindowsProcessTreesSync: vi.fn(() => []),
}));

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: (data: string) => {
      ptyWriteMock(data);
    },
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    onData: (cb: (data: string) => void) => {
      ptyOnDataCallback = cb;
      return { dispose: () => {} };
    },
    onExit: () => ({ dispose: () => {} }),
  };
  return pty as IPty;
}

function defaultSpawnContext(): SpawnContext {
  return { shell: "/bin/zsh", args: ["-l"], env: {} };
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];

function createTerminal(
  options?: Partial<TerminalProcessOptions>,
  onSubmitStatus?: (id: string, state: string) => void
): TerminalProcess {
  const merged = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal" as const,
    ...options,
  };
  return new TerminalProcess(
    "t1",
    merged,
    { emitData: () => {}, onExit: () => {}, onSubmitStatus },
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agentStateService: { handleActivityState: () => {} } as any,
      ptyPool: null,
      processTreeCache: null,
    },
    defaultSpawnContext(),
    createMockPty()
  );
}

/** The shutdown input lock, reached the way `gracefulShutdown` reaches it. */
function acquireInputLock(terminal: TerminalProcess): () => void {
  return (
    terminal as unknown as { inputController: TerminalInputController }
  ).inputController.acquireShutdownInputLock();
}

// Mock ptys carry made-up PIDs that belong to real processes on the machine
// running the suite; every kill path below must land on a stub (#14418). The
// stub outlives ProcessTreeKiller's 500ms SIGKILL escalation.
stubProcessKillForFile(600);

describe("TerminalProcess submission tracking (#12337)", () => {
  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
  });

  it("records pty_written once the body and its Enter have both gone out", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    terminal.submit("test\n", "tok-1");
    // Mid-submit the body is out but the Enter is not, and that is precisely
    // the window in which the old surface said nothing at all.
    expect(terminal.getSubmission("tok-1")?.phase).toBe("writing");

    await vi.advanceTimersByTimeAsync(250);

    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    expect(terminal.getSubmission("tok-1")?.phase).toBe("pty_written");
    vi.useRealTimers();
  });

  it("records pty_written for a bare Enter", async () => {
    const terminal = createTerminal();

    terminal.submit("", "tok-1");

    expect(ptyWriteMock).toHaveBeenCalledWith("\r");
    await Promise.resolve();
    expect(terminal.getSubmission("tok-1")?.phase).toBe("pty_written");
  });

  it("records failed when the Enter write throws instead of logging it away", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    ptyWriteMock.mockImplementation((data) => {
      if (data === "\r") throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });

    terminal.submit("test\n", "tok-1");
    await vi.advanceTimersByTimeAsync(250);

    // Before this, `write()` swallowed the throw into `logWriteError`, so a
    // genuine dead pipe never reached the failure branch and the submission
    // looked as though it had gone out.
    expect(terminal.getSubmission("tok-1")?.phase).toBe("failed");
    vi.useRealTimers();
  });

  it("records failed when the body write throws, and never sends a bare Enter after it", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    ptyWriteMock.mockImplementation((data) => {
      if (data === "test") throw Object.assign(new Error("write EIO"), { code: "EIO" });
    });

    terminal.submit("test\n", "tok-1");
    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.getSubmission("tok-1")?.phase).toBe("failed");
    expect(ptyWriteMock).not.toHaveBeenCalledWith("\r");
    vi.useRealTimers();
  });

  it("records cancelled when a shutdown lock lands between the body and its Enter", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    terminal.submit("test\n", "tok-1");
    expect(ptyWriteMock).toHaveBeenCalledWith("test");

    // The exact silent loss the issue describes: the body is in the composer,
    // the Enter is abandoned, and nothing else on this surface would say so.
    acquireInputLock(terminal);
    await vi.advanceTimersByTimeAsync(250);

    expect(ptyWriteMock).not.toHaveBeenCalledWith("\r");
    expect(terminal.getSubmission("tok-1")?.phase).toBe("cancelled");
    vi.useRealTimers();
  });

  it("drops a queued submit and an in-flight Enter when pending input is cancelled, and keeps input open (#14454)", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    terminal.submit("first\n", "tok-1");
    terminal.submit("second\n", "tok-2");
    expect(ptyWriteMock).toHaveBeenCalledWith("first");

    // Input moved to another window between the body and its Enter.
    terminal.cancelPendingInput();
    await vi.advanceTimersByTimeAsync(500);

    expect(ptyWriteMock).not.toHaveBeenCalledWith("\r");
    expect(ptyWriteMock).not.toHaveBeenCalledWith("second");
    expect(terminal.getSubmission("tok-1")?.phase).toBe("cancelled");

    // Unlike the shutdown lock, the new owner types straight away.
    terminal.submit("third\n", "tok-3");
    await vi.advanceTimersByTimeAsync(250);
    expect(ptyWriteMock).toHaveBeenCalledWith("third");
    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    vi.useRealTimers();
  });

  it("records cancelled for a submission refused because input is locked", () => {
    const terminal = createTerminal();
    acquireInputLock(terminal);

    terminal.submit("test\n", "tok-1");

    expect(ptyWriteMock).not.toHaveBeenCalled();
    // Answered, not silent: `unknown` would be indistinguishable from a token
    // this terminal never saw.
    expect(terminal.getSubmission("tok-1")?.phase).toBe("cancelled");
  });

  it("retains nothing for an untracked submit", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    // What in-app typing and fleet broadcast do.
    terminal.submit("test\n");
    await vi.advanceTimersByTimeAsync(250);

    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    expect(terminal.getSubmission("tok-1")).toBeUndefined();
    vi.useRealTimers();
  });

  it("surfaces an untracked submit's synchronous write error as a failed status", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const terminal = createTerminal(undefined, (_id, state) => statuses.push(state));
    ptyWriteMock.mockImplementation((data) => {
      if (data === "\r") throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });

    // No token: this is in-app typing / fleet broadcast. Before the strict
    // write path, `write()` swallowed the throw into `logWriteError` and the
    // submit lane never heard about it. Driven through the real
    // TerminalInputController so restoring the swallow fails this test.
    terminal.submit("test\n");
    await vi.advanceTimersByTimeAsync(250);

    expect(statuses).toEqual(["failed"]);
    vi.useRealTimers();
  });
});

/**
 * #12478 through the real sampler: the record's `pty_written` time is the
 * baseline, and the terminal's own `lastOutputChangeAt` is what it is compared
 * against.
 */
describe("TerminalProcess submission output observation (#12478)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ptyWriteMock = vi.fn<(data: string) => void>();
    ptyOnDataCallback = null;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("reports nothing until the screen moves after the Enter, then the change", async () => {
    const terminal = createTerminal({ launchAgentId: "claude" });

    terminal.submit("fix the bug", "tok-1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    expect(terminal.getSubmission("tok-1")?.phase).toBe("pty_written");
    // Accepted, and a screen that never moved: the reported loss.
    expect(terminal.getSubmission("tok-1")).not.toHaveProperty("outputChangeAfterWriteAt");

    ptyOnDataCallback!("● Looking into the bug now.\r\n");
    await vi.advanceTimersByTimeAsync(250);

    const changedAt = terminal.getPublicState().lastOutputChangeAt;
    expect(changedAt).toBeDefined();
    expect(terminal.getSubmission("tok-1")?.outputChangeAfterWriteAt).toBe(changedAt);
    terminal.dispose();
  });

  it("does not count a composer echo that is sampled just after the Enter", async () => {
    const terminal = createTerminal({ launchAgentId: "claude" });

    terminal.submit("fix the bug", "tok-1");
    // The echo lands while the submit waits out its pre-Enter delay, so the
    // sample that sees it fires after the Enter has already gone out.
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.getSubmission("tok-1")?.phase).toBe("writing");
    ptyOnDataCallback!("> fix the bug");
    await vi.advanceTimersByTimeAsync(1_000);

    const record = terminal.getSubmission("tok-1");
    const changedAt = terminal.getPublicState().lastOutputChangeAt;
    expect(record?.phase).toBe("pty_written");
    // Stamped after the Enter but inside the margin — the one case a bare
    // after-the-write comparison would misreport as the agent responding.
    expect(changedAt).toBeGreaterThan(record!.at!);
    expect(changedAt).toBeLessThanOrEqual(record!.at! + OUTPUT_PROGRESS_SAMPLE_MS);
    expect(record).not.toHaveProperty("outputChangeAfterWriteAt");
    terminal.dispose();
  });
});

describe("TerminalProcess handback requests (#12488)", () => {
  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
  });

  it("keeps no tracker for a terminal whose submits never asked", async () => {
    const terminal = createTerminal();

    terminal.submit("", "tok-1");
    await Promise.resolve();

    expect(terminal.getInfo().handbackTracker).toBeUndefined();
    terminal.dispose();
  });

  it("makes a request eligible only once its submission reaches the pty", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    terminal.submit("fix the bug", "tok-1", "k7f3qa");
    const tracker = terminal.getInfo().handbackTracker;
    expect(tracker?.hasRequests()).toBe(true);
    expect(tracker?.deliveredRequests()).toEqual([]);

    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.getSubmission("tok-1")?.phase).toBe("pty_written");
    expect(tracker?.deliveredRequests()).toMatchObject([
      { code: "k7f3qa", submissionToken: "tok-1", delivered: true },
    ]);
    vi.useRealTimers();
    terminal.dispose();
  });

  it("retires an earlier request when a later plain submission reaches the pty", async () => {
    const terminal = createTerminal();

    terminal.submit("", "tok-1", "aaaaaa");
    await Promise.resolve();
    terminal.submit("", "tok-2");
    await Promise.resolve();
    await Promise.resolve();

    expect(terminal.getSubmission("tok-2")?.phase).toBe("pty_written");
    expect(terminal.getInfo().handbackTracker?.hasRequests()).toBe(false);
    terminal.dispose();
  });

  it("drops the last handback once a later plain submission reaches the pty (#13128)", async () => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
    const terminal = createTerminal({ launchAgentId: "claude", handbackCode: "k7f3qa" });
    terminal.getInfo().agentState = "waiting";

    ptyOnDataCallback!("DAINTREE-DONE-k7f3qa: reviewed END-k7f3qa\r\n");
    await vi.advanceTimersByTimeAsync(300);
    expect(terminal.getInfo().lastHandback?.message).toBe("reviewed");
    // The hit retired the only request, so the tracker has nothing left to retire.
    expect(terminal.getInfo().handbackTracker?.hasRequests()).toBe(false);

    terminal.submit("one more thing", "tok-2");
    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.getSubmission("tok-2")?.phase).toBe("pty_written");
    expect(terminal.getInfo().lastHandback).toBeUndefined();
    expect(terminal.getInfo().lastHandbackUnpublished).toBe(false);
    vi.useRealTimers();
    terminal.dispose();
  });

  it("keeps the last handback until a later submission's Enter reaches the pty", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    const handback = { message: "done", observedAt: 1, truncated: false };
    terminal.getInfo().lastHandback = handback;

    terminal.submit("follow up", "tok-1");
    expect(terminal.getSubmission("tok-1")?.phase).toBe("writing");
    expect(terminal.getInfo().lastHandback).toBe(handback);

    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.getSubmission("tok-1")?.phase).toBe("pty_written");
    expect(terminal.getInfo().lastHandback).toBeUndefined();
    vi.useRealTimers();
    terminal.dispose();
  });

  it("reports a done marker the moment it is complete on screen, without waiting for a settle", async () => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
    const seen: Array<{ terminalId: string; message: string | null }> = [];
    const off = events.on("agent:handback-observed", (payload) =>
      seen.push({ terminalId: payload.terminalId, message: payload.handback.message })
    );
    const terminal = createTerminal({ launchAgentId: "claude", handbackCode: "k7f3qa" });

    ptyOnDataCallback!("● Fact: honey never spoils.\r\n");
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toEqual([]);

    ptyOnDataCallback!("DAINTREE-DONE-k7f3qa: gave a fact END-k7f3qa\r\n");
    await vi.advanceTimersByTimeAsync(300);

    expect(seen).toEqual([{ terminalId: "t1", message: "gave a fact" }]);
    expect(terminal.getInfo().handbackTracker?.deliveredRequests()).toEqual([]);
    // Retired, so a later sample of the same screen reports nothing more.
    ptyOnDataCallback!("\r\n");
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toHaveLength(1);
    off();
    vi.useRealTimers();
    terminal.dispose();
  });

  it("reports a scheduled run's launch marker as the run's while its agent still works (#15982)", async () => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
    const runs: Array<{ code: string; report: string; message: string | null; spawnedAt: number }> =
      [];
    const ordinary: Array<string | null> = [];
    const offRun = events.on("agent:run-handback-observed", (payload) =>
      runs.push({
        code: payload.code,
        report: payload.report,
        message: payload.message,
        spawnedAt: payload.spawnedAt,
      })
    );
    const offOrdinary = events.on("agent:handback-observed", (payload) =>
      ordinary.push(payload.handback.message)
    );
    const terminal = createTerminal({
      launchAgentId: "claude",
      handbackCode: "k7f3qa",
      handbackInstruction: "run",
    });
    terminal.getInfo().agentState = "working";

    ptyOnDataCallback!("DAINTREE-NEEDS-YOU-k7f3qa: the deploy key expired END-k7f3qa\r\n");
    await vi.advanceTimersByTimeAsync(300);

    expect(runs).toEqual([
      {
        code: "k7f3qa",
        report: "needs-you",
        message: "the deploy key expired",
        spawnedAt: terminal.getInfo().spawnedAt,
      },
    ]);
    // The ordinary observation still goes out, as for any handback.
    expect(ordinary).toEqual(["the deploy key expired"]);
    offRun();
    offOrdinary();
    vi.useRealTimers();
    terminal.dispose();
  });

  it("never reports a launch marker as a run's when the launch was no run's", async () => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
    const runs: unknown[] = [];
    const off = events.on("agent:run-handback-observed", (payload) => runs.push(payload));
    const terminal = createTerminal({ launchAgentId: "claude", handbackCode: "k7f3qa" });
    terminal.getInfo().agentState = "waiting";

    ptyOnDataCallback!("DAINTREE-NEEDS-YOU-k7f3qa: stuck END-k7f3qa\r\n");
    ptyOnDataCallback!("DAINTREE-DONE-k7f3qa: reviewed END-k7f3qa\r\n");
    await vi.advanceTimersByTimeAsync(300);

    expect(terminal.getInfo().lastHandback?.message).toBe("reviewed");
    expect(runs).toEqual([]);
    off();
    vi.useRealTimers();
    terminal.dispose();
  });

  it("names the state a marker was printed in by the pane's own last transition (#15726)", async () => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
    const seen: Array<number | undefined> = [];
    const off = events.on("agent:handback-observed", (payload) =>
      seen.push(payload.lastStateChange)
    );
    const terminal = createTerminal({ launchAgentId: "grok", handbackCode: "k7f3qa" });
    const workingSince = Date.now() - 42_000;
    terminal.getInfo().agentState = "working";
    terminal.getInfo().lastStateChange = workingSince;

    ptyOnDataCallback!("DAINTREE-DONE-k7f3qa: gave a fact END-k7f3qa\r\n");
    await vi.advanceTimersByTimeAsync(300);

    expect(seen).toEqual([workingSince]);
    off();
    vi.useRealTimers();
    terminal.dispose();
  });

  it("keeps a code open while the agent works, reporting a changed capture once", async () => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
    const seen: Array<string | null> = [];
    const off = events.on("agent:handback-observed", (payload) =>
      seen.push(payload.handback.message)
    );
    const terminal = createTerminal({ launchAgentId: "grok", handbackCode: "k7f3qa" });
    terminal.getInfo().agentState = "working";

    // A drafted marker in a thinking preview, before the reply itself prints.
    ptyOnDataCallback!("  draft: DAINTREE-DONE-k7f3qa: Voted A END-k7f3qa\r\n");
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toEqual(["Voted A"]);
    expect(terminal.getInfo().handbackTracker?.deliveredRequests()).toHaveLength(1);
    const firstObservedAt = terminal.getInfo().lastHandback?.observedAt;

    // The same screen sampled again reports nothing new.
    ptyOnDataCallback!("\r\n");
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toHaveLength(1);

    ptyOnDataCallback!("  DAINTREE-DONE-k7f3qa: Voted A, runner-up C. END-k7f3qa\r\n");
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toEqual(["Voted A", "Voted A, runner-up C."]);
    expect(terminal.getInfo().lastHandback?.message).toBe("Voted A, runner-up C.");
    // Input typed between the two captures must still read as after the handback (#13128).
    expect(terminal.getInfo().lastHandback?.observedAt).toBe(firstObservedAt);

    // Out of `working`, the same capture retires the code without reporting again.
    terminal.getInfo().agentState = "waiting";
    ptyOnDataCallback!("\r\n");
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toHaveLength(2);
    expect(terminal.getInfo().handbackTracker?.deliveredRequests()).toEqual([]);
    off();
    vi.useRealTimers();
    terminal.dispose();
  });

  it("registers a launch prompt's code as delivered at spawn", () => {
    const terminal = createTerminal({ handbackCode: "launch" });

    expect(terminal.getInfo().handbackTracker?.deliveredRequests()).toMatchObject([
      { code: "launch", delivered: true },
    ]);
    terminal.dispose();
  });
});

/**
 * #15521: a submission carrying a first-prompt candidate offers it only once
 * its Enter has been written to an agent, through the same phases as above.
 */
describe("TerminalProcess first prompt (#15521)", () => {
  const candidate = { text: "Fix the login bug" };
  let offered: Array<{ id: string; firstPrompt: unknown }>;

  beforeEach(() => {
    vi.useFakeTimers();
    ptyWriteMock = vi.fn<(data: string) => void>();
    offered = [];
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function createAgentTerminal(options?: Partial<TerminalProcessOptions>): TerminalProcess {
    return new TerminalProcess(
      "t1",
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal" as const,
        launchAgentId: "claude",
        ...options,
      },
      {
        emitData: () => {},
        onExit: () => {},
        onFirstPromptWritten: (id, firstPrompt) => offered.push({ id, firstPrompt }),
      },
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agentStateService: { handleActivityState: () => {} } as any,
        ptyPool: null,
        processTreeCache: null,
      },
      defaultSpawnContext(),
      createMockPty()
    );
  }

  it("offers the record once the Enter is written, stamped with that moment", async () => {
    vi.setSystemTime(10_000);
    let enterAt: number | undefined;
    ptyWriteMock.mockImplementation((data) => {
      if (data === "\r") enterAt = Date.now();
    });
    const terminal = createAgentTerminal();

    terminal.submit("Fix the login bug", "tok-1", undefined, undefined, undefined, candidate);
    expect(offered).toEqual([]);

    await vi.advanceTimersByTimeAsync(250);
    expect(enterAt).toBeGreaterThan(10_000);
    expect(offered).toEqual([
      { id: "t1", firstPrompt: { text: "Fix the login bug", via: "send", at: enterAt } },
    ]);
  });

  it("offers nothing when the Enter write throws", async () => {
    const terminal = createAgentTerminal();
    ptyWriteMock.mockImplementation((data) => {
      if (data === "\r") throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });

    terminal.submit("Fix the login bug", "tok-1", undefined, undefined, undefined, candidate);
    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.getSubmission("tok-1")?.phase).toBe("failed");
    expect(offered).toEqual([]);
  });

  it("offers nothing when the Enter is abandoned or the send is refused", async () => {
    const abandoned = createAgentTerminal();
    abandoned.submit("Fix the login bug", "tok-1", undefined, undefined, undefined, candidate);
    acquireInputLock(abandoned);
    await vi.advanceTimersByTimeAsync(250);
    expect(abandoned.getSubmission("tok-1")?.phase).toBe("cancelled");

    const refused = createAgentTerminal();
    acquireInputLock(refused);
    refused.submit("Fix the login bug", "tok-2", undefined, undefined, undefined, candidate);
    await vi.advanceTimersByTimeAsync(250);

    expect(offered).toEqual([]);
  });

  it("offers nothing to the shell a launched agent has exited to", async () => {
    const terminal = createAgentTerminal();
    // Launch affinity alone would still call this an agent.
    terminal.getInfo().agentState = "exited";
    terminal.submit("ls", undefined, undefined, undefined, undefined, candidate);
    await vi.advanceTimersByTimeAsync(250);

    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    expect(offered).toEqual([]);
  });

  it("offers nothing to a shell, or for a send that carried no candidate", async () => {
    const shell = createAgentTerminal({ launchAgentId: undefined });
    shell.submit("ls", undefined, undefined, undefined, undefined, candidate);
    const agent = createAgentTerminal();
    agent.submit("Fix the login bug");
    await vi.advanceTimersByTimeAsync(250);

    expect(ptyWriteMock).toHaveBeenCalledWith("\r");
    expect(offered).toEqual([]);
  });
});
