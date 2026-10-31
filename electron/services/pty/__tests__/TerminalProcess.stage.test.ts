import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { getSoftNewlineSequence } from "../terminalInput.js";

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
    agentIncarnation: number;
    isExited?: boolean;
    lastOutputTime: number;
  };
}

function createAgentTerminal(agentId: string): TerminalProcess {
  const terminal = new TerminalProcess(
    "t-stage",
    { cwd: process.cwd(), cols: 80, rows: 24, kind: "terminal", launchAgentId: agentId },
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: { handleActivityState: () => {} } as never,
      ptyPool: null,
      processTreeCache: null,
    },
    SPAWN_CONTEXT,
    createMockPty()
  );
  info(terminal).detectedAgentId = agentId;
  return terminal;
}

function info(terminal: TerminalProcess): Internals["terminalInfo"] {
  return (terminal as unknown as Internals).terminalInfo;
}

function writes(): string[] {
  return ptyWriteMock.mock.calls.map((call) => call[0]);
}

const DRAFT = "DRAFT-DO-NOT-SEND";

describe("TerminalProcess.stage and the submit lane (#15554)", () => {
  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes straight away when no submission owns the composer", () => {
    const terminal = createAgentTerminal("claude");

    terminal.stage(DRAFT);

    expect(writes()).toEqual([DRAFT]);
  });

  it("waits out an ordinary submission's Enter delay instead of joining its line", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit("first prompt");
    expect(writes()).toEqual(["first prompt"]);

    terminal.stage(DRAFT);
    expect(writes()).toEqual(["first prompt"]);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(writes()).toEqual(["first prompt", "\r", DRAFT]);
  });

  it("waits out an output-settle Enter wait on an agent without bracketed paste", async () => {
    const terminal = createAgentTerminal("gemini");

    terminal.submit("first prompt");
    terminal.stage(DRAFT);
    // Output that keeps arriving holds the Enter back for the settle window's
    // full length; the draft has to wait all of it out.
    for (let elapsed = 0; elapsed < 1_500; elapsed += 100) {
      info(terminal).lastOutputTime = Date.now();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(writes()).toEqual(["first prompt"]);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(writes()).toEqual(["first prompt", "\r", DRAFT]);
  });

  it("keeps its place behind submissions already queued, and ahead of later ones", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit("first");
    terminal.submit("second");
    terminal.stage(DRAFT);
    terminal.submit("third");

    await vi.advanceTimersByTimeAsync(5_000);

    const stream = writes();
    expect(stream.slice(0, 5)).toEqual(["first", "\r", "second", "\r", DRAFT]);
    // The draft is never followed by an Enter of its own: the next write is the
    // later submission's body, which the lane writes after it, as it would after
    // anything the user had typed.
    expect(stream[5]).toBe("third");
  });

  it("is dropped when a shutdown lock takes the input while it waits", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit("first prompt");
    terminal.stage(DRAFT);
    const inputController = (
      terminal as unknown as {
        inputController: { acquireShutdownInputLock: () => () => void };
      }
    ).inputController;
    // Released before the in-flight submission has even unwound: the draft
    // was accepted before the lock and must not outlive it.
    inputController.acquireShutdownInputLock()();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(writes()).toEqual(["first prompt"]);
  });

  it("is dropped when pending input is cancelled while it waits, unlike one staged after", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit("first prompt");
    terminal.stage(DRAFT);
    terminal.cancelPendingInput();
    terminal.stage("NEW-OWNER-DRAFT");

    await vi.advanceTimersByTimeAsync(3_000);

    expect(writes()).not.toContain(DRAFT);
    expect(writes()).toContain("NEW-OWNER-DRAFT");
  });

  it("is dropped when the agent it was meant for is relaunched while it waits", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit("first prompt");
    terminal.stage(DRAFT);
    info(terminal).agentIncarnation += 1;

    await vi.advanceTimersByTimeAsync(3_000);

    expect(writes()).not.toContain(DRAFT);
  });

  it("is dropped when the agent it was meant for exits to its shell while it waits", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit("first prompt");
    terminal.stage(DRAFT);
    info(terminal).detectedAgentId = undefined;

    await vi.advanceTimersByTimeAsync(3_000);

    expect(writes()).not.toContain(DRAFT);
  });

  it("still reaches an agent whose detection lands while the draft waits", async () => {
    const terminal = createAgentTerminal("claude");
    info(terminal).detectedAgentId = undefined;

    terminal.submit("first prompt");
    terminal.stage(DRAFT);
    info(terminal).detectedAgentId = "claude";

    await vi.advanceTimersByTimeAsync(3_000);

    expect(writes()).toEqual(["first prompt", "\r", DRAFT]);
  });

  it("keeps a deferred multi-line draft inside one bracketed paste with no Enter after it", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit("first prompt");
    terminal.stage("line one\nline two\n\n");

    await vi.advanceTimersByTimeAsync(3_000);

    expect(writes()).toEqual(["first prompt", "\r", "\x1b[200~line one\rline two\x1b[201~"]);
  });

  it("writes a deferred multi-line draft with soft newlines where pastes are not supported", async () => {
    const terminal = createAgentTerminal("gemini");

    terminal.submit("first prompt");
    terminal.stage("line one\nline two");

    await vi.advanceTimersByTimeAsync(5_000);

    const softNewline = getSoftNewlineSequence(info(terminal) as never);
    expect(softNewline).not.toBe("\r");
    expect(writes()).toEqual(["first prompt", "\r", `line one${softNewline}line two`]);
  });

  it("is dropped when the pty exits while it waits", async () => {
    const terminal = createAgentTerminal("claude");

    terminal.submit("first prompt");
    terminal.stage(DRAFT);
    info(terminal).isExited = true;

    await vi.advanceTimersByTimeAsync(3_000);

    expect(writes()).not.toContain(DRAFT);
  });

  it("still reads as typed text to a guarded submission queued behind it", async () => {
    const terminal = createAgentTerminal("claude");
    const t = info(terminal);
    t.agentState = "waiting";
    t.waitingReason = "prompt";
    t.lastStateChange = Date.now() - 5_000;

    terminal.submit("first prompt");
    terminal.stage(DRAFT);
    terminal.submit("wake", "tok-guarded", undefined, "settled-prompt");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(writes()).toEqual(["first prompt", "\r", DRAFT]);
    expect(t.lastTypedInputAt).toBeDefined();
    expect(terminal.getSubmission("tok-guarded")).toMatchObject({ phase: "cancelled" });
  });

  it("lets an in-flight guarded submission finish before the draft is written", async () => {
    const terminal = createAgentTerminal("claude");
    const t = info(terminal);
    t.agentState = "waiting";
    t.waitingReason = "prompt";
    t.lastStateChange = Date.now() - 5_000;

    terminal.submit("wake", "tok-guarded", undefined, "settled-prompt");
    expect(writes()).toEqual(["wake"]);
    terminal.stage(DRAFT);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(writes()).toEqual(["wake", "\r", DRAFT]);
    expect(terminal.getSubmission("tok-guarded")).toMatchObject({ phase: "pty_written" });
  });
});
