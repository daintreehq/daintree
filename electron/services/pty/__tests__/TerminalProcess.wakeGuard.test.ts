import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { isTerminalReportOnly } from "../terminalInput.js";
import type { ExactPromptGuard } from "../../../../shared/types/pty-host.js";
import {
  batchNotices,
  formatAnswerNotice,
  formatFollowupNotice,
  noticeChunk,
} from "@daintreehq/decisions-client";
import {
  parseAnswerNotice,
  parseDecisionNotice,
  renderDecisionSection,
} from "../../decisions/answerNotice.js";

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
    lastOwnedInput?: { owner: string; at: number };
    lastForeignInputAt?: number;
    lastOwnedPromptInput?: { owner: string; at: number };
    lastForeignPromptInputAt?: number;
    detectedAgentId?: string;
    agentIncarnation?: number;
    agentSessionId?: string;
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
    ["Kitty graphics probe reply", "\x1b_Gi=31;OK\x1b\\"],
    ["Kitty graphics reply ended by BEL", "\x1b_Gi=31;OK\x07"],
    ["Kitty graphics error reply", "\x1b_Gi=31;ENOENT:file not found\x1b\\"],
    ["two Kitty graphics replies back to back", "\x1b_Gi=1;OK\x1b\\\x1b_Gi=2;OK\x1b\\"],
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
    ["Alt+_", "\x1b_"],
    ["Alt+_ and then text", "\x1b_hello"],
    ["a Kitty graphics reply followed by a keystroke", "\x1b_Gi=31;OK\x1b\\x"],
    ["a multi-line paste framed like a reply", "\x1b_Ghello\nworld\x1b\\"],
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

  it("files an assistant's keys under it and every other typed input as foreign (#16094)", () => {
    const terminal = createTerminal();
    const start = Date.now();

    terminal.write("\x1b", undefined, "principal-a");
    expect(info(terminal)).toMatchObject({
      lastTypedInputAt: start,
      lastOwnedInput: { owner: "principal-a", at: start },
    });
    expect(info(terminal).lastForeignInputAt).toBeUndefined();

    vi.setSystemTime(start + 10);
    terminal.tryWrite("x");
    vi.setSystemTime(start + 20);
    terminal.write("\x1b[I", undefined, "principal-a");
    expect(info(terminal)).toMatchObject({
      lastTypedInputAt: start + 10,
      lastForeignInputAt: start + 10,
      lastOwnedInput: { owner: "principal-a", at: start },
    });
  });

  it("files keys at an approval dialog as typing but not as a prompt (#16187)", () => {
    const terminal = createTerminal();
    const t = info(terminal);
    t.detectedAgentId = "claude";
    t.agentState = "waiting";
    t.waitingReason = "approval";
    const start = Date.now();

    terminal.write("\x1b[B");
    terminal.tryWrite("\r");
    expect(t.lastTypedInputAt).toBe(start);
    expect(t.lastForeignPromptInputAt).toBeUndefined();

    // The same keys reach the composer mid-turn, or at its prompt, whichever way they come.
    t.agentState = "working";
    t.waitingReason = undefined;
    vi.setSystemTime(start + 5);
    terminal.tryWrite("w");
    expect(t.lastForeignPromptInputAt).toBe(start + 5);
    vi.setSystemTime(start + 10);
    terminal.write("x");
    expect(t.lastForeignPromptInputAt).toBe(start + 10);

    t.agentState = "waiting";
    t.waitingReason = "prompt";
    vi.setSystemTime(start + 20);
    terminal.write("y", undefined, "principal-a");
    expect(t.lastOwnedPromptInput).toEqual({ owner: "principal-a", at: start + 20 });
    expect(t.lastForeignPromptInputAt).toBe(start + 10);

    // A later approval key never hides the earlier prompt.
    t.waitingReason = "approval";
    vi.setSystemTime(start + 30);
    terminal.write("\r");
    expect(t.lastForeignPromptInputAt).toBe(start + 10);
    expect(t.lastTypedInputAt).toBe(start + 30);
  });

  it("files an unguarded submission as someone's prompt, and Daintree's own guarded lines as nobody's (#16187)", async () => {
    const terminal = createTerminal();
    const t = info(terminal);
    settleAtPrompt(terminal, Date.now() - 5_000);

    terminal.submit("notice", "tok-1", undefined, "settled-prompt");
    terminal.submit("brief", "tok-2", undefined, "settled-prompt-strict");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.lastForeignPromptInputAt).toBeUndefined();

    // An assistant's guarded prompt is its own, filed once its Enter is written,
    // at the next settle: one strict line per settle.
    settleAtPrompt(terminal, Date.now());
    vi.setSystemTime(Date.now() + 10);
    const written = Date.now();
    terminal.submit(
      "brief",
      "tok-3",
      undefined,
      "settled-prompt-strict",
      undefined,
      undefined,
      undefined,
      "principal-a"
    );
    expect(t.lastOwnedPromptInput).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(terminal.getSubmission("tok-3")).toMatchObject({ phase: "pty_written" });
    expect(t.lastOwnedPromptInput?.owner).toBe("principal-a");
    expect(t.lastOwnedPromptInput!.at).toBeGreaterThanOrEqual(written);
    expect(t.lastForeignPromptInputAt).toBeUndefined();

    const at = Date.now();
    terminal.submit("a person's prompt");
    expect(t.lastForeignPromptInputAt).toBe(at);
    // It never reads as a draft: the lane's own writes leave the composer empty.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.lastTypedInputAt).toBeUndefined();
  });

  it("still holds a strict submission after an assistant's own keys (#16094)", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    terminal.write("\x1b[A", undefined, "principal-a");
    ptyWriteMock.mockClear();

    terminal.submit("brief", "tok-1", undefined, "settled-prompt-strict");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
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
    // Gemini is not known to queue mid-turn input, so it keeps the hold.
    [
      "working, in a CLI not known to queue input",
      { agentState: "working", detectedAgentId: "gemini" },
    ],
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

  it("queues a guarded submission behind the turn of a CLI that queues mid-turn input", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), { agentState: "working", lastStateChange: Date.now() - 1_000 });

    terminal.submit("wake", "tok-1", undefined, "settled-prompt");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["wake", "\r"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
  });

  it("refuses a strict guarded submission mid-turn, even for a CLI that queues input (#13496)", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), { agentState: "working", lastStateChange: Date.now() - 1_000 });

    terminal.submit("brief", "tok-1", undefined, "settled-prompt-strict");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
  });

  it("writes one strict guarded submission per settle, before the analysis reports the turn (#13496)", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);

    // Nothing reports the first brief's turn before the second reaches the lane.
    terminal.submit("first", "tok-1", undefined, "settled-prompt-strict");
    terminal.submit("second", "tok-2", undefined, "settled-prompt-strict");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["first", "\r"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
    expect(terminal.getSubmission("tok-2")).toMatchObject({ phase: "cancelled" });

    // Once the agent has settled at its prompt again, the next one goes.
    vi.setSystemTime(Date.now() + 1_000);
    settleAtPrompt(terminal, Date.now());
    vi.setSystemTime(Date.now() + 1_000);
    ptyWriteMock.mockClear();
    terminal.submit("third", "tok-3", undefined, "settled-prompt-strict");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["third", "\r"]);
    expect(terminal.getSubmission("tok-3")).toMatchObject({ phase: "pty_written" });
  });

  it("admits a strict submission at a question asked in prose (#14475)", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), { waitingReason: "question" });

    terminal.submit("toFixed", "tok-1", undefined, "settled-prompt-strict");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["toFixed", "\r"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
  });

  it.each([
    ["at an approval", { waitingReason: "approval" }],
    ["at an error", { waitingReason: "error" }],
  ])("refuses a strict submission %s", async (_label, patch) => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), patch);

    terminal.submit("brief", "tok-1", undefined, "settled-prompt-strict");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
  });

  it("holds a strict submission behind any line the lane wrote since the prompt settled", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);

    terminal.submit("a person's prompt");
    terminal.submit("brief", "tok-1", undefined, "settled-prompt-strict");
    // An ordinary guarded line still queues, as it always did.
    terminal.submit("notice", "tok-2", undefined, "settled-prompt");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
    expect(terminal.getSubmission("tok-2")).toMatchObject({ phase: "pty_written" });
  });

  it("holds even a queueing CLI when something was typed since its turn began", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), { agentState: "working", lastStateChange: Date.now() - 1_000 });
    terminal.write("half a thought");
    ptyWriteMock.mockClear();

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
    info(terminal).detectedAgentId = "gemini";
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
    // The body is still in the composer: a draft to every reader of the
    // settle, auto-sleep included (#13854), until the agent settles again.
    expect(info(terminal).lastTypedInputAt).toBeGreaterThanOrEqual(info(terminal).lastStateChange!);
    // Nobody's keys left it there, so no assistant may press keys over it.
    expect(info(terminal).lastForeignInputAt).toBe(info(terminal).lastTypedInputAt);
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

describe("TerminalProcess settled-prompt-exact guard, widened for a Decisions answer (#16282)", () => {
  const ANSWER: ExactPromptGuard = {
    kind: "settled-prompt-exact",
    acceptWorking: true,
    acceptQuestion: true,
  };

  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** `patch` the pane settled at its prompt, submit the answer, and say what became of it. */
  async function answerInto(patch: Partial<Internals["terminalInfo"]>, guard = ANSWER) {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), patch);
    terminal.submit("answer", "tok-1", undefined, guard);
    await vi.advanceTimersByTimeAsync(3_000);
    return { terminal, phase: terminal.getSubmission("tok-1")?.phase };
  }

  it.each([
    ["mid-turn, in a CLI that queues input", { agentState: "working" as const }],
    ["at a question asked in prose", { waitingReason: "question" as const }],
  ])("writes it %s", async (_label, patch) => {
    const { phase } = await answerInto(patch);
    expect(phase).toBe("pty_written");
    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["answer", "\r"]);
  });

  it.each([
    [
      "mid-turn, in a CLI that can't queue input",
      { agentState: "working" as const, detectedAgentId: "gemini" },
    ],
    ["at an approval", { waitingReason: "approval" as const }],
    ["at an error", { waitingReason: "error" as const }],
  ])("refuses it %s", async (_label, patch) => {
    const { phase } = await answerInto(patch);
    expect(phase).toBe("cancelled");
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it("takes a question only when main asked for it, and mid-turn only when main allowed it", async () => {
    const atQuestion = await answerInto(
      { waitingReason: "question" },
      { kind: "settled-prompt-exact", acceptWorking: true }
    );
    expect(atQuestion.phase).toBe("cancelled");
    const midTurn = await answerInto(
      { agentState: "working" },
      { kind: "settled-prompt-exact", acceptQuestion: true }
    );
    expect(midTurn.phase).toBe("cancelled");
  });

  it("refuses it over something typed into the line since the turn began", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), { agentState: "working", lastStateChange: Date.now() - 2_000 });
    terminal.write("half a thought");
    ptyWriteMock.mockClear();

    terminal.submit("answer", "tok-1", undefined, ANSWER);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it("treats a body a shutdown lock left in the composer as a draft", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), { agentState: "working", lastStateChange: Date.now() - 2_000 });
    terminal.submit("a person's prompt");
    await vi.advanceTimersByTimeAsync(0);
    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["a person's prompt"]);
    // The lock is taken while the body waits for its Enter, then let go.
    const release = (
      terminal as unknown as { inputController: { acquireShutdownInputLock(): () => void } }
    ).inputController.acquireShutdownInputLock();
    release();
    await vi.advanceTimersByTimeAsync(3_000);

    terminal.submit("answer", "tok-1", undefined, ANSWER);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["a person's prompt"]);
  });

  it("never holds a run that replaced the one a body was left with", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), { agentIncarnation: 0 });
    terminal.submit("a person's prompt");
    await vi.advanceTimersByTimeAsync(0);
    // A new run takes the pty and settles at its prompt before the Enter is due.
    await vi.advanceTimersByTimeAsync(5);
    Object.assign(info(terminal), { agentIncarnation: 1 });
    settleAtPrompt(terminal, Date.now());
    await vi.advanceTimersByTimeAsync(3_000);
    ptyWriteMock.mockClear();

    terminal.submit("answer", "tok-1", undefined, ANSWER);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
  });

  it("queues a second line behind a turn the lane already typed into", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), { agentState: "working", lastStateChange: Date.now() - 2_000 });

    terminal.submit("answer", "tok-1", undefined, ANSWER);
    terminal.submit("follow-up", "tok-2", undefined, ANSWER);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
    expect(terminal.getSubmission("tok-2")).toMatchObject({ phase: "pty_written" });
  });
});

describe("TerminalProcess settled-prompt-exact guard (#16015)", () => {
  const EXACT: ExactPromptGuard = { kind: "settled-prompt-exact" };

  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes an exact guarded submission to an agent settled at its own prompt", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);

    terminal.submit("answer", "tok-1", undefined, EXACT);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["answer", "\r"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
  });

  it.each([
    // Claude queues mid-turn input, which the ordinary guard accepts.
    ["working, in a CLI that queues input", { agentState: "working" }],
    ["at an approval", { waitingReason: "approval" }],
    ["at a question asked in prose", { waitingReason: "question" }],
    ["at an error", { waitingReason: "error" }],
  ])("refuses an exact guarded submission %s", async (_label, patch) => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), { lastStateChange: Date.now() - 1_000 }, patch);

    terminal.submit("answer", "tok-1", undefined, EXACT);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
  });

  it("refuses an exact guarded submission over something typed since the prompt settled", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    terminal.write("half a thought");
    ptyWriteMock.mockClear();

    terminal.submit("answer", "tok-1", undefined, EXACT);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
  });

  it("holds an exact guarded submission behind a line the lane wrote since the prompt settled", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);

    // The prompt's turn isn't observed yet when the answer reaches the lane.
    terminal.submit("a person's prompt");
    terminal.submit("answer", "tok-1", undefined, EXACT);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(ptyWriteMock.mock.calls.map((c) => c[0])).toEqual(["a person's prompt", "\r"]);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
  });

  /**
   * An answer for the run main read (incarnation 0, `session-1`), queued
   * behind a person's prompt; `meanwhile` changes the pane while it waits,
   * and that prompt's turn then ends with the agent settled at its prompt.
   */
  async function queuedAnswer(
    meanwhile: (t: Internals["terminalInfo"]) => void,
    guard: ExactPromptGuard = { ...EXACT, agentIncarnation: 0, agentSessionId: "session-1" },
    /** Null: the host doesn't know the session yet when the line arrives. */
    sessionAtSubmit: string | null = "session-1"
  ) {
    ptyWriteMock = vi.fn<(data: string) => void>();
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    Object.assign(info(terminal), {
      agentIncarnation: 0,
      agentSessionId: sessionAtSubmit ?? undefined,
    });
    terminal.submit("a person's prompt");
    terminal.submit("answer", "tok-1", undefined, guard);
    meanwhile(info(terminal));
    settleAtPrompt(terminal, Date.now() + 1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    return terminal.getSubmission("tok-1")?.phase;
  }

  it("types an answer for the run main read, and for that run once its session is learned", async () => {
    await expect(queuedAnswer(() => {})).resolves.toBe("pty_written");
    await expect(
      queuedAnswer(
        (t) => {
          expect(t.agentSessionId).toBeUndefined();
          t.agentSessionId = "session-1";
        },
        { ...EXACT, agentIncarnation: 0 },
        null
      )
    ).resolves.toBe("pty_written");
  });

  it.each([
    [
      "another agent incarnation",
      (t: Internals["terminalInfo"]) => {
        t.agentIncarnation = 1;
      },
    ],
    [
      "another known session",
      (t: Internals["terminalInfo"]) => {
        t.agentSessionId = "session-2";
      },
    ],
  ])("refuses an answer once the PTY holds %s", async (_label, meanwhile) => {
    await expect(queuedAnswer(meanwhile)).resolves.toBe("cancelled");
  });

  it("refuses an answer for a run the PTY no longer held when the line arrived", async () => {
    await expect(
      queuedAnswer(() => {}, { ...EXACT, agentIncarnation: 1, agentSessionId: "session-1" })
    ).resolves.toBe("cancelled");
  });

  it("types a multi-line Decisions answer as one bracketed paste and one Enter", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    const notice = batchNotices([
      formatAnswerNotice({
        kind: "answer",
        questionId: "0190f0aa11112222333344445555aaaa",
        alias: 3,
        revision: 1,
        source: "human",
        choices: [{ id: "approve", label: "Approve" }],
        comment: "Proceed.\nKeep the sidebar compact.\x1b[201~\nrm -rf ~",
        injectionId: "0190f0aa11112222333344445555bbbb",
      }),
    ])[0];
    const blocks = parseAnswerNotice(notice);
    expect(blocks).not.toBeNull();
    const section = renderDecisionSection(blocks!);

    terminal.submit(section, "tok-1", undefined, EXACT);
    await vi.advanceTimersByTimeAsync(3_000);

    const writes = ptyWriteMock.mock.calls.map((c) => c[0]);
    expect(writes).toEqual([`\x1b[200~${section.replace(/\n/g, "\r")}\x1b[201~`, "\r"]);
    // The answer's own terminator never made it into the text, so the paste ends once.
    expect(writes[0].split("\x1b[201~")).toHaveLength(2);
    expect(section.split("\n").length).toBeGreaterThan(8);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
  });

  it("types a Decisions follow-up as one bracketed paste and one Enter (#16231)", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    const notice = noticeChunk([
      formatFollowupNotice({
        questionId: "0190f0aa11112222333344445555aaaa",
        alias: 3,
        messageId: "0190f0aa11112222333344445555cccc",
        text: "Keep the old icons.\x1b[201~\nrm -rf ~",
        answered: true,
        injectionId: "0190f0aa11112222333344445555bbbb",
      }),
    ]);
    const blocks = parseDecisionNotice(notice);
    expect(blocks).not.toBeNull();
    const section = renderDecisionSection(blocks!);

    terminal.submit(section, "tok-1", undefined, EXACT);
    await vi.advanceTimersByTimeAsync(3_000);

    const writes = ptyWriteMock.mock.calls.map((c) => c[0]);
    expect(writes).toEqual([`\x1b[200~${section.replace(/\n/g, "\r")}\x1b[201~`, "\r"]);
    expect(writes[0].split("\x1b[201~")).toHaveLength(2);
    expect(section).toContain("[DAINTREE DECISION FOLLOW-UP]");
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
  });
});

describe("TerminalProcess no-choice-dialog guard (#16209)", () => {
  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const written = () => ptyWriteMock.mock.calls.map((call) => call[0]).join("");

  it("refuses a line while the agent is observed at a choice dialog, writing nothing", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);
    info(terminal).waitingReason = "approval";

    terminal.submit("lost words", "tok-1", undefined, "no-choice-dialog");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "cancelled" });
    expect(written()).not.toContain("lost words");
  });

  it("refuses a queued line when a choice dialog is observed before it reaches the lane", async () => {
    const terminal = createTerminal();
    settleAtPrompt(terminal, Date.now() - 5_000);

    terminal.submit("first", "tok-1");
    terminal.submit("second", "tok-2", undefined, "no-choice-dialog");
    // Observed while the first line still holds the lane.
    info(terminal).agentState = "waiting";
    info(terminal).waitingReason = "approval";
    await vi.advanceTimersByTimeAsync(3_000);

    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
    expect(terminal.getSubmission("tok-2")).toMatchObject({ phase: "cancelled" });
    expect(written()).toContain("first");
    expect(written()).not.toContain("second");
  });

  it("sends as an unguarded line anywhere else, as someone's prompt", async () => {
    const terminal = createTerminal();
    const t = info(terminal);
    settleAtPrompt(terminal, Date.now() - 5_000);
    // A draft at the prompt doesn't hold it: this guard refuses dialogs only.
    t.lastTypedInputAt = Date.now();

    terminal.submit("at prompt", "tok-1", undefined, "no-choice-dialog");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(terminal.getSubmission("tok-1")).toMatchObject({ phase: "pty_written" });
    expect(t.lastForeignPromptInputAt).toBeDefined();

    t.agentState = "working";
    t.waitingReason = undefined;
    terminal.submit("mid-turn", "tok-2", undefined, "no-choice-dialog");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(terminal.getSubmission("tok-2")).toMatchObject({ phase: "pty_written" });

    // A shell keeps taking sends, whatever reason an earlier agent left behind.
    t.detectedAgentId = undefined;
    t.agentState = "waiting";
    t.waitingReason = "approval";
    terminal.submit("ls", "tok-3", undefined, "no-choice-dialog");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(terminal.getSubmission("tok-3")).toMatchObject({ phase: "pty_written" });
  });
});
