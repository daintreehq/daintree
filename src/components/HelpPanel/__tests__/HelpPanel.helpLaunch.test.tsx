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
    sessionId: null as string | null,
    introDismissed: true,
    conversationTouched: false,
    hibernateSessions: {} as Record<string, { sessionId: string; cwd: string; agentId: string }>,
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
    isBuiltInAgentId: (value: unknown): value is "claude" | "gemini" | "codex" =>
      typeof value === "string" && ids.includes(value),
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
  helpPanelState.conversationTouched = false;
  helpPanelState.hibernateSessions = {};
  helpPanelState.markConversationStarted = vi.fn();
  helpPanelState.setTerminal = vi.fn();
  helpPanelState.setOpen = vi.fn();
  helpPanelState.setWidth = vi.fn();
  helpPanelState.clearTerminal = vi.fn();
  helpPanelState.setPreferredAgent = vi.fn();
  helpPanelState.dismissIntro = vi.fn();
  helpPanelState.setHibernateSession = vi.fn();
  helpPanelState.clearHibernateSession = vi.fn();

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
          onTierNotPermitted: vi.fn(() => () => {}),
          setSessionTier: vi.fn().mockResolvedValue({ sessionId: "", tier: "workbench" }),
          issueGrant: vi.fn().mockResolvedValue({
            sessionId: "",
            toolId: "",
            ttlMs: 900_000,
            expiresAt: Date.now() + 900_000,
          }),
        },
        git: {
          snapshotGet: vi.fn().mockResolvedValue(null),
        },
        project: {
          getSettings: vi.fn().mockResolvedValue({}),
          saveSettings: vi.fn().mockResolvedValue(undefined),
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
  it("does not auto-launch when document.hidden is true (issue #7201 guard)", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
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
  it("waits for app hydration before launching a persisted-open assistant", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    const { rerender } = render(<HelpPanel width={380} isReadyToLaunch={false} />);

    expect(mockGetFolderPath).not.toHaveBeenCalled();
    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();

    await act(async () => {
      rerender(<HelpPanel width={380} isReadyToLaunch />);
    });

    expect(mockProvisionSession).toHaveBeenCalledWith({
      projectId: "proj-default",
      projectPath: "/repo",
      agentId: "claude",
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude", cwd: "/help" }),
      { source: "user" }
    );
  });

  it("waits for a current project before provisioning and launching", async () => {
    projectStoreState.currentProject = null;
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    const { rerender } = render(<HelpPanel width={380} />);

    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();

    projectStoreState.currentProject = { id: "proj-late", path: "/late-repo" };
    await act(async () => {
      rerender(<HelpPanel width={380} />);
    });

    expect(mockProvisionSession).toHaveBeenCalledWith({
      projectId: "proj-late",
      projectPath: "/late-repo",
      agentId: "claude",
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
  });

  it("does not launch the terminal when session provisioning returns null", async () => {
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockProvisionSession.mockResolvedValueOnce(null);

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
    );
  });

  it("does not auto-launch when document.hidden is true (issue #7201 guard)", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    helpPanelState.preferredAgentId = "claude";
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "auto-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(helpPanelState.setTerminal).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
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

  it("provisions and dispatches a Codex assistant launch when codex is the preferred agent", async () => {
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);
    helpPanelState.preferredAgentId = "codex";
    mockProvisionSession.mockResolvedValue({
      sessionId: "sess-codex",
      sessionPath: "/help-codex",
      token: "tok-codex",
      tier: "action",
      mcpUrl: "http://127.0.0.1:45454/mcp",
      windowId: 1,
    });
    mockGetFolderPath.mockResolvedValue("/help");
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "codex-term-1" } });

    await act(async () => {
      render(<HelpPanel width={380} />);
    });

    expect(mockProvisionSession).toHaveBeenCalledWith({
      projectId: "proj-default",
      projectPath: "/repo",
      agentId: "codex",
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentId: "codex",
        cwd: "/help-codex",
        env: expect.objectContaining({
          DAINTREE_MCP_TOKEN: "tok-codex",
          DAINTREE_MCP_URL: "http://127.0.0.1:45454/mcp",
        }),
      }),
      { source: "user" }
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("codex-term-1", "codex", "sess-codex");
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

  it("hides the banner when any panel has launchAgentId (hasEverLaunchedAgent gate)", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.introDismissed = false;
    panelStoreState.panelIds = ["term-1", "other-1"];
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
      "other-1": { id: "other-1", kind: "terminal", launchAgentId: "claude" },
    };

    const { container } = render(<HelpPanel width={380} />);

    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
  });

  it("hides the banner when any panel has everDetectedAgent (persisted across restarts)", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    helpPanelState.introDismissed = false;
    panelStoreState.panelIds = ["term-1", "other-1"];
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
      "other-1": { id: "other-1", kind: "terminal", everDetectedAgent: true },
    };

    const { container } = render(<HelpPanel width={380} />);

    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
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
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "terminal-restarted" } });

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    expect(panelStoreState.removePanel).toHaveBeenCalledWith("gate-1");
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentId: "claude",
        cwd: "/help",
        requestedId: expect.stringMatching(/^terminal-/),
        activateDockOnCreate: true,
        ephemeral: true,
        force: true,
      }),
      { source: "user" }
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      "terminal-restarted",
      "claude",
      "sess-default"
    );
    expect(mockMarkTerminal).toHaveBeenCalledWith("terminal-restarted");
  });

  it("notifies and reverts the reserved help-terminal id on addPanel rejection", async () => {
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
    mockDispatch.mockResolvedValue({ ok: false });

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    // The pre-set fired once (reserving the slot), then clearTerminal reverted it
    // when dispatch returned !ok — so no second setTerminal call carrying a session id.
    expect(helpPanelState.setTerminal).toHaveBeenCalledTimes(1);
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      expect.stringMatching(/^terminal-/),
      "claude",
      null
    );
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
    );
  });

  it("reserves the new help-terminal id BEFORE dispatch resolves (race fix for #6951)", async () => {
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

    // Hold dispatch resolution until after we've inspected store state.
    let resolveDispatch: (value: unknown) => void = () => {};
    mockDispatch.mockImplementation(() => {
      return new Promise((r) => {
        resolveDispatch = r;
      });
    });

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    // Capture the requestedId from the dispatch call.
    const capturedRequestedId = (
      mockDispatch.mock.calls[0]?.[1] as { requestedId?: string } | undefined
    )?.requestedId;

    // setTerminal fired with the pre-generated id while dispatch is still pending.
    expect(capturedRequestedId).toMatch(/^terminal-/);
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(capturedRequestedId, "claude", null);

    await act(async () => {
      resolveDispatch({ ok: true, result: { terminalId: capturedRequestedId! } });
    });
  });

  it("reverts the reserved id when provisionHelpSession returns a non-ok outcome", async () => {
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
    projectStoreState.currentProject = { id: "proj-1", path: "/repo" };
    const mcpErr = new Error("MCP server not ready") as Error & { code: string };
    mcpErr.code = "MCP_NOT_READY";
    mockProvisionSession.mockRejectedValueOnce(mcpErr);

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    // Pre-set fired, then was reverted by the !outcome.ok branch.
    expect(helpPanelState.setTerminal).toHaveBeenCalledTimes(1);
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(panelStoreState.addPanel).not.toHaveBeenCalled();
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
    mockDispatch.mockResolvedValue({ ok: false });

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    expect(mockRevokeSession).toHaveBeenCalledWith("leaked-sess");
  });

  it("forwards fresh customArgs from settings to agent.launch dispatch", async () => {
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
    mockGetHelpAssistantSettings.mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      tier: "action" as const,
      bypassPermissions: false,
      auditRetention: 7,
      customArgs: "--model sonnet",
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "restarted-term" } });

    const { getByTestId } = render(<HelpPanel width={380} />);

    await act(async () => {
      fireEvent.click(getByTestId("run-anyway"));
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentLaunchFlags: ["--model", "sonnet"],
        force: true,
      }),
      { source: "user" }
    );
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
      agentId: "claude",
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

    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      "term-gemini",
      "gemini",
      "sess-default"
    );
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
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      "auto-skip-term",
      "claude",
      "sess-default"
    );
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

describe("HelpPanel — empty state hero (Daintree-relevant entry points)", () => {
  it("renders the value-prop sentence and the two navigation links when no preferred agent and multiple supported agents installed", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { findByRole, getByText } = render(<HelpPanel width={380} />);

    expect(getByText(/Use Daintree Assistant to configure and navigate Daintree/i)).toBeTruthy();
    expect(await findByRole("button", { name: "Assistant settings" })).toBeTruthy();
    expect(await findByRole("button", { name: "Daintree Assistant guide" })).toBeTruthy();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches app.settings.openTab with tab='assistant' when the empty-state settings link is clicked", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { findByRole } = render(<HelpPanel width={380} />);

    const button = await findByRole("button", { name: "Assistant settings" });
    fireEvent.click(button);

    expect(mockDispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "assistant" },
      { source: "user" }
    );
  });

  it("dispatches system.openExternal with the assistant docs URL when the empty-state guide link is clicked", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { findByRole } = render(<HelpPanel width={380} />);

    const button = await findByRole("button", { name: "Daintree Assistant guide" });
    fireEvent.click(button);

    expect(mockDispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://daintree.org/assistant" },
      { source: "user" }
    );
  });

  it("dispatches navigation actions (not agent.launch) when the empty-state links are clicked", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "missing", codex: "missing" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { findByRole } = render(<HelpPanel width={380} />);

    const settings = await findByRole("button", { name: "Assistant settings" });
    const docs = await findByRole("button", { name: "Daintree Assistant guide" });

    fireEvent.click(settings);
    fireEvent.click(docs);

    expect(mockProvisionSession).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "assistant" },
      { source: "user" }
    );
    expect(mockDispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://daintree.org/assistant" },
      { source: "user" }
    );
    expect(mockDispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
  });

  it("renders the title-bar help button that dispatches system.openExternal with the assistant docs URL", async () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { findByRole } = render(<HelpPanel width={380} />);

    const help = await findByRole("button", { name: "Open assistant docs" });
    fireEvent.click(help);

    expect(mockDispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://daintree.org/assistant" },
      { source: "user" }
    );
  });

  it("renders the title-bar help button even when a terminal session is active", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { queryByRole } = render(<HelpPanel width={380} />);

    expect(queryByRole("button", { name: "Open assistant docs" })).not.toBeNull();
  });

  it("does not render a duplicate 'Assistant settings' footer link (empty state)", () => {
    helpPanelState.preferredAgentId = null;
    cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
    mockGetAssistantSupportedAgentIds.mockReturnValue(["claude", "codex"]);

    const { queryAllByRole } = render(<HelpPanel width={380} />);

    const matches = queryAllByRole("button", { name: "Assistant settings" });
    expect(matches.length).toBe(1);
  });

  it("does not render any 'Assistant settings' button when a terminal session is active", () => {
    helpPanelState.terminalId = "term-1";
    helpPanelState.agentId = "claude";
    panelStoreState.panelsById = {
      "term-1": { id: "term-1", kind: "terminal", spawnStatus: "ready", cwd: "/help" },
    };

    const { queryAllByRole } = render(<HelpPanel width={380} />);

    const matches = queryAllByRole("button", { name: "Assistant settings" });
    expect(matches.length).toBe(0);
  });
});

describe("HelpPanel — customArgs threading", () => {
  it("passes customArgs as agentLaunchFlags in the agent.launch dispatch payload", async () => {
    mockGetHelpAssistantSettings.mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      tier: "action" as const,
      bypassPermissions: false,
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
      tier: "action" as const,
      bypassPermissions: false,
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
      tier: "action" as const,
      bypassPermissions: false,
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
      tier: "action" as const,
      bypassPermissions: false,
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
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith("term-1", "claude", "sess-default");
  });
});

describe("HelpPanel — close hides without tearing down the agent", () => {
  it.each([
    ["idle", false],
    ["working", false],
    ["waiting", true],
    ["directing", true],
    ["completed", true],
    ["exited", true],
  ] as const)(
    "hides the panel without removing the terminal or revoking the session (%s, touched=%s)",
    (state, conversationTouched) => {
      helpPanelState.terminalId = "term-1";
      helpPanelState.agentId = "claude";
      helpPanelState.sessionId = "sess-bound";
      helpPanelState.conversationTouched = conversationTouched;
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
      fireEvent.click(container.querySelector('button[aria-label="Hide Daintree Assistant"]')!);

      expect(queryByTestId("confirm-dialog")).toBeNull();
      expect(panelStoreState.removePanel).not.toHaveBeenCalled();
      expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
      expect(mockRevokeSession).not.toHaveBeenCalled();
      expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
    }
  );

  it("Escape hides the panel via the same non-destructive path", () => {
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

    render(<HelpPanel width={380} />);

    const escapeMock = vi.mocked(useEscapeStack);
    const callback = escapeMock.mock.calls.at(-1)?.[1];
    expect(callback).toBeTypeOf("function");

    act(() => {
      callback?.();
    });

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
    expect(helpPanelState.setOpen).toHaveBeenCalledWith(false);
  });

  it("marks conversation started when agent state leaves idle on mount", () => {
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

    render(<HelpPanel width={380} />);

    expect(helpPanelState.markConversationStarted).toHaveBeenCalled();
  });

  it("does not mark conversation started when agent state is idle on mount", () => {
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

    render(<HelpPanel width={380} />);

    expect(helpPanelState.markConversationStarted).not.toHaveBeenCalled();
  });

  it("does not mark conversation started after clearTerminal (stale guard)", () => {
    // Simulate: terminal was set but clearTerminal was called before render.
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    panelStoreState.panelsById = {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        spawnStatus: "ready",
        cwd: "/help",
        agentState: "working",
      },
    };

    render(<HelpPanel width={380} />);

    expect(helpPanelState.markConversationStarted).not.toHaveBeenCalled();
  });
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

  it("hides the + button when there is no live terminal", () => {
    helpPanelState.terminalId = null;
    helpPanelState.agentId = null;
    const { container } = render(<HelpPanel width={380} />);
    expect(container.querySelector('button[aria-label="Start new session"]')).toBeNull();
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
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
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
        ephemeral: true,
      }),
      { source: "user" }
    );
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
      "terminal-fresh",
      "claude",
      "sess-fresh"
    );
  });

  it("shows the confirm dialog when the agent is working", () => {
    setupBoundTerminal({ agentState: "working", conversationTouched: false });

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(helpPanelState.clearTerminal).not.toHaveBeenCalled();
    expect(getByTestId("dialog-title").textContent).toBe("Start a new session?");
    expect(getByTestId("dialog-confirm").textContent).toBe("Start new session");
    expect(getByTestId("dialog-description").textContent).toContain(
      "the conversation will be discarded"
    );
  });

  it("shows the confirm dialog when the conversation has been touched", () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: true });

    const { container, getByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);

    expect(panelStoreState.removePanel).not.toHaveBeenCalled();
    expect(getByTestId("dialog-title").textContent).toBe("Start a new session?");
  });

  it("keeps the session intact when the user cancels the confirm dialog", () => {
    setupBoundTerminal({ agentState: "working" });

    const { container, getByTestId, queryByTestId } = render(<HelpPanel width={380} />);
    fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
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
    fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    await act(async () => {
      fireEvent.click(getByTestId("dialog-confirm"));
    });

    expect(panelStoreState.removePanel).toHaveBeenCalledWith("term-1");
    expect(mockRevokeSession).toHaveBeenCalledWith("sess-bound");
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(
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
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    });

    // Pre-set already fired with the same id we passed as requestedId.
    const capturedRequestedId = (
      mockDispatch.mock.calls[0]?.[1] as { requestedId?: string } | undefined
    )?.requestedId;
    expect(capturedRequestedId).toMatch(/^terminal-/);
    expect(helpPanelState.setTerminal).toHaveBeenCalledWith(capturedRequestedId, "claude", null);

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
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
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
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
    });

    // setTerminal called once (pre-set), then clearTerminal reverted it on !ok.
    // setTerminal must NOT be called again with a session id.
    const setCalls = (helpPanelState.setTerminal as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls.length).toBe(1);
    expect(setCalls[0]?.[2]).toBeNull();
    expect(helpPanelState.clearTerminal).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Assistant launch failed" })
    );
  });

  it("reverts the reserved id when provisionHelpSession returns a non-ok outcome", async () => {
    setupBoundTerminal({ agentState: "idle", conversationTouched: false });
    const mcpErr = new Error("MCP server not ready") as Error & { code: string };
    mcpErr.code = "MCP_NOT_READY";
    mockProvisionSession.mockRejectedValueOnce(mcpErr);

    const { container } = render(<HelpPanel width={380} />);
    await act(async () => {
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
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
      .mockImplementation((tId: string, aId: string, sId: string | null) => {
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
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
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
      fireEvent.click(container.querySelector('button[aria-label="Start new session"]')!);
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
