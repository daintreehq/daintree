// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for #10863: the Daintree Assistant must NOT run its own
// reveal-repaint cascade. The project-level reveal sweep
// (`repaintActiveWorktreeTerminals`) already folds the Assistant terminal into
// its targets (#9637) and is the sole owner of the reveal repaint. A second
// per-frame/timed cascade in HelpPanel raced the shared sweep's reconcile
// against live PTY output and corrupted xterm's line-wrap metadata (duplicated /
// garbled output on reveal). This asserts HelpPanel never calls repaintForReveal
// on `app:view-revealed` or on any timed backstop.

const { repaintForRevealMock, helpPanelState, panelStoreState } = vi.hoisted(() => ({
  repaintForRevealMock: vi.fn(),
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
    terminalId: null as string | null,
    agentId: null as string | null,
    // "claude" rather than null: these suites exercise the PTY LAUNCH path, and the
    // Daintree Assistant is now the default surface when no agent is chosen — a null
    // preference renders the native panel and never launches a terminal at all. Naming
    // a terminal-backed agent keeps each test about the thing it is testing.
    preferredAgentId: "claude" as string | null,
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
    panelIds: [] as string[],
    panelsById: {} as Record<string, { agentState?: string; cwd?: string; spawnStatus?: string }>,
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

vi.mock("@/controllers/HelpSessionController", () => ({
  HelpSessionController: class {
    start = vi.fn();
    stop = vi.fn();
    subscribe = (_cb: () => void) => () => {};
    getSnapshot = () => snapshot;
    syncInputs = vi.fn();
    handleTerminalPanelMissing = vi.fn();
    handleAgentExited = vi.fn();
    handleViewRevealed = vi.fn();
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
    focus: vi.fn(),
    setFocused: vi.fn(),
    notifyUserInput: vi.fn(),
    repaintForReveal: (...args: unknown[]) => repaintForRevealMock(...args),
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

// rAF mock: drive the bounded reveal poll synchronously per flushed frame.
const rafQueue = new Map<number, FrameRequestCallback>();
let rafIdCounter = 0;
function flushFrame(): void {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of pending) cb(0);
}

// The real `onViewRevealed` supports multiple listeners; HelpPanel registers two
// (the launch-recovery effect and this repaint effect), so the mock must fan out
// to all of them rather than keep only the last-registered slot.
let viewRevealedCbs: Array<() => void> = [];

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  // #12108: controllers live in a per-view registry, not component
  // state, so they outlive a render and must be reset between tests.
  __resetHelpSessionControllersForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  rafQueue.clear();
  rafIdCounter = 0;
  repaintForRevealMock.mockClear();
  viewRevealedCbs = [];

  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = ++rafIdCounter;
    rafQueue.set(id, cb);
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number): void => {
    rafQueue.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;

  setVisibilityState("visible");

  helpPanelState.isOpen = true;
  helpPanelState.terminalId = "t-1";
  helpPanelState.agentId = "claude";
  helpPanelState.preferredAgentId = null;
  helpPanelState.conversationTouched = false;
  panelStoreState.panelIds = ["t-1"];
  panelStoreState.panelsById = {
    "t-1": { agentState: "idle", cwd: "/repo", spawnStatus: "ready" },
  };

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
          onSequenceGap: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
        },
        help: { getPinnedActionContext: vi.fn().mockResolvedValue({}) },
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
});

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
  vi.useRealTimers();
});

// The reveal poll's tick runs on a frame; flush one frame to let the width-gated
// repaint land.
function fireReveal(): void {
  act(() => {
    for (const cb of viewRevealedCbs) cb();
  });
  act(() => flushFrame());
}

describe("HelpPanel — Daintree Assistant reveal (no local repaint cascade, #10863)", () => {
  it("does not repaint on `app:view-revealed` — the shared sweep owns reveal repaint", () => {
    render(<HelpPanel width={380} />);
    // HelpPanel still subscribes to onViewRevealed for launch-stall recovery
    // (#10739), so a listener exists — but it must never drive repaintForReveal.
    expect(viewRevealedCbs.length).toBeGreaterThan(0);
    repaintForRevealMock.mockClear();

    fireReveal();
    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });

  it("never arms a timed repaint backstop after reveal", () => {
    render(<HelpPanel width={380} />);
    repaintForRevealMock.mockClear();

    fireReveal();
    // Advance well past the old 1s/3s backstop cadence and flush every frame —
    // a reintroduced local cascade would fire here.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    act(() => flushFrame());
    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });

  it("stays quiet across repeated reveals (no cascade to stack)", () => {
    render(<HelpPanel width={380} />);
    repaintForRevealMock.mockClear();

    fireReveal();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireReveal();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    act(() => flushFrame());
    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });
});
