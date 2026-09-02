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
    sessions: {} as Record<number, Record<string, unknown>>,
    // #12108: which lanes the tab strip renders. Stays [0] for every
    // single-lane case; the parallel-lane suite below widens it.
    openSlots: [0] as number[],
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

/**
 * The control that discards the conversation in the lane on screen and starts a fresh
 * one in the same slot.
 *
 * It used to be a "+" in the header, which sat directly above the strip's own "+" — one
 * of them opened a session and the other threw one away. It is now a named item in the
 * overflow menu, beside the other destructive action, and the tests find it by that name.
 */
function restartConversationButton(container: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Restart conversation")
    ) ?? null
  );
}

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
    // The active lane is the flat fixture; a background lane comes from
    // `sessions[slot]`, which only the parallel-lane suite populates.
    selectSlot: (s: typeof helpPanelState, slot: number) =>
      slot === s.activeSlot ? s : ((s.sessions[slot] as typeof s) ?? s),
    selectActiveSlot: (s: typeof helpPanelState) => s,
    selectOpenSlots: (s: typeof helpPanelState) => s.openSlots,
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

/**
 * The native panel, stubbed down to the two props these suites read.
 *
 * Inert for every PTY suite in this file — they reset to a terminal-backed agent, so
 * no native lane is ever open — and it keeps the real one's engine start, its 94KB of
 * transcript view and its `window.electron` reach out of a harness that models none of
 * them. `restartNonce` is recorded because it is the only observable of a native
 * restart: there is no controller call to spy on, the whole act is a nonce the lane's
 * session effect depends on.
 */
const nativePanelProps: Array<{ slot: number; active: boolean; restartNonce: number }> = [];
vi.mock("@/components/AssistantPanel", () => ({
  AssistantPanel: (props: { slot?: number; active: boolean; restartNonce?: number }) => {
    nativePanelProps.push({
      slot: props.slot ?? 0,
      active: props.active,
      restartNonce: props.restartNonce ?? 0,
    });
    return <div data-testid={`native-lane-${props.slot ?? 0}`} />;
  },
}));

import { HelpPanel } from "../HelpPanel";
import { assistantStoreForSlot, releaseAssistantStore } from "@/store/assistantStore";
import {
  __resetHelpSessionControllersForTests,
  acquireHelpSessionController,
} from "@/controllers/helpSessionControllerRegistry";

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
  helpPanelState.sessions = {};
  helpPanelState.openSlots = [0];
  helpPanelState.activeSlot = 0;
  helpPanelState.closeSlot = vi.fn();
  helpPanelState.openSlot = vi.fn();
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

  it("offers no restart when there is no live terminal to restart", () => {
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    const { container } = render(<HelpPanel width={380} />);
    expect(restartConversationButton(container)).toBeNull();
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
      fireEvent.click(restartConversationButton(container)!);
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
      0,
      "terminal-fresh",
      "claude",
      "sess-fresh"
    );
  });

  it("shows the confirm dialog when the agent is working", () => {
    setupBoundTerminal({ agentState: "working", conversationTouched: false });

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(restartConversationButton(container)!);

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
    expect(getByTestId("dialog-title").textContent).toBe("Restart this conversation?");
    expect(getByTestId("dialog-confirm").textContent).toBe("Restart conversation");
    expect(getByTestId("dialog-description").textContent).toContain(
      "the conversation will be discarded"
    );
  });

  it("shows the confirm dialog when the conversation has been touched", () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: true });

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(restartConversationButton(container)!);

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(getByTestId("dialog-title").textContent).toBe("Restart this conversation?");
  });

  it("keeps the session intact when the user cancels the confirm dialog", () => {
    setupBoundTerminal({ agentState: "working" });

    const { container, getByTestId, queryByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(restartConversationButton(container)!);
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
    fireEvent.click(restartConversationButton(container)!);
    await act(async () => {
      fireEvent.click(getByTestId("dialog-confirm"));
    });

    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(mockRevokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      0,
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
      fireEvent.click(restartConversationButton(container)!);
    });

    // Pre-set already fired with the same id we passed as requestedId.
    const capturedRequestedId = (
      mockDispatch.mock.calls[0]?.[1] as { requestedId?: string } | undefined
    )?.requestedId;
    expect(capturedRequestedId).toMatch(/^terminal-/);
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(0, capturedRequestedId, "claude", null);

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
      fireEvent.click(restartConversationButton(container)!);
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
      fireEvent.click(restartConversationButton(container)!);
    });

    // setTerminal called once (pre-set), then clearTerminal reverted it on !ok.
    // setTerminal must NOT be called again with a session id.
    const setCalls = (helpPanelState.setTerminal as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls.length).toBe(1);
    expect(setCalls[0]?.[3]).toBeNull();
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
      fireEvent.click(restartConversationButton(container)!);
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
      .mockImplementation((_slot: number, tId: string, aId: string, sId: string | null) => {
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
      fireEvent.click(restartConversationButton(container)!);
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
      fireEvent.click(restartConversationButton(container)!);
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
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1", 0);
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
    expect(helpPanelState.clearHibernateSession).toHaveBeenCalledWith("proj-1", 0);
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
      fireEvent.click(restartConversationButton(container)!);
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
    expect(helpPanelState.setTerminal).not.toHaveBeenCalledWith(
      0,
      reservedId,
      "claude",
      "sess-fresh"
    );
    expect(panelStoreState.removePanel).toHaveBeenCalledWith(reservedId);
  });
});

describe("HelpPanel — closing one parallel lane (#12108)", () => {
  // Two live lanes: slot 0 on screen (the flat fixture) and slot 1 behind the
  // tab strip. `sessions` is what the close path and the per-lane state marker
  // read, so both lanes have to appear there.
  function setupTwoLanes(opts: { backgroundAgentState?: string } = {}) {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = "sess-front";
    helpPanelState.activeSlot = 0;
    helpPanelState.openSlots = [0, 1];
    helpPanelState.sessions = {
      0: {
        terminalId: "term-1",
        agentId: "claude",
        sessionId: "sess-front",
        conversationTouched: false,
        figures: [],
        activeFigureNumber: null,
      },
      1: {
        terminalId: "term-2",
        agentId: "claude",
        sessionId: "sess-back",
        conversationTouched: false,
        figures: [],
        activeFigureNumber: null,
      },
    };
    panelStoreState.panelsById = {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
        agentState: "idle",
      },
      "term-2": {
        id: "term-2",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
        agentState: opts.backgroundAgentState ?? "idle",
      },
    };
  }

  // Found by `title` rather than `aria-label`: the close control is pointer-only and
  // `aria-hidden`, because a focusable control beside a `tab` is what makes a roving
  // tabindex impossible and would leave a stray non-`tab` child in the tablist. The
  // keyboard route is Delete on the focused tab, covered in HelpSessionTabs.test.tsx.
  function closeButtonFor(container: HTMLElement, label: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`button[title="Close ${label}"]`);
    if (!button) throw new Error(`no close button for ${label}`);
    return button;
  }

  it("labels lanes by durable slot and names the body after the selected tab", () => {
    // Sparse slots on purpose: lanes 0 and 2 with 1 closed. Position-based labels would
    // read "Session 1 / Session 2" here and rename a live conversation; slot-based ones
    // leave a gap that `openSlot` closes on its own. The strip's own tests build labels
    // themselves, so this is the only place HelpPanel's rule is actually exercised.
    setupTwoLanes();
    helpPanelState.openSlots = [0, 2];
    helpPanelState.sessions = {
      0: helpPanelState.sessions[0]!,
      2: { ...helpPanelState.sessions[1]!, terminalId: "term-3", sessionId: "sess-third" },
    };
    delete helpPanelState.sessions[1];
    panelStoreState.panelsById["term-3"] = {
      ...panelStoreState.panelsById["term-2"]!,
      id: "term-3",
    };

    const { container } = render(<HelpPanel width={380} />);
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));

    expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual(["Session 1", "Session 3"]);
    expect(new Set(tabs.map((t) => t.id)).size).toBe(2);

    const body = container.querySelector('[role="tabpanel"]')!;
    expect(body.getAttribute("aria-labelledby")).toBe(tabs[0]!.id);
    expect(tabs[0]!.getAttribute("aria-controls")).toBe(body.id);

    fireEvent.click(tabs[1]!);
    expect(helpPanelState.setActiveSlot).toHaveBeenCalledWith(2);
  });

  it("tears down only the closed lane and leaves the panel open on the survivor", () => {
    setupTwoLanes();
    const survivor = acquireHelpSessionController(0);
    const closing = acquireHelpSessionController(1);

    const { container } = render(<HelpPanel width={380} />);
    fireEvent.click(closeButtonFor(container, "Session 2"));

    // The closed lane's backend is gone…
    expect(mockRevokeSession).toHaveBeenCalledWith("sess-back");
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-2");
    expect(helpPanelState.closeSlot).toHaveBeenCalledWith(1);
    // …its controller was released, so a later acquire mints a fresh one…
    expect(acquireHelpSessionController(1)).not.toBe(closing);
    // …while the surviving lane keeps its running session AND its controller…
    expect(mockRevokeSession).not.toHaveBeenCalledWith("sess-front");
    expect(panelStoreState.removePanel).not.toHaveBeenCalledWith("term-1");
    expect(acquireHelpSessionController(0)).toBe(survivor);
    // …and the sidebar does not slide shut on it (#12108).
    expect(helpPanelState.setOpen).not.toHaveBeenCalledWith(false);
  });

  it("confirms before closing a lane whose agent is working, gated on THAT lane", () => {
    setupTwoLanes({ backgroundAgentState: "working" });

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(closeButtonFor(container, "Session 2"));

    // Nothing torn down until the user answers.
    expect(mockRevokeSession).not.toHaveBeenCalled();
    expect(helpPanelState.closeSlot).not.toHaveBeenCalled();
    expect(getByTestId("dialog-title").textContent).toBe("Close Session 2?");
    expect(getByTestId("dialog-confirm").textContent).toBe("Close session");
    expect(getByTestId("dialog-description").textContent).toContain(
      "the conversation will be discarded"
    );

    fireEvent.click(getByTestId("dialog-confirm"));
    expect(mockRevokeSession).toHaveBeenCalledWith("sess-back");
    expect(helpPanelState.closeSlot).toHaveBeenCalledWith(1);
  });

  it("keeps the lane when the close confirm is cancelled", () => {
    setupTwoLanes({ backgroundAgentState: "working" });

    const { container, getByTestId, queryByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(closeButtonFor(container, "Session 2"));
    fireEvent.click(getByTestId("dialog-cancel"));

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(mockRevokeSession).not.toHaveBeenCalled();
    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.closeSlot).not.toHaveBeenCalled();
  });
});

/**
 * The native assistant's destructive controls (#12108).
 *
 * "+ New session" and "Stop assistant" discard a conversation exactly as their PTY
 * counterparts do, and for a long time they were the only two that did it in one click:
 * both branches returned before reaching the gate, under a comment that said the gate
 * was the point. The transcript lives only in the lane's own store, so "something to
 * lose" is whether anything has been said in it — the same test the tab's own close
 * already applied, which is what made the omission visible.
 */
describe("HelpPanel — the native assistant's destructive controls", () => {
  function nativeMode() {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    // No bound terminal and no preference: the panel's default, which is native.
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    helpPanelState.preferredAgentId = null;
  }

  function seedConversation() {
    assistantStoreForSlot(0).getState().reset("ses_native");
    assistantStoreForSlot(0).getState().appendUserTurn("something worth keeping");
  }

  function queryStopItem(container: HTMLElement): HTMLButtonElement | null {
    return (
      [
        ...container.querySelectorAll<HTMLButtonElement>("[data-testid='overflow-menu'] button"),
      ].find((b) => b.textContent?.includes("Stop assistant")) ?? null
    );
  }

  afterEach(() => {
    releaseAssistantStore(0);
    nativePanelProps.length = 0;
  });

  it("keeps a running native lane when the agent preference changes", () => {
    nativeMode();
    const { rerender } = render(<HelpPanel width={380} />);
    // Armed by opening the panel — which is the only record that this lane took the
    // native path, because a native lane never launches a terminal and so never binds
    // an agent id.
    expect(nativePanelProps.at(-1)?.active).toBe(true);

    nativePanelProps.length = 0;
    helpPanelState.preferredAgentId = "claude";
    act(() => {
      rerender(<HelpPanel width={380} />);
    });

    // Read through the global preference alone, an unbound native lane reclassifies to a
    // terminal the moment that preference moves — its panel unmounts and its engine
    // stops through the same cleanup a project switch uses. The user changed a setting;
    // they did not ask to end the conversation they were having.
    expect(nativePanelProps.at(-1)?.active).toBe(true);
  });

  it("converts the lane on screen when the agent preference moves to a terminal agent", () => {
    nativeMode();
    helpPanelState.openSlots = [0, 1];
    helpPanelState.activeSlot = 0;
    const { rerender } = render(<HelpPanel width={380} />);
    // Both lanes armed native by the panel opening on each of them in turn.
    helpPanelState.activeSlot = 1;
    act(() => {
      rerender(<HelpPanel width={380} />);
    });
    helpPanelState.activeSlot = 0;
    act(() => {
      rerender(<HelpPanel width={380} />);
    });
    expect(nativePanelProps.filter((p) => p.slot === 1).at(-1)?.active).toBe(true);

    helpPanelState.preferredAgentId = "claude";
    act(() => {
      rerender(<HelpPanel width={380} />);
    });

    // Lane 0 — the one on screen — follows the choice and leaves the native set
    // entirely: #8353's contract is that picking another agent replaces the live
    // session rather than silently doing nothing.
    expect(document.querySelector('[data-testid="native-lane-0"]')).toBe(null);
    // Lane 1 is still mounted and still armed. The user changed a setting while looking
    // at another tab; that is not an instruction to end this conversation.
    expect(document.querySelector('[data-testid="native-lane-1"]')).not.toBe(null);
    expect(nativePanelProps.filter((p) => p.slot === 1).at(-1)?.active).toBe(true);
  });

  it("asks before a new session discards a native conversation", () => {
    nativeMode();
    seedConversation();
    const { container, getByTestId } = render(<HelpPanel width={380} />);
    nativePanelProps.length = 0;

    fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);

    expect(getByTestId("dialog-title").textContent).toBe("Start a new session?");
    // And nothing has happened yet: the restart is a nonce bump, so an unasked restart
    // shows up as the lane re-rendering with a higher one.
    expect(nativePanelProps.every((p) => p.restartNonce === 0)).toBe(true);
  });

  it("restarts the lane once the new session is confirmed", () => {
    nativeMode();
    seedConversation();
    const { container, getByTestId } = render(<HelpPanel width={380} />);

    fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    nativePanelProps.length = 0;
    act(() => {
      fireEvent.click(getByTestId("dialog-confirm"));
    });

    expect(nativePanelProps.some((p) => p.slot === 0 && p.restartNonce === 1)).toBe(true);
  });

  it("starts a new session without asking when nothing has been said", () => {
    nativeMode();
    const { container, queryByTestId } = render(<HelpPanel width={380} />);
    nativePanelProps.length = 0;

    act(() => {
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    });

    // An empty lane has nothing to lose, so the confirm would be pure friction.
    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(nativePanelProps.some((p) => p.slot === 0 && p.restartNonce === 1)).toBe(true);
  });

  it("asks before Stop discards a native conversation, and disarms once confirmed", () => {
    nativeMode();
    seedConversation();
    const { container, getByTestId } = render(<HelpPanel width={380} />);
    const stop = queryStopItem(container);
    expect(stop).not.toBe(null);

    fireEvent.click(stop!);
    expect(getByTestId("dialog-title").textContent).toBe("Stop assistant?");
    // Still armed — the engine must not go before the answer does.
    expect(nativePanelProps.at(-1)?.active).toBe(true);

    nativePanelProps.length = 0;
    act(() => {
      fireEvent.click(getByTestId("dialog-confirm"));
    });
    // Disarming is what stops the engine: the lane re-renders inactive, and its own
    // effect cleanup detaches from there.
    expect(nativePanelProps.at(-1)?.active).toBe(false);
  });

  it("asks before Stop interrupts a lane that is working with nothing said yet", () => {
    nativeMode();
    // A wake's first phase arrives BEFORE its turn opens, so the lane is genuinely
    // working while `turns` is still empty. A transcript-only test waved this through
    // and stopped an engine mid-flight without a word.
    assistantStoreForSlot(0).getState().reset("ses_native");
    assistantStoreForSlot(0).getState().applyEvent({
      type: "turn:phase",
      sessionId: "ses_native",
      seq: 2,
      phase: "Waking",
      wake: true,
    });
    const { container, getByTestId } = render(<HelpPanel width={380} />);

    fireEvent.click(queryStopItem(container)!);
    expect(getByTestId("dialog-title").textContent).toBe("Stop assistant?");
  });

  it("stops without asking when nothing has been said", () => {
    nativeMode();
    const { container, queryByTestId } = render(<HelpPanel width={380} />);
    act(() => {
      fireEvent.click(queryStopItem(container)!);
    });
    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(nativePanelProps.at(-1)?.active).toBe(false);
  });
});
