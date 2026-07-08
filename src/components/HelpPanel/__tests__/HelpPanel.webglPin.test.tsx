// @vitest-environment jsdom
import { render, act, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression for #10672: the Daintree Assistant terminal couldn't regain a
// WebGL context when the fleet was in DOM mode (context count at cap). The
// panel only ever called `terminalInstanceService.focus()` (xterm DOM focus),
// never `setFocused()` — the sole service path that pins the WebGL context via
// `webGLManager.pinFocus()`. These tests assert the panel now routes its focus
// state through `setFocused`, and that a closed / hidden / blurred panel never
// claims the pin.

const { setFocusedMock, focusMock, helpPanelState, panelStoreState } = vi.hoisted(() => ({
  setFocusedMock: vi.fn(),
  focusMock: vi.fn(),
  helpPanelState: {
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
vi.mock("@/components/Terminal/terminalFocus", () => ({
  shouldShowHybridInputBar: () => false,
}));
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
  return { useHelpPanelStore: store, HELP_PANEL_MIN_WIDTH: 320, HELP_PANEL_MAX_WIDTH: 800 };
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
  return { useMacroFocusStore: store };
});

vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("../FigureRail", () => ({ FigureRail: () => null }));

import { HelpPanel } from "../HelpPanel";

function getAside(): HTMLElement {
  const aside = document.getElementById("daintree-assistant-panel");
  if (!aside) throw new Error("assistant aside not found");
  return aside;
}

// Only the `setFocused(id, true)` calls — pin acquisition — matter for the bug.
function pinCalls(): unknown[][] {
  return setFocusedMock.mock.calls.filter((c) => c[1] === true);
}

beforeEach(() => {
  setFocusedMock.mockClear();
  focusMock.mockClear();

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
        help: { getPinnedActionContext: vi.fn().mockResolvedValue({}) },
        app: { onViewRevealed: () => () => {} },
      },
    },
    writable: true,
    configurable: true,
  });
});

describe("HelpPanel — WebGL focus pin wiring (#10672)", () => {
  it("does not pin the assistant terminal while it lacks DOM focus", () => {
    render(<HelpPanel width={380} />);
    // Open + visible but never focused: the panel must not claim the pin.
    expect(pinCalls()).toHaveLength(0);
  });

  it("pins the assistant terminal when DOM focus lands inside the open panel", () => {
    render(<HelpPanel width={380} />);
    act(() => {
      fireEvent.focus(getAside());
    });
    expect(pinCalls()).toContainEqual(["t-1", true]);
  });

  it("releases the pin (setFocused false) when focus leaves the panel", () => {
    render(<HelpPanel width={380} />);
    act(() => {
      fireEvent.focus(getAside());
    });
    setFocusedMock.mockClear();
    act(() => {
      // relatedTarget outside the aside → real blur, not an inside-panel hop.
      fireEvent.blur(getAside(), { relatedTarget: document.body });
    });
    expect(setFocusedMock).toHaveBeenCalledWith("t-1", false);
    expect(pinCalls()).toHaveLength(0);
  });

  it("does not pin a hidden-but-mounted panel even when focused", () => {
    render(<HelpPanel width={0} isVisible={false} />);
    act(() => {
      fireEvent.focus(getAside());
    });
    expect(pinCalls()).toHaveLength(0);
  });

  it("releases the pin when the panel closes", () => {
    const { rerender } = render(<HelpPanel width={380} />);
    act(() => {
      fireEvent.focus(getAside());
    });
    expect(pinCalls()).toContainEqual(["t-1", true]);

    setFocusedMock.mockClear();
    helpPanelState.isOpen = false;
    rerender(<HelpPanel width={380} />);
    expect(setFocusedMock).toHaveBeenCalledWith("t-1", false);
    expect(pinCalls()).toHaveLength(0);
  });

  it("no-ops when there is no assistant terminal", () => {
    helpPanelState.terminalId = null;
    panelStoreState.panelIds = [];
    panelStoreState.panelsById = {};
    render(<HelpPanel width={380} />);
    act(() => {
      fireEvent.focus(getAside());
    });
    expect(setFocusedMock).not.toHaveBeenCalled();
  });

  it("releases the pin when the panel collapses to zero width without a blur", () => {
    // A width collapse can tear down the focused descendant (xterm) without
    // firing a blur — the !isVisible guard must still drop the pin.
    const { rerender } = render(<HelpPanel width={380} />);
    act(() => {
      fireEvent.focus(getAside());
    });
    expect(pinCalls()).toContainEqual(["t-1", true]);

    setFocusedMock.mockClear();
    rerender(<HelpPanel width={0} isVisible={false} />);
    expect(setFocusedMock).toHaveBeenCalledWith("t-1", false);
    expect(pinCalls()).toHaveLength(0);
  });

  it("moves the pin to the new terminal when the assistant terminal id changes", () => {
    const { rerender } = render(<HelpPanel width={380} />);
    act(() => {
      fireEvent.focus(getAside());
    });
    expect(pinCalls()).toContainEqual(["t-1", true]);

    setFocusedMock.mockClear();
    helpPanelState.terminalId = "t-2";
    panelStoreState.panelIds = ["t-2"];
    panelStoreState.panelsById = {
      "t-2": { agentState: "idle", cwd: "/repo", spawnStatus: "ready" },
    };
    rerender(<HelpPanel width={380} />);
    // Cleanup releases the old id, then the rerun pins the new one.
    expect(setFocusedMock).toHaveBeenCalledWith("t-1", false);
    expect(pinCalls()).toContainEqual(["t-2", true]);
  });

  it("keeps the pin across a focus hop between controls inside the panel", () => {
    render(<HelpPanel width={380} />);
    const aside = getAside();
    act(() => {
      fireEvent.focus(aside);
    });
    expect(pinCalls()).toContainEqual(["t-1", true]);

    setFocusedMock.mockClear();
    // Focus moves to a descendant still inside the aside → not a real blur,
    // so hasDomFocus stays true and the pin is neither released nor churned.
    const child = aside.querySelector("*") ?? aside;
    act(() => {
      fireEvent.blur(aside, { relatedTarget: child });
    });
    expect(setFocusedMock).not.toHaveBeenCalledWith("t-1", false);
  });
});
