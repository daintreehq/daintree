import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  mockOpenTour,
  panelsById,
  controllers,
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
  mockOpenTour: vi.fn(),
  panelsById: {} as Record<string, unknown>,
  controllers: new Map<
    number,
    {
      launchWhenReady: ReturnType<typeof vi.fn>;
      getSnapshot: () => { phase: string };
      subscribe: (listener: () => void) => () => void;
      phase: string;
      listeners: Set<() => void>;
    }
  >(),
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
  usePanelStore: { getState: () => ({ panelsById, removePanel: mockRemovePanel }) },
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

vi.mock("@/components/Tour/tourEvents", () => ({ openTour: mockOpenTour }));

vi.mock("@/controllers/helpSessionControllerRegistry", () => ({
  acquireHelpSessionController: (slot: number) => {
    let controller = controllers.get(slot);
    if (!controller) {
      const listeners = new Set<() => void>();
      const created = {
        launchWhenReady: vi.fn(),
        phase: "idle",
        listeners,
        getSnapshot: () => ({ phase: created.phase }),
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      controller = created;
      controllers.set(slot, controller);
    }
    return controller;
  },
}));

import { registerHelpActions } from "../helpActions";
import {
  markHelpPanelRuntimeMounted,
  onHelpPanelRuntimeRequested,
  resetHelpPanelRuntimeGateForTests,
} from "@/lib/helpPanelRuntimeGate";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePaletteStore } from "@/store/paletteStore";
import { makePluginTourId } from "@shared/utils/tourIds";
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

const PROJECT = { id: "proj-1", path: "/repo" };

function extractAction(): AnyActionDefinition {
  const registry: ActionRegistry = new Map();
  // Only `onOpenShortcuts` is reachable from the help actions.
  const callbacks = { onOpenShortcuts: vi.fn() } as unknown as ActionCallbacks;
  registerHelpActions(registry, callbacks);
  const factory = registry.get("help.resumePastSession");
  if (!factory) throw new Error("help.resumePastSession not registered");
  return factory();
}

function bindLane(slot: number, terminalId: string, agentId: string, agentSessionId?: string) {
  const store = useHelpPanelStore.getState();
  store.ensureSlot(slot);
  useHelpPanelStore.getState().setTerminal(slot, terminalId, agentId, `bearer-${slot}`);
  panelsById[terminalId] = { id: terminalId, kind: "terminal", agentSessionId };
}

describe("help.resumePastSession", () => {
  let action: AnyActionDefinition;
  const run = async (args?: unknown): Promise<unknown> => action.run(args, {});

  beforeEach(() => {
    vi.clearAllMocks();
    controllers.clear();
    for (const key of Object.keys(panelsById)) delete panelsById[key];
    mockGetProjectState.mockReturnValue({ currentProject: PROJECT, isBootstrapped: true });
    mockGetScratchState.mockReturnValue({ currentScratch: null });
    resetHelpPanelRuntimeGateForTests();
    markHelpPanelRuntimeMounted();
    useHelpPanelStore.setState(useHelpPanelStore.getInitialState(), true);
    usePaletteStore.setState({ activePaletteId: null });
    action = extractAction();
  });

  // Lane claims are module state held until the launch aimed at the lane
  // settles. Settle every launch so no claim outlives its test.
  afterEach(() => {
    for (const controller of controllers.values()) {
      for (const phase of ["provisioning", "idle"]) {
        controller.phase = phase;
        controller.listeners.forEach((listener) => listener());
      }
    }
  });

  it("stays out of the MCP surface", () => {
    expect(action.mcpVisibility).toBe("hidden");
  });

  it("opens the picker and the panel when called without a session", async () => {
    await run();
    expect(usePaletteStore.getState().activePaletteId).toBe("assistant-sessions");
    expect(useHelpPanelStore.getState().isOpen).toBe(true);
    expect(controllers.size).toBe(0);
  });

  it("focuses the tab already showing the conversation instead of resuming it again", async () => {
    bindLane(0, "term-0", "claude");
    bindLane(1, "term-1", "claude", "ABC-1");
    useHelpPanelStore.getState().setActiveSlot(0);

    const result = await run({ agentId: "claude", sessionId: "abc-1" });

    expect(result).toEqual({ outcome: "focused" });
    expect(useHelpPanelStore.getState().activeSlot).toBe(1);
    expect(controllers.size).toBe(0);
  });

  it("resumes into the free active tab by exact id", async () => {
    const result = await run({ agentId: "claude", sessionId: "abc-1" });

    expect(result).toEqual({ outcome: "resumed" });
    expect(controllers.get(0)?.launchWhenReady).toHaveBeenCalledWith({
      agentId: "claude",
      replaceExisting: true,
      resumeTarget: { sessionId: "abc-1" },
    });
    expect(useHelpPanelStore.getState().isOpen).toBe(true);
  });

  it("opens a new tab when the open ones are busy, and claims it until the launch settles", async () => {
    bindLane(0, "term-0", "claude");

    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({ outcome: "resumed" });
    expect(useHelpPanelStore.getState().sessions[1]).toBeDefined();
    expect(useHelpPanelStore.getState().activeSlot).toBe(1);
    const controller = controllers.get(1)!;
    expect(controller.launchWhenReady).toHaveBeenCalledTimes(1);

    // While the launch is in flight the lane stays claimed: a second pick
    // goes elsewhere rather than displacing it.
    controller.phase = "provisioning";
    controller.listeners.forEach((listener) => listener());
    await run({ agentId: "claude", sessionId: "def-2" });
    expect(controllers.get(2)?.launchWhenReady).toHaveBeenCalledTimes(1);
    expect(controller.launchWhenReady).toHaveBeenCalledTimes(1);
  });

  it("reports every tab busy instead of displacing one, then replaces the tab the user names", async () => {
    bindLane(0, "term-0", "claude");
    bindLane(1, "term-1", "claude");
    bindLane(2, "term-2", "claude");

    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({
      outcome: "lanes-full",
    });
    expect(controllers.size).toBe(0);

    expect(await run({ agentId: "claude", sessionId: "abc-1", slot: 1 })).toEqual({
      outcome: "resumed",
    });
    expect(controllers.get(1)?.launchWhenReady).toHaveBeenCalledWith(
      expect.objectContaining({ replaceExisting: true, resumeTarget: { sessionId: "abc-1" } })
    );
    expect(useHelpPanelStore.getState().activeSlot).toBe(1);
  });

  it("refuses a named tab another resume is already heading for", async () => {
    bindLane(0, "term-0", "claude");
    bindLane(1, "term-1", "claude");
    bindLane(2, "term-2", "claude");
    await run({ agentId: "claude", sessionId: "abc-1", slot: 1 });
    controllers.get(1)!.phase = "provisioning";
    controllers.get(1)!.listeners.forEach((listener) => listener());

    expect(await run({ agentId: "claude", sessionId: "def-2", slot: 1 })).toEqual({
      outcome: "lanes-full",
    });
    expect(controllers.get(1)!.launchWhenReady).toHaveBeenCalledTimes(1);
  });

  it("says a tab is busy rather than dropping the pick when it is mid-launch", async () => {
    const { acquireHelpSessionController } =
      await import("@/controllers/helpSessionControllerRegistry");
    acquireHelpSessionController(0);
    controllers.get(0)!.phase = "provisioning";

    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({
      outcome: "unavailable",
    });
    expect(controllers.get(0)!.launchWhenReady).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));

    // The refused pick left no claim behind.
    controllers.get(0)!.phase = "idle";
    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({ outcome: "resumed" });
  });

  it("ignores a closed tab's capture when checking the agent", async () => {
    useHelpPanelStore.getState().setHibernateSession(PROJECT.id, 2, {
      sessionId: "old",
      cwd: "/help",
      agentId: "claude",
    });
    expect(await run({ agentId: "codex", sessionId: "thread-1" })).toEqual({
      outcome: "resumed",
    });
  });

  it("refuses a named tab that has since closed", async () => {
    expect(await run({ agentId: "claude", sessionId: "abc-1", slot: 2 })).toEqual({
      outcome: "lanes-full",
    });
    expect(controllers.size).toBe(0);
  });

  it("resumes a conversation captured for a closed tab back into that tab", async () => {
    useHelpPanelStore.getState().setHibernateSession(PROJECT.id, 2, {
      sessionId: "abc-1",
      cwd: "/help",
      agentId: "claude",
    });

    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({ outcome: "resumed" });
    expect(useHelpPanelStore.getState().sessions[2]).toBeDefined();
    expect(controllers.get(2)?.launchWhenReady).toHaveBeenCalled();
  });

  it("explains instead of launching when another tab runs a different agent", async () => {
    bindLane(0, "term-0", "claude");

    expect(await run({ agentId: "codex", sessionId: "thread-1" })).toEqual({
      outcome: "agent-mismatch",
    });
    expect(controllers.size).toBe(0);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
  });

  it("allows a different agent when the tab running the other one is the one replaced", async () => {
    bindLane(0, "term-0", "claude");

    expect(await run({ agentId: "codex", sessionId: "thread-1", slot: 0 })).toEqual({
      outcome: "resumed",
    });
  });

  it("does nothing without a workspace", async () => {
    mockGetProjectState.mockReturnValue({ currentProject: null, isBootstrapped: true });

    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({
      outcome: "unavailable",
    });
    expect(controllers.size).toBe(0);
  });

  it("keys captured entries by workspace, so another project's capture is not this tab's", async () => {
    useHelpPanelStore.getState().setHibernateSession("other-project", 2, {
      sessionId: "abc-1",
      cwd: "/help",
      agentId: "claude",
    });

    await run({ agentId: "claude", sessionId: "abc-1" });
    expect(controllers.get(0)?.launchWhenReady).toHaveBeenCalled();
    expect(controllers.get(2)).toBeUndefined();
  });
});

function helpTourShow(): AnyActionDefinition {
  const registry: ActionRegistry = new Map();
  // help.tour.show reaches no callback; every one is a stub.
  const callbacks: ActionCallbacks = new Proxy(Object.create(null), { get: () => vi.fn() });
  registerHelpActions(registry, callbacks);
  return registry.get("help.tour.show")!();
}

describe("help.tour.show", () => {
  it("still needs no arguments, so every existing caller keeps working", () => {
    const schema = helpTourShow().argsSchema!;
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("accepts any tour id as a string and nothing else", () => {
    const schema = helpTourShow().argsSchema!;
    // Whether a tour is registered under it is the host's call, not validation's.
    expect(schema.safeParse({ tourId: "plugin:missing/tour" }).success).toBe(true);
    expect(schema.safeParse({ tourId: 7 }).success).toBe(false);
  });

  it("opens the Daintree tour without arguments and the named tour with one", async () => {
    const action = helpTourShow();
    await action.run(undefined, {});
    await action.run({}, {});
    const acme = makePluginTourId("acme.tools", "welcome");
    await action.run({ tourId: acme }, {});
    expect(mockOpenTour.mock.calls).toEqual([[undefined], [undefined], [acme]]);
  });
});
