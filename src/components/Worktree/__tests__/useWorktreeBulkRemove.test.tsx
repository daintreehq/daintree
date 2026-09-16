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

import { useWorktreeBulkRemove, isBulkRemoveEligible } from "../useWorktreeBulkRemove";
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
    expect(hook.result.current.typedNameTarget).toBe("1 worktree");
  });

  it("does not open the dialog when every selection is the main worktree", () => {
    const { hook, clearSelection } = setup(["main"], [wt("main", { isMainWorktree: true })]);

    act(() => hook.result.current.handleRemoveClick());

    expect(hook.result.current.isConfirmOpen).toBe(false);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", title: "Nothing to remove" })
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
    expect(hook.result.current.hasFailedPreviews).toBe(true);
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
    worktreeClientMock.getFreshChanges
      .mockRejectedValueOnce(new Error("host timed out"))
      .mockImplementation((id: string) => Promise.resolve(fresh(id)));
    const { hook } = setup(["a"], [wt("a")]);

    await openAndSettle(hook);
    expect(hook.result.current.targets[0]!.status.state).toBe("failed");

    act(() => hook.result.current.handleRetryPreviews());
    expect(hook.result.current.targets[0]!.status.state).toBe("pending");
    await flush();

    expect(hook.result.current.targets[0]!.status.state).toBe("verified");
    expect(hook.result.current.eligibleCount).toBe(1);
  });

  it("discards a preview that lands after the dialog was cancelled", async () => {
    let resolveFresh: ((value: WorktreeChanges) => void) | undefined;
    worktreeClientMock.getFreshChanges.mockImplementation(
      () =>
        new Promise<WorktreeChanges>((resolve) => {
          resolveFresh = resolve;
        })
    );
    const { hook } = setup(["a"], [wt("a")]);

    act(() => hook.result.current.handleRemoveClick());
    act(() => hook.result.current.handleCancel());

    act(() => {
      resolveFresh!(fresh("a", [change("/repo/a/x.ts", "modified")]));
    });
    await flush();

    // The snapshot the user left must not be repopulated behind them.
    expect(hook.result.current.targets).toEqual([]);
    expect(hook.result.current.isPreviewPending).toBe(false);
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
    expect(payload.title).toBe("Removed 2 worktrees");
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
    const payload = warning![0] as { title: string; message: string };
    expect(payload.title).toBe("Removed 1 of 2 worktrees");
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
    const payload = error![0] as { title: string; message: string };
    expect(payload.title).toBe("Couldn't remove worktree");
    expect(payload.message).toBe("Disk read-only");
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

    let pending: Promise<void> | undefined;
    act(() => {
      pending = hook.result.current.handleConfirm();
    });

    // Second confirm while the first is in flight must be a no-op.
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    expect(worktreeClientMock.delete).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await act(async () => {
      await pending;
    });
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
    expect((successCall![0] as { title: string }).title).toBe("Removed 2 worktrees");
    // The old escape-hatch toast is gone along with the branch that raised it.
    expect(
      notifyMock.mock.calls.find((c) => (c[0] as { title: string }).title === "Bulk remove aborted")
    ).toBeUndefined();
    expect(hook.result.current.isExecuting).toBe(false);
  });

  it("counts a rejected queue submission as one failure and still observes its siblings", async () => {
    // `addAll` is `Promise.all` underneath, so one rejected submission used to
    // discard every sibling's result. Individual `add()` calls folded through
    // `allSettled` cannot.
    worktreeClientMock.delete.mockResolvedValue(undefined);
    const realAdd = PQueue.prototype.add;
    let rejectedOnce = false;
    const addSpy = vi.spyOn(PQueue.prototype, "add").mockImplementation(function (
      this: PQueue,
      fn: never,
      options: never
    ) {
      // Only the delete queue — the preview fan-out runs at concurrency 3.
      if (this.concurrency === 4 && !rejectedOnce) {
        rejectedOnce = true;
        return Promise.reject(new Error("queue cleared"));
      }
      return realAdd.call(this, fn, options);
    } as typeof PQueue.prototype.add);

    try {
      const { hook } = setup(["a", "b"], [wt("a", { branch: "feature/a" }), wt("b")]);
      await openAndSettle(hook);
      await act(async () => {
        await hook.result.current.handleConfirm();
      });

      const warning = notifyMock.mock.calls.find(
        (c) => (c[0] as { type: string }).type === "warning"
      );
      expect(warning).toBeDefined();
      // The sibling still ran, and both outcomes reached the one summary.
      expect((warning![0] as { title: string }).title).toBe("Removed 1 of 2 worktrees");
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
