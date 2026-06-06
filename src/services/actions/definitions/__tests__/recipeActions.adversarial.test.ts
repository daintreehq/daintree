import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const recipeStoreMock = vi.hoisted(() => ({
  getState: vi.fn(),
}));

const createWorktreeStoreMock = vi.hoisted(() => ({
  getCurrentViewStore: vi.fn(),
}));

const notifySpawnFailuresMock = vi.hoisted(() => vi.fn());

vi.mock("@/store/recipeStore", () => ({ useRecipeStore: recipeStoreMock }));
vi.mock("@/store/createWorktreeStore", () => createWorktreeStoreMock);
vi.mock("@/utils/recipeNotify", () => ({
  notifyRecipeSpawnFailures: notifySpawnFailuresMock,
}));

import { registerRecipeActions } from "../recipeActions";

type Worktree = {
  path: string;
  branch?: string;
  issueNumber?: number;
  prNumber?: number;
};

function setupActions(): (
  id: string,
  args?: unknown,
  ctx?: Record<string, unknown>
) => Promise<unknown> {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerRecipeActions(actions, callbacks);
  return async (id, args, ctx) => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, (ctx ?? {}) as never);
  };
}

const dispatchSpy = vi.fn<(event: Event) => boolean>(() => true);

beforeEach(() => {
  vi.clearAllMocks();
  dispatchSpy.mockReset().mockReturnValue(true);
  Object.defineProperty(globalThis, "window", {
    value: { dispatchEvent: dispatchSpy },
    configurable: true,
    writable: true,
  });
  if (!("CustomEvent" in globalThis)) {
    class CustomEventPolyfill<T> {
      public type: string;
      public detail: T;
      constructor(type: string, init?: { detail: T }) {
        this.type = type;
        this.detail = init?.detail as T;
      }
    }
    (globalThis as unknown as { CustomEvent: unknown }).CustomEvent = CustomEventPolyfill;
  }
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
});

const OK_SPAWN_RESULTS = { spawned: [{ index: 0, terminalId: "term-1" }], failed: [] };

function setRecipeState(state: {
  recipes?: Array<{
    id: string;
    name?: string;
    worktreeId?: string;
    terminals?: unknown[];
    showInEmptyState?: boolean;
  }>;
  isLoading?: boolean;
  currentProjectId?: string | null;
  runRecipeWithResults?: ReturnType<typeof vi.fn>;
  saveToRepo?: ReturnType<typeof vi.fn>;
  deleteRecipe?: ReturnType<typeof vi.fn>;
  generateRecipeFromActiveTerminals?: (id: string) => unknown[];
}) {
  recipeStoreMock.getState.mockReturnValue({
    recipes: state.recipes ?? [],
    isLoading: state.isLoading ?? false,
    currentProjectId: "currentProjectId" in state ? state.currentProjectId : "proj-1",
    getRecipeById: vi.fn((id: string) => (state.recipes ?? []).find((r) => r.id === id)),
    runRecipeWithResults: state.runRecipeWithResults ?? vi.fn().mockResolvedValue(OK_SPAWN_RESULTS),
    saveToRepo: state.saveToRepo ?? vi.fn().mockResolvedValue(undefined),
    deleteRecipe: state.deleteRecipe ?? vi.fn().mockResolvedValue(undefined),
    generateRecipeFromActiveTerminals: state.generateRecipeFromActiveTerminals ?? vi.fn(() => []),
  });
}

function setWorktreeMap(map: Map<string, Worktree>) {
  createWorktreeStoreMock.getCurrentViewStore.mockReturnValue({
    getState: () => ({ worktrees: map }),
  });
}

describe("recipeActions adversarial", () => {
  it("recipe.run prefers explicit worktreeId over ctx.activeWorktreeId", async () => {
    const runRecipeWithResults = vi.fn().mockResolvedValue(OK_SPAWN_RESULTS);
    setRecipeState({ runRecipeWithResults });
    setWorktreeMap(
      new Map([
        ["wt-arg", { path: "/repo/arg", branch: "feat/a", issueNumber: 1 }],
        ["wt-ctx", { path: "/repo/ctx", branch: "feat/c", issueNumber: 2 }],
      ])
    );

    const run = setupActions();
    await run(
      "recipe.run",
      { recipeId: "r1", worktreeId: "wt-arg" },
      { activeWorktreeId: "wt-ctx", projectPath: "/repo" }
    );

    expect(runRecipeWithResults).toHaveBeenCalledWith(
      "r1",
      "/repo/arg",
      "wt-arg",
      {
        issueNumber: 1,
        prNumber: undefined,
        worktreePath: "/repo/arg",
        branchName: "feat/a",
      },
      { spawnedBy: undefined, focusPolicy: undefined, dispatchSource: undefined }
    );
  });

  it("recipe.run threads ctx.dispatchSource into the run options", async () => {
    const runRecipeWithResults = vi.fn().mockResolvedValue(OK_SPAWN_RESULTS);
    setRecipeState({ runRecipeWithResults });
    setWorktreeMap(new Map([["wt-1", { path: "/repo/wt", branch: "feat/x" }]]));

    const run = setupActions();
    await run(
      "recipe.run",
      { recipeId: "r1", worktreeId: "wt-1" },
      { dispatchSource: "agent", projectPath: "/repo" }
    );

    expect(runRecipeWithResults).toHaveBeenCalledWith(
      "r1",
      "/repo/wt",
      "wt-1",
      expect.any(Object),
      expect.objectContaining({ dispatchSource: "agent" })
    );
  });

  it("recipe.run falls back to ctx.projectPath when the target worktree is missing from the view store", async () => {
    const runRecipeWithResults = vi.fn().mockResolvedValue(OK_SPAWN_RESULTS);
    setRecipeState({ runRecipeWithResults });
    setWorktreeMap(new Map());

    const run = setupActions();
    await run(
      "recipe.run",
      { recipeId: "r1" },
      { activeWorktreeId: "wt-missing", projectPath: "/repo/main" }
    );

    expect(runRecipeWithResults).toHaveBeenCalledWith(
      "r1",
      "/repo/main",
      "wt-missing",
      {
        issueNumber: undefined,
        prNumber: undefined,
        worktreePath: "/repo/main",
        branchName: undefined,
      },
      { spawnedBy: undefined, focusPolicy: undefined, dispatchSource: undefined }
    );
  });

  it("recipe.run throws when no path source exists", async () => {
    const runRecipeWithResults = vi.fn().mockResolvedValue(OK_SPAWN_RESULTS);
    setRecipeState({ runRecipeWithResults });
    setWorktreeMap(new Map());

    const run = setupActions();

    await expect(run("recipe.run", { recipeId: "r1" }, {})).rejects.toThrow(
      /No worktree or project path/
    );
    expect(runRecipeWithResults).not.toHaveBeenCalled();
  });

  it("recipe.run returns structured spawn counts on full success", async () => {
    const runRecipeWithResults = vi.fn().mockResolvedValue({
      spawned: [
        { index: 0, terminalId: "t-0" },
        { index: 1, terminalId: "t-1" },
      ],
      failed: [],
    });
    setRecipeState({ runRecipeWithResults });
    setWorktreeMap(new Map([["wt-1", { path: "/repo/wt" }]]));

    const run = setupActions();
    const result = await run("recipe.run", { recipeId: "r1", worktreeId: "wt-1" }, {});

    expect(result).toEqual({ spawnedCount: 2, failedCount: 0, failedTerminals: [] });
  });

  it("recipe.run resolves with failure details on partial spawn and notifies", async () => {
    const results = {
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [{ index: 1, error: "Panel limit reached" }],
    };
    const runRecipeWithResults = vi.fn().mockResolvedValue(results);
    setRecipeState({
      recipes: [{ id: "r1", name: "My recipe", terminals: [] }],
      runRecipeWithResults,
    });
    setWorktreeMap(new Map([["wt-1", { path: "/repo/wt" }]]));

    const run = setupActions();
    const result = await run(
      "recipe.run",
      { recipeId: "r1", worktreeId: "wt-1" },
      { projectId: "proj-1" }
    );

    expect(result).toEqual({
      spawnedCount: 1,
      failedCount: 1,
      failedTerminals: [{ index: 1, reason: "Panel limit reached" }],
    });
    expect(notifySpawnFailuresMock).toHaveBeenCalledWith(results, {
      recipeName: "My recipe",
      projectId: "proj-1",
      worktreeId: "wt-1",
    });
  });

  it("recipe.run throws when no terminals spawned but still notifies first", async () => {
    const results = {
      spawned: [],
      failed: [
        { index: 0, error: "Panel limit reached" },
        { index: 1, error: "Panel limit reached" },
      ],
    };
    setRecipeState({ runRecipeWithResults: vi.fn().mockResolvedValue(results) });
    setWorktreeMap(new Map([["wt-1", { path: "/repo/wt" }]]));

    const run = setupActions();

    await expect(run("recipe.run", { recipeId: "r1", worktreeId: "wt-1" }, {})).rejects.toThrow(
      /Recipe launch failed: Panel limit reached/
    );
    expect(notifySpawnFailuresMock).toHaveBeenCalledWith(results, expect.any(Object));
  });

  it("recipe.list with worktreeId includes global recipes (no worktreeId) and worktree-scoped recipes", async () => {
    setRecipeState({
      isLoading: true,
      recipes: [
        { id: "g", name: "global", terminals: [] },
        { id: "a", name: "a", worktreeId: "wt-a", terminals: [{}] },
        { id: "b", name: "b", worktreeId: "wt-b", terminals: [] },
      ],
    });

    const run = setupActions();
    const result = (await run("recipe.list", { worktreeId: "wt-a" })) as {
      recipes: Array<{ id: string; terminalCount: number }>;
      isLoading: boolean;
    };

    expect(result.recipes.map((r) => r.id)).toEqual(["g", "a"]);
    expect(result.recipes.find((r) => r.id === "a")?.terminalCount).toBe(1);
    expect(result.isLoading).toBe(true);
  });

  it("recipe.list without worktreeId returns all recipes unchanged", async () => {
    setRecipeState({
      recipes: [
        { id: "g", terminals: [] },
        { id: "a", worktreeId: "wt-a", terminals: [] },
      ],
    });

    const run = setupActions();
    const result = (await run("recipe.list")) as {
      recipes: Array<{ id: string; worktreeId: string | null }>;
    };

    expect(result.recipes).toHaveLength(2);
    expect(result.recipes.find((r) => r.id === "g")?.worktreeId).toBeNull();
  });

  it("recipe.saveToRepo rejects when no project is open, before mutating", async () => {
    const saveToRepo = vi.fn().mockResolvedValue(undefined);
    setRecipeState({ currentProjectId: null, saveToRepo });

    const run = setupActions();

    await expect(
      run("recipe.saveToRepo", { recipeId: "r1", deleteOriginal: false })
    ).rejects.toThrow("No project open");
    expect(saveToRepo).not.toHaveBeenCalled();
  });

  it("recipe.saveToRepo forwards deleteOriginal flag exactly", async () => {
    const saveToRepo = vi.fn().mockResolvedValue(undefined);
    setRecipeState({ saveToRepo });

    const run = setupActions();
    await run("recipe.saveToRepo", { recipeId: "r1", deleteOriginal: true });

    expect(saveToRepo).toHaveBeenCalledWith("r1", true);
  });

  it("recipe.delete forwards the recipeId to the store exactly once", async () => {
    const deleteRecipe = vi.fn().mockResolvedValue(undefined);
    setRecipeState({ deleteRecipe });

    const run = setupActions();
    await run("recipe.delete", { recipeId: "r1" });

    expect(deleteRecipe).toHaveBeenCalledTimes(1);
    expect(deleteRecipe).toHaveBeenCalledWith("r1");
  });

  it("recipe.delete propagates store rejection to the caller", async () => {
    const deleteRecipe = vi.fn().mockRejectedValue(new Error("delete failed"));
    setRecipeState({ deleteRecipe });

    const run = setupActions();

    await expect(run("recipe.delete", { recipeId: "r1" })).rejects.toThrow("delete failed");
  });

  it("recipe.editor.openFromLayout dispatches terminals from the live layout", async () => {
    const terminals = [{ title: "t1" }, { title: "t2" }];
    setRecipeState({
      generateRecipeFromActiveTerminals: vi.fn(() => terminals),
    });

    const run = setupActions();
    await run("recipe.editor.openFromLayout", { worktreeId: "wt-a" });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      type: string;
      detail: { worktreeId: string; initialTerminals: unknown[] };
    };
    expect(event.type).toBe("daintree:open-recipe-editor");
    expect(event.detail.worktreeId).toBe("wt-a");
    expect(event.detail.initialTerminals).toEqual(terminals);
  });

  it("recipe.editor.openFromLayout rejects empty layouts without dispatching", async () => {
    setRecipeState({ generateRecipeFromActiveTerminals: vi.fn(() => []) });

    const run = setupActions();

    await expect(run("recipe.editor.openFromLayout", { worktreeId: "wt-a" })).rejects.toThrow(
      /No active terminals/
    );
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("recipe.editor.open dispatches with exact detail payload", async () => {
    setRecipeState({});

    const run = setupActions();
    await run("recipe.editor.open", {
      worktreeId: "wt-a",
      recipeId: "r1",
      initialTerminals: [{ title: "x" }],
    });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      type: string;
      detail: { worktreeId: string; recipeId: string; initialTerminals: unknown };
    };
    expect(event.type).toBe("daintree:open-recipe-editor");
    expect(event.detail).toEqual({
      worktreeId: "wt-a",
      recipeId: "r1",
      initialTerminals: [{ title: "x" }],
    });
  });

  it("recipe.manager.open dispatches the manager event with no detail", async () => {
    setRecipeState({});

    const run = setupActions();
    await run("recipe.manager.open");

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      type: string;
      detail?: unknown;
    };
    expect(event.type).toBe("daintree:open-recipe-manager");
    expect(event.detail).toBeFalsy();
  });
});
