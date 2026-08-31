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
    selectSlot: (s: typeof helpPanelState) => s,
    selectActiveSlot: (s: typeof helpPanelState) => s,
    selectOpenSlots: () => [0],
    selectSlotTerminalIds: (s: typeof helpPanelState) => (s.terminalId ? [s.terminalId] : []),
    selectSlotForTerminal: (s: typeof helpPanelState, id: string) =>
      s.terminalId === id && id ? 0 : null,
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
import { notify } from "@/lib/notify";

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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
    const ctrl = new HelpSessionController();
    ctrl.start();
    startStuckLaunch(ctrl);
    ctrl["_pendingSessionId"] = "sess-orphan";

    ctrl.handleViewRevealed();

    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-orphan");
    ctrl.stop();
  });

  it("is a no-op when a session is already live (no reap, no re-drive)", () => {
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
    const ctrl = new HelpSessionController();
    ctrl.start();
    const genBefore = ctrl["_launchGen"] as number;

    ctrl.handleViewRevealed();

    expect(ctrl.getSnapshot().phase).toBe("idle");
    expect(ctrl["_launchGen"]).toBe(genBefore);
    ctrl.stop();
  });

  it("does not reap a hibernating phase (it owns a live terminal mid-shutdown)", () => {
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "sess-9";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl.dismissTierMismatch();
    expect(mockMcpResetDenialCounts).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("dismissTierMismatch() clears the banner even if the denial-reset IPC rejects", () => {
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "sess-r";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
    const ctrl = new HelpSessionController();
    ctrl.start();
    expect(mockMcpOnSessionRevoked).toHaveBeenCalledTimes(1);
    ctrl.stop();
  });

  it("a session-revoked push surfaces the recovery banner", () => {
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
    const ctrl = new HelpSessionController();
    ctrl.start();
    helpPanelState.sessionId = "sess-current";
    sessionRevokedListeners[0]?.({ sessionId: "sess-stale", denialKind: "auth401" });
    expect(ctrl.getSnapshot().sessionRevoked).toBeNull();
    ctrl.stop();
  });

  it("ignores a revoke while no session is pinned (torn-down or mid-relaunch window)", () => {
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
    const ctrl = new HelpSessionController();
    ctrl["_patch"]({ sessionRevoked: { sessionId: "sess-1", denialKind: "tierMismatch" } });
    expect(ctrl.getSnapshot().sessionRevoked).not.toBeNull();
    ctrl.dismissSessionRevoked();
    expect(ctrl.getSnapshot().sessionRevoked).toBeNull();
  });

  it("a launch supersedes any standing revoked-session banner", () => {
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
    const ctrl = new HelpSessionController();
    ctrl.start();
    expect(mockMcpOnGrantLifecycle).toHaveBeenCalledTimes(1);
    expect(grantLifecycleListeners).toHaveLength(1);
    ctrl.stop();
  });

  it("grant.issued sets the active countdown and clears the prompting mismatch", () => {
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
      // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl.revokeGrant();
    expect(mockMcpRevokeSessionGrants).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("dismissGrantEnded() clears the notice", () => {
    // #12108: MCP pushes are matched against the lane's own session id.
    helpPanelState.sessionId = "s1";
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
