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
import { actionService } from "@/services/ActionService";
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

  it("maps a mixed-agent refusal to its own kind, not the generic spawn failure", async () => {
    // `spawn-failed` would offer a bare Retry that fails identically until the
    // sibling lane stops, under copy that blames the agent for not starting.
    const ctrl = new HelpSessionController();
    ctrl.start();
    primeInputs(ctrl, true);
    provisionMock().mockRejectedValueOnce(
      Object.assign(new Error("sibling lane runs codex"), { code: "MIXED_AGENT_LANES" })
    );

    ctrl.launch({ agentId: "claude" });

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().launchError?.kind).toBe("mixed-agent-lanes");
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

  // #11068: the guard used to say "Project state is still loading" for BOTH the
  // genuinely-hydrating case and the no-workspace case. In a scratch it was
  // simply false — and it's the reason the assistant couldn't launch there at all.
  it("blocks with no-workspace copy — not 'still loading' — when ready but no workspace is active", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_lastInputs"] = {
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: null,
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    };

    ctrl.launch({ agentId: "claude" });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("No project or scratch workspace is active"),
      })
    );
    expect(provisionMock()).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it("blocks with loading copy while inputs are still hydrating", () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_lastInputs"] = {
      isOpen: true,
      isReadyToLaunch: false,
      currentProject: null,
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    };

    ctrl.launch({ agentId: "claude" });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("still loading"),
      })
    );
    expect(provisionMock()).not.toHaveBeenCalled();
    ctrl.stop();
  });

  // A scratch's `{ id, path }` is an opaque workspace ref — it must provision
  // exactly like a project's, with no branching on workspace kind (#11068).
  it("launches into an active scratch workspace, provisioning with the scratch id and path", async () => {
    const ctrl = new HelpSessionController();
    ctrl.start();
    ctrl["_lastInputs"] = {
      isOpen: true,
      isReadyToLaunch: true,
      currentProject: { id: "scratch-1", path: "/scratches/scratch-1" },
      terminalId: null,
      preferredAgentId: "claude",
      supportedInstalledAgentIds: ["claude"],
      autoLaunchEnabled: true,
      visibilityEpoch: 0,
    };
    (
      window.electron.help as unknown as { takePendingHibernation: ReturnType<typeof vi.fn> }
    ).takePendingHibernation = vi.fn().mockResolvedValue(null);
    provisionMock().mockResolvedValueOnce({
      sessionId: "sess-s1",
      sessionPath: "/s/s1",
      token: "tok",
      mcpUrl: null,
      windowId: 1,
    });

    ctrl.launch({ agentId: "claude" });

    await vi.waitFor(() => {
      expect(provisionMock()).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "scratch-1",
          projectPath: "/scratches/scratch-1",
        })
      );
    });
    expect(notify).not.toHaveBeenCalled();
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
      expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
        0,
        "term-codex",
        "codex",
        "sess-codex"
      );
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
