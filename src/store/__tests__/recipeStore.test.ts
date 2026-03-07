import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  addRecipeMock,
  getRecipesMock,
  updateRecipeMock,
  deleteRecipeMock,
  addTerminalMock,
  getAgentSettingsMock,
} = vi.hoisted(() => ({
  addRecipeMock: vi.fn().mockResolvedValue(undefined),
  getRecipesMock: vi.fn().mockResolvedValue([]),
  updateRecipeMock: vi.fn().mockResolvedValue(undefined),
  deleteRecipeMock: vi.fn().mockResolvedValue(undefined),
  addTerminalMock: vi.fn().mockResolvedValue(undefined),
  getAgentSettingsMock: vi.fn().mockResolvedValue({ agents: {} }),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    getRecipes: getRecipesMock,
    addRecipe: addRecipeMock,
    updateRecipe: updateRecipeMock,
    deleteRecipe: deleteRecipeMock,
  },
  agentSettingsClient: {
    get: getAgentSettingsMock,
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
    expect(addRecipeMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes agent commands on update before persisting", async () => {
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

    expect(updateRecipeMock).toHaveBeenCalledTimes(1);
    const persistedUpdates = updateRecipeMock.mock.calls[0]?.[2];
    expect(persistedUpdates?.terminals?.[0]?.command).toBeUndefined();
    expect(persistedUpdates?.terminals?.[0]?.initialPrompt).toBe("merge open prs");
  });

  it("does not include terminals when persisting metadata-only updates", async () => {
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

    await useRecipeStore.getState().updateRecipe(recipeId!, { lastUsedAt: 123 });

    expect(updateRecipeMock).toHaveBeenCalledTimes(1);
    const persistedUpdates = updateRecipeMock.mock.calls[0]?.[2];
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
});
