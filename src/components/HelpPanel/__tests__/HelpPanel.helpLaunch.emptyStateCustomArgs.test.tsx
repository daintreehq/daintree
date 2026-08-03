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
import { useEscapeStack } from "@/hooks/useEscapeStack";

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

describe("HelpPanel — empty state hero (Daintree-relevant entry points)", () => {
  it("renders the value-prop sentence and the two navigation links when no preferred agent and multiple supported agents installed", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { findByRole, getByText } = render(<HelpPanel width={380} />);

    expect(getByText(/Use Daintree Assistant to configure and navigate Daintree/i)).toBeTruthy();
    expect(await findByRole("button", { name: "Assistant settings" })).toBeTruthy();
    expect(await findByRole("button", { name: "Daintree Assistant guide" })).toBeTruthy();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("'Start assistant' CTA records consent and launches, with no auto-launch beforehand (#10699)", async () => {
    // Consent off: opening the panel must show the CTA and start nothing.
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.preferredAgentId = "claude";
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "cta-term" } });

    render(<HelpPanel width={380} />);

    expect(mockProvisionSession).not.toHaveBeenCalled();

    const cta = await screen.findByTestId("help-start-assistant");
    await act(async () => {
      fireEvent.click(cta);
    });

    expect(helpPanelState.setAutoLaunchEnabled).toHaveBeenCalledWith(true);
    expect(mockProvisionSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "claude" })
    );
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });

  it("first-run starter-prompt chip records consent and launches (#10699)", async () => {
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.preferredAgentId = "claude";
    // No prior agent launches → the first-run starter chips render.
    panelStoreState.panelIds = [];
    panelStoreState.panelsById = {};
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "chip-term" } });

    render(<HelpPanel width={380} />);

    const chip = await screen.findByRole("button", {
      name: /How do I set up a new worktree\?/i,
    });
    await act(async () => {
      fireEvent.click(chip);
    });

    expect(helpPanelState.setAutoLaunchEnabled).toHaveBeenCalledWith(true);
    expect(mockProvisionSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "claude" })
    );
  });

  it("renders the configure-in-settings fallback and no Start CTA when no single launchable agent (#10699)", () => {
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    render(<HelpPanel width={380} />);

    expect(
      screen.getByText(/Configure an assistant agent in settings to get started/i)
    ).toBeTruthy();
    expect(screen.queryByTestId("help-start-assistant")).toBeNull();
  });

  it("dispatches app.settings.openTab with tab='assistant' when the empty-state settings link is clicked", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { findByRole } = render(<HelpPanel width={380} />);

    const button = await findByRole("button", { name: "Assistant settings" });
    fireEvent.click(button);

    expect(mockDispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "assistant" },
      { source: "user" }
    );
  });

  it("dispatches system.openExternal with the assistant docs URL when the empty-state guide link is clicked", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { findByRole } = render(<HelpPanel width={380} />);

    const button = await findByRole("button", { name: "Daintree Assistant guide" });
    fireEvent.click(button);

    expect(mockDispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://daintree.org/assistant" },
      { source: "user" }
    );
  });

  it("dispatches navigation actions (not agent.launch) when the empty-state links are clicked", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "missing", codex: "missing" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { findByRole } = render(<HelpPanel width={380} />);

    const settings = await findByRole("button", { name: "Assistant settings" });
    const docs = await findByRole("button", { name: "Daintree Assistant guide" });

    fireEvent.click(settings);
    fireEvent.click(docs);

    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "assistant" },
      { source: "user" }
    );
    expect(mockDispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://daintree.org/assistant" },
      { source: "user" }
    );
    expect(mockDispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
  });

  // Docs moved from a dedicated title-bar icon into the header overflow menu
  // (3-icon header budget); the pass-through dropdown mock renders the item as
  // a plain button labeled "Open docs".
  function queryDocsItem(container: HTMLElement): HTMLButtonElement | null {
    return (
      [
        ...container.querySelectorAll<HTMLButtonElement>("[data-testid='overflow-menu'] button"),
      ].find((b) => b.textContent?.includes("Open docs")) ?? null
    );
  }

  it("dispatches system.openExternal with the assistant docs URL from the overflow docs item", () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { container } = render(<HelpPanel width={380} />);

    fireEvent.click(queryDocsItem(container)!);

    expect(mockDispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://daintree.org/assistant" },
      { source: "user" }
    );
  });

  it("keeps the overflow docs item available while a terminal session is active", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { container } = render(<HelpPanel width={380} />);

    expect(queryDocsItem(container)).not.toBeNull();
  });

  it("does not render a duplicate 'Assistant settings' footer link (empty state)", () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { queryAllByRole } = render(<HelpPanel width={380} />);

    const matches = queryAllByRole("button", { name: "Assistant settings" });
    expect(matches.length).toBe(1);
  });

  it("does not render any 'Assistant settings' button when a terminal session is active", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { queryAllByRole } = render(<HelpPanel width={380} />);

    const matches = queryAllByRole("button", { name: "Assistant settings" });
    expect(matches.length).toBe(0);
  });
});

describe("HelpPanel — customArgs threading", () => {
  it("passes customArgs as agentLaunchFlags in the agent.launch dispatch payload", async () => {
    mockGetHelpAssistantSettings.mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      tier: "action" as const,
      bypassPermissions: false,
      auditRetention: 7,
      customArgs: "--model sonnet --verbose",
    });
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentLaunchFlags: ["--model", "sonnet", "--verbose"],
      }),
      { source: "user" }
    );
  });

  it("does not include agentLaunchFlags when customArgs is empty", async () => {
    mockGetHelpAssistantSettings.mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      tier: "action" as const,
      bypassPermissions: false,
      auditRetention: 7,
      customArgs: "",
    });
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.not.objectContaining({ agentLaunchFlags: expect.anything() }),
      { source: "user" }
    );
  });

  it("treats whitespace-only customArgs as no flags (no agentLaunchFlags field)", async () => {
    mockGetHelpAssistantSettings.mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      tier: "action" as const,
      bypassPermissions: false,
      auditRetention: 7,
      customArgs: "   \t  ",
    });
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.not.objectContaining({ agentLaunchFlags: expect.anything() }),
      { source: "user" }
    );
  });

  it("threads customArgs into the preferredAgentId auto-launch path too", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetHelpAssistantSettings.mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      tier: "action" as const,
      bypassPermissions: false,
      auditRetention: 7,
      customArgs: "--model sonnet",
    });
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentId: "claude",
        agentLaunchFlags: ["--model", "sonnet"],
      }),
      { source: "user" }
    );
  });

  it("falls back to no flags when getSettings rejects", async () => {
    mockGetHelpAssistantSettings.mockRejectedValueOnce(new Error("ipc down"));
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.not.objectContaining({ agentLaunchFlags: expect.anything() }),
      { source: "user" }
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("term-1", "claude", "sess-default");
  });
});

describe("HelpPanel — close hides without tearing down the agent", () => {
  it.each([
    ["idle", false],
    ["working", false],
    ["waiting", true],
    ["directing", true],
    ["completed", true],
    ["exited", true],
  ] as const)(
    "hides the panel without removing the terminal or revoking the session (%s, touched=%s)",
    (state, conversationTouched) => {
      helpPanelState.terminalId = "term-1";
      helpPanelState.agentId = "claude";
      helpPanelState.sessionId = "sess-bound";
      helpPanelState.conversationTouched = conversationTouched;
      panelStoreState.panelsById = {
        "term-1": {
          id: "term-1",
          kind: "terminal",
          spawnStatus: "ready",
          cwd: "/help",
          agentState: state,
        },
      };

      const { container, queryByTestId } = render(<HelpPanel width={380} />);
      fireEvent.click(container.querySelector('button[aria-label="Hide Daintree Assistant"]')!);

      expect(queryByTestId("confirm-dialog")).toBeNull();
      expect(panelStoreState.removePanel).not.toHaveBeenCalled();
      expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
      expect(mockRevokeSession).not.toHaveBeenCalled();
      expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
    }
  );

  it("Escape hides the panel via the same non-destructive path", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/help",
        agentState: "working",
      },
    };

    render(<HelpPanel width={380} />);

    const escapeMock = vi.mocked(useEscapeStack);
    const callback = escapeMock.mock.calls.at(-1)?.[1];
    expect(callback).toBeTypeOf("function");

    act(() => {
      callback?.();
    });

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
  });

  it("marks conversation started when agent state leaves idle on mount", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/help",
        agentState: "working",
      },
    };

    render(<HelpPanel width={380} />);

    expect(helpPanelState.markConversationStarted).toHaveBeenCalled();
  });

  it("does not mark conversation started when agent state is idle on mount", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/help",
        agentState: "idle",
      },
    };

    render(<HelpPanel width={380} />);

    expect(helpPanelState.markConversationStarted).not.toHaveBeenCalled();
  });

  it("does not mark conversation started after clearTerminal (stale guard)", () => {
    // Simulate: terminal was set but clearTerminal was called before render.
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    panelStoreState.panelsById = {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/help",
        agentState: "working",
      },
    };

    render(<HelpPanel width={380} />);

    expect(helpPanelState.markConversationStarted).not.toHaveBeenCalled();
  });
});
