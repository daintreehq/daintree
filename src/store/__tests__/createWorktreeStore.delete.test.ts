import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";

// Host-minted versions are now `(epoch, seq)` tuples (#8403). Tests mint a
// monotonic seq under a fixed epoch; each fresh store starts at epoch "" so
// the first non-empty epoch is always accepted as an epoch transition.
const TEST_EPOCH = "test-epoch";
let _seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++_seq };
}

const {
  worktreeClientDeleteMock,
  captureWorktreeTerminalSnapshotMock,
  closeTerminalsForWorktreeMock,
  restoreClosedTerminalsMock,
  notifyMock,
  devPreviewGetByWorktreeMock,
  devPreviewStopByWorktreeMock,
} = vi.hoisted(() => ({
  worktreeClientDeleteMock: vi.fn<
    (
      id: string,
      options: {
        force?: boolean;
        deleteBranch?: boolean;
        forceDeleteBranch?: boolean;
        mutationId?: string;
      }
    ) => Promise<void>
  >(),
  captureWorktreeTerminalSnapshotMock: vi.fn<(id: string) => unknown[]>(),
  closeTerminalsForWorktreeMock: vi.fn<(id: string) => Promise<void>>(),
  restoreClosedTerminalsMock: vi.fn<(snapshot: readonly unknown[]) => Promise<void>>(),
  notifyMock: vi.fn(),
  devPreviewGetByWorktreeMock: vi.fn(),
  devPreviewStopByWorktreeMock: vi.fn(),
}));

(globalThis as Record<string, unknown>).window = globalThis.window ?? {};
(window as unknown as Record<string, unknown>).electron = {
  ...((window as unknown as Record<string, unknown>).electron ?? {}),
  devPreview: {
    getByWorktree: devPreviewGetByWorktreeMock,
    stopByWorktree: devPreviewStopByWorktreeMock,
  },
};

vi.mock("@/clients", async () => {
  const actual = await vi.importActual<typeof import("@/clients")>("@/clients");
  return {
    ...actual,
    worktreeClient: {
      ...actual.worktreeClient,
      delete: worktreeClientDeleteMock,
    },
  };
});

vi.mock("@/components/Worktree/worktreeDeleteHelper", () => ({
  captureWorktreeTerminalSnapshot: captureWorktreeTerminalSnapshotMock,
  closeTerminalsForWorktree: closeTerminalsForWorktreeMock,
  restoreClosedTerminals: restoreClosedTerminalsMock,
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

// Import after mocks so the store picks up the mocked deps.
import { createWorktreeStore, OUTBOX_RETRY_CAP } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";

function makeSnapshot(id: string): WorktreeSnapshot {
  return {
    id,
    name: id,
    branch: "main",
    path: `/repo/${id}`,
    isCurrent: false,
    isMainWorktree: false,
    modifiedCount: 0,
    changes: [],
    summary: "",
    mood: null,
    gitDir: "",
  } as unknown as WorktreeSnapshot;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createWorktreeStore — delete in-flight state (#8417)", () => {
  beforeEach(() => {
    worktreeClientDeleteMock.mockReset();
    captureWorktreeTerminalSnapshotMock.mockReset();
    closeTerminalsForWorktreeMock.mockReset();
    restoreClosedTerminalsMock.mockReset();
    notifyMock.mockReset();
    devPreviewGetByWorktreeMock.mockReset();
    devPreviewStopByWorktreeMock.mockReset();
    worktreeClientDeleteMock.mockResolvedValue();
    captureWorktreeTerminalSnapshotMock.mockReturnValue([]);
    closeTerminalsForWorktreeMock.mockResolvedValue();
    restoreClosedTerminalsMock.mockResolvedValue();
    // Default: no dev preview session for the worktree. Tests opt-in by
    // overriding the mock per case.
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    devPreviewStopByWorktreeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initializes with empty delete maps", () => {
    const store = createWorktreeStore();
    expect(store.getState().deletingIds.size).toBe(0);
    expect(store.getState().deleteErrors.size).toBe(0);
    expect(store.getState().deleteErrorArgs.size).toBe(0);
  });

  it("startDelete marks deletingIds and stores args atomically", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: true, deleteBranch: false });

    expect(store.getState().deletingIds.has("wt-1")).toBe(true);
    expect(store.getState().deleteErrors.has("wt-1")).toBe(false);
    expect(store.getState().deleteErrorArgs.get("wt-1")).toEqual({
      force: true,
      deleteBranch: false,
    });
  });

  it("startDelete is idempotent — a second call while in flight is a no-op", () => {
    const store = createWorktreeStore();
    store.getState().startDelete("wt-1", { force: false });
    store.getState().startDelete("wt-1", { force: true });
    // Args from the first call must persist — the second start was suppressed.
    expect(store.getState().deleteErrorArgs.get("wt-1")).toEqual({ force: false });
  });

  it("startDelete with closeTerminals routes through closeTerminalsForWorktree before IPC", async () => {
    const store = createWorktreeStore();
    store.getState().startDelete("wt-1", { closeTerminals: true });
    await flushPromises();
    await flushPromises();

    expect(closeTerminalsForWorktreeMock).toHaveBeenCalledWith("wt-1");
    expect(worktreeClientDeleteMock).toHaveBeenCalledWith("wt-1", {
      force: undefined,
      deleteBranch: undefined,
      mutationId: expect.any(String),
    });
  });

  it("stops a running dev preview before delete and emits a transient success toast (#9084)", async () => {
    devPreviewGetByWorktreeMock.mockResolvedValueOnce({
      panelId: "panel-1",
      projectId: "project-1",
      worktreeId: "wt-1",
      status: "running",
      url: "http://localhost:5173",
      predictedUrl: null,
      error: null,
      terminalId: "t-1",
      isRestarting: false,
      generation: 1,
      updatedAt: Date.now(),
    });

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: true });
    await flushPromises();
    await flushPromises();

    expect(devPreviewStopByWorktreeMock).toHaveBeenCalledWith({ worktreeId: "wt-1" });
    expect(worktreeClientDeleteMock).toHaveBeenCalled();
    // stopByWorktree must precede the git delete call to avoid Windows
    // directory-lock failures.
    const stopOrder = devPreviewStopByWorktreeMock.mock.invocationCallOrder[0]!;
    const deleteOrder = worktreeClientDeleteMock.mock.invocationCallOrder[0]!;
    expect(stopOrder).toBeLessThan(deleteOrder);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Dev server stopped",
        transient: true,
      })
    );
  });

  it("aborts the delete when stopByWorktree fails and records the error (#9084)", async () => {
    devPreviewGetByWorktreeMock.mockResolvedValueOnce({
      panelId: "panel-1",
      projectId: "project-1",
      worktreeId: "wt-1",
      status: "running",
      url: "http://localhost:5173",
      predictedUrl: null,
      error: null,
      terminalId: "t-1",
      isRestarting: false,
      generation: 1,
      updatedAt: Date.now(),
    });
    devPreviewStopByWorktreeMock.mockRejectedValueOnce(new Error("stop failed"));

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: true });
    await flushPromises();
    await flushPromises();

    expect(devPreviewStopByWorktreeMock).toHaveBeenCalledWith({ worktreeId: "wt-1" });
    expect(worktreeClientDeleteMock).not.toHaveBeenCalled();
    expect(store.getState().deleteErrors.get("wt-1")).toMatch(/stop failed/);
  });

  it("calls stopByWorktree unconditionally and suppresses the toast when no session existed", async () => {
    devPreviewGetByWorktreeMock.mockResolvedValueOnce(null);

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: true });
    await flushPromises();
    await flushPromises();

    // The service-side `stopByWorktree` filter no-ops cleanly when no
    // session matches — the renderer doesn't gate on `getByWorktree`
    // because that view misses sessions for multi-panel worktrees.
    expect(devPreviewStopByWorktreeMock).toHaveBeenCalledWith({ worktreeId: "wt-1" });
    expect(worktreeClientDeleteMock).toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Dev server stopped" })
    );
  });

  it("startDelete without closeTerminals skips terminal cleanup", async () => {
    const store = createWorktreeStore();
    store.getState().startDelete("wt-1", { force: true, deleteBranch: true });
    await flushPromises();
    await flushPromises();

    expect(closeTerminalsForWorktreeMock).not.toHaveBeenCalled();
    expect(worktreeClientDeleteMock).toHaveBeenCalledWith("wt-1", {
      force: true,
      deleteBranch: true,
      mutationId: expect.any(String),
    });
  });

  it("on success, deletingIds and error maps are cleared by applyRemove", async () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: false });
    expect(store.getState().deletingIds.has("wt-1")).toBe(true);

    await flushPromises();
    await flushPromises();

    // Simulating the worktree-removed event handler invoking applyRemove.
    store.getState().applyRemove("wt-1", nextV());

    expect(store.getState().deletingIds.has("wt-1")).toBe(false);
    expect(store.getState().deleteErrors.has("wt-1")).toBe(false);
    expect(store.getState().deleteErrorArgs.has("wt-1")).toBe(false);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });

  it("on failure, deletingIds is cleared and deleteErrors records the message", async () => {
    worktreeClientDeleteMock.mockRejectedValueOnce(new Error("git error: unmerged paths"));

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: false });
    await flushPromises();
    await flushPromises();

    expect(store.getState().deletingIds.has("wt-1")).toBe(false);
    expect(store.getState().deleteErrors.get("wt-1")).toContain("git error: unmerged paths");
    expect(store.getState().deleteErrorArgs.get("wt-1")).toEqual({ force: false });
  });

  it("retryDelete re-fires with the stored args", async () => {
    worktreeClientDeleteMock.mockRejectedValueOnce(new Error("first fail"));

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: true, deleteBranch: true });
    await flushPromises();
    await flushPromises();

    expect(store.getState().deleteErrors.has("wt-1")).toBe(true);
    worktreeClientDeleteMock.mockResolvedValueOnce();

    store.getState().retryDelete("wt-1");

    expect(store.getState().deletingIds.has("wt-1")).toBe(true);
    expect(store.getState().deleteErrors.has("wt-1")).toBe(false);
    await flushPromises();
    await flushPromises();

    expect(worktreeClientDeleteMock).toHaveBeenCalledTimes(2);
    expect(worktreeClientDeleteMock).toHaveBeenLastCalledWith("wt-1", {
      force: true,
      deleteBranch: true,
      mutationId: expect.any(String),
    });
    // retryDelete reuses the original mutationId so the host's ack map can
    // dedupe across the retry boundary (#8405).
    const firstId = worktreeClientDeleteMock.mock.calls[0]![1].mutationId;
    const secondId = worktreeClientDeleteMock.mock.calls[1]![1].mutationId;
    expect(firstId).toBeDefined();
    expect(secondId).toBe(firstId);
  });

  it("retryDelete with no stored args is a no-op", () => {
    const store = createWorktreeStore();
    store.getState().retryDelete("wt-1");
    expect(store.getState().deletingIds.has("wt-1")).toBe(false);
    expect(worktreeClientDeleteMock).not.toHaveBeenCalled();
  });

  it("clearDeleteError purges error and stored args without touching deletingIds", async () => {
    worktreeClientDeleteMock.mockRejectedValueOnce(new Error("boom"));

    const store = createWorktreeStore();
    store.getState().startDelete("wt-1", { force: false });
    await flushPromises();
    await flushPromises();

    expect(store.getState().deleteErrors.has("wt-1")).toBe(true);

    store.getState().clearDeleteError("wt-1");

    expect(store.getState().deleteErrors.has("wt-1")).toBe(false);
    expect(store.getState().deleteErrorArgs.has("wt-1")).toBe(false);
  });

  // #12087 — Dismiss has to abandon the delete, not just hide its banner. A
  // non-permanent failure parks the outbox entry at `pending`, and the reconnect
  // sweep replays anything that isn't `failed`/`in-flight`, so clearing only the
  // presentation state left a dismissed delete queued to re-fire.
  it("clearDeleteError drops the outbox entry so a dismissed delete cannot replay", async () => {
    worktreeClientDeleteMock.mockRejectedValueOnce(
      new Error("fatal: cannot remove a locked working tree")
    );

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: false });
    await flushPromises();
    await flushPromises();

    // Precondition: a retryable failure leaves a live entry behind the banner.
    expect(store.getState().deleteErrors.has("wt-1")).toBe(true);
    expect(store.getState().mutationOutbox.size).toBe(1);
    expect(worktreeClientDeleteMock).toHaveBeenCalledTimes(1);

    store.getState().clearDeleteError("wt-1");
    expect(store.getState().mutationOutbox.size).toBe(0);

    // The worktree is still in the snapshot, so a surviving entry would be a
    // replay candidate rather than being pruned as already-gone.
    store.getState().replayOutboxAfterReconnect();
    await flushPromises();
    await flushPromises();

    expect(worktreeClientDeleteMock).toHaveBeenCalledTimes(1);
  });

  it("clearDeleteError relaunches the terminals the failed delete closed", async () => {
    captureWorktreeTerminalSnapshotMock.mockReturnValueOnce([{ id: "term-1" }]);
    worktreeClientDeleteMock.mockRejectedValueOnce(
      new Error("fatal: cannot remove a locked working tree")
    );

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: false, closeTerminals: true });
    await flushPromises();
    await flushPromises();

    // A retryable failure deliberately holds the snapshot back — the retry that
    // may still come would only close the terminals again.
    expect(store.getState().deleteErrors.has("wt-1")).toBe(true);
    expect(restoreClosedTerminalsMock).not.toHaveBeenCalled();

    store.getState().clearDeleteError("wt-1");
    await flushPromises();

    expect(restoreClosedTerminalsMock).toHaveBeenCalledTimes(1);
    expect(restoreClosedTerminalsMock).toHaveBeenCalledWith([{ id: "term-1" }]);

    // Snapshot consumed: dismissing again must not relaunch them a second time.
    store.getState().clearDeleteError("wt-1");
    await flushPromises();
    expect(restoreClosedTerminalsMock).toHaveBeenCalledTimes(1);
  });

  it("clearDeleteError leaves an in-flight replay alone rather than orphaning it", async () => {
    captureWorktreeTerminalSnapshotMock.mockReturnValueOnce([{ id: "term-1" }]);
    worktreeClientDeleteMock.mockRejectedValueOnce(new Error("boom"));

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: false, closeTerminals: true });
    await flushPromises();
    await flushPromises();
    expect(store.getState().deleteErrors.has("wt-1")).toBe(true);

    // The reconnect sweep replays the pending entry and flips it to `in-flight`
    // WITHOUT clearing the banner, so Dismiss can land on a live delete.
    let settleDelete: () => void = () => {};
    worktreeClientDeleteMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleDelete = resolve;
        })
    );
    store.getState().replayOutboxAfterReconnect();
    await flushPromises();

    const entryId = Array.from(store.getState().mutationOutbox.keys())[0];
    if (entryId === undefined) throw new Error("expected a delete outbox entry");
    expect(store.getState().mutationOutbox.get(entryId)?.status).toBe("in-flight");

    store.getState().clearDeleteError("wt-1");

    // The banner goes, but the running removal keeps its entry and its
    // terminals stay closed — relaunching them would race a delete that is
    // still on its way to succeeding.
    expect(store.getState().deleteErrors.has("wt-1")).toBe(false);
    expect(store.getState().mutationOutbox.has(entryId)).toBe(true);
    expect(restoreClosedTerminalsMock).not.toHaveBeenCalled();

    settleDelete();
    await flushPromises();
  });

  it("partial-success path: when worktree-removed arrives first, failure routes to notify() so it is not swallowed", async () => {
    // The backend emits `worktree-removed` BEFORE `git branch -d`. A branch
    // deletion failure thus arrives after `applyRemove` has cleared the card.
    // Falling back to a toast preserves user feedback for the branch leak.
    let rejectIpc: (reason: unknown) => void = () => {};
    worktreeClientDeleteMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectIpc = reject;
        })
    );

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: false, deleteBranch: true });
    await flushPromises();

    // Simulate `worktree-removed` arriving before the IPC rejection — common
    // when the backend removed the worktree but the bridge is still resolving
    // a stale promise.
    store.getState().applyRemove("wt-1", nextV());

    expect(store.getState().deletingIds.has("wt-1")).toBe(false);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);

    rejectIpc(new Error("Worktree removed. Couldn't delete branch 'feature/x': locked ref"));
    await flushPromises();
    await flushPromises();

    // No dangling Map entries (card is gone).
    expect(store.getState().deleteErrors.has("wt-1")).toBe(false);
    expect(store.getState().deleteErrorArgs.has("wt-1")).toBe(false);

    // But the user MUST see the branch-leak error somewhere.
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0] as {
      type: string;
      title: string;
      message: string;
      context: { worktreeId?: string };
    };
    expect(payload.type).toBe("error");
    expect(payload.title).toContain("branch");
    expect(payload.message).toContain("Couldn't delete branch");
    // No `worktreeId` context on this path: `notify`'s origin-surface gate
    // treats a matching active worktree as "already visible inline" and drops
    // the toast to inbox-only. This branch runs because the card is gone, and
    // a ghost row keeping terminals alive still answers to the id — so the id
    // would suppress the only surface reporting the outcome.
    expect(payload.context.worktreeId).toBeUndefined();
  });

  it("partial-success path: a branch the backend deliberately kept is a warning, not a failed delete", async () => {
    // `branch -d` refusing a not-fully-merged branch is the safeguard working.
    // Reporting it as an error toast dressed a correct outcome as a fault and
    // implied a retry that could never succeed — the worktree is already gone
    // by the time this arrives.
    let rejectIpc: (reason: unknown) => void = () => {};
    worktreeClientDeleteMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectIpc = reject;
        })
    );

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: true, deleteBranch: true });
    await flushPromises();

    store.getState().applyRemove("wt-1", nextV());
    rejectIpc(
      new Error(
        "Worktree removed. Branch 'feature/x' was kept because Git reports it isn't fully merged."
      )
    );
    await flushPromises();
    await flushPromises();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0] as {
      type: string;
      title: string;
      message: string;
    };
    expect(payload.type).toBe("warning");
    expect(payload.title).toBe("Branch kept");
    // The removal that already happened has to be part of what the user reads.
    expect(payload.message).toContain("Worktree removed.");
  });

  it("closeTerminalsForWorktree rejection short-circuits IPC and records the error on the card", async () => {
    closeTerminalsForWorktreeMock.mockRejectedValueOnce(
      new Error("Timed out waiting for 2 terminal(s) to close before deleting worktree")
    );

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { closeTerminals: true, force: false });
    await flushPromises();
    await flushPromises();

    expect(worktreeClientDeleteMock).not.toHaveBeenCalled();
    expect(store.getState().deletingIds.has("wt-1")).toBe(false);
    expect(store.getState().deleteErrors.get("wt-1")).toContain("Timed out waiting");
    expect(store.getState().deleteErrorArgs.get("wt-1")).toEqual({
      closeTerminals: true,
      force: false,
    });
  });

  describe("#11344 — restore closed terminals when the delete is abandoned", () => {
    const SNAPSHOT = [{ id: "t-1", location: "grid" }];

    it("relaunches the closed terminals on a permanent failure", async () => {
      captureWorktreeTerminalSnapshotMock.mockReturnValueOnce(SNAPSHOT);
      worktreeClientDeleteMock.mockRejectedValueOnce(new Error("worktree has uncommitted changes"));

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { closeTerminals: true, force: false });
      await flushPromises();
      await flushPromises();

      expect(restoreClosedTerminalsMock).toHaveBeenCalledTimes(1);
      expect(restoreClosedTerminalsMock).toHaveBeenCalledWith(SNAPSHOT);
    });

    it("captures BEFORE closing, so a close-wait timeout still restores at the retry cap", async () => {
      captureWorktreeTerminalSnapshotMock.mockReturnValue(SNAPSHOT);
      // The close itself times out before the git delete is even attempted.
      closeTerminalsForWorktreeMock.mockRejectedValue(
        new Error("Timed out waiting for 1 terminal(s) to close before deleting worktree")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { closeTerminals: true, force: false });
      await flushPromises();
      await flushPromises();
      // Generic failure → still pending → not yet restored.
      expect(restoreClosedTerminalsMock).not.toHaveBeenCalled();

      // Drive the generic-retry budget to the cap.
      for (let i = 1; i < OUTBOX_RETRY_CAP; i++) {
        store.getState().retryDelete("wt-1");
        await flushPromises();
        await flushPromises();
      }

      // Never reached worktreeClient.delete, yet the captured snapshot survives
      // the throw and restores exactly once at the cap.
      expect(worktreeClientDeleteMock).not.toHaveBeenCalled();
      expect(restoreClosedTerminalsMock).toHaveBeenCalledTimes(1);
      expect(restoreClosedTerminalsMock).toHaveBeenCalledWith(SNAPSHOT);
    });

    it("a rapid retry waits for the in-flight restore before closing terminals again", async () => {
      captureWorktreeTerminalSnapshotMock.mockReturnValue(SNAPSHOT);
      worktreeClientDeleteMock.mockRejectedValueOnce(new Error("worktree has uncommitted changes"));
      // Hold the restore open so it is still in flight when the retry fires.
      let resolveRestore: () => void = () => {};
      restoreClosedTerminalsMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveRestore = resolve;
          })
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { closeTerminals: true, force: false });
      await flushPromises();
      await flushPromises();
      expect(restoreClosedTerminalsMock).toHaveBeenCalledTimes(1);

      // Retry while the restore is still spawning panels.
      closeTerminalsForWorktreeMock.mockClear();
      worktreeClientDeleteMock.mockResolvedValueOnce();
      store.getState().retryDelete("wt-1");
      await flushPromises();
      await flushPromises();
      // Blocked on the in-flight restore — must not close terminals yet, which
      // would strand the still-spawning panels against the git remove.
      expect(closeTerminalsForWorktreeMock).not.toHaveBeenCalled();

      resolveRestore();
      await flushPromises();
      await flushPromises();
      expect(closeTerminalsForWorktreeMock).toHaveBeenCalledWith("wt-1");
    });

    it("does NOT relaunch on a connectivity failure — the delete stays pending for replay", async () => {
      captureWorktreeTerminalSnapshotMock.mockReturnValueOnce(SNAPSHOT);
      worktreeClientDeleteMock.mockRejectedValueOnce(new Error("HOST_EXITED: port gone"));

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { closeTerminals: true, force: false });
      await flushPromises();
      await flushPromises();

      expect(restoreClosedTerminalsMock).not.toHaveBeenCalled();
    });

    it("does NOT relaunch on success — the worktree is gone, terminals stay closed", async () => {
      captureWorktreeTerminalSnapshotMock.mockReturnValueOnce(SNAPSHOT);

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { closeTerminals: true, force: false });
      await flushPromises();
      await flushPromises();

      expect(restoreClosedTerminalsMock).not.toHaveBeenCalled();
    });

    it("does NOT relaunch on the partial-success path — the worktree directory is already gone", async () => {
      captureWorktreeTerminalSnapshotMock.mockReturnValueOnce(SNAPSHOT);
      let rejectIpc: (reason: unknown) => void = () => {};
      worktreeClientDeleteMock.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectIpc = reject;
          })
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { closeTerminals: true, deleteBranch: true });
      await flushPromises();

      // Guard against a spurious pass: the delete IPC must actually be in flight
      // before we simulate the removed-then-branch-failed ordering.
      expect(worktreeClientDeleteMock).toHaveBeenCalledTimes(1);

      // worktree-removed arrives before the branch-delete rejection.
      store.getState().applyRemove("wt-1", nextV());
      rejectIpc(
        new Error(
          "Worktree removed. Branch 'feature/x' was kept because Git reports it isn't fully merged."
        )
      );
      await flushPromises();
      await flushPromises();

      expect(restoreClosedTerminalsMock).not.toHaveBeenCalled();
    });

    it("leaves the worktree's surviving panels untouched on removal (ghost-row contract #11232)", () => {
      // applyRemove must NOT reap the worktree's panels — the deleted-worktree
      // ghost row keeps them alive until the user acts or the TTL trashes them.
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      const removeSpy = vi
        .spyOn(usePanelStore.getState(), "removePanel")
        .mockImplementation(() => {});
      usePanelStore.setState({ panelIdsByWorktreeId: { "wt-1": ["browser-1", "agent-1"] } });

      try {
        store.getState().applyRemove("wt-1", nextV());
        expect(removeSpy).not.toHaveBeenCalled();
      } finally {
        removeSpy.mockRestore();
        usePanelStore.setState({ panelIdsByWorktreeId: {} });
      }
    });
  });

  it("concurrent deletes for different worktrees do not leak state across rows", async () => {
    let resolveWt1: () => void = () => {};
    let rejectWt2: (err: Error) => void = () => {};
    worktreeClientDeleteMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWt1 = resolve;
        })
    );
    worktreeClientDeleteMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWt2 = reject;
        })
    );

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1"), makeSnapshot("wt-2")], nextV());

    store.getState().startDelete("wt-1", { force: false });
    store.getState().startDelete("wt-2", { force: true });

    expect(store.getState().deletingIds.has("wt-1")).toBe(true);
    expect(store.getState().deletingIds.has("wt-2")).toBe(true);

    // Let the pre-delete getByWorktree microtask resolve so the deferred
    // worktreeClient.delete mocks attach their resolvers/rejecters.
    await flushPromises();
    await flushPromises();

    rejectWt2(new Error("wt-2 failed"));
    await flushPromises();
    await flushPromises();

    expect(store.getState().deletingIds.has("wt-2")).toBe(false);
    expect(store.getState().deleteErrors.get("wt-2")).toContain("wt-2 failed");
    // wt-1 stays in flight — its row is not affected by wt-2's failure.
    expect(store.getState().deletingIds.has("wt-1")).toBe(true);
    expect(store.getState().deleteErrors.has("wt-1")).toBe(false);

    resolveWt1();
    store.getState().applyRemove("wt-1", nextV());
    expect(store.getState().deletingIds.has("wt-1")).toBe(false);
    // wt-2's error survives wt-1's removal.
    expect(store.getState().deleteErrors.get("wt-2")).toContain("wt-2 failed");
  });

  it("startDelete is idempotent — a second call while in flight does not fire a second IPC", async () => {
    let resolveDelete: () => void = () => {};
    worktreeClientDeleteMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        })
    );

    const store = createWorktreeStore();
    store.getState().startDelete("wt-1", { force: false });
    await flushPromises();
    store.getState().startDelete("wt-1", { force: true });
    await flushPromises();

    expect(worktreeClientDeleteMock).toHaveBeenCalledTimes(1);
    expect(worktreeClientDeleteMock).toHaveBeenCalledWith("wt-1", {
      force: false,
      deleteBranch: undefined,
      mutationId: expect.any(String),
    });

    resolveDelete();
    await flushPromises();
  });

  it("applyRemove still works for worktrees with no in-flight delete (no regression)", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().applyRemove("wt-1", nextV());

    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });
});
