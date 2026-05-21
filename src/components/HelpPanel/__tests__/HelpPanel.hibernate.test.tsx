// @vitest-environment jsdom
import { render, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDispatch,
  mockNotify,
  mockLogError,
  mockGetFolderPath,
  mockMarkTerminal,
  mockProvisionSession,
  mockRevokeSession,
  mockGracefulKill,
  mockBuildResumeCommand,
  mockGetAssistantSupportedAgentIds,
  mockGetHelpAssistantSettings,
  mockSystemSleepGetMetrics,
  mockSystemSleepOnSuspend,
  mockSystemSleepOnWake,
  systemSleepListeners,
  helpPanelState,
  panelStoreState,
  cliAvailabilityState,
  agentSettingsState,
  projectStoreState,
  preferencesState,
  terminalInputState,
  mockTerminalSubmit,
  mockTerminalSendKey,
  mockNotifyUserInput,
} = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockNotify: vi.fn().mockReturnValue(""),
  mockLogError: vi.fn(),
  mockGetFolderPath: vi.fn(),
  mockMarkTerminal: vi.fn().mockResolvedValue(undefined),
  mockProvisionSession: vi.fn().mockResolvedValue(null),
  mockRevokeSession: vi.fn().mockResolvedValue(undefined),
  mockGracefulKill: vi.fn().mockResolvedValue(null),
  mockBuildResumeCommand: vi.fn(),
  mockGetAssistantSupportedAgentIds: vi.fn(() => ["claude"]),
  mockGetHelpAssistantSettings: vi.fn().mockResolvedValue({
    docSearch: true,
    daintreeControl: true,
    tier: "action" as const,
    bypassPermissions: false,
    auditRetention: 7,
    customArgs: "",
    idleHibernateMinutes: 30,
  }),
  mockSystemSleepGetMetrics: vi.fn().mockResolvedValue({
    totalSleepMs: 0,
    sleepPeriods: [],
    isCurrentlySleeping: false,
    currentSleepStart: null,
  }),
  mockSystemSleepOnSuspend: vi.fn(),
  mockSystemSleepOnWake: vi.fn(),
  systemSleepListeners: {
    suspend: [] as Array<() => void>,
    wake: [] as Array<(sleepDurationMs: number) => void>,
  },
  helpPanelState: {
    isOpen: true,
    width: 380,
    terminalId: null as string | null,
    agentId: null as string | null,
    preferredAgentId: null as string | null,
    sessionId: null as string | null,
    introDismissed: true,
    conversationTouched: false,
    hibernateSessions: {} as Record<string, { sessionId: string; cwd: string; agentId: string }>,
    markConversationStarted: vi.fn(),
    setWidth: vi.fn(),
    setOpen: vi.fn(),
    clearTerminal: vi.fn(),
    setPreferredAgent: vi.fn(),
    setTerminal: vi.fn(),
    dismissIntro: vi.fn(),
    setHibernateSession: vi.fn(),
    clearHibernateSession: vi.fn(),
  },
  panelStoreState: {
    panelIds: [] as string[],
    panelsById: {} as Record<string, unknown>,
    removePanel: vi.fn(),
    addPanel: vi.fn().mockResolvedValue(""),
  },
  cliAvailabilityState: {
    availability: { claude: "ready" } as Record<string, string>,
    isInitialized: true,
    hasRealData: true,
    details: {} as Record<string, unknown>,
  },
  agentSettingsState: {
    settings: { agents: {} as Record<string, unknown> },
  },
  projectStoreState: {
    currentProject: null as { id: string; path: string } | null,
  },
  preferencesState: { reduceAnimations: false },
  terminalInputState: { hybridInputEnabled: true } as { hybridInputEnabled: boolean },
  mockTerminalSubmit: vi.fn(),
  mockTerminalSendKey: vi.fn(),
  mockNotifyUserInput: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...rest }: React.PropsWithChildren<{ onClick?: () => void }>) => (
    <button type="button" onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/icons/DaintreeIcon", () => ({
  DaintreeIcon: () => null,
}));

vi.mock("@/components/Terminal/XtermAdapter", () => ({
  XtermAdapter: () => <div data-testid="xterm-adapter" />,
}));

vi.mock("@/components/Terminal/HybridInputBar", () => ({
  HybridInputBar: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="hybrid-input-bar" data-terminal-id={terminalId} />
  ),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    submit: (...args: unknown[]) => mockTerminalSubmit(...args),
    sendKey: (...args: unknown[]) => mockTerminalSendKey(...args),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    focus: vi.fn(),
    notifyUserInput: (...args: unknown[]) => mockNotifyUserInput(...args),
  },
}));

vi.mock("@/components/Terminal/MissingCliGate", () => ({
  MissingCliGate: ({ agentId, onRunAnyway }: { agentId: string; onRunAnyway: () => void }) => (
    <div data-testid="missing-cli-gate" data-agent={agentId}>
      <button type="button" data-testid="run-anyway" onClick={onRunAnyway}>
        Run anyway
      </button>
    </div>
  ),
}));

vi.mock("@shared/config/agentIds", () => {
  const ids = ["claude"];
  return {
    BUILT_IN_AGENT_IDS: ids,
    isBuiltInAgentId: (value: unknown): value is "claude" =>
      typeof value === "string" && ids.includes(value),
  };
});

vi.mock("@/config/agents", () => ({
  AGENT_REGISTRY: {
    claude: { name: "Claude", iconId: "claude", color: "#000", icon: () => null },
  },
  getAgentConfig: () => ({ name: "Claude", icon: () => null, models: [] }),
  getAssistantSupportedAgentIds: () => mockGetAssistantSupportedAgentIds(),
  getAgentIds: () => ["claude"],
}));

vi.mock("@shared/types/agentSettings", () => ({
  buildResumeCommand: (...args: unknown[]) => mockBuildResumeCommand(...args),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => mockDispatch(...args) },
}));

vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

vi.mock("@/utils/logger", () => ({
  logError: (...args: unknown[]) => mockLogError(...args),
}));

vi.mock("@/utils/safeFireAndForget", () => ({
  safeFireAndForget: (promise: Promise<unknown>) => promise,
}));

vi.mock("@/store/helpPanelStore", () => {
  const store = (selector?: (state: typeof helpPanelState) => unknown) =>
    selector ? selector(helpPanelState) : helpPanelState;
  store.getState = () => helpPanelState;
  return {
    useHelpPanelStore: store,
    HELP_PANEL_MIN_WIDTH: 320,
    HELP_PANEL_MAX_WIDTH: 800,
  };
});

vi.mock("@/store", () => {
  const panelStore = (selector?: (state: typeof panelStoreState) => unknown) =>
    selector ? selector(panelStoreState) : panelStoreState;
  panelStore.getState = () => panelStoreState;

  const cliStore = (selector?: (state: typeof cliAvailabilityState) => unknown) =>
    selector ? selector(cliAvailabilityState) : cliAvailabilityState;
  cliStore.getState = () => cliAvailabilityState;

  const agentSettingsStore = (selector?: (state: typeof agentSettingsState) => unknown) =>
    selector ? selector(agentSettingsState) : agentSettingsState;
  agentSettingsStore.getState = () => agentSettingsState;

  const projectStore = (selector?: (state: typeof projectStoreState) => unknown) =>
    selector ? selector(projectStoreState) : projectStoreState;
  projectStore.getState = () => projectStoreState;

  const preferencesStore = (selector?: (state: typeof preferencesState) => unknown) =>
    selector ? selector(preferencesState) : preferencesState;
  preferencesStore.getState = () => preferencesState;

  const worktreeSelectionState = { activeWorktreeId: null as string | null };
  const worktreeSelectionStore = (selector?: (state: typeof worktreeSelectionState) => unknown) =>
    selector ? selector(worktreeSelectionState) : worktreeSelectionState;
  worktreeSelectionStore.getState = () => worktreeSelectionState;

  const terminalInputStore = (selector?: (state: typeof terminalInputState) => unknown) =>
    selector ? selector(terminalInputState) : terminalInputState;
  terminalInputStore.getState = () => terminalInputState;

  return {
    usePanelStore: panelStore,
    useCliAvailabilityStore: cliStore,
    useAgentSettingsStore: agentSettingsStore,
    useProjectStore: projectStore,
    usePreferencesStore: preferencesStore,
    useWorktreeSelectionStore: worktreeSelectionStore,
    useTerminalInputStore: terminalInputStore,
    getTerminalRefreshTier: () => 0,
  };
});

vi.mock("@/store/macroFocusStore", () => {
  const state = { focusedRegion: null, setRegionRef: vi.fn(), setVisibility: vi.fn() };
  const store = (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state);
  store.getState = () => state;
  return { useMacroFocusStore: store };
});

vi.mock("@/lib/sidebarToggle", () => ({
  suppressSidebarResizes: vi.fn(),
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    onConfirm,
    onClose,
  }: {
    isOpen: boolean;
    title: React.ReactNode;
    onConfirm: () => void;
    onClose?: () => void;
  }) =>
    isOpen ? (
      <div role="dialog" data-testid="confirm-dialog">
        <h2>{title}</h2>
        <button data-testid="dialog-cancel" onClick={onClose}>
          Cancel
        </button>
        <button data-testid="dialog-confirm" onClick={onConfirm}>
          Confirm
        </button>
      </div>
    ) : null,
}));

vi.mock("@/hooks/useEscapeStack", () => ({
  useEscapeStack: vi.fn(),
}));

vi.mock("@/types", () => ({
  TerminalRefreshTier: { BACKGROUND: 0, ACTIVE: 1 },
}));

import { HelpPanel } from "../HelpPanel";

function resetState() {
  helpPanelState.isOpen = true;
  helpPanelState.width = 380;
  helpPanelState.terminalId = null;
  helpPanelState.agentId = null;
  helpPanelState.preferredAgentId = null;
  helpPanelState.sessionId = null;
  helpPanelState.introDismissed = true;
  helpPanelState.conversationTouched = false;
  helpPanelState.hibernateSessions = {};
  helpPanelState.markConversationStarted = vi.fn();
  helpPanelState.setTerminal = vi.fn();
  helpPanelState.setOpen = vi.fn();
  helpPanelState.setWidth = vi.fn();
  helpPanelState.clearTerminal = vi.fn();
  helpPanelState.setPreferredAgent = vi.fn();
  helpPanelState.dismissIntro = vi.fn();
  helpPanelState.setHibernateSession = vi.fn();
  helpPanelState.clearHibernateSession = vi.fn();

  panelStoreState.panelIds = [];
  panelStoreState.panelsById = {};
  panelStoreState.removePanel = vi.fn();
  panelStoreState.addPanel = vi.fn().mockResolvedValue("");

  cliAvailabilityState.availability = { claude: "ready" };
  cliAvailabilityState.isInitialized = true;
  cliAvailabilityState.hasRealData = true;
  cliAvailabilityState.details = {};

  agentSettingsState.settings = { agents: {} };

  projectStoreState.currentProject = null;
  preferencesState.reduceAnimations = false;
  terminalInputState.hybridInputEnabled = true;
  mockTerminalSubmit.mockReset();
  mockTerminalSubmit.mockResolvedValue(undefined);
  mockTerminalSendKey.mockReset();
  mockNotifyUserInput.mockReset();
  mockProvisionSession.mockReset();
  mockProvisionSession.mockResolvedValue(null);
  mockRevokeSession.mockReset();
  mockRevokeSession.mockResolvedValue(undefined);
  mockGracefulKill.mockReset();
  mockGracefulKill.mockResolvedValue(null);
  mockBuildResumeCommand.mockReset();
  mockBuildResumeCommand.mockReturnValue("claude --resume abc-123");
  mockGetAssistantSupportedAgentIds.mockReset();
  mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
  mockGetHelpAssistantSettings.mockReset();
  mockGetHelpAssistantSettings.mockResolvedValue({
    docSearch: true,
    daintreeControl: true,
    tier: "action" as const,
    bypassPermissions: false,
    auditRetention: 7,
    customArgs: "",
    idleHibernateMinutes: 30,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();

  systemSleepListeners.suspend.length = 0;
  systemSleepListeners.wake.length = 0;
  mockSystemSleepGetMetrics.mockReset();
  mockSystemSleepGetMetrics.mockResolvedValue({
    totalSleepMs: 0,
    sleepPeriods: [],
    isCurrentlySleeping: false,
    currentSleepStart: null,
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
  mockSystemSleepOnWake.mockImplementation((cb: (sleepDurationMs: number) => void) => {
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
          getFolderPath: mockGetFolderPath,
          markTerminal: mockMarkTerminal,
          provisionSession: mockProvisionSession,
          revokeSession: mockRevokeSession,
        },
        helpAssistant: {
          getSettings: mockGetHelpAssistantSettings,
        },
        systemSleep: {
          getMetrics: mockSystemSleepGetMetrics,
          onSuspend: mockSystemSleepOnSuspend,
          onWake: mockSystemSleepOnWake,
        },
        terminal: {
          gracefulKill: mockGracefulKill,
        },
        mcpServer: {
          onTierNotPermitted: vi.fn(() => () => {}),
          setSessionTier: vi.fn().mockResolvedValue({ sessionId: "", tier: "workbench" }),
          issueGrant: vi.fn().mockResolvedValue({
            sessionId: "",
            toolId: "",
            ttlMs: 900_000,
            expiresAt: Date.now() + 900_000,
          }),
        },
        git: {
          snapshotGet: vi.fn().mockResolvedValue(null),
        },
        project: {
          getSettings: vi.fn().mockResolvedValue({}),
          saveSettings: vi.fn().mockResolvedValue(undefined),
        },
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

describe("HelpPanel — resume from hibernated session", () => {
  it("auto-launch resumes via addPanel when hibernateSessions has a matching project + agent entry", async () => {
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      "proj-1": { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
    };
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "fresh-session",
      sessionPath: "/tmp/help/proj-1",
      token: "tok",
      mcpUrl: "http://localhost:1234",
      windowId: 1,
    });
    panelStoreState.addPanel = vi.fn().mockResolvedValue("resumed-term-1");

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockBuildResumeCommand).toHaveBeenCalledWith("claude", "abc-123", undefined);
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        launchAgentId: "claude",
        command: "claude --resume abc-123",
        cwd: "/tmp/help/proj-1",
        ephemeral: true,
      })
    );
    // Resume bypasses the standard agent.launch dispatch.
    expect(mockDispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1");
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      "resumed-term-1",
      "claude",
      "fresh-session"
    );
  });

  it("renders the resume banner after a successful resume", async () => {
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      "proj-1": { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
    };
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "fresh-session",
      sessionPath: "/tmp/help/proj-1",
      token: "tok",
      mcpUrl: null,
      windowId: 1,
    });
    panelStoreState.addPanel = vi.fn().mockImplementation(async () => {
      // After addPanel resolves, reflect the new terminal so the renderer
      // shows the post-launch chrome (where the banner lives).
      helpPanelState.terminalId = "resumed-term-1";
      helpPanelState.agentId = "claude";
      panelStoreState.panelsById = {
        "resumed-term-1": {
          id: "resumed-term-1",
          kind: "terminal",
          spawnStatus: "ready",
          cwd: "/tmp/help/proj-1",
        },
      };
      return "resumed-term-1";
    });

    const { findByTestId } = render(<HelpPanel width={380} />);

    const banner = await findByTestId("help-resume-banner");
    expect(banner.textContent).toContain("Resumed your previous session");
  });

  it("does not resume when the hibernated entry is for a different agent", async () => {
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      "proj-1": { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "gemini" },
    };
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "fresh-session",
      sessionPath: "/tmp/help/proj-1",
      token: "tok",
      mcpUrl: null,
      windowId: 1,
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "fresh-term" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockBuildResumeCommand).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
    expect(helpPanelState.clearHibernateSession).not.toHaveBeenCalled();
  });

  it("does not resume when no hibernated entry exists for the current project", async () => {
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      "other-proj": { sessionId: "xyz", cwd: "/tmp/help/other", agentId: "claude" },
    };
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "fresh-session",
      sessionPath: "/tmp/help/proj-1",
      token: "tok",
      mcpUrl: null,
      windowId: 1,
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "fresh-term" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockBuildResumeCommand).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });

  it("falls through to agent.launch when buildResumeCommand returns undefined", async () => {
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      "proj-1": { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
    };
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "fresh-session",
      sessionPath: "/tmp/help/proj-1",
      token: "tok",
      mcpUrl: null,
      windowId: 1,
    });
    // Agent has no resume config — buildResumeCommand returns undefined.
    mockBuildResumeCommand.mockReturnValue(undefined);
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "fresh-term" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1");
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });

  it("falls through to agent.launch when the resumed addPanel returns no id", async () => {
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      "proj-1": { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
    };
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "fresh-session",
      sessionPath: "/tmp/help/proj-1",
      token: "tok",
      mcpUrl: null,
      windowId: 1,
    });
    panelStoreState.addPanel = vi.fn().mockResolvedValue("");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "fresh-term" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1");
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });
});

describe("HelpPanel — resume preserves user-configured launch flags", () => {
  it("threads customArgs into both buildResumeCommand and addPanel.agentLaunchFlags", async () => {
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      "proj-1": { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
    };
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "fresh-session",
      sessionPath: "/tmp/help/proj-1",
      token: "tok",
      mcpUrl: null,
      windowId: 1,
    });
    mockGetHelpAssistantSettings.mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      tier: "action" as const,
      bypassPermissions: false,
      auditRetention: 7,
      customArgs: "--model claude-opus-4-5",
      idleHibernateMinutes: 30,
    });
    panelStoreState.addPanel = vi.fn().mockResolvedValue("resumed-term-1");

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockBuildResumeCommand).toHaveBeenCalledWith("claude", "abc-123", [
      "--model",
      "claude-opus-4-5",
    ]);
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        agentLaunchFlags: ["--model", "claude-opus-4-5"],
      })
    );
  });
});

describe("HelpPanel — idle hibernation timer", () => {
  it("does not remove the panel when the user reopens before gracefulKill resolves (critical race)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      helpPanelState.isOpen = false;
      helpPanelState.terminalId = "t1";
      helpPanelState.agentId = "claude";
      helpPanelState.sessionId = "live-session";
      panelStoreState.panelsById = {
        t1: {
          id: "t1",
          kind: "terminal",
          spawnStatus: "ready",
          cwd: "/help",
          agentState: "idle",
        },
      };
      projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };

      let resolveGracefulKill: (v: string | null) => void = () => {};
      mockGracefulKill.mockReturnValue(
        new Promise<string | null>((resolve) => {
          resolveGracefulKill = resolve;
        })
      );

      await act(async () => {
        render(<HelpPanel width={380} />);
      });

      // Let the settings IPC resolve so the timer arms.
      await act(async () => {
        await Promise.resolve();
      });

      // Fast-forward past the 30-minute hibernate threshold.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      });

      // gracefulKill is now in flight, awaiting our resolution.
      expect(mockGracefulKill).toHaveBeenCalledWith("t1");

      // User reopens the panel before the kill IPC returns.
      helpPanelState.isOpen = true;

      // Now resolve gracefulKill — the .then() must abort because isOpen=true.
      await act(async () => {
        resolveGracefulKill("captured-session");
        await Promise.resolve();
      });

      expect(panelStoreState.removePanel).not.toHaveBeenCalled();
      expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
      expect(helpPanelState.setHibernateSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures the session and clears the terminal when the timer fires on an idle agent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      helpPanelState.isOpen = false;
      helpPanelState.terminalId = "t1";
      helpPanelState.agentId = "claude";
      helpPanelState.sessionId = "live-session";
      panelStoreState.panelsById = {
        t1: {
          id: "t1",
          kind: "terminal",
          spawnStatus: "ready",
          cwd: "/help",
          agentState: "idle",
        },
      };
      projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
      mockGracefulKill.mockResolvedValue("resume-token-xyz");

      await act(async () => {
        render(<HelpPanel width={380} />);
      });

      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      });

      expect(mockGracefulKill).toHaveBeenCalledWith("t1");
      expect(helpPanelState.setHibernateSession).toHaveBeenCalledWith("proj-1", {
        sessionId: "resume-token-xyz",
        cwd: "/help",
        agentId: "claude",
      });
      expect(panelStoreState.removePanel).toHaveBeenCalledWith("t1");
      expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call gracefulKill while the agent is working — defers via the busy re-check", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      helpPanelState.isOpen = false;
      helpPanelState.terminalId = "t1";
      helpPanelState.agentId = "claude";
      panelStoreState.panelsById = {
        t1: {
          id: "t1",
          kind: "terminal",
          spawnStatus: "ready",
          cwd: "/help",
          agentState: "working",
        },
      };
      projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
      mockGracefulKill.mockResolvedValue("should-not-be-captured");

      await act(async () => {
        render(<HelpPanel width={380} />);
      });

      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      });

      expect(mockGracefulKill).not.toHaveBeenCalled();
      expect(helpPanelState.setHibernateSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm the timer when idleHibernateMinutes is 0", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      helpPanelState.isOpen = false;
      helpPanelState.terminalId = "t1";
      helpPanelState.agentId = "claude";
      panelStoreState.panelsById = {
        t1: {
          id: "t1",
          kind: "terminal",
          spawnStatus: "ready",
          cwd: "/help",
          agentState: "idle",
        },
      };
      projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
      mockGetHelpAssistantSettings.mockResolvedValue({
        docSearch: true,
        daintreeControl: true,
        tier: "action" as const,
        bypassPermissions: false,
        auditRetention: 7,
        customArgs: "",
        idleHibernateMinutes: 0,
      });

      await act(async () => {
        render(<HelpPanel width={380} />);
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Advance way past any reasonable hibernate time.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      });

      expect(mockGracefulKill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the persisted entry when gracefulKill returns no session ID", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      helpPanelState.isOpen = false;
      helpPanelState.terminalId = "t1";
      helpPanelState.agentId = "claude";
      // Pre-existing entry from a previous successful hibernate cycle.
      helpPanelState.hibernateSessions = {
        "proj-1": { sessionId: "old", cwd: "/help", agentId: "claude" },
      };
      panelStoreState.panelsById = {
        t1: {
          id: "t1",
          kind: "terminal",
          spawnStatus: "ready",
          cwd: "/help",
          agentState: "idle",
        },
      };
      projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
      mockGracefulKill.mockResolvedValue(null);

      await act(async () => {
        render(<HelpPanel width={380} />);
      });

      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      });

      expect(helpPanelState.setHibernateSession).not.toHaveBeenCalled();
      expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HelpPanel — assistant header state indicator", () => {
  function setupTerminalWithState(state: string) {
    helpPanelState.terminalId = "live-term";
    helpPanelState.agentId = "claude";
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    panelStoreState.panelsById = {
      "live-term": {
        id: "live-term",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/tmp/help/proj-1",
        title: "Claude",
        command: "claude",
        location: "dock",
        agentState: state,
      },
    };
  }

  it("renders the working indicator when the assistant terminal is working", () => {
    setupTerminalWithState("working");

    const { getByTestId } = render(<HelpPanel width={380} />);
    const indicator = getByTestId("assistant-header-state-indicator");
    expect(indicator.getAttribute("data-agent-state")).toBe("working");
    expect(indicator.getAttribute("aria-label")).toBe("Assistant is working");
  });

  it("renders the waiting indicator when the assistant terminal is waiting", () => {
    setupTerminalWithState("waiting");

    const { getByTestId } = render(<HelpPanel width={380} />);
    const indicator = getByTestId("assistant-header-state-indicator");
    expect(indicator.getAttribute("data-agent-state")).toBe("waiting");
    expect(indicator.getAttribute("aria-label")).toBe("Assistant is waiting");
  });

  it("renders the directing indicator when the assistant terminal is directing", () => {
    setupTerminalWithState("directing");

    const { getByTestId } = render(<HelpPanel width={380} />);
    const indicator = getByTestId("assistant-header-state-indicator");
    expect(indicator.getAttribute("data-agent-state")).toBe("directing");
    expect(indicator.getAttribute("aria-label")).toBe("Assistant is directing");
  });

  it("does not render an indicator for idle, completed, or exited states", () => {
    for (const state of ["idle", "completed", "exited"]) {
      setupTerminalWithState(state);
      const { queryByTestId, unmount } = render(<HelpPanel width={380} />);
      expect(queryByTestId("assistant-header-state-indicator")).toBeNull();
      unmount();
    }
  });

  it("does not render an indicator before any assistant terminal exists", () => {
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    panelStoreState.panelsById = {};

    const { queryByTestId } = render(<HelpPanel width={380} />);
    expect(queryByTestId("assistant-header-state-indicator")).toBeNull();
  });
});

describe("HelpPanel — + New session clears hibernated entry", () => {
  it("clearHibernateSession is called for the current project when starting a new session", async () => {
    helpPanelState.terminalId = "live-term";
    helpPanelState.agentId = "claude";
    helpPanelState.conversationTouched = false;
    helpPanelState.introDismissed = true;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    panelStoreState.panelsById = {
      "live-term": {
        id: "live-term",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/tmp/help/proj-1",
        title: "Claude",
        command: "claude",
        location: "dock",
        agentState: "idle",
      },
    };
    mockProvisionSession.mockResolvedValue({
      sessionId: "new-session",
      sessionPath: "/tmp/help/proj-1",
      token: "tok",
      mcpUrl: null,
      windowId: 1,
    });
    panelStoreState.addPanel = vi.fn().mockResolvedValue("new-term");

    const { container } = render(<HelpPanel width={380} />);

    const newSessionBtn = container.querySelector('button[aria-label="Start new session"]')!;
    expect(newSessionBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(newSessionBtn);
    });

    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1");
  });
});
