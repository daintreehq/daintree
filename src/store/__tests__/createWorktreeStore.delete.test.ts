import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";

// Host-minted versions are now `(epoch, seq)` tuples (#8403). Tests mint a
// monotonic seq under a fixed epoch; each fresh store starts at epoch "" so
// the first non-empty epoch is always accepted as an epoch transition.
const TEST_EPOCH = "test-epoch";
const OTHER_EPOCH = "other-epoch";
let _seq = 0;
function nextV(epoch: string = TEST_EPOCH): WorktreeEventVersion {
  return { epoch, seq: ++_seq };
}

const {
  worktreeClientDeleteMock,
  worktreeClientAttachIssueMock,
  worktreeClientDetachIssueMock,
  captureWorktreeTerminalSnapshotMock,
  closeTerminalsForWorktreeMock,
  restoreClosedTerminalsMock,
  notifyMock,
  devPreviewGetByWorktreeMock,
  devPreviewStopByWorktreeMock,
  logErrorWithContextMock,
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
  worktreeClientAttachIssueMock:
    vi.fn<(payload: import("@shared/types").AttachIssuePayload) => Promise<void>>(),
  worktreeClientDetachIssueMock: vi.fn<(worktreeId: string) => Promise<void>>(),
  captureWorktreeTerminalSnapshotMock: vi.fn<(id: string) => unknown[]>(),
  closeTerminalsForWorktreeMock: vi.fn<(id: string) => Promise<void>>(),
  restoreClosedTerminalsMock: vi.fn<(snapshot: readonly unknown[]) => Promise<void>>(),
  notifyMock: vi.fn(),
  devPreviewGetByWorktreeMock: vi.fn().mockResolvedValue(null),
  devPreviewStopByWorktreeMock: vi.fn().mockResolvedValue(undefined),
  logErrorWithContextMock: vi.fn(),
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
      attachIssue: worktreeClientAttachIssueMock,
      detachIssue: worktreeClientDetachIssueMock,
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

// Partial: `createWorktreeStore` reaches for other `errorContext` exports, so
// the original module has to stay behind the one override.
vi.mock("@/utils/errorContext", async () => {
  const actual =
    await vi.importActual<typeof import("@/utils/errorContext")>("@/utils/errorContext");
  return { ...actual, logErrorWithContext: logErrorWithContextMock };
});

// Import after mocks so the store picks up the mocked deps.
import { createWorktreeStore, OUTBOX_RETRY_CAP } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { nestedWorktreeDeleteMessage } from "@shared/utils/nestedWorktrees";

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

  // #12418. The host stopped truncating git's stderr at the first newline, so
  // the renderer has to carry the rest of it through to the card unchanged —
  // the later lines are the ones that name the recovery.
  it("carries a multi-line failure through to deleteErrors intact", async () => {
    const stderr =
      "Worktree removed. Couldn't delete branch 'feature/x': error: Cannot delete branch 'feature/x' checked out at '/other/tree'\nhint: remove that worktree first";
    worktreeClientDeleteMock.mockRejectedValueOnce(new Error(stderr));

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: false });
    await flushPromises();
    await flushPromises();

    // Exact equality, not `toContain`: a substring check would still pass if the
    // renderer replaced the first line, which is the half of the message the
    // host fix exists to preserve.
    expect(store.getState().deleteErrors.get("wt-1")).toBe(stderr);
  });

  // #12418. Before this, a delete failure existed only on the card — dismiss it
  // and the error was gone everywhere, with nothing in `daintree.log` to go back
  // to. Asserted on both routing paths because the log call sits ahead of the
  // split: the partial-success path returns early and would miss a later one.
  it("logs a delete failure that still has a card to report on", async () => {
    const rejection = new Error("git error: unmerged paths");
    worktreeClientDeleteMock.mockRejectedValueOnce(rejection);

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: false, deleteBranch: true });
    await flushPromises();
    await flushPromises();

    expect(logErrorWithContextMock).toHaveBeenCalledTimes(1);
    const [loggedError, context] = logErrorWithContextMock.mock.calls[0]!;
    // The original error object, not a re-wrap — `classifyError` reads its
    // structured props, so identity is what makes the category right.
    expect(loggedError).toBe(rejection);
    expect(context).toMatchObject({
      operation: "delete_worktree",
      component: "createWorktreeStore",
    });
    // The delete call was reached, so the category is known rather than
    // inferred from text that happens to contain the branch name.
    expect((context as { errorType?: string }).errorType).toBe("git");
    // The mutationId is what ties this record to the host's own log line for
    // the same failure; without it the two records cannot be correlated.
    const sentMutationId = worktreeClientDeleteMock.mock.calls[0]![1].mutationId;
    expect(sentMutationId).toBeDefined();
    expect((context as { details: Record<string, unknown> }).details).toMatchObject({
      worktreeId: "wt-1",
      deleteBranch: true,
      mutationId: sentMutationId,
    });
  });

  it("logs a delete failure whose card is already gone", async () => {
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

    // `worktree-removed` lands before the branch step fails, so the card the
    // error would have gone on is already cleared.
    store.getState().applyRemove("wt-1", nextV());
    const rejection = new Error("Worktree removed. Couldn't delete branch 'feature/x': locked ref");
    rejectIpc(rejection);
    await flushPromises();
    await flushPromises();

    expect(store.getState().deleteErrors.has("wt-1")).toBe(false);
    expect(logErrorWithContextMock).toHaveBeenCalledTimes(1);
    const [loggedError, context] = logErrorWithContextMock.mock.calls[0]!;
    expect(loggedError).toBe(rejection);
    const sentMutationId = worktreeClientDeleteMock.mock.calls[0]![1].mutationId;
    expect(context).toMatchObject({
      operation: "delete_worktree",
      component: "createWorktreeStore",
      details: expect.objectContaining({ worktreeId: "wt-1", mutationId: sentMutationId }),
    });
  });

  // A branch name is part of the failure message, and `classifyError` matches
  // "fetch" before it matches "branch" — so left to the text alone, deleting
  // `feature/fetch` would be filed as a network fault. The stage knows better.
  it("files a delete failure as git even when the branch name reads as another category", async () => {
    worktreeClientDeleteMock.mockRejectedValueOnce(
      new Error("Worktree removed. Couldn't delete branch 'feature/fetch': locked ref")
    );

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: false, deleteBranch: true });
    await flushPromises();
    await flushPromises();

    expect(logErrorWithContextMock.mock.calls[0]![1]).toMatchObject({ errorType: "git" });
  });

  // The mirror of the case above: a failure BEFORE the delete call is not a git
  // failure, so it must not be labelled one.
  it("leaves a pre-delete failure to classifyError rather than calling it git", async () => {
    closeTerminalsForWorktreeMock.mockRejectedValueOnce(new Error("terminal close timed out"));
    captureWorktreeTerminalSnapshotMock.mockReturnValueOnce([{ id: "t-1" }]);

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: false, closeTerminals: true });
    await flushPromises();
    await flushPromises();

    expect(worktreeClientDeleteMock).not.toHaveBeenCalled();
    expect(logErrorWithContextMock).toHaveBeenCalledTimes(1);
    expect(
      (logErrorWithContextMock.mock.calls[0]![1] as { errorType?: string }).errorType
    ).toBeUndefined();
  });

  it("does not log when the delete succeeds", async () => {
    worktreeClientDeleteMock.mockResolvedValueOnce();

    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: false });
    await flushPromises();
    await flushPromises();

    expect(logErrorWithContextMock).not.toHaveBeenCalled();
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
      suppressWhenOriginVisible?: boolean;
    };
    expect(payload.type).toBe("error");
    expect(payload.title).toContain("branch");
    expect(payload.message).toContain("Couldn't delete branch");
    // The deleted worktree's id still files the outcome under it in the inbox;
    // the address no longer gates delivery, so the toast still surfaces.
    expect(payload.context.worktreeId).toBe("wt-1");
    expect(payload.suppressWhenOriginVisible).toBeUndefined();
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
});

describe("createWorktreeStore — nested worktree refusal (#12789)", () => {
  beforeEach(() => {
    worktreeClientDeleteMock.mockReset();
    captureWorktreeTerminalSnapshotMock.mockReset().mockReturnValue([]);
    closeTerminalsForWorktreeMock.mockReset().mockResolvedValue();
    restoreClosedTerminalsMock.mockReset().mockResolvedValue();
    devPreviewGetByWorktreeMock.mockReset().mockResolvedValue(null);
    devPreviewStopByWorktreeMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("treats the host's refusal as permanent and brings the closed terminals back", async () => {
    const snapshot = [{ id: "t-1", location: "grid" }];
    captureWorktreeTerminalSnapshotMock.mockReturnValueOnce(snapshot);
    worktreeClientDeleteMock.mockRejectedValueOnce(
      new Error(nestedWorktreeDeleteMessage(["/repo/wt-1/child"]))
    );
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { closeTerminals: true, force: true });
    await flushPromises();
    await flushPromises();

    const entry = [...store.getState().mutationOutbox.values()][0];
    expect(entry?.status).toBe("failed");
    expect(store.getState().deleteErrors.get("wt-1")).toContain("/repo/wt-1/child");
    expect(restoreClosedTerminalsMock).toHaveBeenCalledWith(snapshot);
  });

  it("does not read an unrelated error that merely mentions a registered worktree as permanent", async () => {
    worktreeClientDeleteMock.mockRejectedValue(
      new Error("fatal: cannot lock ref in /repo/registered worktree/wt-1")
    );
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().startDelete("wt-1", { force: true });
    await flushPromises();
    await flushPromises();

    const entry = [...store.getState().mutationOutbox.values()][0];
    expect(entry?.status).toBe("pending");
    expect(entry?.retryCount).toBe(1);
  });
});

// Mutation-outbox tests (#8405). Covers the lifecycle of `mutationOutbox`
// entries: creation, replay-after-reconnect (target-present vs target-already-gone),
// ack pruning via `pruneAcknowledgedMutations`, error classification
// (permanent / connectivity / generic with retry cap), `retryOutboxEntry` /
// `dismissOutboxEntry`, and survival across `setFatalError`.
describe("createWorktreeStore — mutation outbox (#8405)", () => {
  beforeEach(() => {
    worktreeClientDeleteMock.mockReset();
    worktreeClientAttachIssueMock.mockReset();
    worktreeClientDetachIssueMock.mockReset();
    captureWorktreeTerminalSnapshotMock.mockReset();
    closeTerminalsForWorktreeMock.mockReset();
    restoreClosedTerminalsMock.mockReset();
    notifyMock.mockReset();
    worktreeClientDeleteMock.mockResolvedValue();
    worktreeClientAttachIssueMock.mockResolvedValue();
    worktreeClientDetachIssueMock.mockResolvedValue();
    captureWorktreeTerminalSnapshotMock.mockReturnValue([]);
    closeTerminalsForWorktreeMock.mockResolvedValue();
    restoreClosedTerminalsMock.mockResolvedValue();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("entry creation + success path", () => {
    it("startDelete creates one in-flight entry with a fresh mutationId", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: true, deleteBranch: false });

      const outbox = store.getState().mutationOutbox;
      expect(outbox.size).toBe(1);
      const entry = [...outbox.values()][0]!;
      expect(entry.worktreeId).toBe("wt-1");
      expect(entry.type).toBe("delete-worktree");
      expect(entry.status).toBe("in-flight");
      expect(entry.retryCount).toBe(0);
      if (entry.type !== "delete-worktree") throw new Error("expected delete entry");
      expect(entry.options).toEqual({ force: true, deleteBranch: false });
      expect(typeof entry.mutationId).toBe("string");
      expect(entry.mutationId.length).toBeGreaterThan(0);

      // Drain the IPC promise so it doesn't leak across tests.
      await flushPromises();
      await flushPromises();
    });

    it("applyRemove prunes the matching outbox entry on the success path", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      expect(store.getState().mutationOutbox.size).toBe(1);

      // Simulate the `worktree-removed` event firing applyRemove.
      store.getState().applyRemove("wt-1", nextV());

      expect(store.getState().mutationOutbox.size).toBe(0);
      // Drain IPC.
      await flushPromises();
      await flushPromises();
    });

    it("on resolved IPC, success branch prunes the outbox entry", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      // No worktree-removed event yet, but IPC resolved successfully:
      // pruneOutboxEntry should have removed the entry.
      expect(store.getState().mutationOutbox.size).toBe(0);
    });
  });

  describe("error classification", () => {
    it("permanent errors flip the entry to failed in a single attempt", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("Worktree has uncommitted changes. Use force delete to proceed.")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("failed");
      // Permanent classification does NOT charge the retry counter — the failure
      // is deterministic, not a flake.
      expect(entry.retryCount).toBe(0);
      expect(entry.lastError).toContain("uncommitted changes");
      expect(store.getState().deleteErrors.get("wt-1")).toContain("uncommitted changes");
    });

    it("generic errors retry up to the cap before failing", async () => {
      worktreeClientDeleteMock.mockRejectedValue(new Error("git error: ref already exists"));

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      let entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("pending");
      expect(entry.retryCount).toBe(1);

      // Re-fire via retryDelete (path the card's Retry button uses today).
      store.getState().retryDelete("wt-1");
      await flushPromises();
      await flushPromises();
      entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.retryCount).toBe(2);
      expect(entry.status).toBe("pending");

      store.getState().retryDelete("wt-1");
      await flushPromises();
      await flushPromises();
      entry = [...store.getState().mutationOutbox.values()][0]!;
      // Cap is OUTBOX_RETRY_CAP — third generic failure flips to failed.
      expect(entry.retryCount).toBe(OUTBOX_RETRY_CAP);
      expect(entry.status).toBe("failed");
    });

    it("restores closed terminals only when generic retries exhaust the cap, using the FIRST snapshot (#11344)", async () => {
      worktreeClientDeleteMock.mockRejectedValue(new Error("git error: ref already exists"));
      const FIRST_SNAPSHOT = [{ id: "t-1", location: "grid" }];
      const LATER_SNAPSHOT = [{ id: "t-2", location: "grid" }];
      // The first attempt captures the real terminals; a later capture (e.g. the
      // user opened a new terminal mid-retry) must NOT clobber the held snapshot.
      captureWorktreeTerminalSnapshotMock
        .mockReturnValueOnce(FIRST_SNAPSHOT)
        .mockReturnValue(LATER_SNAPSHOT);

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { closeTerminals: true, force: false });
      await flushPromises();
      await flushPromises();
      // Still pending (retry 1) — do not relaunch yet.
      expect(restoreClosedTerminalsMock).not.toHaveBeenCalled();

      for (let attempt = 1; attempt < OUTBOX_RETRY_CAP; attempt++) {
        store.getState().retryDelete("wt-1");
        await flushPromises();
        await flushPromises();
      }

      // Cap reached → failed → relaunch exactly once, with the FIRST capture
      // (later non-empty captures never overwrote it).
      expect([...store.getState().mutationOutbox.values()][0]!.status).toBe("failed");
      expect(restoreClosedTerminalsMock).toHaveBeenCalledTimes(1);
      expect(restoreClosedTerminalsMock).toHaveBeenCalledWith(FIRST_SNAPSHOT);
    });

    it("connectivity errors leave entry pending and DO NOT charge the retry cap", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("pending");
      expect(entry.retryCount).toBe(0);
      // Card stays clean — global reconnect indicator covers the failure.
      expect(store.getState().deletingIds.has("wt-1")).toBe(false);
      expect(store.getState().deleteErrors.has("wt-1")).toBe(false);
    });
  });

  describe("setFatalError preservation", () => {
    it("setFatalError preserves the mutation outbox", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const beforeEntry = [...store.getState().mutationOutbox.values()][0]!;
      expect(beforeEntry).toBeDefined();

      store.getState().setFatalError("Workspace service crashed and could not recover");

      // Outbox survives the fatal error so a manual restart can replay it.
      const afterEntry = store.getState().mutationOutbox.get(beforeEntry.mutationId);
      expect(afterEntry).toBeDefined();
      expect(afterEntry?.mutationId).toBe(beforeEntry.mutationId);
      expect(afterEntry?.status).toBe("pending");
      // manualAssociations is still cleared (regression guard against the
      // existing setFatalError behavior).
      expect(store.getState().manualAssociations.size).toBe(0);
    });

    it("replay fires after setFatalError + manual restart even though isInitialized is false (#8405 review #2)", async () => {
      // Reproduce the post-fatal-restart sequence: outbox entry stays
      // `pending` through `setFatalError`; the WorktreeStoreContext's
      // post-restart `fetchInitialState` then captures `isWake = false`
      // (because setFatalError reset isInitialized). The replay path must
      // still fire when there are outbox entries to drain — otherwise the
      // preserved outbox is inert and the user's pending delete is silently
      // abandoned.
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("pending");

      // Simulate the fatal-disconnect + manual restart cycle.
      store.getState().setFatalError("Workspace service crashed");
      expect(store.getState().isInitialized).toBe(false);
      expect(store.getState().mutationOutbox.size).toBe(1);

      // Post-restart hydration: snapshot still has wt-1 because the original
      // delete never actually ran.
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(OTHER_EPOCH));

      // The replay must fire — the gate in WorktreeStoreContext is
      // `isWake || mutationOutbox.size > 0`, so even with isWake=false the
      // pending entry replays.
      worktreeClientDeleteMock.mockResolvedValueOnce();
      store.getState().replayOutboxAfterReconnect();
      await flushPromises();
      await flushPromises();

      const lastCallId = worktreeClientDeleteMock.mock.calls.at(-1)![1].mutationId;
      expect(lastCallId).toBe(entry.mutationId);
    });
  });

  describe("pruneAcknowledgedMutations", () => {
    it("removes matching entries by mutationId", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1"), makeSnapshot("wt-2")], nextV());

      worktreeClientDeleteMock.mockRejectedValue(
        new Error("HOST_EXITED: Worktree port disconnected")
      );
      store.getState().startDelete("wt-1", { force: false });
      store.getState().startDelete("wt-2", { force: false });
      await flushPromises();
      await flushPromises();

      const entries = [...store.getState().mutationOutbox.values()];
      expect(entries.length).toBe(2);
      const wt1Id = entries.find((e) => e.worktreeId === "wt-1")!.mutationId;

      store.getState().pruneAcknowledgedMutations([wt1Id]);

      expect(store.getState().mutationOutbox.size).toBe(1);
      expect([...store.getState().mutationOutbox.values()][0]!.worktreeId).toBe("wt-2");
    });

    it("an empty ack list is a no-op", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );
      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const before = store.getState().mutationOutbox;
      store.getState().pruneAcknowledgedMutations([]);
      // Identity-equal — no churn.
      expect(store.getState().mutationOutbox).toBe(before);
    });

    it("clears deletingIds for every pruned worktree, not just the last (#8405 review #3)", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1"), makeSnapshot("wt-2")], nextV());

      // Hold both IPCs open so both cards stay in `deletingIds` when we ack.
      const resolvers: Array<() => void> = [];
      worktreeClientDeleteMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          })
      );
      store.getState().startDelete("wt-1", { force: false });
      store.getState().startDelete("wt-2", { force: false });
      await flushPromises();
      const entries = [...store.getState().mutationOutbox.values()];
      const ids = entries.map((e) => e.mutationId);
      expect(store.getState().deletingIds.has("wt-1")).toBe(true);
      expect(store.getState().deletingIds.has("wt-2")).toBe(true);

      store.getState().pruneAcknowledgedMutations(ids);

      // Both cards must be cleaned up — not just the last one in iteration order.
      expect(store.getState().mutationOutbox.size).toBe(0);
      expect(store.getState().deletingIds.has("wt-1")).toBe(false);
      expect(store.getState().deletingIds.has("wt-2")).toBe(false);

      // Drain the open IPCs.
      for (const r of resolvers) r();
      await flushPromises();
    });
  });

  describe("replayOutboxAfterReconnect", () => {
    it("re-fires pending entries whose target still exists in the snapshot", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );
      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("pending");

      // Simulate the reconnect snapshot — wt-1 is still on disk.
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(OTHER_EPOCH));

      worktreeClientDeleteMock.mockResolvedValueOnce();
      store.getState().replayOutboxAfterReconnect();

      // Replay flipped to in-flight before firing.
      const flipped = [...store.getState().mutationOutbox.values()][0]!;
      expect(flipped.status).toBe("in-flight");
      expect(flipped.mutationId).toBe(entry.mutationId);

      await flushPromises();
      await flushPromises();

      // The replay used the original mutationId.
      const lastCallId = worktreeClientDeleteMock.mock.calls.at(-1)![1].mutationId;
      expect(lastCallId).toBe(entry.mutationId);
    });

    it("reconciles pending entries whose target is absent from the snapshot (success-but-ack-lost)", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("HOST_EXITED: Worktree port disconnected")
      );
      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();

      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("pending");

      // Host restarted — fresh epoch and wt-1 is gone (delete completed before
      // the crash but the ack never reached the renderer).
      store.getState().applySnapshot([], nextV(OTHER_EPOCH));
      store.getState().replayOutboxAfterReconnect();

      // The entry is pruned, no replay was fired.
      expect(store.getState().mutationOutbox.size).toBe(0);
      // No new IPC call from the replay path — only the original failure.
      expect(worktreeClientDeleteMock).toHaveBeenCalledTimes(1);
    });

    it("does not re-fire `in-flight` entries (#8405 review #4 — double-replay suppression)", async () => {
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      // Hold the IPC open so the entry stays `in-flight` while we trigger a
      // second replay sweep.
      let resolveFirst: () => void = () => {};
      worktreeClientDeleteMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          })
      );
      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      expect([...store.getState().mutationOutbox.values()][0]!.status).toBe("in-flight");

      // A spurious second sweep before the first IPC settles must not fire a
      // duplicate delete.
      store.getState().replayOutboxAfterReconnect();
      await flushPromises();
      expect(worktreeClientDeleteMock).toHaveBeenCalledTimes(1);

      // Drain.
      resolveFirst();
      await flushPromises();
    });

    it("does not re-fire `failed` entries", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("Worktree has uncommitted changes. Use force delete to proceed.")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();
      expect([...store.getState().mutationOutbox.values()][0]!.status).toBe("failed");

      worktreeClientDeleteMock.mockClear();
      store.getState().replayOutboxAfterReconnect();
      await flushPromises();
      await flushPromises();

      expect(worktreeClientDeleteMock).not.toHaveBeenCalled();
      expect([...store.getState().mutationOutbox.values()][0]!.status).toBe("failed");
    });
  });

  describe("retryOutboxEntry / dismissOutboxEntry", () => {
    it("retryOutboxEntry resets retryCount and re-fires", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("Worktree has uncommitted changes. Use force delete to proceed.")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();
      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("failed");

      worktreeClientDeleteMock.mockResolvedValueOnce();
      store.getState().retryOutboxEntry(entry.mutationId);

      const flipped = store.getState().mutationOutbox.get(entry.mutationId)!;
      expect(flipped.status).toBe("in-flight");
      expect(flipped.retryCount).toBe(0);
      expect(flipped.lastError).toBeUndefined();

      await flushPromises();
      await flushPromises();
      expect(worktreeClientDeleteMock).toHaveBeenLastCalledWith("wt-1", {
        force: false,
        deleteBranch: undefined,
        mutationId: entry.mutationId,
      });
    });

    it("retryOutboxEntry on an unknown mutationId is a no-op", () => {
      const store = createWorktreeStore();
      store.getState().retryOutboxEntry("does-not-exist");
      expect(store.getState().mutationOutbox.size).toBe(0);
      expect(worktreeClientDeleteMock).not.toHaveBeenCalled();
    });

    it("dismissOutboxEntry removes the entry and clears the card error", async () => {
      worktreeClientDeleteMock.mockRejectedValueOnce(
        new Error("Worktree has uncommitted changes. Use force delete to proceed.")
      );

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startDelete("wt-1", { force: false });
      await flushPromises();
      await flushPromises();
      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(store.getState().deleteErrors.get("wt-1")).toContain("uncommitted changes");

      store.getState().dismissOutboxEntry(entry.mutationId);

      expect(store.getState().mutationOutbox.size).toBe(0);
      expect(store.getState().deleteErrors.has("wt-1")).toBe(false);
      expect(store.getState().deleteErrorArgs.has("wt-1")).toBe(false);
    });

    // #12087 — the banner carrying this Dismiss only became clickable on
    // sidebar cards with that fix, which makes the stale-click window real: a
    // reconnect replay flips an entry to `in-flight` without clearing the
    // banner, so Dismiss can land on a mutation that is still running. Pruning
    // it there would make the success handler discard a write the host had
    // already committed.
    it("dismissOutboxEntry keeps an in-flight issue entry so its result still applies", async () => {
      worktreeClientAttachIssueMock.mockRejectedValueOnce(new Error("network blip"));

      const store = createWorktreeStore();
      store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

      store.getState().startAttachIssue({
        worktreeId: "wt-1",
        issueNumber: 42,
        issueTitle: "Issue 42",
      });
      await flushPromises();
      await flushPromises();
      expect(store.getState().issueErrors.has("wt-1")).toBe(true);

      let settleAttach: () => void = () => {};
      worktreeClientAttachIssueMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settleAttach = resolve;
          })
      );
      store.getState().replayOutboxAfterReconnect();
      await flushPromises();

      const entry = [...store.getState().mutationOutbox.values()][0]!;
      expect(entry.status).toBe("in-flight");

      store.getState().dismissOutboxEntry(entry.mutationId);

      // Banner goes; the live mutation and its in-flight guard do not.
      expect(store.getState().issueErrors.has("wt-1")).toBe(false);
      expect(store.getState().mutationOutbox.has(entry.mutationId)).toBe(true);

      // The host commits the write, so the renderer must still record it.
      settleAttach();
      await flushPromises();
      await flushPromises();
      expect(store.getState().manualAssociations.get("wt-1")?.issueNumber).toBe(42);
    });
  });

  describe("issue-association mutations (#9163)", () => {
    const attachPayload = (worktreeId: string, issueNumber = 42) => ({
      worktreeId,
      issueNumber,
      issueTitle: `Issue ${issueNumber}`,
    });

    describe("entry creation + success path", () => {
      it("startAttachIssue creates one in-flight attach entry", () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        store.getState().startAttachIssue(attachPayload("wt-1"));

        const outbox = store.getState().mutationOutbox;
        expect(outbox.size).toBe(1);
        const entry = [...outbox.values()][0]!;
        expect(entry.type).toBe("attach-issue");
        expect(entry.worktreeId).toBe("wt-1");
        expect(entry.status).toBe("in-flight");
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(true);
        // The local association is NOT applied yet — pessimistic ordering means
        // the renderer never gets ahead of the Electron-store write.
        expect(store.getState().manualAssociations.has("wt-1")).toBe(false);
      });

      it("on resolved attach IPC, applies the association and prunes the entry", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        store.getState().startAttachIssue(attachPayload("wt-1", 7));
        await flushPromises();
        await flushPromises();

        expect(worktreeClientAttachIssueMock).toHaveBeenCalledWith(attachPayload("wt-1", 7));
        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
        // Now the association is applied (post-success).
        expect(store.getState().manualAssociations.get("wt-1")).toEqual({
          issueNumber: 7,
          issueTitle: "Issue 7",
        });
        expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(7);
      });

      it("on resolved detach IPC, clears the association and prunes the entry", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        // Seed an attached issue.
        store.getState().startAttachIssue(attachPayload("wt-1", 9));
        await flushPromises();
        await flushPromises();
        expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(9);

        store.getState().startDetachIssue("wt-1");
        await flushPromises();
        await flushPromises();

        expect(worktreeClientDetachIssueMock).toHaveBeenCalledWith("wt-1");
        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().manualAssociations.has("wt-1")).toBe(false);
        expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBeUndefined();
      });
    });

    describe("single-flight guard", () => {
      it("blocks a second attach while one is in flight", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        let resolveFirst: () => void = () => {};
        worktreeClientAttachIssueMock.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve;
            })
        );
        store.getState().startAttachIssue(attachPayload("wt-1", 1));
        await flushPromises();
        store.getState().startAttachIssue(attachPayload("wt-1", 2));

        // Second call is a no-op — still one in-flight entry, one IPC.
        expect(store.getState().mutationOutbox.size).toBe(1);
        expect(worktreeClientAttachIssueMock).toHaveBeenCalledTimes(1);

        resolveFirst();
        await flushPromises();
      });

      it("shares the key with detach so attach then detach can't interleave", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        let resolveAttach: () => void = () => {};
        worktreeClientAttachIssueMock.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveAttach = resolve;
            })
        );
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        store.getState().startDetachIssue("wt-1");

        // Detach is blocked while the attach is in flight.
        expect(worktreeClientDetachIssueMock).not.toHaveBeenCalled();
        const entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(entry.type).toBe("attach-issue");

        resolveAttach();
        await flushPromises();
      });
    });

    describe("error classification", () => {
      it("connectivity errors leave the entry pending with no banner", async () => {
        worktreeClientAttachIssueMock.mockRejectedValueOnce(
          new Error("HOST_EXITED: Worktree port disconnected")
        );

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();

        const entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(entry.status).toBe("pending");
        expect(entry.retryCount).toBe(0);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
        expect(store.getState().issueErrors.has("wt-1")).toBe(false);
      });

      it("generic errors retry up to the cap then flip to failed with a banner", async () => {
        worktreeClientAttachIssueMock.mockRejectedValue(new Error("network blip"));

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();

        let entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(entry.status).toBe("pending");
        expect(entry.retryCount).toBe(1);
        // Banner shows immediately, even while still retry-eligible.
        expect(store.getState().issueErrors.get("wt-1")?.type).toBe("attach-issue");

        store.getState().retryOutboxEntry(entry.mutationId);
        await flushPromises();
        await flushPromises();
        // Banner-driven retry resets the budget to 0, so this counts as 1.
        entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(entry.retryCount).toBe(1);
        expect(entry.status).toBe("pending");
      });

      it("flips to failed once the retry cap is reached", async () => {
        worktreeClientAttachIssueMock.mockRejectedValue(new Error("network blip"));

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        // Drive cap consecutive failures via reconnect replays (which keep the
        // budget — only user retries reset it).
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();
        for (let i = 1; i < OUTBOX_RETRY_CAP; i++) {
          store.getState().replayOutboxAfterReconnect();
          await flushPromises();
          await flushPromises();
        }

        const entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(entry.retryCount).toBe(OUTBOX_RETRY_CAP);
        expect(entry.status).toBe("failed");
        expect(store.getState().issueErrors.get("wt-1")?.message).toContain("network blip");
      });
    });

    describe("setFatalError + replay", () => {
      it("preserves issue entries across setFatalError", async () => {
        worktreeClientAttachIssueMock.mockRejectedValueOnce(
          new Error("HOST_EXITED: Worktree port disconnected")
        );

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();

        const before = [...store.getState().mutationOutbox.values()][0]!;
        store.getState().setFatalError("Workspace service crashed");

        const after = store.getState().mutationOutbox.get(before.mutationId);
        expect(after).toBeDefined();
        expect(after?.type).toBe("attach-issue");
        expect(after?.status).toBe("pending");
      });

      it("replays a pending issue entry whose target still exists", async () => {
        worktreeClientAttachIssueMock.mockRejectedValueOnce(
          new Error("HOST_EXITED: Worktree port disconnected")
        );

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1", 5));
        await flushPromises();
        await flushPromises();
        expect([...store.getState().mutationOutbox.values()][0]!.status).toBe("pending");

        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(OTHER_EPOCH));
        worktreeClientAttachIssueMock.mockResolvedValueOnce();
        store.getState().replayOutboxAfterReconnect();
        await flushPromises();
        await flushPromises();

        // Replay succeeded — entry pruned, association applied.
        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(5);
      });

      it("reconciles (prunes) a pending issue entry whose target is gone", async () => {
        worktreeClientAttachIssueMock.mockRejectedValueOnce(
          new Error("HOST_EXITED: Worktree port disconnected")
        );

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();

        store.getState().applySnapshot([], nextV(OTHER_EPOCH));
        store.getState().replayOutboxAfterReconnect();

        expect(store.getState().mutationOutbox.size).toBe(0);
        // Only the original failed call — no replay was fired for the gone target.
        expect(worktreeClientAttachIssueMock).toHaveBeenCalledTimes(1);
      });
    });

    describe("retry / dismiss / removal", () => {
      it("retryOutboxEntry re-fires a failed issue entry", async () => {
        worktreeClientAttachIssueMock.mockRejectedValue(new Error("network blip"));

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();
        const entry = [...store.getState().mutationOutbox.values()][0]!;

        worktreeClientAttachIssueMock.mockResolvedValueOnce();
        store.getState().retryOutboxEntry(entry.mutationId);
        expect(store.getState().mutationOutbox.get(entry.mutationId)?.status).toBe("in-flight");
        await flushPromises();
        await flushPromises();

        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueErrors.has("wt-1")).toBe(false);
      });

      it("dismissOutboxEntry removes the issue entry and clears the banner", async () => {
        worktreeClientAttachIssueMock.mockRejectedValue(new Error("network blip"));

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();
        const entry = [...store.getState().mutationOutbox.values()][0]!;
        expect(store.getState().issueErrors.has("wt-1")).toBe(true);

        store.getState().dismissOutboxEntry(entry.mutationId);

        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueErrors.has("wt-1")).toBe(false);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
      });

      it("applyRemove prunes issue entries and clears issue state", async () => {
        worktreeClientAttachIssueMock.mockRejectedValueOnce(new Error("network blip"));

        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();
        expect(store.getState().issueErrors.has("wt-1")).toBe(true);

        store.getState().applyRemove("wt-1", nextV());

        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueErrors.has("wt-1")).toBe(false);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
      });

      it("prunes both a delete and an issue entry for the same worktree", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        // A connectivity-failed attach left pending, plus an in-flight delete.
        worktreeClientAttachIssueMock.mockRejectedValueOnce(
          new Error("HOST_EXITED: Worktree port disconnected")
        );
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();
        await flushPromises();
        let resolveDelete: () => void = () => {};
        worktreeClientDeleteMock.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveDelete = resolve;
            })
        );
        store.getState().startDelete("wt-1", { force: false });
        await flushPromises();
        expect(store.getState().mutationOutbox.size).toBe(2);

        store.getState().applyRemove("wt-1", nextV());

        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().deletingIds.has("wt-1")).toBe(false);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);

        resolveDelete();
        await flushPromises();
      });
    });

    describe("supersession race (#9163 review)", () => {
      it("attach resolving after applyRemove leaves no orphaned manualAssociation", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        let resolveAttach: () => void = () => {};
        worktreeClientAttachIssueMock.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveAttach = resolve;
            })
        );
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();

        // Worktree removed while the attach IPC is still outstanding.
        store.getState().applyRemove("wt-1", nextV());
        expect(store.getState().mutationOutbox.size).toBe(0);

        // The IPC now resolves — the success path must NOT resurrect state.
        resolveAttach();
        await flushPromises();
        await flushPromises();

        expect(store.getState().manualAssociations.has("wt-1")).toBe(false);
        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
      });

      it("attach rejecting after applyRemove leaves no orphaned issueError", async () => {
        const store = createWorktreeStore();
        store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

        let rejectAttach: (e: Error) => void = () => {};
        worktreeClientAttachIssueMock.mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectAttach = reject;
            })
        );
        store.getState().startAttachIssue(attachPayload("wt-1"));
        await flushPromises();

        store.getState().applyRemove("wt-1", nextV());
        expect(store.getState().mutationOutbox.size).toBe(0);

        rejectAttach(new Error("network blip"));
        await flushPromises();
        await flushPromises();

        expect(store.getState().issueErrors.has("wt-1")).toBe(false);
        expect(store.getState().mutationOutbox.size).toBe(0);
        expect(store.getState().issueMutatingIds.has("wt-1")).toBe(false);
      });
    });
  });
});
