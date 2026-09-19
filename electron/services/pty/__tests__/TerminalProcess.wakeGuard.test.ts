import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { isTerminalReportOnly } from "../terminalInput.js";

let ptyWriteMock: ReturnType<typeof vi.fn<(data: string) => void>>;

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

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
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };
  return pty as IPty;
}

const SPAWN_CONTEXT: SpawnContext = { shell: "/bin/zsh", args: ["-l"], env: {} };

interface Internals {
  terminalInfo: {
    agentState?: string;
    waitingReason?: string;
    lastStateChange?: number;
    lastTypedInputAt?: number;
    detectedAgentId?: string;
  };
}

function createTerminal(): TerminalProcess {
  return new TerminalProcess(
    "t-wake",
    { cwd: process.cwd(), cols: 80, rows: 24, kind: "terminal" },
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: { handleActivityState: () => {} } as never,
      ptyPool: null,
      processTreeCache: null,
    },
    SPAWN_CONTEXT,
    createMockPty()
  );
}

function info(terminal: TerminalProcess): Internals["terminalInfo"] {
  return (terminal as unknown as Internals).terminalInfo;
}

/** An agent observed waiting at an empty prompt since `settledAt`. */
function settleAtPrompt(terminal: TerminalProcess, settledAt: number): void {
  const t = info(terminal);
  t.detectedAgentId = "claude";
  t.agentState = "waiting";
  t.waitingReason = "prompt";
  t.lastStateChange = settledAt;
}

describe("isTerminalReportOnly (#12491)", () => {
  it.each([
    ["focus in", "\x1b[I"],
    ["focus out", "\x1b[O"],
    ["SGR mouse press", "\x1b[<0;12;5M"],
    ["SGR mouse release", "\x1b[<0;12;5m"],
    ["X10 mouse", "\x1b[M !!"],
    ["cursor position report", "\x1b[24;80R"],
    ["primary device attributes", "\x1b[?62;22c"],
    ["secondary device attributes", "\x1b[>0;276;0c"],
    ["OSC colour reply (BEL)", "\x1b]11;rgb:0000/0000/0000\x07"],
    ["OSC colour reply (ST)", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"],
    ["device status reply", "\x1b[0n"],
    ["colour-scheme report", "\x1b[?997;1n"],
    ["DEC-private cursor position report", "\x1b[?24;80R"],
    ["two reports back to back", "\x1b[O\x1b[I"],
  ])("treats %s as a report, not typing", (_label, data) => {
    expect(isTerminalReportOnly(data)).toBe(true);
  });

  it.each([
    ["a printable key", "a"],
    ["Enter", "\r"],
    ["an arrow key, which can recall history into the composer", "\x1b[A"],
    ["Escape", "\x1b"],
    ["a paste", "\x1b[200~hello\x1b[201~"],
    ["a report followed by a keystroke", "\x1b[Ix"],
  ])("treats %s as typing", (_label, data) => {
    expect(isTerminalReportOnly(data)).toBe(false);
  });
});

describe("TerminalProcess typed-input stamp and settled-prompt guard (#12491)", () => {
  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps raw typing but not focus reports or the submit lane's own writes", async () => {
    const terminal = createTerminal();

    terminal.write("\x1b[I");
    terminal.tryWrite("\x1b[O");
    expect(info(terminal).lastTypedInputAt).toBeUndefined();

    terminal.submit("hello");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(info(terminal).lastTypedInputAt).toBeUndefined();

    vi.setSystemTime(new Date("2026-09-19T10:00:05Z"));
    terminal.write("x");
    expect(info(terminal).lastTypedInputAt).toBe(Date.now());
  });

  it("writes a guarded submission to an agent settled at an empty prompt", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);

    terminal.submit("wake", "tok-1", undefined, "settled-prompt");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["wake", "\r"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
  });

  it.each([
    ["working", { agentState: "working" }],
    ["at an approval", { waitingReason: "approval" }],
    ["at a question", { waitingReason: "question" }],
    ["at an error", { waitingReason: "error" }],
    ["idle, which may be a bare shell", { agentState: "idle" }],
    ["with no agent detected", { detectedAgentId: undefined }],
  ])("refuses a guarded submission when the agent is %s", async (_label, patch) => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), patch);

    terminal.submit("wake", "tok-1", undefined, "settled-prompt");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
  });

  it("refuses a guarded submission when something was typed after the prompt settled", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    terminal.write("half a thought");
    ptyWriteMock.mockClear();

    terminal.submit("wake", "tok-1", undefined, "settled-prompt");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
  });

  it("judges the guard when the submission reaches the lane, not when it was queued", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);

    // A user prompt holds the lane; the agent starts working on it before the
    // guarded line gets its turn.
    terminal.submit("user prompt");
    terminal.submit("wake", "tok-1", undefined, "settled-prompt");
    info(terminal).agentState = "working";
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["user prompt", "\r"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
  });

  it("drops the Enter when the user types between the body and the Enter", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);

    terminal.submit("wake", "tok-1", undefined, "settled-prompt");
    expect(ptyWriteMock).toHaveBeenLastCalledWith("wake");
    vi.setSystemTime(Date.now() + 10);
    terminal.write("h");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["wake", "h"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
  });

  it("is not refused by the working transition its own submission causes", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    // In-thread analysis flips the agent to working the moment a submission is
    // announced. Announced before admission, the line would refuse itself.
    const analysis = (
      terminal as unknown as {
        analysis: { hasMonitor(): boolean; notifySubmission(): void };
      }
    ).analysis;
    vi.spyOn(analysis, "hasMonitor").mockReturnValue(true);
    const notify = vi.spyOn(analysis, "notifySubmission").mockImplementation(() => {
      info(terminal).agentState = "working";
    });

    terminal.submit("wake", "tok-1", undefined, "settled-prompt");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["wake", "\r"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
    // Announced once, as it executes; an unguarded submit still announces at enqueue too.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("withdraws a guarded submission that has not reached the lane", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);

    terminal.submit("user prompt");
    terminal.submit("wake", "tok-1", undefined, "settled-prompt");
    terminal.withdrawGuardedSubmission("tok-1");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["user prompt", "\r"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
  });

  it("drops the Enter of a guarded submission withdrawn after its body was written", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);

    terminal.submit("wake", "tok-1", undefined, "settled-prompt");
    expect(ptyWriteMock).toHaveBeenLastCalledWith("wake");
    terminal.withdrawGuardedSubmission("tok-1");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["wake"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
  });

  it("never withdraws an ordinary submission", async () => {
    const terminal = createTerminal();

    terminal.submit("first");
    terminal.submit("second", "tok-2");
    terminal.withdrawGuardedSubmission("tok-2");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["first", "\r", "second", "\r"]);
    expect(terminal.getSubmission("tok-2")).toMatchObject({ phase: "pty_written" });
  });

  it("frees the lane after refusing a guarded submission", async () => {
    const terminal = createTerminal();
    info(terminal).agentState = "working";

    terminal.submit("wake", "tok-1", undefined, "settled-prompt");
    await vi.advanceTimersByTimeAsync(3_000);
    terminal.submit("next", "tok-2");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["next", "\r"]);
    expect(terminal.getSubmission("tok-2")).toMatchObject({ phase: "pty_written" });
  });

  it("leaves unguarded submissions exactly as they were", async () => {
    const terminal = createTerminal();
    info(terminal).agentState = "working";

    terminal.submit("plain", "tok-1");
    terminal.write("h");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["plain", "h", "\r"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
  });
});
