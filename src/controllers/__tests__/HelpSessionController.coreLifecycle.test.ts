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
    clearDroppedPreferredAgent: vi.fn(),
    dismissIntro: vi.fn(),
    setAutoLaunchEnabled: vi.fn(),
    setWidth: vi.fn(),
    requestFocus: vi.fn(),
    setActiveFigureNumber: vi.fn(),
    addFigure: vi.fn(),
    markConversationStarted: vi.fn(),
    setActiveSlot: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    // #12108: the panel reads its lane pointer; the mocked selectors
    // above project this same flat object as that lane.
    activeSlot: 0,
    sessions: {} as Record<number, unknown>,
    isOpen: false,
    terminalId: null as string | null,
    agentId: null as string | null,
    preferredAgentId: null as string | null,
    sessionId: null as string | null,
    hibernateSessions: {} as Record<string, unknown>,
    setOpen: vi.fn(),
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
  return {
    useHelpPanelStore: store,
    // #12108 selectors. The fixtures below stay FLAT (terminalId/agentId/…)
    // and these project that same object as the lane, so every existing
    // assertion keeps driving the controller unchanged.
    selectSlot: (s) => s,
    selectActiveSlot: (s) => s,
    selectOpenSlots: () => [0],
    selectSlotTerminalIds: (s) => (s.terminalId ? [s.terminalId] : []),
    selectSlotForTerminal: (s, id) => (s.terminalId === id && id ? 0 : null),
  };
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

import { HelpSessionController } from "../HelpSessionController";
import type { HelpSessionInputs } from "../HelpSessionController";

/**
 * Prime the controller's synced inputs with an active workspace. The controller
 * reads the workspace it acts on from these inputs — never the live project
 * store — because a scratch workspace leaves `currentProject` null by design
 * (#11068). Tests that expect workspace-scoped side effects (clearing the
 * hibernate slot, etc.) must therefore push inputs, not just seed the store.
 */
function syncWorkspaceInputs(
  ctrl: HelpSessionController,
  workspace: { id: string; path: string },
  overrides: Partial<HelpSessionInputs> = {}
): void {
  ctrl.syncInputs({
    isOpen: true,
    isReadyToLaunch: true,
    currentProject: workspace,
    terminalId: "term-1",
    preferredAgentId: null,
    supportedInstalledAgentIds: ["claude"],
    autoLaunchEnabled: false,
    visibilityEpoch: 0,
    ...overrides,
  });
}

function resetState() {
  helpPanelState.isOpen = false;
  helpPanelState.terminalId = null;
  helpPanelState.agentId = null;
  helpPanelState.preferredAgentId = null;
  helpPanelState.sessionId = null;
  helpPanelState.hibernateSessions = {};
  helpPanelState.setOpen = vi.fn();
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
          restorePendingHibernation: vi.fn().mockResolvedValue(false),
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
    // #12108: pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    helpPanelState.sessionId = "help-1";
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
    helpPanelState.sessionId = "help-1";
    const ctrl = new HelpSessionController();
    ctrl.start();
    fireOutcome({ helpSessionId: "help-1", outcome: "reasoning-loop", turnId: "turn-1" });
    expect(ctrl.getSnapshot().outcomeAlert).toBe("reasoning-loop");

    ctrl.dismissOutcomeAlert();
    expect(ctrl.getSnapshot().outcomeAlert).toBeNull();
    ctrl.stop();
  });

  it("auto-clears the pip when a tool call from a different turn starts", () => {
    helpPanelState.sessionId = "help-1";
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
    helpPanelState.sessionId = "help-1";
    const ctrl = new HelpSessionController();
    ctrl.start();
    fireOutcome({ helpSessionId: "help-1", outcome: "agent-stuck" });
    expect(ctrl.getSnapshot().outcomeAlert).toBe("agent-stuck");

    fireToolStart({ turnId: "turn-9" });
    expect(ctrl.getSnapshot().outcomeAlert).toBeNull();
    ctrl.stop();
  });

  it("does not clear the pip for a call with no turn id", () => {
    helpPanelState.sessionId = "help-1";
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
  function bindLiveSession(
    ctrl: HelpSessionController,
    workspace = { id: "proj-1", path: "/repo" }
  ) {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = "sess-bound";
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", cwd: "/help" },
    };
    // Deliberately leaves `projectStoreState.currentProject` null: the workspace
    // reaches the controller through synced inputs only (#11068).
    syncWorkspaceInputs(ctrl, workspace);
  }

  it("tears the bound session down without relaunching, then closes the panel", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "live" });
    bindLiveSession(ctrl);

    ctrl.endSession();

    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(helpPanelState.clearFigures).toHaveBeenCalled();
    // Stop is destructive, not pause: the persisted hibernate slot is dropped so
    // the discarded conversation can't resume on next open.
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1", 0);
    // No fresh terminal is reserved — unlike newSession(), stop does not relaunch.
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    // #11833: Stop slides the sidebar out rather than lingering on the empty
    // state — the same close the self-exit paths already perform.
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
    expect(ctrl.getSnapshot().phase).toBe("idle");
  });

  // #11068: in a scratch workspace `currentProject` is null by design. Stop must
  // still drop the hibernate slot — keyed on the scratch id — or the discarded
  // conversation resurrects on the next open.
  it("drops the hibernate slot under the scratch id when a scratch is the active workspace", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "live" });
    bindLiveSession(ctrl, { id: "scratch-1", path: "/scratches/scratch-1" });
    expect(projectStoreState.currentProject).toBeNull();

    ctrl.endSession();

    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("scratch-1", 0);
  });

  it("revokes the bearer before killing the PTY (revoke-before-kill, #7522)", () => {
    const ctrl = new HelpSessionController();
    bindLiveSession(ctrl);

    ctrl.endSession();

    // removePanel fires the PTY kill IPC; the revoke must be dispatched first so
    // an in-flight MCP call 401s before teardown reaches the host. `?? -1` keeps
    // both operands `number`: a missing (never-called) order fails the guards below.
    const revokeOrder =
      (window.electron.help.revokeSession as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] ?? -1;
    const removeOrder =
      (panelStoreState.removePanel as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? -1;
    expect(revokeOrder).toBeGreaterThanOrEqual(0);
    expect(removeOrder).toBeGreaterThan(revokeOrder);
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
    bindLiveSession(ctrl);

    ctrl.endSession();
    expect(ctrl["_hasAutoLaunched"]).toBe(true);

    // clearTerminal ran — the store now reports no bound terminal.
    helpPanelState.terminalId = null;
    // A synthetic still-open sync with the terminal already cleared. The real
    // Stop path can't commit this pair — `isOpen` and `terminalId` clear in the
    // same batch — but splitting them isolates the auto-launch budget from the
    // `isOpen` gate, so a regression in the budget guard alone stays visible.
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
    bindLiveSession(ctrl);
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

describe("HelpSessionController — terminal PTY exit slides the sidebar out (#10989)", () => {
  function bindLiveSession(
    ctrl: HelpSessionController,
    workspace = { id: "proj-1", path: "/repo" }
  ) {
    helpPanelState.isOpen = true;
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = "sess-bound";
    // Workspace reaches the controller via synced inputs, not the project store.
    syncWorkspaceInputs(ctrl, workspace);
  }

  it("tears the session down and slides the sidebar out when the PTY exits on its own", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "live" });
    bindLiveSession(ctrl);

    // removeOnExit already removed the panel; the renderer reports the bound
    // terminal as no longer existing.
    ctrl.handleTerminalPanelMissing({ terminalId: "term-1", terminalExists: false });

    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    // Full stop: the hibernate slot is dropped and the sidebar slides out.
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1", 0);
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
    expect(ctrl.getSnapshot().phase).toBe("idle");
  });

  it("suppresses a consented auto-relaunch so a self-exit stays stopped", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_patch"]({ phase: "live" });
    bindLiveSession(ctrl);

    ctrl.handleTerminalPanelMissing({ terminalId: "term-1", terminalExists: false });
    // The stop consumes this open cycle's auto-launch budget so the assistant
    // the user just exited can't immediately respawn.
    expect(ctrl["_hasAutoLaunched"]).toBe(true);
    ctrl.stop();
  });

  it("defers to an in-flight hibernate: no slide-out, no hibernate clear", () => {
    const ctrl = new HelpSessionController();
    // `_fireHibernate` sets this phase before its gracefulKill; the PTY onExit
    // then removes the panel and fires this handler mid-teardown.
    ctrl["_patch"]({ phase: "hibernating" });
    bindLiveSession(ctrl);

    ctrl.handleTerminalPanelMissing({ terminalId: "term-1", terminalExists: false });

    // Minimal cleanup still runs; the hibernate flow owns the slot and phase,
    // and this path must not touch panel visibility.
    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(helpPanelState.clearHibernateSession).not.toHaveBeenCalled();
    expect(helpPanelState.setOpen).not.toHaveBeenCalled();
  });

  it("is a no-op while a +New-session terminal is reserved but not yet committed", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "live" });
    bindLiveSession(ctrl);
    ctrl["_pendingNewTerminalId"] = "term-1";

    ctrl.handleTerminalPanelMissing({ terminalId: "term-1", terminalExists: false });

    expect(window.electron.help.revokeSession).not.toHaveBeenCalled();
    expect(helpPanelState.setOpen).not.toHaveBeenCalled();
  });

  it("does not close the panel when the missing terminal is a stale, unbound id", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "live" });
    bindLiveSession(ctrl);

    // A different terminal than the one currently bound in the store.
    ctrl.handleTerminalPanelMissing({ terminalId: "term-stale", terminalExists: false });

    expect(helpPanelState.setOpen).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
  });
});

describe("HelpSessionController — handleAgentExited (agent /exit inside a live shell, #10989)", () => {
  function bindLiveSession(
    ctrl: HelpSessionController,
    workspace = { id: "proj-1", path: "/repo" }
  ) {
    helpPanelState.isOpen = true;
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = "sess-bound";
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", cwd: "/help" },
    };
    // Workspace reaches the controller via synced inputs, not the project store.
    syncWorkspaceInputs(ctrl, workspace);
  }

  it("kills the shell PTY, revokes, and slides the sidebar out on a settled agent exit", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "live" });
    bindLiveSession(ctrl);

    ctrl.handleAgentExited("term-1");

    // Unlike a PTY exit, the shell is still alive — removePanel fires the kill.
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    // Full stop, and the sidebar slides out — same as the Stop button (#11833).
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1", 0);
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
    expect(ctrl["_hasAutoLaunched"]).toBe(true);
    expect(ctrl.getSnapshot().phase).toBe("idle");
  });

  it("revokes the bearer before killing the shell PTY (revoke-before-kill, #7522)", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "live" });
    bindLiveSession(ctrl);

    ctrl.handleAgentExited("term-1");

    const revokeOrder =
      (window.electron.help.revokeSession as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] ?? -1;
    const removeOrder =
      (panelStoreState.removePanel as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? -1;
    expect(revokeOrder).toBeGreaterThanOrEqual(0);
    expect(removeOrder).toBeGreaterThan(revokeOrder);
  });

  it("ignores an exit signal for a terminal that is no longer the bound one", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "live" });
    bindLiveSession(ctrl);

    // A +New session / replace already moved the store on to a different id.
    ctrl.handleAgentExited("term-stale");

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.setOpen).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
  });

  it("defers to an in-flight hibernate rather than double-driving the teardown", () => {
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ phase: "hibernating" });
    bindLiveSession(ctrl);

    ctrl.handleAgentExited("term-1");

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(window.electron.help.revokeSession).not.toHaveBeenCalled();
    expect(helpPanelState.setOpen).not.toHaveBeenCalled();
  });
});
