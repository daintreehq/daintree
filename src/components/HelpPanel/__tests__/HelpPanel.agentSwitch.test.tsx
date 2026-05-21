// @vitest-environment jsdom
import { render, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Captures the live controller instance's spies so tests can assert on the
// switch path. HelpPanel instantiates exactly one controller per mount.
const { controllerSpies, helpPanelState, panelStoreState } = vi.hoisted(() => ({
  controllerSpies: {
    selectAgent: vi.fn(),
    newSession: vi.fn(),
  },
  helpPanelState: {
    isOpen: true,
    width: 380,
    terminalId: null as string | null,
    agentId: null as string | null,
    preferredAgentId: null as string | null,
    sessionId: null as string | null,
    introDismissed: true,
    conversationTouched: false,
    hibernateSessions: {} as Record<string, unknown>,
    focusRequest: 0,
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
    panelsById: {} as Record<string, { agentState?: string; cwd?: string }>,
    removePanel: vi.fn(),
    addPanel: vi.fn().mockResolvedValue(""),
  },
}));

const snapshot = {
  showResumeBanner: false,
  preflightSnapshot: null,
  tierMismatch: null,
  isApprovingTier: false,
  assistantVersionTooOld: null,
};

vi.mock("@/controllers/HelpSessionController", () => ({
  HelpSessionController: class {
    start = vi.fn();
    stop = vi.fn();
    subscribe = (_cb: () => void) => () => {};
    getSnapshot = () => snapshot;
    syncInputs = vi.fn();
    handleTerminalPanelMissing = vi.fn();
    maybeRunPreflightSnapshot = vi.fn(() => undefined);
    selectAgent = (...args: unknown[]) => controllerSpies.selectAgent(...args);
    newSession = (...args: unknown[]) => controllerSpies.newSession(...args);
    runAnyway = vi.fn();
    dismissResumeBanner = vi.fn();
    dismissPreflightSnapshot = vi.fn();
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
  terminalInstanceService: { focus: vi.fn(), notifyUserInput: vi.fn() },
}));
vi.mock("@/clients", () => ({ terminalClient: { submit: vi.fn(), sendKey: vi.fn() } }));
vi.mock("@shared/config/agentIds", () => ({
  isBuiltInAgentId: (v: unknown): v is string =>
    typeof v === "string" && ["claude", "codex", "claude-code"].includes(v),
}));
vi.mock("../../../shared/utils/agentAvailability", () => ({ isAgentInstalled: () => true }));
vi.mock("@/lib/accessibility", () => ({ TABBABLE_SELECTOR: "button" }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
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
  const state = { focusedRegion: null, setRegionRef: vi.fn() };
  const store = (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state);
  store.getState = () => state;
  return { useMacroFocusStore: store };
});

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    confirmLabel,
    cancelLabel = "Cancel",
    onConfirm,
    onClose,
  }: {
    isOpen: boolean;
    title: React.ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onClose?: () => void;
  }) =>
    isOpen ? (
      <div role="dialog" data-testid="confirm-dialog">
        <h2 data-testid="dialog-title">{title}</h2>
        <button data-testid="dialog-cancel" onClick={onClose}>
          {cancelLabel}
        </button>
        <button data-testid="dialog-confirm" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { HelpPanel } from "../HelpPanel";

function resetState() {
  helpPanelState.isOpen = true;
  helpPanelState.terminalId = null;
  helpPanelState.agentId = null;
  helpPanelState.preferredAgentId = null;
  helpPanelState.sessionId = null;
  helpPanelState.introDismissed = true;
  helpPanelState.conversationTouched = false;
  panelStoreState.panelIds = [];
  panelStoreState.panelsById = {};
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
});

function bindTerminal(agentId: string, agentState = "idle") {
  helpPanelState.terminalId = "t-1";
  helpPanelState.agentId = agentId;
  panelStoreState.panelIds = ["t-1"];
  panelStoreState.panelsById = { "t-1": { agentState, cwd: "/repo" } };
}

describe("HelpPanel agent switch (#8353)", () => {
  it("switches immediately when the session is untouched and idle", async () => {
    bindTerminal("codex", "idle");
    helpPanelState.preferredAgentId = "codex";
    const { rerender } = render(<HelpPanel width={380} />);

    await act(async () => {
      helpPanelState.preferredAgentId = "claude-code";
      rerender(<HelpPanel width={380} />);
    });

    expect(controllerSpies.selectAgent).toHaveBeenCalledWith("claude-code");
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
  });

  it("confirms before switching when the conversation has been touched", async () => {
    bindTerminal("codex", "idle");
    helpPanelState.preferredAgentId = "codex";
    helpPanelState.conversationTouched = true;
    const { rerender } = render(<HelpPanel width={380} />);

    await act(async () => {
      helpPanelState.preferredAgentId = "claude-code";
      rerender(<HelpPanel width={380} />);
    });

    expect(controllerSpies.selectAgent).not.toHaveBeenCalled();
    const dialog = document.querySelector('[data-testid="confirm-dialog"]');
    expect(dialog).not.toBeNull();
    expect(document.querySelector('[data-testid="dialog-title"]')?.textContent).toBe(
      "Switch to Claude Code?"
    );

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="dialog-confirm"]')!);
    });
    expect(controllerSpies.selectAgent).toHaveBeenCalledWith("claude-code");
  });

  it("confirms before switching when the agent is in a close-confirm state", async () => {
    bindTerminal("codex", "working");
    helpPanelState.preferredAgentId = "codex";
    const { rerender } = render(<HelpPanel width={380} />);

    await act(async () => {
      helpPanelState.preferredAgentId = "claude-code";
      rerender(<HelpPanel width={380} />);
    });

    expect(controllerSpies.selectAgent).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();
  });

  it("does not switch and does not revert the preference when the confirm is cancelled", async () => {
    bindTerminal("codex", "working");
    helpPanelState.preferredAgentId = "codex";
    const { rerender } = render(<HelpPanel width={380} />);

    await act(async () => {
      helpPanelState.preferredAgentId = "claude-code";
      rerender(<HelpPanel width={380} />);
    });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="dialog-cancel"]')!);
    });

    expect(controllerSpies.selectAgent).not.toHaveBeenCalled();
    expect(helpPanelState.preferredAgentId).toBe("claude-code");
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
  });

  it("is a no-op when the preferred agent already matches the bound agent", async () => {
    bindTerminal("codex", "idle");
    helpPanelState.preferredAgentId = "codex";

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(controllerSpies.selectAgent).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
  });

  it("switches when the preference was chosen before the terminal bound", async () => {
    // Preference chosen while no terminal is bound, then auto-launch binds a
    // different agent — the change must not be silently consumed (#8353).
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    helpPanelState.preferredAgentId = "claude-code";
    const { rerender } = render(<HelpPanel width={380} />);

    await act(async () => {
      bindTerminal("codex", "idle");
      rerender(<HelpPanel width={380} />);
    });

    expect(controllerSpies.selectAgent).toHaveBeenCalledWith("claude-code");
  });

  it("closes a stale confirm when the preference reverts to the live agent", async () => {
    bindTerminal("codex", "working");
    helpPanelState.preferredAgentId = "codex";
    const { rerender } = render(<HelpPanel width={380} />);

    await act(async () => {
      helpPanelState.preferredAgentId = "claude-code";
      rerender(<HelpPanel width={380} />);
    });
    expect(document.querySelector('[data-testid="confirm-dialog"]')).not.toBeNull();

    await act(async () => {
      helpPanelState.preferredAgentId = "codex";
      rerender(<HelpPanel width={380} />);
    });

    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(controllerSpies.selectAgent).not.toHaveBeenCalled();
  });

  it("retargets the confirm when the preference moves to a third agent", async () => {
    bindTerminal("codex", "working");
    helpPanelState.preferredAgentId = "codex";
    const { rerender } = render(<HelpPanel width={380} />);

    await act(async () => {
      helpPanelState.preferredAgentId = "claude-code";
      rerender(<HelpPanel width={380} />);
    });
    await act(async () => {
      helpPanelState.preferredAgentId = "claude";
      rerender(<HelpPanel width={380} />);
    });

    expect(document.querySelector('[data-testid="dialog-title"]')?.textContent).toBe(
      "Switch to Claude?"
    );
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="dialog-confirm"]')!);
    });
    expect(controllerSpies.selectAgent).toHaveBeenCalledWith("claude");
    expect(controllerSpies.selectAgent).not.toHaveBeenCalledWith("claude-code");
  });

  it("does not switch when no terminal is bound", async () => {
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    helpPanelState.preferredAgentId = "codex";
    const { rerender } = render(<HelpPanel width={380} />);

    await act(async () => {
      helpPanelState.preferredAgentId = "claude-code";
      rerender(<HelpPanel width={380} />);
    });

    expect(controllerSpies.selectAgent).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
  });
});
