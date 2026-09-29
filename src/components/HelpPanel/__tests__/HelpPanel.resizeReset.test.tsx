// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The assistant's resize handle resets like every other resizable edge in the
// app: double-click (and Enter/Space from the keyboard) returns the panel to
// its default width through the same persisted store action a drag uses.

const { setFocusedMock, focusMock, helpPanelState, panelStoreState } = vi.hoisted(() => ({
  setFocusedMock: vi.fn(),
  focusMock: vi.fn(),
  helpPanelState: {
    clearDroppedPreferredAgent: vi.fn(),
    setAutoLaunchEnabled: vi.fn(),
    requestFocus: vi.fn(),
    setActiveFigureNumber: vi.fn(),
    addFigure: vi.fn(),
    setActiveSlot: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    // #12108: the panel reads its lane pointer; the mocked selectors
    // above project this same flat object as that lane.
    activeSlot: 0,
    sessions: {} as Record<number, unknown>,
    isOpen: true,
    width: 380,
    terminalId: "t-1" as string | null,
    agentId: "claude" as string | null,
    preferredAgentId: null as string | null,
    sessionId: null as string | null,
    introDismissed: true,
    conversationTouched: false,
    hibernateSessions: {} as Record<string, unknown>,
    focusRequest: 0,
    figures: [] as unknown[],
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
    panelIds: ["t-1"] as string[],
    panelsById: {
      "t-1": { agentState: "idle", cwd: "/repo", spawnStatus: "ready" },
    } as Record<string, { agentState?: string; cwd?: string; spawnStatus?: string }>,
    removePanel: vi.fn(),
    addPanel: vi.fn().mockResolvedValue(""),
  },
}));

const snapshot = {
  showResumeBanner: false,
  tierMismatch: null,
  isApprovingTier: false,
  assistantVersionTooOld: null,
};

// Pass-through dropdown mock (same shape as PanelHeader.test.tsx) — keeps the
// header's lazily-loaded Radix overflow menu (and its actionService import
// chain) out of this suite's module graph.
// Passthrough tooltips: the footer's Radix provider is incidental to these
// suites, and its unmount timers collide with their stubbed globals.
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: unknown }) => children,
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: () => null,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <div data-testid="overflow-menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children?: ReactNode;
    onSelect?: (e: Event) => void;
    destructive?: boolean;
  }) => (
    <button type="button" onClick={() => onSelect?.(new Event("select"))}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/controllers/HelpSessionController", () => ({
  HelpSessionController: class {
    start = vi.fn();
    stop = vi.fn();
    subscribe = (_cb: () => void) => () => {};
    getSnapshot = () => snapshot;
    syncInputs = vi.fn();
    handleTerminalPanelMissing = vi.fn();
    handleAgentExited = vi.fn();
    selectAgent = vi.fn();
    newSession = vi.fn();
    runAnyway = vi.fn();
    dismissResumeBanner = vi.fn();
    dismissTierMismatch = vi.fn();
    approveTierOnce = vi.fn();
    alwaysAllowTier = vi.fn();
  },
}));

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));
vi.mock("@/components/icons/DaintreeIcon", () => ({ DaintreeIcon: () => null }));
vi.mock("@/components/Terminal/XtermAdapter", () => ({
  XtermAdapter: () => <div data-testid="xterm-adapter" />,
}));
vi.mock("@/components/Terminal/HybridInputBar", () => ({ HybridInputBar: () => null }));
vi.mock("@/components/Terminal/MissingCliGate", () => ({ MissingCliGate: () => null }));
vi.mock("@/components/Terminal/terminalFocus", async (importOriginal) => {
  // Keep the real `getTerminalFocusTarget` — the reveal effect resolves the
  // remembered target through it, and a hand-stubbed copy would drift.
  const actual = await importOriginal<typeof import("@/components/Terminal/terminalFocus")>();
  return { ...actual, shouldShowHybridInputBar: () => false };
});
vi.mock("./HelpIntroBanner", () => ({ HelpIntroBanner: () => null }));
vi.mock("./HelpPanelHeader", () => ({ HelpPanelHeader: () => null }));
vi.mock("./HelpPanelBanners", () => ({ HelpPanelBanners: () => null }));
vi.mock("./HelpPanelVersionGate", () => ({ HelpPanelVersionGate: () => null }));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    focus: (...args: unknown[]) => focusMock(...args),
    setFocused: (...args: unknown[]) => setFocusedMock(...args),
    notifyUserInput: vi.fn(),
    repaintForReveal: vi.fn(),
  },
}));
vi.mock("@/clients", () => ({ terminalClient: { submit: vi.fn(), sendKey: vi.fn() } }));
vi.mock("@shared/config/agentIds", () => ({
  BUILT_IN_AGENT_IDS: ["claude", "codex", "claude-code"] as const,
  ASSISTANT_ONLY_AGENT_IDS: [] as const,
  LAUNCHABLE_AGENT_IDS: ["claude", "codex", "claude-code"] as const,
  isBuiltInAgentId: (v: unknown): v is string =>
    typeof v === "string" && ["claude", "codex", "claude-code"].includes(v),
  isAssistantOnlyAgentId: () => false,
}));
vi.mock("../../../shared/utils/agentAvailability", () => ({ isAgentInstalled: () => true }));
vi.mock("@/lib/accessibility", () => ({ TABBABLE_SELECTOR: "button" }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(), getContext: () => ({}) },
}));
vi.mock("@/lib/sidebarToggle", () => ({ suppressSidebarResizes: vi.fn() }));
vi.mock("@/hooks/useEscapeStack", () => ({ useEscapeStack: vi.fn() }));
vi.mock("@/types", () => ({ TerminalRefreshTier: { BACKGROUND: 0, ACTIVE: 1 } }));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) =>
    ({
      claude: { name: "Claude", icon: () => null },
      codex: { name: "Codex", icon: () => null },
      "claude-code": { name: "Claude Code", icon: () => null },
    })[id],
  getAssistantSupportedAgentIds: () => ["claude", "codex", "claude-code"],
}));

vi.mock("@/store/helpPanelStore", () => {
  const store = (selector?: (s: typeof helpPanelState) => unknown) =>
    selector ? selector(helpPanelState) : helpPanelState;
  store.getState = () => helpPanelState;
  return {
    useHelpPanelStore: store,
    HELP_PANEL_MIN_WIDTH: 320,
    HELP_PANEL_MAX_WIDTH: 800,
    HELP_PANEL_DEFAULT_WIDTH: 380,
    // #12108 selectors. Fixtures stay flat, so these project the same object
    // as the lane and every existing assertion keeps working.
    selectSlot: (s: typeof helpPanelState) => s,
    selectActiveSlot: (s: typeof helpPanelState) => s,
    selectOpenSlots: () => [0],
    selectSlotTerminalIds: (s: typeof helpPanelState) => (s.terminalId ? [s.terminalId] : []),
    selectSlotForTerminal: (s: typeof helpPanelState, id: string) =>
      s.terminalId === id && id ? 0 : null,
  };
});

vi.mock("@/store", () => {
  const panelStore = (selector?: (s: typeof panelStoreState) => unknown) =>
    selector ? selector(panelStoreState) : panelStoreState;
  panelStore.getState = () => panelStoreState;

  const cliState = {
    availability: { claude: "ready", codex: "ready", "claude-code": "ready" } as Record<
      string,
      string
    >,
    isInitialized: true,
    hasRealData: true,
    details: {} as Record<string, unknown>,
  };
  const cliStore = (selector?: (s: typeof cliState) => unknown) =>
    selector ? selector(cliState) : cliState;
  cliStore.getState = () => cliState;

  const projectState = { currentProject: { id: "proj-1", path: "/repo" } };
  const projectStore = (selector?: (s: typeof projectState) => unknown) =>
    selector ? selector(projectState) : projectState;
  projectStore.getState = () => projectState;

  const worktreeState = { activeWorktreeId: null as string | null };
  const worktreeStore = (selector?: (s: typeof worktreeState) => unknown) =>
    selector ? selector(worktreeState) : worktreeState;
  worktreeStore.getState = () => worktreeState;

  const terminalInputState = { hybridInputEnabled: false };
  const terminalInputStore = (selector?: (s: typeof terminalInputState) => unknown) =>
    selector ? selector(terminalInputState) : terminalInputState;
  terminalInputStore.getState = () => terminalInputState;

  return {
    usePanelStore: panelStore,
    useCliAvailabilityStore: cliStore,
    useProjectStore: projectStore,
    useWorktreeSelectionStore: worktreeStore,
    useTerminalInputStore: terminalInputStore,
    getTerminalRefreshTier: () => 0,
  };
});

vi.mock("@/store/macroFocusStore", () => {
  const state = { focusedRegion: null as string | null, setRegionRef: vi.fn() };
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

vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("../FigureRail", () => ({ FigureRail: () => null }));

import { HelpPanel } from "../HelpPanel";
import { __resetHelpSessionControllersForTests } from "@/controllers/helpSessionControllerRegistry";

beforeEach(() => {
  // #12108: controllers live in a per-view registry, not component
  // state, so they outlive a render and must be reset between tests.
  __resetHelpSessionControllersForTests();
  setFocusedMock.mockClear();
  focusMock.mockClear();

  helpPanelState.isOpen = true;
  helpPanelState.width = 520;
  helpPanelState.setWidth.mockClear();
  helpPanelState.terminalId = "t-1";
  helpPanelState.agentId = "claude";
  helpPanelState.preferredAgentId = null;
  helpPanelState.conversationTouched = false;
  panelStoreState.panelIds = ["t-1"];
  panelStoreState.panelsById = {
    "t-1": { agentState: "idle", cwd: "/repo", spawnStatus: "ready" },
  };

  // Assign the bridge rather than replacing `window`: the drag path needs the
  // real window's event listeners.
  Object.defineProperty(window, "electron", {
    value: {
      help: { getPinnedActionContext: vi.fn().mockResolvedValue({}) },
      app: { onViewRevealed: () => () => {} },
    },
    writable: true,
    configurable: true,
  });
});

function getHandle(): HTMLElement {
  return screen.getByTestId("help-panel-resize");
}

describe("HelpPanel — resize handle reset", () => {
  it("resets to the default width on double-click", () => {
    render(<HelpPanel width={520} />);
    fireEvent.doubleClick(getHandle());
    expect(helpPanelState.setWidth).toHaveBeenLastCalledWith(380);
  });

  it.each(["Enter", " "])("resets to the default width on %j", (key) => {
    render(<HelpPanel width={520} />);
    fireEvent.keyDown(getHandle(), { key });
    expect(helpPanelState.setWidth).toHaveBeenLastCalledWith(380);
  });

  it("persists a reset through the same store action a drag uses", () => {
    render(<HelpPanel width={520} />);
    const handle = getHandle();
    fireEvent.mouseDown(handle, { button: 0, clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 460 });
    fireEvent.mouseUp(document);
    const dragWrites = helpPanelState.setWidth.mock.calls.length;
    expect(dragWrites).toBeGreaterThan(0);
    fireEvent.doubleClick(handle);
    expect(helpPanelState.setWidth.mock.calls.length).toBe(dragWrites + 1);
    expect(helpPanelState.setWidth).toHaveBeenLastCalledWith(380);
  });

  it("advertises the reset in the handle's accessible name", () => {
    render(<HelpPanel width={520} />);
    expect(getHandle().getAttribute("aria-label")).toMatch(/double-click to reset/i);
  });
});
