import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CliAvailability } from "@shared/types";

const {
  mockDispatch,
  mockGetContext,
  mockNotify,
  mockGetAgentPrefsState,
  mockGetCliAvailabilityState,
  mockGetAgentSettingsState,
  mockGetProjectState,
  mockGetScratchState,
  mockLogError,
  mockRemovePanel,
} = vi.hoisted(() => ({
  mockDispatch: vi.fn().mockResolvedValue({ ok: true }),
  mockGetContext: vi.fn(() => ({})),
  mockNotify: vi.fn().mockReturnValue(""),
  mockGetAgentPrefsState: vi.fn(),
  mockGetCliAvailabilityState: vi.fn(),
  mockGetAgentSettingsState: vi.fn(),
  mockGetProjectState: vi.fn(),
  mockGetScratchState: vi.fn(),
  mockLogError: vi.fn(),
  mockRemovePanel: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: mockDispatch, getContext: mockGetContext },
}));

vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

vi.mock("@/store/agentPreferencesStore", () => ({
  useAgentPreferencesStore: { getState: () => mockGetAgentPrefsState() },
}));

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: { getState: () => mockGetCliAvailabilityState() },
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: { getState: () => mockGetAgentSettingsState() },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => mockGetProjectState() },
}));

// The launch path tears its own PTY down when the lane it was minted for is
// closed mid-flight (#12108); the real panel store is far too heavy for this
// node-environment suite, and only `removePanel` is reached.
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ removePanel: mockRemovePanel }) },
}));

// Leaf-path mock, mirroring the projectStore one — the action reads the scratch
// pointer as its workspace fallback (#11068).
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: { getState: () => mockGetScratchState() },
}));

vi.mock("@/utils/logger", () => ({
  logError: (...args: unknown[]) => mockLogError(...args),
}));

vi.mock("@/lib/sidebarToggle", () => ({
  suppressSidebarResizes: vi.fn(),
}));

import { registerHelpActions } from "../helpActions";
import {
  markHelpPanelRuntimeMounted,
  onHelpPanelRuntimeRequested,
  resetHelpPanelRuntimeGateForTests,
} from "@/lib/helpPanelRuntimeGate";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { AnyActionDefinition } from "../../actionTypes";

const stubCtx: ActionContext = {};

function allAvailability(override?: Partial<CliAvailability>): CliAvailability {
  return {
    claude: "ready",
    gemini: "ready",
    codex: "ready",
    opencode: "ready",
    ...override,
  } as CliAvailability;
}

function extractHelpLaunchAgent(): AnyActionDefinition {
  const registry = new Map<string, () => AnyActionDefinition>();
  const callbacks = { onOpenShortcuts: vi.fn() } as unknown as ActionCallbacks;
  registerHelpActions(registry as unknown as ActionRegistry, callbacks);
  const factory = registry.get("help.launchAgent");
  if (!factory) throw new Error("help.launchAgent not registered");
  return factory();
}

describe("help.launchAgent", () => {
  let action: AnyActionDefinition;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations; several tests swap these in.
    mockDispatch.mockReset().mockResolvedValue({ ok: true });
    mockGetContext.mockReset().mockImplementation(() => ({}));
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: undefined });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability(),
      isInitialized: true,
    });
    mockGetAgentSettingsState.mockReturnValue({
      settings: { agents: {} },
    });
    Object.defineProperty(globalThis, "window", {
      value: {
        electron: {
          help: {
            getFolderPath: vi.fn(),
            provisionSession: vi.fn().mockResolvedValue({
              sessionId: "sess-default",
              sessionPath: "/mock/help",
              token: "tok-default",
              tier: "core",
              mcpUrl: null,
              windowId: 1,
            }),
            revokeSession: vi.fn().mockResolvedValue(undefined),
            markTerminal: vi.fn().mockResolvedValue(undefined),
          },
          helpAssistant: {
            getSettings: vi.fn().mockResolvedValue({ modelIds: {}, customArgs: "" }),
          },
          agentCapabilities: {
            getResolvedModelList: vi.fn().mockResolvedValue(null),
          },
        },
      },
      writable: true,
      configurable: true,
    });
    mockGetProjectState.mockReturnValue({
      currentProject: { id: "proj-default", path: "/repo" },
      isBootstrapped: true,
    });
    mockGetScratchState.mockReturnValue({ currentScratch: null });
    resetHelpPanelRuntimeGateForTests();
    markHelpPanelRuntimeMounted();
    // A successful launch binds a lane, and a bound lane changes where the next
    // launch goes (#13192) — every test starts from one empty tab.
    useHelpPanelStore.setState(useHelpPanelStore.getInitialState(), true);
    action = extractHelpLaunchAgent();
  });

  it("asks for the assistant panel and binds nothing until it has mounted", async () => {
    // HelpPanel mounts lazily; its lane runtimes hold the session listeners,
    // which don't replay — so the session must not be provisioned before them.
    resetHelpPanelRuntimeGateForTests();
    const requested = vi.fn();
    onHelpPanelRuntimeRequested(requested);
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );

    const run = action.run(undefined, stubCtx);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requested).toHaveBeenCalledTimes(1);
    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();

    markHelpPanelRuntimeMounted();
    await run;

    expect(window.electron.help.provisionSession).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith("agent.launch", expect.anything(), expect.anything());
  });

  it("still launches if the assistant panel never mounts", async () => {
    vi.useFakeTimers();
    try {
      resetHelpPanelRuntimeGateForTests();
      (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
        "/mock/help"
      );
      const run = action.run(undefined, stubCtx);
      await vi.advanceTimersByTimeAsync(5000);
      await run;
      expect(window.electron.help.provisionSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches agent.launch with first available agent when no default set", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: undefined });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability(),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    expect(window.electron.help.getFolderPath).toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude", cwd: "/mock/help", location: "overlay" }),
      { source: "user" }
    );
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("runs the Daintree Assistant in the project root, not the provisioned session dir", async () => {
    // The assistant is env-only and ships its own skills, so it reads nothing
    // from cwd — it should operate on the actual project files. Same mock setup
    // as the non-assistant case below; only the cwd differs.
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );

    await action.run({ agentId: "daintree-assistant" }, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "daintree-assistant", cwd: "/repo" }),
      { source: "user" }
    );
  });

  it("keeps a non-assistant help agent in the provisioned session dir", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );

    await action.run({ agentId: "codex" }, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "codex", cwd: "/mock/help" }),
      { source: "user" }
    );
  });

  it("launches with the CLI default model and custom args", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    (window.electron.helpAssistant.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelIds: {},
      customArgs: "--verbose",
    });

    await action.run({ agentId: "codex" }, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentId: "codex",
        agentLaunchFlags: ["--verbose"],
      }),
      { source: "user" }
    );
  });

  it("adds no launch flags for an explicit CLI default", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    (window.electron.helpAssistant.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelIds: { claude: "" },
      customArgs: "",
    });

    await action.run({ agentId: "claude" }, stubCtx);

    const payload = mockDispatch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("agentLaunchFlags");
  });

  it("never launches an agent with a model saved for a different agent", async () => {
    vi.mocked(window.electron.help.getFolderPath).mockResolvedValue("/mock/help");
    vi.mocked(window.electron.helpAssistant.getSettings).mockResolvedValue({
      docSearch: true,
      daintreeControl: true,
      runbookSearch: true,
      tier: "core",
      bypassPermissions: false,
      auditRetention: 7,
      modelIds: { claude: "opus" },
      customArgs: "",
      idleHibernateMinutes: 5,
      debugLogging: false,
      loadGlobalHooksAndServers: false,
      daintreeConfirmations: "inherit",
    });

    await action.run({ agentId: "codex" }, stubCtx);

    const [, dispatchArg] = mockDispatch.mock.calls[0] ?? [];
    expect(dispatchArg).toMatchObject({ agentId: "codex" });
    expect(dispatchArg).not.toHaveProperty("agentLaunchFlags");
  });

  it("uses the user's preferred default agent when available", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "codex" });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability(),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "codex", cwd: "/mock/help", location: "overlay" }),
      { source: "user" }
    );
  });

  it("skips a preferred default the assistant gate would refuse (#12262)", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    // Gemini is installed and launchable from the toolbar, but its supports
    // block sits at `tier: "deprecated"`, so `provisionSession` refuses it.
    // The implicit default has to skip it rather than resolve into that
    // refusal — this suite mocks provisioning, so nothing else would notice.
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "gemini" });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability(),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "gemini" }),
      { source: "user" }
    );
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude", cwd: "/mock/help", location: "overlay" }),
      { source: "user" }
    );
  });

  it("falls back to first available agent when default is unavailable", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "codex" });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability({ codex: "missing" }),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude", cwd: "/mock/help", location: "overlay" }),
      { source: "user" }
    );
  });

  it("resolves to codex when claude, opencode, and gemini are unavailable", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: undefined });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability({
        claude: "missing",
        opencode: "missing",
        gemini: "missing",
      }),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "codex", cwd: "/mock/help", location: "overlay" }),
      { source: "user" }
    );
  });

  it("falls back to claude when CLI availability store is not initialized", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: undefined });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability({
        claude: "missing",
        gemini: "missing",
        codex: "missing",
        opencode: "missing",
      }),
      isInitialized: false,
    });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude", cwd: "/mock/help", location: "overlay" }),
      { source: "user" }
    );
  });

  it("uses agentId from args when provided", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "claude" });

    await action.run({ agentId: "codex" }, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "codex", cwd: "/mock/help", location: "overlay" }),
      { source: "user" }
    );
  });

  it("shows notification and does not dispatch when help folder is null", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await action.run(undefined, stubCtx);

    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Help agent",
      })
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("has correct metadata", () => {
    expect(action.id).toBe("help.launchAgent");
    expect(action.category).toBe("help");
    expect(action.kind).toBe("command");
    expect(action.danger).toBe("safe");
    expect(action.scope).toBe("renderer");
  });

  it("does not pass a model arg, even when stale assistantModelId is persisted in agent settings", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentSettingsState.mockReturnValue({
      settings: { agents: { claude: { assistantModelId: "claude-opus-4-6" } } },
    });

    await action.run(undefined, stubCtx);

    const firstCall = mockDispatch.mock.calls[0];
    const dispatchArg = firstCall?.[1] as Record<string, unknown> | undefined;
    expect(dispatchArg).toBeDefined();
    expect(dispatchArg).not.toHaveProperty("model");
    expect(dispatchArg).not.toHaveProperty("modelId");
    expect(dispatchArg).not.toHaveProperty("agentModelId");
  });

  it("provisions a help session and threads sessionPath as cwd with full DAINTREE_* env when a project is active", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetProjectState.mockReturnValue({
      currentProject: { id: "proj-1", path: "/repo" },
    });
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "sess-1",
      sessionPath: "/sessions/sess-1",
      token: "tok-abc",
      tier: "core",
      mcpUrl: "http://127.0.0.1:45454/sse",
      windowId: 5,
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await action.run(undefined, stubCtx);

    expect(window.electron.help.provisionSession).toHaveBeenCalledWith({
      projectId: "proj-1",
      projectPath: "/repo",
      agentId: "claude",
      context: {},
      // #12108: the action names its lane explicitly rather than letting main
      // default it, so the session it mints is the one it binds into.
      slot: 0,
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentId: "claude",
        cwd: "/sessions/sess-1",
        env: {
          DAINTREE_MCP_TOKEN: "tok-abc",
          DAINTREE_MCP_URL: "http://127.0.0.1:45454/sse",
          DAINTREE_WINDOW_ID: "5",
          DAINTREE_PROJECT_ID: "proj-1",
        },
      }),
      { source: "user" }
    );
  });

  it("snapshots the action context synchronously before the getFolderPath await (#8317)", async () => {
    // getContext returns the value captured at call time. Resolve
    // getFolderPath only after we've mutated what getContext would return —
    // proving the capture happened on the synchronous first line, not after
    // the await (the stale-read race this fix closes; lesson #5087).
    mockGetContext.mockReturnValue({ focusedWorktreeId: "wt-at-launch" });
    let resolveFolder: (v: string) => void = () => {};
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<string>((r) => {
        resolveFolder = r;
      })
    );
    mockGetProjectState.mockReturnValue({
      currentProject: { id: "proj-1", path: "/repo" },
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    const runPromise = action.run(undefined, stubCtx);
    // Focus drifts while getFolderPath is still pending.
    mockGetContext.mockReturnValue({ focusedWorktreeId: "wt-drifted" });
    resolveFolder("/mock/help");
    await runPromise;

    expect(window.electron.help.provisionSession).toHaveBeenCalledWith(
      expect.objectContaining({ context: { focusedWorktreeId: "wt-at-launch" } })
    );
  });

  // #11068: switching to a scratch clears `currentProject` by design, so the
  // action must fall back to the scratch pointer instead of reporting that
  // project state is "still loading" and refusing to launch.
  it("provisions against the active scratch when no project is active", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetProjectState.mockReturnValue({ currentProject: null, isBootstrapped: true });
    mockGetScratchState.mockReturnValue({
      currentScratch: { id: "scratch-1", path: "/scratches/scratch-1" },
    });
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "sess-s1",
      sessionPath: "/sessions/sess-s1",
      token: "tok-s1",
      tier: "core",
      mcpUrl: null,
      windowId: 3,
    });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await action.run(undefined, stubCtx);

    expect(window.electron.help.provisionSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "scratch-1",
        projectPath: "/scratches/scratch-1",
        agentId: "claude",
      })
    );
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        env: expect.objectContaining({ DAINTREE_PROJECT_ID: "scratch-1" }),
      }),
      { source: "user" }
    );
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("runs the assistant in the scratch root when a scratch is the active workspace", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetProjectState.mockReturnValue({ currentProject: null, isBootstrapped: true });
    mockGetScratchState.mockReturnValue({
      currentScratch: { id: "scratch-1", path: "/scratches/scratch-1" },
    });

    await action.run({ agentId: "daintree-assistant" }, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({
        agentId: "daintree-assistant",
        cwd: "/scratches/scratch-1",
      }),
      { source: "user" }
    );
  });

  it("prefers the project over a stale scratch pointer when both are somehow set", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetProjectState.mockReturnValue({
      currentProject: { id: "proj-1", path: "/repo" },
      isBootstrapped: true,
    });
    mockGetScratchState.mockReturnValue({
      currentScratch: { id: "scratch-1", path: "/scratches/scratch-1" },
    });

    await action.run(undefined, stubCtx);

    expect(window.electron.help.provisionSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", projectPath: "/repo" })
    );
  });

  it("reports no active workspace — not 'still loading' — when project state has settled empty", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetProjectState.mockReturnValue({ currentProject: null, isBootstrapped: true });
    mockGetScratchState.mockReturnValue({ currentScratch: null });
    mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });

    await action.run(undefined, stubCtx);

    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("No project or scratch workspace is active"),
      })
    );
  });

  it("still reports loading when project state has not bootstrapped yet", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetProjectState.mockReturnValue({ currentProject: null, isBootstrapped: false });
    mockGetScratchState.mockReturnValue({ currentScratch: null });

    await action.run(undefined, stubCtx);

    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("still loading"),
      })
    );
  });

  it("does not launch when provisioning returns null", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await action.run(undefined, stubCtx);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Assistant couldn't start",
      })
    );
  });

  it("does not launch when provisioning reports the assistant services aren't ready", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    const err = new Error("port collision") as Error & { code: string };
    err.code = "MCP_SERVER_NOT_STARTED";
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);

    await action.run(undefined, stubCtx);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Assistant couldn't start",
        message: expect.stringContaining("assistant services didn't start"),
      })
    );
  });

  it("revokes the session when agent.launch fails", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetProjectState.mockReturnValue({
      currentProject: { id: "proj-1", path: "/repo" },
    });
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "sess-fail",
      sessionPath: "/sessions/sess-fail",
      token: "tok-fail",
      tier: "core",
      mcpUrl: null,
      windowId: 1,
    });
    mockDispatch.mockResolvedValue({ ok: false });

    await action.run(undefined, stubCtx);

    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-fail");
  });

  it("revokes and removes the terminal when the lane is closed mid-launch (#12108)", async () => {
    // The lane is read before the provision await and used to bind after the
    // dispatch. `setTerminal` refuses a lane that is gone, so without an
    // explicit teardown the spawned PTY would keep a live bearer while
    // belonging to no lane — and no longer be filtered out of the dock.
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetProjectState.mockReturnValue({
      currentProject: { id: "proj-1", path: "/repo" },
      isBootstrapped: true,
    });
    (window.electron.help.provisionSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "sess-orphan",
      sessionPath: "/sessions/sess-orphan",
      token: "tok-orphan",
      tier: "core",
      mcpUrl: null,
      windowId: 1,
    });

    const lane = useHelpPanelStore.getState().openSlot();
    expect(lane).toBe(1);
    // The user hits the tab's close button while provision/dispatch is still
    // outstanding.
    mockDispatch.mockImplementation(async () => {
      useHelpPanelStore.getState().closeSlot(1);
      return { ok: true, result: { terminalId: "term-orphan" } };
    });

    try {
      await action.run(undefined, stubCtx);
    } finally {
      mockDispatch.mockReset();
      useHelpPanelStore.setState({ sessions: { 0: useHelpPanelStore.getState().sessions[0]! } });
      useHelpPanelStore.getState().setActiveSlot(0);
    }

    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-orphan");
    expect(mockRemovePanel).toHaveBeenCalledWith("term-orphan");
    expect(window.electron.help.markTerminal).not.toHaveBeenCalled();
    expect(useHelpPanelStore.getState().sessions[1]).toBeUndefined();
  });

  describe("lane choice (#13192)", () => {
    function provisionedSlot(): unknown {
      return vi.mocked(window.electron.help.provisionSession).mock.calls[0]?.[0]?.slot;
    }

    beforeEach(() => {
      vi.mocked(window.electron.help.getFolderPath).mockResolvedValue("/mock/help");
      mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: "term-help" } });
    });

    it("sends the help prompt without the Electron framing", async () => {
      await action.run(undefined, stubCtx);

      expect(mockDispatch).toHaveBeenCalledWith(
        "agent.launch",
        expect.objectContaining({
          prompt:
            "I need help with Daintree, an IDE for orchestrating AI coding agents. Please briefly tell me how you can help.",
        }),
        expect.anything()
      );
    });

    it("launches into the active tab when it is empty", async () => {
      await action.run(undefined, stubCtx);

      expect(provisionedSlot()).toBe(0);
      const state = useHelpPanelStore.getState();
      expect(state.sessions[0]?.terminalId).toBe("term-help");
      expect(Object.keys(state.sessions)).toEqual(["0"]);
      expect(state.isOpen).toBe(true);
    });

    it("opens a new tab beside a live session and leaves that session alone", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "claude", "sess-live");

      await action.run(undefined, stubCtx);

      expect(provisionedSlot()).toBe(1);
      expect(window.electron.help.revokeSession).not.toHaveBeenCalled();
      expect(mockRemovePanel).not.toHaveBeenCalled();
      const state = useHelpPanelStore.getState();
      expect(state.sessions[0]).toMatchObject({ terminalId: "term-live", sessionId: "sess-live" });
      expect(state.sessions[1]).toMatchObject({
        terminalId: "term-help",
        agentId: "claude",
        sessionId: "sess-default",
      });
      expect(state.activeSlot).toBe(1);
      expect(state.isOpen).toBe(true);
    });

    it("selects the new tab and asks the panel to reveal it when the panel is already open", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "claude", "sess-live");
      useHelpPanelStore.getState().setOpen(true);
      const focusBefore = useHelpPanelStore.getState().focusRequest;

      await action.run(undefined, stubCtx);

      const state = useHelpPanelStore.getState();
      expect(state.activeSlot).toBe(1);
      expect(state.focusRequest).toBe(focusBefore + 1);
    });

    it("does not create the new tab until the session is bound", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "claude", "sess-live");
      let laneDuringLaunch: unknown = "unset";
      mockDispatch.mockImplementation(async () => {
        laneDuringLaunch = useHelpPanelStore.getState().sessions[1];
        return { ok: true, result: { terminalId: "term-help" } };
      });

      await action.run(undefined, stubCtx);

      // An empty lane mounted mid-launch could auto-launch its own session into
      // the slot this one was provisioned for.
      expect(laneDuringLaunch).toBeUndefined();
      expect(useHelpPanelStore.getState().sessions[1]?.terminalId).toBe("term-help");
    });

    it("prefers an existing empty tab over opening another", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "claude", "sess-live");
      useHelpPanelStore.getState().ensureSlot(2);

      await action.run(undefined, stubCtx);

      expect(provisionedSlot()).toBe(2);
      const state = useHelpPanelStore.getState();
      expect(state.sessions[1]).toBeUndefined();
      expect(state.sessions[2]?.terminalId).toBe("term-help");
      expect(state.activeSlot).toBe(2);
    });

    it("never launches over a tab holding a hibernated conversation", async () => {
      useHelpPanelStore.getState().setHibernateSession("proj-default", 0, {
        sessionId: "agent-s",
        cwd: "/repo",
        agentId: "claude",
      });

      await action.run(undefined, stubCtx);

      expect(provisionedSlot()).toBe(1);
      expect(useHelpPanelStore.getState().sessions[0]?.terminalId).toBeNull();
    });

    it("refuses without provisioning when every tab holds a session", async () => {
      const store = useHelpPanelStore.getState();
      store.setTerminal(0, "term-a", "claude", "sess-a");
      for (const slot of [1, 2]) {
        store.ensureSlot(slot);
        useHelpPanelStore.getState().setTerminal(slot, `term-${slot}`, "claude", `sess-${slot}`);
      }

      await action.run(undefined, stubCtx);

      expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
      expect(mockDispatch).not.toHaveBeenCalled();
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({ type: "warning", title: "Assistant tabs full" })
      );
      const state = useHelpPanelStore.getState();
      expect(state.sessions[0]?.terminalId).toBe("term-a");
      expect(state.activeSlot).toBe(0);
      expect(state.isOpen).toBe(true);
    });

    it("counts a closed tab's hibernated conversation as in use", async () => {
      const store = useHelpPanelStore.getState();
      store.setTerminal(0, "term-a", "claude", "sess-a");
      store.ensureSlot(1);
      useHelpPanelStore.getState().setTerminal(1, "term-b", "claude", "sess-b");
      useHelpPanelStore.getState().setHibernateSession("proj-default", 2, {
        sessionId: "agent-s",
        cwd: "/repo",
        agentId: "claude",
      });

      await action.run(undefined, stubCtx);

      expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
      expect(useHelpPanelStore.getState().sessions[2]).toBeUndefined();
    });

    it("joins the agent a sibling tab is running instead of the default", async () => {
      // Lanes of one project must share an agent; main refuses a mismatch.
      useHelpPanelStore.getState().setTerminal(0, "term-live", "codex", "sess-live");

      await action.run(undefined, stubCtx);

      expect(window.electron.help.provisionSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "codex", slot: 1 })
      );
      expect(mockDispatch).toHaveBeenCalledWith(
        "agent.launch",
        expect.objectContaining({ agentId: "codex" }),
        expect.anything()
      );
      expect(useHelpPanelStore.getState().sessions[1]?.agentId).toBe("codex");
    });

    it("joins the agent a hibernated sibling will resume with", async () => {
      useHelpPanelStore.getState().setHibernateSession("proj-default", 0, {
        sessionId: "agent-s",
        cwd: "/repo",
        agentId: "codex",
      });

      await action.run(undefined, stubCtx);

      expect(window.electron.help.provisionSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "codex", slot: 1 })
      );
    });

    it("joins a hibernated sibling's agent before CLI availability is known", async () => {
      mockGetCliAvailabilityState.mockReturnValue({ availability: {}, isInitialized: false });
      useHelpPanelStore.getState().setHibernateSession("proj-default", 0, {
        sessionId: "agent-s",
        cwd: "/repo",
        agentId: "codex",
      });

      await action.run(undefined, stubCtx);

      expect(window.electron.help.provisionSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "codex", slot: 1 })
      );
    });

    it("skips a hibernated sibling's agent the assistant can no longer run", async () => {
      // Gemini is a deprecated assistant tier: main refuses to provision it.
      useHelpPanelStore.getState().setHibernateSession("proj-default", 0, {
        sessionId: "agent-s",
        cwd: "/repo",
        agentId: "gemini",
      });

      await action.run(undefined, stubCtx);

      expect(window.electron.help.provisionSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude", slot: 1 })
      );
    });

    it("skips a hibernated sibling's agent once its CLI can't launch", async () => {
      mockGetCliAvailabilityState.mockReturnValue({
        availability: allAvailability({ codex: "missing" }),
        isInitialized: true,
      });
      useHelpPanelStore.getState().setHibernateSession("proj-default", 0, {
        sessionId: "agent-s",
        cwd: "/repo",
        agentId: "codex",
      });

      await action.run(undefined, stubCtx);

      expect(window.electron.help.provisionSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude", slot: 1 })
      );
    });

    it("ignores another workspace's hibernated lanes", async () => {
      useHelpPanelStore.getState().setHibernateSession("proj-other", 0, {
        sessionId: "agent-s",
        cwd: "/x",
        agentId: "gemini",
      });

      await action.run(undefined, stubCtx);

      expect(window.electron.help.provisionSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude", slot: 0 })
      );
    });

    it("keeps an explicit agent even when a sibling runs a different one", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "codex", "sess-live");

      await action.run({ agentId: "claude" }, stubCtx);

      expect(window.electron.help.provisionSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude", slot: 1 })
      );
    });

    it("surfaces main's mixed-agent refusal for an explicit mismatch and changes nothing", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "codex", "sess-live");
      vi.mocked(window.electron.help.provisionSession).mockRejectedValue(
        new Error("[HelpSessionError|MIXED_AGENT_LANES] Another session runs codex")
      );

      await action.run({ agentId: "claude" }, stubCtx);

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          message: expect.stringContaining(
            "Another session in this project is running a different agent"
          ),
        })
      );
      const state = useHelpPanelStore.getState();
      expect(Object.keys(state.sessions)).toEqual(["0"]);
      expect(state.sessions[0]?.terminalId).toBe("term-live");
      expect(state.activeSlot).toBe(0);
    });

    it("leaves no tab behind when provisioning a new slot throws", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "claude", "sess-live");
      vi.mocked(window.electron.help.provisionSession).mockRejectedValue(new Error("boom"));

      await action.run(undefined, stubCtx);

      expect(provisionedSlot()).toBe(1);
      expect(mockDispatch).not.toHaveBeenCalled();
      expect(useHelpPanelStore.getState().sessions[1]).toBeUndefined();
      expect(useHelpPanelStore.getState().activeSlot).toBe(0);
    });

    it("revokes once and creates no tab when the launch yields no terminal", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "claude", "sess-live");
      mockDispatch.mockResolvedValue({ ok: true, result: { terminalId: null } });

      await action.run(undefined, stubCtx);

      expect(window.electron.help.revokeSession).toHaveBeenCalledTimes(1);
      expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-default");
      expect(window.electron.help.markTerminal).not.toHaveBeenCalled();
      expect(useHelpPanelStore.getState().sessions[1]).toBeUndefined();
    });

    it("sends overlapping launches to different slots", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "claude", "sess-live");
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let provisionCount = 0;
      vi.mocked(window.electron.help.provisionSession).mockImplementation(async (input) => {
        provisionCount += 1;
        if (provisionCount === 1) await firstHeld;
        return {
          sessionId: `sess-${input.slot}`,
          sessionPath: "/mock/help",
          token: "tok",
          tier: "core",
          mcpUrl: null,
          windowId: 1,
        };
      });
      let dispatchCount = 0;
      mockDispatch.mockImplementation(async () => {
        dispatchCount += 1;
        return { ok: true, result: { terminalId: `term-help-${dispatchCount}` } };
      });

      const first = action.run(undefined, stubCtx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = action.run(undefined, stubCtx);
      await second;
      releaseFirst();
      await first;

      const slots = vi
        .mocked(window.electron.help.provisionSession)
        .mock.calls.map(([input]) => input.slot)
        .sort();
      expect(slots).toEqual([1, 2]);
      const state = useHelpPanelStore.getState();
      expect(state.sessions[0]?.terminalId).toBe("term-live");
      expect(state.sessions[1]?.sessionId).toBe("sess-1");
      expect(state.sessions[2]?.sessionId).toBe("sess-2");
    });

    it("does not overwrite a reused tab that another launch bound mid-flight", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "claude", "sess-live");
      useHelpPanelStore.getState().ensureSlot(2);
      mockDispatch.mockImplementation(async () => {
        useHelpPanelStore.getState().setTerminal(2, "term-user", "claude", "sess-user");
        return { ok: true, result: { terminalId: "term-help" } };
      });

      await action.run(undefined, stubCtx);

      expect(provisionedSlot()).toBe(2);
      expect(useHelpPanelStore.getState().sessions[2]).toMatchObject({
        terminalId: "term-user",
        sessionId: "sess-user",
      });
      expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-default");
      expect(mockRemovePanel).toHaveBeenCalledWith("term-help");
      expect(window.electron.help.markTerminal).not.toHaveBeenCalled();
    });

    it("leaves no tab behind when the launch into a new slot fails", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "claude", "sess-live");
      mockDispatch.mockResolvedValue({ ok: false });

      await action.run(undefined, stubCtx);

      expect(provisionedSlot()).toBe(1);
      expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-default");
      const state = useHelpPanelStore.getState();
      expect(state.sessions[1]).toBeUndefined();
      expect(state.activeSlot).toBe(0);
      expect(state.sessions[0]?.terminalId).toBe("term-live");
    });

    it("tears its session down when a tab claimed the new slot mid-launch", async () => {
      useHelpPanelStore.getState().setTerminal(0, "term-live", "claude", "sess-live");
      mockDispatch.mockImplementation(async () => {
        const store = useHelpPanelStore.getState();
        store.ensureSlot(1);
        useHelpPanelStore.getState().setTerminal(1, "term-other", "claude", "sess-other");
        return { ok: true, result: { terminalId: "term-help" } };
      });

      await action.run(undefined, stubCtx);

      expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-default");
      expect(mockRemovePanel).toHaveBeenCalledWith("term-help");
      expect(useHelpPanelStore.getState().sessions[1]?.terminalId).toBe("term-other");
    });
  });
});
