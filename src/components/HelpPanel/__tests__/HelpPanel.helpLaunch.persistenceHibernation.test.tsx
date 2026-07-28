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
  const state = { focusedRegion: null as string | null, setRegionRef: vi.fn(), setVisibility: vi.fn() };
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
function fireViewRevealed(): void {
  act(() => {
    for (const cb of viewRevealedCbs) cb();
  });
}

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

// The footer pinned-context indicator is a quiet, neutral ambient signal — it
// never paints the row red or parks a destructive "Start new session" button
// just because no live grid terminal remains (#10792). Closing every grid
// terminal is a normal action: tool calls re-resolve their target at dispatch
// time and the dock-hosted chat keeps working, so it's not a failure. Recovery
// lives on the header's "Start new session" button. These tests defend against
// reintroducing the old false-alarm danger state (the prior #10431 behavior).
describe("HelpPanel — pinned-terminal state stays a quiet neutral indicator (#10792)", () => {
  const DANGER_BUTTON_TITLE = "No open terminal to receive tool calls — start a new session";
  const PINNED_LABEL = "main · main";

  function dockAssistantTerminal() {
    // The assistant runs in the dock; it is never a tool-call target, so it must
    // not count toward "a live terminal exists to reach".
    return {
      id: "assistant-term",
      kind: "terminal",
      spawnStatus: "ready",
      cwd: "/help",
      command: "claude",
      location: "dock",
      agentState: "idle",
    };
  }

  // The neutral pinned `<span>` (not the diverged-warning button) is what these
  // tests assert renders. It only appears when the focused worktree matches the
  // session's pinned worktree — otherwise the divergence branch takes over — so
  // setupPinnedSession aligns `focusedWorktreeId` with the pinned `worktreeId`.
  const NEUTRAL_PINNED_TITLE = "Assistant tool calls are pinned to this worktree and terminal.";

  function setupPinnedSession(panels: Record<string, unknown>) {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    helpPanelState.terminalId = "assistant-term";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = "sess-pinned";
    panelStoreState.panelIds = Object.keys(panels);
    panelStoreState.panelsById = panels;
    worktreeSelectionState.focusedWorktreeId = "wt-1";
    window.electron.help.getPinnedActionContext = vi.fn().mockResolvedValue({
      terminalId: "pinned-grid-term",
      worktreeId: "wt-1",
      worktreeName: "main",
      worktreeBranch: "main",
    });
  }

  async function renderResolved() {
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(<HelpPanel width={380} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    return result;
  }

  it("does not flag danger when the pinned terminal is gone but another live grid terminal exists", async () => {
    setupPinnedSession({
      "assistant-term": dockAssistantTerminal(),
      // A different, live grid terminal — the pinned id ("pinned-grid-term") is
      // absent, but this one is a valid dispatch target.
      "grid-term": {
        id: "grid-term",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/repo",
        location: "grid",
        agentState: "idle",
      },
    });

    const { container } = await renderResolved();

    expect(container.querySelector(`button[title="${DANGER_BUTTON_TITLE}"]`)).toBeNull();
    expect(container.querySelector(".text-status-danger")).toBeNull();
  });

  it("stays neutral — no danger button — when no live grid terminal remains", async () => {
    setupPinnedSession({
      // Only the dock assistant terminal exists — no grid target to reach.
      "assistant-term": dockAssistantTerminal(),
    });

    const { container } = await renderResolved();

    // The pinned label still renders, but quietly: the neutral non-button span,
    // no danger tint, no footer "Start new session" button (recovery lives on
    // the header).
    const neutral = container.querySelector(`span[title="${NEUTRAL_PINNED_TITLE}"]`);
    expect(neutral).not.toBeNull();
    expect(neutral!.tagName).toBe("SPAN");
    expect(neutral!.textContent).toContain(PINNED_LABEL);
    expect(container.querySelector(`button[title="${DANGER_BUTTON_TITLE}"]`)).toBeNull();
    expect(container.querySelector(".text-status-danger")).toBeNull();
  });

  it("does not flag danger when a dead and a live grid terminal both exist", async () => {
    setupPinnedSession({
      "assistant-term": dockAssistantTerminal(),
      // A grid terminal that has exited is not a live dispatch target...
      "dead-grid": {
        id: "dead-grid",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/repo",
        location: "grid",
        runtimeStatus: "exited",
        exitCode: 0,
      },
      // ...but this live one is, so danger must not fire.
      "live-grid": {
        id: "live-grid",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/repo",
        location: "grid",
        agentState: "idle",
      },
    });

    const { container } = await renderResolved();

    expect(container.querySelector(`button[title="${DANGER_BUTTON_TITLE}"]`)).toBeNull();
  });

  it("stays neutral when the only grid terminal has exited", async () => {
    setupPinnedSession({
      "assistant-term": dockAssistantTerminal(),
      "dead-grid": {
        id: "dead-grid",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/repo",
        location: "grid",
        runtimeStatus: "exited",
        exitCode: 137,
      },
    });

    const { container } = await renderResolved();

    const neutral = container.querySelector(`span[title="${NEUTRAL_PINNED_TITLE}"]`);
    expect(neutral).not.toBeNull();
    expect(neutral!.textContent).toContain(PINNED_LABEL);
    expect(container.querySelector(`button[title="${DANGER_BUTTON_TITLE}"]`)).toBeNull();
    expect(container.querySelector(".text-status-danger")).toBeNull();
  });

  it("stays neutral when the only grid terminal is a missing-cli gate (no backing PTY)", async () => {
    setupPinnedSession({
      "assistant-term": dockAssistantTerminal(),
      // A `missing-cli` gate panel looks otherwise live (no exitCode/runtimeStatus)
      // but has no PTY behind it, so it can't receive a dispatched command.
      "gate-grid": {
        id: "gate-grid",
        kind: "terminal",
        spawnStatus: "missing-cli",
        cwd: "/repo",
        location: "grid",
      },
    });

    const { container } = await renderResolved();

    const neutral = container.querySelector(`span[title="${NEUTRAL_PINNED_TITLE}"]`);
    expect(neutral).not.toBeNull();
    expect(neutral!.textContent).toContain(PINNED_LABEL);
    expect(container.querySelector(`button[title="${DANGER_BUTTON_TITLE}"]`)).toBeNull();
    expect(container.querySelector(".text-status-danger")).toBeNull();
  });

  it("surfaces the diverged-worktree warning when focus moves to another worktree", async () => {
    // The pinned indicator is neutral only while focus stays on the bound
    // worktree. Focusing a different one escalates to the one-click recovery
    // button (still warning-toned, never danger) — proving the neutral branch
    // above is a real branch, not the only thing the component can render.
    setupPinnedSession({ "assistant-term": dockAssistantTerminal() });
    worktreeSelectionState.focusedWorktreeId = "wt-2";

    const { container } = await renderResolved();

    const button = container.querySelector(
      'button[title="Switch to the worktree this assistant is pinned to"]'
    );
    expect(button).not.toBeNull();
    expect(container.querySelector(`span[title="${NEUTRAL_PINNED_TITLE}"]`)).toBeNull();
    fireEvent.click(button!);
    expect(worktreeSelectionState.selectWorktree).toHaveBeenCalledWith("wt-1", { source: "user" });
  });

  it("keeps the header recovery button available with no live grid terminal", async () => {
    // Removing the footer "Start new session" button must not strand the user:
    // the header button (canStartNewSession = terminalId && agentId, both still
    // set via the dock assistant) remains the recovery path (#10792).
    setupPinnedSession({ "assistant-term": dockAssistantTerminal() });

    const { container } = await renderResolved();

    expect(container.querySelector('[aria-label="Start new session"]')).not.toBeNull();
  });

  it("does not flag danger when pinnedContext has no terminal id", async () => {
    // No terminal was pinned at provision time — the danger guard must stay off
    // regardless of grid reachability.
    setupPinnedSession({ "assistant-term": dockAssistantTerminal() });
    window.electron.help.getPinnedActionContext = vi.fn().mockResolvedValue({
      terminalId: null,
      worktreeId: "wt-1",
      worktreeName: "main",
      worktreeBranch: "main",
    });

    const { container } = await renderResolved();

    expect(container.querySelector(`button[title="${DANGER_BUTTON_TITLE}"]`)).toBeNull();
  });
});

// The renderer no longer tears down the assistant on visibility-hidden.
// PTY/MCP lifecycle is owned by main; hibernation capture for true LRU
// eviction happens in `HelpSessionService.revokeByWebContentsId`. These
// tests defend against regressions that would reintroduce the prior bug
// where project-switching destroyed the assistant.
describe("HelpPanel — assistant survives visibility-hidden (project switch persistence)", () => {
  function mountWithBoundTerminal() {
    helpPanelState.terminalId = "term-sleep";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = "session-sleep";
    panelStoreState.panelsById = { "term-sleep": { id: "term-sleep" } };
    return render(<HelpPanel width={380} />);
  }

  async function flushAsync() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("does not tear down on visibility-hidden during a project switch (cached view)", async () => {
    await act(async () => {
      mountWithBoundTerminal();
    });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushAsync();

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(mockRevokeSession).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
  });

  it("does not tear down on visibility-hidden during system suspend", async () => {
    await act(async () => {
      mountWithBoundTerminal();
    });

    act(() => {
      systemSleepListeners.suspend.forEach((cb) => cb());
    });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushAsync();

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(mockRevokeSession).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
  });

  it("does not call systemSleep.getMetrics — visibility is no longer a teardown signal", async () => {
    await act(async () => {
      mountWithBoundTerminal();
    });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushAsync();

    expect(mockSystemSleepGetMetrics).not.toHaveBeenCalled();
  });

  it("re-evaluates auto-launch on visibility restore so a missing terminal can re-launch", async () => {
    // Mount without a bound terminal so auto-launch sits gated on visibility.
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.sessionId = null;

    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-restored" } });

    // Start hidden so the initial mount's auto-launch short-circuits.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await flushAsync();

    expect(mockDispatch).not.toHaveBeenCalled();

    // Restore visibility — epoch bump retriggers auto-launch.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushAsync();

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
    expect(mockProvisionSession).toHaveBeenCalledTimes(1);
  });

  it("re-drives a launch stranded by a switch-back via app:view-revealed with no terminal bound (#10739)", async () => {
    // No bound terminal — the stuck-loader case. The existing reveal-repaint
    // effect is gated on `terminalId`, so it never registers a listener here;
    // only the new recovery effect (gated on `isOpen`) can re-drive.
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.sessionId = null;

    // getFolderPath never resolves, so the launch parks in `version-checking` —
    // exactly the stranded loading phase a parked view's frozen watchdog can't
    // reap.
    mockGetFolderPath.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      render(<HelpPanel width={380} isReadyToLaunch />);
    });
    await flushAsync();

    // The initial auto-launch fired and hung before reaching dispatch.
    const folderCallsBefore = mockGetFolderPath.mock.calls.length;
    expect(folderCallsBefore).toBeGreaterThan(0);
    expect(mockDispatch).not.toHaveBeenCalled();

    // Switch-back reveal reaps the stall and re-drives, even though terminalId
    // is still null (the terminalId-gated repaint listener never registered).
    fireViewRevealed();
    await flushAsync();

    expect(mockGetFolderPath.mock.calls.length).toBeGreaterThan(folderCallsBefore);
    // Recovery is silent — no launch-error banner, no toast.
    expect(screen.queryByTestId("help-launch-error-banner")).toBeNull();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe("HelpPanel — resume from main-captured hibernation (eviction recovery)", () => {
  it("seeds hibernate from main and resumes the conversation on auto-launch", async () => {
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.sessionId = null;
    helpPanelState.hibernateSessions = {};

    mockGetFolderPath.mockResolvedValue("/help");
    mockTakePendingHibernation.mockResolvedValueOnce({
      agentId: "claude",
      agentSessionId: "resume-id-from-main",
      cwd: "/help/session-dir",
    });
    // Mirror the real store mutation so the downstream hibernate lookup
    // observes the entry the controller just merged. Default mock just
    // tracks the call; here we also write through to the in-memory state.
    helpPanelState.setHibernateSession = vi.fn(
      (projectId: string, entry: { sessionId: string; cwd: string; agentId: string }) => {
        helpPanelState.hibernateSessions[projectId] = entry;
      }
    );
    panelStoreState.addPanel.mockResolvedValueOnce("term-resumed");

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockTakePendingHibernation).toHaveBeenCalledWith(projectStoreState.currentProject?.id);
    expect(helpPanelState.setHibernateSession).toHaveBeenCalledWith(
      projectStoreState.currentProject?.id,
      expect.objectContaining({
        sessionId: "resume-id-from-main",
        agentId: "claude",
      })
    );
    // Resume path goes through addPanel — assert the captured resume ID is
    // actually threaded into the spawn command so a regression that wires
    // addPanel without the resume token would fail.
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        launchAgentId: "claude",
        command: expect.stringContaining("resume-id-from-main"),
      })
    );
    // Fresh launch dispatch must NOT fire on the resume path.
    expect(mockDispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
    // Resume consumes the hibernate entry once committed.
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith(
      projectStoreState.currentProject?.id
    );
  });

  it("resumes via resume-latest when main returns the empty-sentinel placeholder (#9639)", async () => {
    // The eviction race fix writes an empty-`agentSessionId` placeholder before
    // gracefulKill resolves. A switch-back that lands in that window pulls the
    // sentinel — the controller must take the resume-latest path (claude
    // `--continue`) rather than a fresh `agent.launch`, so the user's assistant
    // resumes instead of visibly restarting.
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.sessionId = null;
    helpPanelState.hibernateSessions = {};

    mockGetFolderPath.mockResolvedValue("/help");
    mockTakePendingHibernation.mockResolvedValueOnce({
      agentId: "claude",
      agentSessionId: "",
      cwd: "/help/session-dir",
    });
    helpPanelState.setHibernateSession = vi.fn(
      (projectId: string, entry: { sessionId: string; cwd: string; agentId: string }) => {
        helpPanelState.hibernateSessions[projectId] = entry;
      }
    );
    panelStoreState.addPanel.mockResolvedValueOnce("term-resumed-latest");

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(helpPanelState.setHibernateSession).toHaveBeenCalledWith(
      projectStoreState.currentProject?.id,
      expect.objectContaining({ sessionId: "", agentId: "claude" })
    );
    // Resume-latest spawns through addPanel with the `--continue` flag.
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        launchAgentId: "claude",
        command: expect.stringContaining("--continue"),
      })
    );
    // The visible "restart" — a fresh launch — must NOT fire.
    expect(mockDispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
  });

  it("falls through to a fresh launch when main has no pending hibernation", async () => {
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.sessionId = null;
    helpPanelState.hibernateSessions = {};

    mockGetFolderPath.mockResolvedValue("/help");
    mockTakePendingHibernation.mockResolvedValueOnce(null);
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-cold" } });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockTakePendingHibernation).toHaveBeenCalled();
    expect(helpPanelState.setHibernateSession).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });
});
