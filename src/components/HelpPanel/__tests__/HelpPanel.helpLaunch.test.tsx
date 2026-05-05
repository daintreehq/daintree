// @vitest-environment jsdom
import { render, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDispatch,
  mockNotify,
  mockLogError,
  mockGetFolderPath,
  mockMarkTerminal,
  mockProvisionSession,
  mockRevokeSession,
  mockGetAssistantSupportedAgentIds,
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
  preferencesState,
} = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockNotify: vi.fn().mockReturnValue(""),
  mockLogError: vi.fn(),
  mockGetFolderPath: vi.fn(),
  mockMarkTerminal: vi.fn().mockResolvedValue(undefined),
  mockProvisionSession: vi.fn().mockResolvedValue(null),
  mockRevokeSession: vi.fn().mockResolvedValue(undefined),
  mockGetAssistantSupportedAgentIds: vi.fn(() => ["claude"]),
  mockGetHelpAssistantSettings: vi.fn().mockResolvedValue({
    docSearch: true,
    daintreeControl: true,
    skipPermissions: false,
    auditRetention: 7,
    customArgs: "",
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
    sessionId: null as string | null,
    introDismissed: true,
    setWidth: vi.fn(),
    setOpen: vi.fn(),
    clearTerminal: vi.fn(),
    setPreferredAgent: vi.fn(),
    setTerminal: vi.fn(),
    dismissIntro: vi.fn(),
  },
  panelStoreState: {
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
    currentProject: null as { id: string; path: string } | null,
  },
  preferencesState: { reduceAnimations: false, skipWorkingCloseConfirm: false },
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

vi.mock("@/components/Terminal/MissingCliGate", () => ({
  MissingCliGate: ({ agentId, onRunAnyway }: { agentId: string; onRunAnyway: () => void }) => (
    <div data-testid="missing-cli-gate" data-agent={agentId}>
      <button type="button" data-testid="run-anyway" onClick={onRunAnyway}>
        Run anyway
      </button>
    </div>
  ),
}));

vi.mock("@shared/config/agentIds", () => ({
  BUILT_IN_AGENT_IDS: ["claude", "gemini", "codex"],
}));

vi.mock("@/config/agents", () => ({
  AGENT_REGISTRY: {
    claude: { name: "Claude", iconId: "claude", color: "#000", icon: () => null },
    gemini: { name: "Gemini", iconId: "gemini", color: "#000", icon: () => null },
    codex: { name: "Codex", iconId: "codex", color: "#000", icon: () => null },
  },
  getAgentConfig: (id: string) =>
    ({
      claude: { name: "Claude", icon: () => null, models: [] },
      gemini: { name: "Gemini", icon: () => null, models: [] },
      codex: { name: "Codex", icon: () => null, models: [] },
    })[id],
  getAssistantSupportedAgentIds: () => mockGetAssistantSupportedAgentIds(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => mockDispatch(...args) },
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

  return {
    usePanelStore: panelStore,
    useCliAvailabilityStore: cliStore,
    useAgentSettingsStore: agentSettingsStore,
    useProjectStore: projectStore,
    usePreferencesStore: preferencesStore,
    getTerminalRefreshTier: () => 0,
  };
});

vi.mock("@/store/macroFocusStore", () => {
  const state = { focusedRegion: null, setRegionRef: vi.fn(), setVisibility: vi.fn() };
  const store = (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state);
  store.getState = () => state;
  return { useMacroFocusStore: store };
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

import { HelpPanel } from "../HelpPanel";
import { useEscapeStack } from "@/hooks/useEscapeStack";

function resetState() {
  helpPanelState.isOpen = true;
  helpPanelState.width = 380;
  helpPanelState.terminalId = null;
  helpPanelState.agentId = null;
  helpPanelState.preferredAgentId = null;
  helpPanelState.sessionId = null;
  helpPanelState.introDismissed = true;
  helpPanelState.setTerminal = vi.fn();
  helpPanelState.setOpen = vi.fn();
  helpPanelState.setWidth = vi.fn();
  helpPanelState.clearTerminal = vi.fn();
  helpPanelState.setPreferredAgent = vi.fn();
  helpPanelState.dismissIntro = vi.fn();

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

  projectStoreState.currentProject = null;
  preferencesState.reduceAnimations = false;
  preferencesState.skipWorkingCloseConfirm = false;
  mockProvisionSession.mockReset();
  mockProvisionSession.mockResolvedValue(null);
  mockRevokeSession.mockReset();
  mockRevokeSession.mockResolvedValue(undefined);
  mockGetAssistantSupportedAgentIds.mockReset();
  mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
  mockGetHelpAssistantSettings.mockReset();
  mockGetHelpAssistantSettings.mockResolvedValue({
    docSearch: true,
    daintreeControl: true,
    skipPermissions: false,
    auditRetention: 7,
    customArgs: "",
  });
}

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
        },
        helpAssistant: {
          getSettings: mockGetHelpAssistantSettings,
        },
        systemSleep: {
          getMetrics: mockSystemSleepGetMetrics,
          onSuspend: mockSystemSleepOnSuspend,
          onWake: mockSystemSleepOnWake,
        },
      },
    },
    writable: true,
    configurable: true,
  });

  // Default: visibility is "visible"
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

describe("HelpPanel — single-supported-agent launch (handleSelectAgent)", () => {
  it("commits the terminal to helpPanelStore even when document.hidden is true", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("term-1", "claude", null);
    expect(mockNotify).not.toHaveBeenCalled();
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

  it("notifies and does not commit terminal when result.ok is false", async () => {
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: false });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
    );
  });

  it("notifies when result.ok is true but terminalId is null", async () => {
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: null } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
    );
  });

  it("notifies and aborts when help folder is null", async () => {
    mockGetFolderPath.mockResolvedValue(null);

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
    );
  });

  it("surfaces a Start-MCP-failed toast and skips dispatch when provisionSession rejects with MCP_NOT_READY", async () => {
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj" };
    mockGetFolderPath.mockResolvedValue("/help");
    const err = new Error("port collision") as Error & { code: string };
    err.code = "MCP_NOT_READY";
    mockProvisionSession.mockRejectedValueOnce(err);

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Start MCP failed",
        action: expect.objectContaining({
          label: "Open settings",
          actionId: "app.settings.openTab",
        }),
      })
    );
  });

  it("falls back to a generic launch-failed toast when provisionSession rejects without a typed code", async () => {
    projectStoreState.currentProject = { id: "proj-1", path: "/tmp/proj" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockRejectedValueOnce(new Error("ipc disconnected"));

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Assistant launch failed",
      })
    );
  });
});

describe("HelpPanel — auto-launch (preferredAgentId)", () => {
  it("commits the terminal even when document.hidden is true", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("auto-term-1", "claude", null);
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

  it("notifies and does not commit terminal on launch failure", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: false });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
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

  it("does not render the banner on the picker view (no terminal)", () => {
    helpPanelState.terminalId = null;
    helpPanelState.introDismissed = false;

    const { container } = render(<HelpPanel width={380} />);

    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
  });

  it("dismisses the banner and opens the docs URL when the link is clicked", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.introDismissed = false;
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };
    mockDispatch.mockResolvedValue({ ok: true });

    const { getByText } = render(<HelpPanel width={380} />);

    fireEvent.click(getByText("See what the Daintree Assistant can do"));

    expect(helpPanelState.dismissIntro).toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://daintree.org/assistant" },
      { source: "user" }
    );
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

describe("HelpPanel — handleRunAnyway", () => {
  it("commits the re-spawned terminal to helpPanelStore (regression: no orphan)", async () => {
    helpPanelState.terminalId = "gate-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "gate-1": {
        id: "gate-1",
        kind: "terminal",
        spawnStatus: "missing-cli",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
      },
    };
    cliAvailabilityState.details = {
      claude: { state: "missing", resolvedPath: null, via: null },
    };
    panelStoreState.addPanel = vi.fn().mockResolvedValue("restarted-term");

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    expect(panelStoreState.removePanel).toHaveBeenCalledWith("gate-1");
    expect(panelStoreState.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal", launchAgentId: "claude", cwd: "/help" })
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("restarted-term", "claude", null);
    expect(mockMarkTerminal).toHaveBeenCalledWith("restarted-term");
  });

  it("notifies on addPanel rejection", async () => {
    helpPanelState.terminalId = "gate-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "gate-1": {
        id: "gate-1",
        kind: "terminal",
        spawnStatus: "missing-cli",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
      },
    };
    cliAvailabilityState.details = {
      claude: { state: "missing", resolvedPath: null, via: null },
    };
    panelStoreState.addPanel = vi.fn().mockRejectedValue(new Error("spawn failed"));

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
    );
  });

  it("revokes the freshly-provisioned session when addPanel throws (regression: leaked token)", async () => {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    helpPanelState.terminalId = "gate-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "gate-1": {
        id: "gate-1",
        kind: "terminal",
        spawnStatus: "missing-cli",
        cwd: "/help",
        title: "Claude",
        command: "claude",
        location: "dock",
      },
    };
    cliAvailabilityState.details = {
      claude: { state: "missing", resolvedPath: null, via: null },
    };
    mockProvisionSession.mockResolvedValue({
      sessionId: "leaked-sess",
      sessionPath: "/sessions/leaked-sess",
      token: "tok-leak",
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });
    panelStoreState.addPanel = vi.fn().mockRejectedValue(new Error("spawn failed"));

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    expect(mockRevokeSession).toHaveBeenCalledWith("leaked-sess");
  });
});

describe("HelpPanel — session provisioning", () => {
  it("threads sessionPath as cwd and full DAINTREE_* env into agent.launch", async () => {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-1",
      sessionPath: "/sessions/sess-1",
      token: "tok-abc",
      tier: "action",
      mcpUrl: "http://127.0.0.1:45454/sse",
      windowId: 7,
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockProvisionSession).toHaveBeenCalledWith({
      projectId: "proj-1",
      projectPath: "/repo",
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        cwd: "/sessions/sess-1",
        env: {
          DAINTREE_MCP_TOKEN: "tok-abc",
          DAINTREE_MCP_URL: "http://127.0.0.1:45454/sse",
          DAINTREE_WINDOW_ID: "7",
          DAINTREE_PROJECT_ID: "proj-1",
        },
      }),
      { source: "user" }
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("term-1", "claude", "sess-1");
  });

  it("omits DAINTREE_MCP_URL when mcpUrl is null (daintreeControl=false)", async () => {
    projectStoreState.currentProject = { id: "proj-2", path: "/repo2" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-2",
      sessionPath: "/sessions/sess-2",
      token: "tok-xyz",
      tier: "action",
      mcpUrl: null,
      windowId: 3,
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-2" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        env: {
          DAINTREE_MCP_TOKEN: "tok-xyz",
          DAINTREE_WINDOW_ID: "3",
          DAINTREE_PROJECT_ID: "proj-2",
        },
      }),
      { source: "user" }
    );
  });

  it("revokes the in-flight session when handleClose fires before setTerminal commits", async () => {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "pending-1",
      sessionPath: "/sessions/pending-1",
      token: "tok-pending",
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });

    let resolveDispatch: (v: unknown) => void = () => {};
    mockDispatch.mockReturnValue(
      new Promise((r) => {
        resolveDispatch = r;
      })
    );

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<HelpPanel width={380} />));
    });

    // Close the panel while agent.launch is still in-flight
    const closeBtn = container!.querySelector('button[aria-label="Close help panel"]');
    if (closeBtn) {
      await act(async () => {
        fireEvent.click(closeBtn);
      });
    }

    // Now resolve the launch
    await act(async () => {
      resolveDispatch({ ok: true, result: { terminalId: "term-late" } });
    });

    // The pending session should have been revoked by handleClose's
    // revokePendingSession call.
    expect(mockRevokeSession).toHaveBeenCalledWith("pending-1");
  });

  it("does not commit terminal and removes orphan when session was revoked during in-flight launch", async () => {
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValue({
      sessionId: "pending-2",
      sessionPath: "/sessions/pending-2",
      token: "tok-pending-2",
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });

    let resolveDispatch: (v: unknown) => void = () => {};
    mockDispatch.mockReturnValue(
      new Promise((r) => {
        resolveDispatch = r;
      })
    );

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<HelpPanel width={380} />));
    });

    const closeBtn = container!.querySelector('button[aria-label="Close help panel"]');
    if (closeBtn) {
      await act(async () => {
        fireEvent.click(closeBtn);
      });
    }

    await act(async () => {
      resolveDispatch({ ok: true, result: { terminalId: "orphan-term" } });
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("orphan-term");
  });

  it("revokes the bound session when the panel disappears from panelsById", async () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = "sess-bound";
    panelStoreState.panelsById = {};

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockRevokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
  });
});

describe("HelpPanel — hasAutoLaunched stale reset (regression)", () => {
  it("resets hasAutoLaunched after stale-agent abort so next preferred agent can auto-launch", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");

    let resolveFirst: (v: unknown) => void = () => {};
    let resolveSecond: (v: unknown) => void = () => {};
    mockDispatch
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        })
      )
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveSecond = r;
        })
      );

    const { rerender } = render(<HelpPanel width={380} />);

    // User switches preferred agent while first launch is in flight (stale path)
    helpPanelState.preferredAgentId = "gemini";

    await act(async () => {
      resolveFirst({ ok: true, result: { terminalId: "stale-claude" } });
    });

    // Stale guard cleaned up the orphaned terminal and reset hasAutoLaunched.
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("stale-claude");
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();

    // Trigger the effect again with the new preferredAgentId.
    await act(async () => {
      rerender(<HelpPanel width={380} />);
    });

    // The follow-up auto-launch must fire — this is the regression bug.
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(mockDispatch).toHaveBeenLastCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "gemini" }),
      { source: "user" }
    );

    await act(async () => {
      resolveSecond({ ok: true, result: { terminalId: "term-gemini" } });
    });

    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("term-gemini", "gemini", null);
  });
});

describe("HelpPanel — single-supported-agent auto-skip (issue #6612)", () => {
  it("auto-launches the only supported agent without requiring user selection", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-skip-term" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("auto-skip-term", "claude", null);
  });

  it("does not auto-skip when more than one supported agent is installed", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "should-not-fire" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
  });

  it("does not auto-skip when no supported agent is installed", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "missing", gemini: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "should-not-fire" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
  });

  it("does not auto-skip while CLI availability data is still loading", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.hasRealData = false;
    cliAvailabilityState.availability = { claude: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude"]);
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "should-not-fire" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
  });

  it("never renders a Back button (picker removed)", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { container } = render(<HelpPanel width={380} />);

    expect(container.querySelector('button[aria-label="Back to agent picker"]')).toBeNull();
  });
});

describe("HelpPanel — empty state with no preferred agent", () => {
  it("renders an 'Open assistant settings' button when more than one supported agent is installed and no preferred agent", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { findByRole } = render(<HelpPanel width={380} />);

    const button = await findByRole("button", { name: /open assistant settings/i });
    expect(button).toBeTruthy();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches app.settings.openTab with tab='assistant' when the settings button is clicked", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { findByRole } = render(<HelpPanel width={380} />);

    const button = await findByRole("button", { name: /open assistant settings/i });
    fireEvent.click(button);

    expect(mockDispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "assistant" },
      { source: "user" }
    );
  });
});

describe("HelpPanel — customArgs threading", () => {
  it("passes customArgs as agentLaunchFlags in the agent.launch dispatch payload", async () => {
    mockGetHelpAssistantSettings.mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      skipPermissions: false,
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
      skipPermissions: false,
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
      skipPermissions: false,
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
      skipPermissions: false,
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
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("term-1", "claude", null);
  });
});

describe("HelpPanel — close confirmation guard (issue #6623)", () => {
  it("closes immediately when the assistant is idle (no dialog)", () => {
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

    const { container, queryByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Close help panel"]')!);

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
  });

  it("shows the confirm dialog when closing during an in-flight turn", () => {
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

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Close help panel"]')!);

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.setOpen).not.toHaveBeenCalled();
    expect(getByTestId("dialog-title").textContent).toBe("Stop this agent?");
    expect(getByTestId("dialog-description").textContent).toContain(
      "Closing the assistant panel will stop it"
    );
    expect(getByTestId("dialog-confirm").textContent).toBe("Stop and close");
  });

  it("keeps the panel open when the user cancels the close dialog", () => {
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

    const { container, getByTestId, queryByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Close help panel"]')!);
    fireEvent.click(getByTestId("dialog-cancel"));

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.setOpen).not.toHaveBeenCalled();
  });

  it("runs the close cleanup and revokes the bound session when the user confirms", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.sessionId = "sess-bound";
    panelStoreState.panelsById = {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/help",
        agentState: "working",
      },
    };

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Close help panel"]')!);
    fireEvent.click(getByTestId("dialog-confirm"));

    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
    expect(mockRevokeSession).toHaveBeenCalledWith("sess-bound");
  });

  it.each(["waiting", "directing", "completed", "exited"] as const)(
    "closes immediately for %s agent state (only 'working' triggers confirm)",
    (state) => {
      helpPanelState.terminalId = "term-1";
      helpPanelState.agentId = "claude";
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
      fireEvent.click(container.querySelector('button[aria-label="Close help panel"]')!);

      expect(queryByTestId("confirm-dialog")).toBeNull();
      expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
      expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
    }
  );

  it("closes immediately when skipWorkingCloseConfirm preference is on", () => {
    preferencesState.skipWorkingCloseConfirm = true;
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

    const { container, queryByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Close help panel"]')!);

    expect(queryByTestId("confirm-dialog")).toBeNull();
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
  });

  it("Escape inherits the guard via handleClose (working state shows dialog, no cleanup)", () => {
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

    const { getByTestId, queryByTestId } = render(<HelpPanel width={380} />);

    // Capture the callback registered with useEscapeStack and invoke it
    // directly — equivalent to a real Escape press hitting the LIFO stack
    // when no xterm-helper-textarea has focus.
    const escapeMock = vi.mocked(useEscapeStack);
    const lastCall = escapeMock.mock.calls.at(-1);
    const callback = lastCall?.[1];
    expect(callback).toBeTypeOf("function");

    act(() => {
      callback?.();
    });

    expect(queryByTestId("confirm-dialog")).not.toBeNull();
    expect(getByTestId("dialog-confirm").textContent).toBe("Stop and close");
    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.setOpen).not.toHaveBeenCalled();
  });
});

describe("HelpPanel — visibilitychange teardown vs. system sleep (issue #6758)", () => {
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

  it("skips teardown when document.hidden flips during system suspend", async () => {
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
    expect(mockSystemSleepGetMetrics).not.toHaveBeenCalled();
  });

  it("skips teardown when getMetrics reports the system is currently sleeping (race fallback)", async () => {
    mockSystemSleepGetMetrics.mockResolvedValueOnce({
      totalSleepMs: 0,
      sleepPeriods: [],
      isCurrentlySleeping: true,
      currentSleepStart: Date.now(),
    });

    await act(async () => {
      mountWithBoundTerminal();
    });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushAsync();

    expect(mockSystemSleepGetMetrics).toHaveBeenCalledTimes(1);
    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it("tears down when getMetrics reports the system is awake (project switch / window close path)", async () => {
    await act(async () => {
      mountWithBoundTerminal();
    });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushAsync();

    expect(mockSystemSleepGetMetrics).toHaveBeenCalledTimes(1);
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-sleep");
    expect(mockRevokeSession).toHaveBeenCalledWith("session-sleep");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
  });

  it("tears down (safe fallback) when getMetrics rejects", async () => {
    mockSystemSleepGetMetrics.mockRejectedValueOnce(new Error("ipc broken"));

    await act(async () => {
      mountWithBoundTerminal();
    });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushAsync();

    expect(mockSystemSleepGetMetrics).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalled();
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-sleep");
    expect(mockRevokeSession).toHaveBeenCalledWith("session-sleep");
  });

  it("skips teardown if the document becomes visible before getMetrics resolves", async () => {
    let resolveMetrics:
      | ((value: {
          totalSleepMs: number;
          sleepPeriods: never[];
          isCurrentlySleeping: boolean;
          currentSleepStart: number | null;
        }) => void)
      | null = null;
    mockSystemSleepGetMetrics.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMetrics = resolve;
        })
    );

    await act(async () => {
      mountWithBoundTerminal();
    });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => {
      resolveMetrics?.({
        totalSleepMs: 0,
        sleepPeriods: [],
        isCurrentlySleeping: false,
        currentSleepStart: null,
      });
    });
    await flushAsync();

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it("skips teardown if onSuspend arrives while getMetrics is in flight", async () => {
    let resolveMetrics:
      | ((value: {
          totalSleepMs: number;
          sleepPeriods: never[];
          isCurrentlySleeping: boolean;
          currentSleepStart: number | null;
        }) => void)
      | null = null;
    mockSystemSleepGetMetrics.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMetrics = resolve;
        })
    );

    await act(async () => {
      mountWithBoundTerminal();
    });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    act(() => {
      systemSleepListeners.suspend.forEach((cb) => cb());
    });

    await act(async () => {
      resolveMetrics?.({
        totalSleepMs: 0,
        sleepPeriods: [],
        isCurrentlySleeping: false,
        currentSleepStart: null,
      });
    });
    await flushAsync();

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it("clears the suspend guard on wake so subsequent visibilitychange tears down normally", async () => {
    await act(async () => {
      mountWithBoundTerminal();
    });

    act(() => {
      systemSleepListeners.suspend.forEach((cb) => cb());
    });
    act(() => {
      systemSleepListeners.wake.forEach((cb) => cb(1000));
    });

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushAsync();

    expect(mockSystemSleepGetMetrics).toHaveBeenCalledTimes(1);
    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-sleep");
    expect(mockRevokeSession).toHaveBeenCalledWith("session-sleep");
  });
});
