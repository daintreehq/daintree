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

import { HelpSessionController, loadCustomLaunchFlags } from "../HelpSessionController";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { assistantSlotKey as slotKey } from "@shared/config/assistantSlots";

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
    helpPanelState.hibernateSessions[slotKey("p1", 0)] = {
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
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("p1", 0);
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
    helpPanelState.hibernateSessions[slotKey("p1", 0)] = {
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
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("p1", 0);
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
      (projectId: string, slot: number, entry: { sessionId: string; cwd: string; agentId: string }) => {
        helpPanelState.hibernateSessions[slotKey(projectId, slot)] = entry;
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
    helpPanelState.hibernateSessions[slotKey("p1", 0)] = {
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
    expect(takeMock).toHaveBeenCalledWith("p1", 0);
    const takeOrder = takeMock.mock.invocationCallOrder[0];
    const provisionOrder = provisionMock().mock.invocationCallOrder[0];
    expect(takeOrder).toBeDefined();
    expect(provisionOrder).toBeDefined();
    expect(takeOrder!).toBeLessThan(provisionOrder!);
    // The taken entry seeds the local store the resume block reads.
    expect(helpPanelState.setHibernateSession).toHaveBeenCalledWith("p1", 0, {
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
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("p1", 0);
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
    expect(takeMock).toHaveBeenCalledWith("p1", 0);
    expect(panelStoreState.addPanel).toHaveBeenCalled();
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("p1", 0);
    expect(ctrl.getSnapshot().phase).toBe("live");
    ctrl.stop();
  });
});

describe("HelpSessionController — MCP tool activity strip (#9759)", () => {
  function startCtrl() {
    // #12108: every MCP push is matched against the lane's own session id, and
    // the fixtures below all fire for "s1".
    helpPanelState.sessionId = "s1";
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
