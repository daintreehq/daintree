// @vitest-environment jsdom
import { render, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDispatch,
  mockNotify,
  mockLogError,
  mockGetFolderPath,
  mockMarkTerminal,
  mockPeekPendingHibernation,
  mockTakePendingHibernation,
  mockRestorePendingHibernation,
  mockListPendingHibernationSlots,
  mockReportPanelOpen,
  mockProvisionSession,
  mockRevokeSession,
  mockGracefulKill,
  mockBuildResumeCommand,
  mockBuildResumeLatestCommand,
  mockGetAssistantSupportedAgentIds,
  mockGetAgentConfig,
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
  scratchStoreState,
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
  mockPeekPendingHibernation: vi.fn().mockResolvedValue(null),
  mockTakePendingHibernation: vi.fn().mockResolvedValue(null),
  mockRestorePendingHibernation: vi.fn().mockResolvedValue(false),
  mockListPendingHibernationSlots: vi.fn().mockResolvedValue([]),
  mockReportPanelOpen: vi.fn().mockResolvedValue(undefined),
  mockProvisionSession: vi.fn().mockResolvedValue(null),
  mockRevokeSession: vi.fn().mockResolvedValue(undefined),
  mockGracefulKill: vi.fn().mockResolvedValue(null),
  mockBuildResumeCommand: vi.fn(),
  mockBuildResumeLatestCommand: vi.fn(),
  mockGetAssistantSupportedAgentIds: vi.fn(() => ["claude"]),
  // Implementation is installed in resetState() so per-test overrides can't leak.
  mockGetAgentConfig: vi.fn(),
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
    clearDroppedPreferredAgent: vi.fn(),
    requestFocus: vi.fn(),
    setActiveFigureNumber: vi.fn(),
    setActiveSlot: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    ensureSlot: vi.fn(),
    // #12108: the panel reads its lane pointer; the mocked selectors
    // above project this same flat object as that lane.
    activeSlot: 0,
    sessions: {} as Record<number, unknown>,
    isOpen: true,
    width: 380,
    terminalId: null as string | null,
    agentId: null as string | null,
    preferredAgentId: null as string | null,
    // Consent granted by default (#10699) so the resume/auto-launch coverage
    // runs; the consent gate is unit-tested in HelpSessionController.test.ts.
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
  scratchStoreState: {
    currentScratch: null as { id: string; path: string } | null,
  },
  preferencesState: { reduceAnimations: false },
  terminalInputState: { hybridInputEnabled: true } as { hybridInputEnabled: boolean },
  mockTerminalSubmit: vi.fn(),
  mockTerminalSendKey: vi.fn(),
  mockNotifyUserInput: vi.fn(),
}));

// Pass-through dropdown mock (same shape as PanelHeader.test.tsx) — keeps the
// header's lazily-loaded Radix overflow menu (and its actionService import
// chain) out of this suite's module graph.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  DropdownMenuTrigger: ({ children }: { children?: unknown }) => <>{children as never}</>,
  DropdownMenuContent: ({ children }: { children?: unknown }) => (
    <div data-testid="overflow-menu">{children as never}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children?: unknown;
    onSelect?: (e: Event) => void;
    destructive?: boolean;
  }) => (
    <button type="button" onClick={() => onSelect?.(new Event("select"))}>
      {children as never}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
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
  const ids = ["claude"];
  return {
    BUILT_IN_AGENT_IDS: ids,
    ASSISTANT_ONLY_AGENT_IDS: [],
    LAUNCHABLE_AGENT_IDS: ids,
    isBuiltInAgentId: (value: unknown): value is "claude" =>
      typeof value === "string" && ids.includes(value),
    isAssistantOnlyAgentId: () => false,
  };
});

vi.mock("@/config/agents", () => ({
  AGENT_REGISTRY: {
    claude: { name: "Claude", iconId: "claude", color: "#000", icon: () => null },
  },
  getAgentConfig: (id: string) => mockGetAgentConfig(id),
  getAssistantSupportedAgentIds: () => mockGetAssistantSupportedAgentIds(),
  getAgentIds: () => ["claude"],
}));

vi.mock("@shared/types/agentSettings", () => ({
  buildResumeCommand: (...args: unknown[]) => mockBuildResumeCommand(...args),
  buildResumeLatestCommand: (...args: unknown[]) => mockBuildResumeLatestCommand(...args),
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

// Mocked at its leaf path, mirroring the component's import (#11068). The panel
// pulls `useScratchStore` from `@/store/scratchStore` rather than the `@/store`
// barrel precisely so barrel-mocking suites like this one don't have to list it.
// Focus mode parks the assistant off-canvas without closing it, so the panel's
// report has to be able to say "open but not on screen".
const focusStoreState = { gestureAssistantHidden: false };

vi.mock("@/store/scratchStore", () => {
  const store = (selector?: (state: typeof scratchStoreState) => unknown) =>
    selector ? selector(scratchStoreState) : scratchStoreState;
  store.getState = () => scratchStoreState;
  return { useScratchStore: store };
});

vi.mock("@/store/focusStore", () => {
  const store = (selector?: (s: typeof focusStoreState) => unknown) =>
    selector ? selector(focusStoreState) : focusStoreState;
  store.getState = () => focusStoreState;
  return { useFocusStore: store };
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

// The figure rail pulls the real AppDialog (lightbox) into the module graph,
// which drags the @/hooks → panelPersistence chain past this suite's store
// mocks. The rail isn't under test here, so stub it like the other heavy
// children (XtermAdapter, ConfirmDialog) — its own suite is FigureRail.test.tsx.
vi.mock("../FigureRail", () => ({ FigureRail: () => null }));

import { HelpPanel } from "../HelpPanel";
import { assistantSlotKey as slotKey } from "@shared/config/assistantSlots";
import { __resetHelpSessionControllersForTests } from "@/controllers/helpSessionControllerRegistry";

// Drain the full async chain (pull-on-mount peek → setState → re-render →
// fire-effect → async launch) by yielding to a macrotask: setTimeout(0) runs
// only once the microtask queue is empty, so every chained `await` in the
// launch flow has settled when it fires. RTL's standalone `waitFor` can't be
// used here — this suite replaces the global `window` with a minimal mock that
// has no `document`, which waitFor's MutationObserver requires.
async function flushAsyncWork() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Per-agent icon stand-ins for the empty-state CTA coverage. `getAgentConfig`
// hands back a fresh config object on every call, so the icon *component*
// reference is what has to stay stable — minting one per lookup would remount
// the glyph each render. `data-agent-icon` is a test-only handle rather than a
// copy of any production name, and `data-brand-color` records whether the CTA
// wrapped in BrandMark (it must not: the glyph inherits the button foreground).
function makeAgentIconStub(agentId: string) {
  return function AgentIconStub({ style }: { style?: React.CSSProperties }) {
    const ink = (style as Record<string, string> | undefined)?.["--brand-mark-rest"];
    return <svg data-agent-icon={agentId} data-brand-color={ink ?? "inherit"} />;
  };
}
const CLAUDE_ICON_STUB = makeAgentIconStub("claude");
const CODEX_ICON_STUB = makeAgentIconStub("codex");
const NULL_ICON_STUB = () => null;

function agentIconMarkerIn(container: Element | null): string | null {
  return container?.querySelector("[data-agent-icon]")?.getAttribute("data-agent-icon") ?? null;
}

function resetState() {
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

  cliAvailabilityState.availability = { claude: "ready" };
  cliAvailabilityState.isInitialized = true;
  cliAvailabilityState.hasRealData = true;
  cliAvailabilityState.details = {};

  agentSettingsState.settings = { agents: {} };

  projectStoreState.currentProject = null;
  scratchStoreState.currentScratch = null;
  preferencesState.reduceAnimations = false;
  terminalInputState.hybridInputEnabled = true;
  mockTerminalSubmit.mockReset();
  mockTerminalSubmit.mockResolvedValue(undefined);
  mockTerminalSendKey.mockReset();
  mockNotifyUserInput.mockReset();
  mockPeekPendingHibernation.mockReset();
  mockPeekPendingHibernation.mockResolvedValue(null);
  mockTakePendingHibernation.mockReset();
  mockTakePendingHibernation.mockResolvedValue(null);
  mockRestorePendingHibernation.mockReset();
  mockRestorePendingHibernation.mockResolvedValue(false);
  mockListPendingHibernationSlots.mockReset();
  mockListPendingHibernationSlots.mockResolvedValue([]);
  helpPanelState.ensureSlot = vi.fn();
  mockReportPanelOpen.mockReset();
  mockReportPanelOpen.mockResolvedValue(undefined);
  focusStoreState.gestureAssistantHidden = false;
  mockProvisionSession.mockReset();
  mockProvisionSession.mockResolvedValue(null);
  mockRevokeSession.mockReset();
  mockRevokeSession.mockResolvedValue(undefined);
  mockGracefulKill.mockReset();
  mockGracefulKill.mockResolvedValue(null);
  mockBuildResumeCommand.mockReset();
  mockBuildResumeCommand.mockReturnValue("claude --resume abc-123");
  // Default undefined (no resume support) so tests 635/665 keep exercising the
  // buildResumeCommand-undefined fallthrough; resume-capable cases opt in below.
  mockBuildResumeLatestCommand.mockReset();
  mockGetAssistantSupportedAgentIds.mockReset();
  mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
  // Any-id-resolves-to-Claude with a glyph that renders nothing: the pre-#11834
  // default, so the suite's other cases see exactly what they always did.
  mockGetAgentConfig.mockReset();
  mockGetAgentConfig.mockImplementation(() => ({
    name: "Claude",
    icon: NULL_ICON_STUB,
    models: [],
  }));
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
        help: {
          getFolderPath: mockGetFolderPath,
          markTerminal: mockMarkTerminal,
          peekPendingHibernation: mockPeekPendingHibernation,
          takePendingHibernation: mockTakePendingHibernation,
          restorePendingHibernation: mockRestorePendingHibernation,
          listPendingHibernationSlots: mockListPendingHibernationSlots,
          reportPanelOpen: mockReportPanelOpen,
          provisionSession: mockProvisionSession,
          revokeSession: mockRevokeSession,
          getPinnedActionContext: vi.fn().mockResolvedValue({}),
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
      [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
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
        excludeFromPersistence: true,
        removeOnExit: true,
      })
    );
    // Resume bypasses the standard agent.launch dispatch.
    expect(mockDispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1", 0);
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      0,
      "resumed-term-1",
      "claude",
      "fresh-session"
    );
  });

  it("does NOT resume a matching hibernated session when autoLaunchEnabled is false (#10699)", async () => {
    // Consent gates the resume path too — a returning user post-migration must
    // not silently spend tokens re-launching a hibernated agent on panel open.
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
    };
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    panelStoreState.addPanel = vi.fn().mockResolvedValue("resumed-term-1");

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockBuildResumeCommand).not.toHaveBeenCalled();
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(helpPanelState.clearHibernateSession).not.toHaveBeenCalled();
  });

  it("renders the resume banner after a successful resume", async () => {
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
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
      [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "gemini" },
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
      [slotKey("other-proj", 0)]: { sessionId: "xyz", cwd: "/tmp/help/other", agentId: "claude" },
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
      [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
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

    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1", 0);
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });

  it("falls through to agent.launch when the resumed addPanel returns no id", async () => {
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
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

    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1", 0);
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });
});

describe("HelpPanel — Resume affordance for eviction-captured sessions", () => {
  // The eviction/crash path kills the assistant PTY and stashes a resume token
  // in main's pending-hibernation store. A default user (consent off) gets no
  // passive recovery, so the idle empty state peeks that store and offers
  // "Resume assistant" instead of a fresh "Start assistant".
  it("renders Resume assistant for an installed, resume-capable captured agent", async () => {
    helpPanelState.autoLaunchEnabled = false; // default user — empty state stays visible
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockBuildResumeLatestCommand.mockReturnValue("claude resume --last"); // claude is resume-capable
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
    });

    const { findByTestId, queryByTestId } = await act(async () =>
      render(<HelpPanel width={380} />)
    );

    expect(await findByTestId("help-resume-assistant")).toBeTruthy();
    // The Resume CTA replaces the fresh-start primary in the empty state.
    expect(queryByTestId("help-start-assistant")).toBeNull();
    expect(mockPeekPendingHibernation).toHaveBeenCalledWith("proj-1", 0);
  });

  it("clicking Resume resumes the captured session WITHOUT recording consent (#10699)", async () => {
    helpPanelState.autoLaunchEnabled = false;
    // The captured entry is also seeded into the renderer store the launch flow
    // reads (setHibernateSession is mocked, so we pre-seed what _seedHibernateFromMain
    // would have written) — this proves the click actually resumes, not just launches.
    helpPanelState.hibernateSessions = {
      [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
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
    mockBuildResumeLatestCommand.mockReturnValue("claude resume --last");
    panelStoreState.addPanel = vi.fn().mockResolvedValue("resumed-term-1");
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
    });

    const { findByTestId } = await act(async () => render(<HelpPanel width={380} />));
    const resumeButton = await findByTestId("help-resume-assistant");

    await act(async () => {
      fireEvent.click(resumeButton);
    });

    // Resumes the captured session via the agent's --resume command...
    expect(mockBuildResumeCommand).toHaveBeenCalledWith("claude", "abc-123", undefined);
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        launchAgentId: "claude",
        command: "claude --resume abc-123",
        removeOnExit: true,
      })
    );
    // ...but resuming is a one-time recovery, NOT an opt-in to billed
    // auto-launch on every future open — unlike "Start assistant".
    expect(helpPanelState.setAutoLaunchEnabled).not.toHaveBeenCalled();
  });

  it("does not offer Resume when the captured agent is no longer installed", async () => {
    helpPanelState.autoLaunchEnabled = false;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockBuildResumeLatestCommand.mockReturnValue("gemini resume --last");
    // claude is the only installed/supported agent in this suite, so a gemini
    // capture is filtered by the installed guard even though it can resume.
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "gemini",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
    });

    const { findByTestId, queryByTestId } = await act(async () =>
      render(<HelpPanel width={380} />)
    );

    expect(await findByTestId("help-start-assistant")).toBeTruthy();
    expect(queryByTestId("help-resume-assistant")).toBeNull();
  });

  it("does not offer Resume when the captured agent has no resume support", async () => {
    helpPanelState.autoLaunchEnabled = false;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    // claude is installed/supported here, but buildResumeLatestCommand undefined
    // models a non-resumable agent (e.g. the built-in assistant). Resuming would
    // dead-end and silently start fresh, so the CTA must NOT promise a resume.
    mockBuildResumeLatestCommand.mockReturnValue(undefined);
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
    });

    const { findByTestId, queryByTestId } = await act(async () =>
      render(<HelpPanel width={380} />)
    );

    expect(await findByTestId("help-start-assistant")).toBeTruthy();
    expect(queryByTestId("help-resume-assistant")).toBeNull();
  });

  it("does not offer Resume when main has no pending hibernation", async () => {
    helpPanelState.autoLaunchEnabled = false;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockBuildResumeLatestCommand.mockReturnValue("claude resume --last");
    mockPeekPendingHibernation.mockResolvedValue(null);

    const { findByTestId, queryByTestId } = await act(async () =>
      render(<HelpPanel width={380} />)
    );

    expect(await findByTestId("help-start-assistant")).toBeTruthy();
    expect(queryByTestId("help-resume-assistant")).toBeNull();
  });
});

describe("HelpPanel — empty-state CTA wears the launching agent's mark (#11834)", () => {
  // A generic glyph on both CTAs said nothing about what was about to start.
  // Each button now carries the mark of the agent it would actually launch,
  // and the two buttons read different ids — Start follows the launch
  // preference, Resume follows whichever agent's conversation was captured.
  it("Start assistant wears the mark of the agent it would launch", async () => {
    helpPanelState.autoLaunchEnabled = false; // default user — empty state stays visible
    helpPanelState.preferredAgentId = "codex";
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetAgentConfig.mockImplementation((id: string) =>
      id === "codex" ? { name: "Codex", icon: CODEX_ICON_STUB, models: [] } : undefined
    );

    const { findByTestId } = await act(async () => render(<HelpPanel width={380} />));
    const startButton = await findByTestId("help-start-assistant");

    expect(agentIconMarkerIn(startButton)).toBe("codex");
    // No resolved ink reaches the glyph, so it inherits the button's own
    // foreground instead of painting itself the agent's brand hue.
    expect(startButton.querySelector("[data-agent-icon]")?.getAttribute("data-brand-color")).toBe(
      "inherit"
    );
  });

  it("Resume assistant wears the captured agent's mark, not the launch preference's", async () => {
    helpPanelState.autoLaunchEnabled = false;
    // The preference points at codex while the stranded conversation belongs to
    // claude. Resume relaunches the captured agent, so it must promise claude —
    // this is what proves the two CTAs read different ids rather than sharing one.
    helpPanelState.preferredAgentId = "codex";
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockBuildResumeLatestCommand.mockReturnValue("claude resume --last");
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
    });
    mockGetAgentConfig.mockImplementation((id: string) => {
      if (id === "claude") return { name: "Claude", icon: CLAUDE_ICON_STUB, models: [] };
      if (id === "codex") return { name: "Codex", icon: CODEX_ICON_STUB, models: [] };
      return undefined;
    });

    const { findByTestId } = await act(async () => render(<HelpPanel width={380} />));
    const resumeButton = await findByTestId("help-resume-assistant");

    expect(agentIconMarkerIn(resumeButton)).toBe("claude");
  });

  it("infers the mark from the sole supported agent when no preference is set", async () => {
    helpPanelState.autoLaunchEnabled = false;
    // No stored preference, so the launch target is inferred from the single
    // installed supported backend. The mark has to follow that inference rather
    // than reading the (absent) preference straight off the store.
    helpPanelState.preferredAgentId = null;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetAgentConfig.mockImplementation((id: string) =>
      id === "claude" ? { name: "Claude", icon: CLAUDE_ICON_STUB, models: [] } : undefined
    );

    const { findByTestId } = await act(async () => render(<HelpPanel width={380} />));

    expect(agentIconMarkerIn(await findByTestId("help-start-assistant"))).toBe("claude");
  });

  it("swaps back to a generic mark when the launchable agent's config disappears", async () => {
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.preferredAgentId = "codex";
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    // Flipped between renders rather than via mockImplementationOnce: the config
    // is resolved more than once per render, so a one-shot override would fall
    // through mid-render and prove nothing.
    let codexConfigResolves = true;
    mockGetAgentConfig.mockImplementation((id: string) =>
      id === "codex" && codexConfigResolves
        ? { name: "Codex", icon: CODEX_ICON_STUB, models: [] }
        : undefined
    );

    const { findByTestId, rerender } = await act(async () => render(<HelpPanel width={380} />));
    expect(agentIconMarkerIn(await findByTestId("help-start-assistant"))).toBe("codex");

    // The id now outlives its registry entry. The CTA has to keep a glyph rather
    // than leave an empty slot beside its label.
    codexConfigResolves = false;
    await act(async () => {
      rerender(<HelpPanel width={380} />);
    });
    const startButton = await findByTestId("help-start-assistant");

    expect(agentIconMarkerIn(startButton)).toBeNull();
    expect(startButton.querySelector("svg")).toBeTruthy();
  });
});

describe("HelpPanel — cold switch-back auto-resume (#10815)", () => {
  it("reports the panel open-state to main for the current project", async () => {
    helpPanelState.isOpen = true;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockReportPanelOpen).toHaveBeenCalledWith("proj-1", true, true);
  });

  it("auto-opens and resumes the captured session WITHOUT recording consent on cold restore", async () => {
    // Default user (consent off) so the controller does NOT auto-launch a fresh
    // session on open — proving the resume comes from the pull-on-mount peek,
    // not the controller's own consent-gated auto-launch.
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.terminalId = null;
    // Seed what _seedHibernateFromMain would have written so the launch actually
    // resumes (mirrors the click-to-resume test).
    helpPanelState.hibernateSessions = {
      [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
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
    mockBuildResumeLatestCommand.mockReturnValue("claude resume --last");
    panelStoreState.addPanel = vi.fn().mockResolvedValue("resumed-term-1");
    // Main captured this project's assistant with the panel open at eviction —
    // the peek surfaces panelWasOpen:true and the renderer drives the resume off
    // it (no main→renderer push to miss).
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      panelWasOpen: true,
    });
    // #10819: the resumeOnly launch gates on the atomic take (hoisted before
    // provisioning). Whenever the peek surfaces a panelWasOpen entry, main still
    // holds it, so the take returns the same entry.
    mockTakePendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      claimId: "claim-1",
    });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    // The panel is auto-opened off the peek...
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(true);
    // ...and the captured session resumes via the agent's --resume command.
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        launchAgentId: "claude",
        command: "claude --resume abc-123",
        removeOnExit: true,
      })
    );
    expect(mockBuildResumeCommand).toHaveBeenCalledWith("claude", "abc-123", undefined);
    // Auto-resuming a stranded session is recovery, NOT billed-auto-launch
    // consent — same separation as the manual Resume CTA (#10699).
    expect(helpPanelState.setAutoLaunchEnabled).not.toHaveBeenCalled();
  });

  it("releases a mismatched-agent take without touching the hibernate slot it never wrote (#11477)", async () => {
    // The resumeOnly take is hoisted above provisioning (#10819), so it lands
    // BEFORE the agentId check. On a mismatch the launch bails without ever
    // seeding — meaning the local hibernate slot still holds whatever was
    // already there. The put-back must return main's copy and leave that slot
    // alone; clearing it unconditionally would delete an entry this launch
    // never owned.
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.terminalId = null;
    const preExisting = {
      sessionId: "graceful-close-id",
      cwd: "/tmp/help/proj-1",
      agentId: "codex",
    };
    helpPanelState.hibernateSessions = { [slotKey("proj-1", 0)]: preExisting };
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      panelWasOpen: true,
    });
    // Main's captured entry is for a DIFFERENT agent than the one launching.
    mockTakePendingHibernation.mockResolvedValue({
      agentId: "gemini",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      claimId: "claim-mismatch",
    });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    expect(mockRestorePendingHibernation).toHaveBeenCalledWith("proj-1", "claim-mismatch", 0);
    expect(helpPanelState.clearHibernateSession).not.toHaveBeenCalledWith("proj-1", 0);
    expect(helpPanelState.hibernateSessions[slotKey("proj-1", 0)]).toEqual(preExisting);
  });

  it("does NOT launch when a live session already exists (DevTools reload guard)", async () => {
    // A DevTools reload can mount the panel while the store still reports a live
    // terminal. The `!terminalId` gate must drop the auto-resume so a second
    // backend is never spawned over the live one — even though main still has a
    // panelWasOpen capture for the project.
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.terminalId = "live-term";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = "live-session";
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    panelStoreState.addPanel = vi.fn().mockResolvedValue("should-not-be-called");
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      panelWasOpen: true,
    });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    // No new session spawned over the live one.
    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
  });

  it("defers the resume launch until the panel is actually open (isOpen gate)", async () => {
    // The peek resolves while the panel is closed (a cold restore always
    // rehydrates with isOpen=false). The launch must NOT fire until the panel
    // has opened — proving the fire-effect is gated on isOpen, not just on the
    // arm from the peek.
    helpPanelState.isOpen = false;
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.terminalId = null;
    helpPanelState.hibernateSessions = {
      [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
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
    mockBuildResumeLatestCommand.mockReturnValue("claude resume --last");
    panelStoreState.addPanel = vi.fn().mockResolvedValue("resumed-term-1");
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      panelWasOpen: true,
    });
    // #10819: take returns the same entry the peek surfaced (gates the resume).
    mockTakePendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      claimId: "claim-1",
    });

    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    // Peek resolved while closed — panel is asked to open, but with the store
    // still reporting isOpen=false the launch must not fire yet.
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(true);
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();

    // The panel actually opens; re-render reflects the new store state and the
    // gated effect now fires the resume.
    helpPanelState.isOpen = true;
    await act(async () => {
      view!.rerender(<HelpPanel width={380} />);
    });
    await flushAsyncWork();
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude --resume abc-123" })
    );
  });

  it("consumes the pending entry via takePendingHibernation and RESUMES (peek→take→resume handoff)", async () => {
    // The cold-restore peek is non-consuming; the real handoff is the
    // controller's atomic takePendingHibernation, which seeds the hibernate slot
    // the resume lookup reads. Wire setHibernateSession/clearHibernateSession to
    // mutate state so the genuine take→seed→resume chain runs end to end — no
    // pre-seeded shortcut masking the handoff.
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.terminalId = null;
    helpPanelState.hibernateSessions = {};
    helpPanelState.setHibernateSession = vi.fn(
      (
        projectId: string,
        slot: number,
        entry: { sessionId: string; cwd: string; agentId: string }
      ) => {
        helpPanelState.hibernateSessions[slotKey(projectId, slot)] = entry;
      }
    );
    helpPanelState.clearHibernateSession = vi.fn((projectId: string, slot: number) => {
      delete helpPanelState.hibernateSessions[slotKey(projectId, slot)];
    });
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "fresh-session",
      sessionPath: "/tmp/help/proj-1",
      token: "tok",
      mcpUrl: "http://localhost:1234",
      windowId: 1,
    });
    mockBuildResumeLatestCommand.mockReturnValue("claude resume --last");
    panelStoreState.addPanel = vi.fn().mockResolvedValue("resumed-term-1");
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      panelWasOpen: true,
    });
    // Main hands the captured entry over atomically — this is what actually
    // moves the resume token into the renderer's hibernate slot.
    mockTakePendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      claimId: "claim-1",
    });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    // The peek targets the in-view project, and the launch consumes the entry
    // via the atomic take.
    expect(mockPeekPendingHibernation).toHaveBeenCalledWith("proj-1", 0);
    expect(mockTakePendingHibernation).toHaveBeenCalledWith("proj-1", 0);
    // The session is RESUMED (addPanel with the --resume command)...
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude --resume abc-123", launchAgentId: "claude" })
    );
    // ...never fresh-launched via the generic agent.launch dispatch.
    expect(mockDispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
    // The token was genuinely spent, so it is NOT handed back (#11477).
    expect(mockRestorePendingHibernation).not.toHaveBeenCalled();
  });

  it("hands the taken resume token back to main when provisioning fails (#11477)", async () => {
    // `takePendingHibernation` clears main's side, so a launch that takes and
    // then aborts used to destroy the user's only resume token — here via a
    // plain provisioning failure, which the original five-site inventory of
    // take-and-drop paths missed entirely. The put-back is what makes the
    // resume net survive an abort.
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.terminalId = null;
    helpPanelState.hibernateSessions = {};
    helpPanelState.setHibernateSession = vi.fn(
      (
        projectId: string,
        slot: number,
        entry: { sessionId: string; cwd: string; agentId: string }
      ) => {
        helpPanelState.hibernateSessions[slotKey(projectId, slot)] = entry;
      }
    );
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      panelWasOpen: true,
    });
    mockTakePendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      claimId: "claim-1",
    });
    // Provisioning fails AFTER the take has already consumed main's entry.
    mockProvisionSession.mockResolvedValue(null);

    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    expect(mockTakePendingHibernation).toHaveBeenCalledWith("proj-1", 0);
    // Quoting the claim main handed out, so the put-back acts on THIS take and
    // not on whatever the project's slot happens to hold by then.
    expect(mockRestorePendingHibernation).toHaveBeenCalledWith("proj-1", "claim-1", 0);
    // The renderer's local mirror goes with it: seedFromMain wrote the taken
    // entry into hibernateSessions, and leaving that behind while main hands
    // the entry to another window would let two windows resume one
    // conversation — the single-winner invariant the atomic take holds.
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1", 0);
  });

  // #11068: the same cold-resume handoff, but the active workspace is a scratch
  // (so `currentProject` is null). Every hop — peek, panel-open report, atomic
  // take — must key on the scratch id; before the fix they all keyed on null and
  // the assistant refused to launch at all.
  it("peeks, reports, and takes under the scratch id when a scratch is the active workspace", async () => {
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.terminalId = null;
    helpPanelState.hibernateSessions = {};
    helpPanelState.setHibernateSession = vi.fn(
      (
        workspaceId: string,
        slot: number,
        entry: { sessionId: string; cwd: string; agentId: string }
      ) => {
        helpPanelState.hibernateSessions[slotKey(workspaceId, slot)] = entry;
      }
    );
    helpPanelState.clearHibernateSession = vi.fn((workspaceId: string, slot: number) => {
      delete helpPanelState.hibernateSessions[slotKey(workspaceId, slot)];
    });
    projectStoreState.currentProject = null;
    scratchStoreState.currentScratch = { id: "scratch-1", path: "/scratches/scratch-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "fresh-session",
      sessionPath: "/tmp/help/scratch-1",
      token: "tok",
      mcpUrl: "http://localhost:1234",
      windowId: 1,
    });
    mockBuildResumeLatestCommand.mockReturnValue("claude resume --last");
    panelStoreState.addPanel = vi.fn().mockResolvedValue("resumed-term-1");
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/scratches/scratch-1",
      panelWasOpen: true,
    });
    mockTakePendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/scratches/scratch-1",
      claimId: "claim-1",
    });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    expect(mockPeekPendingHibernation).toHaveBeenCalledWith("scratch-1", 0);
    expect(mockTakePendingHibernation).toHaveBeenCalledWith("scratch-1", 0);
    expect(mockReportPanelOpen).toHaveBeenCalledWith(
      "scratch-1",
      expect.any(Boolean),
      expect.any(Boolean)
    );
    // Provisioning treats the scratch as the workspace — same opaque id/path.
    expect(mockProvisionSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "scratch-1",
        projectPath: "/scratches/scratch-1",
      })
    );
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude --resume abc-123", launchAgentId: "claude" })
    );
  });

  it("does NOT auto-resume on app restart (panelWasOpen:false)", async () => {
    // A prior-session token reloaded from disk lacks the in-memory open flag, so
    // main reports panelWasOpen:false. App restart must never silently spin up a
    // billed assistant the user didn't ask for.
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.terminalId = null;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      panelWasOpen: false,
    });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    expect(helpPanelState.setOpen).not.toHaveBeenCalledWith(true);
    expect(mockTakePendingHibernation).not.toHaveBeenCalled();
    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
  });

  it("does NOT auto-resume when the peek entry lacks panelWasOpen", async () => {
    // Defensive against a legacy/disk-loaded entry shape with the field absent:
    // treated identically to false — no arm, no resume.
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.terminalId = null;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
    });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    expect(helpPanelState.setOpen).not.toHaveBeenCalledWith(true);
    expect(mockTakePendingHibernation).not.toHaveBeenCalled();
    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
  });

  it("aborts resume-only without fresh-launching or erroring when the entry was already taken", async () => {
    // Two windows of the same project both peek panelWasOpen:true and both arm,
    // but the atomic take has exactly one winner. The losing window's resume-only
    // launch finds nothing to resume: it must abort cleanly — never fresh-launch a
    // blank session over the backend the other window just resumed, never leak the
    // provisioned session, and never raise a launch error for an expected no-op.
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.terminalId = null;
    helpPanelState.hibernateSessions = {};
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "fresh-session",
      sessionPath: "/tmp/help/proj-1",
      token: "tok",
      mcpUrl: "http://localhost:1234",
      windowId: 1,
    });
    panelStoreState.addPanel = vi.fn().mockResolvedValue("should-not-be-called");
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      panelWasOpen: true,
    });
    // The other window already won the atomic take.
    mockTakePendingHibernation.mockResolvedValue(null);

    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    // The losing window armed and attempted the take...
    expect(mockTakePendingHibernation).toHaveBeenCalledWith("proj-1", 0);
    // ...but nothing is resumed and nothing is fresh-launched.
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
    // #10819: the null take aborts BEFORE provisioning, so the loser never mints
    // a session (nothing to revoke) and — critically — never runs the displacing
    // provision that would have killed the backend the winning window just resumed.
    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(mockRevokeSession).not.toHaveBeenCalled();
    // No scary launch error — neither a toast nor the inline banner.
    expect(mockNotify).not.toHaveBeenCalled();
    expect(view!.queryByTestId("help-launch-error-banner")).toBeNull();
  });

  it("preserves the resume intent until the controller is ready (readiness gate)", async () => {
    // A true cold restore renders while project state is still hydrating
    // (isReadyToLaunch=false). Arming then would burn the one-shot intent on a
    // launch the controller rejects. The intent must survive and fire once
    // hydration completes.
    helpPanelState.autoLaunchEnabled = false;
    helpPanelState.terminalId = null;
    helpPanelState.hibernateSessions = {
      [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
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
    mockBuildResumeLatestCommand.mockReturnValue("claude resume --last");
    panelStoreState.addPanel = vi.fn().mockResolvedValue("resumed-term-1");
    mockPeekPendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      panelWasOpen: true,
    });
    // #10819: take returns the same entry the peek surfaced (gates the resume).
    mockTakePendingHibernation.mockResolvedValue({
      agentId: "claude",
      agentSessionId: "abc-123",
      cwd: "/tmp/help/proj-1",
      claimId: "claim-1",
    });

    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<HelpPanel width={380} isReadyToLaunch={false} />);
    });
    await flushAsyncWork();

    // Still hydrating: the auto-resume must not arm, so the panel isn't
    // force-opened and no session is provisioned — the intent is held, not lost.
    expect(helpPanelState.setOpen).not.toHaveBeenCalledWith(true);
    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();

    // Hydration completes — the gated effect arms and the resume fires exactly once.
    await act(async () => {
      view!.rerender(<HelpPanel width={380} isReadyToLaunch={true} />);
    });
    await flushAsyncWork();

    expect(mockPeekPendingHibernation).toHaveBeenCalledWith("proj-1", 0);
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(true);
    expect(panelStoreState.addPanel).toHaveBeenCalledTimes(1);
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude --resume abc-123" })
    );
  });

  it("reports an open-but-parked panel as not visible", async () => {
    // Focus mode slides the assistant off-canvas and deliberately leaves
    // `isOpen` true so exiting the gesture can bring it back. The two facts go
    // to main separately: the open flag still drives cold-resume, while the
    // project tallies read visibility and must stop reporting an assistant
    // nobody can see.
    helpPanelState.isOpen = true;
    focusStoreState.gestureAssistantHidden = true;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockReportPanelOpen).toHaveBeenCalledWith("proj-1", true, false);
  });

  it("reports the panel closed to main when isOpen transitions to false", async () => {
    helpPanelState.isOpen = true;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };

    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<HelpPanel width={380} />);
    });
    expect(mockReportPanelOpen).toHaveBeenCalledWith("proj-1", true, true);

    // User closes the panel — main must learn so a later eviction does not
    // stamp panelWasOpen:true and auto-resume an assistant the user dismissed.
    helpPanelState.isOpen = false;
    await act(async () => {
      view!.rerender(<HelpPanel width={380} />);
    });
    expect(mockReportPanelOpen).toHaveBeenCalledWith("proj-1", false, false);
  });
});

describe("HelpPanel — resume preserves user-configured launch flags", () => {
  it("threads customArgs into both buildResumeCommand and addPanel.agentLaunchFlags", async () => {
    helpPanelState.preferredAgentId = "claude";
    helpPanelState.hibernateSessions = {
      [slotKey("proj-1", 0)]: { sessionId: "abc-123", cwd: "/tmp/help/proj-1", agentId: "claude" },
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
      expect(helpPanelState.setHibernateSession).toHaveBeenCalledWith("proj-1", 0, {
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

  // #11068: a scratch workspace clears `currentProject`, so before the fix the
  // hibernate slot was keyed on `null` and the captured session was silently
  // dropped — the conversation could never be resumed.
  it("keys the hibernate slot on the scratch id when a scratch is the active workspace", async () => {
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
          cwd: "/scratches/scratch-1",
          agentState: "idle",
        },
      };
      projectStoreState.currentProject = null;
      scratchStoreState.currentScratch = { id: "scratch-1", path: "/scratches/scratch-1" };
      mockGracefulKill.mockResolvedValue("resume-token-scratch");

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
      expect(helpPanelState.setHibernateSession).toHaveBeenCalledWith("scratch-1", 0, {
        sessionId: "resume-token-scratch",
        cwd: "/scratches/scratch-1",
        agentId: "claude",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // #11068 follow-up: arming with a null workspace used to be possible (the
  // armed-identity tuple is only terminal+agent, so a later arm with the SAME
  // tuple early-returns). The timer would then fire, tear the PTY down, and skip
  // every `if (projectId)` persistence branch — destroying the conversation
  // instead of hibernating it. Now we refuse to arm until a workspace is known.
  it("does not arm — and so cannot destroy the session — while the active workspace is null", async () => {
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
          cwd: "/scratches/scratch-1",
          agentState: "idle",
        },
      };
      // Panel closed with a live terminal, but no workspace pointer yet.
      projectStoreState.currentProject = null;
      scratchStoreState.currentScratch = null;
      mockGracefulKill.mockResolvedValue("resume-token-scratch");

      let view: ReturnType<typeof render> | undefined;
      await act(async () => {
        view = render(<HelpPanel width={380} />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      });

      // Nothing armed: the session is left intact rather than killed unsaved.
      expect(mockGracefulKill).not.toHaveBeenCalled();
      expect(panelStoreState.removePanel).not.toHaveBeenCalled();

      // The workspace resolves (same terminal + agent — the tuple that used to
      // early-return past a sticky null arm). Hibernation must now key on it.
      scratchStoreState.currentScratch = { id: "scratch-1", path: "/scratches/scratch-1" };
      await act(async () => {
        view!.rerender(<HelpPanel width={380} />);
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      });

      expect(mockGracefulKill).toHaveBeenCalledWith("t1");
      expect(helpPanelState.setHibernateSession).toHaveBeenCalledWith("scratch-1", 0, {
        sessionId: "resume-token-scratch",
        cwd: "/scratches/scratch-1",
        agentId: "claude",
      });
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
        [slotKey("proj-1", 0)]: { sessionId: "old", cwd: "/help", agentId: "claude" },
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
      expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1", 0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HelpPanel — assistant header state indicator", () => {
  function setupTerminalWithState(state: string) {
    helpPanelState.terminalId = "live-term";
    helpPanelState.agentId = "claude";
    // The strip reads each lane's terminal off `sessions[slot]`, not the flat fields
    // the rest of this fixture projects as the active lane — so the lane has to exist
    // there for its marker to render at all.
    helpPanelState.sessions = {
      0: {
        terminalId: "live-term",
        agentId: "claude",
        sessionId: null,
        conversationTouched: false,
        figures: [],
        activeFigureNumber: null,
      },
    };
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

  // The header no longer DRAWS the active lane's state — the session strip does, and
  // drawing it in both put two identical glyphs one row apart for the same lane. What
  // the header keeps is the announcement, because the strip reaches assistive tech
  // through `aria-describedby`, which is read when a tab takes focus and not when the
  // state changes underneath it.

  it("announces the working state without drawing a second marker for it", () => {
    setupTerminalWithState("working");

    const { getByTestId, container } = render(<HelpPanel width={380} />);
    const announcer = getByTestId("assistant-header-state-announcer");
    expect(announcer.getAttribute("data-agent-state")).toBe("working");
    expect(announcer.getAttribute("role")).toBe("status");
    expect(announcer.textContent).toBe("Assistant is working");
    // Exactly one working marker on screen, and it belongs to a tab — not zero (the
    // state would be invisible) and not two (the header would be drawing it again).
    const markers = container.querySelectorAll("svg.animate-spin-slow");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.closest('[role="tab"]')).not.toBeNull();
  });

  it("announces the waiting state", () => {
    setupTerminalWithState("waiting");

    const { getByTestId } = render(<HelpPanel width={380} />);
    const announcer = getByTestId("assistant-header-state-announcer");
    expect(announcer.getAttribute("data-agent-state")).toBe("waiting");
    expect(announcer.textContent).toBe("Assistant is waiting");
  });

  it("announces the directing state", () => {
    setupTerminalWithState("directing");

    const { getByTestId } = render(<HelpPanel width={380} />);
    const announcer = getByTestId("assistant-header-state-announcer");
    expect(announcer.getAttribute("data-agent-state")).toBe("directing");
    expect(announcer.textContent).toBe("Assistant is directing");
  });

  it("announces nothing for idle, completed, or exited states", () => {
    for (const state of ["idle", "completed", "exited"]) {
      setupTerminalWithState(state);
      const { getByTestId, unmount } = render(<HelpPanel width={380} />);
      expect(getByTestId("assistant-header-state-announcer").textContent).toBe("");
      unmount();
    }
  });

  it("announces nothing before any assistant terminal exists", () => {
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    panelStoreState.panelsById = {};

    const { getByTestId } = render(<HelpPanel width={380} />);
    expect(getByTestId("assistant-header-state-announcer").textContent).toBe("");
  });

  it("keeps the live region mounted so a transition is announced rather than inserted", () => {
    // A `role="status"` that only appears once there is something to say is added to the
    // DOM at the same moment its content is, and a live region added and populated in one
    // pass is not reliably announced. It has to be there first, empty.
    setupTerminalWithState("idle");
    const { getByTestId } = render(<HelpPanel width={380} />);
    expect(getByTestId("assistant-header-state-announcer")).not.toBeNull();
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

    // The restart control moved from a header "+" into the overflow menu, where it is
    // named for the conversation it discards.
    const restartBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Restart conversation")
    )!;
    expect(restartBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(restartBtn);
    });

    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1", 0);
  });
});

describe("HelpPanel — cold-view lane restore (#12108)", () => {
  it("recreates a tab for every lane holding an eviction-captured conversation", async () => {
    // A cold view knows only slot 0, so lanes 1+ would have no tab to reach
    // their captured conversations from even though the entries are on disk.
    helpPanelState.terminalId = null;
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockListPendingHibernationSlots.mockResolvedValue([0, 2]);

    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    expect(mockListPendingHibernationSlots).toHaveBeenCalledWith("proj-1");
    expect(helpPanelState.ensureSlot).toHaveBeenCalledWith(0);
    expect(helpPanelState.ensureSlot).toHaveBeenCalledWith(2);
    // Recreating a background lane must not start (or bill) it — the restored
    // tab lands on its own Resume CTA and waits for the user. (Slot 0 is the
    // visible lane and follows the ordinary auto-launch consent path.)
    expect(mockProvisionSession).not.toHaveBeenCalledWith(expect.objectContaining({ slot: 2 }));
  });

  it("does not recreate lanes for a view that already holds a live session", async () => {
    helpPanelState.terminalId = "term-live";
    helpPanelState.agentId = "claude";
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj-1" };
    mockListPendingHibernationSlots.mockResolvedValue([1]);

    await act(async () => {
      render(<HelpPanel width={380} />);
    });
    await flushAsyncWork();

    expect(mockListPendingHibernationSlots).not.toHaveBeenCalled();
    expect(helpPanelState.ensureSlot).not.toHaveBeenCalled();
  });
});
