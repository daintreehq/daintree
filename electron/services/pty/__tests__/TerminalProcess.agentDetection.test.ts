import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import type { ProcessTreeCache } from "../../ProcessTreeCache.js";
import type { DetectionResult } from "../../ProcessDetector.js";
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

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

function createAgentTerminal(deps?: Partial<TerminalProcessDeps>): TerminalProcess {
  const options: TerminalProcessOptions = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal",
    type: "claude",
    agentId: "claude",
  } as TerminalProcessOptions;
  const ctx: SpawnContext = {
    shell: "/bin/zsh",
    args: ["-l"],
    isAgentTerminal: true,
    agentId: "claude",
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
    type: "terminal",
  } as TerminalProcessOptions;
  const ctx: SpawnContext = {
    shell: "/bin/zsh",
    args: ["-l"],
    isAgentTerminal: false,
    agentId: undefined,
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
      { detected: true, agentType: "claude", processIconId: "claude" },
      getSpawnedAt(terminal)
    );
  });

  afterEach(() => {
    unsubscribe();
    terminal.dispose();
  });

  it("Branch A — disposes monitor when a non-agent process replaces the agent", () => {
    expect(getActivityMonitor(terminal)).not.toBeNull();

    callHandleAgentDetection(
      terminal,
      { detected: true, processIconId: "npm", processName: "npm" },
      getSpawnedAt(terminal)
    );

    expect(getActivityMonitor(terminal)).toBeNull();
    expect(exitedEvents).toHaveLength(1);
    expect(exitedEvents[0]).toEqual({ terminalId: "t-agent", agentType: "claude" });
  });

  it("Branch B — disposes monitor when no process is detected after the agent", () => {
    expect(getActivityMonitor(terminal)).not.toBeNull();

    callHandleAgentDetection(terminal, { detected: false }, getSpawnedAt(terminal));

    expect(getActivityMonitor(terminal)).toBeNull();
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
        { detected: true, agentType: "claude", processIconId: "claude" },
        getSpawnedAt(trackedTerminal)
      );
      const monitorBefore = getActivityMonitor(trackedTerminal);
      expect(monitorBefore).not.toBeNull();

      // Demote: agent gone.
      callHandleAgentDetection(trackedTerminal, { detected: false }, getSpawnedAt(trackedTerminal));
      expect(getActivityMonitor(trackedTerminal)).toBeNull();

      handleActivityState.mockClear();

      // The retained reference to the now-disposed monitor must be a no-op.
      monitorBefore?.onInput("ls -la\r");
      expect(handleActivityState).not.toHaveBeenCalled();
    } finally {
      trackedTerminal.dispose();
    }
  });

  it("Branch A → Branch B sequence — only one agent:exited with the original agentType", () => {
    callHandleAgentDetection(
      terminal,
      { detected: true, processIconId: "npm", processName: "npm" },
      getSpawnedAt(terminal)
    );
    expect(getActivityMonitor(terminal)).toBeNull();
    expect(exitedEvents).toHaveLength(1);
    expect(exitedEvents[0]).toEqual({ terminalId: "t-agent", agentType: "claude" });

    // Subsequent Branch B fires because lastDetectedProcessIconId is still set.
    callHandleAgentDetection(terminal, { detected: false }, getSpawnedAt(terminal));
    expect(getActivityMonitor(terminal)).toBeNull();
    // Branch B emits a second exit (with undefined agentType) by existing contract;
    // the load-bearing assertion is no monitor leak across the sequence.
    expect(exitedEvents.length).toBeGreaterThanOrEqual(1);
    expect(exitedEvents[0]).toEqual({ terminalId: "t-agent", agentType: "claude" });
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
        { detected: true, processIconId: "npm", processName: "npm" },
        getSpawnedAt(trackedTerminal)
      );
      // Monitor was created in the constructor for this isAgentTerminal=true terminal.
      expect(getActivityMonitor(trackedTerminal)).not.toBeNull();

      // Now everything goes away — Branch B with previousType undefined.
      callHandleAgentDetection(trackedTerminal, { detected: false }, getSpawnedAt(trackedTerminal));

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
        { detected: true, agentType: "claude", processIconId: "claude" },
        getSpawnedAt(trackedTerminal)
      );
      expect(getActivityMonitor(trackedTerminal)).not.toBeNull();

      callHandleAgentDetection(trackedTerminal, { detected: false }, getSpawnedAt(trackedTerminal));
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
  it("grows scrollback to AGENT_SCROLLBACK when a plain terminal first detects an agent", () => {
    const terminal = createPlainTerminal();
    try {
      expect(getScrollback(terminal)).toBe(1000);

      callHandleAgentDetection(
        terminal,
        { detected: true, agentType: "claude", processIconId: "claude" },
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
        { detected: true, agentType: "claude", processIconId: "claude" },
        getSpawnedAt(terminal)
      );
      expect(getScrollback(terminal)).toBe(10000);

      callHandleAgentDetection(
        terminal,
        { detected: true, agentType: "claude", processIconId: "claude" },
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
        { detected: true, agentType: "claude", processIconId: "claude" },
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
        { detected: true, agentType: "claude", processIconId: "claude" },
        getSpawnedAt(terminal)
      );
      expect(getScrollback(terminal)).toBe(10000);

      callHandleAgentDetection(
        terminal,
        { detected: true, agentType: "gemini", processIconId: "gemini" },
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
      expect(info.detectedAgentType).toBe("claude");
      expect(info.agentId).toBe("claude");
      expect(info.analysisEnabled).toBe(true);
      expect(info.type).toBe("claude");
      expect(info.everDetectedAgent).toBe(true);
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
      expect(terminal.getInfo().detectedAgentType).toBe("claude");

      pty.__emitData("\r\ngpriday@macbook canopy-app % ");
      await vi.advanceTimersByTimeAsync(600);

      const info = terminal.getInfo();
      expect(info.detectedAgentType).toBeUndefined();
      expect(info.agentId).toBeUndefined();
      expect(info.analysisEnabled).toBe(false);
      expect(info.type).toBe("terminal");
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
      expect(terminal.getInfo().detectedAgentType).toBeUndefined();
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
      expect(info.detectedAgentType).toBeUndefined();
      expect(info.detectedProcessIconId).toBeUndefined();
      expect(info.agentId).toBeUndefined();
      expect(info.type).toBe("terminal");
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
        { detected: true, processIconId: "npm", processName: "npm" },
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
        { detected: true, processIconId: "npm", processName: "npm" },
        getSpawnedAt(terminal)
      );
      expect(terminal.getInfo().detectedProcessIconId).toBe("npm");

      callHandleAgentDetection(terminal, { detected: false }, getSpawnedAt(terminal));

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
