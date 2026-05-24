// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { TerminalRecipe, RunCommand } from "@/types";
import type { RecipeSpawnResults } from "@/store/recipeStore";

const recipes: TerminalRecipe[] = [];
const runRecipeWithResultsMock =
  vi.fn<
    (
      recipeId: string,
      worktreePath: string,
      worktreeId?: string,
      context?: unknown,
      options?: { spawnedBy?: string; terminalIndices?: number[] }
    ) => Promise<RecipeSpawnResults>
  >();

const recipeStoreState = {
  recipes,
  runRecipeWithResults: (
    recipeId: string,
    worktreePath: string,
    worktreeId?: string,
    context?: unknown,
    options?: { spawnedBy?: string; terminalIndices?: number[] }
  ) => runRecipeWithResultsMock(recipeId, worktreePath, worktreeId, context, options),
  updateRecipe: vi.fn(),
  deleteRecipe: vi.fn(),
  createRecipe: vi.fn(),
  getRecipeById: (id: string) => recipes.find((r) => r.id === id),
};

type RecipeStoreSelector<T> = (state: typeof recipeStoreState) => T;

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: <T,>(selector: RecipeStoreSelector<T>) => selector(recipeStoreState),
}));

const fakeWorktreeStore = {
  getState: () => ({
    worktrees: new Map([
      [
        "wt-1",
        {
          worktreeId: "wt-1",
          issueNumber: 42,
          prNumber: undefined,
          branch: "feature/test",
        } as { worktreeId: string; issueNumber?: number; prNumber?: number; branch?: string },
      ],
    ]),
  }),
};

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => fakeWorktreeStore,
}));

const projectSettingsState: { allDetectedRunners: RunCommand[] } = { allDetectedRunners: [] };

vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: <T,>(selector: (state: typeof projectSettingsState) => T) =>
    selector(projectSettingsState),
}));

const addPanelMock = vi.fn<(options: unknown) => Promise<string | null>>();
const panelStoreState = {
  addPanel: (options: unknown) => addPanelMock(options),
};
vi.mock("@/store/panelStore", () => ({
  usePanelStore: <T,>(selector: (state: typeof panelStoreState) => T) => selector(panelStoreState),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => {
    if (id === "claude-code") return { id, name: "Claude Code" };
    if (id === "codex") return { id, name: "Codex Agent" };
    return undefined;
  },
}));

const logErrorMock = vi.fn();
vi.mock("@/utils/logger", () => ({
  logError: (...args: unknown[]) => logErrorMock(...args),
  logDebug: vi.fn(),
}));

import { useRecipeRunner } from "../useRecipeRunner";

function makeRecipe(
  overrides: Partial<TerminalRecipe> & { id: string; name: string }
): TerminalRecipe {
  return {
    terminals: [{ type: "terminal", env: {} }],
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  recipes.length = 0;
  projectSettingsState.allDetectedRunners = [];
  runRecipeWithResultsMock.mockReset();
  addPanelMock.mockReset();
  addPanelMock.mockResolvedValue("panel-1");
  logErrorMock.mockReset();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useRecipeRunner — spawn failure capture", () => {
  it("does not surface a banner when all terminals spawn successfully", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Test recipe",
        terminals: [
          { type: "terminal", env: {} },
          { type: "terminal", env: {} },
        ],
      })
    );
    runRecipeWithResultsMock.mockResolvedValue({
      spawned: [
        { index: 0, terminalId: "t-1" },
        { index: 1, terminalId: "t-2" },
      ],
      failed: [],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    await flush();

    expect(result.current.spawnFailureSummary).toBeNull();
  });

  it("captures failed terminals and exposes a summary with display names", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Multi-agent",
        terminals: [
          { type: "terminal", env: {}, title: "Tests" },
          { type: "claude-code", env: {} },
          { type: "codex", env: {} },
          { type: "terminal", env: {} },
        ],
      })
    );
    runRecipeWithResultsMock.mockResolvedValue({
      spawned: [
        { index: 0, terminalId: "t-0" },
        { index: 1, terminalId: "t-1" },
        { index: 3, terminalId: "t-3" },
      ],
      failed: [{ index: 2, error: "Panel limit reached" }],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    await flush();

    expect(result.current.spawnFailureSummary).not.toBeNull();
    expect(result.current.spawnFailureSummary).toMatchObject({
      recipeName: "Multi-agent",
      totalCount: 4,
    });
    expect(result.current.spawnFailureSummary?.failures).toHaveLength(1);
    expect(result.current.spawnFailureSummary?.failures[0]).toMatchObject({
      index: 2,
      error: "Panel limit reached",
      displayName: "Codex Agent",
    });
  });

  it("falls back to 'Terminal N' when title and agent name are unavailable", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Plain",
        terminals: [
          { type: "terminal", env: {} },
          { type: "terminal", env: {} },
        ],
      })
    );
    runRecipeWithResultsMock.mockResolvedValue({
      spawned: [],
      failed: [
        { index: 0, error: "Panel limit reached" },
        { index: 1, error: "Panel limit reached" },
      ],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    await flush();

    expect(result.current.spawnFailureSummary?.failures.map((f) => f.displayName)).toEqual([
      "Terminal 1",
      "Terminal 2",
    ]);
  });
});

describe("useRecipeRunner — retry failed terminals", () => {
  it("calls runRecipeWithResults with only the failed indices and clears banner on success", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Mixed",
        terminals: [
          { type: "terminal", env: {} },
          { type: "claude-code", env: {} },
          { type: "codex", env: {} },
        ],
      })
    );

    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [
        { index: 0, terminalId: "t-0" },
        { index: 2, terminalId: "t-2" },
      ],
      failed: [{ index: 1, error: "Panel limit reached" }],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    await flush();
    expect(result.current.spawnFailureSummary).not.toBeNull();

    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [{ index: 1, terminalId: "t-1" }],
      failed: [],
    });

    act(() => {
      result.current.handleRetryFailed();
    });
    await flush();

    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(2);
    expect(runRecipeWithResultsMock.mock.calls[1]?.[4]).toMatchObject({
      terminalIndices: [1],
    });
    expect(result.current.spawnFailureSummary).toBeNull();
  });

  it("preserves the original total count when a retry partially fails", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Mixed",
        terminals: [
          { type: "terminal", env: {} },
          { type: "claude-code", env: {} },
          { type: "codex", env: {} },
        ],
      })
    );

    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [
        { index: 1, error: "Panel limit reached" },
        { index: 2, error: "Panel limit reached" },
      ],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    await flush();
    expect(result.current.spawnFailureSummary?.totalCount).toBe(3);

    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [{ index: 1, terminalId: "t-1" }],
      failed: [{ index: 2, error: "Panel limit reached" }],
    });

    act(() => {
      result.current.handleRetryFailed();
    });
    await flush();

    expect(result.current.spawnFailureSummary?.totalCount).toBe(3);
    expect(result.current.spawnFailureSummary?.failures).toHaveLength(1);
    expect(result.current.spawnFailureSummary?.failures[0]?.index).toBe(2);
  });

  it("ignores retry when there are no failures and no last run", async () => {
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRetryFailed();
    });
    await flush();

    expect(runRecipeWithResultsMock).not.toHaveBeenCalled();
  });
});

describe("useRecipeRunner — pre-flight unresolved variables", () => {
  it("flags missing context for known variables in initialPrompt before spawning", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Issue",
        terminals: [
          {
            type: "claude-code",
            env: {},
            initialPrompt:
              "review issue {{issue_number}} on branch {{branch_name}} for pr {{pr_number}}",
          },
        ],
      })
    );
    runRecipeWithResultsMock.mockResolvedValue({ spawned: [], failed: [] });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    // Only pr_number is missing — issue_number=42 and branch_name="feature/test" are populated.
    act(() => {
      result.current.handleRun("r1");
    });
    await flush();

    expect(result.current.unresolvedVars).toEqual(["pr_number"]);
  });

  it("does not flag {{vars}} in plain-terminal command (the store does not substitute it)", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Plain",
        terminals: [{ type: "terminal", env: {}, command: "echo {{pr_number}}" }],
      })
    );
    runRecipeWithResultsMock.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    await flush();

    expect(result.current.unresolvedVars).toEqual([]);
  });

  it("dismisses each banner independently", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Bad",
        terminals: [
          { type: "claude-code", env: {}, initialPrompt: "echo {{pr_number}}" },
          { type: "terminal", env: {} },
        ],
      })
    );
    runRecipeWithResultsMock.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [{ index: 1, error: "Panel limit reached" }],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    await flush();

    expect(result.current.unresolvedVars).toEqual(["pr_number"]);
    expect(result.current.spawnFailureSummary).not.toBeNull();

    act(() => {
      result.current.dismissUnresolvedVars();
    });
    expect(result.current.unresolvedVars).toEqual([]);
    expect(result.current.spawnFailureSummary).not.toBeNull();

    act(() => {
      result.current.dismissSpawnFailures();
    });
    expect(result.current.spawnFailureSummary).toBeNull();
  });
});

describe("useRecipeRunner — reentrancy guard", () => {
  it("ignores a second handleRun while the first is in flight", async () => {
    recipes.push(
      makeRecipe({ id: "r1", name: "Slow", terminals: [{ type: "terminal", env: {} }] })
    );
    let resolve: (results: RecipeSpawnResults) => void = () => {};
    runRecipeWithResultsMock.mockReturnValue(
      new Promise<RecipeSpawnResults>((r) => {
        resolve = r;
      })
    );

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
      result.current.handleRun("r1");
    });

    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ spawned: [{ index: 0, terminalId: "t-0" }], failed: [] });
      await Promise.resolve();
    });
  });
});

describe("useRecipeRunner — async lifecycle", () => {
  it("drops the failure summary when the active worktree changes mid-run", async () => {
    recipes.push(
      makeRecipe({ id: "r1", name: "Slow", terminals: [{ type: "terminal", env: {} }] })
    );
    let resolve: (results: RecipeSpawnResults) => void = () => {};
    runRecipeWithResultsMock.mockReturnValue(
      new Promise<RecipeSpawnResults>((r) => {
        resolve = r;
      })
    );

    const { result, rerender } = renderHook(
      ({ activeWorktreeId }: { activeWorktreeId: string | null }) =>
        useRecipeRunner({ activeWorktreeId, defaultCwd: "/tmp" }),
      { initialProps: { activeWorktreeId: "wt-1" } }
    );

    act(() => {
      result.current.handleRun("r1");
    });

    // Switch worktrees while the run is still in flight.
    rerender({ activeWorktreeId: "wt-2" });

    await act(async () => {
      resolve({
        spawned: [],
        failed: [{ index: 0, error: "Panel limit reached" }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.spawnFailureSummary).toBeNull();
  });

  it("clears a stale failure banner when a new run begins", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "First",
        terminals: [{ type: "terminal", env: {} }],
      })
    );
    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [],
      failed: [{ index: 0, error: "Panel limit reached" }],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    await flush();
    expect(result.current.spawnFailureSummary).not.toBeNull();

    let resolve: (results: RecipeSpawnResults) => void = () => {};
    runRecipeWithResultsMock.mockReturnValueOnce(
      new Promise<RecipeSpawnResults>((r) => {
        resolve = r;
      })
    );

    act(() => {
      result.current.handleRun("r1");
    });

    // The new run is in flight: stale banner must be gone immediately.
    expect(result.current.spawnFailureSummary).toBeNull();

    await act(async () => {
      resolve({ spawned: [{ index: 0, terminalId: "t-0" }], failed: [] });
      await Promise.resolve();
    });
  });

  it("swallows a thrown rejection from the store and releases the run guard", async () => {
    recipes.push(
      makeRecipe({ id: "r1", name: "Throws", terminals: [{ type: "terminal", env: {} }] })
    );
    runRecipeWithResultsMock.mockRejectedValueOnce(new Error("Recipe r1 not found"));

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    await flush();

    expect(result.current.spawnFailureSummary).toBeNull();

    // Subsequent run should proceed (guard is released in finally).
    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [],
    });
    act(() => {
      result.current.handleRun("r1");
    });
    await flush();
    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(2);
  });
});

function makeRunCommand(overrides: Partial<RunCommand> & { id: string; name: string }): RunCommand {
  return {
    command: `npm run ${overrides.name}`,
    ...overrides,
  };
}

describe("useRecipeRunner — suggestions", () => {
  it("caps suggestions to two even when several keyword-matching runners are detected", () => {
    projectSettingsState.allDetectedRunners = [
      makeRunCommand({ id: "1", name: "dev" }),
      makeRunCommand({ id: "2", name: "start" }),
      makeRunCommand({ id: "3", name: "serve" }),
      makeRunCommand({ id: "4", name: "test" }),
      makeRunCommand({ id: "5", name: "build" }),
    ];

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    expect(result.current.suggestions).toHaveLength(2);
    expect(result.current.suggestions.map((s) => s.id)).toEqual(["1", "2"]);
  });

  it("filters out runners that do not match any keyword", () => {
    projectSettingsState.allDetectedRunners = [
      makeRunCommand({ id: "1", name: "lint", command: "eslint ." }),
      makeRunCommand({ id: "2", name: "dev", command: "vite" }),
      makeRunCommand({ id: "3", name: "format", command: "prettier ." }),
    ];

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    expect(result.current.suggestions.map((s) => s.id)).toEqual(["2"]);
  });

  it("returns an empty array when no detected runners match", () => {
    projectSettingsState.allDetectedRunners = [
      makeRunCommand({ id: "1", name: "lint", command: "eslint ." }),
    ];

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    expect(result.current.suggestions).toEqual([]);
  });
});

describe("useRecipeRunner — handleRunSuggestion", () => {
  it("spawns a terminal via addPanel with the suggestion command", async () => {
    const suggestion = makeRunCommand({ id: "s-dev", name: "dev", command: "npm run dev" });
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/repo" })
    );

    act(() => {
      result.current.handleRunSuggestion(suggestion);
    });
    await flush();

    expect(addPanelMock).toHaveBeenCalledTimes(1);
    expect(addPanelMock).toHaveBeenCalledWith({
      kind: "terminal",
      title: "dev",
      cwd: "/repo",
      command: "npm run dev",
      location: "grid",
      worktreeId: "wt-1",
      spawnedBy: "quickrun",
    });
  });

  it("does nothing when defaultCwd is missing", () => {
    const suggestion = makeRunCommand({ id: "s-dev", name: "dev" });
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: undefined })
    );

    act(() => {
      result.current.handleRunSuggestion(suggestion);
    });

    expect(addPanelMock).not.toHaveBeenCalled();
  });

  it("guards against double-click reentrancy while the spawn is in flight", async () => {
    const suggestion = makeRunCommand({ id: "s-dev", name: "dev" });
    let resolve: (id: string) => void = () => {};
    addPanelMock.mockReturnValueOnce(
      new Promise<string>((r) => {
        resolve = r;
      })
    );

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/repo" })
    );

    act(() => {
      result.current.handleRunSuggestion(suggestion);
      result.current.handleRunSuggestion(suggestion);
    });

    expect(addPanelMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve("panel-1");
      await Promise.resolve();
    });

    // Guard cleared — a fresh click should fire again.
    act(() => {
      result.current.handleRunSuggestion(suggestion);
    });
    await flush();
    expect(addPanelMock).toHaveBeenCalledTimes(2);
  });

  it("releases the guard when addPanel rejects", async () => {
    const suggestion = makeRunCommand({ id: "s-dev", name: "dev" });
    addPanelMock.mockRejectedValueOnce(new Error("Panel limit reached"));

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/repo" })
    );

    act(() => {
      result.current.handleRunSuggestion(suggestion);
    });
    await flush();

    addPanelMock.mockResolvedValueOnce("panel-2");
    act(() => {
      result.current.handleRunSuggestion(suggestion);
    });
    await flush();

    expect(addPanelMock).toHaveBeenCalledTimes(2);
    expect(logErrorMock).toHaveBeenCalledWith("Suggestion run failed", expect.any(Error));
  });
});
