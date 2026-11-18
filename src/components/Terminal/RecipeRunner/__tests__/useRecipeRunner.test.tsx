// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import type { TerminalRecipe, RunCommand } from "@/types";
import type { RecipeSpawnResults } from "@/store/recipeStore";
import { PANEL_LIMIT_DECLINED_REASON } from "@/services/actions/definitions/panelLimitError";

const recipes: TerminalRecipe[] = [];
const duplicateRecipeMock = vi.fn<(id: string) => Promise<void>>();
const updateRecipeMock =
  vi.fn<(id: string, updates: { showInEmptyState?: boolean }) => Promise<void>>();
interface NotifyPayload {
  type: string;
  title: string;
  message: string;
  priority?: string;
  action?: { label: string; onClick: () => void };
}
const notifyMock = vi.fn<(payload: NotifyPayload) => void>();
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
  updateRecipe: (id: string, updates: { showInEmptyState?: boolean }) =>
    updateRecipeMock(id, updates),
  deleteRecipe: vi.fn(),
  duplicateRecipe: (id: string) => duplicateRecipeMock(id),
  // Follows a shadowed row to the team recipe that overrides it, as the store does.
  getRecipeById: (id: string) => {
    const list = recipeStoreState.recipes;
    const row = list.find((r) => r.id === id);
    if (!row?.shadowedBy) return row;
    return list.find((r) => r.name === row.name && r.scope === "inrepo") ?? row;
  },
};

type RecipeStoreSelector<T> = (state: typeof recipeStoreState) => T;

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: <T,>(selector: RecipeStoreSelector<T>) => selector(recipeStoreState),
}));

// The PR a worktree is linked to, read the way `buildContext` reads it.
let linkedPrNumber: number | undefined;
const fakeWorktreeStore = {
  getState: () => ({
    worktrees: new Map([
      [
        "wt-1",
        {
          worktreeId: "wt-1",
          issueNumber: 42,
          branch: "feature/test",
          linked:
            linkedPrNumber === undefined ? undefined : { pr: { ref: { number: linkedPrNumber } } },
        },
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

vi.mock("@/lib/notify", () => ({ notify: (payload: NotifyPayload) => notifyMock(payload) }));

const logErrorMock = vi.fn();
vi.mock("@/utils/logger", () => ({
  logError: (...args: unknown[]) => logErrorMock(...args),
  logDebug: vi.fn(),
}));

import { useRecipeRunner } from "../useRecipeRunner";
import { actionService } from "@/services/ActionService";
import {
  cancelRecipeRunConfirmations,
  resolveRecipeRunConfirmation,
  useRecipeRunConfirmStore,
} from "@/store/recipeRunConfirmStore";
import { RecipeChangedSinceShownError, recipeApprovalDigest } from "@/utils/recipeApprovalDigest";

const dispatchMock = vi.mocked(actionService.dispatch);

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
  linkedPrNumber = undefined;
  recipes.length = 0;
  recipeStoreState.recipes = recipes;
  projectSettingsState.allDetectedRunners = [];
  runRecipeWithResultsMock.mockReset();
  addPanelMock.mockReset();
  addPanelMock.mockResolvedValue("panel-1");
  logErrorMock.mockReset();
  duplicateRecipeMock.mockReset().mockResolvedValue(undefined);
  updateRecipeMock.mockReset().mockResolvedValue(undefined);
  notifyMock.mockReset();
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
  cancelRecipeRunConfirmations();
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

describe("useRecipeRunner — panel limit decline", () => {
  const threeTerminals = () =>
    makeRecipe({
      id: "r1",
      name: "Mixed",
      terminals: [
        { type: "terminal", env: {} },
        { type: "claude-code", env: {} },
        { type: "codex", env: {} },
      ],
    });

  it("shows no banner when every missing terminal was declined at the confirm", async () => {
    recipes.push(threeTerminals());
    runRecipeWithResultsMock.mockResolvedValue({
      spawned: [],
      failed: [
        { index: 0, error: PANEL_LIMIT_DECLINED_REASON },
        { index: 1, error: PANEL_LIMIT_DECLINED_REASON },
        { index: 2, error: PANEL_LIMIT_DECLINED_REASON },
      ],
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

  it("still reports real failures alongside a decline", async () => {
    recipes.push(threeTerminals());
    runRecipeWithResultsMock.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [
        { index: 1, error: PANEL_LIMIT_DECLINED_REASON },
        { index: 2, error: "spawn ENOENT" },
      ],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    await flush();

    expect(result.current.spawnFailureSummary?.failures.map((f) => f.index)).toEqual([1, 2]);
  });

  it("keeps the existing banner unchanged when a retry is declined", async () => {
    recipes.push(threeTerminals());
    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [
        { index: 1, error: "spawn ENOENT" },
        { index: 2, error: "spawn ENOENT" },
      ],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    await flush();
    const before = result.current.spawnFailureSummary;
    expect(before?.failures).toHaveLength(2);

    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [],
      failed: [
        { index: 1, error: PANEL_LIMIT_DECLINED_REASON },
        { index: 2, error: PANEL_LIMIT_DECLINED_REASON },
      ],
    });

    act(() => {
      result.current.handleRetryFailed();
    });
    await flush();

    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(2);
    expect(result.current.spawnFailureSummary).toBe(before);
    expect(result.current.isRetryingFailed).toBe(false);
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

describe("useRecipeRunner — retry after the recipe changes (#17446)", () => {
  const install = { type: "terminal" as const, title: "Install", command: "npm ci", env: {} };
  const lint = { type: "terminal" as const, title: "Lint", command: "npm run lint", env: {} };
  const deploy = { type: "terminal" as const, title: "Deploy", command: "npm run deploy", env: {} };

  async function failSecondStep() {
    recipes.push(makeRecipe({ id: "r1", name: "Pipeline", terminals: [install, lint, deploy] }));
    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [
        { index: 0, terminalId: "t-0" },
        { index: 2, terminalId: "t-2" },
      ],
      failed: [{ index: 1, error: "spawn ENOENT" }],
    });
    const hook = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      hook.result.current.handleRun("r1");
    });
    await flush();
    expect(hook.result.current.spawnFailureSummary?.failures.map((f) => f.index)).toEqual([1]);
    expect(hook.result.current.canRetryFailed).toBe(true);
    return hook;
  }

  async function approveConfirm() {
    await act(async () => {
      resolveRecipeRunConfirmation(useRecipeRunConfirmStore.getState().current!.requestId, true);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function expectRetryRefused(hook: Awaited<ReturnType<typeof failSecondStep>>) {
    hook.rerender();
    expect(hook.result.current.canRetryFailed).toBe(false);
    act(() => {
      hook.result.current.handleRetryFailed();
    });
    await flush();
    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(1);
    // The failure report stays: those terminals still didn't start.
    expect(hook.result.current.spawnFailureSummary?.failures[0]?.displayName).toBe("Lint");
  }

  it("refuses to retry by index once the steps are reordered", async () => {
    const hook = await failSecondStep();
    recipes[0] = { ...recipes[0]!, terminals: [install, deploy, lint] };
    await expectRetryRefused(hook);
  });

  it("refuses to retry once the failed step is removed", async () => {
    const hook = await failSecondStep();
    recipes[0] = { ...recipes[0]!, terminals: [install, deploy] };
    await expectRetryRefused(hook);
  });

  it("refuses to retry once the failed step is replaced", async () => {
    const hook = await failSecondStep();
    recipes[0] = {
      ...recipes[0]!,
      terminals: [install, { ...lint, command: "rm -rf build" }, deploy],
    };
    await expectRetryRefused(hook);
  });

  it("refuses to retry once the recipe is deleted", async () => {
    const hook = await failSecondStep();
    recipes.length = 0;
    await expectRetryRefused(hook);
  });

  it("refuses to retry once a team recipe starts shadowing the one that ran", async () => {
    const hook = await failSecondStep();
    // Same steps, so only the recipe's identity tells them apart.
    recipes[0] = { ...recipes[0]!, shadowedBy: "Pipeline" };
    recipes.push(
      makeRecipe({
        id: "inrepo-pipeline",
        name: "Pipeline",
        scope: "inrepo",
        terminals: [install, lint, deploy],
      })
    );
    await expectRetryRefused(hook);
  });

  it("checks the recipe again on click, before a re-render withdraws Retry", async () => {
    const hook = await failSecondStep();
    recipes[0] = { ...recipes[0]!, terminals: [install, deploy, lint] };
    act(() => {
      hook.result.current.handleRetryFailed();
    });
    await flush();
    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(1);
  });

  it("pins the steps that failed when the recipe changes behind the variables confirm", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Pair",
        terminals: [
          { type: "terminal", env: {} },
          { type: "claude-code", env: {}, initialPrompt: "review {{pr_number}}" },
        ],
      })
    );
    const ranDigest = recipeApprovalDigest(recipes[0]!.terminals);
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
    await approveConfirm();
    await flush();

    act(() => {
      result.current.handleRetryFailed();
    });
    expect(useRecipeRunConfirmStore.getState().current).not.toBeNull();
    recipes[0] = {
      ...recipes[0]!,
      terminals: [{ type: "claude-code", env: {}, initialPrompt: "rewrite {{pr_number}}" }],
    };
    await approveConfirm();

    // The store compares this against what it resolves and refuses the run.
    expect(runRecipeWithResultsMock).toHaveBeenLastCalledWith(
      "r1",
      "/tmp",
      "wt-1",
      expect.anything(),
      {
        spawnedBy: "recipe",
        terminalIndices: [1],
        expectedRecipe: { id: "r1", terminalsDigest: ranDigest },
      }
    );
  });

  it("still retries the same step when only the recipe's metadata moved", async () => {
    const hook = await failSecondStep();
    const digest = recipeApprovalDigest(recipes[0]!.terminals);
    // A reload or a frecency stamp hands back a new object with the same steps.
    recipes[0] = {
      ...recipes[0]!,
      terminals: recipes[0]!.terminals.map((t) => ({ ...t })),
      lastUsedAt: Date.now() + 1000,
    };
    hook.rerender();
    expect(hook.result.current.canRetryFailed).toBe(true);

    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [{ index: 1, terminalId: "t-1" }],
      failed: [],
    });
    act(() => {
      hook.result.current.handleRetryFailed();
    });
    await flush();

    // The store re-checks the same identity atomically, so an edit that lands
    // after this check is refused there rather than launched.
    expect(runRecipeWithResultsMock).toHaveBeenLastCalledWith(
      "r1",
      "/tmp",
      "wt-1",
      expect.anything(),
      {
        spawnedBy: "recipe",
        terminalIndices: [1],
        expectedRecipe: { id: "r1", terminalsDigest: digest },
      }
    );
    expect(hook.result.current.spawnFailureSummary).toBeNull();
  });

  it("retries what is still failing against the recipe that first ran", async () => {
    recipes.push(makeRecipe({ id: "r1", name: "Pipeline", terminals: [install, lint, deploy] }));
    const ran = { id: "r1", terminalsDigest: recipeApprovalDigest([install, lint, deploy]) };
    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [
        { index: 1, error: "spawn ENOENT" },
        { index: 2, error: "spawn ENOENT" },
      ],
    });
    const hook = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      hook.result.current.handleRun("r1");
    });
    await flush();

    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [{ index: 1, terminalId: "t-1" }],
      failed: [{ index: 2, error: "spawn ENOENT" }],
    });
    act(() => {
      hook.result.current.handleRetryFailed();
    });
    await flush();
    expect(runRecipeWithResultsMock.mock.calls[1]?.[4]).toEqual({
      spawnedBy: "recipe",
      terminalIndices: [1, 2],
      expectedRecipe: ran,
    });

    runRecipeWithResultsMock.mockResolvedValueOnce({ spawned: [], failed: [] });
    act(() => {
      hook.result.current.handleRetryFailed();
    });
    await flush();
    expect(runRecipeWithResultsMock.mock.calls[2]?.[4]).toEqual({
      spawnedBy: "recipe",
      terminalIndices: [2],
      expectedRecipe: ran,
    });
  });

  it("withdraws a partial retry's Retry once the recipe changes", async () => {
    const hook = await failSecondStep();
    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [],
      failed: [{ index: 1, error: "spawn ENOENT" }],
    });
    act(() => {
      hook.result.current.handleRetryFailed();
    });
    await flush();
    expect(hook.result.current.canRetryFailed).toBe(true);

    recipes[0] = { ...recipes[0]!, terminals: [install, deploy, lint] };
    hook.rerender();
    expect(hook.result.current.canRetryFailed).toBe(false);
    act(() => {
      hook.result.current.handleRetryFailed();
    });
    await flush();
    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(2);
  });

  it("retries a shadowed row through its own id, pinned to the team recipe that ran", async () => {
    recipes.push(
      makeRecipe({
        id: "local",
        name: "Pipeline",
        shadowedBy: "Pipeline",
        terminals: [install, lint, deploy],
      }),
      makeRecipe({
        id: "inrepo-pipeline",
        name: "Pipeline",
        scope: "inrepo",
        terminals: [install, lint, deploy],
      })
    );
    runRecipeWithResultsMock.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [{ index: 1, error: "spawn ENOENT" }],
    });
    const hook = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      hook.result.current.handleRun("local");
    });
    await flush();
    expect(hook.result.current.canRetryFailed).toBe(true);

    act(() => {
      hook.result.current.handleRetryFailed();
    });
    await flush();
    expect(runRecipeWithResultsMock).toHaveBeenLastCalledWith(
      "local",
      "/tmp",
      "wt-1",
      expect.anything(),
      {
        spawnedBy: "recipe",
        terminalIndices: [1],
        expectedRecipe: {
          id: "inrepo-pipeline",
          terminalsDigest: recipeApprovalDigest([install, lint, deploy]),
        },
      }
    );

    expect(hook.result.current.canRetryFailed).toBe(true);

    // Renamed out from under the team recipe, the row launches itself again:
    // the same steps, but not the recipe that ran.
    recipes[0] = { ...recipes[0]!, name: "My pipeline", shadowedBy: undefined };
    hook.rerender();
    expect(hook.result.current.canRetryFailed).toBe(false);
  });

  it("pins the steps that ran even when the recipe changes before the run settles", async () => {
    recipes.push(makeRecipe({ id: "r1", name: "Pipeline", terminals: [install, lint, deploy] }));
    let settle: (results: RecipeSpawnResults) => void = () => {};
    runRecipeWithResultsMock.mockReturnValueOnce(
      new Promise<RecipeSpawnResults>((resolve) => {
        settle = resolve;
      })
    );
    const hook = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      hook.result.current.handleRun("r1");
    });

    recipes[0] = { ...recipes[0]!, terminals: [install, deploy, lint] };
    hook.rerender();
    await act(async () => {
      settle({
        spawned: [
          { index: 0, terminalId: "t-0" },
          { index: 2, terminalId: "t-2" },
        ],
        failed: [{ index: 1, error: "spawn ENOENT" }],
      });
      await Promise.resolve();
    });
    await flush();

    expect(hook.result.current.spawnFailureSummary?.failures[0]?.displayName).toBe("Lint");
    expect(hook.result.current.canRetryFailed).toBe(false);
    act(() => {
      hook.result.current.handleRetryFailed();
    });
    await flush();
    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(1);
  });
});

describe("useRecipeRunner — missing variables hold the run (#15022)", () => {
  function pending() {
    return useRecipeRunConfirmStore.getState().current;
  }

  async function answer(approved: boolean) {
    await act(async () => {
      resolveRecipeRunConfirmation(pending()!.requestId, approved);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  const reviewRecipe = () =>
    makeRecipe({
      id: "r1",
      name: "Review",
      terminals: [
        {
          type: "claude-code",
          env: {},
          initialPrompt:
            "review issue {{issue_number}} on branch {{branch_name}} for pr {{pr_number}}",
        },
      ],
    });

  it("asks about the missing built-ins and spawns nothing until the user decides", () => {
    recipes.push(reviewRecipe());
    runRecipeWithResultsMock.mockResolvedValue({ spawned: [], failed: [] });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });

    // Only pr_number is missing — issue_number=42 and branch_name="feature/test" are populated.
    expect(pending()).toMatchObject({ recipeName: "Review", missing: ["pr_number"] });
    expect(runRecipeWithResultsMock).not.toHaveBeenCalled();
    expect(result.current.unresolvedVars).toEqual([]);
  });

  it("runs the recipe the user approved once they choose to run it empty", async () => {
    recipes.push(reviewRecipe());
    runRecipeWithResultsMock.mockResolvedValue({ spawned: [], failed: [] });
    const approvedDigest = recipeApprovalDigest(reviewRecipe().terminals);

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("r1");
    });
    // Edited while the dialog was open: the store has to see what was shown,
    // so it can refuse the run rather than start the new terminals.
    const edited = makeRecipe({ id: "r1", name: "Review", terminals: [{ type: "terminal" }] });
    expect(recipeApprovalDigest(edited.terminals)).not.toBe(approvedDigest);
    recipes.splice(0, 1, edited);
    await answer(true);

    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(1);
    expect(runRecipeWithResultsMock).toHaveBeenCalledWith(
      "r1",
      "/tmp",
      "wt-1",
      expect.objectContaining({ issueNumber: 42 }),
      {
        spawnedBy: "recipe",
        expectedRecipe: { id: "r1", terminalsDigest: approvedDigest },
      }
    );
  });

  it("backing out spawns nothing, keeps the last failure banner and frees the runner", async () => {
    recipes.push(
      makeRecipe({
        id: "r0",
        name: "Flaky",
        terminals: [
          { type: "terminal", env: {} },
          { type: "terminal", env: {} },
        ],
      }),
      reviewRecipe()
    );
    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [{ index: 1, error: "Panel limit reached" }],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("r0");
    });
    await flush();
    expect(result.current.spawnFailureSummary).not.toBeNull();

    act(() => {
      result.current.handleRun("r1");
    });
    await answer(false);

    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(1);
    expect(result.current.spawnFailureSummary?.recipeName).toBe("Flaky");

    act(() => {
      result.current.handleRun("r1");
    });
    expect(pending()).not.toBeNull();
  });

  it("launches a recipe with every value straight away, without asking", () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Resolved",
        terminals: [{ type: "claude-code", env: {}, initialPrompt: "fix {{issue_number}}" }],
      })
    );
    runRecipeWithResultsMock.mockResolvedValue({ spawned: [], failed: [] });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("r1");
    });

    expect(pending()).toBeNull();
    expect(runRecipeWithResultsMock).toHaveBeenCalledWith(
      "r1",
      "/tmp",
      "wt-1",
      expect.objectContaining({ issueNumber: 42 }),
      { spawnedBy: "recipe" }
    );
  });

  it("takes {{pr_number}} from the worktree's linked PR", () => {
    linkedPrNumber = 17;
    recipes.push(reviewRecipe());
    runRecipeWithResultsMock.mockResolvedValue({ spawned: [], failed: [] });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("r1");
    });

    expect(pending()).toBeNull();
    expect(runRecipeWithResultsMock).toHaveBeenCalledWith(
      "r1",
      "/tmp",
      "wt-1",
      expect.objectContaining({ prNumber: 17 }),
      { spawnedBy: "recipe" }
    );
  });

  it("a second Enter while the question is open doesn't stack another run", () => {
    recipes.push(reviewRecipe());

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("r1");
      result.current.handleRun("r1");
    });

    expect(useRecipeRunConfirmStore.getState().queue).toEqual([]);
  });

  it("withdraws the question when the worktree changes under it", async () => {
    recipes.push(reviewRecipe());

    const { result, rerender } = renderHook(
      ({ wt }: { wt: string }) => useRecipeRunner({ activeWorktreeId: wt, defaultCwd: "/tmp" }),
      { initialProps: { wt: "wt-1" } }
    );
    act(() => {
      result.current.handleRun("r1");
    });

    rerender({ wt: "wt-2" });
    await flush();

    expect(pending()).toBeNull();
    expect(runRecipeWithResultsMock).not.toHaveBeenCalled();
    act(() => {
      result.current.handleRun("r1");
    });
    expect(pending()).not.toBeNull();
  });

  it("drops an approval that lands after the worktree changed", async () => {
    recipes.push(reviewRecipe());

    const { result, rerender } = renderHook(
      ({ wt }: { wt: string }) => useRecipeRunner({ activeWorktreeId: wt, defaultCwd: "/tmp" }),
      { initialProps: { wt: "wt-1" } }
    );
    act(() => {
      result.current.handleRun("r1");
    });

    // Answered, but the switch lands before the answer's continuation runs.
    resolveRecipeRunConfirmation(pending()!.requestId, true);
    rerender({ wt: "wt-2" });
    await flush();

    expect(runRecipeWithResultsMock).not.toHaveBeenCalled();
  });

  it("drops an approval that lands after the runner unmounts", async () => {
    recipes.push(reviewRecipe());

    const { result, unmount } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("r1");
    });

    resolveRecipeRunConfirmation(pending()!.requestId, true);
    unmount();
    await flush();

    expect(runRecipeWithResultsMock).not.toHaveBeenCalled();
  });

  it("withdraws the question when the runner unmounts", () => {
    recipes.push(reviewRecipe());

    const { result, unmount } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("r1");
    });
    unmount();

    expect(pending()).toBeNull();
  });

  it("does not ask about {{vars}} in a plain-terminal command (the store does not substitute it)", async () => {
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

    expect(pending()).toBeNull();
    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(1);
    expect(result.current.unresolvedVars).toEqual([]);
  });

  it("asks again before retrying failed terminals whose prompts still miss a value", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Pair",
        terminals: [
          { type: "terminal", env: {} },
          { type: "claude-code", env: {}, initialPrompt: "review {{pr_number}}" },
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
    await answer(true);
    await flush();
    expect(result.current.spawnFailureSummary).not.toBeNull();

    act(() => {
      result.current.handleRetryFailed();
    });
    expect(pending()?.missing).toEqual(["pr_number"]);
    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(1);

    await answer(true);
    expect(runRecipeWithResultsMock).toHaveBeenLastCalledWith(
      "r1",
      "/tmp",
      "wt-1",
      expect.anything(),
      {
        spawnedBy: "recipe",
        terminalIndices: [1],
        expectedRecipe: { id: "r1", terminalsDigest: recipeApprovalDigest(recipes[0]!.terminals) },
      }
    );
  });

  it("retries without asking when only the terminals that started miss a value", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Pair",
        terminals: [
          { type: "claude-code", env: {}, initialPrompt: "review {{pr_number}}" },
          { type: "claude-code", env: {}, initialPrompt: "fix {{issue_number}}" },
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
    await answer(true);
    await flush();

    act(() => {
      result.current.handleRetryFailed();
    });

    expect(pending()).toBeNull();
    expect(runRecipeWithResultsMock).toHaveBeenLastCalledWith(
      "r1",
      "/tmp",
      "wt-1",
      expect.anything(),
      {
        spawnedBy: "recipe",
        terminalIndices: [1],
        expectedRecipe: { id: "r1", terminalsDigest: recipeApprovalDigest(recipes[0]!.terminals) },
      }
    );
    await flush();
  });
});

describe("useRecipeRunner — a confirmed recipe that changed before it started (#17447)", () => {
  function pending() {
    return useRecipeRunConfirmStore.getState().current;
  }

  async function answer(approved: boolean) {
    await act(async () => {
      resolveRecipeRunConfirmation(pending()!.requestId, approved);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  const needsPr = (overrides: Partial<TerminalRecipe> = {}) =>
    makeRecipe({
      id: "r1",
      name: "Review",
      terminals: [{ type: "claude-code", env: {}, initialPrompt: "review pr {{pr_number}}" }],
      ...overrides,
    });

  // The store's own check: what the confirm approved against what it would launch now.
  function refuseChangedRecipes() {
    runRecipeWithResultsMock.mockImplementation(async (recipeId, _path, _wt, _ctx, options) => {
      const expected = (options as { expectedRecipe?: { id: string; terminalsDigest: string } })
        ?.expectedRecipe;
      const current = recipeStoreState.getRecipeById(recipeId);
      if (
        expected &&
        (current?.id !== expected.id ||
          recipeApprovalDigest(current.terminals) !== expected.terminalsDigest)
      ) {
        throw new RecipeChangedSinceShownError();
      }
      return { spawned: [{ index: 0, terminalId: "t-0" }], failed: [] };
    });
  }

  function editorRequests() {
    const opened: unknown[] = [];
    const listener = (e: Event) => {
      if (e instanceof CustomEvent) opened.push(e.detail.recipeId);
    };
    window.addEventListener("daintree:open-recipe-editor", listener);
    return {
      opened,
      stop: () => window.removeEventListener("daintree:open-recipe-editor", listener),
    };
  }

  it("says why the approved run started nothing and opens the current recipe for review", async () => {
    recipes.push(needsPr());
    refuseChangedRecipes();
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("r1");
    });
    recipes.splice(0, 1, needsPr({ terminals: [{ type: "terminal", env: {} }] }));
    await answer(true);

    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(1);
    expect(result.current.changedRecipe).toEqual({
      recipeId: "r1",
      recipeName: "Review",
      current: "editable",
    });
    expect(result.current.spawnFailureSummary).toBeNull();
    expect(logErrorMock).not.toHaveBeenCalled();

    const editor = editorRequests();
    try {
      act(() => {
        result.current.reviewChangedRecipe();
      });
      expect(editor.opened).toEqual(["r1"]);
    } finally {
      editor.stop();
    }
    // Still there when the editor closes, so focus has its Review to go back to.
    expect(result.current.changedRecipe).not.toBeNull();

    // Trying again asks about what the recipe is now, and that run starts.
    act(() => {
      result.current.handleRun("r1");
    });
    await flush();
    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(2);
    expect(result.current.changedRecipe).toBeNull();
  });

  it("names the recipe a shadowed row now runs, and reviews that one", async () => {
    recipes.push(needsPr({ id: "mine", name: "Dev" }));
    refuseChangedRecipes();
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("mine");
    });
    // A team recipe of the same name lands while the confirm is open, behind a
    // plugin's same-name recipe whose id happens to carry the legacy in-repo prefix.
    recipes.splice(
      0,
      1,
      needsPr({ id: "mine", name: "Dev", shadowedBy: "Dev" }),
      needsPr({
        id: "inrepo-acme.tools.dev",
        name: "Dev",
        origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "dev" },
      }),
      needsPr({ id: "team-dev", name: "Dev", scope: "inrepo" })
    );
    await answer(true);

    expect(result.current.changedRecipe).toEqual({
      recipeId: "mine",
      recipeName: "Dev",
      current: "editable",
    });
    const editor = editorRequests();
    try {
      act(() => {
        result.current.reviewChangedRecipe();
      });
      // The row's id: the editor follows it to the team recipe, as a run would.
      expect(editor.opened).toEqual(["mine"]);
    } finally {
      editor.stop();
    }
  });

  it("offers no editor for a plugin's recipe, whose content its plugin owns", async () => {
    const plugin = (initialPrompt: string) =>
      makeRecipe({
        id: "acme.tools.rel",
        name: "Release",
        origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "rel" },
        terminals: [{ type: "claude-code", env: {}, initialPrompt }],
      });
    recipes.push(plugin("ship {{pr_number}}"));
    refuseChangedRecipes();
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("acme.tools.rel");
    });
    recipes.splice(0, 1, plugin("ship it {{pr_number}}"));
    await answer(true);

    expect(result.current.changedRecipe).toEqual({
      recipeId: "acme.tools.rel",
      recipeName: "Release",
      current: "plugin",
    });
    const editor = editorRequests();
    try {
      act(() => {
        result.current.reviewChangedRecipe();
      });
      expect(editor.opened).toEqual([]);
    } finally {
      editor.stop();
    }
  });

  it("keeps the explanation but opens no blank draft once the recipe is deleted", async () => {
    recipes.push(needsPr());
    refuseChangedRecipes();
    const { result, rerender } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("r1");
    });
    recipes.splice(0, 1, needsPr({ terminals: [{ type: "terminal", env: {} }] }));
    await answer(true);
    expect(result.current.changedRecipe).not.toBeNull();

    // Deleted since: the store publishes a new list without it.
    recipeStoreState.recipes = [];
    rerender();
    expect(result.current.changedRecipe).toMatchObject({
      recipeName: "Review",
      current: "missing",
    });
    const editor = editorRequests();
    try {
      act(() => {
        result.current.reviewChangedRecipe();
      });
      expect(editor.opened).toEqual([]);
    } finally {
      editor.stop();
    }
  });

  it("leaves a refused retry to the failure banner, which withdraws Retry (#17446)", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Pair",
        terminals: [
          { type: "terminal", env: {} },
          { type: "claude-code", env: {}, initialPrompt: "review pr {{pr_number}}" },
        ],
      })
    );
    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [{ index: 1, error: "Panel limit reached" }],
    });
    const { result, rerender } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("r1");
    });
    await answer(true);
    expect(result.current.canRetryFailed).toBe(true);
    const ranDigest = recipeApprovalDigest(recipes[0]!.terminals);

    refuseChangedRecipes();
    act(() => {
      result.current.handleRetryFailed();
    });
    recipeStoreState.recipes = [
      makeRecipe({
        id: "r1",
        name: "Pair",
        terminals: [
          { type: "terminal", env: {} },
          { type: "codex", env: {}, initialPrompt: "review pr {{pr_number}}" },
        ],
      }),
    ];
    await answer(true);
    rerender();

    // The approval reached the store pinned to the steps that ran, and was refused.
    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(2);
    expect(runRecipeWithResultsMock.mock.calls[1]?.[4]).toMatchObject({
      terminalIndices: [1],
      expectedRecipe: { id: "r1", terminalsDigest: ranDigest },
    });
    expect(logErrorMock).toHaveBeenCalledWith(
      "Recipe retry failed",
      expect.any(RecipeChangedSinceShownError)
    );
    // One explanation, not two: the failures still happened and say why Retry went.
    expect(result.current.changedRecipe).toBeNull();
    expect(result.current.spawnFailureSummary?.recipeName).toBe("Pair");
    expect(result.current.canRetryFailed).toBe(false);
    expect(result.current.isRetryingFailed).toBe(false);
  });

  it("drops the launched-empty notice, since nothing launched", async () => {
    const plugin = (initialPrompt: string) =>
      makeRecipe({
        id: "acme.ledger.review",
        name: "Ledger",
        origin: { kind: "plugin", pluginId: "acme.ledger", contributionId: "review" },
        terminals: [{ type: "claude-code", env: {}, initialPrompt }],
      });
    recipes.push(plugin("pr {{pr_number}} notes {{plugin.notes}}"));
    refuseChangedRecipes();
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("acme.ledger.review");
    });
    recipes.splice(0, 1, plugin("pr {{pr_number}} more {{plugin.notes}}"));
    await answer(true);

    expect(result.current.changedRecipe).not.toBeNull();
    expect(result.current.unresolvedVars).toEqual([]);
  });

  it("clears on dismiss and when the worktree changes", async () => {
    recipes.push(needsPr());
    refuseChangedRecipes();
    const { result, rerender } = renderHook(
      ({ wt }: { wt: string }) => useRecipeRunner({ activeWorktreeId: wt, defaultCwd: "/tmp" }),
      { initialProps: { wt: "wt-1" } }
    );
    const refuse = async () => {
      act(() => {
        result.current.handleRun("r1");
      });
      const edited = recipes[0]!.terminals[0]!.initialPrompt + "!";
      recipes.splice(
        0,
        1,
        needsPr({ terminals: [{ type: "claude-code", env: {}, initialPrompt: edited }] })
      );
      await answer(true);
      expect(result.current.changedRecipe).not.toBeNull();
    };

    await refuse();
    act(() => {
      result.current.dismissChangedRecipe();
    });
    expect(result.current.changedRecipe).toBeNull();

    await refuse();
    rerender({ wt: "wt-2" });
    expect(result.current.changedRecipe).toBeNull();
  });

  it("drops a refusal that lands after the worktree changed", async () => {
    recipes.push(needsPr());
    let reject!: (error: unknown) => void;
    runRecipeWithResultsMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, rej) => {
          reject = rej;
        })
    );
    const { result, rerender } = renderHook(
      ({ wt }: { wt: string }) => useRecipeRunner({ activeWorktreeId: wt, defaultCwd: "/tmp" }),
      { initialProps: { wt: "wt-1" } }
    );
    act(() => {
      result.current.handleRun("r1");
    });
    await answer(true);
    rerender({ wt: "wt-2" });
    await act(async () => {
      reject(new RecipeChangedSinceShownError());
      await Promise.resolve();
    });

    expect(result.current.changedRecipe).toBeNull();
  });

  it("logs any other store error without calling it a change", async () => {
    recipes.push(
      makeRecipe({
        id: "r1",
        name: "Pair",
        terminals: [
          { type: "terminal", env: {} },
          { type: "claude-code", env: {}, initialPrompt: "review pr {{pr_number}}" },
        ],
      })
    );
    const failure = new Error("IPC went away");
    runRecipeWithResultsMock.mockRejectedValueOnce(failure);
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("r1");
    });
    await answer(true);
    expect(result.current.changedRecipe).toBeNull();
    expect(logErrorMock).toHaveBeenCalledWith("Recipe run failed", failure);

    runRecipeWithResultsMock.mockResolvedValueOnce({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [{ index: 1, error: "Panel limit reached" }],
    });
    act(() => {
      result.current.handleRun("r1");
    });
    await answer(true);
    const summary = result.current.spawnFailureSummary;
    expect(summary).not.toBeNull();

    runRecipeWithResultsMock.mockRejectedValueOnce(failure);
    act(() => {
      result.current.handleRetryFailed();
    });
    await answer(true);
    expect(result.current.changedRecipe).toBeNull();
    expect(result.current.spawnFailureSummary).toBe(summary);
    expect(logErrorMock).toHaveBeenCalledWith("Recipe retry failed", failure);
  });

  it("keeps the refusal through a backed-out confirm and drops it once the next run starts", async () => {
    recipes.push(needsPr());
    refuseChangedRecipes();
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("r1");
    });
    recipes.splice(
      0,
      1,
      needsPr({
        terminals: [{ type: "claude-code", env: {}, initialPrompt: "ship pr {{pr_number}}" }],
      })
    );
    await answer(true);
    expect(result.current.changedRecipe).not.toBeNull();

    act(() => {
      result.current.handleRun("r1");
    });
    expect(result.current.changedRecipe).not.toBeNull();
    await answer(false);
    expect(result.current.changedRecipe).not.toBeNull();

    let resolve!: (results: RecipeSpawnResults) => void;
    runRecipeWithResultsMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = res;
        })
    );
    act(() => {
      result.current.handleRun("r1");
    });
    await answer(true);
    // Gone as soon as the approved run is underway, not when it finishes.
    expect(result.current.changedRecipe).toBeNull();
    await act(async () => {
      resolve({ spawned: [{ index: 0, terminalId: "t-0" }], failed: [] });
      await Promise.resolve();
    });
  });
});

describe("useRecipeRunner — plugin variables", () => {
  const pluginRecipe = () =>
    makeRecipe({
      id: "acme.ledger.review",
      name: "Ledger review",
      origin: { kind: "plugin", pluginId: "acme.ledger", contributionId: "review" },
      terminals: [
        { type: "claude-code", env: {}, initialPrompt: "review {{plugin.notes}}" },
        { type: "terminal", env: {} },
      ],
    });

  it("launches a plugin recipe's empty variables without asking, then names them", async () => {
    recipes.push(pluginRecipe());
    runRecipeWithResultsMock.mockResolvedValue({ spawned: [], failed: [] });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("acme.ledger.review");
    });
    await flush();

    expect(useRecipeRunConfirmStore.getState().current).toBeNull();
    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(1);
    expect(result.current.unresolvedVars).toEqual(["plugin.notes"]);
  });

  it("asks only about the built-ins in a plugin recipe, then names its own variables", async () => {
    recipes.push(
      makeRecipe({
        id: "acme.ledger.review",
        name: "Ledger review",
        origin: { kind: "plugin", pluginId: "acme.ledger", contributionId: "review" },
        terminals: [
          {
            type: "claude-code",
            env: {},
            initialPrompt: "review {{plugin.notes}} for {{pr_number}}",
          },
        ],
      })
    );
    runRecipeWithResultsMock.mockResolvedValue({ spawned: [], failed: [] });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    act(() => {
      result.current.handleRun("acme.ledger.review");
    });

    expect(useRecipeRunConfirmStore.getState().current?.missing).toEqual(["pr_number"]);
    expect(runRecipeWithResultsMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveRecipeRunConfirmation(useRecipeRunConfirmStore.getState().current!.requestId, true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runRecipeWithResultsMock).toHaveBeenCalledTimes(1);
    expect(result.current.unresolvedVars).toEqual(["plugin.notes"]);
  });

  it("dismisses each banner independently", async () => {
    recipes.push(pluginRecipe());
    runRecipeWithResultsMock.mockResolvedValue({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [{ index: 1, error: "Panel limit reached" }],
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleRun("acme.ledger.review");
    });
    await flush();

    expect(result.current.unresolvedVars).toEqual(["plugin.notes"]);
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

  it("matches the keyword in either the name or the command field", () => {
    projectSettingsState.allDetectedRunners = [
      // keyword only in name
      makeRunCommand({ id: "1", name: "dev", command: "vite" }),
      // keyword only in command
      makeRunCommand({ id: "2", name: "watch", command: "npm run dev" }),
      // neither field matches
      makeRunCommand({ id: "3", name: "lint", command: "eslint ." }),
    ];

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    expect(result.current.suggestions.map((s) => s.id)).toEqual(["1", "2"]);
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

  it("logs and releases the guard when addPanel resolves null (panel rejected)", async () => {
    const suggestion = makeRunCommand({ id: "s-dev", name: "dev", command: "npm run dev" });
    addPanelMock.mockResolvedValueOnce(null);

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/repo" })
    );

    act(() => {
      result.current.handleRunSuggestion(suggestion);
    });
    await flush();

    expect(logErrorMock).toHaveBeenCalledWith(
      "Suggestion run rejected by panel store",
      "npm run dev"
    );

    // Guard released — a follow-up click fires.
    addPanelMock.mockResolvedValueOnce("panel-2");
    act(() => {
      result.current.handleRunSuggestion(suggestion);
    });
    await flush();
    expect(addPanelMock).toHaveBeenCalledTimes(2);
  });

  it("passes worktreeId: undefined to addPanel when activeWorktreeId is null", async () => {
    const suggestion = makeRunCommand({ id: "s-dev", name: "dev", command: "npm run dev" });
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: null, defaultCwd: "/repo" })
    );

    act(() => {
      result.current.handleRunSuggestion(suggestion);
    });
    await flush();

    expect(addPanelMock).toHaveBeenCalledTimes(1);
    expect(addPanelMock.mock.calls[0]?.[0]).toMatchObject({ worktreeId: undefined });
  });
});

describe("useRecipeRunner — delete confirm flow", () => {
  it("handleDelete arms the confirm dialog instead of deleting directly", () => {
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleDelete("r1");
    });

    expect(result.current.pendingDeleteId).toBe("r1");
    expect(recipeStoreState.deleteRecipe).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("confirmDelete dispatches recipe.delete with confirmed:true and clears on success", async () => {
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleDelete("r1");
    });
    act(() => {
      result.current.confirmDelete();
    });
    await flush();

    expect(dispatchMock).toHaveBeenCalledWith(
      "recipe.delete",
      { recipeId: "r1" },
      { source: "user", confirmed: true }
    );
    expect(result.current.pendingDeleteId).toBeNull();
    expect(result.current.deleteError).toBeNull();
  });

  it("keeps the dialog open with an error when dispatch fails", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "boom" },
    });

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleDelete("r1");
    });
    act(() => {
      result.current.confirmDelete();
    });
    await flush();

    expect(result.current.pendingDeleteId).toBe("r1");
    expect(result.current.deleteError).toBeTruthy();
    expect(logErrorMock).toHaveBeenCalledWith(
      "Failed to delete recipe",
      expect.objectContaining({ code: "EXECUTION_ERROR" })
    );
  });

  it("keeps naming the recipe it was asked about, through its exit (#16906)", async () => {
    recipes.push(makeRecipe({ id: "r1", name: "Dev server" }));
    const { result, rerender } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleDelete("r1");
    });
    // A rename while the confirm is open doesn't change the question asked.
    recipeStoreState.recipes = [makeRecipe({ id: "r1", name: "Renamed" })];
    rerender();
    expect(result.current.deleteTarget).toEqual({ id: "r1", name: "Dev server" });

    // The store drops the recipe as the delete lands; the closing dialog must
    // not fall back to a generic title.
    dispatchMock.mockImplementationOnce(async () => {
      recipeStoreState.recipes = [];
      return { ok: true, result: undefined };
    });
    act(() => {
      result.current.confirmDelete();
    });
    await flush();

    expect(result.current.recipes).toEqual([]);
    expect(result.current.pendingDeleteId).toBeNull();
    expect(result.current.deleteTarget).toEqual({ id: "r1", name: "Dev server" });
  });

  it("keeps a failure's error through a cancel's exit and clears it for the next request", async () => {
    recipes.push(makeRecipe({ id: "r1", name: "Dev server" }));
    dispatchMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "boom" },
    });
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleDelete("r1");
    });
    act(() => {
      result.current.confirmDelete();
    });
    await flush();
    act(() => {
      result.current.cancelDelete();
    });

    expect(result.current.pendingDeleteId).toBeNull();
    expect(result.current.deleteError).toBeTruthy();

    act(() => {
      result.current.handleDelete("r1");
    });
    expect(result.current.deleteError).toBeNull();
  });

  it("leaves a later confirm alone when a delete settles after a worktree switch", async () => {
    recipes.push(
      makeRecipe({ id: "r1", name: "Dev server" }),
      makeRecipe({ id: "r2", name: "Docs" })
    );
    let settle: (value: Awaited<ReturnType<typeof actionService.dispatch>>) => void = () => {};
    dispatchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const { result, rerender } = renderHook(
      ({ worktreeId }) => useRecipeRunner({ activeWorktreeId: worktreeId, defaultCwd: "/tmp" }),
      { initialProps: { worktreeId: "wt-1" } }
    );

    act(() => {
      result.current.handleDelete("r1");
    });
    act(() => {
      result.current.confirmDelete();
    });
    rerender({ worktreeId: "wt-2" });
    act(() => {
      result.current.handleDelete("r2");
    });
    await act(async () => {
      settle({ ok: false, error: { code: "EXECUTION_ERROR", message: "boom" } });
      await Promise.resolve();
    });
    await flush();

    expect(result.current.pendingDeleteId).toBe("r2");
    expect(result.current.deleteError).toBeNull();
    expect(result.current.isDeleting).toBe(false);
  });

  it("is busy while the delete runs, and a cancel then is ignored", async () => {
    recipes.push(makeRecipe({ id: "r1", name: "Dev server" }));
    let settle: (value: { ok: true; result: undefined }) => void = () => {};
    dispatchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleDelete("r1");
    });
    act(() => {
      result.current.confirmDelete();
    });
    expect(result.current.isDeleting).toBe(true);

    act(() => {
      result.current.cancelDelete();
    });
    expect(result.current.pendingDeleteId).toBe("r1");

    await act(async () => {
      settle({ ok: true, result: undefined });
      await Promise.resolve();
    });
    await flush();
    expect(result.current.isDeleting).toBe(false);
    expect(result.current.pendingDeleteId).toBeNull();
  });

  it("closes the confirm for another worktree and names the next request afresh", () => {
    recipes.push(
      makeRecipe({ id: "r1", name: "Dev server" }),
      makeRecipe({ id: "r2", name: "Docs" })
    );
    const { result, rerender } = renderHook(
      ({ worktreeId }) => useRecipeRunner({ activeWorktreeId: worktreeId, defaultCwd: "/tmp" }),
      { initialProps: { worktreeId: "wt-1" } }
    );

    act(() => {
      result.current.handleDelete("r1");
    });
    rerender({ worktreeId: "wt-2" });
    expect(result.current.pendingDeleteId).toBeNull();

    act(() => {
      result.current.handleDelete("r2");
    });
    expect(result.current.pendingDeleteId).toBe("r2");
    expect(result.current.deleteTarget).toEqual({ id: "r2", name: "Docs" });
  });

  it("cancelDelete clears the pending id without dispatching", () => {
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleDelete("r1");
    });
    act(() => {
      result.current.cancelDelete();
    });

    expect(result.current.pendingDeleteId).toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("confirmDelete is a no-op when nothing is pending", async () => {
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.confirmDelete();
    });
    await flush();

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("clears a pending delete when the active worktree changes", () => {
    const { result, rerender } = renderHook(
      ({ activeWorktreeId }: { activeWorktreeId: string }) =>
        useRecipeRunner({ activeWorktreeId, defaultCwd: "/tmp" }),
      { initialProps: { activeWorktreeId: "wt-1" } }
    );

    act(() => {
      result.current.handleDelete("r1");
    });
    expect(result.current.pendingDeleteId).toBe("r1");

    rerender({ activeWorktreeId: "wt-2" });

    expect(result.current.pendingDeleteId).toBeNull();
    expect(result.current.deleteError).toBeNull();
  });

  it("dispatches recipe.delete once when confirmDelete is double-clicked", async () => {
    let resolve: (r: { ok: true; result: undefined }) => void = () => {};
    dispatchMock.mockReturnValueOnce(
      new Promise<{ ok: true; result: undefined }>((r) => {
        resolve = r;
      })
    );

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleDelete("r1");
    });
    act(() => {
      result.current.confirmDelete();
      result.current.confirmDelete();
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ ok: true, result: undefined });
      await Promise.resolve();
    });
  });
});

describe("useRecipeRunner — keyboard model", () => {
  it("updates focusedItemId when setFocusedIndex is called", () => {
    recipes.push(
      makeRecipe({ id: "alpha", name: "Alpha" }),
      makeRecipe({ id: "beta", name: "Beta" }),
      makeRecipe({ id: "gamma", name: "Gamma" })
    );

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.setFocusedIndex(2);
    });

    expect(result.current.focusedIndex).toBe(2);
    expect(result.current.focusedItemId).toBe("recipe-option-gamma");
  });

  it("wraps the arrows at the ends, jumps with Home/End, and leaves Shift+End to the field", () => {
    recipes.push(
      makeRecipe({ id: "alpha", name: "Alpha" }),
      makeRecipe({ id: "beta", name: "Beta" }),
      makeRecipe({ id: "gamma", name: "Gamma" })
    );

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    const { container } = render(
      <div tabIndex={0} onKeyDown={(e) => result.current.handleKeyDown(e)} />
    );
    const press = (key: string) => {
      act(() => {
        fireEvent.keyDown(container.firstChild!, { key });
      });
    };
    const first = "recipe-option-alpha";
    const last = "recipe-option-create";
    expect(result.current.focusedItemId).toBe(first);

    press("ArrowUp");
    expect(result.current.focusedItemId).toBe(last);
    press("ArrowDown");
    expect(result.current.focusedItemId).toBe(first);

    press("End");
    expect(result.current.focusedItemId).toBe(last);
    press("Home");
    expect(result.current.focusedItemId).toBe(first);

    let notConsumed = false;
    act(() => {
      notConsumed = fireEvent.keyDown(container.firstChild!, { key: "End", shiftKey: true });
    });
    expect(notConsumed).toBe(true);
    expect(result.current.focusedItemId).toBe(first);
  });

  it("exposes the create option id when focusedIndex is at the trailing button", () => {
    recipes.push(makeRecipe({ id: "alpha", name: "Alpha" }));

    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.setFocusedIndex(1);
    });

    expect(result.current.focusedItemId).toBe("recipe-option-create");
  });
});

describe("useRecipeRunner — a shadowed row describes what it will actually launch", () => {
  it("shows the terminals of the team recipe a shadowed row defers to", () => {
    const local = makeRecipe({
      id: "local",
      name: "Test watch",
      projectId: "p",
      shadowedBy: "Test watch",
      terminals: [{ type: "terminal", title: "Local vitest", env: {} }],
    });
    const team = makeRecipe({
      id: "inrepo-test-watch",
      name: "Test watch",
      scope: "inrepo",
      terminals: [
        { type: "terminal", title: "Team vitest", env: {} },
        { type: "terminal", title: "Coverage", env: {} },
      ],
    });
    recipes.push(local, team);
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/repo" })
    );
    const shown = result.current.recipes.find((r) => r.id === "local")!;
    // The row keeps its own identity (so it stays listed and runnable) while
    // everything it says about what launches comes from the recipe that wins.
    expect(shown.id).toBe("local");
    expect(shown.terminals).toEqual(team.terminals);
  });
});

describe("useRecipeRunner — keyboard edit follows the same ownership rule as the menu", () => {
  it("does not open the editor on a plugin recipe from F2", () => {
    recipes.push(
      makeRecipe({
        id: "acme.tools.rel",
        name: "Release",
        origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "rel" },
      }),
      makeRecipe({ id: "mine", name: "Mine" })
    );
    const events: string[] = [];
    const listener = (e: Event) => {
      if (e instanceof CustomEvent) events.push(String(e.detail.recipeId));
    };
    window.addEventListener("daintree:open-recipe-editor", listener);
    try {
      const { result } = renderHook(() =>
        useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/repo" })
      );
      const { container } = render(
        <div tabIndex={0} onKeyDown={(e) => result.current.handleKeyDown(e)} />
      );
      const press = () => fireEvent.keyDown(container.firstChild!, { key: "F2" });
      const flat = result.current.getFlatRecipes();
      for (let i = 0; i < flat.length; i++) {
        act(() => result.current.setFocusedIndex(i));
        press();
      }
      expect(events).toEqual(["mine"]);
    } finally {
      window.removeEventListener("daintree:open-recipe-editor", listener);
    }
  });

  it("leaves Cmd+E alone, for Canopy", () => {
    recipes.push(makeRecipe({ id: "mine", name: "Mine" }));
    const events: string[] = [];
    const listener = (e: Event) => {
      if (e instanceof CustomEvent) events.push(String(e.detail.recipeId));
    };
    window.addEventListener("daintree:open-recipe-editor", listener);
    try {
      const { result } = renderHook(() =>
        useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/repo" })
      );
      const { container } = render(
        <div tabIndex={0} onKeyDown={(e) => result.current.handleKeyDown(e)} />
      );
      act(() => result.current.setFocusedIndex(0));
      fireEvent.keyDown(container.firstChild!, { key: "e", metaKey: true });
      expect(events).toEqual([]);
    } finally {
      window.removeEventListener("daintree:open-recipe-editor", listener);
    }
  });
});

describe("useRecipeRunner — IME composition", () => {
  it("leaves a composing Enter to the input and still runs on a plain one", () => {
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );
    const { container } = render(
      <div tabIndex={0} onKeyDown={(e) => result.current.handleKeyDown(e)} />
    );
    const node = container.firstChild!;
    const composing = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      node.dispatchEvent(composing);
    });
    expect(composing.defaultPrevented).toBe(false);
    const legacy = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      node.dispatchEvent(legacy);
    });
    expect(legacy.defaultPrevented).toBe(false);
    const plain = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      node.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(true);
  });
});

describe("useRecipeRunner — a live query never hides recipes behind a vanished filter", () => {
  it("keeps the filterable list while a query is active, whatever the count", () => {
    for (let i = 0; i < 7; i++) recipes.push(makeRecipe({ id: `r${i}`, name: `Recipe ${i}` }));
    const { result, rerender } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/repo" })
    );
    act(() => result.current.setSearchQuery("Recipe 3"));
    // A store update hands the hook a new array, as a delete does.
    recipeStoreState.recipes = recipes.slice(2);
    rerender();
    expect(result.current.recipes.length).toBeLessThanOrEqual(6);
    // Whatever mode the band is in, the query that narrows it must be visible.
    expect(result.current.showSearch).toBe(true);
  });

  it("never leaves the active row past the end of a shrunken list", () => {
    for (let i = 0; i < 4; i++) recipes.push(makeRecipe({ id: `r${i}`, name: `Recipe ${i}` }));
    const { result, rerender } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/repo" })
    );
    act(() => result.current.setFocusedIndex(4));
    recipeStoreState.recipes = recipes.slice(3);
    rerender();
    expect(result.current.focusedIndex).toBeLessThan(result.current.totalItems);
  });
});

describe("useRecipeRunner — create (#16906)", () => {
  it("asks for a project draft without a worktree when the folder has none", () => {
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: null, defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleCreate();
    });

    // A null id fails the action's optional-string argument, so nothing opens.
    expect(dispatchMock).toHaveBeenCalledWith("recipe.editor.open", {}, { source: "user" });
  });

  it("scopes the draft to the active worktree when there is one", () => {
    const { result } = renderHook(() =>
      useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" })
    );

    act(() => {
      result.current.handleCreate();
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "recipe.editor.open",
      { worktreeId: "wt-1" },
      { source: "user" }
    );
  });
});

describe("useRecipeRunner — duplicating a recipe (#17200)", () => {
  const renderRunner = () =>
    renderHook(() => useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" }));

  it("copies the row it was asked about, not the team recipe that shadows it", () => {
    recipes.push(
      makeRecipe({
        id: "local-1",
        name: "Shared",
        projectId: "proj",
        shadowedBy: "Shared",
        terminals: [{ type: "terminal", command: "local-only", env: {} }],
      }),
      makeRecipe({
        id: "inrepo-shared",
        name: "Shared",
        scope: "inrepo",
        terminals: [{ type: "terminal", command: "team-only", env: {} }],
      })
    );
    const { result } = renderRunner();

    act(() => {
      result.current.handleDuplicate("local-1");
    });

    expect(duplicateRecipeMock).toHaveBeenCalledExactlyOnceWith("local-1");
  });

  it("does nothing for a recipe that is no longer listed", () => {
    const { result } = renderRunner();

    act(() => {
      result.current.handleDuplicate("gone");
    });

    expect(duplicateRecipeMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("refuses a recipe that needs its plugin without asking the store to copy it", () => {
    recipes.push(
      makeRecipe({
        id: "plug-1",
        name: "Plugin recipe",
        terminals: [{ type: "terminal", env: {}, systemPrompt: "be terse" }],
      })
    );
    const { result } = renderRunner();

    act(() => {
      result.current.handleDuplicate("plug-1");
    });

    expect(duplicateRecipeMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "warning", title: "Can't duplicate recipe" })
    );
  });

  it("surfaces a failed copy with one Retry that tries the same recipe again", async () => {
    recipes.push(makeRecipe({ id: "team-1", name: "Team", scope: "inrepo" }));
    duplicateRecipeMock.mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderRunner();

    act(() => {
      result.current.handleDuplicate("team-1");
    });
    await flush();

    expect(logErrorMock).toHaveBeenCalledWith("Failed to duplicate recipe", expect.any(Error));
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const toast = notifyMock.mock.calls[0]![0];
    expect(toast.type).toBe("error");
    expect(toast.title).toBe("Couldn't duplicate recipe");
    expect(toast.message).toContain("disk full");
    // Passive uiFeedback resolves to inbox-only, which would drop the Retry.
    expect(toast.priority).toBe("high");
    expect(toast.action?.label).toBe("Retry");

    act(() => {
      toast.action?.onClick();
    });
    await flush();

    expect(duplicateRecipeMock).toHaveBeenCalledTimes(2);
    expect(duplicateRecipeMock).toHaveBeenLastCalledWith("team-1");
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});

describe("useRecipeRunner — pin and unpin", () => {
  const renderRunner = () =>
    renderHook(() => useRecipeRunner({ activeWorktreeId: "wt-1", defaultCwd: "/tmp" }));

  it.each([
    ["handlePin", true],
    ["handleUnpin", false],
  ] as const)("%s saves the preference without a toast on success", async (method, pinned) => {
    recipes.push(makeRecipe({ id: "r1", name: "Build" }));
    const { result } = renderRunner();

    act(() => {
      result.current[method]("r1");
    });
    await flush();

    expect(updateRecipeMock).toHaveBeenCalledExactlyOnceWith("r1", { showInEmptyState: pinned });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it.each([
    ["handlePin", true],
    ["handleUnpin", false],
  ] as const)(
    "%s surfaces a failed save naming the recipe, with one Retry for the same change",
    async (method, pinned) => {
      recipes.push(makeRecipe({ id: "r1", name: "Build" }));
      updateRecipeMock.mockRejectedValueOnce(new Error("disk full"));
      const { result } = renderRunner();

      act(() => {
        result.current[method]("r1");
      });
      await flush();

      expect(logErrorMock).toHaveBeenCalledWith("Failed to update recipe pin", expect.any(Error));
      expect(notifyMock).toHaveBeenCalledTimes(1);
      const toast = notifyMock.mock.calls[0]![0];
      expect(toast.type).toBe("error");
      expect(toast.title).toBe("Couldn't update recipe pin");
      expect(toast.message).toContain("Build");
      expect(toast.message).toContain("disk full");
      expect(toast.priority).toBe("high");
      expect(toast.action?.label).toBe("Retry");

      act(() => {
        toast.action?.onClick();
      });
      await flush();

      expect(updateRecipeMock).toHaveBeenCalledTimes(2);
      expect(updateRecipeMock).toHaveBeenLastCalledWith("r1", { showInEmptyState: pinned });
      expect(notifyMock).toHaveBeenCalledTimes(1);
    }
  );

  it("offers another Retry when the retried save fails too", async () => {
    recipes.push(makeRecipe({ id: "r1", name: "Build" }));
    updateRecipeMock.mockRejectedValue(new Error("disk full"));
    const { result } = renderRunner();

    act(() => {
      result.current.handlePin("r1");
    });
    await flush();
    act(() => {
      notifyMock.mock.calls[0]![0].action?.onClick();
    });
    await flush();

    expect(updateRecipeMock).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock.mock.calls[1]![0].action?.label).toBe("Retry");
  });
});
