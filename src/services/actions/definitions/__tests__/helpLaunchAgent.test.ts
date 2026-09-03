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
  mockPlatformSupport,
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
  mockPlatformSupport: vi.fn(() => ({ supported: true })),
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

// Where the built-in engine can run decides the LAST-RESORT branch, and the real
// answer is the machine the suite happens to run on. Mocked so both sides of it are
// exercised the same way on every platform.
vi.mock("@shared/config/assistantPlatform", () => ({
  assistantPlatformSupport: () => mockPlatformSupport(),
}));

import { registerHelpActions } from "../helpActions";
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
    // `clearAllMocks` clears CALLS, not implementations, and several tests below
    // install their own (a drifted context, a resolved terminal id, a bare reset). Put
    // the defaults back so this file does not depend on its own declaration order.
    mockDispatch.mockResolvedValue({ ok: true });
    mockGetContext.mockReturnValue({});
    mockPlatformSupport.mockReturnValue({ supported: true });
    // The assistant's own agent setting is what this action launches, so the PTY-path
    // tests below need one set — a user with Claude picked in assistant settings.
    // Tests about the resolution itself override it.
    useHelpPanelStore.setState({ preferredAgentId: "claude", isOpen: false });
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

  it("opens the native assistant when no assistant agent has been chosen", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    useHelpPanelStore.setState({ preferredAgentId: null, isOpen: false });
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: undefined });

    await action.run(undefined, stubCtx);

    // The same default the panel itself applies to an unset preference. Both surfaces
    // open the same panel, so they must not disagree about what is in it. Asserted as
    // "dispatched nothing at all" rather than "not agent.launch with these args": this
    // action has no other legitimate dispatch, and the narrower form would pass if a
    // launch went out under a changed argument shape.
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(useHelpPanelStore.getState().isOpen).toBe(true);
  });

  it("leaves the preference unset when it only DEFAULTED to the native assistant", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    useHelpPanelStore.setState({ preferredAgentId: null, isOpen: false });

    await action.run(undefined, stubCtx);

    // Unset already MEANS the native assistant. Stamping it in would freeze today's
    // default into the user's settings behind their back.
    expect(useHelpPanelStore.getState().preferredAgentId).toBeNull();
  });

  it("dispatches agent.launch for the chosen assistant agent", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );

    await action.run(undefined, stubCtx);

    expect(window.electron.help.getFolderPath).toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude", cwd: "/mock/help", location: "overlay" }),
      { source: "user" }
    );
    expect(mockNotify).not.toHaveBeenCalled();
  });

  // Replaces "runs the Daintree Assistant in the project root, not the provisioned
  // session dir". That test described the assistant when it WAS a CLI in a terminal.
  // It is now a headless engine behind a React panel with no PTY form at all, so the
  // question is no longer where its terminal runs but that it never gets one: this
  // action sits on a shipped keyboard shortcut and in the Help menu, and a terminal
  // spawned from here would race the panel's own engine for the project lease.
  it("opens the panel and launches NO terminal for the native assistant", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    useHelpPanelStore.getState().setOpen(false);

    await action.run({ agentId: "daintree-assistant" }, stubCtx);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(window.electron.help.provisionSession).not.toHaveBeenCalled();
    expect(useHelpPanelStore.getState().isOpen).toBe(true);
    expect(useHelpPanelStore.getState().preferredAgentId).toBe("daintree-assistant");
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

  it("honours the assistant agent over the global default agent", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    // Two different settings answering two different questions. The global default
    // names what a DIRECT launch spawns; the assistant setting names what the
    // assistant runs, and this action opens the assistant.
    useHelpPanelStore.setState({ preferredAgentId: "gemini" });
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "codex" });

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

  it("never overwrites a chosen assistant agent with the native one", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    useHelpPanelStore.setState({ preferredAgentId: "claude" });
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: undefined });
    // The native id must be IN the fixture, and ready. That is what it reads as on
    // every working install — `CliAvailabilityService` short-circuits its PATH probe
    // and answers from the bundled engine — and it is the whole mechanism of the bug:
    // omit it here and the old code resolves Claude, so this test would pass against
    // the very defect it exists to pin.
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability({ "daintree-assistant": "ready" }),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    // The regression: this used to resolve the global default agent, land on the
    // native assistant and write it back — so the setting lost the launch AND lost
    // itself. Both halves are asserted: Claude runs, and Claude is still the setting.
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude" }),
      { source: "user" }
    );
    expect(useHelpPanelStore.getState().preferredAgentId).toBe("claude");
  });

  it("falls back to the global default agent where the engine cannot run", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockPlatformSupport.mockReturnValue({ supported: false });
    useHelpPanelStore.setState({ preferredAgentId: null });
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

  it("skips a global default that no help session can be provisioned for", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockPlatformSupport.mockReturnValue({ supported: false });
    useHelpPanelStore.setState({ preferredAgentId: null });
    // Gemini is `supports.tier: "deprecated"` and OpenCode has no assistant wiring at
    // all, so `HelpSessionService.provisionSession` rejects both outright. Resolving
    // one here would pick a launch main then refuses — the fallback is held to the
    // wired set, so it skips past both and lands on Claude.
    mockGetAgentPrefsState.mockReturnValue({ defaultAgent: "gemini" });
    mockGetCliAvailabilityState.mockReturnValue({
      availability: allAvailability(),
      isInitialized: true,
    });

    await action.run(undefined, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "claude", cwd: "/mock/help", location: "overlay" }),
      { source: "user" }
    );
  });

  it("falls back to first available agent when that default is unavailable", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockPlatformSupport.mockReturnValue({ supported: false });
    useHelpPanelStore.setState({ preferredAgentId: null });
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

  it("resolves to codex when claude is unavailable", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockPlatformSupport.mockReturnValue({ supported: false });
    useHelpPanelStore.setState({ preferredAgentId: null });
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
    mockPlatformSupport.mockReturnValue({ supported: false });
    useHelpPanelStore.setState({ preferredAgentId: null });
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
    useHelpPanelStore.setState({ preferredAgentId: "gemini" });

    await action.run({ agentId: "codex" }, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "codex", cwd: "/mock/help", location: "overlay" }),
      { source: "user" }
    );
  });

  it("opens the native assistant even when the help folder is unavailable", async () => {
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    useHelpPanelStore.setState({ preferredAgentId: null, isOpen: false });

    await action.run(undefined, stubCtx);

    // The native engine runs in the project root and reads its skills from the app
    // bundle — the help folder is a PTY-path asset. Refusing to open over an asset
    // this branch never touches blocked the DEFAULT surface on an unrelated failure.
    expect(mockNotify).not.toHaveBeenCalled();
    expect(useHelpPanelStore.getState().isOpen).toBe(true);
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

  it("runs a terminal help agent in the scratch root when a scratch is the active workspace", async () => {
    // Was asserted with the Daintree Assistant, which no longer takes a terminal at
    // all. The scratch-root rule it was really testing belongs to the PTY help agents,
    // so it is asserted with one.
    (window.electron.help.getFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/mock/help"
    );
    mockGetProjectState.mockReturnValue({ currentProject: null, isBootstrapped: true });
    mockGetScratchState.mockReturnValue({
      currentScratch: { id: "scratch-1", path: "/scratches/scratch-1" },
    });

    await action.run({ agentId: "codex" }, stubCtx);

    expect(mockDispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ agentId: "codex" }),
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
      tier: "action",
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
});
