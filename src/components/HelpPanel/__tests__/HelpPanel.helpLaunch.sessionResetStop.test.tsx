// @vitest-environment jsdom
import { render, fireEvent, act, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDispatch,
  mockNotify,
  mockLogError,
  mockGetFolderPath,
  mockMarkTerminal,
  mockProvisionSession,
  mockRevokeSession,
  mockTakePendingHibernation,
  mockGetAssistantSupportedAgentIds,
  mockGetHelpAssistantSettings,
  mockGetAgentVersion,
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
  worktreeSelectionState,
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
  mockTakePendingHibernation: vi.fn().mockResolvedValue(null),
  mockGetAssistantSupportedAgentIds: vi.fn(() => ["claude"]),
  mockGetHelpAssistantSettings: vi.fn().mockResolvedValue({
    docSearch: true,
    daintreeControl: true,
    tier: "action" as const,
    bypassPermissions: false,
    auditRetention: 7,
    customArgs: "",
  }),
  mockGetAgentVersion: vi.fn().mockResolvedValue({
    agentId: "claude",
    installedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    lastChecked: null,
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
    // Consent granted by default (#10699) so the existing auto-launch coverage
    // exercises the downstream launch wiring; the consent gate itself is
    // unit-tested in HelpSessionController.test.ts.
    autoLaunchEnabled: true,
    sessionId: null as string | null,
    introDismissed: true,
    conversationTouched: false,
    hibernateSessions: {} as Record<string, { sessionId: string; cwd: string; agentId: string }>,
    figures: [] as unknown[],
    markConversationStarted: vi.fn(),
    setWidth: vi.fn(),
    setOpen: vi.fn(),
    setAutoLaunchEnabled: vi.fn(),
    clearTerminal: vi.fn(),
    setPreferredAgent: vi.fn(),
    setTerminal: vi.fn(),
    dismissIntro: vi.fn(),
    setHibernateSession: vi.fn(),
    clearHibernateSession: vi.fn(),
    addFigure: vi.fn(),
    clearFigures: vi.fn(),
  },
  panelStoreState: {
    panelIds: [] as string[],
    panelsById: {} as Record<string, unknown>,
    removePanel: vi.fn(),
    addPanel: vi.fn().mockResolvedValue(""),
  },
  cliAvailabilityState: {
    availability: { claude: "ready", gemini: "ready", codex: "ready", opencode: "ready" } as Record<
      string,
      string
    >,
    isInitialized: true,
    hasRealData: true,
    details: {} as Record<string, unknown>,
  },
  agentSettingsState: {
    settings: { agents: {} as Record<string, unknown> },
  },
  projectStoreState: {
    currentProject: { id: "proj-default", path: "/repo" } as { id: string; path: string } | null,
  },
  preferencesState: { reduceAnimations: false },
  terminalInputState: { hybridInputEnabled: true } as { hybridInputEnabled: boolean },
  worktreeSelectionState: {
    activeWorktreeId: null as string | null,
    focusedWorktreeId: null as string | null,
    selectWorktree: vi.fn(),
  },
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

// Pass-through dropdown mock (same shape as PanelHeader.test.tsx) — the header
// hosts Stop/Docs in a lazily-loaded Radix overflow menu; render its items as
// plain buttons so tests can click them without driving Radix.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="overflow-menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    destructive,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    destructive?: boolean;
  }) => (
    <button
      data-destructive={destructive || undefined}
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/components/icons/DaintreeIcon", () => ({
  DaintreeIcon: () => null,
}));

vi.mock("@/components/Terminal/XtermAdapter", () => ({
  XtermAdapter: () => <div data-testid="xterm-adapter" />,
}));

vi.mock("@/components/Terminal/HybridInputBar", () => ({
  HybridInputBar: ({
    terminalId,
    onSend,
    onSendKey,
    disabled,
  }: {
    terminalId: string;
    onSend?: (payload: { data: string; trackerData: string; text: string }) => void;
    onSendKey?: (key: string) => void;
    disabled?: boolean;
  }) => (
    <div
      data-testid="hybrid-input-bar"
      data-terminal-id={terminalId}
      data-disabled={disabled ? "true" : "false"}
    >
      <button
        type="button"
        data-testid="hybrid-input-send"
        onClick={() => onSend?.({ data: "hello", trackerData: "hello", text: "hello" })}
      >
        send
      </button>
      <button type="button" data-testid="hybrid-input-key" onClick={() => onSendKey?.("escape")}>
        key
      </button>
    </div>
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
    setFocused: vi.fn(),
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
  const ids = ["claude", "gemini", "codex"];
  return {
    BUILT_IN_AGENT_IDS: ids,
    ASSISTANT_ONLY_AGENT_IDS: [],
    LAUNCHABLE_AGENT_IDS: ids,
    isBuiltInAgentId: (value: unknown): value is "claude" | "gemini" | "codex" =>
      typeof value === "string" && ids.includes(value),
    isAssistantOnlyAgentId: () => false,
  };
});

vi.mock("@/config/agents", () => ({
  AGENT_REGISTRY: {
    claude: { name: "Claude", iconId: "claude", color: "#000", icon: () => null },
    gemini: { name: "Gemini", iconId: "gemini", color: "#000", icon: () => null },
    codex: { name: "Codex", iconId: "codex", color: "#000", icon: () => null },
  },
  getAgentConfig: (id: string) =>
    ({
      claude: {
        name: "Claude",
        icon: () => null,
        models: [],
        assistantMinVersion: "1.0.0",
      },
      gemini: { name: "Gemini", icon: () => null, models: [] },
      codex: { name: "Codex", icon: () => null, models: [] },
    })[id],
  getAssistantSupportedAgentIds: () => mockGetAssistantSupportedAgentIds(),
  getAgentIds: () => ["claude", "gemini", "codex"],
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => mockDispatch(...args),
    getContext: () => ({}),
  },
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
  const state = {
    focusedRegion: null as string | null,
    setRegionRef: vi.fn(),
    setVisibility: vi.fn(),
  };
  const store = (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state);
  store.getState = () => state;
  store.setState = (
    partial: Partial<typeof state> | ((s: typeof state) => Partial<typeof state>)
  ) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    Object.assign(state, next);
  };
  return {
    useMacroFocusStore: store,
    // Mirrors the real contract (macroFocusStore.ts:94) closely enough for these
    // suites: the assistant owns focus when its macro region is selected.
    isAssistantFocused: () => state.focusedRegion === "assistant",
  };
});

vi.mock("@/lib/sidebarToggle", () => ({
  suppressSidebarResizes: vi.fn(),
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    description,
    confirmLabel,
    cancelLabel = "Cancel",
    onConfirm,
    onClose,
  }: {
    isOpen: boolean;
    title: React.ReactNode;
    description?: React.ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onClose?: () => void;
  }) =>
    isOpen ? (
      <div role="dialog" data-testid="confirm-dialog">
        <h2 data-testid="dialog-title">{title}</h2>
        <p data-testid="dialog-description">{description}</p>
        <button data-testid="dialog-cancel" onClick={onClose}>
          {cancelLabel}
        </button>
        <button data-testid="dialog-confirm" onClick={onConfirm}>
          {confirmLabel}
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

// The figure rail pulls the real AppDialog (lightbox) into the module graph,
// which drags the @/hooks → panelPersistence chain past this suite's store
// mocks. The rail isn't under test here, so stub it like the other heavy
// children (XtermAdapter, ConfirmDialog) — its own suite is FigureRail.test.tsx.
vi.mock("../FigureRail", () => ({ FigureRail: () => null }));

import { HelpPanel } from "../HelpPanel";

// The real `app:view-revealed` bridge fans out to every registered listener;
// HelpPanel registers the switch-back recovery effect against it (#10739).
let viewRevealedCbs: Array<() => void> = [];

function resetState() {
  viewRevealedCbs = [];
  helpPanelState.isOpen = true;
  helpPanelState.width = 380;
  helpPanelState.terminalId = null;
  helpPanelState.agentId = null;
  helpPanelState.preferredAgentId = null;
  helpPanelState.autoLaunchEnabled = true;
  helpPanelState.sessionId = null;
  helpPanelState.introDismissed = true;
  helpPanelState.conversationTouched = false;
  helpPanelState.hibernateSessions = {};
  helpPanelState.figures = [];
  helpPanelState.markConversationStarted = vi.fn();
  helpPanelState.setTerminal = vi.fn();
  helpPanelState.setOpen = vi.fn();
  helpPanelState.setAutoLaunchEnabled = vi.fn();
  helpPanelState.setWidth = vi.fn();
  helpPanelState.clearTerminal = vi.fn();
  helpPanelState.setPreferredAgent = vi.fn();
  helpPanelState.dismissIntro = vi.fn();
  helpPanelState.setHibernateSession = vi.fn();
  helpPanelState.clearHibernateSession = vi.fn();
  helpPanelState.addFigure = vi.fn();
  helpPanelState.clearFigures = vi.fn();

  panelStoreState.panelIds = [];
  panelStoreState.panelsById = {};
  panelStoreState.removePanel = vi.fn();
  panelStoreState.addPanel = vi.fn().mockResolvedValue("");

  cliAvailabilityState.availability = {
    claude: "ready",
    gemini: "ready",
    codex: "ready",
    opencode: "ready",
  };
  cliAvailabilityState.isInitialized = true;
  cliAvailabilityState.hasRealData = true;
  cliAvailabilityState.details = {};

  agentSettingsState.settings = { agents: {} };

  projectStoreState.currentProject = { id: "proj-default", path: "/repo" };
  preferencesState.reduceAnimations = false;
  terminalInputState.hybridInputEnabled = true;
  worktreeSelectionState.activeWorktreeId = null;
  worktreeSelectionState.focusedWorktreeId = null;
  worktreeSelectionState.selectWorktree = vi.fn();
  mockTerminalSubmit.mockReset();
  mockTerminalSubmit.mockResolvedValue(undefined);
  mockTerminalSendKey.mockReset();
  mockNotifyUserInput.mockReset();
  mockProvisionSession.mockReset();
  mockProvisionSession.mockResolvedValue({
    sessionId: "sess-default",
    sessionPath: "/help",
    token: "tok-default",
    tier: "action",
    mcpUrl: null,
    windowId: 1,
  });
  mockRevokeSession.mockReset();
  mockRevokeSession.mockResolvedValue(undefined);
  mockTakePendingHibernation.mockReset();
  mockTakePendingHibernation.mockResolvedValue(null);
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
  });
  mockGetAgentVersion.mockReset();
  mockGetAgentVersion.mockResolvedValue({
    agentId: "claude",
    installedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    lastChecked: null,
  });
}

afterEach(() => {
  // Unmount any rendered HelpPanel so its controller's in-flight launch can't
  // leak fire-and-forget state updates into the next test (#8771 added phase
  // patches on the launch success/abandon paths, which surfaced this latent
  // cross-test bleed).
  cleanup();
});

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
          takePendingHibernation: mockTakePendingHibernation,
          restorePendingHibernation: vi.fn().mockResolvedValue(false),
          getPinnedActionContext: vi.fn().mockResolvedValue({}),
        },
        helpAssistant: {
          getSettings: mockGetHelpAssistantSettings,
        },
        system: {
          getAgentVersion: mockGetAgentVersion,
        },
        systemSleep: {
          getMetrics: mockSystemSleepGetMetrics,
          onSuspend: mockSystemSleepOnSuspend,
          onWake: mockSystemSleepOnWake,
        },
        mcpServer: {
          getAuditRecords: vi.fn().mockResolvedValue([]),
          onTierNotPermitted: vi.fn(() => () => {}),
          onToolCallStarted: vi.fn(() => () => {}),
          onToolCallSettled: vi.fn(() => () => {}),
          onDisplayImage: vi.fn(() => () => {}),
          onSessionRevoked: vi.fn(() => () => {}),
          onGrantLifecycle: vi.fn(() => () => {}),
          onTurnOutcomeAlert: vi.fn(() => () => {}),
          setSessionTier: vi.fn().mockResolvedValue({ sessionId: "", tier: "workbench" }),
          resetDenialCounts: vi.fn().mockResolvedValue(undefined),
          issueGrant: vi.fn().mockResolvedValue({
            sessionId: "",
            toolId: "",
            ttlMs: 900_000,
            expiresAt: Date.now() + 900_000,
          }),
        },
        project: {
          getSettings: vi.fn().mockResolvedValue({}),
          saveSettings: vi.fn().mockResolvedValue(undefined),
        },
        app: {
          onViewRevealed: (cb: () => void) => {
            viewRevealedCbs.push(cb);
            return () => {
              viewRevealedCbs = viewRevealedCbs.filter((c) => c !== cb);
            };
          },
        },
      },
    },
    writable: true,
    configurable: true,
  });

  // Default: visibility is "visible"
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

describe("HelpPanel — + New session destructive reset", () => {
  function setupBoundTerminal(opts: {
    agentState?: string;
    conversationTouched?: boolean;
    sessionId?: string | null;
  }) {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = opts.sessionId ?? "sess-bound";
    helpPanelState.conversationTouched = opts.conversationTouched ?? false;
    panelStoreState.panelsById = {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
        agentState: opts.agentState ?? "idle",
      },
    };
  }

  it("hides the + button when there is no live terminal", () => {
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    const { container } = render(<HelpPanel width={380} />);
    expect(container.querySelector('button[aria-label="Start new session"]')).toBeNull();
  });

  it("resets immediately without a confirm when the agent is idle and conversation is untouched", async () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: false });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "terminal-fresh" } });
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-fresh",
      sessionPath: "/sessions/fresh",
      token: "tok-fresh",
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });

    const { container, queryByTestId } = render(<HelpPanel width={380} />);
    await act(async () => {
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    });

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(mockRevokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentId: "claude",
        requestedId: expect.stringMatching(/^terminal-/),
        activateDockOnCreate: true,
        excludeFromPersistence: true,
        removeOnExit: true,
      }),
      { source: "user" }
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      "terminal-fresh",
      "claude",
      "sess-fresh"
    );
  });

  it("shows the confirm dialog when the agent is working", () => {
    setupBoundTerminal({ agentState: "working", conversationTouched: false });

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
    expect(getByTestId("dialog-title").textContent).toBe("Start a new session?");
    expect(getByTestId("dialog-confirm").textContent).toBe("Start new session");
    expect(getByTestId("dialog-description").textContent).toContain(
      "the conversation will be discarded"
    );
  });

  it("shows the confirm dialog when the conversation has been touched", () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: true });

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(getByTestId("dialog-title").textContent).toBe("Start a new session?");
  });

  it("keeps the session intact when the user cancels the confirm dialog", () => {
    setupBoundTerminal({ agentState: "working" });

    const { container, getByTestId, queryByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    fireEvent.click(getByTestId("dialog-cancel"));

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(mockRevokeSession).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
  });

  it("runs the destructive teardown and relaunches when the user confirms", async () => {
    setupBoundTerminal({ agentState: "working", conversationTouched: true });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "terminal-fresh" } });
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-fresh",
      sessionPath: "/sessions/fresh",
      token: "tok-fresh",
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    await act(async () => {
      fireEvent.click(getByTestId("dialog-confirm"));
    });

    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(mockRevokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      "terminal-fresh",
      "claude",
      "sess-fresh"
    );
  });

  it("reserves the new help-terminal id BEFORE dispatch resolves (race fix for #6951)", async () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: false });
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-fresh",
      sessionPath: "/sessions/fresh",
      token: "tok-fresh",
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });

    let resolveDispatch: (value: unknown) => void = () => {};
    mockDispatch.mockImplementation(() => {
      return new Promise((r) => {
        resolveDispatch = r;
      });
    });

    const { container } = render(<HelpPanel width={380} />);
    await act(async () => {
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    });

    // Pre-set already fired with the same id we passed as requestedId.
    const capturedRequestedId = (
      mockDispatch.mock.calls[0]?.[1] as { requestedId?: string } | undefined
    )?.requestedId;
    expect(capturedRequestedId).toMatch(/^terminal-/);
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(capturedRequestedId, "claude", null);

    await act(async () => {
      resolveDispatch({ ok: true, result: { terminalId: capturedRequestedId! } });
    });
  });

  it("forwards requestedId and activateDockOnCreate to agent.launch dispatch", async () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: false });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "fresh" } });
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-fresh",
      sessionPath: "/sessions/fresh",
      token: "tok-fresh",
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });

    const { container } = render(<HelpPanel width={380} />);
    await act(async () => {
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        requestedId: expect.stringMatching(/^terminal-/),
        activateDockOnCreate: true,
      }),
      { source: "user" }
    );
  });

  it("reverts the reserved id when agent.launch dispatch fails (no ghost helpTerminalId)", async () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: false });
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-fresh",
      sessionPath: "/sessions/fresh",
      token: "tok-fresh",
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });
    mockDispatch.mockResolvedValue({ ok: false });

    const { container } = render(<HelpPanel width={380} />);
    await act(async () => {
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    });

    // setTerminal called once (pre-set), then clearTerminal reverted it on !ok.
    // setTerminal must NOT be called again with a session id.
    const setCalls = (helpPanelState.setTerminal as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls.length).toBe(1);
    expect(setCalls[0]?.[2]).toBeNull();
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(screen.getByTestId("help-launch-error-banner")).toBeTruthy();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("reverts the reserved id when provisionHelpSession returns a non-ok outcome", async () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: false });
    const mcpErr = new Error("MCP server not ready") as Error & { code: string };
    mcpErr.code = "MCP_NOT_READY";
    mockProvisionSession.mockRejectedValueOnce(mcpErr);

    const { container } = render(<HelpPanel width={380} />);
    await act(async () => {
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    });

    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
    const setCalls = (helpPanelState.setTerminal as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls.length).toBe(1);
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
  });

  it("does NOT wipe the reservation when the cleanup effect re-runs mid-launch", async () => {
    // Regression: without the pendingNewTerminalIdRef guard in the cleanup
    // effect at HelpPanel.tsx:221, a re-render fired while
    // `terminalId === newId` but `panelsById[newId]` is not yet committed
    // would observe `terminalId && !terminal` and call clearTerminal —
    // re-opening the dock-leak gap that #6951 closes. This test wires up a
    // stateful setTerminal/clearTerminal so React actually sees the
    // intermediate state (the standard mocks are vi.fn() and don't mutate).
    setupBoundTerminal({ agentState: "idle", conversationTouched: false });

    helpPanelState.setTerminal = vi
      .fn()
      .mockImplementation((tId: string, aId: string, sId: string | null) => {
        helpPanelState.terminalId = tId;
        helpPanelState.agentId = aId;
        helpPanelState.sessionId = sId;
      });
    helpPanelState.clearTerminal = vi.fn().mockImplementation(() => {
      helpPanelState.terminalId = null;
      helpPanelState.agentId = null;
      helpPanelState.sessionId = null;
    });

    // Hold provisionHelpSession to keep us in the in-flight window.
    let resolveProvision: ((value: unknown) => void) | undefined;
    mockProvisionSession.mockImplementation(
      () =>
        new Promise((r) => {
          resolveProvision = r;
        })
    );

    const { container, rerender } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    });

    // We're in the in-flight window. Force a re-render so the cleanup
    // effect re-evaluates: terminalId is the reserved id, panelsById has
    // no entry for it yet. The ref guard must suppress the cleanup.
    await act(async () => {
      rerender(<HelpPanel width={380} />);
    });

    // Exactly one clearTerminal call (the explicit synchronous reset
    // before the pre-set). If the effect had fired, we'd see 2+.
    expect(helpPanelState.clearTerminal).toHaveBeenCalledTimes(1);
    expect(helpPanelState.terminalId).toMatch(/^terminal-/);

    // Drain the pending promise so vitest's act() doesn't warn.
    await act(async () => {
      resolveProvision?.(null);
    });
  });

  it("forwards fresh customArgs from settings to agent.launch dispatch", async () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: false });
    mockGetHelpAssistantSettings.mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      tier: "action" as const,
      bypassPermissions: false,
      auditRetention: 7,
      customArgs: "--model sonnet",
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "fresh-term" } });
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-fresh",
      sessionPath: "/sessions/fresh",
      token: "tok-fresh",
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });

    const { container } = render(<HelpPanel width={380} />);
    await act(async () => {
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentLaunchFlags: ["--model", "sonnet"],
      }),
      { source: "user" }
    );
  });
});

describe("HelpPanel — Stop assistant (end session, #10989)", () => {
  function setupBoundTerminal(opts: {
    agentState?: string;
    conversationTouched?: boolean;
    sessionId?: string | null;
  }) {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = opts.sessionId ?? "sess-bound";
    helpPanelState.conversationTouched = opts.conversationTouched ?? false;
    panelStoreState.panelsById = {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
        agentState: opts.agentState ?? "idle",
      },
    };
  }

  // The stop control lives in the header's overflow menu (rendered flat by the
  // dropdown pass-through mock above). Scoped to the overflow container so the
  // confirm dialog's identically-worded "Stop assistant" button never matches.
  function queryStopItem(container: HTMLElement): HTMLButtonElement | null {
    return (
      [
        ...container.querySelectorAll<HTMLButtonElement>("[data-testid='overflow-menu'] button"),
      ].find((b) => b.textContent?.includes("Stop assistant")) ?? null
    );
  }

  it("hides the Stop assistant menu item when there is no live terminal", () => {
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    const { container } = render(<HelpPanel width={380} />);
    expect(queryStopItem(container)).toBeNull();
  });

  it("keeps the stop item out of the primary row, distinct from the hide button", () => {
    setupBoundTerminal({ agentState: "idle" });
    const { container } = render(<HelpPanel width={380} />);
    expect(queryStopItem(container)).toBeTruthy();
    expect(container.querySelector('button[aria-label="Hide Daintree Assistant"]')).toBeTruthy();
    // No dedicated header stop icon — only the overflow item.
    expect(container.querySelector('button[aria-label="Stop Daintree Assistant"]')).toBeNull();
  });

  it("ends immediately without a confirm and does NOT relaunch when idle and untouched", () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: false });

    const { container, queryByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(queryStopItem(container)!);

    expect(queryByTestId("confirm-dialog")).toBeNull();
    // Teardown ran…
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(mockRevokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(helpPanelState.clearFigures).toHaveBeenCalled();
    // …the persisted hibernate entry is dropped so a stop can't be resumed…
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1");
    // …and, unlike + New session, no fresh agent is launched.
    expect(mockDispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    // …and the panel slides out rather than lingering on the empty state (#11833).
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
  });

  it("shows the Stop assistant confirm when the agent is working (no teardown yet)", () => {
    setupBoundTerminal({ agentState: "working", conversationTouched: false });

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(queryStopItem(container)!);

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
    expect(getByTestId("dialog-title").textContent).toBe("Stop assistant?");
    expect(getByTestId("dialog-confirm").textContent).toBe("Stop assistant");
    expect(getByTestId("dialog-description").textContent).toContain(
      "the conversation will be discarded"
    );
  });

  it("shows the confirm when the conversation has been touched even while idle", () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: true });

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(queryStopItem(container)!);

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(getByTestId("dialog-title").textContent).toBe("Stop assistant?");
  });

  it("keeps the session intact when the user cancels the confirm", () => {
    setupBoundTerminal({ agentState: "working" });

    const { container, getByTestId, queryByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(queryStopItem(container)!);
    fireEvent.click(getByTestId("dialog-cancel"));

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(mockRevokeSession).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
  });

  it("tears down and does not relaunch when the user confirms the stop", () => {
    setupBoundTerminal({ agentState: "working", conversationTouched: true });

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(queryStopItem(container)!);
    fireEvent.click(getByTestId("dialog-confirm"));

    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(mockRevokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1");
    expect(mockDispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
    // The same confirmation gates both the teardown and the slide-out (#11833).
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
  });

  it("aborts a relaunch in flight so a late-settling dispatch never binds a fresh session", async () => {
    // Regression: user hits Stop while a + New session relaunch is mid-flight.
    // endSession() bumps the launch generation so the superseded _executeLaunch
    // bails at its post-dispatch gen-check instead of binding the fresh session.
    setupBoundTerminal({ agentState: "idle", conversationTouched: false });
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-fresh",
      sessionPath: "/sessions/fresh",
      token: "tok-fresh",
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });
    let resolveDispatch: (value: unknown) => void = () => {};
    mockDispatch.mockImplementation(
      () =>
        new Promise((r) => {
          resolveDispatch = r;
        })
    );

    const { container } = render(<HelpPanel width={380} />);
    // Start the relaunch (idle + untouched → immediate, no confirm); dispatch hangs.
    await act(async () => {
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    });
    const reservedId = (mockDispatch.mock.calls[0]?.[1] as { requestedId?: string } | undefined)
      ?.requestedId;
    expect(reservedId).toMatch(/^terminal-/);
    (helpPanelState.setTerminal as ReturnType<typeof vi.fn>).mockClear();

    // Stop the assistant while the relaunch is still provisioning.
    await act(async () => {
      fireEvent.click(queryStopItem(container)!);
    });

    // The hung dispatch finally resolves with the reserved terminal.
    await act(async () => {
      resolveDispatch({ ok: true, result: { terminalId: reservedId } });
    });

    // The superseded launch bailed: it never bound the fresh session and cleaned
    // up the orphaned terminal instead.
    expect(helpPanelState.setTerminal).not.toHaveBeenCalledWith(reservedId, "claude", "sess-fresh");
    expect(panelStoreState.removePanel).toHaveBeenCalledWith(reservedId);
  });
});
