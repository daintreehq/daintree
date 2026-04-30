import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import type { ProcessTreeCache } from "../../ProcessTreeCache.js";
import type { DetectionResult } from "../../ProcessDetector.js";
import { makeAgentResult, makeNoAgentResult } from "../../ProcessDetector.js";
import { events } from "../../events.js";

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

type MockPty = IPty & {
  __emitData: (data: string) => void;
  __emitExit: (exitCode?: number, signal?: number) => void;
  __writes: string[];
};

function createMockPty(): MockPty {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const writes: string[] = [];

  const pty: Partial<MockPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: (data: string) => {
      writes.push(data);
    },
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: (callback: (data: string) => void) => {
      dataListeners.add(callback);
      return { dispose: () => dataListeners.delete(callback) };
    },
    onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.add(callback);
      return { dispose: () => exitListeners.delete(callback) };
    },
    __emitData: (data: string) => {
      for (const listener of dataListeners) {
        listener(data);
      }
    },
    __emitExit: (exitCode = 0, signal = 0) => {
      for (const listener of exitListeners) {
        listener({ exitCode, signal });
      }
    },
    __writes: writes,
  };
  return pty as MockPty;
}

function createMockProcessTreeCache(): ProcessTreeCache {
  return {
    getDescendantPids: vi.fn().mockReturnValue([]),
    getChildPids: vi.fn().mockReturnValue([]),
    getChildren: vi.fn().mockReturnValue([]),
    getProcess: vi.fn(),
    hasChildren: vi.fn().mockReturnValue(false),
    getDescendantsCpuUsage: vi.fn().mockReturnValue(0),
    hasActiveDescendants: vi.fn().mockReturnValue(false),
    start: vi.fn(),
    stop: vi.fn(),
    onRefresh: vi.fn().mockReturnValue(() => {}),
    refresh: vi.fn(),
    getLastRefreshTime: vi.fn().mockReturnValue(0),
    getLastError: vi.fn().mockReturnValue(null),
    getCacheSize: vi.fn().mockReturnValue(0),
  } as unknown as ProcessTreeCache;
}

function createMutableDescendantCache(): {
  cache: ProcessTreeCache;
  setDescendants: (pids: number[]) => void;
} {
  const cache = createMockProcessTreeCache();
  let descendants: number[] = [];
  vi.mocked(cache.getDescendantPids).mockImplementation(() => descendants);
  vi.mocked(cache.getChildren).mockImplementation(() =>
    descendants.map((pid) => ({
      pid,
      ppid: 123,
      comm: "node",
      command: "node /tmp/runtime.js",
      cpuPercent: 0,
      rssKb: 0,
    }))
  );
  return {
    cache,
    setDescendants: (pids) => {
      descendants = pids;
    },
  };
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

function createAgentTerminal(deps?: Partial<TerminalProcessDeps>): TerminalProcess {
  const options: TerminalProcessOptions = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal",
    launchAgentId: "claude",
  } as TerminalProcessOptions;
  const ctx: SpawnContext = {
    shell: "/bin/zsh",
    args: ["-l"],
    env: {},
  };
  return new TerminalProcess(
    "t-agent",
    options,
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
        emitAgentCompleted: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: createMockProcessTreeCache(),
      ...deps,
    } as TerminalProcessDeps,
    ctx,
    createMockPty()
  );
}

function createPlainTerminal(id = "t-plain", deps?: Partial<TerminalProcessDeps>): TerminalProcess {
  const options: TerminalProcessOptions = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal",
  } as TerminalProcessOptions;
  const ctx: SpawnContext = {
    shell: "/bin/zsh",
    args: ["-l"],
    env: {},
  };
  return new TerminalProcess(
    id,
    options,
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
        emitAgentCompleted: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: createMockProcessTreeCache(),
      ...deps,
    } as TerminalProcessDeps,
    ctx,
    createMockPty()
  );
}

function createPlainTerminalWithCommand(
  id: string,
  command: string,
  deps?: Partial<TerminalProcessDeps>
): TerminalProcess {
  const options: TerminalProcessOptions = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal",
    command,
  } as TerminalProcessOptions;
  const ctx: SpawnContext = {
    shell: "/bin/zsh",
    args: ["-lc", command],
    env: {},
  };
  return new TerminalProcess(
    id,
    options,
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
        emitAgentCompleted: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: createMockProcessTreeCache(),
      ...deps,
    } as TerminalProcessDeps,
    ctx,
    createMockPty()
  );
}

function getScrollback(terminal: TerminalProcess): number {
  return (terminal as unknown as { _scrollback: number })._scrollback;
}

type HandleAgentDetection = (result: DetectionResult, spawnedAt: number) => void;

function callHandleAgentDetection(
  terminal: TerminalProcess,
  result: DetectionResult,
  spawnedAt: number
): void {
  const fn = (terminal as unknown as { handleAgentDetection: HandleAgentDetection })
    .handleAgentDetection;
  fn.call(terminal, result, spawnedAt);
}

function getActivityMonitor(terminal: TerminalProcess): { onInput: (s: string) => void } | null {
  return (terminal as unknown as { activityMonitor: { onInput: (s: string) => void } | null })
    .activityMonitor;
}

function getSpawnedAt(terminal: TerminalProcess): number {
  return (terminal as unknown as { terminalInfo: { spawnedAt: number } }).terminalInfo.spawnedAt;
}

function getMockPty(terminal: TerminalProcess): MockPty {
  return terminal.getInfo().ptyProcess as MockPty;
}

describe("TerminalProcess.handleAgentDetection — disposes ActivityMonitor on agent exit", () => {
  let terminal: TerminalProcess;
  let exitedEvents: Array<{ terminalId: string; agentType?: string }>;
  let unsubscribe: () => void;

  beforeEach(() => {
    terminal = createAgentTerminal();
    exitedEvents = [];
    unsubscribe = events.on("agent:exited", (payload) => {
      exitedEvents.push({ terminalId: payload.terminalId, agentType: payload.agentType });
    });
    // Seed initial agent detection so subsequent transitions hit the exit branches.
    callHandleAgentDetection(
      terminal,
      makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
      getSpawnedAt(terminal)
    );
  });

  afterEach(() => {
    unsubscribe();
    terminal.dispose();
  });

  it("holds monitor when a non-agent process appears while an agent is live", () => {
    expect(getActivityMonitor(terminal)).not.toBeNull();

    callHandleAgentDetection(
      terminal,
      makeAgentResult({ processIconId: "npm", processName: "npm" }),
      getSpawnedAt(terminal)
    );

    expect(getActivityMonitor(terminal)).not.toBeNull();
    expect(terminal.getInfo().detectedAgentId).toBe("claude");
    expect(exitedEvents).toHaveLength(0);
  });

  it("holds monitor when process-tree absence reports no process after the agent", () => {
    expect(getActivityMonitor(terminal)).not.toBeNull();

    callHandleAgentDetection(terminal, makeNoAgentResult({}), getSpawnedAt(terminal));

    expect(getActivityMonitor(terminal)).not.toBeNull();
    expect(terminal.getInfo().detectedAgentId).toBe("claude");
    expect(exitedEvents).toHaveLength(0);
  });

  it("disposes monitor when prompt-return explicitly exits the agent", () => {
    expect(getActivityMonitor(terminal)).not.toBeNull();

    callHandleAgentDetection(
      terminal,
      makeNoAgentResult({ evidenceSource: "shell_command" }),
      getSpawnedAt(terminal)
    );

    expect(getActivityMonitor(terminal)).toBeNull();
    expect(terminal.getInfo().detectedAgentId).toBeUndefined();
    expect(exitedEvents).toHaveLength(1);
    expect(exitedEvents[0]).toEqual({ terminalId: "t-agent", agentType: "claude" });
  });

  it("does not flow further activity-state callbacks after the monitor is disposed", () => {
    const handleActivityState = vi.fn();
    const trackedTerminal = createAgentTerminal({
      agentStateService: {
        handleActivityState,
        updateAgentState: () => {},
        emitAgentKilled: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
    });

    try {
      // Seed agent detection.
      callHandleAgentDetection(
        trackedTerminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(trackedTerminal)
      );
      const monitorBefore = getActivityMonitor(trackedTerminal);
      expect(monitorBefore).not.toBeNull();

      // Demote: agent gone.
      callHandleAgentDetection(
        trackedTerminal,
        makeNoAgentResult({ evidenceSource: "shell_command" }),
        getSpawnedAt(trackedTerminal)
      );
      expect(getActivityMonitor(trackedTerminal)).toBeNull();

      handleActivityState.mockClear();

      // The retained reference to the now-disposed monitor must be a no-op.
      monitorBefore?.onInput("ls -la\r");
      expect(handleActivityState).not.toHaveBeenCalled();
    } finally {
      trackedTerminal.dispose();
    }
  });

  it("non-agent process and process absence do not emit agent exit without prompt return", () => {
    callHandleAgentDetection(
      terminal,
      makeAgentResult({ processIconId: "npm", processName: "npm" }),
      getSpawnedAt(terminal)
    );
    expect(getActivityMonitor(terminal)).not.toBeNull();
    expect(exitedEvents).toHaveLength(0);

    callHandleAgentDetection(terminal, makeNoAgentResult({}), getSpawnedAt(terminal));
    expect(getActivityMonitor(terminal)).not.toBeNull();
    expect(terminal.getInfo().detectedAgentId).toBe("claude");
    expect(exitedEvents).toHaveLength(0);
  });
});

describe("TerminalProcess.handleAgentDetection — disposes monitor without prior agent", () => {
  it("Branch B — stops the constructor-created monitor when no agent was ever detected", () => {
    const exitedEvents: Array<{ terminalId: string; agentType?: string }> = [];
    const unsub = events.on("agent:exited", (payload) => {
      exitedEvents.push({ terminalId: payload.terminalId, agentType: payload.agentType });
    });
    const trackedTerminal = createAgentTerminal();
    try {
      // No initial agent detection: only a non-agent process icon is set.
      callHandleAgentDetection(
        trackedTerminal,
        makeAgentResult({ processIconId: "npm", processName: "npm" }),
        getSpawnedAt(trackedTerminal)
      );
      // Monitor was created in the constructor for this isAgentTerminal=true terminal.
      expect(getActivityMonitor(trackedTerminal)).not.toBeNull();

      // Now everything goes away — Branch B with previousType undefined.
      callHandleAgentDetection(
        trackedTerminal,
        makeNoAgentResult({ evidenceSource: "shell_command" }),
        getSpawnedAt(trackedTerminal)
      );

      expect(getActivityMonitor(trackedTerminal)).toBeNull();
      expect(exitedEvents).toHaveLength(1);
      expect(exitedEvents[0].agentType).toBeUndefined();
    } finally {
      unsub();
      trackedTerminal.dispose();
    }
  });
});

describe("TerminalProcess.handleAgentDetection — polling loop teardown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits no further handleActivityState callbacks after the monitor is disposed", () => {
    const handleActivityState = vi.fn();
    const trackedTerminal = createAgentTerminal({
      agentStateService: {
        handleActivityState,
        updateAgentState: () => {},
        emitAgentKilled: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
    });

    try {
      callHandleAgentDetection(
        trackedTerminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(trackedTerminal)
      );
      expect(getActivityMonitor(trackedTerminal)).not.toBeNull();

      callHandleAgentDetection(
        trackedTerminal,
        makeNoAgentResult({ evidenceSource: "shell_command" }),
        getSpawnedAt(trackedTerminal)
      );
      expect(getActivityMonitor(trackedTerminal)).toBeNull();

      handleActivityState.mockClear();

      // Advance past several polling cycles. If the polling interval still fired,
      // it would call handleActivityState. The monitor must be fully torn down.
      vi.advanceTimersByTime(5000);

      expect(handleActivityState).not.toHaveBeenCalled();
    } finally {
      trackedTerminal.dispose();
    }
  });
});

// Issue #5776: spawn-sealed agent behaviours on runtime-promoted panels.
// Plain terminals spawned with kind="terminal" inherit DEFAULT_SCROLLBACK (1k);
// when runtime detection sees an agent appear, the headless detection buffer
// must grow to AGENT_SCROLLBACK (10k) so the buffer carries enough history for
// the agent's longer output. Cold agent terminals already start at 10k and
// must be untouched.
describe("TerminalProcess.handleAgentDetection — runtime promotion scrollback", () => {
  it("plain terminal starts at DEFAULT_SCROLLBACK and agent detection does not change it", () => {
    const terminal = createPlainTerminal();
    try {
      expect(getScrollback(terminal)).toBe(10000);

      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );

      expect(getScrollback(terminal)).toBe(10000);
    } finally {
      terminal.dispose();
    }
  });

  it("is idempotent on repeated detection of the same agent", () => {
    const terminal = createPlainTerminal("t-plain-idem");
    try {
      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );
      expect(getScrollback(terminal)).toBe(10000);

      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );
      expect(getScrollback(terminal)).toBe(10000);
    } finally {
      terminal.dispose();
    }
  });

  it("does not change scrollback for cold-spawned agent terminals", () => {
    const terminal = createAgentTerminal();
    try {
      // Cold-spawned agent already starts at AGENT_SCROLLBACK.
      expect(getScrollback(terminal)).toBe(10000);

      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );

      expect(getScrollback(terminal)).toBe(10000);
    } finally {
      terminal.dispose();
    }
  });

  it("growScrollback never shrinks", () => {
    const terminal = createAgentTerminal();
    try {
      expect(getScrollback(terminal)).toBe(10000);
      terminal.growScrollback(5000);
      expect(getScrollback(terminal)).toBe(10000);
    } finally {
      terminal.dispose();
    }
  });

  it("keeps scrollback at AGENT_SCROLLBACK across an agent-to-agent switch", () => {
    const terminal = createPlainTerminal("t-plain-switch");
    try {
      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );
      expect(getScrollback(terminal)).toBe(10000);

      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "gemini" as const, processIconId: "gemini" }),
        getSpawnedAt(terminal)
      );
      expect(getScrollback(terminal)).toBe(10000);
    } finally {
      terminal.dispose();
    }
  });
});

describe("TerminalProcess shell-command identity fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("promotes a plain terminal from a typed agent command when process-tree detection never commits", async () => {
    const terminal = createPlainTerminal("t-fallback-agent");
    const pty = getMockPty(terminal);

    try {
      terminal.write("claude\r");
      pty.__emitData("claude\r\n");
      pty.__emitData("Starting Claude Code...\r\n");

      await vi.advanceTimersByTimeAsync(2000);

      const info = terminal.getInfo();
      expect(info.detectedAgentId).toBe("claude");
      // Plain terminal — no launchAgentId; runtime detection must not set it.
      expect(info.launchAgentId).toBeUndefined();
      expect(info.analysisEnabled).toBe(true);
      expect(info.everDetectedAgent).toBe(true);
    } finally {
      terminal.dispose();
    }
  });

  it("does not let a trust-prompt Enter overwrite pending typed-agent fallback cleanup", async () => {
    const terminal = createPlainTerminal("t-fallback-agent-trust-enter");
    const pty = getMockPty(terminal);

    try {
      terminal.write("claude\r");
      pty.__emitData("claude\r\n");
      pty.__emitData("Accessing workspace:\r\n");
      pty.__emitData(" ❯ 1. Yes, I trust this folder\r\n");

      // This Enter belongs to Claude's trust UI, not to the shell. It must
      // not reset the pending shell-command identity to "no command".
      terminal.write("\r");
      pty.__emitData("FAKE_CLAUDE_READY\r\n");

      await vi.advanceTimersByTimeAsync(2000);
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      pty.__emitData("^CFAKE_CLAUDE_EXIT\r\n");
      pty.__emitData("➜  canopy-app git:(main) ");
      await vi.advanceTimersByTimeAsync(600);

      expect(terminal.getInfo().detectedAgentId).toBeUndefined();
      expect(terminal.getInfo().detectedProcessIconId).toBeUndefined();
      expect(terminal.getInfo().analysisEnabled).toBe(false);
    } finally {
      terminal.dispose();
    }
  });

  it("does not demote an agent on prompt-looking TUI text while a foreground child owns the PTY", async () => {
    const terminal = createPlainTerminal("t-fallback-agent-foreground-pgid");
    const pty = getMockPty(terminal);
    let foregroundPgid = 456;
    (
      terminal as unknown as {
        readForegroundProcessGroupSnapshot: () => { shellPgid: number; foregroundPgid: number };
      }
    ).readForegroundProcessGroupSnapshot = () => ({ shellPgid: 123, foregroundPgid });

    try {
      terminal.write("claude\r");
      pty.__emitData("claude\r\n");
      pty.__emitData("FAKE_CLAUDE_READY\r\n");

      await vi.advanceTimersByTimeAsync(2000);
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      // Claude/Ink idle input can look like a shell prompt. The foreground
      // process group says the agent still owns the TTY, so hold identity.
      pty.__emitData("\r\n❯ ");
      await vi.advanceTimersByTimeAsync(1000);
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      // Once the shell reclaims the foreground process group, prompt return is
      // authoritative and demotion is allowed.
      foregroundPgid = 123;
      pty.__emitData("\r\n➜  canopy-app git:(main) ");
      await vi.advanceTimersByTimeAsync(600);

      expect(terminal.getInfo().detectedAgentId).toBeUndefined();
      expect(terminal.getInfo().detectedProcessIconId).toBeUndefined();
      expect(terminal.getInfo().analysisEnabled).toBe(false);
    } finally {
      terminal.dispose();
    }
  });

  it("demotes a spawn-sealed agent terminal back to plain shell when the prompt returns", async () => {
    const terminal = createAgentTerminal();
    const pty = getMockPty(terminal);

    try {
      terminal.write("claude\r");
      pty.__emitData("claude\r\n");
      pty.__emitData("Claude Code ready.\r\n");

      await vi.advanceTimersByTimeAsync(2000);
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      pty.__emitData("\r\ngpriday@macbook canopy-app % ");
      await vi.advanceTimersByTimeAsync(600);

      const info = terminal.getInfo();
      expect(info.detectedAgentId).toBeUndefined();
      // Launch hint survives demotion — the PTY was born as claude, and
      // that historical fact must persist across the agent exiting. #5803
      expect(info.launchAgentId).toBe("claude");
      expect(info.analysisEnabled).toBe(false);
    } finally {
      terminal.dispose();
    }
  });

  it("shows the npm badge for a typed npm run dev command and clears it on prompt return", async () => {
    const terminal = createPlainTerminal("t-fallback-npm");
    const pty = getMockPty(terminal);

    try {
      terminal.write("npm run dev\r");
      pty.__emitData("npm run dev\r\n");
      pty.__emitData("> canopy-app@1.0.0 dev\r\n");

      await vi.advanceTimersByTimeAsync(2000);
      expect(terminal.getInfo().detectedProcessIconId).toBe("npm");

      pty.__emitData("\r\ngpriday@macbook canopy-app % ");
      await vi.advanceTimersByTimeAsync(600);

      expect(terminal.getInfo().detectedProcessIconId).toBeUndefined();
      expect(terminal.getInfo().detectedAgentId).toBeUndefined();
    } finally {
      terminal.dispose();
    }
  });

  it("does not flash an agent badge for a short-lived command that returns before the fallback commit window", async () => {
    const terminal = createPlainTerminal("t-fallback-short");
    const pty = getMockPty(terminal);

    try {
      terminal.write("claude --version\r");
      pty.__emitData("claude --version\r\n2.1.117\r\n");
      pty.__emitData("gpriday@macbook canopy-app % ");

      await vi.advanceTimersByTimeAsync(2500);

      const info = terminal.getInfo();
      expect(info.detectedAgentId).toBeUndefined();
      expect(info.detectedProcessIconId).toBeUndefined();
      expect(info.launchAgentId).toBeUndefined();
    } finally {
      terminal.dispose();
    }
  });

  // #5813 regression: when the PTY exits on the non-preserved path,
  // `disposeHeadless()` nulls the headless terminal but neither `isExited`
  // nor `wasKilled` is set — so the fallback watcher, which had
  // `!headlessTerminal` removed from its stop guard, must instead be stopped
  // explicitly in the `onExit` handler. Otherwise the interval runs forever
  // and keeps the TerminalProcess alive past registry deletion.
  it("stops the fallback watcher on non-preserved PTY exit (no orphan timer)", async () => {
    const terminal = createPlainTerminal("t-fallback-exit");
    const pty = getMockPty(terminal);
    const emittedEventsAfterExit: string[] = [];

    try {
      terminal.write("npm run dev\r");
      pty.__emitData("npm run dev\r\n");
      pty.__emitData("> canopy-app@1.0.0 dev\r\n");
      await vi.advanceTimersByTimeAsync(2000);
      expect(terminal.getInfo().detectedProcessIconId).toBe("npm");

      const unsub = events.on("agent:detected", (payload) => {
        emittedEventsAfterExit.push(payload.terminalId);
      });
      pty.__emitExit(0);
      await vi.advanceTimersByTimeAsync(30_000);

      // No post-exit detection events; watcher is gone.
      expect(emittedEventsAfterExit).toHaveLength(0);
      unsub();
    } finally {
      terminal.dispose();
    }
  });

  it("clears live agent identity when a preserved agent PTY exits before a shell prompt returns", async () => {
    const terminal = createPlainTerminalWithCommand("t-agent-pty-exit-clear", "claude");
    const pty = getMockPty(terminal);
    const exitedEvents: Array<{ terminalId: string; agentType?: string; exitKind?: string }> = [];
    const unsub = events.on("agent:exited", (payload) => {
      exitedEvents.push({
        terminalId: payload.terminalId,
        agentType: payload.agentType,
        exitKind: payload.exitKind,
      });
    });

    try {
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      pty.__emitExit(0);

      const info = terminal.getInfo();
      expect(info.detectedAgentId).toBeUndefined();
      expect(info.detectedProcessIconId).toBeUndefined();
      expect(info.analysisEnabled).toBe(false);
      expect(info.isExited).toBe(true);
      expect(exitedEvents).toEqual([
        { terminalId: "t-agent-pty-exit-clear", agentType: "claude", exitKind: "terminal" },
      ]);
    } finally {
      unsub();
      terminal.dispose();
    }
  });

  // #5813: user runs a plain-process command, the badge appears via the
  // fallback, they Ctrl+C, then run a DIFFERENT plain-process command. The
  // second command must re-arm the fallback even though lastDetectedProcessIconId
  // from the first command hasn't been cleared by the process-tree path yet.
  it("re-arms the fallback for a second plain-process command when the first badge hasn't cleared", async () => {
    const terminal = createPlainTerminal("t-fallback-rearm");
    const pty = getMockPty(terminal);

    try {
      terminal.write("npm run dev\r");
      pty.__emitData("npm run dev\r\n");
      pty.__emitData("> canopy-app@1.0.0 dev\r\n");
      await vi.advanceTimersByTimeAsync(2000);
      expect(terminal.getInfo().detectedProcessIconId).toBe("npm");

      // Second command while first badge is still latched. No process-tree
      // clear has fired yet.
      terminal.write("pnpm build\r");
      pty.__emitData("pnpm build\r\n");
      pty.__emitData("> build output\r\n");
      await vi.advanceTimersByTimeAsync(2000);

      expect(terminal.getInfo().detectedProcessIconId).toBe("pnpm");
    } finally {
      terminal.dispose();
    }
  });
});

// #5813: the live ProcessDetector path for plain terminals running a
// recognised non-agent process (npm, pnpm, python, docker, etc.) must emit
// `agent:detected` with `processIconId` but no `agentType`. This is the
// primary pipeline — the shell-command fallback is belt-and-suspenders.
describe("TerminalProcess.handleAgentDetection — plain process icon badge emission", () => {
  it("emits agent:detected with processIconId only (no agentType) for a plain-process detection", () => {
    const terminal = createPlainTerminal("t-plain-badge");
    const detectedEvents: Array<{
      terminalId: string;
      agentType?: string;
      processIconId?: string;
      processName?: string;
    }> = [];
    const unsub = events.on("agent:detected", (payload) => {
      detectedEvents.push({
        terminalId: payload.terminalId,
        agentType: payload.agentType,
        processIconId: payload.processIconId,
        processName: payload.processName,
      });
    });

    try {
      callHandleAgentDetection(
        terminal,
        makeAgentResult({ processIconId: "npm", processName: "npm" }),
        getSpawnedAt(terminal)
      );

      expect(detectedEvents).toHaveLength(1);
      expect(detectedEvents[0].terminalId).toBe("t-plain-badge");
      expect(detectedEvents[0].agentType).toBeUndefined();
      expect(detectedEvents[0].processIconId).toBe("npm");
      expect(detectedEvents[0].processName).toBe("npm");
      expect(terminal.getInfo().detectedProcessIconId).toBe("npm");
    } finally {
      unsub();
      terminal.dispose();
    }
  });

  it("clears detectedProcessIconId and emits agent:exited when the plain process goes away", () => {
    const terminal = createPlainTerminal("t-plain-badge-clear");
    const exitedEvents: Array<{ terminalId: string; agentType?: string }> = [];
    const unsub = events.on("agent:exited", (payload) => {
      exitedEvents.push({ terminalId: payload.terminalId, agentType: payload.agentType });
    });

    try {
      callHandleAgentDetection(
        terminal,
        makeAgentResult({ processIconId: "npm", processName: "npm" }),
        getSpawnedAt(terminal)
      );
      expect(terminal.getInfo().detectedProcessIconId).toBe("npm");

      callHandleAgentDetection(terminal, makeNoAgentResult({}), getSpawnedAt(terminal));

      expect(terminal.getInfo().detectedProcessIconId).toBeUndefined();
      expect(exitedEvents).toHaveLength(1);
      expect(exitedEvents[0].terminalId).toBe("t-plain-badge-clear");
      expect(exitedEvents[0].agentType).toBeUndefined();
    } finally {
      unsub();
      terminal.dispose();
    }
  });
});

describe("TerminalProcess spawn command identity seeding", () => {
  it("routes a spawn-time Claude command through the same agent:detected path", () => {
    const detectedEvents: Array<{
      terminalId: string;
      agentType?: string;
      processIconId?: string;
      processName?: string;
    }> = [];
    const unsub = events.on("agent:detected", (payload) => {
      detectedEvents.push({
        terminalId: payload.terminalId,
        agentType: payload.agentType,
        processIconId: payload.processIconId,
        processName: payload.processName,
      });
    });

    const terminal = createPlainTerminalWithCommand("t-spawn-claude", "claude --model sonnet");

    try {
      expect(detectedEvents).toHaveLength(1);
      expect(detectedEvents[0]).toMatchObject({
        terminalId: "t-spawn-claude",
        agentType: "claude",
        processIconId: "claude",
        processName: "claude",
      });
      expect(terminal.getInfo().detectedAgentId).toBe("claude");
      expect(terminal.getInfo().detectedProcessIconId).toBe("claude");
    } finally {
      unsub();
      terminal.dispose();
    }
  });

  it("routes a spawn-time quoted absolute Claude path through the same agent:detected path", () => {
    const detectedEvents: Array<{
      terminalId: string;
      agentType?: string;
      processIconId?: string;
      processName?: string;
    }> = [];
    const unsub = events.on("agent:detected", (payload) => {
      detectedEvents.push({
        terminalId: payload.terminalId,
        agentType: payload.agentType,
        processIconId: payload.processIconId,
        processName: payload.processName,
      });
    });

    const terminal = createPlainTerminalWithCommand(
      "t-spawn-quoted-claude",
      "'/Users/gpriday/.local/bin/claude' --dangerously-skip-permissions"
    );

    try {
      expect(detectedEvents).toHaveLength(1);
      expect(detectedEvents[0]).toMatchObject({
        terminalId: "t-spawn-quoted-claude",
        agentType: "claude",
        processIconId: "claude",
        processName: "claude",
      });
      expect(terminal.getInfo().detectedAgentId).toBe("claude");
      expect(terminal.getInfo().detectedProcessIconId).toBe("claude");
    } finally {
      unsub();
      terminal.dispose();
    }
  });

  it("clears spawn-time shell evidence when the command-launch shell returns to prompt", async () => {
    vi.useFakeTimers();
    const { cache, setDescendants } = createMutableDescendantCache();
    setDescendants([456]);
    const terminal = createPlainTerminalWithCommand("t-spawn-claude-clear", "claude", {
      processTreeCache: cache,
    });
    const pty = getMockPty(terminal);

    try {
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      pty.__emitData("claude\r\n");
      pty.__emitData("FAKE_CLAUDE_READY\r\n");
      await vi.advanceTimersByTimeAsync(250);
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      setDescendants([]);
      pty.__emitData("\r\ngpriday@macbook canopy-app % ");
      await vi.advanceTimersByTimeAsync(600);

      expect(terminal.getInfo().detectedAgentId).toBeUndefined();
      expect(terminal.getInfo().detectedProcessIconId).toBeUndefined();
      expect(terminal.getInfo().analysisEnabled).toBe(false);
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("clears agent identity at a returned shell prompt even if prompt helpers are descendants", async () => {
    vi.useFakeTimers();
    const { cache, setDescendants } = createMutableDescendantCache();
    setDescendants([456]);
    const terminal = createPlainTerminalWithCommand("t-spawn-claude-prompt-helper", "claude", {
      processTreeCache: cache,
    });
    const pty = getMockPty(terminal);

    try {
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      pty.__emitData("FAKE_CLAUDE_READY\r\n");
      await vi.advanceTimersByTimeAsync(250);
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      // zsh/git prompts can briefly spawn helper descendants while the shell
      // prompt is visible. That must not keep the terminal in agent chrome.
      setDescendants([999]);
      pty.__emitData("\r\n➜  canopy-app git:(main) ");
      await vi.advanceTimersByTimeAsync(600);

      expect(terminal.getInfo().detectedAgentId).toBeUndefined();
      expect(terminal.getInfo().detectedProcessIconId).toBeUndefined();
      expect(terminal.getInfo().analysisEnabled).toBe(false);
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("clears agent identity when a shell prompt returns below historical trust-prompt text", async () => {
    vi.useFakeTimers();
    const terminal = createPlainTerminalWithCommand("t-agent-trust-prompt-history", "claude");
    const pty = getMockPty(terminal);

    try {
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      pty.__emitData("Accessing workspace:\r\n");
      pty.__emitData(" ❯ 1. Yes, I trust this folder\r\n");
      pty.__emitData(" Enter to confirm · Esc to cancel\r\n");
      pty.__emitData("FAKE_CLAUDE_READY\r\n");
      pty.__emitData("^CFAKE_CLAUDE_EXIT\r\n");
      pty.__emitData("➜  canopy-app git:(main) ");
      await vi.advanceTimersByTimeAsync(600);

      expect(terminal.getInfo().detectedAgentId).toBeUndefined();
      expect(terminal.getInfo().detectedProcessIconId).toBeUndefined();
      expect(terminal.getInfo().analysisEnabled).toBe(false);
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("does not clear agent identity when an agent UI prompt is visible before process observation", async () => {
    vi.useFakeTimers();
    const terminal = createPlainTerminalWithCommand("t-agent-ui-prompt-before-tree", "claude");
    const pty = getMockPty(terminal);

    try {
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      terminal.write("claude\r");
      pty.__emitData("Accessing workspace:\r\n");
      pty.__emitData(" ❯ 1. Yes, I trust this folder\r\n");
      await vi.advanceTimersByTimeAsync(1000);

      expect(terminal.getInfo().detectedAgentId).toBe("claude");
      expect(terminal.getInfo().detectedProcessIconId).toBe("claude");
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("does not clear agent identity when an agent UI prompt is visible while a descendant is live", async () => {
    vi.useFakeTimers();
    const { cache, setDescendants } = createMutableDescendantCache();
    setDescendants([456]);
    const terminal = createPlainTerminalWithCommand("t-agent-ui-prompt-live-tree", "claude", {
      processTreeCache: cache,
    });
    const pty = getMockPty(terminal);

    try {
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      terminal.write("claude\r");
      pty.__emitData("Accessing workspace:\r\n");
      pty.__emitData(" ❯ 1. Yes, I trust this folder\r\n");
      await vi.advanceTimersByTimeAsync(1000);

      expect(terminal.getInfo().detectedAgentId).toBe("claude");
      expect(terminal.getInfo().detectedProcessIconId).toBe("claude");
    } finally {
      terminal.dispose();
      vi.useRealTimers();
    }
  });

  it("routes a spawn-time npm command through the same process icon path", () => {
    const detectedEvents: Array<{
      terminalId: string;
      agentType?: string;
      processIconId?: string;
    }> = [];
    const unsub = events.on("agent:detected", (payload) => {
      detectedEvents.push({
        terminalId: payload.terminalId,
        agentType: payload.agentType,
        processIconId: payload.processIconId,
      });
    });

    const terminal = createPlainTerminalWithCommand("t-spawn-npm", "npm run build");

    try {
      expect(detectedEvents).toHaveLength(1);
      expect(detectedEvents[0]).toMatchObject({
        terminalId: "t-spawn-npm",
        processIconId: "npm",
      });
      expect(detectedEvents[0].agentType).toBeUndefined();
      expect(terminal.getInfo().detectedProcessIconId).toBe("npm");
    } finally {
      unsub();
      terminal.dispose();
    }
  });
});

// #5803: launchAgentId is sealed at spawn time and must never be rewritten by
// runtime process detection. Runtime-detected identity flows through
// `detectedAgentId`. See `docs/architecture/terminal-identity.md`.
describe("TerminalProcess.handleAgentDetection — launch identity immutability (#5803)", () => {
  it("plain terminal promotion does not set launchAgentId", () => {
    const terminal = createPlainTerminal("t-immut-promote");
    try {
      expect(terminal.getInfo().launchAgentId).toBeUndefined();

      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );

      const info = terminal.getInfo();
      expect(info.launchAgentId).toBeUndefined();
      expect(info.detectedAgentId).toBe("claude");
    } finally {
      terminal.dispose();
    }
  });

  it("plain terminal prompt-return demotion does not set launchAgentId", () => {
    const terminal = createPlainTerminal("t-immut-demote-plain");
    try {
      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );
      expect(terminal.getInfo().launchAgentId).toBeUndefined();

      callHandleAgentDetection(
        terminal,
        makeNoAgentResult({ evidenceSource: "shell_command" }),
        getSpawnedAt(terminal)
      );
      expect(terminal.getInfo().launchAgentId).toBeUndefined();
      expect(terminal.getInfo().detectedAgentId).toBeUndefined();
    } finally {
      terminal.dispose();
    }
  });

  it("spawn-sealed agent ignores non-agent-icon blips and preserves launchAgentId", () => {
    const terminal = createAgentTerminal();
    try {
      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );
      expect(terminal.getInfo().launchAgentId).toBe("claude");

      callHandleAgentDetection(
        terminal,
        makeAgentResult({ processIconId: "npm", processName: "npm" }),
        getSpawnedAt(terminal)
      );

      const info = terminal.getInfo();
      expect(info.launchAgentId).toBe("claude");
      expect(info.detectedAgentId).toBe("claude");
    } finally {
      terminal.dispose();
    }
  });

  it("spawn-sealed agent ignores no-detection blips and preserves launchAgentId", () => {
    const terminal = createAgentTerminal();
    try {
      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );
      expect(terminal.getInfo().launchAgentId).toBe("claude");

      callHandleAgentDetection(terminal, makeNoAgentResult({}), getSpawnedAt(terminal));

      const info = terminal.getInfo();
      expect(info.launchAgentId).toBe("claude");
      expect(info.detectedAgentId).toBe("claude");
    } finally {
      terminal.dispose();
    }
  });

  it("detection events still flow for a runtime-promoted plain shell", () => {
    const terminal = createPlainTerminal("t-immut-events");
    const detectedEvents: Array<{ agentType?: string }> = [];
    const exitedEvents: Array<{ agentType?: string }> = [];
    const unsubDetected = events.on("agent:detected", (payload) => {
      detectedEvents.push({ agentType: payload.agentType });
    });
    const unsubExited = events.on("agent:exited", (payload) => {
      exitedEvents.push({ agentType: payload.agentType });
    });

    try {
      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );
      expect(detectedEvents).toHaveLength(1);
      expect(detectedEvents[0].agentType).toBe("claude");
      expect(terminal.getInfo().launchAgentId).toBeUndefined();

      callHandleAgentDetection(
        terminal,
        makeNoAgentResult({ evidenceSource: "shell_command" }),
        getSpawnedAt(terminal)
      );
      expect(exitedEvents).toHaveLength(1);
      expect(exitedEvents[0].agentType).toBe("claude");
      expect(terminal.getInfo().launchAgentId).toBeUndefined();
    } finally {
      unsubDetected();
      unsubExited();
      terminal.dispose();
    }
  });
});

// v0.8.0 release fix: the "agent-requires-explicit-exit" guard preserves
// branded chrome through transient detection gaps for launch-anchored agents
// (toolbar-launched, where `launchAgentId` is set). Runtime-promoted plain
// terminals have no durable anchor, so a `no_agent` callback after the
// command exits must demote regardless of evidence source — otherwise a
// process-tree-absence tick that arrives without `evidenceSource:
// "shell_command"` strands the chrome on `claude` until terminal teardown.
describe("TerminalProcess.handleAgentDetection — runtime-promoted demote without launch anchor", () => {
  it("plain terminal demotes on no_agent without shell_command evidence", () => {
    const terminal = createPlainTerminal("t-runtime-demote");
    const exitedEvents: Array<{ agentType?: string }> = [];
    const unsubscribe = events.on("agent:exited", (payload) => {
      exitedEvents.push({ agentType: payload.agentType });
    });

    try {
      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      // Process-tree absence after the user typed `claude` and Ctrl+C'd —
      // arrives with no evidenceSource field. Plain terminals must demote.
      callHandleAgentDetection(terminal, makeNoAgentResult({}), getSpawnedAt(terminal));

      expect(terminal.getInfo().detectedAgentId).toBeUndefined();
      expect(exitedEvents).toHaveLength(1);
      expect(exitedEvents[0].agentType).toBe("claude");
    } finally {
      unsubscribe();
      terminal.dispose();
    }
  });

  it("toolbar-launched terminal still holds chrome on no_agent without shell_command", () => {
    // Regression guard: launch-anchored agents must keep the existing
    // "explicit-exit" guard so transient process-tree gaps don't drop the
    // branded chrome between detection ticks.
    const terminal = createAgentTerminal();
    const exitedEvents: Array<{ agentType?: string }> = [];
    const unsubscribe = events.on("agent:exited", (payload) => {
      exitedEvents.push({ agentType: payload.agentType });
    });

    try {
      callHandleAgentDetection(
        terminal,
        makeAgentResult({ agentType: "claude" as const, processIconId: "claude" }),
        getSpawnedAt(terminal)
      );

      callHandleAgentDetection(terminal, makeNoAgentResult({}), getSpawnedAt(terminal));

      expect(terminal.getInfo().detectedAgentId).toBe("claude");
      expect(exitedEvents).toHaveLength(0);

      // Explicit prompt-return demote still fires for launch-anchored agents.
      callHandleAgentDetection(
        terminal,
        makeNoAgentResult({ evidenceSource: "shell_command" }),
        getSpawnedAt(terminal)
      );
      expect(terminal.getInfo().detectedAgentId).toBeUndefined();
      expect(exitedEvents).toHaveLength(1);
    } finally {
      unsubscribe();
      terminal.dispose();
    }
  });
});

// #5809: unknown/ambiguous are first-class HOLD states. handleAgentDetection
// must no-op on both so a blind `ps` cycle or a two-source conflict does not
// silently demote a confirmed agent every HYSTERESIS window.
describe("TerminalProcess.handleAgentDetection — unknown/ambiguous hold state (#5809)", () => {
  it("no-ops on detectionState=unknown — keeps committed agent identity", () => {
    const terminal = createAgentTerminal();
    let exitedEvents = 0;
    const unsubscribe = events.on("agent:exited", () => {
      exitedEvents += 1;
    });

    try {
      callHandleAgentDetection(
        terminal,
        { detectionState: "agent", detected: true, agentType: "claude", processIconId: "claude" },
        getSpawnedAt(terminal)
      );
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      callHandleAgentDetection(
        terminal,
        { detectionState: "unknown", detected: false },
        getSpawnedAt(terminal)
      );

      expect(terminal.getInfo().detectedAgentId).toBe("claude");
      expect(exitedEvents).toBe(0);
    } finally {
      unsubscribe();
      terminal.dispose();
    }
  });

  it("no-ops on detectionState=ambiguous — keeps committed agent identity", () => {
    const terminal = createAgentTerminal();
    let exitedEvents = 0;
    const unsubscribe = events.on("agent:exited", () => {
      exitedEvents += 1;
    });

    try {
      callHandleAgentDetection(
        terminal,
        { detectionState: "agent", detected: true, agentType: "claude", processIconId: "claude" },
        getSpawnedAt(terminal)
      );
      expect(terminal.getInfo().detectedAgentId).toBe("claude");

      callHandleAgentDetection(
        terminal,
        { detectionState: "ambiguous", detected: false },
        getSpawnedAt(terminal)
      );

      expect(terminal.getInfo().detectedAgentId).toBe("claude");
      expect(exitedEvents).toBe(0);
    } finally {
      unsubscribe();
      terminal.dispose();
    }
  });

  it("normalizes legacy callers missing detectionState — detected=true maps to agent state", () => {
    const terminal = createPlainTerminal("t-normalize");
    try {
      // Legacy caller (no detectionState) — must be treated as agent.
      callHandleAgentDetection(
        terminal,
        { detected: true, agentType: "claude", processIconId: "claude" } as never,
        getSpawnedAt(terminal)
      );
      expect(terminal.getInfo().detectedAgentId).toBe("claude");
    } finally {
      terminal.dispose();
    }
  });
});
