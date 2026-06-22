import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  addRecipeMock,
  getRecipesMock,
  updateRecipeMock,
  deleteRecipeMock,
  addTerminalMock,
  getAgentSettingsMock,
  globalGetRecipesMock,
  globalAddRecipeMock,
  globalUpdateRecipeMock,
  globalDeleteRecipeMock,
  getInRepoRecipesMock,
  updateInRepoRecipeMock,
  deleteInRepoRecipeMock,
  exportRecipeToFileMock,
  importRecipeFromFileMock,
  notifyMock,
} = vi.hoisted(() => ({
  addRecipeMock: vi.fn().mockResolvedValue(undefined),
  getRecipesMock: vi.fn().mockResolvedValue({ recipes: [], collisions: [] }),
  updateRecipeMock: vi.fn().mockResolvedValue(undefined),
  deleteRecipeMock: vi.fn().mockResolvedValue(undefined),
  addTerminalMock: vi.fn().mockResolvedValue(undefined),
  getAgentSettingsMock: vi.fn().mockResolvedValue({ agents: {} }),
  globalGetRecipesMock: vi.fn().mockResolvedValue([]),
  globalAddRecipeMock: vi.fn().mockResolvedValue(undefined),
  globalUpdateRecipeMock: vi.fn().mockResolvedValue(undefined),
  globalDeleteRecipeMock: vi.fn().mockResolvedValue(undefined),
  getInRepoRecipesMock: vi.fn().mockResolvedValue([]),
  updateInRepoRecipeMock: vi.fn().mockResolvedValue(undefined),
  deleteInRepoRecipeMock: vi.fn().mockResolvedValue(undefined),
  exportRecipeToFileMock: vi.fn().mockResolvedValue(true),
  importRecipeFromFileMock: vi.fn().mockResolvedValue(null),
  notifyMock: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

vi.mock("@/clients", () => ({
  projectClient: {
    getRecipes: getRecipesMock,
    addRecipe: addRecipeMock,
    updateRecipe: updateRecipeMock,
    deleteRecipe: deleteRecipeMock,
    getInRepoRecipes: getInRepoRecipesMock,
    updateInRepoRecipe: updateInRepoRecipeMock,
    deleteInRepoRecipe: deleteInRepoRecipeMock,
    exportRecipeToFile: exportRecipeToFileMock,
    importRecipeFromFile: importRecipeFromFileMock,
  },
  agentSettingsClient: {
    get: getAgentSettingsMock,
  },
  systemClient: {
    getTmpDir: vi.fn().mockResolvedValue("/tmp"),
  },
  globalRecipesClient: {
    getRecipes: globalGetRecipesMock,
    addRecipe: globalAddRecipeMock,
    updateRecipe: globalUpdateRecipeMock,
    deleteRecipe: globalDeleteRecipeMock,
  },
}));

const beginSpawnBatchMock = vi.fn(() => Symbol("spawn-batch"));
const flushSpawnBatchMock = vi.fn();
const setFocusedMock = vi.fn();

const panelStoreState: {
  panelIds: string[];
  panelsById: Record<string, unknown>;
  addPanel: typeof addTerminalMock;
  beginSpawnBatch: typeof beginSpawnBatchMock;
  flushSpawnBatch: typeof flushSpawnBatchMock;
  setFocused: typeof setFocusedMock;
} = {
  panelIds: [],
  panelsById: {},
  addPanel: addTerminalMock,
  beginSpawnBatch: beginSpawnBatchMock,
  flushSpawnBatch: flushSpawnBatchMock,
  setFocused: setFocusedMock,
};

vi.mock("../panelStore", () => ({
  usePanelStore: {
    getState: vi.fn(() => panelStoreState),
  },
}));

// Preset sources resolved during recipe agent launches (#10722). Mutable so
// individual tests can inject CCR/project presets; reset in beforeEach.
const ccrPresetsState: { ccrPresetsByAgent: Record<string, unknown> } = {
  ccrPresetsByAgent: {},
};
const projectPresetsState: { presetsByAgent: Record<string, unknown> } = {
  presetsByAgent: {},
};

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: {
    getState: vi.fn(() => ccrPresetsState),
  },
}));

vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: {
    getState: vi.fn(() => projectPresetsState),
  },
}));

// runRecipeWithResults records the run via window.electron.runHistory.append
// (fire-and-forget). Stub it so the call resolves cleanly in tests.
const runHistoryAppendMock = vi.fn().mockResolvedValue(undefined);
(globalThis as { window?: unknown }).window = {
  electron: {
    runHistory: { append: runHistoryAppendMock },
  },
};

import { useRecipeStore } from "../recipeStore";
import { usePanelLimitStore } from "../panelLimitStore";

describe("recipeStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRecipeStore.getState().reset();
    panelStoreState.panelIds = [];
    panelStoreState.panelsById = {};
    ccrPresetsState.ccrPresetsByAgent = {};
    projectPresetsState.presetsByAgent = {};
  });

  it("rejects malformed recipe json", async () => {
    await expect(useRecipeStore.getState().importRecipe("project-1", "{bad-json")).rejects.toThrow(
      "Invalid JSON format"
    );
  });

  it("sanitizes imported terminals and strips empty commands", async () => {
    const input = JSON.stringify({
      name: "Imported",
      terminals: [
        { type: "terminal", title: "Shell", command: "   " },
        { type: "dev-preview", title: "Dev Server", devCommand: "   " },
        { type: "codex", title: "Agent", command: " codex --fast ", initialPrompt: "hello\r\n" },
      ],
    });

    await useRecipeStore.getState().importRecipe("project-1", input);

    const recipe = useRecipeStore.getState().recipes[0];
    expect(recipe).toBeTruthy();
    expect(recipe?.terminals).toHaveLength(3);

    expect(recipe?.terminals[0]?.type).toBe("terminal");
    expect(recipe?.terminals[0]?.command).toBeUndefined();

    expect(recipe?.terminals[1]?.type).toBe("dev-preview");
    expect(recipe?.terminals[1]?.devCommand).toBeUndefined();

    expect(recipe?.terminals[2]?.command).toBeUndefined();
    expect(recipe?.terminals[2]?.initialPrompt).toBe("hello");
    expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
  });

  describe("generateRecipeFromActiveTerminals", () => {
    it("preserves agentModelId and agentLaunchFlags for agent panels (clone-layout flow)", () => {
      panelStoreState.panelIds = ["panel-agent", "panel-plain", "panel-dev"];
      panelStoreState.panelsById = {
        "panel-agent": {
          id: "panel-agent",
          kind: "terminal",
          launchAgentId: "claude",
          detectedAgentId: "claude",
          title: "Claude",
          worktreeId: "wt-1",
          location: "active",
          agentModelId: "claude-opus-4-7",
          agentLaunchFlags: ["--resume", "abc123"],
        },
        "panel-plain": {
          id: "panel-plain",
          kind: "terminal",
          title: "Shell",
          worktreeId: "wt-1",
          location: "active",
          command: "npm test",
          // Plain terminals should never carry agent overrides in the projection.
          agentModelId: "should-be-ignored",
          agentLaunchFlags: ["should-be-ignored"],
        },
        "panel-dev": {
          id: "panel-dev",
          kind: "dev-preview",
          title: "Preview",
          worktreeId: "wt-1",
          location: "active",
          devCommand: "npm run dev",
        },
      };

      const terminals = useRecipeStore.getState().generateRecipeFromActiveTerminals("wt-1");
      expect(terminals).toHaveLength(3);

      const agentEntry = terminals.find((t) => t.type === "claude");
      expect(agentEntry?.agentModelId).toBe("claude-opus-4-7");
      expect(agentEntry?.agentLaunchFlags).toEqual(["--resume", "abc123"]);

      const plainEntry = terminals.find((t) => t.type === "terminal");
      expect(plainEntry?.agentModelId).toBeUndefined();
      expect(plainEntry?.agentLaunchFlags).toBeUndefined();

      const devEntry = terminals.find((t) => t.type === "dev-preview");
      expect(devEntry?.devCommand).toBe("npm run dev");
      expect(devEntry?.agentModelId).toBeUndefined();
      expect(devEntry?.agentLaunchFlags).toBeUndefined();
    });

    it("captures dock placement and omits location for grid-equivalent panels (#9764)", () => {
      panelStoreState.panelIds = ["panel-dock", "panel-grid", "panel-overlay"];
      panelStoreState.panelsById = {
        "panel-dock": {
          id: "panel-dock",
          kind: "terminal",
          title: "Docked",
          worktreeId: "wt-1",
          location: "dock",
          command: "npm test",
        },
        "panel-grid": {
          id: "panel-grid",
          kind: "terminal",
          title: "Grid",
          worktreeId: "wt-1",
          location: "grid",
        },
        "panel-overlay": {
          id: "panel-overlay",
          kind: "terminal",
          title: "Overlay",
          worktreeId: "wt-1",
          location: "overlay",
        },
      };

      const terminals = useRecipeStore.getState().generateRecipeFromActiveTerminals("wt-1");
      expect(terminals).toHaveLength(3);
      expect(terminals.find((t) => t.title === "Docked")?.location).toBe("dock");
      expect(terminals.find((t) => t.title === "Grid")?.location).toBeUndefined();
      // Transient system placements are not user layout choices — never cloned.
      expect(terminals.find((t) => t.title === "Overlay")?.location).toBeUndefined();
    });

    it("strips location when persisting to disk via createRecipe (#9764)", async () => {
      useRecipeStore.setState({ currentProjectId: "project-1" });
      await useRecipeStore.getState().createRecipe(
        "project-1",
        "Layout",
        undefined,
        [
          {
            type: "terminal",
            title: "Docked",
            command: "npm test",
            env: {},
            location: "dock",
          },
        ],
        false
      );

      expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
      const persistedRecipe = updateInRepoRecipeMock.mock.calls[0]?.[1];
      expect(persistedRecipe?.terminals?.[0]?.location).toBeUndefined();
    });

    it("strips agentModelId and agentLaunchFlags when persisting to disk via createRecipe", async () => {
      useRecipeStore.setState({ currentProjectId: "project-1" });
      await useRecipeStore.getState().createRecipe(
        "project-1",
        "Layout",
        undefined,
        [
          {
            type: "claude",
            title: "Agent",
            env: {},
            agentModelId: "claude-opus-4-7",
            agentLaunchFlags: ["--resume", "abc"],
          },
        ],
        false
      );

      expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
      const persistedRecipe = updateInRepoRecipeMock.mock.calls[0]?.[1];
      expect(persistedRecipe?.terminals?.[0]?.agentModelId).toBeUndefined();
      expect(persistedRecipe?.terminals?.[0]?.agentLaunchFlags).toBeUndefined();
    });

    it("strips agentModelId and agentLaunchFlags when persisting to disk via updateRecipe", async () => {
      useRecipeStore.setState({ currentProjectId: "project-1" });
      await useRecipeStore
        .getState()
        .createRecipe(
          "project-1",
          "Layout",
          undefined,
          [{ type: "terminal", title: "Shell", command: "npm test", env: {} }],
          false
        );

      const recipeId = useRecipeStore.getState().recipes[0]?.id;
      expect(recipeId).toBeTruthy();

      updateInRepoRecipeMock.mockClear();
      await useRecipeStore.getState().updateRecipe(recipeId!, {
        terminals: [
          {
            type: "claude",
            title: "Agent",
            env: {},
            agentModelId: "claude-opus-4-7",
            agentLaunchFlags: ["--resume", "xyz"],
          },
        ],
      });

      const persistedRecipe = updateInRepoRecipeMock.mock.calls[0]?.[1];
      expect(persistedRecipe?.terminals?.[0]?.agentModelId).toBeUndefined();
      expect(persistedRecipe?.terminals?.[0]?.agentLaunchFlags).toBeUndefined();
    });

    it("strips agentModelId and agentLaunchFlags when persisting a global recipe update", async () => {
      useRecipeStore.setState({
        globalRecipes: [
          {
            id: "global-agent",
            name: "Global Agent",
            terminals: [{ type: "terminal", title: "Shell", env: {} }],
            createdAt: 1000,
          },
        ],
        projectRecipes: [],
        inRepoRecipes: [],
        recipes: [
          {
            id: "global-agent",
            name: "Global Agent",
            terminals: [{ type: "terminal", title: "Shell", env: {} }],
            createdAt: 1000,
          },
        ],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().updateRecipe("global-agent", {
        terminals: [
          {
            type: "claude",
            title: "Agent",
            env: {},
            agentModelId: "claude-opus-4-7",
            agentLaunchFlags: ["--resume", "xyz"],
          },
        ],
      });

      expect(globalUpdateRecipeMock).toHaveBeenCalledTimes(1);
      const persistedUpdates = globalUpdateRecipeMock.mock.calls[0]?.[1];
      expect(persistedUpdates?.terminals?.[0]?.agentModelId).toBeUndefined();
      expect(persistedUpdates?.terminals?.[0]?.agentLaunchFlags).toBeUndefined();
    });

    it("drops session-override fields from recipes loaded from disk (defense-in-depth)", async () => {
      const contaminatedRecipe = {
        id: "inrepo-contaminated",
        name: "Contaminated",
        terminals: [
          {
            type: "claude" as const,
            title: "Agent",
            env: {},
            agentModelId: "claude-opus-4-7",
            agentLaunchFlags: ["--resume", "old"],
            location: "dock" as const,
          },
        ],
        createdAt: 1000,
      };
      globalGetRecipesMock.mockResolvedValueOnce([]);
      getRecipesMock.mockResolvedValueOnce({ recipes: [], collisions: [] });
      getInRepoRecipesMock.mockResolvedValueOnce([contaminatedRecipe]);

      await useRecipeStore.getState().loadRecipes("project-1");

      const loaded = useRecipeStore.getState().inRepoRecipes[0];
      expect(loaded?.terminals[0]?.agentModelId).toBeUndefined();
      expect(loaded?.terminals[0]?.agentLaunchFlags).toBeUndefined();
      expect(loaded?.terminals[0]?.location).toBeUndefined();
    });
  });

  it("sanitizes agent commands on update before persisting", async () => {
    useRecipeStore.setState({ currentProjectId: "project-1" });
    await useRecipeStore
      .getState()
      .createRecipe(
        "project-1",
        "Recipe",
        undefined,
        [{ type: "terminal", title: "Shell", command: "npm test", env: {} }],
        false
      );

    const recipeId = useRecipeStore.getState().recipes[0]?.id;
    expect(recipeId).toBeTruthy();
    expect(recipeId).toMatch(/^recipe-/);

    updateInRepoRecipeMock.mockClear();
    await useRecipeStore.getState().updateRecipe(recipeId!, {
      terminals: [
        {
          type: "codex",
          title: "Agent",
          command: "gemini --yolo --dangerously-bypass-approvals-and-sandbox",
          initialPrompt: "merge open prs\r\n",
          env: {},
        },
      ],
    });

    const updated = useRecipeStore.getState().recipes[0];
    expect(updated?.terminals[0]?.command).toBeUndefined();
    expect(updated?.terminals[0]?.initialPrompt).toBe("merge open prs");

    expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
    const persistedRecipe = updateInRepoRecipeMock.mock.calls[0]?.[1];
    expect(persistedRecipe?.terminals?.[0]?.command).toBeUndefined();
    expect(persistedRecipe?.terminals?.[0]?.initialPrompt).toBe("merge open prs");
  });

  it("does not include terminals when persisting metadata-only updates", async () => {
    // Use a global recipe so the legacy updateRecipe path is tested
    useRecipeStore.setState({
      globalRecipes: [
        {
          id: "global-meta",
          name: "Global Recipe",
          terminals: [{ type: "terminal" as const, title: "Shell", command: "npm test", env: {} }],
          createdAt: 1000,
        },
      ],
      projectRecipes: [],
      recipes: [
        {
          id: "global-meta",
          name: "Global Recipe",
          terminals: [{ type: "terminal" as const, title: "Shell", command: "npm test", env: {} }],
          createdAt: 1000,
        },
      ],
      currentProjectId: "project-1",
    });

    await useRecipeStore.getState().updateRecipe("global-meta", { lastUsedAt: 123 });

    expect(globalUpdateRecipeMock).toHaveBeenCalledTimes(1);
    const persistedUpdates = globalUpdateRecipeMock.mock.calls[0]?.[1];
    expect(Object.prototype.hasOwnProperty.call(persistedUpdates, "terminals")).toBe(false);
    expect(persistedUpdates?.lastUsedAt).toBe(123);
  });

  it("runRecipe rebuilds agent command from type and ignores stale stored command", async () => {
    useRecipeStore.setState({
      recipes: [
        {
          id: "recipe-1",
          name: "Agent Recipe",
          projectId: "project-1",
          terminals: [
            {
              type: "codex",
              title: "Agent",
              command: "gemini --yolo --dangerously-bypass-approvals-and-sandbox",
              initialPrompt: "/prompts:merge-prs",
              env: {},
            },
          ],
          createdAt: Date.now(),
        },
      ],
      isLoading: false,
      currentProjectId: "project-1",
    });

    await useRecipeStore.getState().runRecipe("recipe-1", "/tmp/worktree", "worktree-1");

    expect(addTerminalMock).toHaveBeenCalledTimes(1);
    const spawned = addTerminalMock.mock.calls[0]?.[0];
    expect(spawned.kind).toBe("terminal");
    expect(spawned.launchAgentId).toBe("codex");
    expect(spawned.command).toContain("codex");
    expect(spawned.command).toContain("/prompts:merge-prs");
    expect(spawned.command).toMatch(/['"]\/prompts:merge-prs['"]/);
    expect(spawned.command).not.toContain("gemini");
  });

  it("runRecipe passes recipe args to the spawned agent command", async () => {
    useRecipeStore.setState({
      recipes: [
        {
          id: "recipe-args",
          name: "Args Recipe",
          projectId: "project-1",
          terminals: [
            {
              type: "claude",
              title: "Claude with args",
              args: "--verbose --model sonnet",
              env: {},
            },
          ],
          createdAt: Date.now(),
        },
      ],
      isLoading: false,
      currentProjectId: "project-1",
    });

    await useRecipeStore.getState().runRecipe("recipe-args", "/tmp/worktree", "worktree-1");

    expect(addTerminalMock).toHaveBeenCalledTimes(1);
    const spawned = addTerminalMock.mock.calls[0]?.[0];
    expect(spawned.command).toContain("--verbose");
    expect(spawned.command).toContain("--model");
    expect(spawned.command).toContain("sonnet");
  });

  it("runRecipe passes spawnedBy through to spawned panels", async () => {
    useRecipeStore.setState({
      recipes: [
        {
          id: "recipe-mcp",
          name: "MCP Recipe",
          projectId: "project-1",
          terminals: [
            {
              type: "claude",
              title: "Claude",
              env: {},
            },
          ],
          createdAt: Date.now(),
        },
      ],
      isLoading: false,
      currentProjectId: "project-1",
    });

    await useRecipeStore
      .getState()
      .runRecipe("recipe-mcp", "/tmp/worktree", "worktree-1", undefined, {
        spawnedBy: "mcp",
      });

    expect(addTerminalMock).toHaveBeenCalledTimes(1);
    expect(addTerminalMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        launchAgentId: "claude",
        spawnedBy: "mcp",
      })
    );
  });

  describe("runRecipeWithResults", () => {
    it("returns all spawned terminal IDs on full success", async () => {
      let callIndex = 0;
      addTerminalMock.mockImplementation(() => {
        callIndex++;
        return Promise.resolve(`terminal-${callIndex}`);
      });

      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-1",
            name: "Test Recipe",
            projectId: "project-1",
            terminals: [
              { type: "terminal", title: "Shell 1", command: "npm test", env: {} },
              { type: "terminal", title: "Shell 2", command: "npm start", env: {} },
            ],
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        currentProjectId: "project-1",
      });

      const results = await useRecipeStore
        .getState()
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1");

      expect(results.spawned).toHaveLength(2);
      expect(results.failed).toHaveLength(0);
      expect(results.spawned[0]).toEqual({ index: 0, terminalId: "terminal-1" });
      expect(results.spawned[1]).toEqual({ index: 1, terminalId: "terminal-2" });
    });

    it("reports partial failures with correct indices", async () => {
      let callIndex = 0;
      addTerminalMock.mockImplementation(() => {
        callIndex++;
        if (callIndex === 2) return Promise.reject(new Error("Spawn failed"));
        return Promise.resolve(`terminal-${callIndex}`);
      });

      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-1",
            name: "Test Recipe",
            projectId: "project-1",
            terminals: [
              { type: "terminal", title: "Shell 1", command: "npm test", env: {} },
              { type: "terminal", title: "Shell 2", command: "npm start", env: {} },
              { type: "terminal", title: "Shell 3", command: "npm build", env: {} },
            ],
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        currentProjectId: "project-1",
      });

      const results = await useRecipeStore
        .getState()
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1");

      expect(results.spawned).toHaveLength(2);
      expect(results.failed).toHaveLength(1);
      expect(results.failed[0]).toEqual({ index: 1, error: "Spawn failed" });
      expect(results.spawned[0]?.index).toBe(0);
      expect(results.spawned[1]?.index).toBe(2);
    });

    it("appends usageHistory atomically across concurrent runs", async () => {
      // Hold the first spawn open so the second run interleaves with the
      // first's in-flight state. Without an atomic set-callback append, both
      // runs would read the same pre-update snapshot and one timestamp would
      // get dropped — final usageHistory would be length 1 instead of 2.
      let resolveFirst: ((value: string) => void) | null = null;
      let callCount = 0;
      addTerminalMock.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise<string>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(`terminal-${callCount}`);
      });

      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-race",
            name: "Race",
            projectId: "project-1",
            terminals: [{ type: "terminal", title: "T1", command: "echo", env: {} }],
            createdAt: 1000,
          },
        ],
        projectRecipes: [
          {
            id: "recipe-race",
            name: "Race",
            projectId: "project-1",
            terminals: [{ type: "terminal", title: "T1", command: "echo", env: {} }],
            createdAt: 1000,
          },
        ],
        globalRecipes: [],
        inRepoRecipes: [],
        isLoading: false,
        currentProjectId: "project-1",
      });

      const p1 = useRecipeStore.getState().runRecipeWithResults("recipe-race", "/tmp", "wt-1");
      // Yield so p1 reaches its first await (the held addPanel).
      await Promise.resolve();
      const p2 = useRecipeStore.getState().runRecipeWithResults("recipe-race", "/tmp", "wt-1");

      // Release the first spawn so both runs can settle.
      resolveFirst!("terminal-1");

      await Promise.all([p1, p2]);

      const recipe = useRecipeStore.getState().recipes.find((r) => r.id === "recipe-race");
      expect(recipe?.usageHistory).toHaveLength(2);
    });

    it("retries only specified terminal indices", async () => {
      addTerminalMock.mockResolvedValue("terminal-retry-1");

      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-1",
            name: "Test Recipe",
            projectId: "project-1",
            terminals: [
              { type: "terminal", title: "Shell 1", command: "npm test", env: {} },
              { type: "terminal", title: "Shell 2", command: "npm start", env: {} },
              { type: "terminal", title: "Shell 3", command: "npm build", env: {} },
            ],
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        currentProjectId: "project-1",
      });

      const results = await useRecipeStore
        .getState()
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1", undefined, {
          terminalIndices: [1],
        });

      expect(addTerminalMock).toHaveBeenCalledTimes(1);
      expect(results.spawned).toHaveLength(1);
      expect(results.spawned[0]?.index).toBe(1);
    });

    it("opens one spawn batch and flushes it once, bypassing per-panel limits", async () => {
      let callIndex = 0;
      addTerminalMock.mockImplementation(() => Promise.resolve(`terminal-${++callIndex}`));

      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-1",
            name: "Test Recipe",
            projectId: "project-1",
            terminals: [
              { type: "terminal", title: "Shell 1", command: "a", env: {} },
              { type: "terminal", title: "Shell 2", command: "b", env: {} },
              { type: "terminal", title: "Shell 3", command: "c", env: {} },
            ],
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        currentProjectId: "project-1",
      });

      await useRecipeStore
        .getState()
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1");

      expect(beginSpawnBatchMock).toHaveBeenCalledTimes(1);
      expect(flushSpawnBatchMock).toHaveBeenCalledTimes(1);
      expect(flushSpawnBatchMock).toHaveBeenCalledWith(beginSpawnBatchMock.mock.results[0]?.value);
      expect(addTerminalMock).toHaveBeenCalledTimes(3);
      // EVERY panel in the burst must bypass the per-call limit (the batch gated
      // the whole burst); dropping it on one panel would re-introduce the
      // stale-count under-enforcement.
      expect(
        addTerminalMock.mock.calls.every(
          (c) => (c[0] as { bypassLimits?: boolean })?.bypassLimits === true
        )
      ).toBe(true);
    });

    it("focuses the last spawned grid panel after the batch flush", async () => {
      let callIndex = 0;
      addTerminalMock.mockImplementation(() => Promise.resolve(`terminal-${++callIndex}`));

      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-1",
            name: "Test Recipe",
            projectId: "project-1",
            terminals: [
              { type: "terminal", title: "Shell 1", command: "a", env: {} },
              { type: "terminal", title: "Shell 2", command: "b", env: {} },
            ],
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        currentProjectId: "project-1",
      });

      await useRecipeStore
        .getState()
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1");

      expect(setFocusedMock).toHaveBeenCalledTimes(1);
      expect(setFocusedMock).toHaveBeenCalledWith("terminal-2");
    });

    it("does not steal focus when focusPolicy is preserve", async () => {
      addTerminalMock.mockResolvedValue("terminal-x");

      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-1",
            name: "Test Recipe",
            projectId: "project-1",
            terminals: [{ type: "terminal", title: "Shell 1", command: "a", env: {} }],
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        currentProjectId: "project-1",
      });

      await useRecipeStore
        .getState()
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1", undefined, {
          focusPolicy: "preserve",
        });

      expect(setFocusedMock).not.toHaveBeenCalled();
    });

    it("reports out-of-bounds terminalIndices as structured failures without throwing", async () => {
      // Regression: previously, recipe.terminals[i]! with a bad index handed
      // `undefined` to the hasAgent loop and threw TypeError on `.type`. Now
      // validation runs first and out-of-bounds indices go straight to failed.
      addTerminalMock.mockResolvedValue("terminal-1");
      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-1",
            name: "Test Recipe",
            projectId: "project-1",
            terminals: [{ type: "terminal", title: "Shell 1", command: "a", env: {} }],
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        currentProjectId: "project-1",
      });

      const results = await useRecipeStore
        .getState()
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1", undefined, {
          terminalIndices: [0, 99, -1],
        });

      expect(addTerminalMock).toHaveBeenCalledTimes(1);
      expect(results.spawned).toHaveLength(1);
      expect(results.spawned[0]?.index).toBe(0);
      expect(results.failed).toHaveLength(2);
      expect(results.failed.map((f) => f.index).sort()).toEqual([-1, 99]);
      expect(results.failed.every((f) => f.error.includes("out of bounds"))).toBe(true);
    });

    it("caps the burst at the hard panel limit and reports overflow as failed", async () => {
      const previousHardLimit = usePanelLimitStore.getState().hardLimit;
      usePanelLimitStore.setState({ hardLimit: 2, warningsDisabled: true });
      try {
        let callIndex = 0;
        addTerminalMock.mockImplementation(() => Promise.resolve(`terminal-${++callIndex}`));

        useRecipeStore.setState({
          recipes: [
            {
              id: "recipe-1",
              name: "Test Recipe",
              projectId: "project-1",
              terminals: [
                { type: "terminal", title: "Shell 1", command: "a", env: {} },
                { type: "terminal", title: "Shell 2", command: "b", env: {} },
                { type: "terminal", title: "Shell 3", command: "c", env: {} },
              ],
              createdAt: Date.now(),
            },
          ],
          isLoading: false,
          currentProjectId: "project-1",
        });

        const results = await useRecipeStore
          .getState()
          .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1");

        expect(addTerminalMock).toHaveBeenCalledTimes(2);
        expect(
          addTerminalMock.mock.calls.every(
            (c) => (c[0] as { bypassLimits?: boolean })?.bypassLimits === true
          )
        ).toBe(true);
        expect(results.spawned).toHaveLength(2);
        expect(results.failed).toHaveLength(1);
        expect(results.failed[0]).toEqual({ index: 2, error: "Panel limit reached" });
      } finally {
        usePanelLimitStore.setState({ hardLimit: previousHardLimit, warningsDisabled: false });
      }
    });

    it("caps an agent-dispatched run at MAX_AGENT_RECIPE_TERMINALS and never prompts", async () => {
      const requestConfirmationSpy = vi.fn().mockResolvedValue(true);
      const previousRequestConfirmation = usePanelLimitStore.getState().requestConfirmation;
      usePanelLimitStore.setState({ requestConfirmation: requestConfirmationSpy });
      try {
        let callIndex = 0;
        addTerminalMock.mockImplementation(() => Promise.resolve(`terminal-${++callIndex}`));

        useRecipeStore.setState({
          recipes: [
            {
              id: "recipe-1",
              name: "Ten Terminals",
              projectId: "project-1",
              terminals: Array.from({ length: 10 }, (_, i) => ({
                type: "terminal" as const,
                title: `Shell ${i}`,
                command: "echo",
                env: {},
              })),
              createdAt: Date.now(),
            },
          ],
          isLoading: false,
          currentProjectId: "project-1",
        });

        const results = await useRecipeStore
          .getState()
          .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1", undefined, {
            dispatchSource: "agent",
          });

        expect(addTerminalMock).toHaveBeenCalledTimes(3);
        expect(results.spawned).toHaveLength(3);
        expect(results.failed).toHaveLength(7);
        expect(results.failed.map((f) => f.index)).toEqual([3, 4, 5, 6, 7, 8, 9]);
        expect(results.failed.every((f) => f.error === "Agent recipe terminal cap reached")).toBe(
          true
        );
        // Cap runs before preflightSpawnBatchLimit, so the projected count never
        // crosses the confirm threshold — a headless agent dispatch can't hang.
        expect(requestConfirmationSpy).not.toHaveBeenCalled();
      } finally {
        usePanelLimitStore.setState({ requestConfirmation: previousRequestConfirmation });
      }
    });

    it("spawns all terminals for an agent run at exactly the cap", async () => {
      let callIndex = 0;
      addTerminalMock.mockImplementation(() => Promise.resolve(`terminal-${++callIndex}`));

      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-1",
            name: "Three Terminals",
            projectId: "project-1",
            terminals: Array.from({ length: 3 }, (_, i) => ({
              type: "terminal" as const,
              title: `Shell ${i}`,
              command: "echo",
              env: {},
            })),
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        currentProjectId: "project-1",
      });

      const results = await useRecipeStore
        .getState()
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1", undefined, {
          dispatchSource: "agent",
        });

      expect(addTerminalMock).toHaveBeenCalledTimes(3);
      expect(results.spawned).toHaveLength(3);
      expect(results.failed).toHaveLength(0);
    });

    it("does not cap a user-dispatched run", async () => {
      let callIndex = 0;
      addTerminalMock.mockImplementation(() => Promise.resolve(`terminal-${++callIndex}`));

      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-1",
            name: "Ten Terminals",
            projectId: "project-1",
            terminals: Array.from({ length: 10 }, (_, i) => ({
              type: "terminal" as const,
              title: `Shell ${i}`,
              command: "echo",
              env: {},
            })),
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        currentProjectId: "project-1",
      });

      const results = await useRecipeStore
        .getState()
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1", undefined, {
          dispatchSource: "user",
        });

      expect(addTerminalMock).toHaveBeenCalledTimes(10);
      expect(results.spawned).toHaveLength(10);
      expect(results.failed).toHaveLength(0);
    });

    it("persists agentLaunchFlags so resume keeps dangerous flag and recipe args (#9650)", async () => {
      getAgentSettingsMock.mockResolvedValue({ agents: { claude: { dangerousEnabled: true } } });
      addTerminalMock.mockResolvedValue("terminal-1");

      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-1",
            name: "Agent Recipe",
            projectId: "project-1",
            terminals: [
              {
                type: "claude",
                title: "Claude",
                args: "--recipe-arg value",
                agentModelId: "sonnet",
                env: {},
              },
            ],
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        currentProjectId: "project-1",
      });

      await useRecipeStore
        .getState()
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1");

      const call = addTerminalMock.mock.calls[0]?.[0] as {
        command?: string;
        agentLaunchFlags?: string[];
        agentModelId?: string;
      };
      expect(call.agentLaunchFlags).toEqual(
        expect.arrayContaining(["--dangerously-skip-permissions", "--recipe-arg", "value"])
      );
      expect(call.agentModelId).toBe("sonnet");
      // The initial command must also carry the model — without it the first run
      // uses the default model and only restart (which replays the flags) fixes it.
      expect(call.command).toContain("--model sonnet");
    });

    it("emits no blank flag tokens when an agent terminal has no recipe args (#9650)", async () => {
      getAgentSettingsMock.mockResolvedValue({ agents: { claude: { dangerousEnabled: true } } });
      addTerminalMock.mockResolvedValue("terminal-1");

      useRecipeStore.setState({
        recipes: [
          {
            id: "recipe-1",
            name: "Agent Recipe",
            projectId: "project-1",
            terminals: [{ type: "claude", title: "Claude", env: {} }],
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        currentProjectId: "project-1",
      });

      await useRecipeStore
        .getState()
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1");

      const call = addTerminalMock.mock.calls[0]?.[0] as { agentLaunchFlags?: string[] };
      expect(call.agentLaunchFlags).toEqual(
        expect.arrayContaining(["--dangerously-skip-permissions"])
      );
      expect(call.agentLaunchFlags?.every((f) => f.trim().length > 0)).toBe(true);
    });

    describe("preset resolution (#10722)", () => {
      type AgentSpawnCall = {
        command?: string;
        env?: Record<string, string>;
        agentLaunchFlags?: string[];
        agentPresetId?: string;
        agentPresetColor?: string;
      };

      const runSingleAgentRecipe = async (
        terminal: Record<string, unknown>,
        worktreeId = "worktree-1"
      ): Promise<AgentSpawnCall> => {
        addTerminalMock.mockResolvedValue("terminal-1");
        useRecipeStore.setState({
          recipes: [
            {
              id: "recipe-1",
              name: "Agent Recipe",
              projectId: "project-1",
              terminals: [terminal as never],
              createdAt: Date.now(),
            },
          ],
          isLoading: false,
          currentProjectId: "project-1",
        });
        await useRecipeStore
          .getState()
          .runRecipeWithResults("recipe-1", "/tmp/worktree", worktreeId);
        return addTerminalMock.mock.calls[0]?.[0] as AgentSpawnCall;
      };

      it("folds the agent-wide default preset's args and env into the launch", async () => {
        getAgentSettingsMock.mockResolvedValue({
          agents: {
            claude: {
              presetId: "fast",
              customPresets: [
                { id: "fast", name: "Fast", args: ["--fast"], env: { PRESET_KEY: "preset" } },
              ],
            },
          },
        });

        const call = await runSingleAgentRecipe({ type: "claude", title: "Claude", env: {} });

        expect(call.command).toContain("--fast");
        expect(call.env).toMatchObject({ PRESET_KEY: "preset" });
        expect(call.agentPresetId).toBe("fast");
        expect(call.agentLaunchFlags).toEqual(expect.arrayContaining(["--fast"]));
      });

      it("prefers the worktree-scoped preset over the agent-wide default", async () => {
        getAgentSettingsMock.mockResolvedValue({
          agents: {
            claude: {
              presetId: "fast",
              worktreePresets: { "worktree-1": "careful" },
              customPresets: [
                { id: "fast", name: "Fast", args: ["--fast"] },
                { id: "careful", name: "Careful", args: ["--careful"], color: "#abcdef" },
              ],
            },
          },
        });

        const call = await runSingleAgentRecipe({ type: "claude", title: "Claude", env: {} });

        expect(call.command).toContain("--careful");
        expect(call.command).not.toContain("--fast");
        expect(call.agentPresetId).toBe("careful");
        expect(call.agentPresetColor).toBe("#abcdef");
      });

      it("lets recipe-defined env win over preset env on key conflicts", async () => {
        getAgentSettingsMock.mockResolvedValue({
          agents: {
            claude: {
              presetId: "fast",
              customPresets: [
                {
                  id: "fast",
                  name: "Fast",
                  env: { SHARED: "from-preset", PRESET_ONLY: "preset" },
                },
              ],
            },
          },
        });

        const call = await runSingleAgentRecipe({
          type: "claude",
          title: "Claude",
          env: { SHARED: "from-recipe" },
        });

        expect(call.env).toMatchObject({ SHARED: "from-recipe", PRESET_ONLY: "preset" });
      });

      it("applies preset behavioral overrides to the generated command", async () => {
        getAgentSettingsMock.mockResolvedValue({
          agents: {
            claude: {
              presetId: "danger",
              customPresets: [
                { id: "danger", name: "Danger", dangerousMode: "on", customFlags: "--verbose" },
              ],
            },
          },
        });

        const call = await runSingleAgentRecipe({ type: "claude", title: "Claude", env: {} });

        expect(call.command).toContain("--dangerously-skip-permissions");
        expect(call.command).toContain("--verbose");
      });

      it("falls back to the agent-wide default when the worktree preset is stale", async () => {
        getAgentSettingsMock.mockResolvedValue({
          agents: {
            claude: {
              presetId: "fast",
              worktreePresets: { "worktree-1": "deleted" },
              customPresets: [{ id: "fast", name: "Fast", args: ["--fast"] }],
            },
          },
        });

        const call = await runSingleAgentRecipe({ type: "claude", title: "Claude", env: {} });

        expect(call.command).toContain("--fast");
        expect(call.agentPresetId).toBe("fast");
      });

      it("resolves presets discovered from the CCR source", async () => {
        getAgentSettingsMock.mockResolvedValue({
          agents: { claude: { presetId: "ccr-preset" } },
        });
        ccrPresetsState.ccrPresetsByAgent = {
          claude: [{ id: "ccr-preset", name: "CCR", args: ["--ccr"] }],
        };

        const call = await runSingleAgentRecipe({ type: "claude", title: "Claude", env: {} });

        expect(call.command).toContain("--ccr");
        expect(call.agentPresetId).toBe("ccr-preset");
      });

      it("resolves presets shared via the project source", async () => {
        getAgentSettingsMock.mockResolvedValue({
          agents: { claude: { presetId: "project-preset" } },
        });
        projectPresetsState.presetsByAgent = {
          claude: [{ id: "project-preset", name: "Project", args: ["--project"] }],
        };

        const call = await runSingleAgentRecipe({ type: "claude", title: "Claude", env: {} });

        expect(call.command).toContain("--project");
        expect(call.agentPresetId).toBe("project-preset");
      });

      it("does not attach preset metadata to non-agent terminals", async () => {
        getAgentSettingsMock.mockResolvedValue({ agents: {} });

        const call = await runSingleAgentRecipe({
          type: "terminal",
          title: "Shell",
          command: "npm test",
          env: {},
        });

        expect(call.agentPresetId).toBeUndefined();
        expect(call.agentPresetColor).toBeUndefined();
      });
    });
  });

  it("keeps importing valid terminals even when others are invalid", async () => {
    const input = JSON.stringify({
      name: "Mixed",
      terminals: [
        { type: "terminal", command: "npm test" },
        { type: "invalid-type", command: "whoami" },
      ],
    });

    await useRecipeStore.getState().importRecipe("project-1", input);

    const recipe = useRecipeStore.getState().recipes[0];
    expect(recipe?.terminals).toHaveLength(1);
    expect(recipe?.terminals[0]?.type).toBe("terminal");
  });

  it("preserves args on agent terminals during import", async () => {
    const input = JSON.stringify({
      name: "With Args",
      terminals: [{ type: "claude", title: "Agent", args: "--model sonnet" }],
    });

    await useRecipeStore.getState().importRecipe("project-1", input);

    const recipe = useRecipeStore.getState().recipes[0];
    expect(recipe?.terminals[0]?.args).toBe("--model sonnet");
  });

  it("drops args on non-agent terminals during import", async () => {
    const input = JSON.stringify({
      name: "Terminal Args",
      terminals: [
        { type: "terminal", command: "npm test", args: "--model sonnet" },
        { type: "dev-preview", args: "--flag" },
      ],
    });

    await useRecipeStore.getState().importRecipe("project-1", input);

    const recipe = useRecipeStore.getState().recipes[0];
    expect(recipe?.terminals[0]?.args).toBeUndefined();
    expect(recipe?.terminals[1]?.args).toBeUndefined();
  });

  it("filters out terminals with control characters in args", async () => {
    const input = JSON.stringify({
      name: "Bad Args",
      terminals: [
        { type: "claude", args: "--model\x00evil" },
        { type: "claude", args: "--model sonnet" },
      ],
    });

    await useRecipeStore.getState().importRecipe("project-1", input);

    const recipe = useRecipeStore.getState().recipes[0];
    expect(recipe?.terminals).toHaveLength(1);
    expect(recipe?.terminals[0]?.args).toBe("--model sonnet");
  });

  it("filters out terminals with non-string args", async () => {
    const input = JSON.stringify({
      name: "Array Args",
      terminals: [
        { type: "claude", args: ["--model", "sonnet"] },
        { type: "claude", args: "--valid" },
      ],
    });

    await useRecipeStore.getState().importRecipe("project-1", input);

    const recipe = useRecipeStore.getState().recipes[0];
    expect(recipe?.terminals).toHaveLength(1);
    expect(recipe?.terminals[0]?.args).toBe("--valid");
  });

  it("normalizes empty args to undefined on import", async () => {
    const input = JSON.stringify({
      name: "Empty Args",
      terminals: [{ type: "claude", args: "   " }],
    });

    await useRecipeStore.getState().importRecipe("project-1", input);

    const recipe = useRecipeStore.getState().recipes[0];
    expect(recipe?.terminals[0]?.args).toBeUndefined();
  });

  it("filters out terminals with control characters in env values on import", async () => {
    const input = JSON.stringify({
      name: "Env Injected",
      terminals: [
        { type: "terminal", command: "ok", env: { FOO: "bar\ninjected" } },
        { type: "terminal", command: "ok", env: { FOO: "bar" } },
      ],
    });

    await useRecipeStore.getState().importRecipe("project-1", input);

    const recipe = useRecipeStore.getState().recipes[0];
    expect(recipe?.terminals).toHaveLength(1);
    expect(recipe?.terminals[0]?.env).toEqual({ FOO: "bar" });
  });

  it("sanitizes args on update — keeps for agent, drops for non-agent", async () => {
    useRecipeStore.setState({ currentProjectId: "project-1" });
    await useRecipeStore
      .getState()
      .createRecipe(
        "project-1",
        "Recipe",
        undefined,
        [{ type: "terminal", title: "Shell", command: "npm test", env: {} }],
        false
      );

    const recipeId = useRecipeStore.getState().recipes[0]?.id;
    expect(recipeId).toBeTruthy();

    updateInRepoRecipeMock.mockClear();
    await useRecipeStore.getState().updateRecipe(recipeId!, {
      terminals: [
        { type: "claude", title: "Agent", args: "--model opus", env: {} },
        { type: "terminal", title: "Shell", command: "bash", args: "--model opus", env: {} },
      ],
    });

    const updated = useRecipeStore.getState().recipes[0];
    expect(updated?.terminals[0]?.args).toBe("--model opus");
    expect(updated?.terminals[1]?.args).toBeUndefined();
  });

  describe("global recipes", () => {
    it("loadRecipes fetches from both global and project sources", async () => {
      const globalRecipe = {
        id: "global-1",
        name: "Global Recipe",
        terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
        createdAt: 1000,
      };
      const projectRecipe = {
        id: "project-recipe-1",
        name: "Project Recipe",
        projectId: "project-1",
        terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
        createdAt: 2000,
      };

      globalGetRecipesMock.mockResolvedValueOnce([globalRecipe]);
      getRecipesMock.mockResolvedValueOnce({ recipes: [projectRecipe], collisions: [] });

      await useRecipeStore.getState().loadRecipes("project-1");

      const state = useRecipeStore.getState();
      expect(state.globalRecipes).toHaveLength(1);
      expect(state.projectRecipes).toHaveLength(1);
      expect(state.recipes).toHaveLength(2);
      // Global first, then project
      expect(state.recipes[0]?.id).toBe("global-1");
      expect(state.recipes[1]?.id).toBe("project-recipe-1");
    });

    it("createRecipe with undefined projectId routes to globalRecipesClient", async () => {
      await useRecipeStore
        .getState()
        .createRecipe(
          undefined,
          "Global Recipe",
          undefined,
          [{ type: "terminal", title: "Shell", command: "npm test", env: {} }],
          false
        );

      expect(globalAddRecipeMock).toHaveBeenCalledTimes(1);
      expect(addRecipeMock).not.toHaveBeenCalled();

      const recipe = globalAddRecipeMock.mock.calls[0]?.[0];
      expect(recipe.projectId).toBeUndefined();
      expect(recipe.worktreeId).toBeUndefined();

      const state = useRecipeStore.getState();
      expect(state.globalRecipes).toHaveLength(1);
      expect(state.recipes).toHaveLength(1);
    });

    it("createRecipe with projectId routes to in-repo storage", async () => {
      await useRecipeStore
        .getState()
        .createRecipe(
          "project-1",
          "Project Recipe",
          "wt-1",
          [{ type: "terminal", title: "Shell", command: "npm test", env: {} }],
          false
        );

      expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
      expect(addRecipeMock).not.toHaveBeenCalled();
      expect(globalAddRecipeMock).not.toHaveBeenCalled();

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(state.recipes).toHaveLength(1);
      expect(state.recipes[0]?.scope).toBe("inrepo");
      expect(state.recipes[0]?.id).toMatch(/^recipe-/);
    });

    it("updateRecipe routes global recipes to globalRecipesClient", async () => {
      useRecipeStore.setState({
        globalRecipes: [
          {
            id: "global-1",
            name: "Global",
            terminals: [{ type: "terminal", title: "Shell", env: {} }],
            createdAt: 1000,
          },
        ],
        projectRecipes: [],
        recipes: [
          {
            id: "global-1",
            name: "Global",
            terminals: [{ type: "terminal", title: "Shell", env: {} }],
            createdAt: 1000,
          },
        ],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().updateRecipe("global-1", { name: "Updated Global" });

      expect(globalUpdateRecipeMock).toHaveBeenCalledTimes(1);
      expect(updateRecipeMock).not.toHaveBeenCalled();
    });

    it("deleteRecipe routes global recipes to globalRecipesClient", async () => {
      useRecipeStore.setState({
        globalRecipes: [
          {
            id: "global-1",
            name: "Global",
            terminals: [{ type: "terminal", title: "Shell", env: {} }],
            createdAt: 1000,
          },
        ],
        projectRecipes: [],
        recipes: [
          {
            id: "global-1",
            name: "Global",
            terminals: [{ type: "terminal", title: "Shell", env: {} }],
            createdAt: 1000,
          },
        ],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().deleteRecipe("global-1");

      expect(globalDeleteRecipeMock).toHaveBeenCalledTimes(1);
      expect(deleteRecipeMock).not.toHaveBeenCalled();

      const state = useRecipeStore.getState();
      expect(state.globalRecipes).toHaveLength(0);
      expect(state.recipes).toHaveLength(0);
    });

    it("getRecipesForWorktree includes global recipes", () => {
      useRecipeStore.setState({
        globalRecipes: [
          {
            id: "global-1",
            name: "Global",
            terminals: [{ type: "terminal", title: "Shell", env: {} }],
            createdAt: 1000,
          },
        ],
        projectRecipes: [
          {
            id: "project-1-recipe",
            name: "Project Wide",
            projectId: "project-1",
            terminals: [{ type: "terminal", title: "Shell", env: {} }],
            createdAt: 2000,
          },
        ],
        recipes: [
          {
            id: "global-1",
            name: "Global",
            terminals: [{ type: "terminal", title: "Shell", env: {} }],
            createdAt: 1000,
          },
          {
            id: "project-1-recipe",
            name: "Project Wide",
            projectId: "project-1",
            terminals: [{ type: "terminal", title: "Shell", env: {} }],
            createdAt: 2000,
          },
        ],
        currentProjectId: "project-1",
      });

      const results = useRecipeStore.getState().getRecipesForWorktree(undefined);
      expect(results).toHaveLength(2);
    });

    it("importRecipe with undefined projectId creates global recipe", async () => {
      const input = JSON.stringify({
        name: "Imported Global",
        terminals: [{ type: "terminal", command: "npm test" }],
      });

      await useRecipeStore.getState().importRecipe(undefined, input);

      expect(globalAddRecipeMock).toHaveBeenCalledTimes(1);
      expect(addRecipeMock).not.toHaveBeenCalled();

      const recipe = useRecipeStore.getState().globalRecipes[0];
      expect(recipe?.projectId).toBeUndefined();
      expect(recipe?.worktreeId).toBeUndefined();
    });

    it("global recipe creation clears worktreeId even if provided", async () => {
      await useRecipeStore
        .getState()
        .createRecipe(
          undefined,
          "Global",
          "wt-1",
          [{ type: "terminal", title: "Shell", env: {} }],
          false
        );

      const recipe = globalAddRecipeMock.mock.calls[0]?.[0];
      expect(recipe.worktreeId).toBeUndefined();
    });
  });

  describe("in-repo recipes", () => {
    it("loadRecipes includes in-repo recipes", async () => {
      const inRepoRecipe = {
        id: "inrepo-test",
        name: "Team Recipe",
        terminals: [{ type: "terminal" as const, title: "Shell" }],
        createdAt: 500,
      };
      globalGetRecipesMock.mockResolvedValueOnce([]);
      getRecipesMock.mockResolvedValueOnce({ recipes: [], collisions: [] });
      getInRepoRecipesMock.mockResolvedValueOnce([inRepoRecipe]);

      await useRecipeStore.getState().loadRecipes("project-1");

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(state.recipes).toHaveLength(1);
      expect(state.recipes[0]?.id).toBe("inrepo-test");
    });

    it("loadRecipes de-duplicates ProjectFileStore mirrors for in-repo recipes", async () => {
      const inRepoRecipe = {
        id: "recipe-opaque-abc",
        name: "Team Recipe",
        scope: "inrepo" as const,
        terminals: [{ type: "terminal" as const, title: "Shell" }],
        createdAt: 500,
      };
      const projectMirror = {
        ...inRepoRecipe,
        projectId: "project-1",
        lastUsedAt: 900,
        usageHistory: [800, 900],
        terminals: [{ type: "terminal" as const, title: "Shell", env: { TOKEN: "" } }],
      };
      globalGetRecipesMock.mockResolvedValueOnce([]);
      getRecipesMock.mockResolvedValueOnce({ recipes: [projectMirror], collisions: [] });
      getInRepoRecipesMock.mockResolvedValueOnce([inRepoRecipe]);

      await useRecipeStore.getState().loadRecipes("project-1");

      const state = useRecipeStore.getState();
      expect(state.projectRecipes).toHaveLength(1);
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(state.recipes).toHaveLength(1);
      expect(state.recipes[0]).toMatchObject({
        id: "recipe-opaque-abc",
        scope: "inrepo",
        projectId: "project-1",
        lastUsedAt: 900,
        usageHistory: [800, 900],
      });
      expect(state.recipes[0]?.shadowedBy).toBeUndefined();
      expect(state.recipes[0]?.terminals[0]?.env).toEqual({ TOKEN: "" });
    });

    it("createRecipe assigns an opaque UUID id (not name-derived) and inrepo scope", async () => {
      await useRecipeStore
        .getState()
        .createRecipe("project-1", "Team Recipe", undefined, [
          { type: "terminal", title: "Shell", env: {} },
        ]);

      expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
      const persisted = updateInRepoRecipeMock.mock.calls[0]?.[1];
      expect(persisted.scope).toBe("inrepo");
      expect(persisted.id).toMatch(/^recipe-/);
      expect(persisted.id.startsWith("inrepo-")).toBe(false);
    });

    it("updateRecipe preserves the opaque id across a rename", async () => {
      const inRepoRecipe = {
        id: "recipe-opaque-abc",
        name: "Before",
        scope: "inrepo" as const,
        terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
        createdAt: 500,
      };
      useRecipeStore.setState({
        inRepoRecipes: [inRepoRecipe],
        globalRecipes: [],
        projectRecipes: [],
        recipes: [inRepoRecipe],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().updateRecipe("recipe-opaque-abc", { name: "After" });

      const state = useRecipeStore.getState();
      // Id is unchanged (detected as in-repo via scope, not the id prefix).
      expect(state.inRepoRecipes[0]?.id).toBe("recipe-opaque-abc");
      expect(state.inRepoRecipes[0]?.name).toBe("After");
      expect(updateInRepoRecipeMock.mock.calls[0]?.[1].id).toBe("recipe-opaque-abc");
    });

    it("loadRecipes surfaces a filename collision via a low-priority notification", async () => {
      globalGetRecipesMock.mockResolvedValueOnce([]);
      getRecipesMock.mockResolvedValueOnce({
        recipes: [],
        collisions: [
          {
            filename: "shared.json",
            keptId: "recipe-a",
            droppedId: "recipe-b",
            droppedName: "Shared",
          },
        ],
      });
      getInRepoRecipesMock.mockResolvedValueOnce([]);

      await useRecipeStore.getState().loadRecipes("project-1");

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const payload = notifyMock.mock.calls[0]?.[0];
      expect(payload.type).toBe("warning");
      expect(payload.priority).toBe("low");
      expect(payload.title).toBe("Recipe name conflict");
    });

    it("loadRecipes does not notify when there are no collisions", async () => {
      globalGetRecipesMock.mockResolvedValueOnce([]);
      getRecipesMock.mockResolvedValueOnce({ recipes: [], collisions: [] });
      getInRepoRecipesMock.mockResolvedValueOnce([]);

      await useRecipeStore.getState().loadRecipes("project-1");

      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("in-repo recipes shadow project-local recipes with same name", async () => {
      const inRepoRecipe = {
        id: "inrepo-1",
        name: "Shared Recipe",
        terminals: [{ type: "terminal" as const }],
        createdAt: 100,
      };
      const projectRecipe = {
        id: "project-1",
        name: "Shared Recipe",
        projectId: "proj-1",
        terminals: [{ type: "terminal" as const }],
        createdAt: 200,
      };
      globalGetRecipesMock.mockResolvedValueOnce([]);
      getRecipesMock.mockResolvedValueOnce({ recipes: [projectRecipe], collisions: [] });
      getInRepoRecipesMock.mockResolvedValueOnce([inRepoRecipe]);

      await useRecipeStore.getState().loadRecipes("proj-1");

      const state = useRecipeStore.getState();
      // Both recipes appear: the project one is marked shadowed, the in-repo one wins
      expect(state.recipes).toHaveLength(2);
      const project = state.recipes.find((r) => r.id === "project-1");
      const inRepo = state.recipes.find((r) => r.id === "inrepo-1");
      expect(project?.shadowedBy).toBe("Shared Recipe");
      expect(inRepo?.shadowedBy).toBeUndefined();
    });

    it("in-repo recipes take precedence over both project-local and global recipes", async () => {
      const globalRecipe = {
        id: "global-1",
        name: "Shared Recipe",
        isGlobal: true as const,
        terminals: [{ type: "terminal" as const }],
        createdAt: 50,
      };
      const projectRecipe = {
        id: "project-1",
        name: "Shared Recipe",
        projectId: "proj-1",
        terminals: [{ type: "terminal" as const }],
        createdAt: 100,
      };
      const inRepoRecipe = {
        id: "inrepo-1",
        name: "Shared Recipe",
        terminals: [{ type: "terminal" as const }],
        createdAt: 200,
      };
      globalGetRecipesMock.mockResolvedValueOnce([globalRecipe]);
      getRecipesMock.mockResolvedValueOnce({ recipes: [projectRecipe], collisions: [] });
      getInRepoRecipesMock.mockResolvedValueOnce([inRepoRecipe]);

      await useRecipeStore.getState().loadRecipes("proj-1");

      const state = useRecipeStore.getState();
      // Global is not deduplicated, project is shadowed, in-repo wins
      expect(state.recipes).toHaveLength(3);
      expect(state.recipes.map((r) => r.id)).toEqual(["global-1", "project-1", "inrepo-1"]);
      const project = state.recipes.find((r) => r.id === "project-1");
      expect(project?.shadowedBy).toBe("Shared Recipe");
    });

    it("stripSessionOverridesFromRecipe removes shadowedBy", async () => {
      // We import the function indirectly by testing that loaded recipes never have shadowedBy
      // shadowedBy is stripped at load time via stripSessionOverridesFromRecipe
      const inRepoRecipe = {
        id: "inrepo-1",
        name: "Work",
        terminals: [{ type: "terminal" as const }],
        createdAt: 100,
      };
      const projectRecipe = {
        id: "project-1",
        name: "Work",
        projectId: "proj-1",
        terminals: [{ type: "terminal" as const }],
        createdAt: 200,
      };
      globalGetRecipesMock.mockResolvedValueOnce([]);
      getRecipesMock.mockResolvedValueOnce({ recipes: [projectRecipe], collisions: [] });
      getInRepoRecipesMock.mockResolvedValueOnce([inRepoRecipe]);

      await useRecipeStore.getState().loadRecipes("proj-1");

      const state = useRecipeStore.getState();
      // The shadowedBy marker is only on the merged recipes list, not on source arrays
      expect(state.projectRecipes[0]?.shadowedBy).toBeUndefined();
      expect(state.inRepoRecipes[0]?.shadowedBy).toBeUndefined();
      // But the merged list has the marker
      expect(state.recipes.find((r) => r.id === "project-1")?.shadowedBy).toBe("Work");
    });

    it("project recipe with unique name is not shadowed", async () => {
      const inRepoRecipe = {
        id: "inrepo-1",
        name: "Team Only",
        terminals: [{ type: "terminal" as const }],
        createdAt: 100,
      };
      const projectRecipe = {
        id: "project-1",
        name: "My Local",
        projectId: "proj-1",
        terminals: [{ type: "terminal" as const }],
        createdAt: 200,
      };
      globalGetRecipesMock.mockResolvedValueOnce([]);
      getRecipesMock.mockResolvedValueOnce({ recipes: [projectRecipe], collisions: [] });
      getInRepoRecipesMock.mockResolvedValueOnce([inRepoRecipe]);

      await useRecipeStore.getState().loadRecipes("proj-1");

      const state = useRecipeStore.getState();
      expect(state.recipes).toHaveLength(2);
      expect(state.recipes.find((r) => r.id === "project-1")?.shadowedBy).toBeUndefined();
    });

    it("updateRecipe routes in-repo recipe to updateInRepoRecipe client", async () => {
      const inRepoRecipe = {
        id: "inrepo-test",
        name: "Team Recipe",
        terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
        createdAt: 500,
      };
      useRecipeStore.setState({
        inRepoRecipes: [inRepoRecipe],
        globalRecipes: [],
        projectRecipes: [],
        recipes: [inRepoRecipe],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().updateRecipe("inrepo-test", { name: "Updated Team" });

      expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
      expect(updateRecipeMock).not.toHaveBeenCalled();
      expect(globalUpdateRecipeMock).not.toHaveBeenCalled();

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes[0]?.name).toBe("Updated Team");
      expect(state.recipes[0]?.name).toBe("Updated Team");
    });

    it("updateRecipe passes previousName when in-repo recipe is renamed", async () => {
      const inRepoRecipe = {
        id: "inrepo-test",
        name: "Old Name",
        terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
        createdAt: 500,
      };
      useRecipeStore.setState({
        inRepoRecipes: [inRepoRecipe],
        globalRecipes: [],
        projectRecipes: [],
        recipes: [inRepoRecipe],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().updateRecipe("inrepo-test", { name: "New Name" });

      expect(updateInRepoRecipeMock).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ name: "New Name" }),
        "Old Name"
      );
    });

    it("updateRecipe skips file write for metadata-only in-repo update", async () => {
      const inRepoRecipe = {
        id: "inrepo-test",
        name: "Team Recipe",
        terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
        createdAt: 500,
      };
      useRecipeStore.setState({
        inRepoRecipes: [inRepoRecipe],
        globalRecipes: [],
        projectRecipes: [],
        recipes: [inRepoRecipe],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().updateRecipe("inrepo-test", { lastUsedAt: 999 });

      expect(updateInRepoRecipeMock).not.toHaveBeenCalled();
      expect(updateRecipeMock).not.toHaveBeenCalled();
    });

    it("deleteRecipe routes in-repo recipe to deleteInRepoRecipe client", async () => {
      const inRepoRecipe = {
        id: "inrepo-test",
        name: "Team Recipe",
        terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
        createdAt: 500,
      };
      useRecipeStore.setState({
        inRepoRecipes: [inRepoRecipe],
        globalRecipes: [],
        projectRecipes: [],
        recipes: [inRepoRecipe],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().deleteRecipe("inrepo-test");

      expect(deleteInRepoRecipeMock).toHaveBeenCalledWith("project-1", "Team Recipe");
      expect(deleteRecipeMock).not.toHaveBeenCalled();
      expect(globalDeleteRecipeMock).not.toHaveBeenCalled();

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(0);
      expect(state.recipes).toHaveLength(0);
    });

    it("deleteRecipe rolls back inRepoRecipes on failure", async () => {
      const inRepoRecipe = {
        id: "inrepo-test",
        name: "Team Recipe",
        terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
        createdAt: 500,
      };
      useRecipeStore.setState({
        inRepoRecipes: [inRepoRecipe],
        globalRecipes: [],
        projectRecipes: [],
        recipes: [inRepoRecipe],
        currentProjectId: "project-1",
      });

      deleteInRepoRecipeMock.mockRejectedValueOnce(new Error("disk error"));

      await expect(useRecipeStore.getState().deleteRecipe("inrepo-test")).rejects.toThrow(
        "disk error"
      );

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(state.recipes).toHaveLength(1);
    });

    describe("RECIPE_STALE_CONFLICT handling (#9186)", () => {
      function makeConflictError(name: string) {
        // Mirror the `[AppError|<code>|<urlencoded userMessage>] <message>`
        // shape the preload injects on AppError throws so `isClientAppError`
        // recognizes the encoded prefix.
        const userMsg = encodeURIComponent(name);
        const err = new Error(
          `[AppError|RECIPE_STALE_CONFLICT|${userMsg}] Recipe '${name}' changed on disk`
        );
        err.name = "Error";
        return err;
      }

      async function importConflictStore() {
        // Loaded lazily to avoid initialization order coupling with the
        // hoisted client mocks above.
        const mod = await import("../recipeConflictStore");
        mod.useRecipeConflictStore.setState({ pendingConflict: null });
        return mod.useRecipeConflictStore;
      }

      const inRepoRecipe = {
        id: "inrepo-test",
        name: "Conflict Recipe",
        terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
        createdAt: 500,
      };

      function seedStore() {
        useRecipeStore.setState({
          inRepoRecipes: [inRepoRecipe],
          globalRecipes: [],
          projectRecipes: [],
          recipes: [inRepoRecipe],
          currentProjectId: "project-1",
        });
      }

      it("surfaces a pending conflict on the conflict store, rolls back, and does not throw", async () => {
        seedStore();
        const store = await importConflictStore();
        updateInRepoRecipeMock.mockRejectedValueOnce(makeConflictError("Conflict Recipe"));

        const promise = useRecipeStore
          .getState()
          .updateRecipe("inrepo-test", { name: "Conflict Recipe", lastUsedAt: 1 });

        // Yield so the catch enqueues the conflict before we read it.
        await Promise.resolve();
        await Promise.resolve();
        const pending = store.getState().pendingConflict;
        expect(pending).not.toBeNull();
        expect(pending?.recipeId).toBe("inrepo-test");
        expect(pending?.recipeName).toBe("Conflict Recipe");

        // Resolve as cancel — the updateRecipe call should settle without throwing.
        store.getState().resolveConflict("cancel");
        await expect(promise).resolves.toBeUndefined();

        // State rolled back to pre-edit snapshot.
        const state = useRecipeStore.getState();
        expect(state.inRepoRecipes[0]?.name).toBe("Conflict Recipe");
      });

      it("'reload' resolution triggers loadRecipes and does not rethrow", async () => {
        seedStore();
        const store = await importConflictStore();
        updateInRepoRecipeMock.mockRejectedValueOnce(makeConflictError("Conflict Recipe"));
        globalGetRecipesMock.mockResolvedValueOnce([]);
        getRecipesMock.mockResolvedValueOnce({ recipes: [], collisions: [] });
        getInRepoRecipesMock.mockResolvedValueOnce([{ ...inRepoRecipe, name: "Disk Version" }]);

        const promise = useRecipeStore.getState().updateRecipe("inrepo-test", { name: "Mine" });
        await Promise.resolve();
        await Promise.resolve();
        store.getState().resolveConflict("reload");
        await expect(promise).resolves.toBeUndefined();
        // Wait one more tick for the fire-and-forget loadRecipes to settle.
        await new Promise((r) => setTimeout(r, 0));
        expect(getInRepoRecipesMock).toHaveBeenCalled();
      });

      it("'overwrite' resolution retries the IPC call with force:true and re-applies the edit", async () => {
        seedStore();
        const store = await importConflictStore();
        updateInRepoRecipeMock.mockRejectedValueOnce(makeConflictError("Conflict Recipe"));
        updateInRepoRecipeMock.mockResolvedValueOnce(undefined);

        const promise = useRecipeStore
          .getState()
          .updateRecipe("inrepo-test", { name: "Forced Name" });
        await Promise.resolve();
        await Promise.resolve();
        store.getState().resolveConflict("overwrite");
        await expect(promise).resolves.toBeUndefined();

        expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(2);
        // Second call carries force:true and the previous-name (for rename support).
        const secondCall = updateInRepoRecipeMock.mock.calls[1];
        expect(secondCall?.[3]).toEqual({ force: true });
        expect(secondCall?.[2]).toBe("Conflict Recipe");

        // Optimistic edit landed back in state after the forced write.
        const state = useRecipeStore.getState();
        // After rename the recipe id is regenerated from the new name.
        expect(state.inRepoRecipes[0]?.name).toBe("Forced Name");
      });
    });

    it("updateRecipe rolls back inRepoRecipes on failure", async () => {
      const inRepoRecipe = {
        id: "inrepo-test",
        name: "Team Recipe",
        terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
        createdAt: 500,
      };
      useRecipeStore.setState({
        inRepoRecipes: [inRepoRecipe],
        globalRecipes: [],
        projectRecipes: [],
        recipes: [inRepoRecipe],
        currentProjectId: "project-1",
      });

      updateInRepoRecipeMock.mockRejectedValueOnce(new Error("write error"));

      await expect(
        useRecipeStore.getState().updateRecipe("inrepo-test", { name: "New Name" })
      ).rejects.toThrow("write error");

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes[0]?.name).toBe("Team Recipe");
      expect(state.recipes[0]?.name).toBe("Team Recipe");
    });

    it("reset clears inRepoRecipes", () => {
      useRecipeStore.setState({
        inRepoRecipes: [{ id: "x", name: "x", terminals: [], createdAt: 0 }],
      });
      useRecipeStore.getState().reset();
      expect(useRecipeStore.getState().inRepoRecipes).toEqual([]);
    });

    it("createRecipe with projectId generates an opaque id (not name-derived) with inrepo scope", async () => {
      await useRecipeStore
        .getState()
        .createRecipe(
          "project-1",
          "My Dev Setup",
          undefined,
          [{ type: "terminal", title: "Shell", env: {} }],
          false
        );

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
      // Id is opaque — independent of the (mutable) name — so a rename can't
      // orphan it (#9195).
      expect(state.inRepoRecipes[0]?.id).toMatch(/^recipe-/);
      expect(state.inRepoRecipes[0]?.id).not.toContain("my-dev-setup");
      expect(state.inRepoRecipes[0]?.scope).toBe("inrepo");
      expect(updateInRepoRecipeMock).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({
          name: "My Dev Setup",
          scope: "inrepo",
        })
      );
    });

    it("updateRecipe routes in-repo recipes to updateInRepoRecipe", async () => {
      useRecipeStore.setState({
        inRepoRecipes: [
          {
            id: "inrepo-test",
            name: "Test",
            terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
            createdAt: 500,
          },
        ],
        projectRecipes: [],
        globalRecipes: [],
        recipes: [
          {
            id: "inrepo-test",
            name: "Test",
            terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
            createdAt: 500,
          },
        ],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().updateRecipe("inrepo-test", { name: "Updated Test" });

      expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
      expect(globalUpdateRecipeMock).not.toHaveBeenCalled();
      expect(updateRecipeMock).not.toHaveBeenCalled();
    });

    it("updateRecipe with name change deletes old in-repo file", async () => {
      useRecipeStore.setState({
        inRepoRecipes: [
          {
            id: "inrepo-old-name",
            name: "Old Name",
            terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
            createdAt: 500,
          },
        ],
        projectRecipes: [],
        globalRecipes: [],
        recipes: [
          {
            id: "inrepo-old-name",
            name: "Old Name",
            terminals: [{ type: "terminal" as const, title: "Shell", env: {} }],
            createdAt: 500,
          },
        ],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().updateRecipe("inrepo-old-name", { name: "New Name" });

      expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
      // The id is stable across the rename; previousName tells the main process
      // which old-name file to delete.
      expect(updateInRepoRecipeMock).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ id: "inrepo-old-name", name: "New Name" }),
        "Old Name"
      );
      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes[0]?.id).toBe("inrepo-old-name");
    });

    it("deleteRecipe routes in-repo recipes to deleteInRepoRecipe", async () => {
      useRecipeStore.setState({
        inRepoRecipes: [
          {
            id: "inrepo-doomed",
            name: "Doomed",
            terminals: [{ type: "terminal" as const }],
            createdAt: 500,
          },
        ],
        projectRecipes: [],
        globalRecipes: [],
        recipes: [
          {
            id: "inrepo-doomed",
            name: "Doomed",
            terminals: [{ type: "terminal" as const }],
            createdAt: 500,
          },
        ],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().deleteRecipe("inrepo-doomed");

      expect(deleteInRepoRecipeMock).toHaveBeenCalledWith("project-1", "Doomed");
      expect(globalDeleteRecipeMock).not.toHaveBeenCalled();
      expect(deleteRecipeMock).not.toHaveBeenCalled();
      expect(useRecipeStore.getState().inRepoRecipes).toHaveLength(0);
    });

    it("importRecipe with projectId routes to in-repo storage", async () => {
      const input = JSON.stringify({
        name: "Imported Project",
        terminals: [{ type: "terminal", command: "npm test" }],
      });

      await useRecipeStore.getState().importRecipe("project-1", input);

      expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
      expect(addRecipeMock).not.toHaveBeenCalled();

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(state.inRepoRecipes[0]?.id).toMatch(/^recipe-/);
      expect(state.inRepoRecipes[0]?.scope).toBe("inrepo");
    });

    it("rename to same normalized name does not delete the file", async () => {
      useRecipeStore.setState({
        inRepoRecipes: [
          {
            id: "inrepo-cafe",
            name: "Cafe",
            terminals: [{ type: "terminal" as const }],
            createdAt: 500,
          },
        ],
        projectRecipes: [],
        globalRecipes: [],
        recipes: [
          {
            id: "inrepo-cafe",
            name: "Cafe",
            terminals: [{ type: "terminal" as const }],
            createdAt: 500,
          },
        ],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().updateRecipe("inrepo-cafe", { name: "cafe" });

      expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
      expect(deleteInRepoRecipeMock).not.toHaveBeenCalled();
      expect(useRecipeStore.getState().inRepoRecipes[0]?.name).toBe("cafe");
    });

    it("in-repo recipe with projectId=undefined does NOT route to global on update", async () => {
      useRecipeStore.setState({
        inRepoRecipes: [
          {
            id: "inrepo-test",
            name: "Test",
            terminals: [{ type: "terminal" as const }],
            createdAt: 500,
          },
        ],
        projectRecipes: [],
        globalRecipes: [],
        recipes: [
          {
            id: "inrepo-test",
            name: "Test",
            terminals: [{ type: "terminal" as const }],
            createdAt: 500,
          },
        ],
        currentProjectId: "project-1",
      });

      await useRecipeStore.getState().updateRecipe("inrepo-test", { lastUsedAt: 999 });

      // lastUsedAt is metadata-only, so no IPC write is performed
      expect(updateInRepoRecipeMock).not.toHaveBeenCalled();
      expect(globalUpdateRecipeMock).not.toHaveBeenCalled();
    });
  });

  describe("saveToRepo", () => {
    const globalRecipe = {
      id: "global-1",
      name: "My Global Recipe",
      terminals: [{ type: "terminal" as const, title: "Shell", command: "npm test", env: {} }],
      createdAt: 1000,
    };

    const projectRecipe = {
      id: "project-recipe-1",
      name: "My Project Recipe",
      projectId: "project-1",
      worktreeId: "wt-1",
      terminals: [{ type: "terminal" as const, title: "Shell", command: "npm start", env: {} }],
      createdAt: 2000,
    };

    function setupWithGlobal() {
      useRecipeStore.setState({
        globalRecipes: [globalRecipe],
        projectRecipes: [],
        inRepoRecipes: [],
        recipes: [globalRecipe],
        currentProjectId: "project-1",
      });
    }

    function setupWithProject() {
      useRecipeStore.setState({
        globalRecipes: [],
        projectRecipes: [projectRecipe],
        inRepoRecipes: [],
        recipes: [projectRecipe],
        currentProjectId: "project-1",
      });
    }

    it("promotes a global recipe to in-repo, keeping original", async () => {
      setupWithGlobal();
      await useRecipeStore.getState().saveToRepo("global-1", false);

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(state.inRepoRecipes[0]?.id).toMatch(/^recipe-/);
      expect(state.inRepoRecipes[0]?.scope).toBe("inrepo");
      expect(state.inRepoRecipes[0]?.name).toBe("My Global Recipe");
      expect(state.inRepoRecipes[0]).not.toHaveProperty("projectId");
      expect(state.inRepoRecipes[0]).not.toHaveProperty("worktreeId");
      expect(state.globalRecipes).toHaveLength(1);
      expect(updateInRepoRecipeMock).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ name: "My Global Recipe", scope: "inrepo" })
      );
      expect(globalDeleteRecipeMock).not.toHaveBeenCalled();
    });

    it("promotes a global recipe and deletes original", async () => {
      setupWithGlobal();
      await useRecipeStore.getState().saveToRepo("global-1", true);

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(state.globalRecipes).toHaveLength(0);
      expect(globalDeleteRecipeMock).toHaveBeenCalledWith("global-1");
    });

    it("promotes a project-local recipe, keeping original (shadowed by name)", async () => {
      setupWithProject();
      await useRecipeStore.getState().saveToRepo("project-recipe-1", false);

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(state.projectRecipes).toHaveLength(1);
      // Both recipes appear: project is marked shadowed, in-repo is the winner
      const matching = state.recipes.filter((r) => r.name === "My Project Recipe");
      expect(matching).toHaveLength(2);
      const project = matching.find((r) => r.id === "project-recipe-1");
      const inRepo = matching.find((r) => r.scope === "inrepo");
      expect(project?.shadowedBy).toBe("My Project Recipe");
      expect(inRepo?.shadowedBy).toBeUndefined();
    });

    it("promotes a project-local recipe and deletes original", async () => {
      setupWithProject();
      await useRecipeStore.getState().saveToRepo("project-recipe-1", true);

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(state.projectRecipes).toHaveLength(0);
      expect(deleteRecipeMock).toHaveBeenCalledWith("project-1", "project-recipe-1");
    });

    it("strips projectId and worktreeId from promoted recipe", async () => {
      setupWithProject();
      await useRecipeStore.getState().saveToRepo("project-recipe-1", false);

      const promoted = updateInRepoRecipeMock.mock.calls[0]?.[1];
      expect(promoted.projectId).toBeUndefined();
      expect(promoted.worktreeId).toBeUndefined();
    });

    it("rolls back all slices when updateInRepoRecipe fails", async () => {
      setupWithGlobal();
      updateInRepoRecipeMock.mockRejectedValueOnce(new Error("disk error"));

      await expect(useRecipeStore.getState().saveToRepo("global-1", true)).rejects.toThrow(
        "disk error"
      );

      const state = useRecipeStore.getState();
      expect(state.globalRecipes).toHaveLength(1);
      expect(state.inRepoRecipes).toHaveLength(0);
      expect(state.recipes).toHaveLength(1);
    });

    it("keeps in-repo copy when delete-original fails after successful write", async () => {
      setupWithGlobal();
      globalDeleteRecipeMock.mockRejectedValueOnce(new Error("delete failed"));

      await expect(useRecipeStore.getState().saveToRepo("global-1", true)).rejects.toThrow(
        "delete failed"
      );

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(state.globalRecipes).toHaveLength(1);
      expect(updateInRepoRecipeMock).toHaveBeenCalledTimes(1);
    });

    it("deleteRecipe finds shadowed project recipe after saveToRepo", async () => {
      setupWithProject();
      await useRecipeStore.getState().saveToRepo("project-recipe-1", false);

      // The project recipe is shadowed in the merged list, but deleteRecipe should still find it
      await useRecipeStore.getState().deleteRecipe("project-recipe-1");

      const state = useRecipeStore.getState();
      expect(state.projectRecipes).toHaveLength(0);
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(deleteRecipeMock).toHaveBeenCalledWith("project-1", "project-recipe-1");
    });

    it("throws when recipe is not found", async () => {
      useRecipeStore.setState({ recipes: [], currentProjectId: "project-1" });
      await expect(useRecipeStore.getState().saveToRepo("nonexistent")).rejects.toThrow(
        "not found"
      );
    });

    it("throws when recipe is already in-repo", async () => {
      const inRepoRecipe = {
        id: "inrepo-test",
        name: "Test",
        terminals: [{ type: "terminal" as const }],
        createdAt: 500,
      };
      useRecipeStore.setState({
        inRepoRecipes: [inRepoRecipe],
        recipes: [inRepoRecipe],
        currentProjectId: "project-1",
      });
      await expect(useRecipeStore.getState().saveToRepo("inrepo-test")).rejects.toThrow(
        "already in-repo"
      );
    });

    it("throws when no current project", async () => {
      useRecipeStore.setState({
        globalRecipes: [globalRecipe],
        recipes: [globalRecipe],
        currentProjectId: null,
      });
      await expect(useRecipeStore.getState().saveToRepo("global-1")).rejects.toThrow(
        "No current project"
      );
    });

    it("upserts without duplicating when called twice for the same recipe", async () => {
      setupWithGlobal();
      await useRecipeStore.getState().saveToRepo("global-1", false);
      await useRecipeStore.getState().saveToRepo("global-1", false);

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
    });

    it("reuses an existing in-repo id when promoting a filename-slug variant of an existing name", async () => {
      const existingInRepo = {
        id: "recipe-existing-abc",
        name: "My Recipe",
        scope: "inrepo" as const,
        terminals: [{ type: "terminal" as const, env: {} }],
        createdAt: 100,
      };
      const localVariant = {
        id: "project-variant",
        name: "my recipe", // slugs to the same my-recipe.json as "My Recipe"
        projectId: "project-1",
        terminals: [{ type: "terminal" as const, env: {} }],
        createdAt: 200,
      };
      useRecipeStore.setState({
        globalRecipes: [],
        projectRecipes: [localVariant],
        inRepoRecipes: [existingInRepo],
        recipes: [localVariant, existingInRepo],
        currentProjectId: "project-1",
      });

      await expect(
        useRecipeStore.getState().saveToRepo("project-variant", false)
      ).resolves.toBeUndefined();

      // Reuses the existing in-repo id (same on-disk filename) — an idempotent
      // update, not a duplicate that would hit an on-disk stale conflict.
      const promoted = updateInRepoRecipeMock.mock.calls[0]?.[1];
      expect(promoted.id).toBe("recipe-existing-abc");
      expect(useRecipeStore.getState().inRepoRecipes).toHaveLength(1);
    });
  });

  describe("file export/import", () => {
    it("exportRecipeToFile calls client with recipe name and JSON", async () => {
      useRecipeStore.setState({
        recipes: [
          {
            id: "r-1",
            name: "My Recipe",
            projectId: "proj-1",
            terminals: [{ type: "terminal" as const }],
            createdAt: 100,
          },
        ],
        projectRecipes: [
          {
            id: "r-1",
            name: "My Recipe",
            projectId: "proj-1",
            terminals: [{ type: "terminal" as const }],
            createdAt: 100,
          },
        ],
        globalRecipes: [],
      });

      await useRecipeStore.getState().exportRecipeToFile("r-1");

      expect(exportRecipeToFileMock).toHaveBeenCalledWith("My Recipe", expect.any(String));
      const json = JSON.parse(exportRecipeToFileMock.mock.calls[0]![1]);
      expect(json).not.toHaveProperty("projectId");
    });

    it("importRecipeFromFile returns false when cancelled", async () => {
      importRecipeFromFileMock.mockResolvedValueOnce(null);
      const result = await useRecipeStore.getState().importRecipeFromFile("proj-1");
      expect(result).toBe(false);
    });
  });
});
