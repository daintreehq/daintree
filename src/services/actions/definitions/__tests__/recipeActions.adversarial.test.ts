import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
import { resolveEffectiveActionDanger } from "../../effectiveDanger";

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

function definitionFor(id: string): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  registerRecipeActions(actions, {} as unknown as ActionCallbacks);
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  return factory() as AnyActionDefinition;
}

/**
 * Stands in for a mounted editor surface: the real listener calls back through
 * `detail.acknowledge` so the action can tell "the editor opened" from "nothing
 * was listening" (#11908). A spy that only recorded the event would leave every
 * editor-open test asserting against the unmounted path.
 */
const acknowledgeDispatchedEvent = (event: Event): boolean => {
  const { detail } = event as unknown as { detail?: { acknowledge?: () => void } };
  detail?.acknowledge?.();
  return true;
};

const dispatchSpy = vi.fn<(event: Event) => boolean>(acknowledgeDispatchedEvent);

beforeEach(() => {
  vi.clearAllMocks();
  dispatchSpy.mockReset().mockImplementation(acknowledgeDispatchedEvent);
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

  it("recipe.run returns the ids of the terminals it spawned, not just a count", async () => {
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

    // The ids are what makes the spawned panels actionable — an automated
    // caller polls them, and the MCP ownership ledger attributes them to the
    // session that ran the recipe (#11909). In spawn order.
    expect(result).toEqual({
      spawnedCount: 2,
      failedCount: 0,
      spawnedTerminalIds: ["t-0", "t-1"],
      failedTerminals: [],
    });
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
      // Only what actually started: a dropped terminal has no id to report,
      // and reporting one would attribute a panel that never existed.
      spawnedTerminalIds: ["t-0"],
      failedTerminals: [{ index: 1, reason: "Panel limit reached" }],
    });
    expect(notifySpawnFailuresMock).toHaveBeenCalledWith(results, {
      recipeName: "My recipe",
      projectId: "proj-1",
    });
  });

  it("recipe.run re-throws store rejections without notifying", async () => {
    const runRecipeWithResults = vi.fn().mockRejectedValue(new Error("recipe gone"));
    setRecipeState({ runRecipeWithResults });
    setWorktreeMap(new Map([["wt-1", { path: "/repo/wt" }]]));

    const run = setupActions();

    await expect(run("recipe.run", { recipeId: "r1", worktreeId: "wt-1" }, {})).rejects.toThrow(
      "recipe gone"
    );
    expect(notifySpawnFailuresMock).not.toHaveBeenCalled();
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
    setRecipeState({ recipes: [{ id: "r1", worktreeId: "wt-a", terminals: [] }] });

    const run = setupActions();
    await run("recipe.editor.open", { worktreeId: "wt-a", recipeId: "r1" });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      type: string;
      detail: { worktreeId: string; recipeId: string; acknowledge: () => void };
    };
    expect(event.type).toBe("daintree:open-recipe-editor");
    expect(event.detail.worktreeId).toBe("wt-a");
    expect(event.detail.recipeId).toBe("r1");
    expect(typeof event.detail.acknowledge).toBe("function");
  });

  // #11908 — these two are on the assistant's action tier, so their result is a
  // model-facing claim. The editor's own listener silently returns when it gets
  // no usable worktree, which is exactly the case a naive `opened: true` would
  // misreport.
  describe("recipe editor handoff results (#11908)", () => {
    it("reports a blank draft opened for the named worktree", async () => {
      setRecipeState({});

      const run = setupActions();
      const result = await run("recipe.editor.open", { worktreeId: "wt-a" });

      expect(result).toEqual({
        opened: true,
        mode: "blankDraft",
        worktreeId: "wt-a",
        recipeId: null,
        terminalCount: 0,
      });
    });

    it("reports loading an existing recipe, with its own worktree and pane count", async () => {
      setRecipeState({
        recipes: [
          { id: "r1", worktreeId: "wt-b", terminals: [{ type: "terminal" }, { type: "claude" }] },
        ],
      });

      const run = setupActions();
      const result = await run("recipe.editor.open", { worktreeId: "wt-a", recipeId: "r1" });

      expect(result).toEqual({
        opened: true,
        mode: "existingRecipe",
        worktreeId: "wt-b",
        recipeId: "r1",
        terminalCount: 2,
      });
    });

    it("falls back to the dispatch context's worktree when none is named", async () => {
      setRecipeState({});

      const run = setupActions();
      const result = await run("recipe.editor.open", {}, { activeWorktreeId: "wt-ctx" });

      expect(result).toMatchObject({ worktreeId: "wt-ctx" });
      const event = dispatchSpy.mock.calls[0]![0] as unknown as {
        detail: { worktreeId: string };
      };
      expect(event.detail.worktreeId).toBe("wt-ctx");
    });

    it("throws instead of claiming an editor opened that the listener would drop", async () => {
      setRecipeState({});

      const run = setupActions();

      await expect(run("recipe.editor.open", {})).rejects.toThrow(/No worktree/i);
      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it("reports the captured pane count from a live layout", async () => {
      setRecipeState({
        generateRecipeFromActiveTerminals: vi.fn(() => [{ type: "terminal" }, { type: "claude" }]),
      });

      const run = setupActions();
      const result = await run("recipe.editor.openFromLayout", { worktreeId: "wt-a" });

      expect(result).toEqual({
        opened: true,
        mode: "fromLayout",
        worktreeId: "wt-a",
        recipeId: null,
        terminalCount: 2,
      });
    });

    it("never reports a save — neither handoff writes a recipe", async () => {
      const saveToRepo = vi.fn().mockResolvedValue(undefined);
      const deleteRecipe = vi.fn().mockResolvedValue(undefined);
      setRecipeState({
        saveToRepo,
        deleteRecipe,
        generateRecipeFromActiveTerminals: vi.fn(() => [{ type: "terminal" }]),
      });

      const run = setupActions();
      const blank = await run("recipe.editor.open", { worktreeId: "wt-a" });
      const layout = await run("recipe.editor.openFromLayout", { worktreeId: "wt-a" });

      // The exact-shape assertions above already fail on any extra key, so the
      // load-bearing half here is that neither handoff touched a persistence
      // collaborator — the write path has no MCP surface at all.
      expect(blank).toBeTruthy();
      expect(layout).toBeTruthy();
      expect(saveToRepo).not.toHaveBeenCalled();
      expect(deleteRecipe).not.toHaveBeenCalled();
    });
  });

  describe("recipe editor argument schema (#11908)", () => {
    it("bounds and shape-checks the prefilled pane list it now advertises", () => {
      const def = definitionFor("recipe.editor.open");
      const parse = (initialTerminals: unknown) =>
        def.argsSchema?.safeParse({ worktreeId: "wt-a", initialTerminals }).success;

      // The one field the editor actually reads has to be there — the listener
      // casts straight to RecipeTerminal[], so a bare string would be rendered
      // as a pane.
      expect(parse([{ type: "claude", title: "Reviewer", anythingElse: 1 }])).toBe(true);
      expect(parse(["claude"])).toBe(false);
      expect(parse([{ title: "no type" }])).toBe(false);
      // Longer than any recipe can hold, so nothing legitimate is turned away.
      expect(parse(Array.from({ length: 11 }, () => ({ type: "terminal" })))).toBe(false);
    });

    it("rejects a blank selector rather than treating it as absent", () => {
      const def = definitionFor("recipe.editor.open");

      expect(def.argsSchema?.safeParse({ worktreeId: "" }).success).toBe(false);
      expect(def.argsSchema?.safeParse({ worktreeId: "wt-a", recipeId: "" }).success).toBe(false);
    });

    it("advertises only the two selectors, not a hand-authored terminal list", () => {
      // `initialTerminals` was dropped when these went on the tool surface: it
      // had no caller, and typing it meant 1.8 KB of nested schema on a tool
      // that opens a window. Capturing real panes is openFromLayout's job.
      const def = definitionFor("recipe.editor.open");
      const json = def.argsSchema
        ? (z.toJSONSchema(def.argsSchema, { io: "input" }) as {
            properties?: Record<string, unknown>;
          })
        : undefined;

      expect(Object.keys(json?.properties ?? {}).sort()).toEqual([
        "initialTerminals",
        "recipeId",
        "worktreeId",
      ]);
    });

    it("still elevates an agent dispatch carrying a recipe id to confirm", () => {
      // `resolveEffectiveActionDanger` keys the elevation on the ARGUMENT, not
      // an action allowlist (#11860). Tier-exposing this action makes that
      // elevation reachable for the first time, so pin it: opening the editor on
      // an existing recipe is a confirm-gated agent call, while a blank draft is
      // not, and a human pick is never elevated.
      const def = definitionFor("recipe.editor.open");

      expect(
        resolveEffectiveActionDanger("recipe.editor.open", def.danger, "agent", { recipeId: "r1" })
      ).toBe("confirm");
      expect(
        resolveEffectiveActionDanger("recipe.editor.open", def.danger, "agent", {
          worktreeId: "wt-a",
        })
      ).toBe("safe");
      expect(
        resolveEffectiveActionDanger("recipe.editor.open", def.danger, "user", { recipeId: "r1" })
      ).toBe("safe");
    });

    it("refuses to claim an editor opened when nothing is listening", async () => {
      // The handoff travels as a DOM event, which reports nothing back to its
      // dispatcher — so without the acknowledgement the action would return
      // `opened: true` into a void.
      dispatchSpy.mockImplementation(() => true);
      setRecipeState({});
      const run = setupActions();

      await expect(run("recipe.editor.open", { worktreeId: "wt-a" })).rejects.toThrow(
        /didn't open/i
      );
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    });

    it("returns results the declared schema actually accepts", async () => {
      // `dispatch` parses run()'s return through `resultSchema` and strips
      // unknown keys (#11539), so a shape that drifts from the schema loses
      // fields silently rather than failing loudly here.
      setRecipeState({
        recipes: [{ id: "r1", worktreeId: "wt-b", terminals: [{ type: "terminal" }] }],
        generateRecipeFromActiveTerminals: vi.fn(() => [{ type: "terminal" }]),
      });
      const run = setupActions();

      const results = [
        await run("recipe.editor.open", { worktreeId: "wt-a" }),
        await run("recipe.editor.open", { worktreeId: "wt-a", recipeId: "r1" }),
        await run("recipe.editor.openFromLayout", { worktreeId: "wt-a" }),
      ];
      const schema = definitionFor("recipe.editor.open").resultSchema;

      for (const result of results) {
        expect(schema?.safeParse(result).success).toBe(true);
      }
    });

    it("advertises a structured result over MCP for both handoffs", () => {
      for (const id of ["recipe.editor.open", "recipe.editor.openFromLayout"]) {
        const def = definitionFor(id);
        expect(def.mcpOutputSchema).toBe(true);
        // A non-object top level emits no outputSchema, so structuredContent
        // would silently never populate (#11547).
        const json = def.resultSchema
          ? z.toJSONSchema(def.resultSchema, { io: "output" })
          : undefined;
        expect(json?.["type"]).toBe("object");
      }
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
