// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const worktreeClientMock = vi.hoisted(() => ({ delete: vi.fn() }));
const notifyMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const devPreviewGetByWorktreeMock = vi.hoisted(() => vi.fn());
const devPreviewStopByWorktreeMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients/worktreeClient", () => ({ worktreeClient: worktreeClientMock }));
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

import { useWorktreeBulkRemove } from "../useWorktreeBulkRemove";
import type { WorktreeState } from "@/types";

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

beforeEach(() => {
  vi.clearAllMocks();
  devPreviewGetByWorktreeMock.mockResolvedValue(null);
  devPreviewStopByWorktreeMock.mockResolvedValue(undefined);
});

describe("useWorktreeBulkRemove — confirm derivation", () => {
  it("snapshots non-main targets when Remove is clicked", () => {
    const { hook } = setup(
      ["a", "b"],
      [wt("a", { branch: "feature/a" }), wt("b", { branch: "feature/b" })]
    );

    act(() => hook.result.current.handleRemoveClick());

    expect(hook.result.current.isConfirmOpen).toBe(true);
    expect(hook.result.current.targets.map((t) => t.id)).toEqual(["a", "b"]);
    expect(hook.result.current.typedNameTarget).toBe("2 worktrees");
  });

  it("excludes main worktree from the target list and surfaces the excluded count", () => {
    const { hook } = setup(
      ["main", "feature"],
      [wt("main", { isMainWorktree: true }), wt("feature")]
    );

    act(() => hook.result.current.handleRemoveClick());

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

  it("computes per-target tracked-change and ahead counts (lessons #4927 and unpushed-state)", () => {
    const { hook } = setup(
      ["a"],
      [
        wt("a", {
          aheadCount: 3,
          worktreeChanges: {
            changes: [
              { status: "modified", filePath: "x" },
              { status: "untracked", filePath: "y" },
              { status: "ignored", filePath: "z" },
            ],
            changedFileCount: 3,
          } as unknown as WorktreeState["worktreeChanges"],
        }),
      ]
    );

    act(() => hook.result.current.handleRemoveClick());

    const target = hook.result.current.targets[0];
    expect(target).toBeDefined();
    expect(target!.trackedChangeCount).toBe(1); // modified only — untracked + ignored excluded
    expect(target!.untrackedFileCount).toBe(1);
    expect(target!.aheadCount).toBe(3);
  });
});

describe("useWorktreeBulkRemove — execution", () => {
  it("runs every snapshot target through worktreeClient.delete with force=true", async () => {
    worktreeClientMock.delete.mockResolvedValue(undefined);
    const { hook, clearSelection } = setup(["a", "b"], [wt("a"), wt("b")]);

    act(() => hook.result.current.handleRemoveClick());
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

    act(() => hook.result.current.handleRemoveClick());
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

    act(() => hook.result.current.handleRemoveClick());
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

    act(() => hook.result.current.handleRemoveClick());
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
    act(() => hook.result.current.handleRemoveClick());
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
    act(() => hook.result.current.handleRemoveClick());
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
    act(() => hook.result.current.handleRemoveClick());
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    expect(worktreeClientMock.delete).not.toHaveBeenCalled();
    const error = notifyMock.mock.calls.find((c) => (c[0] as { type: string }).type === "error");
    expect(error).toBeDefined();
    const payload = error![0] as { message: string };
    expect(payload.message).toContain("stop failed");
  });

  it("recovers from a PQueue TimeoutError so the dialog can be reused (no permanent freeze)", async () => {
    // Simulate a hang that the p-queue's 30s timeout would eventually
    // catch in production. We can't really wait 30s, so instead we
    // throw a TimeoutError-shaped error from the awaited promise to
    // trip the same catch path that p-queue would.
    const timeoutErr = Object.assign(new Error("Operation timed out"), { name: "TimeoutError" });
    worktreeClientMock.delete.mockRejectedValue(timeoutErr);
    const { hook, clearSelection } = setup(["a"], [wt("a")]);

    act(() => hook.result.current.handleRemoveClick());
    await act(async () => {
      await hook.result.current.handleConfirm();
    });

    // Cleanup must run even on the failure path — these are the
    // load-bearing invariants for "the modal can be reused".
    expect(hook.result.current.isExecuting).toBe(false);
    expect(hook.result.current.isConfirmOpen).toBe(false);
    expect(hook.result.current.targets).toEqual([]);
    expect(clearSelection).toHaveBeenCalled();
  });

  it("handleCancel clears the snapshot so the next click derives fresh targets", () => {
    const { hook } = setup(["a", "b", "c"], [wt("a"), wt("b"), wt("c")]);

    act(() => hook.result.current.handleRemoveClick());
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

    act(() => hook.result.current.handleRemoveClick());

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
