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
  scratchStoreState,
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
    clearDroppedPreferredAgent: vi.fn(),
    requestFocus: vi.fn(),
    setActiveFigureNumber: vi.fn(),
    setActiveSlot: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    // #12108: the panel reads its lane pointer; the mocked selectors
    // above project this same flat object as that lane.
    activeSlot: 0,
    sessions: {} as Record<number, unknown>,
    isOpen: true,
    width: 380,
    terminalId: null as string | null,
    agentId: null as string | null,
    // "claude" rather than null: these suites exercise the PTY LAUNCH path, and the
    // Daintree Assistant is now the default surface when no agent is chosen — a null
    // preference renders the native panel and never launches a terminal at all. Naming
    // a terminal-backed agent keeps each test about the thing it is testing.
    preferredAgentId: "claude" as string | null,
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
  scratchStoreState: {
    currentScratch: null as { id: string; path: string } | null,
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
    // #12108 selectors. The fixtures below stay FLAT (terminalId/agentId/…)
    // and these project that same object as the lane, so every existing
    // assertion keeps driving the controller unchanged.
    selectSlot: (s: typeof helpPanelState) => s,
    selectActiveSlot: (s: typeof helpPanelState) => s,
    selectOpenSlots: () => [0],
    selectSlotTerminalIds: (s: typeof helpPanelState) => (s.terminalId ? [s.terminalId] : []),
    selectSlotForTerminal: (s: typeof helpPanelState, id: string) =>
      s.terminalId === id && id ? 0 : null,
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

// Leaf-path mock, mirroring the component's import (#11068) — kept out of the
// `@/store` barrel above so barrel-mocking suites don't have to list it.
vi.mock("@/store/scratchStore", () => {
  const store = (selector?: (state: typeof scratchStoreState) => unknown) =>
    selector ? selector(scratchStoreState) : scratchStoreState;
  store.getState = () => scratchStoreState;
  return { useScratchStore: store };
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
import { __resetHelpSessionControllersForTests } from "@/controllers/helpSessionControllerRegistry";

// The real `app:view-revealed` bridge fans out to every registered listener;
// HelpPanel registers the switch-back recovery effect against it (#10739).
let viewRevealedCbs: Array<() => void> = [];

function resetState() {
  viewRevealedCbs = [];
  helpPanelState.isOpen = true;
  helpPanelState.width = 380;
  helpPanelState.terminalId = null;
  helpPanelState.agentId = null;
  // See the note on the initial state: null now means the NATIVE panel, so the
  // PTY-launch suites reset to a terminal-backed agent.
  helpPanelState.preferredAgentId = "claude";
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
  scratchStoreState.currentScratch = null;
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
  // #12108: controllers live in a per-view registry, not component
  // state, so they outlive a render and must be reset between tests.
  __resetHelpSessionControllersForTests();
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
        // The native assistant panel mounts whenever no terminal-backed agent is
        // chosen, so the HelpPanel harness has to model its IPC namespace. Without
        // it the panel throws on subscribe and every test in the file fails for a
        // reason that has nothing to do with what it asserts.
        assistantHost: {
          start: vi.fn().mockResolvedValue({ sessionId: "assistant-test-session" }),
          send: vi.fn().mockResolvedValue({ delivered: true }),
          stop: vi.fn().mockResolvedValue({ stopped: true }),
          onEvent: vi.fn(() => () => {}),
          onPeerPrompt: () => () => {},
          onSequenceGap: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
        },
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

describe("HelpPanel — preferred-agent launch (handleSelectAgent)", () => {
  it("does not auto-launch when document.hidden is true (issue #7201 guard)", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches agent.launch without a prompt field (regression: auto-greeting removed)", async () => {
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.not.objectContaining({ prompt: expect.anything() }),
      { source: "user" }
    );
  });

  it("shows the launch-error banner (not a toast) and skips commit when result.ok is false", async () => {
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: false });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    // Panel is open, so the failure surfaces inline rather than as a toast.
    expect(screen.getByTestId("help-launch-error-banner")).toBeTruthy();
    expect(screen.getByText("Assistant couldn't start")).toBeTruthy();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("shows the launch-error banner when result.ok is true but terminalId is null", async () => {
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: null } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(screen.getByTestId("help-launch-error-banner")).toBeTruthy();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("shows the launch-error banner and aborts when help folder is null", async () => {
    mockGetFolderPath.mockResolvedValue(null);

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(screen.getByTestId("help-launch-error-banner")).toBeTruthy();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("shows the services-unavailable banner with a settings shortcut when provisioning reports the server isn't started", async () => {
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj" };
    mockGetFolderPath.mockResolvedValue("/help");
    const err = new Error("port collision") as Error & { code: string };
    err.code = "MCP_SERVER_NOT_STARTED";
    mockProvisionSession.mockRejectedValueOnce(err);

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(screen.getByTestId("help-launch-error-banner")).toBeTruthy();
    expect(screen.getByText("Open settings")).toBeTruthy();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("shows the launch-error banner when provisionSession rejects without a typed code", async () => {
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockRejectedValueOnce(new Error("ipc disconnected"));

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(screen.getByTestId("help-launch-error-banner")).toBeTruthy();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe("HelpPanel — auto-launch (preferredAgentId)", () => {
  it("waits for app hydration before launching a persisted-open assistant", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    const { rerender } = render(<HelpPanel width={380} isReadyToLaunch={false} />);

    expect(mockGetFolderPath).not.toHaveBeenCalled();
    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();

    await act(async () => {
      rerender(<HelpPanel width={380} isReadyToLaunch />);
    });

    expect(mockProvisionSession).toHaveBeenCalledWith({
      projectId: "proj-default",
      projectPath: "/repo",
      agentId: "claude",
      context: {},
      slot: 0,
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude", cwd: "/help" }),
      { source: "user" }
    );
  });

  it("waits for a current project before provisioning and launching", async () => {
    projectStoreState.currentProject = null;
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    const { rerender } = render(<HelpPanel width={380} />);

    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();

    projectStoreState.currentProject = { id: "proj-late", path: "/late-repo" };
    await act(async () => {
      rerender(<HelpPanel width={380} />);
    });

    expect(mockProvisionSession).toHaveBeenCalledWith({
      projectId: "proj-late",
      projectPath: "/late-repo",
      agentId: "claude",
      context: {},
      slot: 0,
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });

  // #11068: the headline regression. A scratch is a valid workspace (same
  // ProjectViewManager, same PTY host), but switching to one clears
  // `currentProject`, so the assistant used to bail with "Project state is still
  // loading" and never launch.
  it("launches into an active scratch workspace when no project is active", async () => {
    projectStoreState.currentProject = null;
    scratchStoreState.currentScratch = { id: "scratch-1", path: "/scratches/scratch-1" };
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockProvisionSession).toHaveBeenCalledWith({
      projectId: "scratch-1",
      projectPath: "/scratches/scratch-1",
      agentId: "claude",
      context: {},
      slot: 0,
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
    // The bug's signature: a "still loading" toast instead of a launch.
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does not launch the terminal when session provisioning returns null", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValueOnce(null);

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(screen.getByTestId("help-launch-error-banner")).toBeTruthy();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does not auto-launch when document.hidden is true (issue #7201 guard)", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches auto-launch agent.launch without a prompt field", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.not.objectContaining({ prompt: expect.anything() }),
      { source: "user" }
    );
  });

  it("does not commit terminal and cleans up if user navigated away (preferredAgentId cleared) during in-flight launch", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    // Two supported agents so clearing the preference doesn't trip the
    // single-supported-agent auto-launch fallback — this test isolates the
    // in-flight launch's cleanup, not the fallback path.
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    let resolveDispatch: (v: unknown) => void = () => {};
    mockDispatch.mockReturnValue(
      new Promise((r) => {
        resolveDispatch = r;
      })
    );

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    // Simulate user clicking Back during the in-flight launch:
    helpPanelState.preferredAgentId = null;

    await act(async () => {
      resolveDispatch({ ok: true, result: { terminalId: "stale-term" } });
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("stale-term");
  });

  it("shows the launch-error banner and does not commit terminal on launch failure", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: false });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(screen.getByTestId("help-launch-error-banner")).toBeTruthy();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("provisions and dispatches a Codex assistant launch when codex is the preferred agent", async () => {
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);
    helpPanelState.preferredAgentId = "codex";
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-codex",
      sessionPath: "/help-codex",
      token: "tok-codex",
      tier: "action",
      mcpUrl: "http://127.0.0.1:45454/mcp",
      windowId: 1,
    });
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "codex-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockProvisionSession).toHaveBeenCalledWith({
      projectId: "proj-default",
      projectPath: "/repo",
      agentId: "codex",
      context: {},
      slot: 0,
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentId: "codex",
        cwd: "/help-codex",
        env: expect.objectContaining({
          DAINTREE_MCP_TOKEN: "tok-codex",
          DAINTREE_MCP_URL: "http://127.0.0.1:45454/mcp",
        }),
      }),
      { source: "user" }
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      0,
      "codex-term-1",
      "codex",
      "sess-codex"
    );
  });
});

describe("HelpPanel — intro banner visibility", () => {
  it("renders the banner when the terminal is healthy and introDismissed=false", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.introDismissed = false;
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { container } = render(<HelpPanel width={380} />);

    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeTruthy();
  });

  it("hides the banner when introDismissed=true", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.introDismissed = true;
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { container } = render(<HelpPanel width={380} />);

    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
  });

  it("does not render the banner on the idle empty state (no terminal)", () => {
    helpPanelState.terminalId = null;
    helpPanelState.introDismissed = false;

    const { container } = render(<HelpPanel width={380} />);

    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
  });

  it("hides the banner when any panel has launchAgentId (hasEverLaunchedAgent gate)", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.introDismissed = false;
    panelStoreState.panelIds = ["term-1", "other-1"];
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
      "other-1": { id: "other-1", kind: "terminal", launchAgentId: "claude" },
    };

    const { container } = render(<HelpPanel width={380} />);

    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
  });

  it("hides the banner when any panel has everDetectedAgent (persisted across restarts)", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.introDismissed = false;
    panelStoreState.panelIds = ["term-1", "other-1"];
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
      "other-1": { id: "other-1", kind: "terminal", everDetectedAgent: true },
    };

    const { container } = render(<HelpPanel width={380} />);

    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
  });

  it("renders the banner above the XtermAdapter (DOM order protects flex layout)", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.introDismissed = false;
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { container, getByTestId } = render(<HelpPanel width={380} />);

    const dismissBtn = container.querySelector('button[aria-label="Dismiss"]')!;
    const xterm = getByTestId("xterm-adapter");
    const order = dismissBtn.compareDocumentPosition(xterm);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("dismisses the banner when the X button is clicked", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.introDismissed = false;
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { container } = render(<HelpPanel width={380} />);
    const dismissBtn = container.querySelector('button[aria-label="Dismiss"]');
    expect(dismissBtn).toBeTruthy();
    fireEvent.click(dismissBtn!);

    expect(helpPanelState.dismissIntro).toHaveBeenCalled();
  });
});

describe("HelpPanel — render gates", () => {
  it("renders MissingCliGate when terminal has spawnStatus 'missing-cli'", () => {
    helpPanelState.terminalId = "gate-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "gate-1": {
        id: "gate-1",
        kind: "terminal",
        spawnStatus: "missing-cli",
        cwd: "/help",
      },
    };
    cliAvailabilityState.details = {
      claude: { state: "missing", resolvedPath: null, via: null },
    };

    const { getByTestId, queryByTestId } = render(<HelpPanel width={380} />);

    expect(getByTestId("missing-cli-gate")).toBeTruthy();
    expect(queryByTestId("xterm-adapter")).toBeNull();
  });

  it("renders XtermAdapter when terminal is healthy", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { getByTestId, queryByTestId } = render(<HelpPanel width={380} />);

    expect(getByTestId("xterm-adapter")).toBeTruthy();
    expect(queryByTestId("missing-cli-gate")).toBeNull();
  });
});
