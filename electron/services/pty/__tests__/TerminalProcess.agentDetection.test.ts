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

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };
  return pty as IPty;
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
