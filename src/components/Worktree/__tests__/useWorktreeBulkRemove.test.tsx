// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import PQueue from "p-queue";

const worktreeClientMock = vi.hoisted(() => ({
  delete: vi.fn(),
  getFreshChanges: vi.fn(),
  getSubmoduleDeleteRisk: vi.fn(),
}));
const notifyMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const devPreviewGetByWorktreeMock = vi.hoisted(() => vi.fn());
const devPreviewStopByWorktreeMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients/worktreeClient", () => ({ worktreeClient: worktreeClientMock }));
// `worktreeDeletePreview` imports the barrel, not the module. Both specifiers
// have to resolve to the same double or the real preview builder would reach
// the real client through one of them. Deliberately NOT mocking the preview
// module itself: its fail-closed rules ARE what the bulk surface is adopting,
// so the tests exercise them rather than a re-spelling of them.
vi.mock("@/clients", () => ({ worktreeClient: worktreeClientMock }));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/utils/logger", () => ({ logError: logErrorMock }));

(globalThis as Record<string, unknown>).window = globalThis.window ?? {};
(window as unknown as Record<string, unknown>).electron = {
  ...((window as unknown as Record<string, unknown>).electron ?? {}),
  devPreview: {
    getByWorktree: devPreviewGetByWorktreeMock,
    stopByWorktree: devPreviewStopByWorktreeMock,
  },
};

import {
  useWorktreeBulkRemove,
  isBulkRemoveEligible,
  bulkRemoveEvidenceKey,
  bulkRemoveExclusion,
  describeBulkRemoveRisks,
  type BulkRemoveTarget,
  type BulkRemoveTargetStatus,
} from "../useWorktreeBulkRemove";
import type { WorktreeDeletePreview } from "../worktreeDeletePreview";
import type { WorktreeState } from "@/types";
import type { FileChangeDetail, WorktreeChanges } from "@shared/types/git";
import type { SubmoduleDeleteRisk } from "@shared/types/submodule";

function wt(id: string, overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    id,
    name: overrides.name ?? id,
    path: overrides.path ?? `/repo/${id}`,
    branch: overrides.branch ?? `branch-${id}`,
    worktreeChanges: overrides.worktreeChanges ?? null,
    lastActivityTimestamp: null,
    ...overrides,
  } as WorktreeState;
}

function change(path: string, status: FileChangeDetail["status"]): FileChangeDetail {
  return { path, status, insertions: null, deletions: null };
}

function fresh(id: string, changes: FileChangeDetail[] = []): WorktreeChanges {
  return {
    worktreeId: id,
    rootPath: `/repo/${id}`,
    changes,
    changedFileCount: changes.length,
  };
}

function risk(over: Partial<SubmoduleDeleteRisk> = {}): SubmoduleDeleteRisk {
  return {
    entries: [],
    dirtyFiles: [],
    untrackedFiles: [],
    atRiskCommits: [],
    requiresMechanicalForce: false,
    incomplete: false,
    ...over,
  };
}

function setup(selectedIds: string[], worktrees: WorktreeState[]) {
  const worktreeMap = new Map(worktrees.map((w) => [w.id, w] as const));
  const clearSelection = vi.fn();
  const hook = renderHook(() =>
    useWorktreeBulkRemove({
      selectedIds: new Set(selectedIds),
      worktreeMap,
      clearSelection,
    })
  );
  return { hook, clearSelection };
}

/**
 * Drain the preview chain. Each target costs several awaits (queue task →
 * parent fetch → settled submodule arm → the `allSettled` that clears
 * `isPreviewPending`), so one tick is not enough.
 */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

/** Open the confirm and let every queued preview settle. */
async function openAndSettle(hook: ReturnType<typeof setup>["hook"]) {
  act(() => hook.result.current.handleRemoveClick());
  await flush();
}

/**
 * Hold every `getFreshChanges` call open so a test can settle a SPECIFIC
 * generation's request by hand.
 *
 * Generation isolation is only observable when two generations are in flight
 * at once, so `resolve(id, value, nth)` picks which of that worktree's calls to
 * answer — `nth: 0` being the abandoned one.
 */
function deferFreshChanges() {
  const pending = new Map<string, Array<(value: WorktreeChanges | null) => void>>();
  worktreeClientMock.getFreshChanges.mockImplementation(
    (id: string) =>
      new Promise<WorktreeChanges | null>((resolve) => {
        const queue = pending.get(id) ?? [];
        queue.push(resolve);
        pending.set(id, queue);
      })
  );
  return {
    resolve(id: string, value: WorktreeChanges | null, nth = 0) {
      const queue = pending.get(id);
      const settle = queue?.[nth];
      if (!settle) throw new Error(`no pending getFreshChanges(${id}) at index ${nth}`);
      settle(value);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  devPreviewGetByWorktreeMock.mockResolvedValue(null);
  devPreviewStopByWorktreeMock.mockResolvedValue(undefined);
  // Default: every target previews clean and verified. A `null` submodule risk
  // would read as `unverified` and block every target, so the clean default has
  // to be a completed inventory.
  worktreeClientMock.getFreshChanges.mockImplementation((id: string) => Promise.resolve(fresh(id)));
  worktreeClientMock.getSubmoduleDeleteRisk.mockResolvedValue(risk());
});

describe("useWorktreeBulkRemove — confirm derivation", () => {
  it("snapshots non-main targets when Remove is clicked", async () => {
    const { hook } = setup(
      ["a", "b"],
      [wt("a", { branch: "feature/a" }), wt("b", { branch: "feature/b" })]
    );

    await openAndSettle(hook);

    expect(hook.result.current.isConfirmOpen).toBe(true);
    expect(hook.result.current.targets.map((t) => t.id)).toEqual(["a", "b"]);
    expect(hook.result.current.typedNameTarget).toBe("2 worktrees");
  });

  it("excludes main worktree from the target list and surfaces the excluded count", async () => {
    const { hook } = setup(
      ["main", "feature"],
      [wt("main", { isMainWorktree: true }), wt("feature")]
    );

    await openAndSettle(hook);

    expect(hook.result.current.targets.map((t) => t.id)).toEqual(["feature"]);
    expect(hook.result.current.excludedMainCount).toBe(1);
    // Named, so the confirm can say which selection it dropped.
    expect(hook.result.current.excludedMainNames).toEqual(["branch-main"]);
    expect(hook.result.current.typedNameTarget).toBe("1 worktree");
  });

  it("does not open the dialog when every selection is the main worktree", () => {
    const { hook, clearSelection } = setup(["main"], [wt("main", { isMainWorktree: true })]);

    act(() => hook.result.current.handleRemoveClick());

    expect(hook.result.current.isConfirmOpen).toBe(false);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Nothing to delete",
        context: expect.objectContaining({ worktreeId: "main" }),
      })
    );
    expect(clearSelection).toHaveBeenCalled();
  });

  it("opens instantly with every target pending, then settles (#12416)", async () => {
    const { hook } = setup(["a"], [wt("a")]);

    act(() => hook.result.current.handleRemoveClick());
    // The dialog is up before a single port request has returned — the chrome
    // and the identities are known without them.
    expect(hook.result.current.isConfirmOpen).toBe(true);
    expect(hook.result.current.isPreviewPending).toBe(true);
    expect(hook.result.current.targets[0]!.status.state).toBe("pending");
    // Nothing may be confirmed against a skeleton.
    expect(hook.result.current.canConfirm).toBe(false);

    await flush();
    expect(hook.result.current.isPreviewPending).toBe(false);
    expect(hook.result.current.canConfirm).toBe(true);
  });

  it("builds risk counts from a FRESH fetch, not the store snapshot (#12416)", async () => {
    // The whole bug: the store says this worktree is clean, because its poll
    // has not run since the agent wrote into it. The confirmation must show
    // what git says now.
    const { hook } = setup(
      ["a"],
      [
        wt("a", {
          worktreeChanges: {
            changes: [],
            changedFileCount: 0,
          } as unknown as WorktreeState["worktreeChanges"],
        }),
      ]
    );
    worktreeClientMock.getFreshChanges.mockResolvedValue(
      fresh("a", [
        change("/repo/a/src/agent.ts", "modified"),
        change("/repo/a/notes.md", "untracked"),
      ])
    );

    await openAndSettle(hook);

    const status = hook.result.current.targets[0]!.status;
    expect(status.state).toBe("verified");
    if (status.state !== "verified") return;
    expect(status.preview.trackedChangeCount).toBe(1);
    expect(status.preview.untrackedFileCount).toBe(1);
    expect(worktreeClientMock.getFreshChanges).toHaveBeenCalledWith("a");
    expect(worktreeClientMock.getSubmoduleDeleteRisk).toHaveBeenCalledWith("a");
  });

  it("carries the submodule inventory the parent status cannot express (#12416)", async () => {
    worktreeClientMock.getSubmoduleDeleteRisk.mockResolvedValue(
      risk({ dirtyFiles: ["vendor/lib/src/main.c"], untrackedFiles: ["vendor/lib/build.o"] })
    );
    const { hook } = setup(["a"], [wt("a")]);

    await openAndSettle(hook);

    const status = hook.result.current.targets[0]!.status;
    expect(status.state).toBe("verified");
    if (status.state !== "verified") return;
    expect(status.preview.submodules).toEqual({
      status: "verified",
      risk: expect.objectContaining({ dirtyFiles: ["vendor/lib/src/main.c"] }),
    });
    expect(isBulkRemoveEligible(hook.result.current.targets[0]!)).toBe(true);
  });
});

describe("useWorktreeBulkRemove — fail-closed exclusions", () => {
  it("excludes a target whose fresh fetch failed and never deletes it", async () => {
    worktreeClientMock.getFreshChanges.mockImplementation((id: string) =>
      id === "b" ? Promise.reject(new Error("host timed out")) : Promise.resolve(fresh(id))
    );
    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);

    await openAndSettle(hook);

    expect(hook.result.current.targets[1]!.status.state).toBe("failed");
    expect(hook.result.current.eligibleCount).toBe(1);
    expect(hook.result.current.hasRetryablePreviews).toBe(true);
    expect(hook.result.current.typedNameTarget).toBe("1 worktree");

    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    // The unverifiable target never reaches the host — falling back to the
    // cached snapshot is the exact bug being fixed.
    expect(worktreeClientMock.delete).toHaveBeenCalledTimes(1);
    expect(worktreeClientMock.delete).toHaveBeenCalledWith("a", {
      force: true,
      deleteBranch: false,
    });
  });

  it("excludes an already-removed worktree without calling delete", async () => {
    worktreeClientMock.getFreshChanges.mockImplementation((id: string) =>
      id === "b" ? Promise.resolve(null) : Promise.resolve(fresh(id))
    );
    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);

    await openAndSettle(hook);
    expect(hook.result.current.targets[1]!.status.state).toBe("gone");
    expect(hook.result.current.eligibleCount).toBe(1);

    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    expect(worktreeClientMock.delete).toHaveBeenCalledTimes(1);
    expect(worktreeClientMock.delete).toHaveBeenCalledWith("a", {
      force: true,
      deleteBranch: false,
    });
  });

  it("excludes a target the host would refuse for at-risk submodule commits", async () => {
    // `guardSubmoduleDelete` throws on these before it reads `force`, so
    // sending one spends the typed-count consent on a guaranteed toast.
    worktreeClientMock.getSubmoduleDeleteRisk.mockImplementation((id: string) =>
      Promise.resolve(
        id === "b"
          ? risk({ atRiskCommits: [{ oid: "abc1234def", subject: "wip: vendored fix" }] })
          : risk()
      )
    );
    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);

    await openAndSettle(hook);
    expect(hook.result.current.eligibleCount).toBe(1);

    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    expect(worktreeClientMock.delete).toHaveBeenCalledTimes(1);
    expect(worktreeClientMock.delete).toHaveBeenCalledWith("a", {
      force: true,
      deleteBranch: false,
    });
  });

  it("excludes a target whose submodule inventory came back incomplete", async () => {
    worktreeClientMock.getSubmoduleDeleteRisk.mockResolvedValue(risk({ incomplete: true }));
    const { hook } = setup(["a"], [wt("a")]);

    await openAndSettle(hook);

    expect(hook.result.current.eligibleCount).toBe(0);
    expect(hook.result.current.canConfirm).toBe(false);
  });

  it("closes without deleting anything when every target was excluded", async () => {
    worktreeClientMock.getFreshChanges.mockRejectedValue(new Error("host down"));
    const { hook, clearSelection } = setup(["a", "b"], [wt("a"), wt("b")]);

    await openAndSettle(hook);
    expect(hook.result.current.canConfirm).toBe(false);

    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    expect(worktreeClientMock.delete).not.toHaveBeenCalled();
    expect(hook.result.current.isConfirmOpen).toBe(false);
    // Nothing ran, so nothing is summarised — a toast here would report a run
    // that never happened.
    expect(notifyMock).not.toHaveBeenCalled();
    expect(clearSelection).not.toHaveBeenCalled();
  });

  it("re-runs the whole frozen set on retry so one generation owns every row", async () => {
    // Two targets, only one of which failed. Retrying just the failure would
    // leave the other row's evidence a generation old, which is the staleness
    // this surface exists to remove — so both must be re-fetched.
    // An explicit flag, not a call count — `mockClear()` below resets
    // `mock.calls`, which would silently re-arm the failure for the retry.
    let failB = true;
    worktreeClientMock.getFreshChanges.mockImplementation((id: string) =>
      id === "b" && failB ? Promise.reject(new Error("host timed out")) : Promise.resolve(fresh(id))
    );
    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);

    await openAndSettle(hook);
    expect(hook.result.current.targets[1]!.status.state).toBe("failed");
    expect(hook.result.current.eligibleCount).toBe(1);

    failB = false;
    worktreeClientMock.getFreshChanges.mockClear();
    worktreeClientMock.getSubmoduleDeleteRisk.mockClear();
    act(() => hook.result.current.handleRetryPreviews());
    // Every row drops back to pending, including the one that had succeeded.
    expect(hook.result.current.targets.map((t) => t.status.state)).toEqual(["pending", "pending"]);
    await flush();

    expect(worktreeClientMock.getFreshChanges.mock.calls.map((c) => c[0]).sort()).toEqual([
      "a",
      "b",
    ]);
    expect(worktreeClientMock.getSubmoduleDeleteRisk.mock.calls.map((c) => c[0]).sort()).toEqual([
      "a",
      "b",
    ]);
    expect(hook.result.current.eligibleCount).toBe(2);
  });

  it("discards a preview that lands after the dialog was cancelled", async () => {
    const gate = deferFreshChanges();
    const { hook } = setup(["a"], [wt("a")]);

    act(() => hook.result.current.handleRemoveClick());
    act(() => hook.result.current.handleCancel());

    act(() => {
      gate.resolve("a", fresh("a", [change("/repo/a/x.ts", "modified")]));
    });
    await flush();

    // The snapshot the user left must not be repopulated behind them.
    expect(hook.result.current.targets).toEqual([]);
    expect(hook.result.current.isPreviewPending).toBe(false);
  });

  it("ignores the abandoned generation when the dialog is cancelled and reopened", async () => {
    // The assertion the empty-snapshot test above cannot make: after a reopen
    // there IS a live snapshot for a stale result to corrupt. Without the
    // generation guard the first open's answer lands on the second open's row.
    const gate = deferFreshChanges();
    const { hook } = setup(["a"], [wt("a")]);

    act(() => hook.result.current.handleRemoveClick());
    act(() => hook.result.current.handleCancel());
    act(() => hook.result.current.handleRemoveClick());

    // Generation 1 answers "dirty" — late, and for a dialog the user left.
    act(() => {
      gate.resolve("a", fresh("a", [change("/repo/a/stale.ts", "modified")]), 0);
    });
    await flush();
    expect(hook.result.current.targets[0]!.status.state).toBe("pending");
    // A stale completion must not clear the CURRENT generation's pending gate.
    expect(hook.result.current.isPreviewPending).toBe(true);
    expect(hook.result.current.canConfirm).toBe(false);

    // Generation 2 answers clean, and that is the answer that counts.
    act(() => {
      gate.resolve("a", fresh("a"), 1);
    });
    await flush();
    const status = hook.result.current.targets[0]!.status;
    expect(status.state).toBe("verified");
    if (status.state !== "verified") return;
    expect(status.preview.trackedChangeCount).toBe(0);
    expect(hook.result.current.isPreviewPending).toBe(false);
  });

  it("keeps the gate closed until every target in the generation has settled", async () => {
    const gate = deferFreshChanges();
    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);

    act(() => hook.result.current.handleRemoveClick());
    act(() => {
      gate.resolve("a", fresh("a"));
    });
    await flush();

    // One of two settled — the batch is not ready and must not say it is.
    expect(hook.result.current.targets[0]!.status.state).toBe("verified");
    expect(hook.result.current.targets[1]!.status.state).toBe("pending");
    expect(hook.result.current.isPreviewPending).toBe(true);
    expect(hook.result.current.canConfirm).toBe(false);

    act(() => {
      gate.resolve("b", fresh("b"));
    });
    await flush();
    expect(hook.result.current.isPreviewPending).toBe(false);
    expect(hook.result.current.canConfirm).toBe(true);
  });

  it("reports a retry as in flight until its generation settles", async () => {
    // The dialog keeps its Retry button mounted off this flag; deriving it from
    // `hasRetryablePreviews` alone would unmount the button mid-click, because
    // a retry sends every row back to pending.
    const gate = deferFreshChanges();
    const { hook } = setup(["a"], [wt("a")]);

    act(() => hook.result.current.handleRemoveClick());
    expect(hook.result.current.isRetryingPreviews).toBe(false);
    act(() => {
      gate.resolve("a", fresh("a"));
    });
    await flush();

    act(() => hook.result.current.handleRetryPreviews());
    expect(hook.result.current.isRetryingPreviews).toBe(true);
    expect(hook.result.current.hasRetryablePreviews).toBe(false);

    act(() => {
      gate.resolve("a", fresh("a"), 1);
    });
    await flush();
    expect(hook.result.current.isRetryingPreviews).toBe(false);
  });

  it("drops an in-flight generation when Retry starts a new one mid-fetch", async () => {
    const gate = deferFreshChanges();
    const { hook } = setup(["a"], [wt("a")]);

    act(() => hook.result.current.handleRemoveClick());
    act(() => hook.result.current.handleRetryPreviews());

    // The first generation's answer arrives after the retry replaced it.
    act(() => {
      gate.resolve("a", fresh("a", [change("/repo/a/stale.ts", "modified")]), 0);
    });
    await flush();
    expect(hook.result.current.targets[0]!.status.state).toBe("pending");
    expect(hook.result.current.isPreviewPending).toBe(true);

    act(() => {
      gate.resolve("a", fresh("a"), 1);
    });
    await flush();
    expect(hook.result.current.isPreviewPending).toBe(false);
    expect(hook.result.current.eligibleCount).toBe(1);
  });

  it("stops spending port requests on a generation whose dialog unmounted", async () => {
    // Observable, not just "it didn't warn": the preview queue runs at
    // concurrency 3, so with four targets the fourth is still queued at unmount
    // and its task can check the generation BEFORE paying for two port
    // requests. Asserting `logError` was silent would have passed even with
    // every guard deleted.
    const gate = deferFreshChanges();
    const ids = ["a", "b", "c", "d"];
    const { hook } = setup(
      ids,
      ids.map((id) => wt(id))
    );

    act(() => hook.result.current.handleRemoveClick());
    await flush();
    // Three in flight, one queued behind them.
    expect(worktreeClientMock.getFreshChanges).toHaveBeenCalledTimes(3);

    hook.unmount();
    act(() => {
      gate.resolve("a", fresh("a"));
      gate.resolve("b", fresh("b"));
      gate.resolve("c", fresh("c"));
    });
    await flush();

    // The queued fourth started after a slot freed, saw its generation was
    // abandoned, and returned without calling the host.
    expect(worktreeClientMock.getFreshChanges).toHaveBeenCalledTimes(3);
    expect(worktreeClientMock.getFreshChanges.mock.calls.map((c) => c[0])).not.toContain("d");
  });
});

describe("useWorktreeBulkRemove — execution", () => {
  it("runs every eligible target through worktreeClient.delete with force=true", async () => {
    worktreeClientMock.delete.mockResolvedValue(undefined);
    const { hook, clearSelection } = setup(["a", "b"], [wt("a"), wt("b")]);

    await openAndSettle(hook);
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    expect(worktreeClientMock.delete).toHaveBeenCalledTimes(2);
    expect(worktreeClientMock.delete).toHaveBeenNthCalledWith(1, "a", {
      force: true,
      deleteBranch: false,
    });
    expect(worktreeClientMock.delete).toHaveBeenNthCalledWith(2, "b", {
      force: true,
      deleteBranch: false,
    });
    expect(clearSelection).toHaveBeenCalled();
    expect(hook.result.current.isConfirmOpen).toBe(false);
  });

  it("emits a past-tense success toast on all-success — no 'successfully' adverb (microcopy rule)", async () => {
    worktreeClientMock.delete.mockResolvedValue(undefined);
    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);

    await openAndSettle(hook);
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    const successCall = notifyMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "success"
    );
    expect(successCall).toBeDefined();
    const payload = successCall![0] as { title: string };
    expect(payload.title).toBe("Deleted 2 worktrees");
    expect(payload.title).not.toMatch(/successfully/i);
  });

  it("emits a warning toast on partial failure with the success/total ratio in the title", async () => {
    worktreeClientMock.delete
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Filesystem busy"));
    const { hook, clearSelection } = setup(
      ["a", "b"],
      [wt("a", { branch: "feature/a" }), wt("b", { branch: "feature/b" })]
    );

    await openAndSettle(hook);
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    const warning = notifyMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "warning"
    );
    expect(warning).toBeDefined();
    const payload = warning![0] as {
      title: string;
      message: string;
      context?: { worktreeId?: string };
    };
    expect(payload.title).toBe("Deleted 1 of 2 worktrees");
    // Spans two worktrees, so it files under neither.
    expect(payload.context?.worktreeId).toBeUndefined();
    expect(payload.message).toContain("feature/b");
    // Selection is cleared regardless of partial failure — selection is
    // not a retry surface (the modal itself is).
    expect(clearSelection).toHaveBeenCalled();
  });

  it("emits an error toast on total failure", async () => {
    worktreeClientMock.delete.mockRejectedValue(new Error("Disk read-only"));
    const { hook } = setup(["a"], [wt("a")]);

    await openAndSettle(hook);
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    const error = notifyMock.mock.calls.find((c) => (c[0] as { type: string }).type === "error");
    expect(error).toBeDefined();
    const payload = error![0] as {
      title: string;
      message: string;
      context?: { worktreeId?: string };
    };
    expect(payload.title).toBe("Couldn't delete worktree");
    expect(payload.message).toBe("Disk read-only");
    expect(payload.context?.worktreeId).toBe("a");
  });

  it("stops dev previews before each delete and folds counts into the success toast (#9084)", async () => {
    worktreeClientMock.delete.mockResolvedValue(undefined);
    const runningState = {
      panelId: "panel",
      projectId: "project",
      status: "running",
      url: "http://localhost:5173",
      predictedUrl: null,
      error: null,
      terminalId: "t",
      isRestarting: false,
      generation: 1,
      updatedAt: Date.now(),
    };
    devPreviewGetByWorktreeMock.mockImplementation(({ worktreeId }: { worktreeId: string }) =>
      Promise.resolve({ ...runningState, worktreeId })
    );

    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);
    await openAndSettle(hook);
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    expect(devPreviewStopByWorktreeMock).toHaveBeenCalledTimes(2);
    expect(devPreviewStopByWorktreeMock).toHaveBeenCalledWith({ worktreeId: "a" });
    expect(devPreviewStopByWorktreeMock).toHaveBeenCalledWith({ worktreeId: "b" });

    const successCall = notifyMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "success"
    );
    expect(successCall).toBeDefined();
    const payload = successCall![0] as { message: string };
    expect(payload.message).toContain("Stopped 2 dev servers");
  });

  it("uses singular dev server copy when exactly one preview was stopped (#9084)", async () => {
    worktreeClientMock.delete.mockResolvedValue(undefined);
    devPreviewGetByWorktreeMock.mockImplementation(({ worktreeId }: { worktreeId: string }) => {
      if (worktreeId === "a") {
        return Promise.resolve({
          panelId: "p",
          projectId: "proj",
          worktreeId,
          status: "running",
          url: null,
          predictedUrl: null,
          error: null,
          terminalId: null,
          isRestarting: false,
          generation: 1,
          updatedAt: Date.now(),
        });
      }
      return Promise.resolve(null);
    });

    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);
    await openAndSettle(hook);
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    // stopByWorktree is called for every target (no client-side gate); the
    // service no-ops when no session matches. Only `a` had a session, so
    // the toast names it.
    expect(devPreviewStopByWorktreeMock).toHaveBeenCalledTimes(2);
    expect(devPreviewStopByWorktreeMock).toHaveBeenCalledWith({ worktreeId: "a" });
    expect(devPreviewStopByWorktreeMock).toHaveBeenCalledWith({ worktreeId: "b" });

    const successCall = notifyMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "success"
    );
    const payload = successCall![0] as { message: string };
    expect(payload.message).toContain("Stopped dev server for a");
  });

  it("does not start the delete until the dev preview stop resolves (#9084)", async () => {
    // On Windows the dev server's directory lock blocks `git worktree remove`
    // outright, so the ordering is the point — asserting both calls happened
    // would pass against a version that fired them together.
    worktreeClientMock.delete.mockResolvedValue(undefined);
    let releaseStop: (() => void) | undefined;
    devPreviewStopByWorktreeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        })
    );
    const { hook } = setup(["a"], [wt("a")]);
    await openAndSettle(hook);

    let pending: Promise<void> | undefined;
    act(() => {
      pending = hook.result.current.handleConfirm();
    });
    await flush();
    expect(devPreviewStopByWorktreeMock).toHaveBeenCalledTimes(1);
    expect(worktreeClientMock.delete).not.toHaveBeenCalled();

    await act(async () => {
      releaseStop!();
      await pending;
    });
    expect(worktreeClientMock.delete).toHaveBeenCalledWith("a", {
      force: true,
      deleteBranch: false,
    });
  });

  it("treats a dev preview stop failure as a removal failure for that target (#9084)", async () => {
    worktreeClientMock.delete.mockResolvedValue(undefined);
    devPreviewGetByWorktreeMock.mockResolvedValue({
      panelId: "p",
      projectId: "proj",
      worktreeId: "a",
      status: "running",
      url: null,
      predictedUrl: null,
      error: null,
      terminalId: null,
      isRestarting: false,
      generation: 1,
      updatedAt: Date.now(),
    });
    devPreviewStopByWorktreeMock.mockRejectedValueOnce(new Error("stop failed"));

    const { hook } = setup(["a"], [wt("a", { branch: "feature/a" })]);
    await openAndSettle(hook);
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    expect(worktreeClientMock.delete).not.toHaveBeenCalled();
    const error = notifyMock.mock.calls.find((c) => (c[0] as { type: string }).type === "error");
    expect(error).toBeDefined();
    const payload = error![0] as { message: string };
    expect(payload.message).toContain("stop failed");
  });

  it("handleCancel clears the snapshot so the next click derives fresh targets", async () => {
    const { hook } = setup(["a", "b", "c"], [wt("a"), wt("b"), wt("c")]);

    await openAndSettle(hook);
    expect(hook.result.current.typedNameTarget).toBe("3 worktrees");

    act(() => hook.result.current.handleCancel());
    expect(hook.result.current.isConfirmOpen).toBe(false);
    expect(hook.result.current.targets).toEqual([]);
    expect(hook.result.current.excludedMainCount).toBe(0);
  });

  it("guards against rapid double-click via the isExecutingRef gate", async () => {
    let resolveFirst: (() => void) | undefined;
    worktreeClientMock.delete.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const { hook } = setup(["a"], [wt("a")]);

    await openAndSettle(hook);

    // Both clicks inside ONE synchronous act, so React never publishes
    // `isExecuting` between them. A state-based guard would pass if they were
    // split across two acts; only the synchronous ref guard passes here.
    let pending: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      pending = hook.result.current.handleConfirm();
      second = hook.result.current.handleConfirm();
    });
    await act(async () => {
      await second;
    });

    expect(worktreeClientMock.delete).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await act(async () => {
      await pending;
    });
    // One run, so exactly one summary.
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});

describe("useWorktreeBulkRemove — the queue no longer guillotines the batch (#12416)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a delete outlive the old 30s ceiling and still summarises every target", async () => {
    // The regression: `PQueue({ timeout: 30_000 })` rejected `addAll` after 30s
    // while p-queue cancelled nothing, so the siblings kept running unobserved
    // behind a "Bulk remove aborted" toast. The delete transport's own deadline
    // is 10 minutes (`WORKTREE_PORT_TIMEOUTS_MS["delete-worktree"]`), sized to
    // the host's 7-minute teardown worst case — a renderer ceiling below that
    // can only ever fire early.
    vi.useFakeTimers();
    worktreeClientMock.delete.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 45_000);
        })
    );
    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);

    act(() => hook.result.current.handleRemoveClick());
    await flush();
    expect(hook.result.current.canConfirm).toBe(true);

    let pending: Promise<void> | undefined;
    act(() => {
      pending = hook.result.current.handleConfirm();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
      await pending;
    });

    const successCall = notifyMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "success"
    );
    expect(successCall).toBeDefined();
    expect((successCall![0] as { title: string }).title).toBe("Deleted 2 worktrees");
    // The old escape-hatch toast is gone along with the branch that raised it.
    expect(
      notifyMock.mock.calls.find((c) => (c[0] as { title: string }).title === "Bulk remove aborted")
    ).toBeUndefined();
    expect(hook.result.current.isExecuting).toBe(false);
  });

  it("bounds a hung dev-preview stop instead of parking the whole batch", async () => {
    // The queue timeout used to bound these two calls by accident. They are a
    // bare `ipcRenderer.invoke` with no deadline of their own (unlike
    // `worktreeClient.delete`, which has a 10-minute port deadline), so
    // removing the queue ceiling without this would let one hung stop park its
    // task before the delete — `allSettled` never settles, no summary is ever
    // emitted, and `isExecuting` stays pinned true with Cancel gated behind it.
    vi.useFakeTimers();
    devPreviewGetByWorktreeMock.mockImplementation(({ worktreeId }: { worktreeId: string }) =>
      Promise.resolve(
        worktreeId === "a"
          ? {
              panelId: "p",
              projectId: "proj",
              worktreeId,
              status: "running",
              url: null,
              predictedUrl: null,
              error: null,
              terminalId: null,
              isRestarting: false,
              generation: 1,
              updatedAt: Date.now(),
            }
          : null
      )
    );
    devPreviewStopByWorktreeMock.mockImplementation(({ worktreeId }: { worktreeId: string }) =>
      worktreeId === "a" ? new Promise<void>(() => {}) : Promise.resolve(undefined)
    );
    worktreeClientMock.delete.mockResolvedValue(undefined);

    const { hook } = setup(["a", "b"], [wt("a", { branch: "feature/a" }), wt("b")]);
    act(() => hook.result.current.handleRemoveClick());
    await flush();

    let pending: Promise<void> | undefined;
    act(() => {
      pending = hook.result.current.handleConfirm();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      await pending;
    });

    // The hung target is an ordinary failure; its sibling still ran.
    const warning = notifyMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "warning"
    );
    expect(warning).toBeDefined();
    expect((warning![0] as { title: string }).title).toBe("Deleted 1 of 2 worktrees");
    expect((warning![0] as { message: string }).message).toContain("feature/a");
    // Never deleted behind a lock we could not confirm released (#9084).
    expect(worktreeClientMock.delete).toHaveBeenCalledTimes(1);
    expect(worktreeClientMock.delete).toHaveBeenCalledWith("b", {
      force: true,
      deleteBranch: false,
    });
    // The run finished, so the dialog is usable again.
    expect(hook.result.current.isExecuting).toBe(false);
    expect(hook.result.current.isConfirmOpen).toBe(false);
  });

  it("counts a rejected queue submission as one failure and still observes its siblings", async () => {
    // `addAll` is `Promise.all` underneath, so one rejected submission used to
    // discard every sibling's result. Individual `add()` calls folded through
    // `allSettled` cannot.
    worktreeClientMock.delete.mockResolvedValue(undefined);
    const { hook } = setup(["a", "b"], [wt("a", { branch: "feature/a" }), wt("b")]);
    // Settle the previews FIRST, then install the spy — so the only queue it
    // can intercept is the delete fan-out, without keying off a concurrency
    // number copied from the implementation.
    await openAndSettle(hook);

    const realAdd = PQueue.prototype.add;
    let rejectedOnce = false;
    const addSpy = vi.spyOn(PQueue.prototype, "add").mockImplementation(function (
      this: PQueue,
      fn: never,
      options: never
    ) {
      if (!rejectedOnce) {
        rejectedOnce = true;
        return Promise.reject(new Error("submission rejected"));
      }
      return realAdd.call(this, fn, options);
    } as typeof PQueue.prototype.add);

    try {
      await act(async () => {
        await hook.result.current.handleConfirm();
      });

      const warning = notifyMock.mock.calls.find(
        (c) => (c[0] as { type: string }).type === "warning"
      );
      expect(warning).toBeDefined();
      // The sibling still ran, and both outcomes reached the one summary.
      expect((warning![0] as { title: string }).title).toBe("Deleted 1 of 2 worktrees");
      expect((warning![0] as { message: string }).message).toContain("feature/a");
      expect(worktreeClientMock.delete).toHaveBeenCalledTimes(1);
      expect(worktreeClientMock.delete).toHaveBeenCalledWith("b", {
        force: true,
        deleteBranch: false,
      });
    } finally {
      addSpy.mockRestore();
    }
  });
});

describe("useWorktreeBulkRemove — nested worktrees (#12789)", () => {
  const parent = () => wt("parent", { path: "/repo/parent", branch: "feature/parent" });
  const child = () => wt("child", { path: "/repo/parent/child", branch: "feature/child" });
  const deletedIds = (): string[] =>
    worktreeClientMock.delete.mock.calls.map((call: unknown[]) => String(call[0]));

  it("removes a selected nested worktree before its ancestor starts", async () => {
    let finishChild: () => void = () => {};
    worktreeClientMock.delete.mockImplementation((id: string) =>
      id === "child"
        ? new Promise<void>((resolve) => {
            finishChild = resolve;
          })
        : Promise.resolve()
    );
    const { hook } = setup(["parent", "child"], [parent(), child()]);
    await openAndSettle(hook);

    let confirmed!: Promise<void>;
    act(() => {
      confirmed = hook.result.current.handleConfirm();
    });
    await flush();
    expect(deletedIds()).toEqual(["child"]);

    await act(async () => {
      finishChild();
      await confirmed;
    });
    expect(deletedIds()).toEqual(["child", "parent"]);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Deleted 2 worktrees" })
    );
  });

  it("keeps the ancestor when a nested worktree fails", async () => {
    worktreeClientMock.delete.mockImplementation((id: string) =>
      id === "child" ? Promise.reject(new Error("Filesystem busy")) : Promise.resolve()
    );
    const { hook } = setup(["parent", "child"], [parent(), child()]);
    await openAndSettle(hook);
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    expect(deletedIds()).toEqual(["child"]);
    // The parent comes first in selection order, but its failure only echoes
    // the child's, so the child's cause is the one shown.
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Couldn't delete worktrees",
        message: "Filesystem busy",
      })
    );
  });

  it("keeps every ancestor above a failed nested worktree and runs the rest", async () => {
    worktreeClientMock.delete.mockImplementation((id: string) =>
      id === "child" ? Promise.reject(new Error("Filesystem busy")) : Promise.resolve()
    );
    const other = wt("other", { path: "/repo/other", branch: "feature/other" });
    const grandchild = wt("grandchild", {
      path: "/repo/parent/child/grandchild",
      branch: "feature/grandchild",
    });
    const { hook } = setup(
      ["parent", "child", "grandchild", "other"],
      [parent(), child(), grandchild, other]
    );
    await openAndSettle(hook);
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    const deleted = deletedIds();
    expect(deleted.indexOf("grandchild")).toBeLessThan(deleted.indexOf("child"));
    expect(deleted).not.toContain("parent");
    expect(deleted).toContain("other");
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "warning", title: "Deleted 2 of 4 worktrees" })
    );
    expect(logErrorMock).toHaveBeenCalledWith("Bulk remove failed for child", expect.anything());
  });

  it("names every failed nested worktree when it keeps the ancestor", async () => {
    worktreeClientMock.delete.mockImplementation((id: string) =>
      id === "parent" ? Promise.resolve() : Promise.reject(new Error("Filesystem busy"))
    );
    const second = wt("second", { path: "/repo/parent/second", branch: "feature/second" });
    const { hook } = setup(["child", "second", "parent"], [parent(), child(), second]);
    await openAndSettle(hook);
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    expect(deletedIds()).not.toContain("parent");
    expect(logErrorMock).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", message: "Filesystem busy" })
    );
  });

  it("does not order siblings whose names merely share a prefix", async () => {
    worktreeClientMock.delete.mockResolvedValue(undefined);
    const a = wt("a", { path: "/repo/wt" });
    const b = wt("b", { path: "/repo/wt-other" });
    const { hook } = setup(["a", "b"], [a, b]);
    await openAndSettle(hook);
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    expect(deletedIds()).toEqual(["a", "b"]);
  });
});

describe("useWorktreeBulkRemove — the evidence is re-read before anything runs", () => {
  async function confirm(hook: ReturnType<typeof setup>["hook"]) {
    await act(async () => {
      await hook.result.current.handleConfirm();
    });
  }

  it("re-reads every target, then runs when nothing changed", async () => {
    worktreeClientMock.delete.mockResolvedValue(undefined);
    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);
    await openAndSettle(hook);
    const readsAtOpen = worktreeClientMock.getFreshChanges.mock.calls.length;

    await confirm(hook);

    // One more read per target, all before the first delete.
    expect(worktreeClientMock.getFreshChanges.mock.calls.length - readsAtOpen).toBe(2);
    const lastRead = Math.max(...worktreeClientMock.getFreshChanges.mock.invocationCallOrder);
    const firstDelete = Math.min(...worktreeClientMock.delete.mock.invocationCallOrder);
    expect(lastRead).toBeLessThan(firstDelete);
    expect(worktreeClientMock.delete).toHaveBeenCalledTimes(2);
  });

  it("holds the whole run when a target changed since the check, and resets consent", async () => {
    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);
    await openAndSettle(hook);
    const consentBefore = hook.result.current.consentKey;

    // An agent writes into "b" after the user read its clean preview.
    worktreeClientMock.getFreshChanges.mockImplementation((id: string) =>
      Promise.resolve(id === "b" ? fresh(id, [change("/repo/b/new.ts", "modified")]) : fresh(id))
    );
    await confirm(hook);

    expect(worktreeClientMock.delete).not.toHaveBeenCalled();
    expect(hook.result.current.isConfirmOpen).toBe(true);
    expect(hook.result.current.isExecuting).toBe(false);
    // The new evidence is what's on screen now, and the typed count was for
    // the old one.
    const b = hook.result.current.targets.find((t) => t.id === "b")!;
    expect(b.status.state === "verified" && b.status.preview.changes).toHaveLength(1);
    expect(hook.result.current.consentKey).not.toBe(consentBefore);
  });

  it("holds the run when a re-read fails, and leaves that target out", async () => {
    const { hook } = setup(["a", "b"], [wt("a"), wt("b")]);
    await openAndSettle(hook);

    worktreeClientMock.getFreshChanges.mockImplementation((id: string) =>
      id === "b" ? Promise.reject(new Error("port closed")) : Promise.resolve(fresh(id))
    );
    await confirm(hook);

    expect(worktreeClientMock.delete).not.toHaveBeenCalled();
    const b = hook.result.current.targets.find((t) => t.id === "b")!;
    expect(isBulkRemoveEligible(b)).toBe(false);
    expect(hook.result.current.eligibleCount).toBe(1);
  });
});

describe("bulkRemoveEvidenceKey", () => {
  function row(submodules: SubmoduleDeleteRisk): BulkRemoveTarget {
    return {
      id: "a",
      name: "a",
      branch: "feature/a",
      path: "/repo/a",
      aheadCount: 0,
      status: {
        state: "verified",
        preview: {
          trackedChangeCount: 0,
          untrackedFileCount: 0,
          hasTrackedChanges: false,
          hasUntrackedFiles: false,
          changes: [],
          rootPath: "/repo/a",
          submodules: { status: "verified", risk: submodules },
        },
      },
    };
  }

  it("changes when a nested file moves between untracked and modified", () => {
    // The row's glyph and the loss line's wording both change, so consent
    // given to the old one can't stand.
    expect(bulkRemoveEvidenceKey(row(risk({ untrackedFiles: ["vendor/lib/x.c"] })))).not.toBe(
      bulkRemoveEvidenceKey(row(risk({ dirtyFiles: ["vendor/lib/x.c"] })))
    );
  });

  it("changes when a submodule checkout moves", () => {
    const entry = (headOid: string) => ({
      path: "vendor/lib",
      state: "moved" as const,
      recordedOid: "a".repeat(40),
      headOid,
      hasModifiedContent: false,
      hasUntrackedContent: false,
    });
    expect(bulkRemoveEvidenceKey(row(risk({ entries: [entry("b".repeat(40))] })))).not.toBe(
      bulkRemoveEvidenceKey(row(risk({ entries: [entry("c".repeat(40))] })))
    );
  });

  it("is stable across reads that list the same evidence in another order", () => {
    expect(bulkRemoveEvidenceKey(row(risk({ dirtyFiles: ["vendor/b.c", "vendor/a.c"] })))).toBe(
      bulkRemoveEvidenceKey(row(risk({ dirtyFiles: ["vendor/a.c", "vendor/b.c"] })))
    );
  });
});

function verified(over: Partial<WorktreeDeletePreview> = {}): BulkRemoveTargetStatus {
  const changes = over.changes ?? [];
  return {
    state: "verified",
    preview: {
      trackedChangeCount: changes.filter((c) => c.status !== "untracked" && c.status !== "ignored")
        .length,
      untrackedFileCount: changes.filter((c) => c.status === "untracked").length,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes,
      rootPath: "/tmp/worktrees/retry-jitter",
      submodules: { status: "verified", risk: risk() },
      ...over,
    },
  };
}

function target(over: Partial<BulkRemoveTarget> = {}): BulkRemoveTarget {
  return {
    id: "wt-1",
    name: "retry-jitter",
    branch: "fix/retry-backoff-jitter",
    path: "/tmp/worktrees/retry-jitter",
    aheadCount: 0,
    status: verified(),
    ...over,
  };
}

describe("describeBulkRemoveRisks", () => {
  /**
   * The invariant, asserted over the fresh preview's own counts rather than any
   * wording: every count the confirmation derives has to reach the user.
   *
   * The bug this guards against is a count being derived and silently never
   * rendered — a worktree holding nothing but untracked files rendering as a
   * row with no warning at all (#7880).
   */
  it("surfaces every non-zero count the fresh preview carries", () => {
    // Every count distinct, so no phrase can stand in for another — a bare
    // `toContain("2")` was satisfiable by whichever risk happened to say 2.
    const populated = target({
      aheadCount: 7,
      status: verified({
        changes: [
          ...Array.from({ length: 3 }, (_, i) => change(`t${i}.ts`, "modified")),
          ...Array.from({ length: 5 }, (_, i) => change(`u${i}.ts`, "untracked")),
        ],
        submodules: {
          status: "verified",
          risk: risk({
            dirtyFiles: ["vendor/lib/src/main.c", "vendor/lib/src/util.c"],
            untrackedFiles: [
              "vendor/lib/x.o",
              "vendor/lib/y.o",
              "vendor/lib/z.o",
              "vendor/lib/w.o",
            ],
          }),
        },
      }),
    });
    const line = describeBulkRemoveRisks(populated).join(" · ");

    expect(line, "tracked changes never reached the confirmation").toContain("3 uncommitted files");
    expect(line, "untracked files never reached the confirmation").toContain("5 untracked files");
    expect(line, "unpushed commits never reached the confirmation").toContain("7 unpushed commits");
    // The parent's own status collapses all six nested files into one
    // ` M vendor/lib` row, so this count cannot be derived from the two above.
    expect(line, "nested submodule files never reached the confirmation").toContain(
      "6 files inside submodules"
    );
  });

  it("prefers the fresh ahead count over the cached seed", () => {
    // `getFreshChanges` reports `ahead` from the same `git status --porcelain -b`
    // that produced the file list, so the seed must not win once it has landed.
    const risks = describeBulkRemoveRisks(
      target({ aheadCount: 0, status: verified({ ahead: 3 }) })
    );
    expect(risks).toEqual(["3 unpushed commits"]);
  });

  it("falls back to the seed when git reports no upstream to be ahead of", () => {
    // `ahead` is absent, NOT zero, on a branch with no upstream — reading that
    // as "nothing unpushed" is the misreading the fallback exists to prevent.
    const risks = describeBulkRemoveRisks(target({ aheadCount: 2, status: verified() }));
    expect(risks).toEqual(["2 unpushed commits"]);
  });

  it("reports nothing when nothing is at risk", () => {
    expect(describeBulkRemoveRisks(target())).toEqual([]);
  });

  it("reads the fresh preview, never a cached count", () => {
    // The #12416 regression in one assertion: a target whose preview came back
    // dirty must warn, and the hook no longer carries a cached count that could
    // disagree with it.
    const risks = describeBulkRemoveRisks(
      target({ status: verified({ changes: [change("src/agent.ts", "modified")] }) })
    );
    expect(risks).toEqual(["1 uncommitted file"]);
  });

  it("treats untracked-only work as a risk in its own right", () => {
    // The regression case: a worktree with no tracked changes and no unpushed
    // commits still loses real files when its directory is deleted.
    const risks = describeBulkRemoveRisks(
      target({
        status: verified({ changes: [change("a.log", "untracked"), change("b.log", "untracked")] }),
      })
    );
    expect(risks).toHaveLength(1);
    expect(risks[0]).toContain("2");
  });

  it("asserts no content risk while the preview is still pending", () => {
    // No file count may be claimed before the evidence arrives — the skeleton
    // is the honest state, not a zero.
    expect(describeBulkRemoveRisks(target({ status: { state: "pending" } }))).toEqual([]);
  });

  it("still carries the seeded unpushed count while pending", () => {
    // Deliberate: the seed is the only risk that is already known at open
    // time. The dialog renders a skeleton for a pending row rather than this
    // line, so the contract is the helper's, not the surface's.
    expect(
      describeBulkRemoveRisks(target({ aheadCount: 4, status: { state: "pending" } }))
    ).toEqual(["4 unpushed commits"]);
  });

  it("keeps each risk to its own phrase so they can be joined", () => {
    const risks = describeBulkRemoveRisks(
      target({
        aheadCount: 1,
        status: verified({ changes: [change("a.ts", "modified"), change("b.log", "untracked")] }),
      })
    );
    expect(risks).toHaveLength(3);
    for (const risk of risks) {
      expect(risk).not.toContain("·");
    }
  });

  it("singularises a count of one and pluralises the rest", () => {
    const one = describeBulkRemoveRisks(
      target({ status: verified({ changes: [change("a.log", "untracked")] }) })
    )[0];
    const many = describeBulkRemoveRisks(
      target({
        status: verified({ changes: [change("a.log", "untracked"), change("b.log", "untracked")] }),
      })
    )[0];
    expect(one?.endsWith("s")).toBe(false);
    expect(many?.endsWith("s")).toBe(true);
  });
});

describe("bulkRemoveExclusion", () => {
  it("clears a verified target with a completed, clean submodule inventory", () => {
    const clean = target();
    expect(bulkRemoveExclusion(clean)).toBeNull();
    expect(isBulkRemoveEligible(clean)).toBe(true);
  });

  it("does not exclude a target whose preview has not settled yet", () => {
    // Pending is not an exclusion — it is "not ready". The confirmation is
    // gated as a whole while any target is pending.
    const pending = target({ status: { state: "pending" } });
    expect(bulkRemoveExclusion(pending)).toBeNull();
    expect(isBulkRemoveEligible(pending)).toBe(false);
  });

  it("excludes an already-removed worktree", () => {
    const gone = target({ status: { state: "gone" } });
    expect(bulkRemoveExclusion(gone)).toEqual({ kind: "gone" });
    expect(isBulkRemoveEligible(gone)).toBe(false);
  });

  it("excludes a target whose parent status could not be read — never falls back to cache", () => {
    const failed = target({ status: { state: "failed", submodules: null } });
    expect(bulkRemoveExclusion(failed)).toEqual({ kind: "verify-failed" });
    expect(isBulkRemoveEligible(failed)).toBe(false);
  });

  it("excludes a target holding submodule commits the host refuses to lose", () => {
    // `guardSubmoduleDelete` throws on these BEFORE it reads `force`, so
    // sending one would spend the typed-count consent on a call whose only
    // outcome is a toast.
    const blocked = target({
      status: verified({
        submodules: {
          status: "verified",
          risk: risk({ atRiskCommits: [{ oid: "abc1234def", subject: "wip: vendored fix" }] }),
        },
      }),
    });
    expect(bulkRemoveExclusion(blocked)).toEqual({ kind: "blocked", block: "at-risk-commits" });
    expect(isBulkRemoveEligible(blocked)).toBe(false);
  });

  it("excludes a target whose submodule inventory never completed", () => {
    const incomplete = target({
      status: verified({ submodules: { status: "unverified", risk: risk({ incomplete: true }) } }),
    });
    expect(bulkRemoveExclusion(incomplete)).toEqual({ kind: "blocked", block: "unverified" });
    expect(isBulkRemoveEligible(incomplete)).toBe(false);
  });

  it("does not count a submodule's own row as a file when its contents are counted", () => {
    // The parent reports a submodule with work in it as one ` M vendor/lib`
    // row; counting it beside the nested files it stands for stated one loss
    // twice.
    const risks = describeBulkRemoveRisks(
      target({
        status: verified({
          changes: [change("/tmp/worktrees/retry-jitter/vendor/lib", "modified")],
          submodules: {
            status: "verified",
            risk: risk({
              entries: [
                {
                  path: "vendor/lib",
                  state: "at-recorded-commit",
                  recordedOid: "0".repeat(40),
                  hasModifiedContent: true,
                  hasUntrackedContent: false,
                },
              ],
              dirtyFiles: ["vendor/lib/a.c", "vendor/lib/b.c"],
            }),
          },
        }),
      })
    );
    expect(risks).toEqual(["2 files inside submodules"]);
  });
});
