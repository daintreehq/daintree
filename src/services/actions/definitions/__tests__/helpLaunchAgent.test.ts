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
              tier: "action",
              mcpUrl: null,
              windowId: 1,
            }),
            revokeSession: vi.fn().mockResolvedValue(undefined),
            markTerminal: vi.fn().mockResolvedValue(undefined),
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
    action = extractHelpLaunchAgent();
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

  it("uses the user's preferred default agent when available", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "gemini" });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability(),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "gemini", cwd: "/mock/help", location: "overlay" }),
      { source: "user" }
    );
  });

  it("falls back to first available agent when default is unavailable", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "gemini" });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability({ gemini: "missing" }),
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
        title: "Help Agent",
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
      tier: "action",
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
      tier: "action",
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
      tier: "action",
      mcpUrl: null,
      windowId: 1,
    });
    mockDispatch.mockResolvedValue({ ok: false });

    await action.run(undefined, stubCtx);

    expect(window.electron.help.revokeSession).toHaveBeenCalledWith("sess-fail");
  });
});
