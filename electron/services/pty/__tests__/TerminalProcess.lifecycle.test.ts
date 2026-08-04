import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { events } from "../../events.js";
import { AGENT_OUTPUT_ACTIVITY_LINE_COUNT } from "../AgentActivityTemperature.js";
import { measureVisibleContentDelta } from "../SustainedChangeTracker.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

vi.mock("../terminalSessionPersistence.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    TERMINAL_SESSION_PERSISTENCE_ENABLED: false,
    persistSessionSnapshotSync: vi.fn(),
    persistSessionSnapshotAsync: vi.fn(),
  };
});

type DataCb = (data: string) => void;
type ExitCb = (e: { exitCode: number; signal?: number }) => void;

function createControllablePty(): IPty & {
  emitData: (d: string) => void;
  emitExit: (code: number, signal?: number) => void;
  destroy: ReturnType<typeof vi.fn>;
} {
  let dataCb: DataCb | null = null;
  let exitCb: ExitCb | null = null;

  const pty: Partial<IPty> & {
    emitData: (d: string) => void;
    emitExit: (code: number, signal?: number) => void;
    destroy: ReturnType<typeof vi.fn>;
  } = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    // destroy() releases the master PTY fd; absent from the IPty type so it is
    // accessed structurally by destroyPty() (#9539).
    destroy: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: (cb: (data: string) => void) => {
      dataCb = cb;
      return { dispose: () => {} };
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitCb = cb;
      return { dispose: () => {} };
    },
    emitData: (d: string) => {
      dataCb?.(d);
    },
    emitExit: (code: number, signal?: number) => {
      exitCb?.({ exitCode: code, signal });
    },
  };
  return pty as IPty & {
    emitData: (d: string) => void;
    emitExit: (c: number, s?: number) => void;
    destroy: ReturnType<typeof vi.fn>;
  };
}

async function emitDataAndFlush(
  pty: ReturnType<typeof createControllablePty>,
  data: string
): Promise<void> {
  pty.emitData(data);
  await vi.advanceTimersByTimeAsync(0);
}

function defaultSpawnContext(): SpawnContext {
  return {
    shell: "/bin/zsh",
    args: ["-l"],
    env: {},
  };
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

function createTerminal(
  pty: IPty,
  options?: Partial<TerminalProcessOptions>,
  deps?: Partial<TerminalProcessDeps>,
  id = "t-lifecycle"
): TerminalProcess {
  const merged = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal" as const,
    ...options,
  };
  return new TerminalProcess(
    id,
    merged,
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
        emitAgentCompleted: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: null,
      ...deps,
    },
    defaultSpawnContext(),
    pty
  );
}

type TerminalExitedPayload = Parameters<Parameters<typeof events.on<"terminal:exited">>[1]>[0];

describe("TerminalProcess — terminal:exited event", () => {
  let exitedListener: ReturnType<typeof vi.fn<(p: TerminalExitedPayload) => void>>;
  let unsubscribe: () => void;

  beforeEach(() => {
    exitedListener = vi.fn<(p: TerminalExitedPayload) => void>();
    unsubscribe = events.on("terminal:exited", exitedListener);
  });

  afterEach(() => {
    unsubscribe();
  });

  it("emits exactly once on natural exit with reason 'natural'", () => {
    const pty = createControllablePty();
    createTerminal(pty);

    pty.emitExit(0);

    const calls = exitedListener.mock.calls.filter(
      (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-lifecycle"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      terminalId: "t-lifecycle",
      code: 0,
      reason: "natural",
    });
  });

  it("captures recentOutput before headless dispose", () => {
    const pty = createControllablePty();
    createTerminal(pty);

    pty.emitData("connection refused\n");
    pty.emitExit(1);

    const call = exitedListener.mock.calls.find(
      (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-lifecycle"
    );
    expect(call).toBeDefined();
    const payload = call![0] as { recentOutput: string };
    expect(payload.recentOutput).toContain("connection refused");
  });

  it("uses reason='kill' when kill() runs before the natural PTY exit", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty, {
      kind: "terminal",
      launchAgentId: "claude",
    });

    terminal.kill("user requested");
    pty.emitExit(0);

    const calls = exitedListener.mock.calls.filter(
      (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-lifecycle"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      terminalId: "t-lifecycle",
      reason: "kill",
    });
  });

  it("emits with reason='dispose' and code=null when dispose() fires before any exit", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty);

    terminal.dispose();

    const calls = exitedListener.mock.calls.filter(
      (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-lifecycle"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      terminalId: "t-lifecycle",
      code: null,
      reason: "dispose",
    });
  });

  it("does not double-emit when natural exit fires after dispose()", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty);

    terminal.dispose();
    pty.emitExit(0);

    const calls = exitedListener.mock.calls.filter(
      (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-lifecycle"
    );
    expect(calls).toHaveLength(1);
  });
});

describe("TerminalProcess — master fd release (#9539)", () => {
  it("calls destroy() to release the master fd on dispose()", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty);

    terminal.dispose();

    expect(pty.destroy).toHaveBeenCalledTimes(1);
  });

  it("calls destroy() exactly once when kill() precedes the natural exit", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty);

    terminal.kill("user requested");
    pty.emitExit(0);

    expect(pty.destroy).toHaveBeenCalledTimes(1);
  });

  it("calls destroy() exactly once when natural exit fires after dispose()", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty);

    terminal.dispose();
    pty.emitExit(0);

    expect(pty.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalProcess — observer-driven exit handlers", () => {
  it("samples only the visible tail for fallback output recovery without a monitor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const terminal = createTerminal(pty, { kind: "terminal", launchAgentId: "claude" });

    try {
      terminal.stopActivityMonitor();
      terminal.getInfo().agentState = "waiting";
      const getVisibleActivitySnapshot = vi.spyOn(terminal, "getVisibleActivitySnapshot");

      await emitDataAndFlush(pty, "waiting");

      expect(getVisibleActivitySnapshot).toHaveBeenCalledWith(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("does not recover a waiting live agent on unchanged redraw output without a monitor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const handleActivityState = vi.fn();
    const terminal = createTerminal(
      pty,
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState,
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: () => {},
        } as unknown as TerminalProcessDeps["agentStateService"],
      },
      "t-output-recovery"
    );

    try {
      terminal.stopActivityMonitor();
      terminal.getInfo().agentState = "waiting";

      await emitDataAndFlush(pty, "waiting");
      vi.advanceTimersByTime(1300);
      handleActivityState.mockClear();

      await emitDataAndFlush(pty, "\rwaiting");
      vi.advanceTimersByTime(500);
      await emitDataAndFlush(pty, "\rwaiting");
      vi.advanceTimersByTime(600);
      await emitDataAndFlush(pty, "\rwaiting");

      expect(handleActivityState).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("does not recover a waiting live agent when repeated separator width changes without a monitor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const handleActivityState = vi.fn();
    const terminal = createTerminal(
      pty,
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState,
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: () => {},
        } as unknown as TerminalProcessDeps["agentStateService"],
      },
      "t-output-separator-resize"
    );

    try {
      terminal.stopActivityMonitor();
      terminal.getInfo().agentState = "waiting";

      await emitDataAndFlush(pty, "-----");
      vi.advanceTimersByTime(1300);
      handleActivityState.mockClear();

      for (const length of [10, 20, 40, 60]) {
        await emitDataAndFlush(pty, `\r${"-".repeat(length)}`);
        vi.advanceTimersByTime(700);
      }

      expect(handleActivityState).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps the visible activity snapshot stable across wrap-only viewport changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const terminal = createTerminal(
      pty,
      { cols: 90, rows: 24, kind: "terminal", launchAgentId: "claude" },
      undefined,
      "t-output-wrap-stable"
    );

    try {
      terminal.stopActivityMonitor();
      terminal.getInfo().agentState = "waiting";

      await emitDataAndFlush(
        pty,
        [
          "Bash(gh issue view 6951 --json title,labels,url --jq '.')",
          "Issue created",
          "URL: https://github.com/daintreehq/daintree/issues/6951",
          "Type: Bug",
          "Title: + New session button leaves stray terminal in dock",
          "Captures the regression in fcbb3f765 closing #6948, plus the race window between addPanel resolving and setTerminal(newId) firing where the dock has no helpTerminalId to filter against. Labelled bug + ui.",
          "* Cogitated for 3m 1s",
          "* recap: Filed issue #6951 capturing the + New session dock regression from #6948 - the + button uses a different panel-creation path than the original launch and races the dock filter. Next: hand it to /work when ready.",
          "/exit",
          "Catch you later!",
          "/exit",
          "See ya!",
          "/exit",
          "Goodbye!",
          'Try "create a util logging.py that..."',
          "bypass permissions on (shift+tab to cycle)",
        ].join("\r\n")
      );

      const before = terminal.getVisibleActivitySnapshot(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);
      terminal.resize(140, 24);
      const after = terminal.getVisibleActivitySnapshot(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);

      expect(after).toBeDefined();
      expect(measureVisibleContentDelta(before, after!)).toEqual({
        changed: false,
        changedChars: 0,
      });
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("treats viewport height changes as prefix-only activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const mutablePtyDimensions = pty as unknown as { cols: number; rows: number };
    mutablePtyDimensions.cols = 90;
    mutablePtyDimensions.rows = 18;
    const terminal = createTerminal(
      pty,
      { cols: 90, rows: 18, kind: "terminal", launchAgentId: "claude" },
      undefined,
      "t-output-height-stable"
    );

    try {
      terminal.stopActivityMonitor();
      terminal.getInfo().agentState = "waiting";

      await emitDataAndFlush(
        pty,
        Array.from({ length: 26 }, (_, index) => `historical line ${index + 1}`)
          .concat([
            "/exit",
            "See ya!",
            "/exit",
            "Goodbye!",
            'Try "create a util logging.py that..."',
          ])
          .join("\r\n")
      );

      const before = terminal.getVisibleActivitySnapshot(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);
      terminal.resize(90, 24);
      const after = terminal.getVisibleActivitySnapshot(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);

      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(measureVisibleContentDelta(before, after!)).toEqual({
        changed: false,
        changedChars: 0,
      });
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("samples activity lines through the viewport bottom instead of stopping at the cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const terminal = createTerminal(
      pty,
      { cols: 80, rows: 10, kind: "terminal", launchAgentId: "claude" },
      undefined,
      "t-output-after-cursor"
    );

    try {
      terminal.stopActivityMonitor();

      await emitDataAndFlush(pty, "above\r\nmiddle\r\nbelow-cursor\x1b[2A");

      expect(terminal.getVisibleActivityLines(10)).toContain("below-cursor");
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("returns the last non-empty visible lines when the prompt sits above blank viewport rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const terminal = createTerminal(
      pty,
      { cols: 80, rows: 10, kind: "terminal", launchAgentId: "claude" },
      undefined,
      "t-visible-tail-non-empty"
    );

    try {
      terminal.stopActivityMonitor();

      await emitDataAndFlush(
        pty,
        [
          "Quick safety check: Is this a project you created or one you trust?",
          "FAKE_CLAUDE_READY",
          "__DAINTREE_FAKE_CLAUDE_STOP__",
          "FAKE_CLAUDE_EXIT",
          "PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project>",
        ].join("\r\n")
      );

      expect(terminal.getLastNLines(4)).toEqual([
        "FAKE_CLAUDE_READY",
        "__DAINTREE_FAKE_CLAUDE_STOP__",
        "FAKE_CLAUDE_EXIT",
        "PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project>",
      ]);
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("detects spinner activity above a pinned bottom input box (regression: cursor-anchored scan window)", async () => {
    // Regression for the v0.19.0 detection break: getVisibleActivityCells was
    // narrowed to a cursor-anchored bottom-15-row window. A TUI agent that
    // animates its spinner/status line ABOVE a pinned bottom input box then
    // produced changedChars=0, so a genuinely-working agent decayed to
    // "waiting" during long low-output thinking. The cell scan must cover the
    // full viewport.
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const mutablePtyDimensions = pty as unknown as { cols: number; rows: number };
    mutablePtyDimensions.cols = 100;
    mutablePtyDimensions.rows = 30;
    const terminal = createTerminal(
      pty,
      { cols: 100, rows: 30, kind: "terminal", launchAgentId: "claude" },
      undefined,
      "t-spinner-above-input"
    );

    try {
      terminal.stopActivityMonitor();
      terminal.getInfo().agentState = "working";

      // Spinner on the top row, body filling the middle, input box at the
      // bottom. The cursor lands in the input box (row ~27 of 30) after this
      // write, so a bottom-15 window would start at row 15 — above which the
      // spinner is invisible.
      await emitDataAndFlush(
        pty,
        [
          "✻ Thinking (0s · esc to interrupt)",
          ...Array.from({ length: 26 }, (_, i) => `body line ${i + 1}`),
          "> ",
        ].join("\r\n")
      );

      const before = terminal.getVisibleActivitySnapshot(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);

      // Animate ONLY the top spinner line, restoring the cursor to the input
      // box (DECSC/DECRC) — exactly how the agent re-renders during thinking.
      await emitDataAndFlush(pty, "\x1b7\x1b[1;1H✻ Thinking (3s · esc to interrupt)\x1b8");

      const after = terminal.getVisibleActivitySnapshot(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);

      expect(before).toBeDefined();
      expect(after).toBeDefined();
      const delta = measureVisibleContentDelta(before, after!);
      expect(delta.changed).toBe(true);
      expect(delta.changedChars).toBeGreaterThan(0);
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("recovers a waiting live agent to working on sustained PTY content changes without a monitor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const handleActivityState = vi.fn();
    const terminal = createTerminal(
      pty,
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState,
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: () => {},
        } as unknown as TerminalProcessDeps["agentStateService"],
      },
      "t-output-recovery"
    );

    try {
      terminal.stopActivityMonitor();
      terminal.getInfo().agentState = "waiting";

      await emitDataAndFlush(pty, "waiting");
      vi.advanceTimersByTime(1300);
      handleActivityState.mockClear();

      await emitDataAndFlush(pty, "\rworking 1");
      expect(handleActivityState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(700);
      await emitDataAndFlush(pty, "\rworking 2");
      expect(handleActivityState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(700);
      await emitDataAndFlush(pty, "\rworking 3");
      expect(handleActivityState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(700);
      await emitDataAndFlush(pty, "\rworking 4");

      expect(handleActivityState).toHaveBeenCalledWith(terminal.getInfo(), "busy", {
        trigger: "output",
      });
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("recovers a waiting live agent to working on sustained color-only changes without a monitor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const handleActivityState = vi.fn();
    const terminal = createTerminal(
      pty,
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState,
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: () => {},
        } as unknown as TerminalProcessDeps["agentStateService"],
      },
      "t-output-color-recovery"
    );

    try {
      terminal.stopActivityMonitor();
      terminal.getInfo().agentState = "waiting";

      await emitDataAndFlush(pty, "\x1b[31mloading\x1b[0m");
      vi.advanceTimersByTime(1300);
      handleActivityState.mockClear();

      await emitDataAndFlush(pty, "\r\x1b[32mloading\x1b[0m");
      expect(handleActivityState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(700);
      await emitDataAndFlush(pty, "\r\x1b[33mloading\x1b[0m");
      expect(handleActivityState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(700);
      await emitDataAndFlush(pty, "\r\x1b[34mloading\x1b[0m");
      expect(handleActivityState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(700);
      await emitDataAndFlush(pty, "\r\x1b[35mloading\x1b[0m");

      expect(handleActivityState).toHaveBeenCalledWith(terminal.getInfo(), "busy", {
        trigger: "output",
      });
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("does not carry output-recovery heat across a resize without a monitor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const handleActivityState = vi.fn();
    const terminal = createTerminal(
      pty,
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState,
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: () => {},
        } as unknown as TerminalProcessDeps["agentStateService"],
      },
      "t-output-resize"
    );

    try {
      terminal.stopActivityMonitor();
      terminal.getInfo().agentState = "waiting";

      await emitDataAndFlush(pty, "waiting");
      vi.advanceTimersByTime(1300);
      handleActivityState.mockClear();

      await emitDataAndFlush(pty, "\rworking 1");
      vi.advanceTimersByTime(700);
      await emitDataAndFlush(pty, "\rworking 2");
      expect(handleActivityState).not.toHaveBeenCalled();

      terminal.resize(40, 24);

      vi.advanceTimersByTime(700);
      await emitDataAndFlush(pty, "\rworking 3");
      vi.advanceTimersByTime(700);
      await emitDataAndFlush(pty, "\rworking 4");
      vi.advanceTimersByTime(700);
      await emitDataAndFlush(pty, "\rworking 5");

      expect(handleActivityState).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("fires fallback classifier on natural agent exit with connection error tail", () => {
    const pty = createControllablePty();
    const fallbackListener = vi.fn();
    const off = events.on("agent:fallback-triggered", fallbackListener);

    try {
      createTerminal(
        pty,
        {
          kind: "terminal",
          launchAgentId: "claude",
          agentPresetId: "claude-default",
          originalAgentPresetId: "claude-default",
        },
        undefined,
        "t-fallback"
      );

      pty.emitData("API Error: 503 Service Unavailable\n");
      pty.emitExit(1);

      const calls = fallbackListener.mock.calls.filter(
        (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-fallback"
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toMatchObject({
        terminalId: "t-fallback",
        agentId: "claude",
        fromPresetId: "claude-default",
        reason: "connection",
      });
    } finally {
      off();
    }
  });

  it("does NOT fire fallback when terminal was killed before exit", () => {
    const pty = createControllablePty();
    const fallbackListener = vi.fn();
    const off = events.on("agent:fallback-triggered", fallbackListener);

    try {
      const terminal = createTerminal(
        pty,
        {
          kind: "terminal",
          launchAgentId: "claude",
          agentPresetId: "claude-default",
        },
        undefined,
        "t-killed"
      );

      pty.emitData("API Error: 503 Service Unavailable\n");
      terminal.kill("user");
      pty.emitExit(1);

      const calls = fallbackListener.mock.calls.filter(
        (c: unknown[]) => (c[0] as { terminalId: string }).terminalId === "t-killed"
      );
      expect(calls).toHaveLength(0);
    } finally {
      off();
    }
  });

  it("emits agent:completed only on natural exit, not on kill→onExit", () => {
    const pty = createControllablePty();
    const emitAgentCompletedSpy = vi.fn();

    const terminal = createTerminal(
      pty,
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: emitAgentCompletedSpy,
        } as never,
      },
      "t-completed"
    );

    terminal.kill("user");
    pty.emitExit(0);

    expect(emitAgentCompletedSpy).not.toHaveBeenCalled();
  });

  // PtyManager.spawn(id) kills the existing terminal and respawns under
  // the same id. The new instance's `terminal:exited` listener must NOT
  // be consumed by the old PTY's eventual exit — that would silence its
  // own real exit later.
  it("filters terminal:exited by spawnedAt to survive id reuse during respawn", () => {
    const pty1 = createControllablePty();
    const emitAgentCompletedSpy1 = vi.fn();
    const t1 = createTerminal(
      pty1,
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: emitAgentCompletedSpy1,
        } as never,
      },
      "t-shared-id"
    );
    t1.kill("respawn");

    // Wait one millisecond so the second terminal's spawnedAt token
    // differs from the first.
    const start = Date.now();
    while (Date.now() === start) {
      /* spin briefly */
    }

    const pty2 = createControllablePty();
    const emitAgentCompletedSpy2 = vi.fn();
    createTerminal(
      pty2,
      { kind: "terminal", launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: emitAgentCompletedSpy2,
        } as never,
      },
      "t-shared-id"
    );

    // Old PTY fires its long-delayed exit. Subscriber for t1 may run; the
    // subscriber for t2 must NOT (it was killed, so reason !== natural,
    // but the critical case is that t2's listener is also still wired
    // and would otherwise match terminalId).
    pty1.emitExit(0);

    // Now t2 exits naturally — its own subscriber must still be wired.
    pty2.emitExit(0);

    // t1 was killed, no agent:completed expected for it.
    expect(emitAgentCompletedSpy1).not.toHaveBeenCalled();
    // t2 exited naturally; its subscriber must have fired.
    expect(emitAgentCompletedSpy2).toHaveBeenCalledTimes(1);
  });

  it("does not double-fire callbacks.onExit when natural exit follows dispose()", () => {
    const pty = createControllablePty();
    const onExitSpy = vi.fn();

    const terminal = new TerminalProcess(
      "t-late-exit",
      { cwd: process.cwd(), cols: 80, rows: 24, kind: "terminal" },
      { emitData: () => {}, onExit: onExitSpy },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: () => {},
        } as unknown as TerminalProcessDeps["agentStateService"],
        ptyPool: null,
        processTreeCache: null,
      },
      defaultSpawnContext(),
      pty
    );

    terminal.dispose();
    pty.emitExit(0);

    expect(onExitSpy).not.toHaveBeenCalled();
  });
});

describe("TerminalProcess — plain-terminal snapshot gate (#7004)", () => {
  it("does not capture a visible-cell snapshot on PTY data for plain terminals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const terminal = createTerminal(pty, { kind: "terminal" }, undefined, "t-plain-no-snapshot");

    try {
      const getVisibleActivitySnapshot = vi.spyOn(terminal, "getVisibleActivitySnapshot");

      await emitDataAndFlush(pty, "build watcher: 12 files compiled\n");
      await emitDataAndFlush(pty, "[hmr] update applied\n");

      expect(getVisibleActivitySnapshot).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("does not transition agent state on the warm-up tick after plain→agent-live promotion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const handleActivityState = vi.fn();
    const terminal = createTerminal(
      pty,
      { kind: "terminal" },
      {
        agentStateService: {
          handleActivityState,
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          emitAgentCompleted: () => {},
        } as unknown as TerminalProcessDeps["agentStateService"],
      },
      "t-promotion-warmup"
    );

    try {
      terminal.stopActivityMonitor();

      // Promote a plain terminal to agent-live (mirrors TerminalAgentDetection
      // setting detectedAgentId mid-session). agentState seeds to "idle" on
      // detection, which is one of the states noteAgentOutputActivity acts on.
      const info = terminal.getInfo();
      info.detectedAgentId = "claude";
      info.agentState = "idle";

      // First live tick — isAgentLive is now true so beforeContentSnapshot IS
      // captured, but agentOutputContentSnapshot is still undefined (never set
      // while plain). hadFallbackBaseline is false at L1382, so the warm-up
      // path fires observeDelta({changedChars: 0}) and returns without
      // promoting the agent to "busy".
      await expect(emitDataAndFlush(pty, "claude > thinking…\n")).resolves.not.toThrow();

      expect(handleActivityState).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("still captures a visible-cell snapshot on PTY data for active launch-agent terminals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pty = createControllablePty();
    const terminal = createTerminal(
      pty,
      { kind: "terminal", launchAgentId: "claude" },
      undefined,
      "t-launch-agent-still-scans"
    );

    try {
      terminal.stopActivityMonitor();
      terminal.getInfo().agentState = "idle";
      const getVisibleActivitySnapshot = vi.spyOn(terminal, "getVisibleActivitySnapshot");

      await emitDataAndFlush(pty, "claude > working…\n");

      expect(getVisibleActivitySnapshot).toHaveBeenCalled();
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });
});

describe("TerminalProcess — getPublicState lifecycle derivation", () => {
  it("reflects hasPty=false after dispose() even without prior kill", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty);

    expect(terminal.getPublicState().hasPty).toBe(true);

    terminal.dispose();

    const state = terminal.getPublicState();
    expect(state.hasPty).toBe(false);
    expect(state.wasKilled).toBe(true);
  });

  it("reflects hasPty=false after natural exit (preserved agent terminal)", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty, { kind: "terminal", launchAgentId: "claude" });

    pty.emitExit(0);

    const state = terminal.getPublicState();
    expect(state.hasPty).toBe(false);
    expect(state.isExited).toBe(true);
    expect(state.exitCode).toBe(0);
  });
});

describe("TerminalProcess — agent startup instrumentation (Issue #7616)", () => {
  it("leaves firstByteAt and bootCompleteAt undefined before any data arrives", () => {
    const pty = createControllablePty();
    const terminal = createTerminal(pty);

    const state = terminal.getPublicState();
    expect(state.firstByteAt).toBeUndefined();
    expect(state.bootCompleteAt).toBeUndefined();
    terminal.dispose();
  });

  it("captures firstByteAt on the first data event and does not overwrite it on subsequent data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const pty = createControllablePty();
    const terminal = createTerminal(pty);

    try {
      await emitDataAndFlush(pty, "first");
      const initial = terminal.getPublicState().firstByteAt;
      expect(initial).toBe(2000);

      vi.setSystemTime(2500);
      await emitDataAndFlush(pty, "second");
      expect(terminal.getPublicState().firstByteAt).toBe(initial);
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("emits a single [AgentStartup] log line keyed on (agentId, cwdHash) for agent terminals", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const pty = createControllablePty();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const terminal = createTerminal(pty, {
      kind: "terminal",
      launchAgentId: "claude",
      cwd: "/repo/agent",
    });

    try {
      // Drive ActivityMonitor's onData path to surface the boot-complete callback.
      terminal.getInfo().firstByteAt = 5050;
      terminal.getInfo().bootCompleteAt = undefined;
      // Invoke recordBootComplete via the public path: simulate boot at 5100ms.
      // We expose this by reading through getPublicState after manually firing.
      // (We bypass ActivityMonitor here because the production wiring is
      // covered by ActivityMonitor.test.ts; this test asserts the log shape.)
      const recordBootComplete = (
        terminal as unknown as { recordBootComplete: (ts: number) => void }
      ).recordBootComplete.bind(terminal);
      recordBootComplete(5100);

      const startupLogs = consoleLog.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((line) => line.startsWith("[AgentStartup] "));
      expect(startupLogs).toHaveLength(1);

      const json = JSON.parse(startupLogs[0]!.replace(/^\[AgentStartup\] /, ""));
      expect(json).toMatchObject({
        agentId: "claude",
        terminalId: expect.any(String),
        spawnedAt: expect.any(Number),
        firstByteAt: 5050,
        bootCompleteAt: 5100,
        bootDurationMs: expect.any(Number),
        timeToFirstByteMs: expect.any(Number),
      });
      // 8-char md5 hex slice
      expect(typeof json.cwdHash).toBe("string");
      expect(json.cwdHash).toMatch(/^[0-9a-f]{8}$/);

      const state = terminal.getPublicState();
      expect(state.bootCompleteAt).toBe(5100);
    } finally {
      consoleLog.mockRestore();
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("does not emit [AgentStartup] for plain terminals without a launch hint", () => {
    const pty = createControllablePty();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const terminal = createTerminal(pty);

    try {
      const recordBootComplete = (
        terminal as unknown as { recordBootComplete: (ts: number) => void }
      ).recordBootComplete.bind(terminal);
      recordBootComplete(Date.now());

      const startupLogs = consoleLog.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((line) => line.startsWith("[AgentStartup] "));
      expect(startupLogs).toHaveLength(0);
    } finally {
      consoleLog.mockRestore();
      terminal.dispose();
    }
  });

  it("emits the [AgentStartup] log only on the first recordBootComplete call (idempotency)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(7000);
    const pty = createControllablePty();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const terminal = createTerminal(pty, {
      kind: "terminal",
      launchAgentId: "claude",
    });

    try {
      const recordBootComplete = (
        terminal as unknown as { recordBootComplete: (ts: number) => void }
      ).recordBootComplete.bind(terminal);

      recordBootComplete(7100);
      recordBootComplete(7200);
      recordBootComplete(7300);

      const startupLogs = consoleLog.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((line) => line.startsWith("[AgentStartup] "));
      expect(startupLogs).toHaveLength(1);
      // The first timestamp wins; later calls do not mutate or re-emit.
      expect(terminal.getPublicState().bootCompleteAt).toBe(7100);
    } finally {
      consoleLog.mockRestore();
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("omits firstByteAt/timeToFirstByteMs from the log when no data was observed before boot completes", () => {
    const pty = createControllablePty();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const terminal = createTerminal(pty, {
      kind: "terminal",
      launchAgentId: "codex",
    });

    try {
      const recordBootComplete = (
        terminal as unknown as { recordBootComplete: (ts: number) => void }
      ).recordBootComplete.bind(terminal);
      recordBootComplete(Date.now());

      const line = consoleLog.mock.calls
        .map((c) => String(c[0] ?? ""))
        .find((l) => l.startsWith("[AgentStartup] "));
      expect(line).toBeDefined();
      const json = JSON.parse(line!.replace(/^\[AgentStartup\] /, ""));
      expect(json.firstByteAt).toBeUndefined();
      expect(json.timeToFirstByteMs).toBeUndefined();
      expect(json.bootDurationMs).toEqual(expect.any(Number));
    } finally {
      consoleLog.mockRestore();
      terminal.dispose();
    }
  });
});

describe("TerminalProcess — resize result echo (#11641)", () => {
  /**
   * A pty whose `cols`/`rows` track what `resize()` accepted, and which can
   * accept something other than what it was asked for. Real node-pty reports
   * its own cached view rather than a kernel read-back, so the distinction the
   * echo has to preserve is "what the pty ended up holding" vs "what we asked
   * for" — a fake that always stores the argument can't tell those apart.
   */
  function createResizablePty(
    initialCols: number,
    initialRows: number,
    accept: (cols: number, rows: number) => { cols: number; rows: number } = (cols, rows) => ({
      cols,
      rows,
    })
  ) {
    const pty = createControllablePty();
    let currentCols = initialCols;
    let currentRows = initialRows;
    Object.defineProperty(pty, "cols", { get: () => currentCols, configurable: true });
    Object.defineProperty(pty, "rows", { get: () => currentRows, configurable: true });
    const resizeSpy = vi.fn<(cols: number, rows: number) => void>((cols, rows) => {
      const accepted = accept(cols, rows);
      currentCols = accepted.cols;
      currentRows = accepted.rows;
    });
    pty.resize = resizeSpy;
    return { pty, resizeSpy };
  }

  it("reports the geometry the pty holds once it adopts the request", () => {
    const { pty } = createResizablePty(80, 24);
    const terminal = createTerminal(pty, undefined, undefined, "t-resize-applied");
    try {
      const result = terminal.resize(700, 40);

      expect(result.outcome).toBe("applied");
      expect(result.appliedCols).toBe(700);
      expect(result.appliedRows).toBe(40);
    } finally {
      terminal.dispose();
    }
  });

  it("reports no geometry when the backend has not adopted the resize yet", () => {
    // node-pty on Windows QUEUES resize until ConPTY is ready and updates its
    // cached dims only inside that deferred callback, so the getters still
    // report the pre-resize grid. Claiming the OLD grid as applied is the
    // dangerous answer: the watchdog would compare it against xterm, see
    // agreement, and miss the split once the queued resize lands.
    const { pty, resizeSpy } = createResizablePty(80, 24, (_cols, _rows) => ({
      cols: 80,
      rows: 24,
    }));
    const terminal = createTerminal(pty, undefined, undefined, "t-resize-deferred");
    try {
      const result = terminal.resize(700, 40);

      expect(resizeSpy).toHaveBeenCalledWith(700, 40);
      expect(result.outcome).toBe("deferred");
      // Neither the request nor the stale grid — the geometry is unknown.
      expect(result.appliedCols).toBeNull();
      expect(result.appliedRows).toBeNull();
    } finally {
      terminal.dispose();
    }
  });

  it("reports no geometry when the dimensions cannot be read at all", () => {
    const { pty } = createResizablePty(80, 24);
    const terminal = createTerminal(pty, undefined, undefined, "t-resize-getter-throws");
    try {
      Object.defineProperty(pty, "cols", {
        get: (): number => {
          throw new Error("pty destroyed");
        },
        configurable: true,
      });

      const result = terminal.resize(120, 40);

      // An unreadable grid must never fall back to the request — that would
      // manufacture agreement with xterm out of a measurement failure.
      expect(result.appliedCols).toBeNull();
      expect(result.appliedCols).not.toBe(result.requestedCols);
    } finally {
      terminal.dispose();
    }
  });

  it("still reports the pty's geometry when the request is a no-op", () => {
    // The dedup shortcut skips ptyProcess.resize (and therefore SIGWINCH). A
    // caller that learns nothing here cannot distinguish "the pty is where you
    // asked" from "the pty never moved", which is the split this echo exists
    // to surface.
    const { pty, resizeSpy } = createResizablePty(120, 30);
    const terminal = createTerminal(pty, undefined, undefined, "t-resize-noop");
    try {
      const result = terminal.resize(120, 30);

      expect(result.outcome).toBe("unchanged");
      expect(result.appliedCols).toBe(120);
      expect(result.appliedRows).toBe(30);
      expect(resizeSpy).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
    }
  });

  it("reports the pre-existing geometry when the pty rejects the resize", () => {
    const { pty } = createResizablePty(100, 30);
    pty.resize = () => {
      throw new Error("ioctl failed");
    };
    const terminal = createTerminal(pty, undefined, undefined, "t-resize-throw");
    try {
      const result = terminal.resize(200, 50);

      expect(result.outcome).toBe("failed");
      expect(result.error).toContain("ioctl failed");
      // The grid did NOT move — reporting the request here would claim a
      // resize that never happened.
      expect(result.appliedCols).toBe(100);
      expect(result.appliedRows).toBe(30);
    } finally {
      terminal.dispose();
    }
  });

  it("rejects non-integral geometry without touching the pty", () => {
    const { pty, resizeSpy } = createResizablePty(80, 24);
    const terminal = createTerminal(pty, undefined, undefined, "t-resize-invalid");
    try {
      const result = terminal.resize(80.5, 24);

      expect(result.outcome).toBe("rejected");
      expect(result.appliedCols).toBeNull();
      expect(result.appliedRows).toBeNull();
      expect(resizeSpy).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
    }
  });

  it("reports no applied geometry once the pty has exited", () => {
    const { pty, resizeSpy } = createResizablePty(80, 24);
    const terminal = createTerminal(pty, undefined, undefined, "t-resize-exited");
    try {
      pty.emitExit(0);
      const result = terminal.resize(120, 40);

      expect(result.outcome).toBe("exited");
      expect(result.appliedCols).toBeNull();
      expect(resizeSpy).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
    }
  });
});
