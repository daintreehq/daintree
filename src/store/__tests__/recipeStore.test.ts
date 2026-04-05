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
} = vi.hoisted(() => ({
  addRecipeMock: vi.fn().mockResolvedValue(undefined),
  getRecipesMock: vi.fn().mockResolvedValue([]),
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
  globalRecipesClient: {
    getRecipes: globalGetRecipesMock,
    addRecipe: globalAddRecipeMock,
    updateRecipe: globalUpdateRecipeMock,
    deleteRecipe: globalDeleteRecipeMock,
  },
}));

vi.mock("../terminalStore", () => ({
  useTerminalStore: {
    getState: vi.fn(() => ({
      terminals: [],
      addTerminal: addTerminalMock,
    })),
  },
}));

import { useRecipeStore } from "../recipeStore";

describe("recipeStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRecipeStore.getState().reset();
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
    expect(recipeId).toMatch(/^inrepo-/);

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
    expect(spawned.kind).toBe("agent");
    expect(spawned.agentId).toBe("codex");
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
        .runRecipeWithResults("recipe-1", "/tmp/worktree", "worktree-1", undefined, [1]);

      expect(addTerminalMock).toHaveBeenCalledTimes(1);
      expect(results.spawned).toHaveLength(1);
      expect(results.spawned[0]?.index).toBe(1);
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
      terminals: [
        { type: "claude", title: "Agent", args: "--model sonnet" },
      ],
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
      terminals: [
        { type: "claude", args: "   " },
      ],
    });

    await useRecipeStore.getState().importRecipe("project-1", input);

    const recipe = useRecipeStore.getState().recipes[0];
    expect(recipe?.terminals[0]?.args).toBeUndefined();
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
      getRecipesMock.mockResolvedValueOnce([projectRecipe]);

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
      expect(state.recipes[0]?.id).toMatch(/^inrepo-/);
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
      getRecipesMock.mockResolvedValueOnce([]);
      getInRepoRecipesMock.mockResolvedValueOnce([inRepoRecipe]);

      await useRecipeStore.getState().loadRecipes("project-1");

      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes).toHaveLength(1);
      expect(state.recipes).toHaveLength(1);
      expect(state.recipes[0]?.id).toBe("inrepo-test");
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
      getRecipesMock.mockResolvedValueOnce([projectRecipe]);
      getInRepoRecipesMock.mockResolvedValueOnce([inRepoRecipe]);

      await useRecipeStore.getState().loadRecipes("proj-1");

      const state = useRecipeStore.getState();
      expect(state.recipes).toHaveLength(1);
      expect(state.recipes[0]?.id).toBe("inrepo-1");
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
      getRecipesMock.mockResolvedValueOnce([projectRecipe]);
      getInRepoRecipesMock.mockResolvedValueOnce([inRepoRecipe]);

      await useRecipeStore.getState().loadRecipes("proj-1");

      const state = useRecipeStore.getState();
      // Global is not deduplicated (pre-existing behavior), so we get global + in-repo
      expect(state.recipes).toHaveLength(2);
      expect(state.recipes.map((r) => r.id)).toEqual(["global-1", "inrepo-1"]);
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

    it("createRecipe with projectId generates inrepo- prefixed ID", async () => {
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
      expect(state.inRepoRecipes[0]?.id).toBe("inrepo-my-dev-setup");
      expect(updateInRepoRecipeMock).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({
          id: "inrepo-my-dev-setup",
          name: "My Dev Setup",
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
      expect(updateInRepoRecipeMock).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ id: "inrepo-new-name", name: "New Name" }),
        "Old Name"
      );
      const state = useRecipeStore.getState();
      expect(state.inRepoRecipes[0]?.id).toBe("inrepo-new-name");
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
      expect(state.inRepoRecipes[0]?.id).toMatch(/^inrepo-/);
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
      expect(state.inRepoRecipes[0]?.id).toBe("inrepo-my-global-recipe");
      expect(state.inRepoRecipes[0]?.name).toBe("My Global Recipe");
      expect(state.inRepoRecipes[0]).not.toHaveProperty("projectId");
      expect(state.inRepoRecipes[0]).not.toHaveProperty("worktreeId");
      expect(state.globalRecipes).toHaveLength(1);
      expect(updateInRepoRecipeMock).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ id: "inrepo-my-global-recipe" })
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
      // Project recipe is shadowed by the in-repo recipe with the same name
      expect(state.recipes.filter((r) => r.name === "My Project Recipe")).toHaveLength(1);
      expect(state.recipes.find((r) => r.name === "My Project Recipe")?.id).toBe(
        "inrepo-my-project-recipe"
      );
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
