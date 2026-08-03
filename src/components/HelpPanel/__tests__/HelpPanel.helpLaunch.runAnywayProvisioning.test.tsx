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

describe("HelpPanel — handleRunAnyway", () => {
  it("commits the re-spawned terminal to helpPanelStore (regression: no orphan)", async () => {
    helpPanelState.terminalId = "gate-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "gate-1": {
        id: "gate-1",
        kind: "terminal",
        spawnStatus: "missing-cli",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
      },
    };
    cliAvailabilityState.details = {
      claude: { state: "missing", resolvedPath: null, via: null },
    };
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "terminal-restarted" } });

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    expect(panelStoreState.removePanel).toHaveBeenCalledWith("gate-1");
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentId: "claude",
        cwd: "/help",
        requestedId: expect.stringMatching(/^terminal-/),
        activateDockOnCreate: true,
        excludeFromPersistence: true,
        removeOnExit: true,
        force: true,
      }),
      { source: "user" }
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      "terminal-restarted",
      "claude",
      "sess-default"
    );
    expect(mockMarkTerminal).toHaveBeenCalledWith("terminal-restarted");
  });

  it("notifies and reverts the reserved help-terminal id on addPanel rejection", async () => {
    helpPanelState.terminalId = "gate-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "gate-1": {
        id: "gate-1",
        kind: "terminal",
        spawnStatus: "missing-cli",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
      },
    };
    cliAvailabilityState.details = {
      claude: { state: "missing", resolvedPath: null, via: null },
    };
    mockDispatch.mockResolvedValue({ ok: false });

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    // The pre-set fired once (reserving the slot), then clearTerminal reverted it
    // when dispatch returned !ok — so no second setTerminal call carrying a session id.
    expect(helpPanelState.setTerminal).toHaveBeenCalledTimes(1);
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      expect.stringMatching(/^terminal-/),
      "claude",
      null
    );
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(screen.getByTestId("help-launch-error-banner")).toBeTruthy();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("reserves the new help-terminal id BEFORE dispatch resolves (race fix for #6951)", async () => {
    helpPanelState.terminalId = "gate-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "gate-1": {
        id: "gate-1",
        kind: "terminal",
        spawnStatus: "missing-cli",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
      },
    };
    cliAvailabilityState.details = {
      claude: { state: "missing", resolvedPath: null, via: null },
    };

    // Hold dispatch resolution until after we've inspected store state.
    let resolveDispatch: (value: unknown) => void = () => {};
    mockDispatch.mockImplementation(() => {
      return new Promise((r) => {
        resolveDispatch = r;
      });
    });

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    // Capture the requestedId from the dispatch call.
    const capturedRequestedId = (
      mockDispatch.mock.calls[0]?.[1] as { requestedId?: string } | undefined
    )?.requestedId;

    // setTerminal fired with the pre-generated id while dispatch is still pending.
    expect(capturedRequestedId).toMatch(/^terminal-/);
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(capturedRequestedId, "claude", null);

    await act(async () => {
      resolveDispatch({ ok: true, result: { terminalId: capturedRequestedId! } });
    });
  });

  it("reverts the reserved id when provisionHelpSession returns a non-ok outcome", async () => {
    helpPanelState.terminalId = "gate-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "gate-1": {
        id: "gate-1",
        kind: "terminal",
        spawnStatus: "missing-cli",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
      },
    };
    cliAvailabilityState.details = {
      claude: { state: "missing", resolvedPath: null, via: null },
    };
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    const mcpErr = new Error("MCP server not ready") as Error & { code: string };
    mcpErr.code = "MCP_NOT_READY";
    mockProvisionSession.mockRejectedValueOnce(mcpErr);

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    // Pre-set fired, then was reverted by the !outcome.ok branch.
    expect(helpPanelState.setTerminal).toHaveBeenCalledTimes(1);
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
  });

  it("revokes the freshly-provisioned session when addPanel throws (regression: leaked token)", async () => {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    helpPanelState.terminalId = "gate-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "gate-1": {
        id: "gate-1",
        kind: "terminal",
        spawnStatus: "missing-cli",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
      },
    };
    cliAvailabilityState.details = {
      claude: { state: "missing", resolvedPath: null, via: null },
    };
    mockProvisionSession.mockResolvedValue({
      sessionId: "leaked-sess",
      sessionPath: "/sessions/leaked-sess",
      token: "tok-leak",
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });
    mockDispatch.mockResolvedValue({ ok: false });

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    expect(mockRevokeSession).toHaveBeenCalledWith("leaked-sess");
  });

  it("forwards fresh customArgs from settings to agent.launch dispatch", async () => {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    helpPanelState.terminalId = "gate-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "gate-1": {
        id: "gate-1",
        kind: "terminal",
        spawnStatus: "missing-cli",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
      },
    };
    cliAvailabilityState.details = {
      claude: { state: "missing", resolvedPath: null, via: null },
    };
    mockGetHelpAssistantSettings.mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      tier: "action" as const,
      bypassPermissions: false,
      auditRetention: 7,
      customArgs: "--model sonnet",
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "restarted-term" } });

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentLaunchFlags: ["--model", "sonnet"],
        force: true,
      }),
      { source: "user" }
    );
  });
});

describe("HelpPanel — session provisioning", () => {
  it("threads sessionPath as cwd and full DAINTREE_* env into agent.launch", async () => {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-1",
      sessionPath: "/sessions/sess-1",
      token: "tok-abc",
      tier: "action",
      mcpUrl: "http://127.0.0.1:45454/sse",
      windowId: 7,
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockProvisionSession).toHaveBeenCalledWith({
      projectId: "proj-1",
      projectPath: "/repo",
      agentId: "claude",
      context: {},
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        cwd: "/sessions/sess-1",
        env: {
          DAINTREE_MCP_TOKEN: "tok-abc",
          DAINTREE_MCP_URL: "http://127.0.0.1:45454/sse",
          DAINTREE_WINDOW_ID: "7",
          DAINTREE_PROJECT_ID: "proj-1",
        },
      }),
      { source: "user" }
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("term-1", "claude", "sess-1");
  });

  it("omits DAINTREE_MCP_URL when mcpUrl is null (daintreeControl=false)", async () => {
    projectStoreState.currentProject = { id: "proj-2", path: "/repo2" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-2",
      sessionPath: "/sessions/sess-2",
      token: "tok-xyz",
      tier: "action",
      mcpUrl: null,
      windowId: 3,
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-2" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        env: {
          DAINTREE_MCP_TOKEN: "tok-xyz",
          DAINTREE_WINDOW_ID: "3",
          DAINTREE_PROJECT_ID: "proj-2",
        },
      }),
      { source: "user" }
    );
  });

  it("revokes the bound session when the panel disappears from panelsById", async () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = "sess-bound";
    panelStoreState.panelsById = {};

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockRevokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
  });
});

describe("HelpPanel — hasAutoLaunched stale reset (regression)", () => {
  it("resets hasAutoLaunched after stale-agent abort so next preferred agent can auto-launch", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");

    let resolveFirst: (v: unknown) => void = () => {};
    let resolveSecond: (v: unknown) => void = () => {};
    mockDispatch
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        })
      )
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveSecond = r;
        })
      );

    const { rerender } = render(<HelpPanel width={380} />);

    // User switches preferred agent while first launch is in flight (stale path)
    helpPanelState.preferredAgentId = "gemini";

    await act(async () => {
      resolveFirst({ ok: true, result: { terminalId: "stale-claude" } });
    });

    // Stale guard cleaned up the orphaned terminal and reset hasAutoLaunched.
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("stale-claude");
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();

    // Trigger the effect again with the new preferredAgentId.
    await act(async () => {
      rerender(<HelpPanel width={380} />);
    });

    // The follow-up auto-launch must fire — this is the regression bug.
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(mockDispatch).toHaveBeenLastCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "gemini" }),
      { source: "user" }
    );

    await act(async () => {
      resolveSecond({ ok: true, result: { terminalId: "term-gemini" } });
    });

    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      "term-gemini",
      "gemini",
      "sess-default"
    );
  });
});

describe("HelpPanel — single-supported-agent auto-skip (issue #6612)", () => {
  it("auto-launches the only supported agent without requiring user selection", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-skip-term" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      "auto-skip-term",
      "claude",
      "sess-default"
    );
  });

  it("does not auto-skip when more than one supported agent is installed", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "should-not-fire" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
  });

  it("does not auto-skip when no supported agent is installed", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "missing", gemini: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "should-not-fire" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
  });

  it("does not auto-skip while CLI availability data is still loading", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.hasRealData = false;
    cliAvailabilityState.availability = { claude: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "should-not-fire" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
  });

  it("never renders a Back button (picker removed)", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { container } = render(<HelpPanel width={380} />);

    expect(container.querySelector('button[aria-label="Back to agent picker"]')).toBeNull();
  });
});
