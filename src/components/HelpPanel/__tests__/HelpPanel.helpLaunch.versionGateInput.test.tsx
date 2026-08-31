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
    // #12108 selectors. The fixtures below stay FLAT (terminalId/agentId/…)
    // and these project that same object as the lane, so every existing
    // assertion keeps driving the controller unchanged.
    selectSlot: (s) => s,
    selectActiveSlot: (s) => s,
    selectOpenSlots: () => [0],
    selectSlotTerminalIds: (s) => (s.terminalId ? [s.terminalId] : []),
    selectSlotForTerminal: (s, id) => (s.terminalId === id && id ? 0 : null),
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

describe("HelpPanel — assistantMinVersion gate (issue #7539)", () => {
  it("blocks the single-supported-agent launch when installed version is below assistantMinVersion", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
    mockGetFolderPath.mockResolvedValue("/help");
    mockGetAgentVersion.mockResolvedValue({
      agentId: "claude",
      installedVersion: "0.2.74",
      latestVersion: "1.0.0",
      updateAvailable: true,
      lastChecked: Date.now(),
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "blocked-term" } });

    const { findByTestId } = render(<HelpPanel width={380} />);

    await findByTestId("help-version-too-old");

    expect(mockGetAgentVersion).toHaveBeenCalledWith("claude", false);
    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
  });

  it("blocks the preferredAgentId auto-launch when installed version is below assistantMinVersion", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockGetAgentVersion.mockResolvedValue({
      agentId: "claude",
      installedVersion: "0.9.0",
      latestVersion: "1.0.0",
      updateAvailable: true,
      lastChecked: Date.now(),
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    const { findByTestId } = render(<HelpPanel width={380} />);

    await findByTestId("help-version-too-old");

    expect(mockGetAgentVersion).toHaveBeenCalledWith("claude", false);
    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
  });

  it("renders the upgrade copy with required and installed versions", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockGetAgentVersion.mockResolvedValue({
      agentId: "claude",
      installedVersion: "0.2.74",
      latestVersion: "1.0.0",
      updateAvailable: true,
      lastChecked: Date.now(),
    });

    const { findByTestId } = render(<HelpPanel width={380} />);

    const block = await findByTestId("help-version-too-old");
    expect(block.textContent).toContain("Update Claude to use Daintree Assistant");
    expect(block.textContent).toContain("1.0.0");
    expect(block.textContent).toContain("0.2.74");
  });

  it("update CTA dispatches app.settings.openTab to the assistant tab", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockGetAgentVersion.mockResolvedValue({
      agentId: "claude",
      installedVersion: "0.2.74",
      latestVersion: "1.0.0",
      updateAvailable: true,
      lastChecked: Date.now(),
    });

    const { findByRole } = render(<HelpPanel width={380} />);

    const cta = await findByRole("button", { name: /update claude/i });
    fireEvent.click(cta);

    expect(mockDispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "assistant" },
      { source: "user" }
    );
  });

  it("'Check again' re-probes with refresh=true and clears the gate when the CLI is now current", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockGetAgentVersion.mockResolvedValue({
      agentId: "claude",
      installedVersion: "0.9.0",
      latestVersion: "1.0.0",
      updateAvailable: true,
      lastChecked: Date.now(),
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    const { findByTestId, findByRole, queryByTestId } = render(<HelpPanel width={380} />);
    await findByTestId("help-version-too-old");

    // User updates the CLI outside Daintree, then clicks "Check again".
    mockGetAgentVersion.mockResolvedValue({
      agentId: "claude",
      installedVersion: "1.2.0",
      latestVersion: "1.2.0",
      updateAvailable: false,
      lastChecked: Date.now(),
    });

    const checkAgain = await findByRole("button", { name: /check again/i });
    await act(async () => {
      fireEvent.click(checkAgain);
    });

    // The re-probe must bypass the 12h cache (refresh=true).
    expect(mockGetAgentVersion).toHaveBeenCalledWith("claude", true);
    // Passing probe clears the gate.
    expect(queryByTestId("help-version-too-old")).toBeNull();
  });

  it("'Check again' keeps the gate when the CLI is still too old", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockGetAgentVersion.mockResolvedValue({
      agentId: "claude",
      installedVersion: "0.9.0",
      latestVersion: "1.0.0",
      updateAvailable: true,
      lastChecked: Date.now(),
    });

    const { findByTestId, findByRole, getByTestId } = render(<HelpPanel width={380} />);
    await findByTestId("help-version-too-old");

    const checkAgain = await findByRole("button", { name: /check again/i });
    await act(async () => {
      fireEvent.click(checkAgain);
    });

    expect(mockGetAgentVersion).toHaveBeenCalledWith("claude", true);
    // Still blocked — the gate stays visible.
    expect(getByTestId("help-version-too-old")).toBeTruthy();
  });

  it("passes through when installed version equals assistantMinVersion", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockGetAgentVersion.mockResolvedValue({
      agentId: "claude",
      installedVersion: "1.0.0",
      latestVersion: "1.2.0",
      updateAvailable: true,
      lastChecked: Date.now(),
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockProvisionSession).toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });

  it("passes through when installedVersion is null (probe could not determine version)", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockGetAgentVersion.mockResolvedValue({
      agentId: "claude",
      installedVersion: null,
      latestVersion: null,
      updateAvailable: false,
      lastChecked: null,
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockProvisionSession).toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });

  it("passes through when the version probe IPC throws (transient failure does not block launch)", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockGetAgentVersion.mockRejectedValueOnce(new Error("ipc disconnected"));
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockProvisionSession).toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(
      "Failed to probe assistant CLI version",
      expect.any(Error)
    );
  });

  it("does not gate agents without an assistantMinVersion (e.g., codex)", async () => {
    mockGetAssistantSupportedAgentIds.mockReturnValue(["codex"]);
    helpPanelState.preferredAgentId = "codex";
    cliAvailabilityState.availability = { codex: "ready" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockGetAgentVersion.mockResolvedValue({
      agentId: "codex",
      installedVersion: "0.0.1",
      latestVersion: "1.0.0",
      updateAvailable: true,
      lastChecked: Date.now(),
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "codex-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    // Without an assistantMinVersion, the helper short-circuits to null and the IPC
    // probe should never be called — saves a probe per launch on un-gated agents.
    expect(mockGetAgentVersion).not.toHaveBeenCalled();
    expect(mockProvisionSession).toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "codex" }),
      { source: "user" }
    );
  });

  it("clears the version-too-old block when preferredAgentId changes", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockGetAgentVersion.mockResolvedValue({
      agentId: "claude",
      installedVersion: "0.2.74",
      latestVersion: "1.0.0",
      updateAvailable: true,
      lastChecked: Date.now(),
    });

    const { findByTestId, queryByTestId, rerender } = render(<HelpPanel width={380} />);
    await findByTestId("help-version-too-old");

    // User clears their preferred agent — the stale block should disappear so
    // the no-preference empty state can render correctly.
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    await act(async () => {
      rerender(<HelpPanel width={380} />);
    });

    expect(queryByTestId("help-version-too-old")).toBeNull();
  });

  it("does not paint a stale version-too-old block when preferredAgentId changes mid-probe", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");

    let resolveProbe: (info: unknown) => void = () => {};
    mockGetAgentVersion.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveProbe = r;
        })
    );
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    const { queryByTestId, rerender } = render(<HelpPanel width={380} />);

    // User switches preference while probe is in flight.
    helpPanelState.preferredAgentId = "codex";
    await act(async () => {
      rerender(<HelpPanel width={380} />);
    });

    // Probe finally returns "too old" for the now-stale claude.
    await act(async () => {
      resolveProbe({
        agentId: "claude",
        installedVersion: "0.2.74",
        latestVersion: "1.0.0",
        updateAvailable: true,
        lastChecked: Date.now(),
      });
    });

    // The stale block must NOT be rendered; the new preferred agent's launch
    // should proceed unobstructed.
    expect(queryByTestId("help-version-too-old")).toBeNull();
  });

  it("passes refresh=true on retry so an externally-updated CLI recovers without waiting for cache TTL", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");

    // First probe: blocked.
    mockGetAgentVersion.mockResolvedValueOnce({
      agentId: "claude",
      installedVersion: "0.2.74",
      latestVersion: "1.0.0",
      updateAvailable: true,
      lastChecked: Date.now(),
    });
    // Second probe (retry after user updated externally): passes.
    mockGetAgentVersion.mockResolvedValueOnce({
      agentId: "claude",
      installedVersion: "1.5.0",
      latestVersion: "1.5.0",
      updateAvailable: false,
      lastChecked: Date.now(),
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "recovered-term" } });

    const { findByTestId, rerender } = render(<HelpPanel width={380} />);
    await findByTestId("help-version-too-old");

    // First call uses cached path (refresh=false). Confirm call signature.
    expect(mockGetAgentVersion).toHaveBeenNthCalledWith(1, "claude", false);

    // Simulate a retry: close + reopen flips hasAutoLaunched, retriggering the effect.
    helpPanelState.isOpen = false;
    await act(async () => {
      rerender(<HelpPanel width={380} />);
    });
    helpPanelState.isOpen = true;
    await act(async () => {
      rerender(<HelpPanel width={380} />);
    });

    // Second probe must pass refresh=true to bust the 12h cache.
    expect(mockGetAgentVersion).toHaveBeenNthCalledWith(2, "claude", true);
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });
});

describe("HelpPanel — HybridInputBar wiring (issue #8185)", () => {
  function setupBoundTerminal(overrides: { isInputLocked?: boolean } = {}) {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/help",
        agentState: "idle",
        isInputLocked: overrides.isInputLocked ?? false,
      },
    };
  }

  it("renders HybridInputBar when an agent is bound and hybridInputEnabled is true", async () => {
    setupBoundTerminal();
    terminalInputState.hybridInputEnabled = true;

    let queryByTestId!: ReturnType<typeof render>["queryByTestId"];
    await act(async () => {
      ({ queryByTestId } = render(<HelpPanel width={380} />));
    });

    const bar = queryByTestId("hybrid-input-bar");
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("data-terminal-id")).toBe("term-1");
    expect(bar?.getAttribute("data-disabled")).toBe("false");
  });

  it("does not render HybridInputBar when hybridInputEnabled is false", async () => {
    setupBoundTerminal();
    terminalInputState.hybridInputEnabled = false;

    let queryByTestId!: ReturnType<typeof render>["queryByTestId"];
    await act(async () => {
      ({ queryByTestId } = render(<HelpPanel width={380} />));
    });

    expect(queryByTestId("hybrid-input-bar")).toBeNull();
  });

  it("does not render HybridInputBar when no agent is bound", async () => {
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    terminalInputState.hybridInputEnabled = true;

    let queryByTestId!: ReturnType<typeof render>["queryByTestId"];
    await act(async () => {
      ({ queryByTestId } = render(<HelpPanel width={380} />));
    });

    expect(queryByTestId("hybrid-input-bar")).toBeNull();
  });

  it("onSend calls notifyUserInput before terminalClient.submit", async () => {
    setupBoundTerminal();

    let getByTestId!: ReturnType<typeof render>["getByTestId"];
    await act(async () => {
      ({ getByTestId } = render(<HelpPanel width={380} />));
    });

    await act(async () => {
      fireEvent.click(getByTestId("hybrid-input-send"));
    });

    expect(mockNotifyUserInput).toHaveBeenCalledWith("term-1");
    expect(mockTerminalSubmit).toHaveBeenCalledWith("term-1", "hello");
    // Order matters (lesson #2187): notifyUserInput must precede submit.
    expect(mockNotifyUserInput.mock.invocationCallOrder?.[0] ?? 0).toBeLessThan(
      mockTerminalSubmit.mock.invocationCallOrder?.[0] ?? 0
    );
  });

  it("onSendKey calls notifyUserInput before terminalClient.sendKey", async () => {
    setupBoundTerminal();

    let getByTestId!: ReturnType<typeof render>["getByTestId"];
    await act(async () => {
      ({ getByTestId } = render(<HelpPanel width={380} />));
    });

    await act(async () => {
      fireEvent.click(getByTestId("hybrid-input-key"));
    });

    expect(mockNotifyUserInput).toHaveBeenCalledWith("term-1");
    expect(mockTerminalSendKey).toHaveBeenCalledWith("term-1", "escape");
    expect(mockNotifyUserInput.mock.invocationCallOrder?.[0] ?? 0).toBeLessThan(
      mockTerminalSendKey.mock.invocationCallOrder?.[0] ?? 0
    );
  });

  it("onSend and onSendKey are no-ops when isInputLocked is true", async () => {
    setupBoundTerminal({ isInputLocked: true });

    let getByTestId!: ReturnType<typeof render>["getByTestId"];
    await act(async () => {
      ({ getByTestId } = render(<HelpPanel width={380} />));
    });

    await act(async () => {
      fireEvent.click(getByTestId("hybrid-input-send"));
      fireEvent.click(getByTestId("hybrid-input-key"));
    });

    expect(mockNotifyUserInput).not.toHaveBeenCalled();
    expect(mockTerminalSubmit).not.toHaveBeenCalled();
    expect(mockTerminalSendKey).not.toHaveBeenCalled();
  });

  it("renders HybridInputBar as disabled when isInputLocked is true", async () => {
    setupBoundTerminal({ isInputLocked: true });

    let queryByTestId!: ReturnType<typeof render>["queryByTestId"];
    await act(async () => {
      ({ queryByTestId } = render(<HelpPanel width={380} />));
    });

    expect(queryByTestId("hybrid-input-bar")?.getAttribute("data-disabled")).toBe("true");
  });

  it("Escape with focus inside .cm-editor does not close the panel (autocomplete swallow)", () => {
    setupBoundTerminal();

    const { container } = render(<HelpPanel width={380} />);

    // Simulate CodeMirror focus inside the assistant panel — `closest(".cm-editor")`
    // matches and `panelRef.current?.contains(active)` is true.
    const panel = container.querySelector("#daintree-assistant-panel");
    expect(panel).not.toBeNull();
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const textarea = document.createElement("textarea");
    editor.appendChild(textarea);
    panel!.appendChild(editor);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    const escapeMock = vi.mocked(useEscapeStack);
    const callback = escapeMock.mock.calls.at(-1)?.[1];
    expect(callback).toBeTypeOf("function");

    act(() => {
      callback?.();
    });

    expect(helpPanelState.setOpen).not.toHaveBeenCalledWith(false);
  });

  it("Escape with focus inside a .cm-editor OUTSIDE the panel still closes it", () => {
    setupBoundTerminal();

    render(<HelpPanel width={380} />);

    // Simulate a CodeMirror editor in a different panel (e.g. FileViewer) by
    // attaching it to document.body — outside the assistant panel root.
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const textarea = document.createElement("textarea");
    editor.appendChild(textarea);
    document.body.appendChild(editor);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    const escapeMock = vi.mocked(useEscapeStack);
    const callback = escapeMock.mock.calls.at(-1)?.[1];
    expect(callback).toBeTypeOf("function");

    act(() => {
      callback?.();
    });

    // External CodeMirror must not trap the assistant's Escape handler.
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);

    document.body.removeChild(editor);
  });
});

describe("HelpPanel — launch loading state (issue #8771)", () => {
  it("renders the phase-labeled launch skeleton once the Doherty gate elapses", async () => {
    vi.useFakeTimers();
    try {
      helpPanelState.preferredAgentId = "claude";
      mockGetFolderPath.mockResolvedValue("/help");
      // Hold dispatch so the launch parks at the "launching" phase.
      let resolveDispatch: (value: unknown) => void = () => {};
      mockDispatch.mockReturnValue(
        new Promise((r) => {
          resolveDispatch = r;
        })
      );

      await act(async () => {
        render(<HelpPanel width={380} />);
      });

      // Drain the in-flight launch microtasks and open the 400ms gate.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(450);
      });

      // The label renders twice — once sr-only (Skeleton aria) and once visible.
      expect(screen.getAllByText("Starting assistant…").length).toBeGreaterThan(0);
      // The static empty-state value prop must not show while launching.
      expect(screen.queryByText(/Use Daintree Assistant to configure/i)).toBeNull();

      await act(async () => {
        resolveDispatch({ ok: true, result: { terminalId: "term-1" } });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not render the launch skeleton on the idle multi-agent empty state", () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    render(<HelpPanel width={380} />);

    expect(screen.queryByText("Starting assistant…")).toBeNull();
    expect(screen.queryByText("Provisioning session…")).toBeNull();
    expect(screen.getByText(/Use Daintree Assistant to configure/i)).toBeTruthy();
  });
});
