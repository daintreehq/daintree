/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@shared/types/forge";
import type {
  BulkWorktreeRunCommand,
  BulkWorktreeRunSnapshot,
} from "@shared/types/ipc/bulkWorktreeRuns";

const mockWorktreeCreate = vi.fn();
const mockGetAvailableBranch = vi.fn(async (_root: string, branch: string) => branch);
const mockGetDefaultPath = vi.fn(async (_root: string, branch: string) => `/worktrees/${branch}`);
const mockRunRecipe = vi.fn();
const mockAssignIssue = vi.fn();
const mockGetCurrentUser = vi.fn();
const recipesById: Record<string, unknown> = {};
const mockNotify = vi.fn();

vi.mock("@/clients", () => ({
  worktreeClient: {
    create: (...args: unknown[]) => mockWorktreeCreate(...args),
    getAvailableBranch: (root: string, branch: string) => mockGetAvailableBranch(root, branch),
    getDefaultPath: (root: string, branch: string) => mockGetDefaultPath(root, branch),
    listBranches: vi.fn(async () => []),
  },
  forgeClient: {
    assignIssue: (...args: unknown[]) => mockAssignIssue(...args),
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
  },
  agentSettingsClient: { get: vi.fn() },
  systemClient: { getTmpDir: vi.fn() },
}));
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => mockNotify(...args) }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));
vi.mock("@/utils/linkProviderIssue", () => ({ linkProviderIssue: vi.fn() }));
vi.mock("@/lib/forgeResourceCache", () => ({ patchIssueAssigneeCache: vi.fn() }));
vi.mock("@/components/Worktree/hooks/useRecipePicker", () => ({
  CLONE_LAYOUT_ID: "__clone_layout__",
}));
vi.mock("@/components/Worktree/panelSpawning", () => ({ spawnPanelsFromRecipe: vi.fn() }));
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: {
    getState: () => ({
      runRecipeWithResults: mockRunRecipe,
      getRecipeById: (id: string) => recipesById[id] ?? null,
    }),
  },
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({ setPendingWorktree: vi.fn(), selectWorktree: vi.fn() }),
  },
}));
const panelsById: Record<string, unknown> = {};
const mockTrashPanel = vi.fn();
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({ panelsById, trashPanel: mockTrashPanel }),
    subscribe: () => () => {},
  },
}));

import {
  _resetBulkCreateRunsForTests,
  cancelBulkCreateRun,
  dismissBulkCreateRun,
  findBulkCreateRunToShow,
  retryFailedBulkCreateRun,
  startBulkCreateRun,
  useBulkCreateRunStore,
  type BulkCreateRunInput,
} from "../components/bulkCreateRunner";
import type { PlannedWorktree } from "../components/bulkCreateUtils";
import { BULK_RUN_HEARTBEAT_MS } from "@shared/types/ipc/bulkWorktreeRuns";
import { recipeApprovalDigest } from "@/utils/recipeApprovalDigest";
import type { RecipeTerminal } from "@shared/types";

const issue = (n: number): Issue =>
  ({ number: n, title: `Issue ${n}`, state: "open", assignees: [] }) as unknown as Issue;

const planned = (n: number): PlannedWorktree => ({
  item: issue(n),
  mode: "issue",
  branchName: `feature/issue-${n}`,
  skipped: false,
});

function input(numbers: number[], overrides: Partial<BulkCreateRunInput> = {}): BulkCreateRunInput {
  return {
    projectId: "proj-a",
    rootPath: "/repo",
    mode: "issue",
    plan: numbers.map(planned),
    recipeId: null,
    recipe: undefined,
    assignToSelf: false,
    getViewer: () => null,
    base: { name: "main", fromRemote: false },
    cloneTerminals: null,
    ...overrides,
  };
}

/** Holds every create open until the test lands it. */
function deferCreates() {
  const pending = new Map<string, (branch: string) => void>();
  mockWorktreeCreate.mockImplementation(
    (options: { newBranch: string }) =>
      new Promise((resolve) => {
        pending.set(options.newBranch, (id: string) =>
          resolve({ worktreeId: id, branch: options.newBranch, setupState: "pending" })
        );
      })
  );
  return {
    land: (n: number) => pending.get(`feature/issue-${n}`)?.(`wt-${n}`),
    started: () => [...pending.keys()],
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const runOf = (runId: string) => useBulkCreateRunStore.getState().runs[runId]!;

/** The bridge main gives each view, with what it published and its command listener. */
function installBridge() {
  const published: BulkWorktreeRunSnapshot[] = [];
  let onCommand: ((command: BulkWorktreeRunCommand) => void) | null = null;
  const dismissed: string[] = [];
  (window as unknown as { electron: unknown }).electron = {
    bulkWorktreeRuns: {
      publish: vi.fn(async (snapshot: BulkWorktreeRunSnapshot) => {
        published.push(snapshot);
      }),
      dismiss: vi.fn(async (runId: string) => {
        dismissed.push(runId);
        return true;
      }),
      onCommand: (callback: (command: BulkWorktreeRunCommand) => void) => {
        onCommand = callback;
        return () => {
          onCommand = null;
        };
      },
    },
  };
  return {
    published,
    dismissed,
    send: (command: BulkWorktreeRunCommand) => onCommand?.(command),
    lastFor: (runId: string) => published.filter((s) => s.runId === runId).at(-1),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunRecipe.mockReset();
  mockWorktreeCreate.mockReset();
  _resetBulkCreateRunsForTests();
  for (const key of Object.keys(panelsById)) delete panelsById[key];
  for (const key of Object.keys(recipesById)) delete recipesById[key];
});

afterEach(() => {
  _resetBulkCreateRunsForTests();
  delete (window as unknown as { electron?: unknown }).electron;
});

describe("bulk create runner", () => {
  it("runs to the end with no dialog, and its state is readable from outside one", async () => {
    const bridge = installBridge();
    const creates = deferCreates();

    const { runId, done } = startBulkCreateRun(input([1, 2]));
    await flush();
    expect(runOf(runId).progress.phase).toBe("executing");
    expect(bridge.lastFor(runId)).toMatchObject({ phase: "running", projectId: "proj-a" });

    creates.land(1);
    creates.land(2);
    await done;
    await flush();

    expect(runOf(runId).progress.phase).toBe("done");
    const published = bridge.lastFor(runId)!;
    expect(published.phase).toBe("done");
    expect(published.items.map((i) => [i.number, i.stage, i.worktreeId, i.branch])).toEqual([
      [1, "succeeded", "wt-1", "feature/issue-1"],
      [2, "succeeded", "wt-2", "feature/issue-2"],
    ]);
    expect(findBulkCreateRunToShow("proj-a")?.id).toBe(runId);
    expect(findBulkCreateRunToShow("proj-b")).toBeUndefined();
  });

  it("tracks two runs at once, and cancelling one leaves the other going", async () => {
    installBridge();
    const creates = deferCreates();

    const a = startBulkCreateRun(input([1, 2]));
    const b = startBulkCreateRun(input([3, 4]));
    expect(a.runId).not.toBe(b.runId);
    await flush();

    expect(cancelBulkCreateRun(a.runId)).toBe(true);
    expect(runOf(a.runId).progress.phase).toBe("cancelling");
    expect(runOf(b.runId).progress.phase).toBe("executing");

    for (const n of [1, 2, 3, 4]) creates.land(n);
    await Promise.all([a.done, b.done]);

    expect(runOf(a.runId).progress.phase).toBe("cancelled");
    expect(runOf(b.runId).progress.phase).toBe("done");
    expect([...runOf(b.runId).progress.items.values()].map((i) => i.stage)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    // The cancelled run's creates were already underway, so they are reported as made.
    expect([...runOf(a.runId).progress.items.values()].map((i) => i.worktreeId)).toEqual([
      "wt-1",
      "wt-2",
    ]);
  });

  it("stops queued items on cancel and reports the in-flight ones once they settle", async () => {
    installBridge();
    const creates = deferCreates();

    const { runId, done } = startBulkCreateRun(input([1, 2, 3, 4]));
    await flush();
    // Three run at once; the fourth waits.
    expect(creates.started()).toHaveLength(3);

    cancelBulkCreateRun(runId);
    creates.land(1);
    await flush();
    expect(runOf(runId).progress.phase).toBe("cancelling");
    expect(mockNotify).not.toHaveBeenCalled();

    creates.land(2);
    creates.land(3);
    await done;

    const items = runOf(runId).progress.items;
    expect(creates.started()).toHaveLength(3);
    expect(runOf(runId).progress.phase).toBe("cancelled");
    expect([1, 2, 3, 4].map((n) => [items.get(n)?.stage, items.get(n)?.worktreeId])).toEqual([
      ["cancelled", "wt-1"],
      ["cancelled", "wt-2"],
      ["cancelled", "wt-3"],
      ["cancelled", undefined],
    ]);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ message: "3 of 4 worktrees created." })
    );
    expect(cancelBulkCreateRun(runId)).toBe(false);
  });

  it("takes cancel and retry from another view through main", async () => {
    const bridge = installBridge();
    mockRunRecipe.mockResolvedValueOnce({
      spawned: [],
      failed: [{ index: 0, error: "spawn refused" }],
    });
    mockRunRecipe.mockResolvedValue({ spawned: [{ index: 0, terminalId: "t-1" }], failed: [] });
    mockWorktreeCreate.mockImplementation(async (options: { newBranch: string }) => ({
      worktreeId: `wt-${options.newBranch}`,
      branch: options.newBranch,
      setupState: "pending",
    }));
    vi.useFakeTimers();
    try {
      const { runId, done } = startBulkCreateRun(
        input([1], { recipeId: "recipe", recipe: { id: "recipe", terminals: [{}] } as never })
      );
      await vi.runAllTimersAsync();
      await done;
      expect(runOf(runId).progress.items.get(1)?.stage).toBe("failed");
      expect(bridge.lastFor(runId)?.items[0]?.stage).toBe("failed");

      bridge.send({ runId, kind: "retry-failed" });
      await vi.runAllTimersAsync();

      expect(runOf(runId).progress.phase).toBe("done");
      expect(runOf(runId).progress.items.get(1)?.stage).toBe("succeeded");
      // The retry reused the worktree the first attempt made.
      expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);
      expect(mockRunRecipe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }

    const creates = deferCreates();
    const second = startBulkCreateRun(input([5]));
    await flush();
    bridge.send({ runId: second.runId, kind: "cancel" });
    creates.land(5);
    await second.done;
    expect(runOf(second.runId).progress.phase).toBe("cancelled");
  });

  it("retries a partial failure without recreating the worktrees that landed", async () => {
    installBridge();
    let fail = true;
    mockWorktreeCreate.mockImplementation(async (options: { newBranch: string }) => {
      if (options.newBranch === "feature/issue-2" && fail) throw new Error("disk full");
      return { worktreeId: `wt-${options.newBranch}`, branch: options.newBranch };
    });

    const { runId, done } = startBulkCreateRun(input([1, 2]));
    await done;
    const items = runOf(runId).progress.items;
    expect(items.get(1)?.stage).toBe("succeeded");
    expect(items.get(2)).toMatchObject({ stage: "failed", error: "disk full" });

    fail = false;
    await retryFailedBulkCreateRun(runId);

    expect(runOf(runId).progress.items.get(2)?.stage).toBe("succeeded");
    expect(
      mockWorktreeCreate.mock.calls.map(([o]) => (o as { newBranch: string }).newBranch)
    ).toEqual(["feature/issue-1", "feature/issue-2", "feature/issue-2"]);
    expect(retryFailedBulkCreateRun(runId)).toBeNull();
  });

  it("keeps a live run through dismissal and drops an ended one here and in main", async () => {
    const bridge = installBridge();
    const creates = deferCreates();
    const { runId, done } = startBulkCreateRun(input([1]));
    await flush();

    expect(dismissBulkCreateRun(runId)).toBe(false);
    creates.land(1);
    await done;

    expect(dismissBulkCreateRun(runId)).toBe(true);
    expect(useBulkCreateRunStore.getState().runs[runId]).toBeUndefined();
    expect(bridge.dismissed).toEqual([runId]);
  });

  it("retries the failures of a cancelled run, leaving what the cancel stopped", async () => {
    const bridge = installBridge();
    const pending = new Map<
      string,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    mockWorktreeCreate.mockImplementation(
      (options: { newBranch: string }) =>
        new Promise((resolve, reject) => pending.set(options.newBranch, { resolve, reject }))
    );

    const { runId, done } = startBulkCreateRun(input([1, 2, 3, 4]));
    await flush();
    pending.get("feature/issue-1")!.reject(new Error("disk full"));
    await flush();
    cancelBulkCreateRun(runId);
    pending.get("feature/issue-2")!.resolve({ worktreeId: "wt-2", branch: "feature/issue-2" });
    pending.get("feature/issue-3")!.resolve({ worktreeId: "wt-3", branch: "feature/issue-3" });
    // Item 1's failure freed a slot, so item 4 had started too.
    pending.get("feature/issue-4")!.resolve({ worktreeId: "wt-4", branch: "feature/issue-4" });
    await done;
    expect(runOf(runId).progress.phase).toBe("cancelled");
    expect(runOf(runId).progress.items.get(1)?.stage).toBe("failed");

    mockWorktreeCreate.mockImplementation(async (options: { newBranch: string }) => ({
      worktreeId: `wt-${options.newBranch}`,
      branch: options.newBranch,
    }));
    bridge.send({ runId, kind: "retry-failed" });
    await vi.waitFor(() => expect(runOf(runId).progress.phase).toBe("done"));

    const stages = [1, 2, 3, 4].map((n) => runOf(runId).progress.items.get(n)?.stage);
    expect(stages).toEqual(["succeeded", "cancelled", "cancelled", "cancelled"]);
    // Only the failed item went again.
    expect(mockWorktreeCreate).toHaveBeenCalledTimes(5);
    expect(mockWorktreeCreate.mock.calls.at(-1)?.[0]).toMatchObject({
      newBranch: "feature/issue-1",
    });
  });

  it("republishes a run whose command it turned down, so main lets the view go", async () => {
    const bridge = installBridge();
    mockWorktreeCreate.mockImplementation(async (options: { newBranch: string }) => ({
      worktreeId: `wt-${options.newBranch}`,
      branch: options.newBranch,
    }));
    const { runId, done } = startBulkCreateRun(input([1]));
    await done;
    await flush();
    const before = bridge.published.length;

    bridge.send({ runId, kind: "retry-failed" });
    await flush();

    expect(bridge.published.length).toBe(before + 1);
    expect(bridge.lastFor(runId)?.phase).toBe("done");
  });

  it("keeps republishing a live run through a long step, and stops once it ends", async () => {
    vi.useFakeTimers();
    try {
      const bridge = installBridge();
      const creates = deferCreates();
      const timersBefore = vi.getTimerCount();
      const { runId, done } = startBulkCreateRun(input([1]));
      await vi.advanceTimersByTimeAsync(0);
      const before = bridge.published.length;

      await vi.advanceTimersByTimeAsync(BULK_RUN_HEARTBEAT_MS * 3);
      expect(bridge.published.length).toBe(before + 3);
      expect(bridge.lastFor(runId)?.phase).toBe("running");

      creates.land(1);
      await vi.advanceTimersByTimeAsync(0);
      await done;
      await vi.advanceTimersByTimeAsync(0);
      const afterEnd = bridge.published.length;
      await vi.advanceTimersByTimeAsync(BULK_RUN_HEARTBEAT_MS * 3);
      expect(bridge.published.length).toBe(afterEnd);
      // The heartbeat itself is gone, not just idle.
      expect(vi.getTimerCount()).toBe(timersBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips assignment without looking again when the dialog's lookup found no account", async () => {
    installBridge();
    mockGetCurrentUser.mockResolvedValue({ login: "octocat" });
    mockWorktreeCreate.mockImplementation(async (options: { newBranch: string }) => ({
      worktreeId: `wt-${options.newBranch}`,
      branch: options.newBranch,
    }));

    const { runId, done } = startBulkCreateRun(
      input([1], { assignToSelf: true, getViewer: () => null })
    );
    await done;

    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(mockAssignIssue).not.toHaveBeenCalled();
    expect(runOf(runId).progress.items.get(1)?.stage).toBe("succeeded");
  });

  it("looks up who to assign to itself when the dialog closed before its lookup landed", async () => {
    installBridge();
    mockGetCurrentUser.mockResolvedValue({ login: "octocat", avatarUrl: "a.png" });
    mockAssignIssue.mockResolvedValue(undefined);
    mockWorktreeCreate.mockImplementation(async (options: { newBranch: string }) => ({
      worktreeId: `wt-${options.newBranch}`,
      branch: options.newBranch,
    }));

    const { runId, done } = startBulkCreateRun(
      input([1, 2], { assignToSelf: true, getViewer: () => undefined })
    );
    await done;

    expect(mockGetCurrentUser).toHaveBeenCalledTimes(1);
    expect(mockAssignIssue.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [1, "octocat"],
      [2, "octocat"],
    ]);
    expect(runOf(runId).progress.items.get(2)?.stage).toBe("succeeded");
  });

  it("pins each item to the recipe its first launch ran, and relaunches only against that", async () => {
    installBridge();
    const first = { id: "recipe", terminals: [{ type: "terminal" }, { type: "claude" }] };
    const edited = { id: "recipe", terminals: [{ type: "claude" }, { type: "terminal" }] };
    recipesById.recipe = first;
    const creates = deferCreates();
    mockRunRecipe.mockResolvedValueOnce({
      spawned: [{ index: 0, terminalId: "t-0" }],
      failed: [{ index: 1, error: "spawn refused" }],
    });
    mockRunRecipe.mockResolvedValue({ spawned: [{ index: 1, terminalId: "t-1" }], failed: [] });

    const { runId, done } = startBulkCreateRun(
      input([1], { recipeId: "recipe", recipe: first as never })
    );
    await flush();
    // Edited while the worktree is still being made: the item runs the edit.
    recipesById.recipe = edited;
    creates.land(1);
    await done;

    const digestOf = (recipe: { terminals: unknown[] }) => ({
      id: "recipe",
      terminalsDigest: recipeApprovalDigest(recipe.terminals as RecipeTerminal[]),
    });
    expect(mockRunRecipe.mock.calls[0]?.[4]).toMatchObject({ expectedRecipe: digestOf(edited) });

    // A later edit doesn't move the pin: the retry still asks for what ran.
    recipesById.recipe = first;
    await retryFailedBulkCreateRun(runId);
    expect(mockRunRecipe.mock.calls[1]?.[4]).toMatchObject({
      terminalIndices: [1],
      expectedRecipe: digestOf(edited),
    });
  });
});
