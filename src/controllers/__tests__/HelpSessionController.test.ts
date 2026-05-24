// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockMcpOnTierNotPermitted,
  mockMcpSetSessionTier,
  mockMcpIssueGrant,
  mockSystemSleepOnSuspend,
  mockSystemSleepOnWake,
  systemSleepListeners,
  tierListeners,
  helpPanelState,
  panelStoreState,
  projectStoreState,
} = vi.hoisted(() => ({
  mockMcpOnTierNotPermitted: vi.fn(),
  mockMcpSetSessionTier: vi.fn().mockResolvedValue(undefined),
  mockMcpIssueGrant: vi.fn().mockResolvedValue({
    sessionId: "",
    toolId: "",
    ttlMs: 900_000,
    expiresAt: Date.now() + 900_000,
  }),
  mockSystemSleepOnSuspend: vi.fn(),
  mockSystemSleepOnWake: vi.fn(),
  systemSleepListeners: {
    suspend: [] as Array<() => void>,
    wake: [] as Array<() => void>,
  },
  tierListeners: [] as Array<(payload: unknown) => void>,
  helpPanelState: {
    isOpen: false,
    terminalId: null as string | null,
    agentId: null as string | null,
    preferredAgentId: null as string | null,
    sessionId: null as string | null,
    hibernateSessions: {} as Record<string, unknown>,
    setTerminal: vi.fn(),
    clearTerminal: vi.fn(),
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
    ({ claude: { name: "Claude", assistantMinVersion: "1.0.0" } })[id],
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
  helpPanelState.setTerminal = vi.fn();
  helpPanelState.clearTerminal = vi.fn();
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

  mockMcpOnTierNotPermitted.mockReset();
  mockMcpOnTierNotPermitted.mockImplementation((cb: (payload: unknown) => void) => {
    tierListeners.push(cb);
    return () => {
      const idx = tierListeners.indexOf(cb);
      if (idx >= 0) tierListeners.splice(idx, 1);
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
          setSessionTier: mockMcpSetSessionTier,
          issueGrant: mockMcpIssueGrant,
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
    expect(systemSleepListeners.suspend).toHaveLength(1);
    expect(systemSleepListeners.wake).toHaveLength(1);
    ctrl.stop();
    expect(tierListeners).toHaveLength(0);
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
      visibilityEpoch: 0,
    });
    expect(ctrl.getSnapshot().assistantVersionTooOld).toBeNull();
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
      visibilityEpoch: 0,
    });

    // The first phase write happens synchronously, before the first await.
    expect(ctrl.getSnapshot().phase).toBe("version-checking");

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().phase).toBe("live");
    });
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
      visibilityEpoch: 0,
    });

    await vi.waitFor(() => {
      expect(ctrl.getSnapshot().phase).toBe("idle");
    });
    expect(vi.mocked(actionService.dispatch)).not.toHaveBeenCalled();
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
      visibilityEpoch: 0,
    });

    await vi.waitFor(() => {
      expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-leak");
    });
    expect(ctrl.getSnapshot().phase).toBe("idle");
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

    await ctrl["_executeAutoLaunch"](7, "claude", { id: "p1", path: "/repo" });

    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-x");
    expect(ctrl["_pendingSessionId"]).toBeNull();
    expect(ctrl.getSnapshot().launchError).toEqual({ agentId: "claude", kind: "spawn-failed" });
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
