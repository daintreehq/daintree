import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IpcContext } from "../../types.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
const broadcastMock = vi.hoisted(() => vi.fn());
const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn<(id: string) => { path: string } | undefined>(() => undefined),
}));
type StatesResult =
  | { status: "ok"; projectId: string; states: Array<{ id: string; path: string }> }
  | { status: "unavailable"; reason: string };
const workspaceClientMock = vi.hoisted(() => ({
  getAllStatesForProjectResultAsync: vi.fn<
    (projectPath: string, projectId: string) => Promise<StatesResult>
  >(async () => ({ status: "unavailable", reason: "project-unavailable" })),
}));
const serviceRefsMock = vi.hoisted(() => ({
  getWorkspaceClientRef: vi.fn((): unknown => workspaceClientMock),
}));
const leaseMock = vi.hoisted(() => ({
  mayWriteProjectState: vi.fn<(projectId: string, getEndpoint: () => unknown) => boolean>(
    () => true
  ),
}));
const identityMock = vi.hoisted(() => ({
  readWorktreeIdentity: vi.fn(),
}));
const captureMock = vi.hoisted(() => ({
  captureReviewPoint: vi.fn(),
}));
const comparisonsMock = vi.hoisted(() => ({
  compare: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock, app: { getPath: () => os.tmpdir() } }));
vi.mock("../../utils.js", async (importActual) => ({
  ...(await importActual<object>()),
  broadcastToProjectRenderers: broadcastMock,
}));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../../window/serviceRefs.js", () => serviceRefsMock);
vi.mock("../../../services/DriveLeaseService.js", () => leaseMock);
vi.mock("../../../services/git/reviewPoint/readWorktreeIdentity.js", async (importActual) => ({
  ...(await importActual<object>()),
  readWorktreeIdentity: identityMock.readWorktreeIdentity,
}));
vi.mock("../../../services/git/reviewPoint/captureReviewPoint.js", async (importActual) => ({
  ...(await importActual<object>()),
  captureReviewPoint: captureMock.captureReviewPoint,
}));
vi.mock("../../../services/git/reviewPoint/reviewComparisons.js", () => ({
  reviewComparisons: comparisonsMock,
}));

import { CHANNELS } from "../../channels.js";
import {
  _settleReviewMarkPrunesForTesting,
  registerReviewMarksHandlers,
  reviewMarksNamespace,
} from "../reviewMarks.js";
import { ReviewMarkStore, _setReviewMarkStoreForTesting } from "../../../services/reviewMarks.js";
import { reviewPointCaptures } from "../../../services/reviewPointCaptures.js";
import { getProjectStateDir } from "../../../services/projectStorePaths.js";
import type { WorktreeIdentity } from "../../../services/git/reviewPoint/readWorktreeIdentity.js";
import type { ReviewPoint } from "../../../../shared/types/reviewPoint.js";
import type {
  ReviewMarkCaptureOutcome,
  ReviewMarkClearOutcome,
  ReviewMarkCompareOutcome,
  ReviewMarkSaveOutcome,
  ReviewMarksSnapshot,
} from "../../../../shared/types/ipc/reviewMarks.js";
import type { ReviewComparisonResult } from "../../../../shared/types/reviewComparison.js";

const PROJECT_A = "a".repeat(64);
const ROOT_A = path.resolve("/repos/alpha");
const WT_1 = path.join(ROOT_A, "feature-1");
const WT_2 = path.join(ROOT_A, "feature-2");
const COMMIT = "1".repeat(40);

type HydrateHandler = (context: IpcContext) => Promise<ReviewMarksSnapshot | null>;
type MarkHandler = (
  context: IpcContext,
  worktreeId: string,
  point: unknown,
  basedOn: number
) => Promise<ReviewMarkSaveOutcome>;
type ClearHandler = (
  context: IpcContext,
  worktreeId: string,
  basedOn: number
) => Promise<ReviewMarkClearOutcome>;

type CaptureHandler = (context: IpcContext, worktreeId: string) => Promise<ReviewMarkCaptureOutcome>;
type MarkCapturedHandler = (
  context: IpcContext,
  worktreeId: string,
  captureId: string,
  basedOn: number
) => Promise<ReviewMarkSaveOutcome>;
type CompareHandler = (context: IpcContext, worktreeId: string) => Promise<ReviewMarkCompareOutcome>;

const hydrate = reviewMarksNamespace.ops.hydrate.handler as unknown as HydrateHandler;
const mark = reviewMarksNamespace.ops.mark.handler as unknown as MarkHandler;
const clear = reviewMarksNamespace.ops.clear.handler as unknown as ClearHandler;
const capture = reviewMarksNamespace.ops.capture.handler as unknown as CaptureHandler;
const markCaptured = reviewMarksNamespace.ops.markCaptured
  .handler as unknown as MarkCapturedHandler;
const compare = reviewMarksNamespace.ops.compare.handler as unknown as CompareHandler;

function ctx(projectId: string | null, endpointId = "view-1"): IpcContext {
  return {
    projectId,
    client: { kind: "local" },
    endpoint: { kind: "local-view", endpointId, clientId: "local" },
  } as unknown as IpcContext;
}

function point(worktreeId: string, overrides: Partial<ReviewPoint> = {}): ReviewPoint {
  return {
    version: 1,
    capturedAt: 1_000,
    worktreePath: worktreeId,
    gitDir: path.join(ROOT_A, ".git", "worktrees", path.basename(worktreeId)),
    commonDir: path.join(ROOT_A, ".git"),
    objectFormat: "sha1",
    head: { kind: "branch", branch: path.basename(worktreeId), commit: COMMIT },
    base: { requested: { kind: "branch", branch: "main" }, ref: null, tip: null, mergeBases: [] },
    entries: [],
    incomplete: null,
    ...overrides,
  };
}

function identityOf(worktreeId: string, branch = path.basename(worktreeId)): WorktreeIdentity {
  return {
    worktreePath: worktreeId,
    gitDir: path.join(ROOT_A, ".git", "worktrees", path.basename(worktreeId)),
    commonDir: path.join(ROOT_A, ".git"),
    headRef: `refs/heads/${branch}`,
  };
}

function liveWorktrees(...ids: string[]): void {
  projectStoreMock.getProjectById.mockReturnValue({ path: ROOT_A });
  workspaceClientMock.getAllStatesForProjectResultAsync.mockResolvedValue({
    status: "ok",
    projectId: PROJECT_A,
    states: ids.map((id) => ({ id, path: id })),
  });
}

function liveStates(states: Array<Record<string, unknown> & { id: string; path: string }>): void {
  projectStoreMock.getProjectById.mockReturnValue({ path: ROOT_A });
  workspaceClientMock.getAllStatesForProjectResultAsync.mockResolvedValue({
    status: "ok",
    projectId: PROJECT_A,
    states,
  });
}

const COMPARABLE: ReviewComparisonResult = {
  state: "comparable",
  comparedAt: 5_000,
  head: { kind: "branch", branch: "feature-1", commit: COMMIT },
  base: {
    reviewed: { ref: null, tip: null, mergeBases: [] },
    current: { ref: null, tip: null, mergeBases: [] },
  },
  files: [],
  commits: { kind: "listed", history: "extended", commits: [], truncated: false },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let root: string;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "review-marks-ipc-"));
  _setReviewMarkStoreForTesting(new ReviewMarkStore(root, { now: () => 0 }));
  serviceRefsMock.getWorkspaceClientRef.mockReturnValue(workspaceClientMock);
  leaseMock.mayWriteProjectState.mockReturnValue(true);
  identityMock.readWorktreeIdentity.mockImplementation(async (cwd: string) => identityOf(cwd));
  liveWorktrees(WT_1, WT_2);
});

afterEach(async () => {
  await _settleReviewMarkPrunesForTesting();
  _setReviewMarkStoreForTesting(null);
  reviewPointCaptures.clear();
  await fs.rm(root, { recursive: true, force: true });
});

describe("reviewMarks IPC namespace", () => {
  it("answers an unbound sender with null so the view reads again", async () => {
    expect(await hydrate(ctx(null))).toBeNull();
  });

  it("stores the point it was handed and tells every view of the project", async () => {
    const outcome = await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);

    expect(outcome.status).toBe("saved");
    expect(outcome.snapshot.marks[WT_1]).toMatchObject({ capturedAt: 1_000, revision: 1 });
    expect(broadcastMock).toHaveBeenCalledWith(
      PROJECT_A,
      CHANNELS.REVIEW_MARKS_CHANGED,
      outcome.snapshot
    );
    expect(identityMock.readWorktreeIdentity).toHaveBeenCalledWith(WT_1, expect.anything());
  });

  it("lets two views of one project agree, the later start losing", async () => {
    const viewA = ctx(PROJECT_A, "view-a");
    const viewB = ctx(PROJECT_A, "view-b");
    // Both start from revision 0; A lands first.
    const fromA = await mark(viewA, WT_1, point(WT_1, { capturedAt: 2_000 }), 0);
    const fromB = await mark(viewB, WT_1, point(WT_1, { capturedAt: 1_500 }), 0);

    expect(fromA.status).toBe("saved");
    expect(fromB.status).toBe("stale");
    // B's reply carries A's mark, so B adopts it rather than its own.
    expect(fromB.snapshot).toEqual(fromA.snapshot);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(await hydrate(viewB)).toEqual(fromA.snapshot);
  });

  it("never brings back a mark cleared while the save was in flight", async () => {
    const first = await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);
    const identity = deferred<WorktreeIdentity>();
    identityMock.readWorktreeIdentity.mockReturnValueOnce(identity.promise);

    const saving = mark(ctx(PROJECT_A, "view-a"), WT_1, point(WT_1, { capturedAt: 3_000 }), 1);
    await vi.waitFor(() => expect(identityMock.readWorktreeIdentity).toHaveBeenCalledTimes(2));
    const cleared = await clear(ctx(PROJECT_A, "view-b"), WT_1, first.snapshot.revision);
    identity.resolve(identityOf(WT_1));

    expect(cleared.status).toBe("cleared");
    expect((await saving).status).toBe("stale");
    expect((await hydrate(ctx(PROJECT_A)))?.marks).toEqual({});
  });

  it("writes nothing when the drive lease moves while the save waits", async () => {
    const identity = deferred<WorktreeIdentity>();
    identityMock.readWorktreeIdentity.mockReturnValueOnce(identity.promise);
    const view = ctx(PROJECT_A, "old-driver");

    const saving = mark(view, WT_1, point(WT_1), 0);
    await vi.waitFor(() => expect(identityMock.readWorktreeIdentity).toHaveBeenCalled());
    // The lease is handed to another window before the write.
    leaseMock.mayWriteProjectState.mockImplementation(
      (_projectId, getEndpoint) =>
        (getEndpoint() as { endpointId: string }).endpointId !== "old-driver"
    );
    identity.resolve(identityOf(WT_1));

    await expect(saving).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    expect(broadcastMock).not.toHaveBeenCalled();
    expect((await hydrate(view))?.marks).toEqual({});
    expect(leaseMock.mayWriteProjectState).toHaveBeenCalledWith(PROJECT_A, expect.any(Function));
  });

  it("refuses a clear from a view that no longer drives the project", async () => {
    await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);
    leaseMock.mayWriteProjectState.mockReturnValue(false);
    await expect(clear(ctx(PROJECT_A), WT_1, 1)).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
    expect((await hydrate(ctx(PROJECT_A)))?.marks[WT_1]).toBeDefined();
  });

  it("gives a view coming back from a reconnect the marks it missed", async () => {
    const missed = await mark(ctx(PROJECT_A, "view-a"), WT_1, point(WT_1), 0);
    await mark(ctx(PROJECT_A, "view-a"), WT_2, point(WT_2), missed.snapshot.revision);
    // A remote view whose link dropped heard neither push; its re-read has both.
    const reread = await hydrate(ctx(PROJECT_A, "remote-view"));
    expect(Object.keys(reread?.marks ?? {}).sort()).toEqual([WT_1, WT_2]);
    expect(reread?.revision).toBe(2);
  });

  it.each([
    ["repository", { commonDir: "/elsewhere/.git" }],
    ["worktree", { worktreePath: WT_2 }],
    ["branch", { headRef: "refs/heads/other" }],
    ["branch", { headRef: null }],
  ] as const)("refuses a point from another %s", async (reason, change) => {
    identityMock.readWorktreeIdentity.mockResolvedValueOnce({ ...identityOf(WT_1), ...change });
    const outcome = await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);
    expect(outcome).toMatchObject({ status: "mismatch", reason });
    expect(outcome.snapshot.marks).toEqual({});
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("saves nothing when the host can't confirm the worktree", async () => {
    liveWorktrees(WT_2);
    expect((await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0)).status).toBe("unavailable");

    liveWorktrees(WT_1);
    identityMock.readWorktreeIdentity.mockRejectedValueOnce(new Error("git failed"));
    expect((await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0)).status).toBe("unavailable");
    expect((await hydrate(ctx(PROJECT_A)))?.marks).toEqual({});
  });

  it("refuses arguments that aren't a worktree id, a revision and a review point", async () => {
    await expect(mark(ctx(PROJECT_A), "relative", point(WT_1), 0)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(mark(ctx(PROJECT_A), WT_1, point(WT_1), -1)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      mark(ctx(PROJECT_A), WT_1, { ...point(WT_1), entries: "all" }, 0)
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(mark(ctx(null), WT_1, point(WT_1), 0)).rejects.toThrow("sender has no project");
  });

  it("refuses a first mark undone before it landed", async () => {
    const identity = deferred<WorktreeIdentity>();
    identityMock.readWorktreeIdentity.mockReturnValueOnce(identity.promise);
    const view = ctx(PROJECT_A);

    const saving = mark(view, WT_1, point(WT_1), 0);
    await vi.waitFor(() => expect(identityMock.readWorktreeIdentity).toHaveBeenCalled());
    expect((await clear(view, WT_1, 0)).status).toBe("cleared");
    identity.resolve(identityOf(WT_1));

    expect((await saving).status).toBe("stale");
    expect((await hydrate(view))?.marks).toEqual({});
  });

  describe("Review Hub's captures (#14585)", () => {
    beforeEach(() => {
      liveStates([
        { id: ROOT_A, path: ROOT_A, isMainWorktree: true, branch: "main" },
        { id: WT_1, path: WT_1, branch: "feature-1" },
        { id: WT_2, path: WT_2, branch: "feature-2" },
      ]);
    });

    it("holds the capture on the host and hands back only its id and summary", async () => {
      captureMock.captureReviewPoint.mockResolvedValue({
        kind: "captured",
        point: point(WT_1, { capturedAt: 4_000 }),
      });

      const outcome = await capture(ctx(PROJECT_A), WT_1);

      expect(outcome).toEqual({
        status: "captured",
        capture: {
          captureId: expect.any(String),
          capturedAt: 4_000,
          head: point(WT_1).head,
          complete: true,
          pathCount: 0,
        },
      });
      expect(JSON.stringify(outcome)).not.toContain("gitDir");
      expect(captureMock.captureReviewPoint).toHaveBeenCalledWith(WT_1, {
        base: { kind: "branch", branch: "main" },
      });
    });

    it("reads the change set against the worktree's own base, else the main worktree's branch", async () => {
      captureMock.captureReviewPoint.mockResolvedValue({ kind: "changed-during-capture" });
      liveStates([
        { id: ROOT_A, path: ROOT_A, isMainWorktree: true, branch: "develop" },
        { id: WT_1, path: WT_1, branch: "feature-1", baseBranchName: "release/2" },
        { id: WT_2, path: WT_2, branch: "feature-2", baseBranchName: null },
      ]);

      expect(await capture(ctx(PROJECT_A), WT_1)).toEqual({ status: "changed-during-capture" });
      await capture(ctx(PROJECT_A), WT_2);
      await capture(ctx(PROJECT_A), ROOT_A);

      expect(captureMock.captureReviewPoint.mock.calls.map(([, options]) => options.base)).toEqual([
        { kind: "branch", branch: "release/2" },
        { kind: "branch", branch: "develop" },
        { kind: "branch", branch: "develop" },
      ]);
    });

    it("captures nothing for a worktree the host doesn't list", async () => {
      expect(await capture(ctx(PROJECT_A), path.join(ROOT_A, "gone"))).toEqual({
        status: "unavailable",
      });
      expect(captureMock.captureReviewPoint).not.toHaveBeenCalled();
    });

    it("marks the held capture, checked like a handed point", async () => {
      captureMock.captureReviewPoint.mockResolvedValue({
        kind: "captured",
        point: point(WT_1, { capturedAt: 4_000 }),
      });
      const captured = await capture(ctx(PROJECT_A), WT_1);
      if (captured.status !== "captured") throw new Error("expected a capture");

      const outcome = await markCaptured(ctx(PROJECT_A), WT_1, captured.capture.captureId, 0);

      expect(outcome.status).toBe("saved");
      expect(outcome.snapshot.marks[WT_1]).toMatchObject({ capturedAt: 4_000 });
      expect(identityMock.readWorktreeIdentity).toHaveBeenCalledWith(WT_1, expect.anything());
    });

    it("refuses a capture id from another worktree or one no longer held", async () => {
      captureMock.captureReviewPoint.mockResolvedValue({ kind: "captured", point: point(WT_1) });
      const captured = await capture(ctx(PROJECT_A), WT_1);
      if (captured.status !== "captured") throw new Error("expected a capture");

      const other = await markCaptured(ctx(PROJECT_A), WT_2, captured.capture.captureId, 0);
      const unknown = await markCaptured(ctx(PROJECT_A), WT_1, "not-a-held-capture", 0);

      expect(other.status).toBe("expired");
      expect(unknown.status).toBe("expired");
      expect(other.snapshot.marks).toEqual({});
      expect(broadcastMock).not.toHaveBeenCalled();
      await expect(markCaptured(ctx(PROJECT_A), WT_1, "", 0)).rejects.toThrow(/captureId/);
    });

    it("compares the worktree against its stored point and names the mark's revision", async () => {
      const saved = await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);
      comparisonsMock.compare.mockResolvedValue(COMPARABLE);

      const outcome = await compare(ctx(PROJECT_A), WT_1);

      expect(outcome).toEqual({
        status: "compared",
        markRevision: saved.snapshot.marks[WT_1]?.revision,
        result: COMPARABLE,
      });
      expect(comparisonsMock.compare).toHaveBeenCalledWith(WT_1, point(WT_1));
    });

    it("says there's no mark rather than comparing", async () => {
      expect(await compare(ctx(PROJECT_A), WT_1)).toEqual({ status: "none" });
      expect(comparisonsMock.compare).not.toHaveBeenCalled();
    });

    it("says the mark can't be read when its point file is gone, never that there is none", async () => {
      const saved = await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);
      const dir = path.join(getProjectStateDir(root, PROJECT_A) ?? root, "review-marks");
      for (const file of await fs.readdir(dir)) await fs.rm(path.join(dir, file));

      expect(await compare(ctx(PROJECT_A), WT_1)).toEqual({
        status: "unavailable",
        markRevision: saved.snapshot.marks[WT_1]?.revision,
      });
      expect(comparisonsMock.compare).not.toHaveBeenCalled();
    });
  });

  describe("pruning", () => {
    let client: EventEmitter;
    let dispose: () => void;

    beforeEach(() => {
      client = new EventEmitter();
      dispose = registerReviewMarksHandlers({ worktreeService: client as never });
    });

    afterEach(() => {
      dispose();
    });

    function states(...ids: string[]): StatesResult {
      return { status: "ok", projectId: PROJECT_A, states: ids.map((id) => ({ id, path: id })) };
    }

    it("drops marks of worktrees the host confirms are gone, on a hydrate", async () => {
      await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);
      await mark(ctx(PROJECT_A), WT_2, point(WT_2), 1);
      broadcastMock.mockClear();
      liveWorktrees(WT_2);
      workspaceClientMock.getAllStatesForProjectResultAsync.mockClear();

      await hydrate(ctx(PROJECT_A));
      await _settleReviewMarkPrunesForTesting();

      expect(workspaceClientMock.getAllStatesForProjectResultAsync).toHaveBeenCalledTimes(2);
      const snapshot = (await hydrate(ctx(PROJECT_A)))!;
      expect(Object.keys(snapshot.marks)).toEqual([WT_2]);
      expect(broadcastMock).toHaveBeenCalledWith(
        PROJECT_A,
        CHANNELS.REVIEW_MARKS_CHANGED,
        snapshot
      );
    });

    it("keeps a mark the second read finds, or when the host can't answer", async () => {
      await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);
      broadcastMock.mockClear();
      workspaceClientMock.getAllStatesForProjectResultAsync
        .mockResolvedValueOnce(states())
        .mockResolvedValueOnce(states(WT_1));
      await hydrate(ctx(PROJECT_A));
      await _settleReviewMarkPrunesForTesting();
      expect((await hydrate(ctx(PROJECT_A)))?.marks[WT_1]).toBeDefined();
      await _settleReviewMarkPrunesForTesting();

      workspaceClientMock.getAllStatesForProjectResultAsync.mockResolvedValue({
        status: "unavailable",
        reason: "project-unavailable",
      });
      await hydrate(ctx(PROJECT_A));
      await _settleReviewMarkPrunesForTesting();
      expect((await hydrate(ctx(PROJECT_A)))?.marks[WT_1]).toBeDefined();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it("never drops a mark made while the host was being asked", async () => {
      await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);
      const calls = workspaceClientMock.getAllStatesForProjectResultAsync;
      calls.mockClear();
      // The prune's first read misses WT_1; it is recreated and marked again
      // before the second read, which misses it too.
      calls
        .mockResolvedValueOnce(states(WT_2))
        .mockResolvedValueOnce(states(WT_1, WT_2))
        .mockResolvedValueOnce(states(WT_2));
      await hydrate(ctx(PROJECT_A));
      await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
      const remarked = await mark(ctx(PROJECT_A), WT_1, point(WT_1, { capturedAt: 2_000 }), 1);
      expect(remarked.status).toBe("saved");
      await _settleReviewMarkPrunesForTesting();

      // Checked again on fresh reads, which find it.
      expect(calls.mock.calls.length).toBeGreaterThan(3);
      expect((await hydrate(ctx(PROJECT_A)))?.marks[WT_1]?.capturedAt).toBe(2_000);
    });

    it("drops a deleted worktree's mark once the host confirms it", async () => {
      await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);
      liveWorktrees(WT_2);

      client.emit("worktree-removed", {
        worktreeId: WT_1,
        projectPath: ROOT_A,
        projectId: PROJECT_A,
      });
      await _settleReviewMarkPrunesForTesting();
      expect((await hydrate(ctx(PROJECT_A)))?.marks).toEqual({});
    });

    it("refuses a save in flight for a worktree deleted meanwhile", async () => {
      const identity = deferred<WorktreeIdentity>();
      identityMock.readWorktreeIdentity.mockReturnValueOnce(identity.promise);

      const saving = mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);
      await vi.waitFor(() => expect(identityMock.readWorktreeIdentity).toHaveBeenCalled());
      liveWorktrees(WT_2);
      client.emit("worktree-removed", {
        worktreeId: WT_1,
        projectPath: ROOT_A,
        projectId: PROJECT_A,
      });
      await _settleReviewMarkPrunesForTesting();
      identity.resolve(identityOf(WT_1));

      expect((await saving).status).toBe("stale");
      expect((await hydrate(ctx(PROJECT_A)))?.marks).toEqual({});
    });

    it("writes nothing once disposed mid-prune, and stops listening", async () => {
      await mark(ctx(PROJECT_A), WT_1, point(WT_1), 0);
      broadcastMock.mockClear();
      liveWorktrees(WT_2);
      const calls = workspaceClientMock.getAllStatesForProjectResultAsync;
      calls.mockClear();

      client.emit("worktree-removed", {
        worktreeId: WT_1,
        projectPath: ROOT_A,
        projectId: PROJECT_A,
      });
      await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
      dispose();
      dispose = () => {};
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(calls).toHaveBeenCalledTimes(1);
      expect(broadcastMock).not.toHaveBeenCalled();
      expect(client.listenerCount("worktree-removed")).toBe(0);
      expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.REVIEW_MARKS_MARK);
      expect((await hydrate(ctx(PROJECT_A)))?.marks[WT_1]).toBeDefined();
    });
  });
});
