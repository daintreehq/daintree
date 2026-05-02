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
  helpPanelState,
  panelStoreState,
  cliAvailabilityState,
  agentSettingsState,
  projectStoreState,
} = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockNotify: vi.fn().mockReturnValue(""),
  mockLogError: vi.fn(),
  mockGetFolderPath: vi.fn(),
  mockMarkTerminal: vi.fn().mockResolvedValue(undefined),
  mockProvisionSession: vi.fn().mockResolvedValue(null),
  mockRevokeSession: vi.fn().mockResolvedValue(undefined),
  helpPanelState: {
    isOpen: true,
    width: 380,
    terminalId: null as string | null,
    agentId: null as string | null,
    preferredAgentId: null as string | null,
    sessionId: null as string | null,
    setWidth: vi.fn(),
    setOpen: vi.fn(),
    clearTerminal: vi.fn(),
    clearPreferredAgent: vi.fn(),
    setTerminal: vi.fn(),
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
}));

vi.mock("@shared/types", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentSettingsEntry: () => ({}),
  };
});

vi.mock("@shared/config/agentRegistry", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ASSISTANT_FAST_MODELS: {} as Record<string, string>,
  };
});

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

  return {
    usePanelStore: panelStore,
    useCliAvailabilityStore: cliStore,
    useAgentSettingsStore: agentSettingsStore,
    useProjectStore: projectStore,
    getTerminalRefreshTier: () => 0,
  };
});

vi.mock("@/types", () => ({
  TerminalRefreshTier: { BACKGROUND: 0, ACTIVE: 1 },
}));

// Stub HelpAgentPicker to expose a click target tied to the onSelectAgent prop
vi.mock("../HelpAgentPicker", () => ({
  HelpAgentPicker: ({ onSelectAgent }: { onSelectAgent: (id: string) => void }) => (
    <button type="button" data-testid="pick-claude" onClick={() => onSelectAgent("claude")}>
      Pick Claude
    </button>
  ),
}));

import { HelpPanel } from "../HelpPanel";

function resetState() {
  helpPanelState.isOpen = true;
  helpPanelState.width = 380;
  helpPanelState.terminalId = null;
  helpPanelState.agentId = null;
  helpPanelState.preferredAgentId = null;
  helpPanelState.sessionId = null;
  helpPanelState.setTerminal = vi.fn();
  helpPanelState.setOpen = vi.fn();
  helpPanelState.setWidth = vi.fn();
  helpPanelState.clearTerminal = vi.fn();
  helpPanelState.clearPreferredAgent = vi.fn();

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
  mockProvisionSession.mockReset();
  mockProvisionSession.mockResolvedValue(null);
  mockRevokeSession.mockReset();
  mockRevokeSession.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();

  Object.defineProperty(globalThis, "window", {
    value: {
      electron: {
        help: {
          getFolderPath: mockGetFolderPath,
          markTerminal: mockMarkTerminal,
          provisionSession: mockProvisionSession,
          revokeSession: mockRevokeSession,
        },
      },
    },
    writable: true,
    configurable: true,
  });

  // Default: visibility is "visible"
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

describe("HelpPanel — manual select agent (handleSelectAgent)", () => {
  it("commits the terminal to helpPanelStore even when document.hidden is true", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    const { getByTestId } = render(<HelpPanel />);

    await act(async () => {
      fireEvent.click(getByTestId("pick-claude"));
    });

    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("term-1", "claude", null);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("notifies and does not commit terminal when result.ok is false", async () => {
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: false });

    const { getByTestId } = render(<HelpPanel />);

    await act(async () => {
      fireEvent.click(getByTestId("pick-claude"));
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
    );
  });

  it("notifies when result.ok is true but terminalId is null", async () => {
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: null } });

    const { getByTestId } = render(<HelpPanel />);

    await act(async () => {
      fireEvent.click(getByTestId("pick-claude"));
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
    );
  });

  it("notifies and aborts when help folder is null", async () => {
    mockGetFolderPath.mockResolvedValue(null);

    const { getByTestId } = render(<HelpPanel />);

    await act(async () => {
      fireEvent.click(getByTestId("pick-claude"));
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
    );
  });

  it("ignores second click while first launch is in flight (reentrancy guard)", async () => {
    mockGetFolderPath.mockResolvedValue("/help");
    let resolveDispatch: (v: unknown) => void = () => {};
    mockDispatch.mockReturnValue(
      new Promise((r) => {
        resolveDispatch = r;
      })
    );

    const { getByTestId } = render(<HelpPanel />);

    // First click — kicks off async launch
    await act(async () => {
      fireEvent.click(getByTestId("pick-claude"));
    });
    // First click should have advanced past getFolderPath into dispatch
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    // Second click while first dispatch is still pending — should be ignored
    await act(async () => {
      fireEvent.click(getByTestId("pick-claude"));
    });
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDispatch({ ok: true, result: { terminalId: "term-1" } });
    });

    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("term-1", "claude", null);
  });
});

describe("HelpPanel — auto-launch (preferredAgentId)", () => {
  it("commits the terminal even when document.hidden is true", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    await act(async () => {
      render(<HelpPanel />);
    });

    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("auto-term-1", "claude", null);
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
      render(<HelpPanel />);
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
      render(<HelpPanel />);
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
    );
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

    const { getByTestId, queryByTestId } = render(<HelpPanel />);

    expect(getByTestId("missing-cli-gate")).toBeTruthy();
    expect(queryByTestId("xterm-adapter")).toBeNull();
  });

  it("renders XtermAdapter when terminal is healthy", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { getByTestId, queryByTestId } = render(<HelpPanel />);

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

    const { getByTestId } = render(<HelpPanel />);

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

    const { getByTestId } = render(<HelpPanel />);

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

    const { getByTestId } = render(<HelpPanel />);

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

    const { getByTestId } = render(<HelpPanel />);

    await act(async () => {
      fireEvent.click(getByTestId("pick-claude"));
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

  it("omits DAINTREE_MCP_URL when mcpUrl is null (localMcpEnabled=false)", async () => {
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

    const { getByTestId } = render(<HelpPanel />);

    await act(async () => {
      fireEvent.click(getByTestId("pick-claude"));
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

    const { getByTestId, container } = render(<HelpPanel />);

    await act(async () => {
      fireEvent.click(getByTestId("pick-claude"));
    });

    // Wait a microtask for provisionSession promise to flush
    await act(async () => {
      await Promise.resolve();
    });

    // Close the panel while agent.launch is still in-flight
    const closeBtn = container.querySelector('button[aria-label="Close help panel"]');
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

    const { getByTestId, container } = render(<HelpPanel />);

    await act(async () => {
      fireEvent.click(getByTestId("pick-claude"));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const closeBtn = container.querySelector('button[aria-label="Close help panel"]');
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
      render(<HelpPanel />);
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

    const { rerender } = render(<HelpPanel />);

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
      rerender(<HelpPanel />);
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
