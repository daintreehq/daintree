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
    ctrl["_hibernationManager"]["_hibernateArmedFor"] = {
      terminalId: "term-1",
      agentId: "claude",
      projectId: "proj",
    };

    ctrl["_hibernationManager"]["_fireHibernate"]("term-1", "claude", "proj");
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
    ctrl["_hibernationManager"]["_hibernateArmedFor"] = {
      terminalId: "term-1",
      agentId: "claude",
      projectId: "proj",
    };

    ctrl["_hibernationManager"]["_fireHibernate"]("term-1", "claude", "proj");
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
