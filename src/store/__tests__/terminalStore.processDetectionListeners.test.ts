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
    onActivity: onActivityMock,
    onTrashed: onTrashedMock,
    onRestored: onRestoredMock,
    onStatus: onStatusMock,
    onBackendCrashed: onBackendCrashedMock,
    onBackendReady: onBackendReadyMock,
    onSpawnResult: onSpawnResultMock,
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
  },
}));

const { useTerminalStore, setupTerminalStoreListeners, cleanupTerminalStoreListeners } =
  await import("../terminalStore");

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

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          kind: "terminal",
          title: "Terminal",
          cwd: "/tmp",
          cols: 80,
          rows: 24,
          location: "grid",
          detectedProcessId: undefined,
        },
      ],
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

    expect(useTerminalStore.getState().terminals[0]?.detectedProcessId).toBe("npm");

    detected?.({
      terminalId: "term-1",
      processIconId: "npm",
      processName: "npm",
      timestamp: Date.now(),
    });

    expect(useTerminalStore.getState().terminals[0]?.detectedProcessId).toBe("npm");
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
    expect(useTerminalStore.getState().terminals[0]?.detectedProcessId).toBe("claude");

    exited?.({
      terminalId: "term-1",
      timestamp: Date.now(),
    });
    expect(useTerminalStore.getState().terminals[0]?.detectedProcessId).toBeUndefined();
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
});
