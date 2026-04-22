// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AgentStateHandler = (data: {
  terminalId: string;
  state: string;
  timestamp: number;
  trigger: string;
  confidence: number;
}) => void;
type AgentDetectedHandler = (data: {
  terminalId: string;
  agentType?: string;
  processIconId?: string;
  processName: string;
  timestamp: number;
}) => void;
type AgentExitedHandler = (data: { terminalId: string; timestamp: number }) => void;
type ActivityHandler = (data: {
  terminalId: string;
  headline: string;
  status: "working" | "waiting" | "success" | "failure";
  type: "interactive" | "background" | "idle";
  timestamp: number;
  lastCommand?: string;
}) => void;
type TrashedHandler = (data: { id: string; expiresAt: number }) => void;
type RestoredHandler = (data: { id: string }) => void;
type ExitHandler = (id: string, exitCode: number) => void;
type StatusHandler = (data: { id: string; status: string; timestamp: number }) => void;
type BackendCrashedHandler = (data: {
  crashType: string;
  code: number | null;
  signal: string | null;
  timestamp: number;
}) => void;
type BackendReadyHandler = () => void;
type SpawnResultHandler = (id: string, result: { success: boolean; error?: unknown }) => void;

const handlers: {
  agentStateChanged?: AgentStateHandler;
  agentDetected?: AgentDetectedHandler;
  agentExited?: AgentExitedHandler;
  activity?: ActivityHandler;
  trashed?: TrashedHandler;
  restored?: RestoredHandler;
  exit?: ExitHandler;
  status?: StatusHandler;
  backendCrashed?: BackendCrashedHandler;
  backendReady?: BackendReadyHandler;
  spawnResult?: SpawnResultHandler;
} = {};

const unsubs = {
  agentStateChanged: vi.fn(),
  agentDetected: vi.fn(),
  agentExited: vi.fn(),
  activity: vi.fn(),
  trashed: vi.fn(),
  restored: vi.fn(),
  exit: vi.fn(),
  status: vi.fn(),
  backendCrashed: vi.fn(),
  backendReady: vi.fn(),
  spawnResult: vi.fn(),
};

const onAgentStateChangedMock = vi.fn((cb: AgentStateHandler) => {
  handlers.agentStateChanged = cb;
  return unsubs.agentStateChanged;
});
const onAgentDetectedMock = vi.fn((cb: AgentDetectedHandler) => {
  handlers.agentDetected = cb;
  return unsubs.agentDetected;
});
const onAgentExitedMock = vi.fn((cb: AgentExitedHandler) => {
  handlers.agentExited = cb;
  return unsubs.agentExited;
});
const onActivityMock = vi.fn((cb: ActivityHandler) => {
  handlers.activity = cb;
  return unsubs.activity;
});
const onTrashedMock = vi.fn((cb: TrashedHandler) => {
  handlers.trashed = cb;
  return unsubs.trashed;
});
const onRestoredMock = vi.fn((cb: RestoredHandler) => {
  handlers.restored = cb;
  return unsubs.restored;
});
const onExitMock = vi.fn((cb: ExitHandler) => {
  handlers.exit = cb;
  return unsubs.exit;
});
const onStatusMock = vi.fn((cb: StatusHandler) => {
  handlers.status = cb;
  return unsubs.status;
});
const onBackendCrashedMock = vi.fn((cb: BackendCrashedHandler) => {
  handlers.backendCrashed = cb;
  return unsubs.backendCrashed;
});
const onBackendReadyMock = vi.fn((cb: BackendReadyHandler) => {
  handlers.backendReady = cb;
  return unsubs.backendReady;
});
const onSpawnResultMock = vi.fn((cb: SpawnResultHandler) => {
  handlers.spawnResult = cb;
  return unsubs.spawnResult;
});

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn().mockResolvedValue("term-1"),
    write: vi.fn(),
    submit: vi.fn(),
    sendKey: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(true),
    setActivityTier: vi.fn(),
    wake: vi.fn().mockResolvedValue({ state: null }),
    getForProject: vi.fn().mockResolvedValue([]),
    reconnect: vi.fn().mockResolvedValue({ exists: false }),
    replayHistory: vi.fn().mockResolvedValue({ replayed: 0 }),
    forceResume: vi.fn().mockResolvedValue({ success: true }),
    onData: vi.fn(() => vi.fn()),
    onExit: onExitMock,
    onAgentStateChanged: onAgentStateChangedMock,
    onAgentDetected: onAgentDetectedMock,
    onAgentExited: onAgentExitedMock,
    onFallbackTriggered: vi.fn(() => vi.fn()),
    onActivity: onActivityMock,
    onTrashed: onTrashedMock,
    onRestored: onRestoredMock,
    onStatus: onStatusMock,
    onBackendCrashed: onBackendCrashedMock,
    onBackendReady: onBackendReadyMock,
    onSpawnResult: onSpawnResultMock,
    onReduceScrollback: vi.fn(() => vi.fn()),
    onRestoreScrollback: vi.fn(() => vi.fn()),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    getTabGroups: vi.fn().mockResolvedValue([]),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getTerminalSizes: vi.fn().mockResolvedValue({}),
    setTerminalSizes: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

const applyAgentPromotionMock = vi.fn();

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    prewarmTerminal: vi.fn(),
    sendPtyResize: vi.fn(),
    applyRendererPolicy: vi.fn(),
    setInputLocked: vi.fn(),
    destroy: vi.fn(),
    suppressNextExit: vi.fn(),
    waitForInstance: vi.fn().mockResolvedValue(undefined),
    fit: vi.fn(),
    get: vi.fn(),
    wake: vi.fn(),
    setAgentState: vi.fn(),
    notifyUserInput: vi.fn(),
    suppressResizesDuringProjectSwitch: vi.fn(),
    detachForProjectSwitch: vi.fn(),
    handleBackendRecovery: vi.fn(),
    cleanup: vi.fn(),
    applyAgentPromotion: applyAgentPromotionMock,
  },
}));

// Mock window.electron for resource monitoring listener
(globalThis as Record<string, unknown>).window = globalThis.window ?? {};
(window as unknown as Record<string, unknown>).electron = {
  terminal: {
    onResourceMetrics: vi.fn(() => vi.fn()),
    onReclaimMemory: vi.fn(() => vi.fn()),
  },
  terminalConfig: {
    get: vi.fn().mockResolvedValue({}),
    setResourceMonitoring: vi.fn(),
  },
};

const { usePanelStore, setupTerminalStoreListeners, cleanupTerminalStoreListeners } =
  await import("../panelStore");

describe("terminalStore process detection listeners", () => {
  beforeEach(() => {
    cleanupTerminalStoreListeners();
    vi.clearAllMocks();

    handlers.agentStateChanged = undefined;
    handlers.agentDetected = undefined;
    handlers.agentExited = undefined;
    handlers.activity = undefined;
    handlers.trashed = undefined;
    handlers.restored = undefined;
    handlers.exit = undefined;
    handlers.status = undefined;
    handlers.backendCrashed = undefined;
    handlers.backendReady = undefined;
    handlers.spawnResult = undefined;

    const term1 = {
      id: "term-1",
      type: "terminal" as const,
      kind: "terminal" as const,
      title: "Terminal",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      location: "grid" as const,
      detectedProcessId: undefined,
    };
    usePanelStore.setState({
      panelsById: { "term-1": term1 },
      panelIds: ["term-1"],
      focusedId: "term-1",
      maximizedId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    cleanupTerminalStoreListeners();
  });

  it("stores detectedProcessId when agent:detected events arrive", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;

    expect(detected).toBeDefined();
    expect(onAgentDetectedMock).toHaveBeenCalledTimes(1);

    detected?.({
      terminalId: "term-1",
      processIconId: "npm",
      processName: "npm",
      timestamp: Date.now(),
    });

    expect(usePanelStore.getState().panelsById["term-1"]?.detectedProcessId).toBe("npm");

    detected?.({
      terminalId: "term-1",
      processIconId: "npm",
      processName: "npm",
      timestamp: Date.now(),
    });

    expect(usePanelStore.getState().panelsById["term-1"]?.detectedProcessId).toBe("npm");
    cleanup();
  });

  it("clears detectedProcessId on agent:exited", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;
    const exited = handlers.agentExited;

    detected?.({
      terminalId: "term-1",
      processIconId: "claude",
      processName: "claude",
      timestamp: Date.now(),
    });
    expect(usePanelStore.getState().panelsById["term-1"]?.detectedProcessId).toBe("claude");

    exited?.({
      terminalId: "term-1",
      timestamp: Date.now(),
    });
    expect(usePanelStore.getState().panelsById["term-1"]?.detectedProcessId).toBeUndefined();
    cleanup();
  });

  // Regression for #5765: once runtime detection sees an agent, the renderer must
  // mirror the sticky everDetectedAgent flag so the onExit guard can preserve the
  // panel even if snapshot IPC lags behind the exit event.
  it("sets everDetectedAgent when agent:detected carries an agentType", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;

    detected?.({
      terminalId: "term-1",
      agentType: "claude",
      processIconId: "claude",
      processName: "claude",
      timestamp: Date.now(),
    });

    expect(usePanelStore.getState().panelsById["term-1"]?.everDetectedAgent).toBe(true);
    cleanup();
  });

  it("does not set everDetectedAgent for non-agent detections", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;

    detected?.({
      terminalId: "term-1",
      processIconId: "npm",
      processName: "npm",
      timestamp: Date.now(),
    });

    expect(usePanelStore.getState().panelsById["term-1"]?.everDetectedAgent).toBeUndefined();
    cleanup();
  });

  it("stores detectedAgentId when agent:detected carries a BuiltInAgentId", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;

    detected?.({
      terminalId: "term-1",
      agentType: "claude",
      processIconId: "claude",
      processName: "claude",
      timestamp: Date.now(),
    });

    expect(usePanelStore.getState().panelsById["term-1"]?.detectedAgentId).toBe("claude");
    cleanup();
  });

  it("ignores unknown agentType values for detectedAgentId", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;

    detected?.({
      terminalId: "term-1",
      agentType: "not-a-real-agent",
      processIconId: "mystery",
      processName: "mystery",
      timestamp: Date.now(),
    });

    expect(usePanelStore.getState().panelsById["term-1"]?.detectedAgentId).toBeUndefined();
    cleanup();
  });

  it("does not set detectedAgentId for non-agent detections", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;

    detected?.({
      terminalId: "term-1",
      processIconId: "npm",
      processName: "npm",
      timestamp: Date.now(),
    });

    expect(usePanelStore.getState().panelsById["term-1"]?.detectedAgentId).toBeUndefined();
    cleanup();
  });

  it("clears detectedAgentId when agent:exited fires", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;
    const exited = handlers.agentExited;

    detected?.({
      terminalId: "term-1",
      agentType: "gemini",
      processIconId: "gemini",
      processName: "gemini",
      timestamp: Date.now(),
    });
    expect(usePanelStore.getState().panelsById["term-1"]?.detectedAgentId).toBe("gemini");

    exited?.({ terminalId: "term-1", timestamp: Date.now() });
    expect(usePanelStore.getState().panelsById["term-1"]?.detectedAgentId).toBeUndefined();
    cleanup();
  });

  // Issue #5776: when a plain terminal is runtime-promoted to host an agent,
  // the renderer must apply the agent scrollback policy to the live xterm —
  // the only in-process repair available for spawn-sealed terminals.
  it("calls applyAgentPromotion when a plain terminal (no agentId) detects a built-in agent", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;

    applyAgentPromotionMock.mockClear();

    detected?.({
      terminalId: "term-1",
      agentType: "claude",
      processIconId: "claude",
      processName: "claude",
      timestamp: Date.now(),
    });

    expect(applyAgentPromotionMock).toHaveBeenCalledWith("term-1", "claude");
    cleanup();
  });

  it("does not call applyAgentPromotion for cold-spawned agent panels (agentId set at spawn)", () => {
    usePanelStore.setState((s) => ({
      panelsById: {
        ...s.panelsById,
        "term-1": { ...s.panelsById["term-1"]!, agentId: "claude" },
      },
    }));

    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;

    applyAgentPromotionMock.mockClear();

    detected?.({
      terminalId: "term-1",
      agentType: "claude",
      processIconId: "claude",
      processName: "claude",
      timestamp: Date.now(),
    });

    expect(applyAgentPromotionMock).not.toHaveBeenCalled();
    cleanup();
  });

  it("does not call applyAgentPromotion when agentType is not a built-in agent", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;

    applyAgentPromotionMock.mockClear();

    detected?.({
      terminalId: "term-1",
      agentType: "not-a-real-agent",
      processIconId: "mystery",
      processName: "mystery",
      timestamp: Date.now(),
    });

    expect(applyAgentPromotionMock).not.toHaveBeenCalled();
    cleanup();
  });

  it("keeps everDetectedAgent true after agent:exited fires (sticky flag)", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;
    const exited = handlers.agentExited;

    detected?.({
      terminalId: "term-1",
      agentType: "claude",
      processIconId: "claude",
      processName: "claude",
      timestamp: Date.now(),
    });
    expect(usePanelStore.getState().panelsById["term-1"]?.everDetectedAgent).toBe(true);

    exited?.({ terminalId: "term-1", timestamp: Date.now() });
    expect(usePanelStore.getState().panelsById["term-1"]?.everDetectedAgent).toBe(true);
    cleanup();
  });

  // End-to-end regression for #5765: a plain terminal that ran an agent must not
  // be trashed on clean exit — the sticky flag is what the onExit handler reads.
  it("does not trash a plain terminal on clean exit after an agent was detected", () => {
    const cleanup = setupTerminalStoreListeners();
    const detected = handlers.agentDetected;
    const exit = handlers.exit;

    detected?.({
      terminalId: "term-1",
      agentType: "claude",
      processIconId: "claude",
      processName: "claude",
      timestamp: Date.now(),
    });

    exit?.("term-1", 0);

    const panel = usePanelStore.getState().panelsById["term-1"];
    expect(panel).toBeDefined();
    expect(panel?.location).not.toBe("trash");
    expect(panel?.everDetectedAgent).toBe(true);
    cleanup();
  });

  it("still trashes a plain terminal on clean exit when no agent was ever detected", () => {
    const cleanup = setupTerminalStoreListeners();
    const exit = handlers.exit;

    exit?.("term-1", 0);

    const panel = usePanelStore.getState().panelsById["term-1"];
    // Either moved to trash (location === "trash") or removed entirely.
    expect(panel === undefined || panel.location === "trash").toBe(true);
    cleanup();
  });

  it("is idempotent and does not register duplicate listeners", () => {
    const cleanupA = setupTerminalStoreListeners();
    const cleanupB = setupTerminalStoreListeners();

    expect(onAgentDetectedMock).toHaveBeenCalledTimes(1);
    expect(onAgentExitedMock).toHaveBeenCalledTimes(1);

    cleanupA();
    cleanupB();
  });

  describe("flow status wake behavior", () => {
    let terminalInstanceService: { wake: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      const mod = await import("@/services/TerminalInstanceService");
      terminalInstanceService =
        mod.terminalInstanceService as unknown as typeof terminalInstanceService;
    });

    it("calls wake on suspended status", () => {
      const cleanup = setupTerminalStoreListeners();
      handlers.status?.({ id: "term-1", status: "suspended", timestamp: Date.now() });
      expect(terminalInstanceService.wake).toHaveBeenCalledWith("term-1");
      cleanup();
    });

    it("calls wake on paused-backpressure status", () => {
      const cleanup = setupTerminalStoreListeners();
      handlers.status?.({ id: "term-1", status: "paused-backpressure", timestamp: Date.now() });
      expect(terminalInstanceService.wake).toHaveBeenCalledWith("term-1");
      cleanup();
    });

    it("does not call wake on paused-user status", () => {
      const cleanup = setupTerminalStoreListeners();
      handlers.status?.({ id: "term-1", status: "paused-user", timestamp: Date.now() });
      expect(terminalInstanceService.wake).not.toHaveBeenCalled();
      cleanup();
    });

    it("does not call wake on running status", () => {
      const cleanup = setupTerminalStoreListeners();
      handlers.status?.({ id: "term-1", status: "running", timestamp: Date.now() });
      expect(terminalInstanceService.wake).not.toHaveBeenCalled();
      cleanup();
    });
  });
});
