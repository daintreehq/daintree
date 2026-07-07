// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockMcpOnTierNotPermitted,
  mockMcpOnToolCallStarted,
  mockMcpOnToolCallSettled,
  mockMcpOnDisplayImage,
  mockMcpOnSessionRevoked,
  mockMcpOnGrantLifecycle,
  mockMcpOnTurnOutcomeAlert,
  mockMcpSetSessionTier,
  mockMcpIssueGrant,
  mockMcpResetDenialCounts,
  mockMcpRevokeSessionGrants,
  mockSystemSleepOnSuspend,
  mockSystemSleepOnWake,
  systemSleepListeners,
  tierListeners,
  toolStartedListeners,
  toolSettledListeners,
  displayImageListeners,
  sessionRevokedListeners,
  grantLifecycleListeners,
  outcomeAlertListeners,
  helpPanelState,
  panelStoreState,
  projectStoreState,
} = vi.hoisted(() => ({
  mockMcpOnTierNotPermitted: vi.fn(),
  mockMcpOnToolCallStarted: vi.fn(),
  mockMcpOnToolCallSettled: vi.fn(),
  mockMcpOnDisplayImage: vi.fn(),
  mockMcpOnSessionRevoked: vi.fn(),
  mockMcpOnGrantLifecycle: vi.fn(),
  mockMcpOnTurnOutcomeAlert: vi.fn(),
  mockMcpSetSessionTier: vi.fn().mockResolvedValue(undefined),
  mockMcpIssueGrant: vi.fn().mockResolvedValue({
    sessionId: "",
    toolId: "",
    ttlMs: 900_000,
    expiresAt: Date.now() + 900_000,
  }),
  mockMcpResetDenialCounts: vi.fn().mockResolvedValue(undefined),
  mockMcpRevokeSessionGrants: vi.fn().mockResolvedValue({ sessionId: "", revokedCount: 0 }),
  mockSystemSleepOnSuspend: vi.fn(),
  mockSystemSleepOnWake: vi.fn(),
  systemSleepListeners: {
    suspend: [] as Array<() => void>,
    wake: [] as Array<() => void>,
  },
  tierListeners: [] as Array<(payload: unknown) => void>,
  toolStartedListeners: [] as Array<(payload: unknown) => void>,
  toolSettledListeners: [] as Array<(payload: unknown) => void>,
  displayImageListeners: [] as Array<(payload: unknown) => void>,
  sessionRevokedListeners: [] as Array<(payload: unknown) => void>,
  grantLifecycleListeners: [] as Array<(payload: unknown) => void>,
  outcomeAlertListeners: [] as Array<(payload: unknown) => void>,
  helpPanelState: {
    isOpen: false,
    terminalId: null as string | null,
    agentId: null as string | null,
    preferredAgentId: null as string | null,
    sessionId: null as string | null,
    hibernateSessions: {} as Record<string, unknown>,
    setTerminal: vi.fn(),
    clearTerminal: vi.fn(),
    clearFigures: vi.fn(),
    setHibernateSession: vi.fn(),
    clearHibernateSession: vi.fn(),
  },
  panelStoreState: {
    panelIds: [] as string[],
    panelsById: {} as Record<string, unknown>,
    removePanel: vi.fn(),
    addPanel: vi.fn().mockResolvedValue(""),
  },
  projectStoreState: {
    currentProject: null as { id: string; path: string } | null,
  },
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) =>
    ({
      claude: { name: "Claude", assistantMinVersion: "1.0.0" },
      "daintree-assistant": { name: "Daintree Assistant", assistantMinVersion: "1.0.0" },
    })[id],
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(), getContext: vi.fn() },
}));

vi.mock("@/store/helpPanelStore", () => {
  const store = (selector?: (s: typeof helpPanelState) => unknown) =>
    selector ? selector(helpPanelState) : helpPanelState;
  store.getState = () => helpPanelState;
  return { useHelpPanelStore: store };
});

vi.mock("@/store", () => {
  const panelStore = (selector?: (s: typeof panelStoreState) => unknown) =>
    selector ? selector(panelStoreState) : panelStoreState;
  panelStore.getState = () => panelStoreState;

  const projectStore = (selector?: (s: typeof projectStoreState) => unknown) =>
    selector ? selector(projectStoreState) : projectStoreState;
  projectStore.getState = () => projectStoreState;

  return { usePanelStore: panelStore, useProjectStore: projectStore };
});

vi.mock("@/clients/projectClient", () => ({
  projectClient: {
    getSettings: vi.fn().mockResolvedValue({}),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));
vi.mock("@/utils/safeFireAndForget", () => ({
  safeFireAndForget: (p: Promise<unknown>) => p,
}));

import { HelpSessionController, loadCustomLaunchFlags } from "../HelpSessionController";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";

function resetState() {
  helpPanelState.isOpen = false;
  helpPanelState.terminalId = null;
  helpPanelState.agentId = null;
  helpPanelState.preferredAgentId = null;
  helpPanelState.sessionId = null;
  helpPanelState.hibernateSessions = {};
  helpPanelState.setTerminal = vi.fn();
  helpPanelState.clearTerminal = vi.fn();
  helpPanelState.clearFigures = vi.fn();
  helpPanelState.setHibernateSession = vi.fn();
  helpPanelState.clearHibernateSession = vi.fn();
  panelStoreState.panelIds = [];
  panelStoreState.panelsById = {};
  panelStoreState.removePanel = vi.fn();
  panelStoreState.addPanel = vi.fn().mockResolvedValue("");
  projectStoreState.currentProject = null;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  systemSleepListeners.suspend.length = 0;
  systemSleepListeners.wake.length = 0;
  tierListeners.length = 0;
  toolStartedListeners.length = 0;
  toolSettledListeners.length = 0;
  displayImageListeners.length = 0;
  sessionRevokedListeners.length = 0;
  grantLifecycleListeners.length = 0;
  outcomeAlertListeners.length = 0;

  mockMcpOnTierNotPermitted.mockReset();
  mockMcpOnTierNotPermitted.mockImplementation((cb: (payload: unknown) => void) => {
    tierListeners.push(cb);
    return () => {
      const idx = tierListeners.indexOf(cb);
      if (idx >= 0) tierListeners.splice(idx, 1);
    };
  });
  mockMcpOnToolCallStarted.mockReset();
  mockMcpOnToolCallStarted.mockImplementation((cb: (payload: unknown) => void) => {
    toolStartedListeners.push(cb);
    return () => {
      const idx = toolStartedListeners.indexOf(cb);
      if (idx >= 0) toolStartedListeners.splice(idx, 1);
    };
  });
  mockMcpOnToolCallSettled.mockReset();
  mockMcpOnToolCallSettled.mockImplementation((cb: (payload: unknown) => void) => {
    toolSettledListeners.push(cb);
    return () => {
      const idx = toolSettledListeners.indexOf(cb);
      if (idx >= 0) toolSettledListeners.splice(idx, 1);
    };
  });
  mockMcpOnDisplayImage.mockReset();
  mockMcpOnDisplayImage.mockImplementation((cb: (payload: unknown) => void) => {
    displayImageListeners.push(cb);
    return () => {
      const idx = displayImageListeners.indexOf(cb);
      if (idx >= 0) displayImageListeners.splice(idx, 1);
    };
  });
  mockMcpOnSessionRevoked.mockReset();
  mockMcpOnSessionRevoked.mockImplementation((cb: (payload: unknown) => void) => {
    sessionRevokedListeners.push(cb);
    return () => {
      const idx = sessionRevokedListeners.indexOf(cb);
      if (idx >= 0) sessionRevokedListeners.splice(idx, 1);
    };
  });
  mockMcpResetDenialCounts.mockReset();
  mockMcpResetDenialCounts.mockResolvedValue(undefined);
  mockMcpOnGrantLifecycle.mockReset();
  mockMcpOnGrantLifecycle.mockImplementation((cb: (payload: unknown) => void) => {
    grantLifecycleListeners.push(cb);
    return () => {
      const idx = grantLifecycleListeners.indexOf(cb);
      if (idx >= 0) grantLifecycleListeners.splice(idx, 1);
    };
  });
  mockMcpOnTurnOutcomeAlert.mockReset();
  mockMcpOnTurnOutcomeAlert.mockImplementation((cb: (payload: unknown) => void) => {
    outcomeAlertListeners.push(cb);
    return () => {
      const idx = outcomeAlertListeners.indexOf(cb);
      if (idx >= 0) outcomeAlertListeners.splice(idx, 1);
    };
  });
  mockMcpSetSessionTier.mockReset();
  mockMcpSetSessionTier.mockResolvedValue(undefined);
  mockMcpIssueGrant.mockReset();
  mockMcpIssueGrant.mockResolvedValue({
    sessionId: "",
    toolId: "",
    ttlMs: 900_000,
    expiresAt: Date.now() + 900_000,
  });
  mockMcpRevokeSessionGrants.mockReset();
  mockMcpRevokeSessionGrants.mockResolvedValue({ sessionId: "", revokedCount: 1 });
  mockSystemSleepOnSuspend.mockReset();
  mockSystemSleepOnSuspend.mockImplementation((cb: () => void) => {
    systemSleepListeners.suspend.push(cb);
    return () => {
      const idx = systemSleepListeners.suspend.indexOf(cb);
      if (idx >= 0) systemSleepListeners.suspend.splice(idx, 1);
    };
  });
  mockSystemSleepOnWake.mockReset();
  mockSystemSleepOnWake.mockImplementation((cb: () => void) => {
    systemSleepListeners.wake.push(cb);
    return () => {
      const idx = systemSleepListeners.wake.indexOf(cb);
      if (idx >= 0) systemSleepListeners.wake.splice(idx, 1);
    };
  });

  Object.defineProperty(globalThis, "window", {
    value: {
      electron: {
        help: {
          getFolderPath: vi.fn().mockResolvedValue("/help"),
          markTerminal: vi.fn().mockResolvedValue(undefined),
          provisionSession: vi.fn().mockResolvedValue(null),
          revokeSession: vi.fn().mockResolvedValue(undefined),
          takePendingHibernation: vi.fn().mockResolvedValue(null),
        },
        helpAssistant: {
          getSettings: vi.fn().mockResolvedValue({ idleHibernateMinutes: 30 }),
        },
        system: {
          getAgentVersion: vi
            .fn()
            .mockResolvedValue({ installedVersion: null, latestVersion: null }),
        },
        systemSleep: {
          getMetrics: vi.fn().mockResolvedValue({ isCurrentlySleeping: false }),
          onSuspend: mockSystemSleepOnSuspend,
          onWake: mockSystemSleepOnWake,
        },
        mcpServer: {
          onTierNotPermitted: mockMcpOnTierNotPermitted,
          onToolCallStarted: mockMcpOnToolCallStarted,
          onToolCallSettled: mockMcpOnToolCallSettled,
          onDisplayImage: mockMcpOnDisplayImage,
          onSessionRevoked: mockMcpOnSessionRevoked,
          onGrantLifecycle: mockMcpOnGrantLifecycle,
          onTurnOutcomeAlert: mockMcpOnTurnOutcomeAlert,
          setSessionTier: mockMcpSetSessionTier,
          issueGrant: mockMcpIssueGrant,
          resetDenialCounts: mockMcpResetDenialCounts,
          revokeSessionGrants: mockMcpRevokeSessionGrants,
        },
        git: { snapshotGet: vi.fn().mockResolvedValue(null) },
        terminal: { gracefulKill: vi.fn().mockResolvedValue(null) },
      },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  // Defensive: any test that didn't stop its controller would leak listeners.
});

describe("HelpSessionController — lifecycle", () => {
  it("start() arms tier-mismatch and system-sleep subscriptions", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    expect(mockMcpOnTierNotPermitted).toHaveBeenCalledTimes(1);
    expect(mockSystemSleepOnSuspend).toHaveBeenCalledTimes(1);
    expect(mockSystemSleepOnWake).toHaveBeenCalledTimes(1);
    ctrl.stop();
  });

  it("start() is idempotent across StrictMode double-mount (no duplicate listeners)", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl.start();
    ctrl.start();
    expect(mockMcpOnTierNotPermitted).toHaveBeenCalledTimes(1);
    expect(mockSystemSleepOnSuspend).toHaveBeenCalledTimes(1);
    ctrl.stop();
  });

  it("stop() unsubscribes every disposer registered by start()", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    expect(tierListeners).toHaveLength(1);
    expect(toolStartedListeners).toHaveLength(1);
    expect(toolSettledListeners).toHaveLength(1);
    expect(displayImageListeners).toHaveLength(1);
    expect(sessionRevokedListeners).toHaveLength(1);
    expect(grantLifecycleListeners).toHaveLength(1);
    expect(systemSleepListeners.suspend).toHaveLength(1);
    expect(systemSleepListeners.wake).toHaveLength(1);
    ctrl.stop();
    expect(tierListeners).toHaveLength(0);
    expect(toolStartedListeners).toHaveLength(0);
    expect(toolSettledListeners).toHaveLength(0);
    expect(displayImageListeners).toHaveLength(0);
    expect(sessionRevokedListeners).toHaveLength(0);
    expect(grantLifecycleListeners).toHaveLength(0);
    expect(systemSleepListeners.suspend).toHaveLength(0);
    expect(systemSleepListeners.wake).toHaveLength(0);
  });

  it("stop() is safe to call when start() has not run", () => {
    const ctrl = new HelpSessionController();
    expect(() => ctrl.stop()).not.toThrow();
  });
});

describe("HelpSessionController — subscribe / getSnapshot", () => {
  it("snapshot is initially in the idle state with no banners", () => {
    const ctrl = new HelpSessionController();
    const snap = ctrl.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.showResumeBanner).toBe(false);
    expect(snap.assistantVersionTooOld).toBeNull();
    expect(snap.tierMismatch).toBeNull();
    expect(snap.preflightSnapshot).toBeNull();
    expect(snap.isApprovingTier).toBe(false);
    expect(snap.isCheckingVersion).toBe(false);
    expect(snap.launchError).toBeNull();
    expect(snap.mcpActivity).toBeNull();
    expect(snap.sessionRevoked).toBeNull();
  });

  it("returns the same snapshot reference when no state changes (Object.is stable)", () => {
    const ctrl = new HelpSessionController();
    const a = ctrl.getSnapshot();
    const b = ctrl.getSnapshot();
    expect(a).toBe(b);
  });

  it("notifies listeners when state changes via patch", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    const listener = vi.fn();
    const unsubscribe = ctrl.subscribe(listener);

    // Simulate a tier-mismatch event firing
    const fire = tierListeners[0]!;
    fire({ sessionId: "s1", toolId: "t1", tier: "workbench", targetTier: "action" });
    expect(listener).toHaveBeenCalled();
    expect(ctrl.getSnapshot().tierMismatch).toEqual({
      sessionId: "s1",
      toolId: "t1",
      tier: "workbench",
      targetTier: "action",
      projectId: null,
    });

    listener.mockClear();
    ctrl.dismissTierMismatch();
    expect(listener).toHaveBeenCalled();
    expect(ctrl.getSnapshot().tierMismatch).toBeNull();

    unsubscribe();
    ctrl.stop();
  });

  it("subscribe returns a stable unsubscribe function that removes only that listener", () => {
    const ctrl = new HelpSessionController();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = ctrl.subscribe(a);
    ctrl.subscribe(b);
    unsubA();
    ctrl.dismissTierMismatch(); // currently null → no notify
    ctrl["_patch"]({ showResumeBanner: true });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });
});

describe("HelpSessionController — turn-outcome alert pip", () => {
  function fireOutcome(payload: { helpSessionId: string; outcome: string; turnId?: string }) {
    outcomeAlertListeners[0]!(payload);
  }
  function fireToolStart(payload: { turnId?: string }) {
    toolStartedListeners[0]!({
      sessionId: "s1",
      toolId: "agent.getState",
      argsSummary: "{}",
      startedAt: Date.now(),
      danger: false,
      ...payload,
    });
  }

  it("surfaces agent-stuck as outcomeAlert and notifies listeners", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    const listener = vi.fn();
    ctrl.subscribe(listener);
    expect(ctrl.getSnapshot().outcomeAlert).toBeNull();

    fireOutcome({ helpSessionId: "help-1", outcome: "agent-stuck" });
    expect(listener).toHaveBeenCalled();
    expect(ctrl.getSnapshot().outcomeAlert).toBe("agent-stuck");
    ctrl.stop();
  });

  it("surfaces reasoning-loop and clears on user dismiss", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    fireOutcome({ helpSessionId: "help-1", outcome: "reasoning-loop", turnId: "turn-1" });
    expect(ctrl.getSnapshot().outcomeAlert).toBe("reasoning-loop");

    ctrl.dismissOutcomeAlert();
    expect(ctrl.getSnapshot().outcomeAlert).toBeNull();
    ctrl.stop();
  });

  it("auto-clears the pip when a tool call from a different turn starts", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    fireOutcome({ helpSessionId: "help-1", outcome: "reasoning-loop", turnId: "turn-1" });
    expect(ctrl.getSnapshot().outcomeAlert).toBe("reasoning-loop");

    // Same-turn residual call must NOT clear the pip.
    fireToolStart({ turnId: "turn-1" });
    expect(ctrl.getSnapshot().outcomeAlert).toBe("reasoning-loop");

    // A fresh turn means the agent resumed — clear.
    fireToolStart({ turnId: "turn-2" });
    expect(ctrl.getSnapshot().outcomeAlert).toBeNull();
    ctrl.stop();
  });

  it("auto-clears an agent-stuck pip (no turn id) on the next turn-stamped call", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    fireOutcome({ helpSessionId: "help-1", outcome: "agent-stuck" });
    expect(ctrl.getSnapshot().outcomeAlert).toBe("agent-stuck");

    fireToolStart({ turnId: "turn-9" });
    expect(ctrl.getSnapshot().outcomeAlert).toBeNull();
    ctrl.stop();
  });

  it("does not clear the pip for a call with no turn id", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    fireOutcome({ helpSessionId: "help-1", outcome: "reasoning-loop", turnId: "turn-1" });
    fireToolStart({});
    expect(ctrl.getSnapshot().outcomeAlert).toBe("reasoning-loop");
    ctrl.stop();
  });
});

describe("HelpSessionController — syncInputs", () => {
  it("clears the version block when preferredAgentId changes", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_patch"]({
      assistantVersionTooOld: {
        agentId: "claude",
        agentName: "Claude",
        installedVersion: "0.9.0",
        requiredVersion: "1.0.0",
      },
    });
    expect(ctrl.getSnapshot().assistantVersionTooOld).not.toBeNull();

    ctrl.syncInputs({
      isOpen: false,
      isReadyToLaunch: false,
      currentProject: null,
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: [],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });
    expect(ctrl.getSnapshot().assistantVersionTooOld).not.toBeNull();

    ctrl.syncInputs({
      isOpen: false,
      isReadyToLaunch: false,
      currentProject: null,
      terminalId: null,
      preferredAgentId: "codex",
      supportedInstalledAgentIds: [],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });
    expect(ctrl.getSnapshot().assistantVersionTooOld).toBeNull();
    ctrl.stop();
  });
});

describe("HelpSessionController — endSession (Stop assistant, #10989)", () => {
  function bindLiveSession() {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = "sess-bound";
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", cwd: "/help" },
    };
  }

  it("tears the bound session down without relaunching", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "live" });
    bindLiveSession();

    ctrl.endSession();

    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(helpPanelState.clearFigures).toHaveBeenCalled();
    // Stop is destructive, not pause: the persisted hibernate slot is dropped so
    // the discarded conversation can't resume on next open.
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1");
    // No fresh terminal is reserved — unlike newSession(), stop does not relaunch.
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(ctrl.getSnapshot().phase).toBe("idle");
  });

  it("revokes the bearer before killing the PTY (revoke-before-kill, #7522)", () => {
    const ctrl = new HelpSessionController();
    bindLiveSession();

    ctrl.endSession();

    // removePanel fires the PTY kill IPC; the revoke must be dispatched first so
    // an in-flight MCP call 401s before teardown reaches the host.
    const revokeOrder = (window.electron.help.revokeSession as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const removeOrder = (panelStoreState.removePanel as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(revokeOrder).toBeLessThan(removeOrder);
  });

  it("revokes a reserved-but-uncommitted bearer even when no terminal is bound", () => {
    const ctrl = new HelpSessionController();
    ctrl["_pendingSessionId"] = "sess-pending";

    ctrl.endSession();

    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-pending");
    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(ctrl["_pendingSessionId"]).toBeNull();
  });

  it("aborts an in-flight launch by bumping the gen and clearing the guard", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "provisioning" });
    ctrl["_isLaunching"] = true;
    const genBefore = ctrl["_launchGen"] as number;

    ctrl.endSession();

    expect(ctrl["_launchGen"]).toBe(genBefore + 1);
    expect(ctrl["_isLaunching"]).toBe(false);
    expect(ctrl.getSnapshot().phase).toBe("idle");
  });

  it("is a no-op teardown when no terminal is bound", () => {
    const ctrl = new HelpSessionController();

    ctrl.endSession();

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
    expect(ctrl.getSnapshot().phase).toBe("idle");
  });

  it("suppresses an immediate consented auto-relaunch in the same open cycle", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    bindLiveSession();

    ctrl.endSession();
    expect(ctrl["_hasAutoLaunched"]).toBe(true);

    // clearTerminal ran — the store now reports no bound terminal.
    helpPanelState.terminalId = null;
    // The panel is still open with auto-launch consented; without the guard this
    // would immediately respawn the assistant the user just stopped.
    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj-1", path: "/repo" },
      terminalId: null,
      preferredAgentId: null,
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });

    expect(ctrl.getSnapshot().phase).toBe("idle");
    ctrl.stop();
  });

  it("re-arms auto-launch after the panel closes and reopens", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    bindLiveSession();
    ctrl.endSession();
    expect(ctrl["_hasAutoLaunched"]).toBe(true);
    helpPanelState.terminalId = null;

    // Closing the panel resets the per-open-cycle auto-launch budget.
    ctrl.syncInputs({
      isOpen: false,
      isReadyToLaunch: true,
      currentProject: { id: "proj-1", path: "/repo" },
      terminalId: null,
      preferredAgentId: null,
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });

    expect(ctrl["_hasAutoLaunched"]).toBe(false);
    ctrl.stop();
  });
});

describe("HelpSessionController — launch phase FSM", () => {
  it("cancelLaunch() resets phase to idle, clears the launching guard, and bumps the gen", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "provisioning" });
    ctrl["_isLaunching"] = true;
    const genBefore = ctrl["_launchGen"] as number;

    ctrl.cancelLaunch();

    expect(ctrl.getSnapshot().phase).toBe("idle");
    expect(ctrl["_isLaunching"]).toBe(false);
    expect(ctrl["_launchGen"]).toBe(genBefore + 1);
  });

  it("watchdog supersedes a launch stuck on version-checking and surfaces a retryable error", async () => {
    vi.useFakeTimers();
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "claude";
    // Hang the first bridge await so the launch can never leave version-checking
    // — the real-world failure is a CLI version probe that never resolves.
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {})
    );
    try {
      ctrl.syncInputs({
        isOpen: true,
        isReadyToLaunch: true,
        currentProject: { id: "proj", path: "/repo" },
        terminalId: null,
        preferredAgentId: "claude",
        supportedInstalledAgentIds: ["claude"],
        autoLaunchEnabled: true,
        visibilityEpoch: 0,
      });
      expect(ctrl.getSnapshot().phase).toBe("version-checking");
      const genBefore = ctrl["_launchGen"] as number;

      // Below the ceiling the panel is still legitimately loading.
      await vi.advanceTimersByTimeAsync(89_000);
      expect(ctrl.getSnapshot().phase).toBe("version-checking");
      expect(ctrl.getSnapshot().launchError).toBeNull();

      // Past the ceiling the dead-man timer reclaims the stranded FSM.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ctrl.getSnapshot().phase).toBe("idle");
      expect(ctrl.getSnapshot().launchError).toEqual(
        expect.objectContaining({ agentId: "claude", kind: "spawn-failed" })
      );
      // Gen bumped so the stalled flow's eventual await resolves into a bail,
      // and the auto-launch guard is cleared so a retry can re-drive.
      expect(ctrl["_launchGen"]).toBe(genBefore + 1);
      expect(ctrl["_hasAutoLaunched"]).toBe(false);
    } finally {
      ctrl.stop();
      vi.useRealTimers();
    }
  });

  it("re-entrancy guard blocks a current owner but ignores a stale (superseded) one", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: null,
      supportedInstalledAgentIds: [],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });

    // A launch() owned by the CURRENT generation is genuinely in flight → a
    // second launch() must be dropped (no gen bump).
    ctrl["_isLaunching"] = true;
    ctrl["_isLaunchingGen"] = ctrl["_launchGen"] as number;
    const genCurrent = ctrl["_launchGen"] as number;
    ctrl.launch({ agentId: "claude", requestedId: "term-blocked" });
    expect(ctrl["_launchGen"]).toBe(genCurrent);

    // A guard left by a SUPERSEDED launch (its owner generation is stale, e.g.
    // a hung flow the auto-launch path bumped past) must not block forever.
    ctrl["_isLaunching"] = true;
    ctrl["_isLaunchingGen"] = (ctrl["_launchGen"] as number) - 1;
    ctrl.launch({ agentId: "claude", requestedId: "term-allowed" });
    expect(ctrl["_launchGen"]).toBe(genCurrent + 1);

    ctrl.stop();
  });

  it("auto-launch enters version-checking synchronously and reaches live on success", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "claude";
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "sess-1",
      sessionPath: "/help",
      token: "tok-1",
      mcpUrl: null,
      windowId: 1,
    });
    vi.mocked(actionService.dispatch).mockResolvedValue({
      ok: true,
      result: { terminalId: "term-1" },
    } as never);

    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });

    // The first phase write happens synchronously, before the first await.
    expect(ctrl.getSnapshot().phase).toBe("version-checking");

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().phase).toBe("live");
    });
    // The assistant terminal must spawn as an overlay panel, not a phantom dock item (#9640),
    // and must stay out of persisted/restored app state.
    expect(vi.mocked(actionService.dispatch)).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        location: "overlay",
        excludeFromPersistence: true,
        removeOnExit: true,
      }),
      expect.anything()
    );
    // The watchdog must be cleared once the launch reaches a terminal state, so
    // it can never fire 90s later and tear down a healthy live session.
    expect(ctrl["_launchWatchdogTimer"]).toBeNull();
    expect(ctrl.getSnapshot().launchError).toBeNull();
    // Non-assistant agents read their .mcp.json / settings from cwd, so they
    // run in the provisioned session dir, not the project root.
    expect(vi.mocked(actionService.dispatch)).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ cwd: "/help" }),
      expect.anything()
    );
    ctrl.stop();
  });

  it("launches the Daintree Assistant in the project root, not the session dir", async () => {
    // The assistant is env-only (MCP via env, ships its own skills) so it reads
    // nothing from cwd — it runs in the actual project. Same provision (session
    // dir "/help") and project ("/repo") as the Claude case above; only the
    // resolved cwd differs by agent.
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "daintree-assistant";
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "sess-asst",
      sessionPath: "/help",
      token: "tok-asst",
      mcpUrl: null,
      windowId: 1,
    });
    vi.mocked(actionService.dispatch).mockResolvedValue({
      ok: true,
      result: { terminalId: "term-asst" },
    } as never);

    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: "daintree-assistant",
      supportedInstalledAgentIds: ["daintree-assistant"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().phase).toBe("live");
    });
    expect(vi.mocked(actionService.dispatch)).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "daintree-assistant", cwd: "/repo" }),
      expect.anything()
    );
    ctrl.stop();
  });

  it("binds a resumed session's DAINTREE_PROJECT_ID to the launch project, not live store state", async () => {
    // Resume path (_spawnResumed): the project identity must come from the
    // project captured at launch, never live store state — otherwise a project
    // switch mid-resume makes cwd and DAINTREE_PROJECT_ID disagree. Drive it
    // with claude (which has a resume config; the assistant has none and always
    // fresh-launches) and deliberately drift the store's currentProject.
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      proj: { sessionId: "old-sess", agentId: "claude", cwd: "/help" },
    };
    // Store currentProject drifts away from the launch project after capture.
    projectStoreState.currentProject = { id: "other", path: "/other" };
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "new-sess",
      sessionPath: "/help",
      token: "tok-resume",
      mcpUrl: null,
      windowId: 1,
    });
    panelStoreState.addPanel = vi.fn().mockResolvedValue("term-resumed");

    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });

    await vi.waitFor(() => {
      expect(panelStoreState.addPanel).toHaveBeenCalled();
    });
    const addPanelArg = (panelStoreState.addPanel as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      cwd?: string;
      env?: Record<string, string>;
    };
    // Claude resumes in the session dir (it owns its .mcp.json there)…
    expect(addPanelArg.cwd).toBe("/help");
    // …but its project identity is the launch project, not the drifted store.
    expect(addPanelArg.env?.DAINTREE_PROJECT_ID).toBe("proj");
    ctrl.stop();
  });

  it("auto-launch resets the phase to idle when provisioning fails", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "claude";
    // Default provisionSession resolves null → outcome not ok.
    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().phase).toBe("idle");
    });
    expect(vi.mocked(actionService.dispatch)).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("does NOT auto-launch when autoLaunchEnabled is false, despite a preferred agent + open ready panel (#10699)", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "claude";

    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: false,
      visibilityEpoch: 0,
    });

    // The auto-launch path writes phase synchronously before its first await,
    // so an idle phase here proves the consent gate short-circuited it.
    expect(ctrl.getSnapshot().phase).toBe("idle");
    expect(ctrl["_hasAutoLaunched"]).toBe(false);

    // A visibility-restore epoch bump must not bypass consent either.
    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: false,
      visibilityEpoch: 1,
    });
    expect(ctrl.getSnapshot().phase).toBe("idle");
    expect(vi.mocked(actionService.dispatch)).not.toHaveBeenCalled();
    // No billed work may even begin — the gate must short-circuit before the
    // session is provisioned, not merely before the terminal is dispatched.
    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("does NOT auto-launch a sole installed agent when autoLaunchEnabled is false (#10699)", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();

    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: null,
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: false,
      visibilityEpoch: 0,
    });

    expect(ctrl.getSnapshot().phase).toBe("idle");
    expect(ctrl["_hasAutoLaunched"]).toBe(false);
    expect(vi.mocked(actionService.dispatch)).not.toHaveBeenCalled();
    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("_fireHibernate surfaces the hibernating phase, then resets to idle after teardown", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.terminalId = "term-1";
    helpPanelState.isOpen = false;
    panelStoreState.panelsById = { "term-1": { id: "term-1", cwd: "/p" } };
    (window.electron.terminal.gracefulKill as ReturnType<typeof vi.fn>).mockResolvedValue(
      "captured-sess"
    );
    ctrl["_hibernateArmedFor"] = { terminalId: "term-1", agentId: "claude", projectId: "proj" };

    ctrl["_fireHibernate"]("term-1", "claude", "proj");
    expect(ctrl.getSnapshot().phase).toBe("hibernating");

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().phase).toBe("idle");
    });
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    ctrl.stop();
  });

  it("_fireHibernate resets the phase to idle if terminalId is cleared mid-kill (no stuck skeleton)", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.terminalId = "term-1";
    helpPanelState.isOpen = false;
    panelStoreState.panelsById = { "term-1": { id: "term-1", cwd: "/p" } };
    let resolveKill: (v: string | null) => void = () => {};
    (window.electron.terminal.gracefulKill as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((r) => {
        resolveKill = r;
      })
    );
    ctrl["_hibernateArmedFor"] = { terminalId: "term-1", agentId: "claude", projectId: "proj" };

    ctrl["_fireHibernate"]("term-1", "claude", "proj");
    expect(ctrl.getSnapshot().phase).toBe("hibernating");

    // The panel disappears while the kill is in flight (handleTerminalPanelMissing).
    helpPanelState.terminalId = null;
    resolveKill("captured-sess");

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().phase).toBe("idle");
    });
    ctrl.stop();
  });

  it("revokes the provisioned session when agent.launch rejects after provisioning", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "claude";
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "sess-leak",
      sessionPath: "/help",
      token: "tok-leak",
      mcpUrl: null,
      windowId: 1,
    });
    vi.mocked(actionService.dispatch).mockRejectedValue(new Error("dispatch boom") as never);

    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });

    await vi.waitFor(() => {
      expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-leak");
    });
    expect(ctrl.getSnapshot().phase).toBe("idle");
    ctrl.stop();
  });

  it("watchdog revokes the provisioned session when agent.launch hangs after provisioning (#10698)", async () => {
    vi.useFakeTimers();
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "claude";
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "sess-hang",
      sessionPath: "/help",
      token: "tok-hang",
      mcpUrl: null,
      windowId: 1,
    });
    // Provisioning succeeds (the bearer is minted), then agent.launch never
    // settles — the post-provision stall the watchdog must reclaim. Without the
    // fix the watchdog reset the phase but left the live token orphaned forever.
    vi.mocked(actionService.dispatch).mockReturnValue(new Promise(() => {}) as never);
    try {
      ctrl.syncInputs({
        isOpen: true,
        isReadyToLaunch: true,
        currentProject: { id: "proj", path: "/repo" },
        terminalId: null,
        preferredAgentId: "claude",
        supportedInstalledAgentIds: ["claude"],
        autoLaunchEnabled: true,
        visibilityEpoch: 0,
      });

      // Let the provision microtask chain settle so the bearer is minted and
      // agent.launch has been dispatched (and is now hanging).
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ctrl["_pendingSessionId"]).toBe("sess-hang");
      // Prove the flow actually reached (and is now hung on) agent.launch, so
      // the revoke below is exercising the post-provision stall, not an earlier
      // bail before the bearer was put at risk.
      expect(vi.mocked(actionService.dispatch)).toHaveBeenCalledWith(
        "agent.launch",
        expect.anything(),
        expect.anything()
      );
      expect(window.electron.help.revokeSession).not.toHaveBeenCalled();

      // Past the 90s ceiling the dead-man timer reclaims the stranded FSM and
      // revokes the orphaned bearer so the token can't outlive the launch.
      await vi.advanceTimersByTimeAsync(90_000);
      expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-hang");
      expect(ctrl["_pendingSessionId"]).toBeNull();
      expect(ctrl.getSnapshot().phase).toBe("idle");
      expect(ctrl.getSnapshot().launchError).toEqual(
        expect.objectContaining({ agentId: "claude", kind: "spawn-failed" })
      );
    } finally {
      ctrl.stop();
      vi.useRealTimers();
    }
  });

  it("a late-rejecting stale launch revokes its own token but spares a newer launch's pending session (#10698)", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "claude";
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "sess-stale",
      sessionPath: "/help",
      token: "tok-stale",
      mcpUrl: null,
      windowId: 1,
    });
    let rejectDispatch: (err: unknown) => void = () => {};
    vi.mocked(actionService.dispatch).mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectDispatch = reject;
      }) as never
    );

    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });
    await vi.waitFor(() => {
      expect(ctrl["_pendingSessionId"]).toBe("sess-stale");
    });

    // A newer launch wins the race and takes ownership of the pending-session
    // slot while the stale launch's dispatch is still in flight.
    ctrl["_pendingSessionId"] = "sess-new";

    // The stale launch's dispatch finally rejects. Its catch must revoke ITS
    // own bearer but must NOT null the newer launch's pending-session guard.
    rejectDispatch(new Error("late boom"));
    await vi.waitFor(() => {
      expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-stale");
    });
    expect(ctrl["_pendingSessionId"]).toBe("sess-new");
    ctrl.stop();
  });
});

describe("HelpSessionController — handleViewRevealed (switch-back recovery #10739)", () => {
  // Drives a preferred-agent auto-launch that hangs on the first bridge await,
  // leaving the FSM stranded in `version-checking` — the parked-view stall the
  // watchdog can't reap because its setTimeout is frozen in the LRU cache.
  function startStuckLaunch(ctrl: HelpSessionController): void {
    helpPanelState.preferredAgentId = "claude";
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {})
    );
    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });
  }

  it("silently reaps a stranded loading-phase launch and re-drives it (no error surfaced)", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    startStuckLaunch(ctrl);
    expect(ctrl.getSnapshot().phase).toBe("version-checking");
    const genBefore = ctrl["_launchGen"] as number;
    const folderCallsBefore = (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mock
      .calls.length;

    ctrl.handleViewRevealed();

    // Re-driven, not left stranded: a fresh launch synchronously re-enters the
    // loading phase, the auto-launch path ran again, and the generation advanced
    // (reap + re-drive each bump it).
    expect(ctrl.getSnapshot().phase).toBe("version-checking");
    expect(
      (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBeGreaterThan(folderCallsBefore);
    expect(ctrl["_launchGen"]).toBeGreaterThan(genBefore);
    // Recovery is silent — the user must see the resume, not a failure.
    expect(ctrl.getSnapshot().launchError).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("revokes the minted-but-orphaned pending session token when reaping", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    startStuckLaunch(ctrl);
    ctrl["_pendingSessionId"] = "sess-orphan";

    ctrl.handleViewRevealed();

    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-orphan");
    ctrl.stop();
  });

  it("is a no-op when a session is already live (no reap, no re-drive)", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_patch"]({ phase: "live" });
    const genBefore = ctrl["_launchGen"] as number;

    ctrl.handleViewRevealed();

    expect(ctrl.getSnapshot().phase).toBe("live");
    expect(ctrl["_launchGen"]).toBe(genBefore);
    ctrl.stop();
  });

  it("is a no-op while idle", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    const genBefore = ctrl["_launchGen"] as number;

    ctrl.handleViewRevealed();

    expect(ctrl.getSnapshot().phase).toBe("idle");
    expect(ctrl["_launchGen"]).toBe(genBefore);
    ctrl.stop();
  });

  it("does not reap a hibernating phase (it owns a live terminal mid-shutdown)", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_patch"]({ phase: "hibernating" });
    const genBefore = ctrl["_launchGen"] as number;

    ctrl.handleViewRevealed();

    expect(ctrl.getSnapshot().phase).toBe("hibernating");
    expect(ctrl["_launchGen"]).toBe(genBefore);
    ctrl.stop();
  });

  it("does not reap a manual (non-auto) launch — the _hasAutoLaunched guard protects it", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    // A manual selectAgent() launch never sets `_hasAutoLaunched`; reaping it
    // would silently discard the user's explicit pick since the re-drive can't
    // restart it (auto-launch is disabled). Simulate one stranded in provisioning.
    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: null,
      supportedInstalledAgentIds: ["claude", "codex"],
      autoLaunchEnabled: false,
      visibilityEpoch: 0,
    });
    ctrl["_patch"]({ phase: "provisioning" });
    ctrl["_hasAutoLaunched"] = false;
    const genBefore = ctrl["_launchGen"] as number;

    ctrl.handleViewRevealed();

    expect(ctrl.getSnapshot().phase).toBe("provisioning");
    expect(ctrl["_launchGen"]).toBe(genBefore);
    ctrl.stop();
  });

  it("does not surface a launch error when the original hung IPC rejects after the reap", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "claude";
    // First getFolderPath (the stranded launch) is rejectable; the re-drive's
    // call hangs so it stays in version-checking after recovery.
    let rejectFolder: (err: unknown) => void = () => {};
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectFolder = reject;
        })
      )
      .mockReturnValue(new Promise(() => {}));
    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });
    expect(ctrl.getSnapshot().phase).toBe("version-checking");

    // Switch-back reveal reaps the stall (bumping the gen) and re-drives.
    ctrl.handleViewRevealed();
    expect(ctrl.getSnapshot().phase).toBe("version-checking");

    // The original hung IPC now rejects — it belongs to a superseded generation,
    // so it must NOT paint an error banner over the recovered launch.
    rejectFolder(new Error("late reject"));
    await Promise.resolve();
    await Promise.resolve();

    expect(ctrl.getSnapshot().launchError).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("does not reap a loading phase when a terminal is already bound (reserved-id guard)", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    // A newSession/runAnyway launch reserves its terminal slot synchronously, so
    // _lastInputs.terminalId is non-null even while the FSM is provisioning —
    // that is not a stranded auto-launch and must not be reaped.
    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "proj", path: "/repo" },
      terminalId: "term-live",
      preferredAgentId: null,
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });
    ctrl["_patch"]({ phase: "provisioning" });
    const genBefore = ctrl["_launchGen"] as number;

    ctrl.handleViewRevealed();

    expect(ctrl.getSnapshot().phase).toBe("provisioning");
    expect(ctrl["_launchGen"]).toBe(genBefore);
    expect(ctrl.getSnapshot().launchError).toBeNull();
    ctrl.stop();
  });
});

describe("HelpSessionController — tier-mismatch handlers", () => {
  it("approveTierOnce() calls issueGrant (per-tool) and clears banner on success", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    tierListeners[0]?.({
      sessionId: "s1",
      toolId: "t1",
      tier: "workbench",
      targetTier: "action",
    });
    expect(ctrl.getSnapshot().tierMismatch).not.toBeNull();

    ctrl.approveTierOnce();
    expect(ctrl.getSnapshot().isApprovingTier).toBe(true);
    // "Approve once" is now a per-tool grant (#8442) — it must NOT
    // elevate the session tier, only mint a grant for this exact tool.
    expect(mockMcpIssueGrant).toHaveBeenCalledWith({ sessionId: "s1", toolId: "t1" });
    expect(mockMcpSetSessionTier).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().isApprovingTier).toBe(false);
      expect(ctrl.getSnapshot().tierMismatch).toBeNull();
    });
    ctrl.stop();
  });

  it("approveTierOnce() is a no-op while another approval is in flight", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    tierListeners[0]?.({
      sessionId: "s1",
      toolId: "t1",
      tier: "workbench",
      targetTier: "action",
    });
    ctrl.approveTierOnce();
    const callsBefore = mockMcpIssueGrant.mock.calls.length;
    ctrl.approveTierOnce();
    expect(mockMcpIssueGrant.mock.calls.length).toBe(callsBefore);
    ctrl.stop();
  });

  it("dismissTierMismatch() clears the banner immediately", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    tierListeners[0]?.({
      sessionId: "s1",
      toolId: "t1",
      tier: "workbench",
      targetTier: null,
    });
    expect(ctrl.getSnapshot().tierMismatch).not.toBeNull();
    ctrl.dismissTierMismatch();
    expect(ctrl.getSnapshot().tierMismatch).toBeNull();
    ctrl.stop();
  });

  it("dismissTierMismatch() resets the denial counter for the dismissed session (#10017)", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    tierListeners[0]?.({
      sessionId: "sess-9",
      toolId: "t1",
      tier: "workbench",
      targetTier: "action",
    });
    ctrl.dismissTierMismatch();
    // Cancel must re-arm the banner by clearing the per-session denial
    // counters in main — without this the next denial is silently suppressed.
    expect(mockMcpResetDenialCounts).toHaveBeenCalledWith({ sessionId: "sess-9" });
    ctrl.stop();
  });

  it("dismissTierMismatch() does not reset denial counts when no banner is showing", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl.dismissTierMismatch();
    expect(mockMcpResetDenialCounts).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("dismissTierMismatch() clears the banner even if the denial-reset IPC rejects", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    // Fire-and-forget: a rejected reset (e.g. caller-pin mismatch after a view
    // rebind) must not throw or leave the banner stuck open.
    mockMcpResetDenialCounts.mockRejectedValueOnce(new Error("not the pinned renderer"));
    tierListeners[0]?.({
      sessionId: "sess-r",
      toolId: "t1",
      tier: "workbench",
      targetTier: "action",
    });
    expect(() => ctrl.dismissTierMismatch()).not.toThrow();
    expect(ctrl.getSnapshot().tierMismatch).toBeNull();
    expect(mockMcpResetDenialCounts).toHaveBeenCalledWith({ sessionId: "sess-r" });
    ctrl.stop();
  });
});

describe("HelpSessionController — session revoked (#10017)", () => {
  it("start() arms the session-revoked subscription", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    expect(mockMcpOnSessionRevoked).toHaveBeenCalledTimes(1);
    ctrl.stop();
  });

  it("a session-revoked push surfaces the recovery banner", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.sessionId = "sess-live";
    sessionRevokedListeners[0]?.({ sessionId: "sess-live", denialKind: "tierMismatch" });
    expect(ctrl.getSnapshot().sessionRevoked).toEqual({
      sessionId: "sess-live",
      denialKind: "tierMismatch",
    });
    ctrl.stop();
  });

  it("ignores a revoke for a session the panel has already replaced", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.sessionId = "sess-current";
    sessionRevokedListeners[0]?.({ sessionId: "sess-stale", denialKind: "auth401" });
    expect(ctrl.getSnapshot().sessionRevoked).toBeNull();
    ctrl.stop();
  });

  it("ignores a revoke while no session is pinned (torn-down or mid-relaunch window)", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    // A null store sessionId means there is no live session to end — a revoke
    // arriving now is for a session being torn down or replaced, and must not
    // paint a banner over the fresh launch the user just started (#10017).
    helpPanelState.sessionId = null;
    sessionRevokedListeners[0]?.({ sessionId: "sess-old", denialKind: "tierMismatch" });
    expect(ctrl.getSnapshot().sessionRevoked).toBeNull();
    ctrl.stop();
  });

  it("dismissSessionRevoked clears the banner", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ sessionRevoked: { sessionId: "sess-1", denialKind: "tierMismatch" } });
    expect(ctrl.getSnapshot().sessionRevoked).not.toBeNull();
    ctrl.dismissSessionRevoked();
    expect(ctrl.getSnapshot().sessionRevoked).toBeNull();
  });

  it("a launch supersedes any standing revoked-session banner", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_lastInputs"] = {
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "p1", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    };
    ctrl["_patch"]({ sessionRevoked: { sessionId: "sess-old", denialKind: "tierMismatch" } });
    expect(ctrl.getSnapshot().sessionRevoked).not.toBeNull();

    ctrl.launch({ agentId: "claude" });
    expect(ctrl.getSnapshot().sessionRevoked).toBeNull();
    ctrl.stop();
  });
});

describe("HelpSessionController — grant lifecycle (#10042)", () => {
  function armMismatch() {
    tierListeners[0]?.({
      sessionId: "s1",
      toolId: "t1",
      tier: "workbench",
      targetTier: "action",
    });
  }

  it("start() arms the grant lifecycle subscription", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    expect(mockMcpOnGrantLifecycle).toHaveBeenCalledTimes(1);
    expect(grantLifecycleListeners).toHaveLength(1);
    ctrl.stop();
  });

  it("grant.issued sets the active countdown and clears the prompting mismatch", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    armMismatch();
    expect(ctrl.getSnapshot().tierMismatch).not.toBeNull();

    const expiresAt = Date.now() + 900_000;
    grantLifecycleListeners[0]?.({
      type: "grant.issued",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
      expiresAt,
    });

    expect(ctrl.getSnapshot().activeGrant).toEqual({
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
      expiresAt,
    });
    expect(ctrl.getSnapshot().tierMismatch).toBeNull();
    expect(ctrl.getSnapshot().grantEnded).toBeNull();
    ctrl.stop();
  });

  it("grant.issued without expiresAt is ignored rather than seeding a NaN countdown", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    grantLifecycleListeners[0]?.({
      type: "grant.issued",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
    });
    expect(ctrl.getSnapshot().activeGrant).toBeNull();
    ctrl.stop();
  });

  it("grant.expired retires the active grant and surfaces an 'expired' notice", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    grantLifecycleListeners[0]?.({
      type: "grant.issued",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
      expiresAt: Date.now() + 900_000,
    });
    grantLifecycleListeners[0]?.({
      type: "grant.expired",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
    });
    expect(ctrl.getSnapshot().activeGrant).toBeNull();
    expect(ctrl.getSnapshot().grantEnded).toEqual({ toolId: "t1", reason: "expired" });
    ctrl.stop();
  });

  it("grant.revoked with grant-ceiling surfaces a ceiling notice", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    grantLifecycleListeners[0]?.({
      type: "grant.issued",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
      expiresAt: Date.now() + 900_000,
    });
    grantLifecycleListeners[0]?.({
      type: "grant.revoked",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
      revokedReason: "grant-ceiling",
    });
    expect(ctrl.getSnapshot().activeGrant).toBeNull();
    expect(ctrl.getSnapshot().grantEnded).toEqual({ toolId: "t1", reason: "grant-ceiling" });
    ctrl.stop();
  });

  it.each(["user", "session-ended", "session-idle"] as const)(
    "grant.revoked with reason %s clears the grant silently (no notice)",
    (revokedReason) => {
      const ctrl = new HelpSessionController();
      ctrl.start();
      grantLifecycleListeners[0]?.({
        type: "grant.issued",
        sessionId: "s1",
        toolId: "t1",
        ttlMs: 900_000,
        expiresAt: Date.now() + 900_000,
      });
      grantLifecycleListeners[0]?.({
        type: "grant.revoked",
        sessionId: "s1",
        toolId: "t1",
        ttlMs: 900_000,
        revokedReason,
      });
      expect(ctrl.getSnapshot().activeGrant).toBeNull();
      expect(ctrl.getSnapshot().grantEnded).toBeNull();
      ctrl.stop();
    }
  );

  it("a lapse for a different tool leaves the on-screen countdown intact", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    grantLifecycleListeners[0]?.({
      type: "grant.issued",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
      expiresAt: Date.now() + 900_000,
    });
    // A stale expiry for a tool we're not counting down must not clear t1.
    grantLifecycleListeners[0]?.({
      type: "grant.expired",
      sessionId: "s1",
      toolId: "other-tool",
      ttlMs: 900_000,
    });
    expect(ctrl.getSnapshot().activeGrant?.toolId).toBe("t1");
    expect(ctrl.getSnapshot().grantEnded).toBeNull();
    ctrl.stop();
  });

  it("tier.elevated / tier.decayed do not disturb the per-tool countdown", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    grantLifecycleListeners[0]?.({
      type: "grant.issued",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
      expiresAt: Date.now() + 900_000,
    });
    grantLifecycleListeners[0]?.({
      type: "tier.elevated",
      sessionId: "s1",
      toolId: "*",
      ttlMs: 900_000,
    });
    expect(ctrl.getSnapshot().activeGrant?.toolId).toBe("t1");
    grantLifecycleListeners[0]?.({
      type: "tier.decayed",
      sessionId: "s1",
      toolId: "*",
      ttlMs: 900_000,
    });
    expect(ctrl.getSnapshot().activeGrant?.toolId).toBe("t1");
    ctrl.stop();
  });

  it("a fresh tier denial supersedes a lingering 'approval ended' notice", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    grantLifecycleListeners[0]?.({
      type: "grant.issued",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
      expiresAt: Date.now() + 900_000,
    });
    grantLifecycleListeners[0]?.({
      type: "grant.expired",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
    });
    expect(ctrl.getSnapshot().grantEnded).not.toBeNull();
    armMismatch();
    expect(ctrl.getSnapshot().grantEnded).toBeNull();
    expect(ctrl.getSnapshot().tierMismatch).not.toBeNull();
    ctrl.stop();
  });

  function issueGrant() {
    grantLifecycleListeners[0]?.({
      type: "grant.issued",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
      expiresAt: Date.now() + 900_000,
    });
  }

  it("revokeGrant() revokes the session's grants and clears the countdown once the IPC settles", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    issueGrant();
    ctrl.revokeGrant();
    expect(ctrl.getSnapshot().isRevokingGrant).toBe(true);
    expect(mockMcpRevokeSessionGrants).toHaveBeenCalledWith({ sessionId: "s1" });
    // Authoritative renderer-side fallback: even with no `grant.revoked`
    // lifecycle event echoed back, the countdown clears when the IPC settles.
    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().isRevokingGrant).toBe(false);
      expect(ctrl.getSnapshot().activeGrant).toBeNull();
    });
    ctrl.stop();
  });

  it("revokeGrant() is a no-op while a revoke is already in flight", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    issueGrant();
    let resolveRevoke: (() => void) | undefined;
    mockMcpRevokeSessionGrants.mockReturnValueOnce(
      new Promise<{ sessionId: string; revokedCount: number }>((resolve) => {
        resolveRevoke = () => resolve({ sessionId: "s1", revokedCount: 1 });
      })
    );
    ctrl.revokeGrant();
    ctrl.revokeGrant();
    expect(mockMcpRevokeSessionGrants).toHaveBeenCalledTimes(1);
    resolveRevoke?.();
    ctrl.stop();
  });

  it("revokeGrant() does not wipe a newer grant that arrived before the IPC settled", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    issueGrant();
    let resolveRevoke: (() => void) | undefined;
    mockMcpRevokeSessionGrants.mockReturnValueOnce(
      new Promise<{ sessionId: string; revokedCount: number }>((resolve) => {
        resolveRevoke = () => resolve({ sessionId: "s1", revokedCount: 1 });
      })
    );
    ctrl.revokeGrant();
    // A new grant for a different tool lands while the revoke is in flight.
    const newerExpiry = Date.now() + 900_000;
    grantLifecycleListeners[0]?.({
      type: "grant.issued",
      sessionId: "s1",
      toolId: "t2",
      ttlMs: 900_000,
      expiresAt: newerExpiry,
    });
    resolveRevoke?.();
    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().isRevokingGrant).toBe(false);
    });
    // The settle must not clear the newer t2 grant — only the one we revoked.
    expect(ctrl.getSnapshot().activeGrant?.toolId).toBe("t2");
    ctrl.stop();
  });

  it("a failed revoke keeps the countdown banner up as the retry surface", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    issueGrant();
    mockMcpRevokeSessionGrants.mockRejectedValueOnce(new Error("ipc boom"));
    ctrl.revokeGrant();
    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().isRevokingGrant).toBe(false);
    });
    // Revoke failed → the grant is still live, so the banner must stay put.
    expect(ctrl.getSnapshot().activeGrant?.toolId).toBe("t1");
    ctrl.stop();
  });

  it("a teardown mid-revoke does not leak a disabled Revoke button into the next grant", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    issueGrant();
    mockMcpRevokeSessionGrants.mockReturnValueOnce(
      new Promise<{ sessionId: string; revokedCount: number }>(() => {
        // never resolves — the teardown happens first
      })
    );
    ctrl.revokeGrant();
    expect(ctrl.getSnapshot().isRevokingGrant).toBe(true);
    helpPanelState.terminalId = "term-1";
    helpPanelState.sessionId = "sess-1";
    ctrl.handleTerminalPanelMissing({ terminalId: "term-1", terminalExists: false });
    expect(ctrl.getSnapshot().isRevokingGrant).toBe(false);
    expect(ctrl.getSnapshot().activeGrant).toBeNull();
    ctrl.stop();
  });

  it("revokeGrant() is a no-op when there is no active grant", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl.revokeGrant();
    expect(mockMcpRevokeSessionGrants).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("dismissGrantEnded() clears the notice", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    grantLifecycleListeners[0]?.({
      type: "grant.issued",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
      expiresAt: Date.now() + 900_000,
    });
    grantLifecycleListeners[0]?.({
      type: "grant.expired",
      sessionId: "s1",
      toolId: "t1",
      ttlMs: 900_000,
    });
    expect(ctrl.getSnapshot().grantEnded).not.toBeNull();
    ctrl.dismissGrantEnded();
    expect(ctrl.getSnapshot().grantEnded).toBeNull();
    ctrl.stop();
  });
});

describe("HelpSessionController — checkVersionAgain", () => {
  const block = {
    agentId: "claude",
    agentName: "Claude",
    installedVersion: "0.9.0",
    requiredVersion: "1.0.0",
  };

  function setBlock(ctrl: HelpSessionController) {
    ctrl["_patch"]({ assistantVersionTooOld: { ...block } });
  }

  function getAgentVersionMock() {
    return window.electron.system.getAgentVersion as ReturnType<typeof vi.fn>;
  }

  it("is a no-op when the version gate is not showing", () => {
    const ctrl = new HelpSessionController();
    ctrl.checkVersionAgain();
    expect(getAgentVersionMock()).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("is a no-op while a re-probe is already in flight", () => {
    const ctrl = new HelpSessionController();
    setBlock(ctrl);
    ctrl["_patch"]({ isCheckingVersion: true });
    ctrl.checkVersionAgain();
    expect(getAgentVersionMock()).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("re-probes with refresh=true and clears the gate when the CLI is now current", async () => {
    const ctrl = new HelpSessionController();
    getAgentVersionMock().mockResolvedValue({ installedVersion: "1.2.0", latestVersion: "1.2.0" });
    setBlock(ctrl);

    ctrl.checkVersionAgain();
    expect(getAgentVersionMock()).toHaveBeenCalledWith("claude", true);
    expect(ctrl.getSnapshot().isCheckingVersion).toBe(true);

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().assistantVersionTooOld).toBeNull();
    });
    ctrl.stop();
  });

  it("keeps the gate with refreshed versions when the CLI is still too old", async () => {
    const ctrl = new HelpSessionController();
    getAgentVersionMock().mockResolvedValue({ installedVersion: "0.9.5", latestVersion: "1.2.0" });
    setBlock(ctrl);

    ctrl.checkVersionAgain();
    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().assistantVersionTooOld?.installedVersion).toBe("0.9.5");
    });
    ctrl.stop();
  });

  it("ignores a duplicate click while the first probe is still in flight", () => {
    const ctrl = new HelpSessionController();
    getAgentVersionMock().mockReturnValue(new Promise(() => {}));
    setBlock(ctrl);

    ctrl.checkVersionAgain();
    ctrl.checkVersionAgain();
    expect(getAgentVersionMock()).toHaveBeenCalledTimes(1);
    ctrl.stop();
  });

  it("keeps the gate when the probe fails transiently (does not dismiss on error)", async () => {
    const ctrl = new HelpSessionController();
    getAgentVersionMock().mockRejectedValue(new Error("probe failed"));
    setBlock(ctrl);

    ctrl.checkVersionAgain();
    await vi.waitFor(() => {
      // Probe settled; the gate must remain visible rather than clearing.
      expect(getAgentVersionMock()).toHaveBeenCalled();
    });
    expect(ctrl.getSnapshot().assistantVersionTooOld).not.toBeNull();
    ctrl.stop();
  });

  it("keeps the gate when the probe returns an undeterminable version", async () => {
    const ctrl = new HelpSessionController();
    getAgentVersionMock().mockResolvedValue({ installedVersion: null, latestVersion: null });
    setBlock(ctrl);

    ctrl.checkVersionAgain();
    await vi.waitFor(() => {
      expect(getAgentVersionMock()).toHaveBeenCalled();
    });
    expect(ctrl.getSnapshot().assistantVersionTooOld).not.toBeNull();
    ctrl.stop();
  });

  it("does not re-enable the button on cooldown alone while a slow probe is still in flight", async () => {
    vi.useFakeTimers();
    try {
      const ctrl = new HelpSessionController();
      ctrl.start();
      let resolveProbe: (v: { installedVersion: string }) => void = () => {};
      getAgentVersionMock().mockReturnValue(
        new Promise((resolve) => {
          resolveProbe = resolve;
        })
      );
      setBlock(ctrl);

      ctrl.checkVersionAgain();
      expect(ctrl.getSnapshot().isCheckingVersion).toBe(true);

      // Cooldown elapses but the probe hasn't settled — button stays disabled.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ctrl.getSnapshot().isCheckingVersion).toBe(true);

      // Probe settles → button re-enables.
      resolveProbe({ installedVersion: "1.2.0" });
      await vi.advanceTimersByTimeAsync(0);
      expect(ctrl.getSnapshot().isCheckingVersion).toBe(false);
      ctrl.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds isCheckingVersion until both the probe settles and the 5s cooldown elapses", async () => {
    vi.useFakeTimers();
    try {
      const ctrl = new HelpSessionController();
      ctrl.start();
      getAgentVersionMock().mockResolvedValue({
        installedVersion: "1.2.0",
        latestVersion: "1.2.0",
      });
      setBlock(ctrl);

      ctrl.checkVersionAgain();
      expect(ctrl.getSnapshot().isCheckingVersion).toBe(true);

      // Probe resolves but the cooldown floor hasn't elapsed yet.
      await vi.advanceTimersByTimeAsync(0);
      expect(ctrl.getSnapshot().isCheckingVersion).toBe(true);

      // Cooldown elapses → button re-enables.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ctrl.getSnapshot().isCheckingVersion).toBe(false);
      ctrl.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() clears the pending cooldown timer", () => {
    vi.useFakeTimers();
    try {
      const ctrl = new HelpSessionController();
      ctrl.start();
      getAgentVersionMock().mockReturnValue(new Promise(() => {}));
      setBlock(ctrl);
      ctrl.checkVersionAgain();
      expect(ctrl.getSnapshot().isCheckingVersion).toBe(true);
      ctrl.stop();
      // No pending timers should remain after stop().
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HelpSessionController — launch error routing", () => {
  function primeInputs(ctrl: HelpSessionController, isOpen: boolean) {
    ctrl["_lastInputs"] = {
      isOpen,
      isReadyToLaunch: true,
      currentProject: { id: "p1", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    };
  }

  const provisionMock = () =>
    window.electron.help.provisionSession as unknown as ReturnType<typeof vi.fn>;

  it("surfaces a launch failure as a banner when the panel is open", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeInputs(ctrl, true);
    provisionMock().mockRejectedValueOnce(
      Object.assign(new Error("port collision"), { code: "MCP_SERVER_NOT_STARTED" })
    );

    ctrl.launch({ agentId: "claude" });

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().launchError).toEqual({
        agentId: "claude",
        kind: "mcp-server-not-started",
      });
    });
    expect(notify).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("maps a probe failure to the probe-failed banner kind", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeInputs(ctrl, true);
    provisionMock().mockRejectedValueOnce(
      Object.assign(new Error("bad probe"), { code: "MCP_PROBE_FAILED" })
    );

    ctrl.launch({ agentId: "claude" });

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().launchError?.kind).toBe("mcp-probe-failed");
    });
    ctrl.stop();
  });

  it("falls back to a toast when the panel is closed", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeInputs(ctrl, false);
    provisionMock().mockRejectedValueOnce(
      Object.assign(new Error("port collision"), { code: "MCP_SERVER_NOT_STARTED" })
    );

    ctrl.launch({ agentId: "claude" });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Assistant couldn't start" })
      );
    });
    expect(ctrl.getSnapshot().launchError).toBeNull();
    ctrl.stop();
  });

  it("treats a null provision result as a generic spawn failure", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeInputs(ctrl, true);
    provisionMock().mockResolvedValueOnce(null);

    ctrl.launch({ agentId: "claude" });

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().launchError?.kind).toBe("spawn-failed");
    });
    ctrl.stop();
  });

  it("surfaces the folder-unavailable banner when help folder path is null", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeInputs(ctrl, true);
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    ctrl.launch({ agentId: "claude" });

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().launchError?.kind).toBe("folder-unavailable");
    });
    expect(notify).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("surfaces a folder-unavailable toast with the installer-page action when panel is closed", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeInputs(ctrl, false);
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    ctrl.launch({ agentId: "claude" });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Assistant files missing",
          action: expect.objectContaining({
            label: "Open installer page",
            actionId: "system.openExternal",
            actionArgs: { url: "https://daintree.org/download" },
          }),
        })
      );
    });
    expect(ctrl.getSnapshot().launchError).toBeNull();
    // Toast body must not promise a Retry the click can't deliver, and must
    // keep the same jargon-free contract the banner enforces.
    const call = (notify as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        (c[0] as { title?: string }).title === "Assistant files missing"
    );
    const payload = call?.[0] as { message: string; action: { onClick: () => void } };
    expect(payload.message).not.toMatch(/Try again/i);
    expect(payload.message).not.toMatch(/\bMCP\b/i);
    expect(payload.message).not.toMatch(/\btoken\b/i);
    expect(payload.message).not.toMatch(/\bbearer\b/i);
    // Clicking the toast action must fire the same action the banner's
    // Open installer page button does — locked to the same URL and source.
    (actionService.dispatch as ReturnType<typeof vi.fn>).mockClear();
    payload.action.onClick();
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://daintree.org/download" },
      { source: "user" }
    );
    ctrl.stop();
  });

  it("dismissLaunchError clears the banner", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeInputs(ctrl, true);
    provisionMock().mockResolvedValueOnce(null);

    ctrl.launch({ agentId: "claude" });
    await vi.waitFor(() => expect(ctrl.getSnapshot().launchError).not.toBeNull());

    ctrl.dismissLaunchError();
    expect(ctrl.getSnapshot().launchError).toBeNull();
    ctrl.stop();
  });

  it("uses probe-failure copy on the closed-panel fallback toast", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeInputs(ctrl, false);
    provisionMock().mockRejectedValueOnce(
      Object.assign(new Error("slow probe"), { code: "MCP_PROBE_FAILED" })
    );

    ctrl.launch({ agentId: "claude" });

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          message: expect.stringContaining("didn't respond in time"),
        })
      );
    });
    expect(ctrl.getSnapshot().launchError).toBeNull();
    ctrl.stop();
  });

  it("revokes the session and surfaces an error when auto-launch throws after provisioning", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeInputs(ctrl, true);
    helpPanelState.preferredAgentId = "claude";
    ctrl["_launchGen"] = 7;
    provisionMock().mockResolvedValueOnce({
      sessionId: "sess-x",
      sessionPath: "/s/x",
      token: "tok",
      mcpUrl: null,
      windowId: 1,
    });
    (
      window.electron.help as unknown as { takePendingHibernation: ReturnType<typeof vi.fn> }
    ).takePendingHibernation = vi.fn().mockResolvedValue(null);
    (actionService.dispatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));

    await ctrl["_executeLaunch"](
      7,
      { agentId: "claude", isAutoLaunch: true, preferredAgentLaunch: true },
      { id: "p1", path: "/repo" },
      undefined
    );

    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-x");
    expect(ctrl["_pendingSessionId"]).toBeNull();
    expect(ctrl.getSnapshot().launchError).toEqual({ agentId: "claude", kind: "spawn-failed" });
    ctrl.stop();
  });

  it("preferred-agent auto-launch abandons and relaunches the new agent when preferredAgentId changes mid-dispatch (#10703)", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "claude";
    (
      window.electron.help as unknown as { takePendingHibernation: ReturnType<typeof vi.fn> }
    ).takePendingHibernation = vi.fn().mockResolvedValue(null);
    provisionMock()
      .mockResolvedValueOnce({
        sessionId: "sess-claude",
        sessionPath: "/s/claude",
        token: "tok",
        mcpUrl: null,
        windowId: 1,
      })
      .mockResolvedValueOnce({
        sessionId: "sess-codex",
        sessionPath: "/s/codex",
        token: "tok",
        mcpUrl: null,
        windowId: 1,
      });
    // The user switches preferred agent while the claude launch IPC is in
    // flight; the codex relaunch must then succeed.
    (actionService.dispatch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_action: string, args: { agentId: string }) => {
        if (args.agentId === "claude") {
          helpPanelState.preferredAgentId = "codex";
          return { ok: true, result: { terminalId: "term-claude" } };
        }
        return { ok: true, result: { terminalId: "term-codex" } };
      }
    );

    ctrl.syncInputs({
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "p1", path: "/repo" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude", "codex"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });

    // The relaunch must actually reach the codex agent — the bug this guards
    // against is the re-eval's launch() being swallowed by the still-held
    // re-entrancy guard, leaving _hasAutoLaunched stuck and codex unlaunched.
    await vi.waitFor(() => {
      expect(helpPanelState.setTerminal).toHaveBeenCalledWith("term-codex", "codex", "sess-codex");
    });
    // The superseded claude attempt is cleaned up: orphan terminal removed,
    // stale session token revoked.
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-claude");
    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-claude");
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "codex" }),
      expect.anything()
    );
    expect(ctrl.getSnapshot().phase).toBe("live");
    ctrl.stop();
  });

  it("skips the version-too-old banner when preferredAgentId changes during the probe (#10703)", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.preferredAgentId = "claude";
    ctrl["_hasAutoLaunched"] = true;
    ctrl["_launchGen"] = 7;
    // The probe reports claude as too old, but the user switches to codex
    // before it resolves — the stale "Update Claude" gate must not apply.
    (window.electron.system.getAgentVersion as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        helpPanelState.preferredAgentId = "codex";
        return { installedVersion: "0.9.0", latestVersion: "1.2.0" };
      }
    );

    await ctrl["_executeLaunch"](
      7,
      { agentId: "claude", isAutoLaunch: true, preferredAgentLaunch: true },
      { id: "p1", path: "/repo" },
      undefined
    );

    expect(ctrl.getSnapshot().assistantVersionTooOld).toBeNull();
    // _hasAutoLaunched is released so codex can auto-launch on the next render.
    expect(ctrl["_hasAutoLaunched"]).toBe(false);
    // The abandoned claude launch must never have minted a session.
    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("clears the launch-error banner when the preferred agent changes", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    // isReadyToLaunch:false keeps auto-launch from firing and clearing the
    // banner out from under the assertion.
    const inputs = (preferredAgentId: string) => ({
      isOpen: true,
      isReadyToLaunch: false,
      currentProject: { id: "p1", path: "/repo" },
      terminalId: null,
      preferredAgentId,
      supportedInstalledAgentIds: ["claude", "codex"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    });
    ctrl.syncInputs(inputs("claude"));
    ctrl["_patch"]({ launchError: { agentId: "claude", kind: "spawn-failed" } });
    expect(ctrl.getSnapshot().launchError).not.toBeNull();

    ctrl.syncInputs(inputs("codex"));
    expect(ctrl.getSnapshot().launchError).toBeNull();
    ctrl.stop();
  });
});

describe("HelpSessionController — resume banner gating (#10057)", () => {
  const provisionMock = () =>
    window.electron.help.provisionSession as unknown as ReturnType<typeof vi.fn>;

  function primeResumeInputs(ctrl: HelpSessionController) {
    helpPanelState.preferredAgentId = "claude";
    ctrl["_launchGen"] = 7;
    (
      window.electron.help as unknown as { takePendingHibernation: ReturnType<typeof vi.fn> }
    ).takePendingHibernation = vi.fn().mockResolvedValue(null);
    provisionMock().mockResolvedValueOnce({
      sessionId: "sess-1",
      sessionPath: "/help",
      token: "tok-1",
      mcpUrl: null,
      windowId: 1,
    });
    panelStoreState.addPanel = vi.fn().mockResolvedValue("term-resumed");
  }

  it("does not show the resume banner when the hibernation sessionId is empty (resume-latest path)", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeResumeInputs(ctrl);
    // Empty sessionId is the sentinel from main's LRU-eviction race.
    helpPanelState.hibernateSessions["p1"] = {
      sessionId: "",
      cwd: "/repo",
      agentId: "claude",
    };

    await ctrl["_executeLaunch"](
      7,
      { agentId: "claude", isAutoLaunch: true, preferredAgentLaunch: true },
      { id: "p1", path: "/repo" },
      undefined
    );

    // The phase still reached live (the spawn succeeded via --continue) but
    // the resume-banner claim is suppressed because we never had a real id.
    expect(ctrl.getSnapshot().phase).toBe("live");
    expect(ctrl.getSnapshot().showResumeBanner).toBe(false);
    // The hibernate entry is still consumed so a future auto-launch doesn't
    // loop on the same --continue attempt.
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("p1");
    // The spawn still happened — the renderer attempted the agent heuristic.
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal" })
    );
    ctrl.stop();
  });

  it("shows the resume banner when the hibernation sessionId is specific", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeResumeInputs(ctrl);
    helpPanelState.hibernateSessions["p1"] = {
      sessionId: "abc-123",
      cwd: "/repo",
      agentId: "claude",
    };

    await ctrl["_executeLaunch"](
      7,
      { agentId: "claude", isAutoLaunch: true, preferredAgentLaunch: true },
      { id: "p1", path: "/repo" },
      undefined
    );

    expect(ctrl.getSnapshot().phase).toBe("live");
    expect(ctrl.getSnapshot().showResumeBanner).toBe(true);
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("p1");
    ctrl.stop();
  });
});

describe("HelpSessionController — resume-only auto-resume (#10815)", () => {
  const provisionMock = () =>
    window.electron.help.provisionSession as unknown as ReturnType<typeof vi.fn>;

  // #10819: a state-mutating setHibernateSession so the resume block below can
  // read the entry the early atomic take seeded. The global resetState() leaves
  // it a pure spy; this writes through to helpPanelState.hibernateSessions.
  const seedThroughSetHibernate = () => {
    helpPanelState.setHibernateSession = vi.fn(
      (projectId: string, entry: { sessionId: string; cwd: string; agentId: string }) => {
        helpPanelState.hibernateSessions[projectId] = entry;
      }
    );
  };

  it("aborts a resumeOnly launch without provisioning when the atomic take returns null", async () => {
    // Cold switch-back / cross-window auto-resume. #10819: the atomic take is
    // hoisted BEFORE provisioning. A null take (another window already won it, or
    // nothing was captured) must abort before provisionHelpSession runs — that
    // call displaces the project's existing backend, which is exactly what would
    // strand the window that legitimately resumed.
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_launchGen"] = 7;
    (
      window.electron.help as unknown as { takePendingHibernation: ReturnType<typeof vi.fn> }
    ).takePendingHibernation = vi.fn().mockResolvedValue(null);
    helpPanelState.hibernateSessions = {};

    await ctrl["_executeLaunch"](
      7,
      { agentId: "claude", replaceExisting: true, resumeOnly: true },
      { id: "p1", path: "/repo" },
      undefined
    );

    // Never provisions, so nothing to displace and no session to revoke.
    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    expect(window.electron.help.revokeSession).not.toHaveBeenCalled();
    expect(ctrl["_pendingSessionId"]).toBeNull();
    // NEVER fresh-launches, and never spawns a panel.
    expect(actionService.dispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
    // Expected no-op: phase falls back to idle, no scary launch error.
    expect(ctrl.getSnapshot().phase).toBe("idle");
    expect(ctrl.getSnapshot().launchError).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("does not provision when the take returns null even if a stale local hibernate entry exists (#10819 secondary race)", async () => {
    // The resume decision must gate on the main-side atomic take, NOT on the
    // local persisted hibernateSessions entry. A losing window can still carry a
    // stale local entry from before; without the take gate it would provision
    // (and displace the winner) on the strength of that stale entry alone.
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_launchGen"] = 7;
    (
      window.electron.help as unknown as { takePendingHibernation: ReturnType<typeof vi.fn> }
    ).takePendingHibernation = vi.fn().mockResolvedValue(null);
    helpPanelState.hibernateSessions["p1"] = {
      sessionId: "stale-123",
      cwd: "/repo",
      agentId: "claude",
    };

    await ctrl["_executeLaunch"](
      7,
      { agentId: "claude", replaceExisting: true, resumeOnly: true },
      { id: "p1", path: "/repo" },
      undefined
    );

    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    expect(window.electron.help.revokeSession).not.toHaveBeenCalled();
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
    expect(ctrl.getSnapshot().phase).toBe("idle");
    ctrl.stop();
  });

  it("resumes (never fresh-launches) on a resumeOnly launch when the atomic take returns a matching entry", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_launchGen"] = 7;
    seedThroughSetHibernate();
    helpPanelState.hibernateSessions = {};
    const takeMock = vi.fn().mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/repo",
    });
    (
      window.electron.help as unknown as { takePendingHibernation: ReturnType<typeof vi.fn> }
    ).takePendingHibernation = takeMock;
    provisionMock().mockResolvedValueOnce({
      sessionId: "sess-ro2",
      sessionPath: "/help",
      token: "tok",
      mcpUrl: null,
      windowId: 1,
    });
    panelStoreState.addPanel = vi.fn().mockResolvedValue("term-ro");

    await ctrl["_executeLaunch"](
      7,
      { agentId: "claude", replaceExisting: true, resumeOnly: true },
      { id: "p1", path: "/repo" },
      undefined
    );

    // The take is the gate, and it runs before provisioning displaces anything.
    expect(takeMock).toHaveBeenCalledWith("p1");
    const takeOrder = takeMock.mock.invocationCallOrder[0];
    const provisionOrder = provisionMock().mock.invocationCallOrder[0];
    expect(takeOrder).toBeDefined();
    expect(provisionOrder).toBeDefined();
    expect(takeOrder!).toBeLessThan(provisionOrder!);
    // The taken entry seeds the local store the resume block reads.
    expect(helpPanelState.setHibernateSession).toHaveBeenCalledWith("p1", {
      sessionId: "abc-123",
      cwd: "/repo",
      agentId: "claude",
    });
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal" })
    );
    expect(actionService.dispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("p1");
    expect(ctrl.getSnapshot().phase).toBe("live");
    ctrl.stop();
  });

  it("aborts before provisioning when the early take's agentId mismatches the launch agent (#10819)", async () => {
    // The entry was captured for a different agent (the user switched the
    // preferred agent before the cold restore). The mismatched entry can't be
    // resumed, so abort before provisioning rather than displace a live backend.
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_launchGen"] = 7;
    helpPanelState.hibernateSessions = {};
    (
      window.electron.help as unknown as { takePendingHibernation: ReturnType<typeof vi.fn> }
    ).takePendingHibernation = vi.fn().mockResolvedValue({
      agentId: "codex",
      agentSessionId: "codex-1",
      cwd: "/repo",
    });

    await ctrl["_executeLaunch"](
      7,
      { agentId: "claude", replaceExisting: true, resumeOnly: true },
      { id: "p1", path: "/repo" },
      undefined
    );

    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    expect(window.electron.help.revokeSession).not.toHaveBeenCalled();
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
    expect(ctrl.getSnapshot().phase).toBe("idle");
    ctrl.stop();
  });

  it("drops the early take and does not provision when the generation is superseded mid-take (#10819)", async () => {
    // A competing launch bumps _launchGen while the atomic take IPC is in flight.
    // The stale result must not seed the store or provision — the gen guard after
    // the take await abandons the launch.
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_launchGen"] = 7;
    seedThroughSetHibernate();
    helpPanelState.hibernateSessions = {};
    (
      window.electron.help as unknown as { takePendingHibernation: ReturnType<typeof vi.fn> }
    ).takePendingHibernation = vi.fn().mockImplementation(async () => {
      ctrl["_launchGen"] = 8; // superseded mid-await
      return { agentId: "claude", agentSessionId: "abc-123", cwd: "/repo" };
    });

    await ctrl["_executeLaunch"](
      7,
      { agentId: "claude", replaceExisting: true, resumeOnly: true },
      { id: "p1", path: "/repo" },
      undefined
    );

    expect(helpPanelState.setHibernateSession).not.toHaveBeenCalled();
    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("aborts silently before provisioning when the early take IPC throws (#10819)", async () => {
    // The early take is a recovery-path credential check; an IPC failure means
    // "can't prove we won the race", so abort WITHOUT displacing — and without a
    // scary error banner, mirroring how _seedHibernateFromMain swallows its own
    // IPC failure.
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_launchGen"] = 7;
    helpPanelState.hibernateSessions = {};
    (
      window.electron.help as unknown as { takePendingHibernation: ReturnType<typeof vi.fn> }
    ).takePendingHibernation = vi.fn().mockRejectedValue(new Error("ipc down"));

    await ctrl["_executeLaunch"](
      7,
      { agentId: "claude", replaceExisting: true, resumeOnly: true },
      { id: "p1", path: "/repo" },
      undefined
    );

    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    expect(window.electron.help.revokeSession).not.toHaveBeenCalled();
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
    expect(ctrl.getSnapshot().phase).toBe("idle");
    expect(ctrl.getSnapshot().launchError).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("still seeds via _seedHibernateFromMain on a non-resumeOnly launch (#10819 invariant)", async () => {
    // The early-take guard must NOT swallow the normal empty-state launch: a
    // non-resumeOnly launch still pulls main's pending entry post-provision via
    // _seedHibernateFromMain and resumes from it.
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_launchGen"] = 7;
    seedThroughSetHibernate();
    helpPanelState.hibernateSessions = {};
    const takeMock = vi.fn().mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-9",
      cwd: "/repo",
    });
    (
      window.electron.help as unknown as { takePendingHibernation: ReturnType<typeof vi.fn> }
    ).takePendingHibernation = takeMock;
    provisionMock().mockResolvedValueOnce({
      sessionId: "sess-normal",
      sessionPath: "/help",
      token: "tok",
      mcpUrl: null,
      windowId: 1,
    });
    panelStoreState.addPanel = vi.fn().mockResolvedValue("term-normal");

    await ctrl["_executeLaunch"](7, { agentId: "claude" }, { id: "p1", path: "/repo" }, undefined);

    // _seedHibernateFromMain ran (the take is its only caller on this path).
    expect(takeMock).toHaveBeenCalledWith("p1");
    expect(panelStoreState.addPanel).toHaveBeenCalled();
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("p1");
    expect(ctrl.getSnapshot().phase).toBe("live");
    ctrl.stop();
  });
});

describe("HelpSessionController — MCP tool activity strip (#9759)", () => {
  function startCtrl() {
    const ctrl = new HelpSessionController();
    ctrl.start();
    return ctrl;
  }
  const fireStarted = (payload: Record<string, unknown>) => toolStartedListeners[0]!(payload);
  const fireSettled = (payload: Record<string, unknown>) => toolSettledListeners[0]!(payload);

  it("start() arms the tool-call started/settled subscriptions", () => {
    const ctrl = startCtrl();
    expect(mockMcpOnToolCallStarted).toHaveBeenCalledTimes(1);
    expect(mockMcpOnToolCallSettled).toHaveBeenCalledTimes(1);
    ctrl.stop();
  });

  it("a started event populates an in-flight row", () => {
    const ctrl = startCtrl();
    fireStarted({
      sessionId: "s1",
      toolId: "terminal.list",
      argsSummary: "{}",
      startedAt: 1000,
      danger: false,
    });
    const a = ctrl.getSnapshot().mcpActivity;
    expect(a?.status).toBe("in-flight");
    expect(a?.toolId).toBe("terminal.list");
    expect(a?.callCount).toBe(1);
    expect(a?.isError).toBe(false);
    ctrl.stop();
  });

  it("a settled event transitions the row to settled with duration and result", () => {
    const ctrl = startCtrl();
    fireStarted({
      sessionId: "s1",
      toolId: "terminal.list",
      argsSummary: "{}",
      startedAt: 1000,
      danger: false,
    });
    fireSettled({
      sessionId: "s1",
      toolId: "terminal.list",
      durationMs: 1200,
      result: "success",
      severity: "info",
    });
    const a = ctrl.getSnapshot().mcpActivity;
    expect(a?.status).toBe("settled");
    expect(a?.durationMs).toBe(1200);
    expect(a?.result).toBe("success");
    expect(a?.isError).toBe(false);
    ctrl.stop();
  });

  it("an error-severity settle marks the row as error (red, persists)", () => {
    const ctrl = startCtrl();
    fireStarted({ sessionId: "s1", toolId: "x", argsSummary: "{}", startedAt: 1, danger: false });
    fireSettled({
      sessionId: "s1",
      toolId: "x",
      durationMs: 50,
      result: "error",
      severity: "error",
    });
    expect(ctrl.getSnapshot().mcpActivity?.isError).toBe(true);
    ctrl.stop();
  });

  it("coalesces bursts within the same turn into a single counted row", () => {
    const ctrl = startCtrl();
    fireStarted({
      sessionId: "s1",
      toolId: "a",
      argsSummary: "{}",
      startedAt: 1,
      danger: false,
      turnId: "T1",
    });
    fireStarted({
      sessionId: "s1",
      toolId: "b",
      argsSummary: "{}",
      startedAt: 2,
      danger: false,
      turnId: "T1",
    });
    fireStarted({
      sessionId: "s1",
      toolId: "c",
      argsSummary: "{}",
      startedAt: 3,
      danger: false,
      turnId: "T1",
    });
    const a = ctrl.getSnapshot().mcpActivity;
    expect(a?.callCount).toBe(3);
    expect(a?.toolId).toBe("c");
    ctrl.stop();
  });

  it("a new turn starts a fresh row (no coalescing across turns)", () => {
    const ctrl = startCtrl();
    fireStarted({
      sessionId: "s1",
      toolId: "a",
      argsSummary: "{}",
      startedAt: 1,
      danger: false,
      turnId: "T1",
    });
    fireStarted({
      sessionId: "s1",
      toolId: "b",
      argsSummary: "{}",
      startedAt: 2,
      danger: false,
      turnId: "T2",
    });
    expect(ctrl.getSnapshot().mcpActivity?.callCount).toBe(1);
    expect(ctrl.getSnapshot().mcpActivity?.toolId).toBe("b");
    ctrl.stop();
  });

  it("calls without a turnId never coalesce (last wins)", () => {
    const ctrl = startCtrl();
    fireStarted({ sessionId: "s1", toolId: "a", argsSummary: "{}", startedAt: 1, danger: false });
    fireStarted({ sessionId: "s1", toolId: "b", argsSummary: "{}", startedAt: 2, danger: false });
    expect(ctrl.getSnapshot().mcpActivity?.callCount).toBe(1);
    expect(ctrl.getSnapshot().mcpActivity?.toolId).toBe("b");
    ctrl.stop();
  });

  it("a new call clears a lingering errored row", () => {
    const ctrl = startCtrl();
    fireStarted({ sessionId: "s1", toolId: "x", argsSummary: "{}", startedAt: 1, danger: false });
    fireSettled({
      sessionId: "s1",
      toolId: "x",
      durationMs: 5,
      result: "error",
      severity: "error",
    });
    expect(ctrl.getSnapshot().mcpActivity?.isError).toBe(true);
    fireStarted({ sessionId: "s1", toolId: "y", argsSummary: "{}", startedAt: 2, danger: false });
    const a = ctrl.getSnapshot().mcpActivity;
    expect(a?.status).toBe("in-flight");
    expect(a?.isError).toBe(false);
    expect(a?.toolId).toBe("y");
    ctrl.stop();
  });

  it("carries danger through for an awaiting-confirmation row", () => {
    const ctrl = startCtrl();
    fireStarted({
      sessionId: "s1",
      toolId: "git.push",
      argsSummary: "{}",
      startedAt: 1,
      danger: true,
    });
    expect(ctrl.getSnapshot().mcpActivity?.danger).toBe(true);
    ctrl.stop();
  });

  it("a settle with no current row is ignored", () => {
    const ctrl = startCtrl();
    fireSettled({
      sessionId: "s1",
      toolId: "x",
      durationMs: 5,
      result: "success",
      severity: "info",
    });
    expect(ctrl.getSnapshot().mcpActivity).toBeNull();
    ctrl.stop();
  });

  it("a settle arriving after clearMcpActivity() does not resurrect a row", () => {
    const ctrl = startCtrl();
    fireStarted({ sessionId: "s1", toolId: "x", argsSummary: "{}", startedAt: 1, danger: false });
    ctrl.clearMcpActivity();
    expect(ctrl.getSnapshot().mcpActivity).toBeNull();
    fireSettled({
      sessionId: "s1",
      toolId: "x",
      durationMs: 5,
      result: "success",
      severity: "info",
    });
    expect(ctrl.getSnapshot().mcpActivity).toBeNull();
    ctrl.stop();
  });

  it("handleTerminalPanelMissing clears the activity row", () => {
    const ctrl = startCtrl();
    helpPanelState.terminalId = "term-1";
    helpPanelState.sessionId = "sess-1";
    fireStarted({ sessionId: "s1", toolId: "x", argsSummary: "{}", startedAt: 1, danger: false });
    expect(ctrl.getSnapshot().mcpActivity).not.toBeNull();
    ctrl.handleTerminalPanelMissing({ terminalId: "term-1", terminalExists: false });
    expect(ctrl.getSnapshot().mcpActivity).toBeNull();
    ctrl.stop();
  });

  it("ignores a settle from a different turn (late cross-turn settle cannot regress the row)", () => {
    const ctrl = startCtrl();
    fireStarted({
      sessionId: "s1",
      toolId: "slow-old",
      argsSummary: "{}",
      startedAt: 1,
      danger: false,
      turnId: "T1",
    });
    fireStarted({
      sessionId: "s1",
      toolId: "fresh",
      argsSummary: "{}",
      startedAt: 2,
      danger: false,
      turnId: "T2",
    });
    fireSettled({
      sessionId: "s1",
      toolId: "slow-old",
      durationMs: 9000,
      result: "error",
      severity: "error",
      turnId: "T1",
    });
    const a = ctrl.getSnapshot().mcpActivity;
    expect(a?.status).toBe("in-flight");
    expect(a?.toolId).toBe("fresh");
    expect(a?.isError).toBe(false);
    ctrl.stop();
  });

  it("keeps a coalesced burst in-flight until every outstanding call settles", () => {
    const ctrl = startCtrl();
    fireStarted({
      sessionId: "s1",
      toolId: "a",
      argsSummary: "{}",
      startedAt: 1,
      danger: false,
      turnId: "T1",
    });
    fireStarted({
      sessionId: "s1",
      toolId: "b",
      argsSummary: "{}",
      startedAt: 2,
      danger: false,
      turnId: "T1",
    });
    // Call A settles while B is still running — the row must stay in-flight.
    fireSettled({
      sessionId: "s1",
      toolId: "a",
      durationMs: 10,
      result: "success",
      severity: "info",
      turnId: "T1",
    });
    let a = ctrl.getSnapshot().mcpActivity;
    expect(a?.status).toBe("in-flight");
    expect(a?.callCount).toBe(2);
    // The final settle completes the burst.
    fireSettled({
      sessionId: "s1",
      toolId: "b",
      durationMs: 25,
      result: "success",
      severity: "info",
      turnId: "T1",
    });
    a = ctrl.getSnapshot().mcpActivity;
    expect(a?.status).toBe("settled");
    expect(a?.toolId).toBe("b");
    expect(a?.durationMs).toBe(25);
    ctrl.stop();
  });
});

describe("loadCustomLaunchFlags — model + custom args composition", () => {
  const getSettings = () => window.electron.helpAssistant.getSettings as ReturnType<typeof vi.fn>;

  it("returns no flags when neither modelId nor customArgs is set", async () => {
    getSettings().mockResolvedValue({ modelId: "", customArgs: "" });
    expect(await loadCustomLaunchFlags()).toEqual([]);
  });

  it("injects --model when modelId is set", async () => {
    getSettings().mockResolvedValue({ modelId: "claude-sonnet-4-6", customArgs: "" });
    expect(await loadCustomLaunchFlags()).toEqual(["--model", "claude-sonnet-4-6"]);
  });

  it("prepends the model flag before custom args so a custom --model wins (last-flag semantics)", async () => {
    getSettings().mockResolvedValue({ modelId: "sonnet", customArgs: "--model opus --verbose" });
    expect(await loadCustomLaunchFlags()).toEqual([
      "--model",
      "sonnet",
      "--model",
      "opus",
      "--verbose",
    ]);
  });

  it("returns only custom args when no model is selected", async () => {
    getSettings().mockResolvedValue({ modelId: "", customArgs: "--verbose --foo bar" });
    expect(await loadCustomLaunchFlags()).toEqual(["--verbose", "--foo", "bar"]);
  });

  it("tolerates absent modelId (legacy settings) and falls back to custom args only", async () => {
    getSettings().mockResolvedValue({ customArgs: "--verbose" });
    expect(await loadCustomLaunchFlags()).toEqual(["--verbose"]);
  });

  it("returns [] when reading settings throws", async () => {
    getSettings().mockRejectedValue(new Error("ipc down"));
    expect(await loadCustomLaunchFlags()).toEqual([]);
  });
});
