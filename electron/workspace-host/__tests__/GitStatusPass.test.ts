import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetWorktreeChangesWithStats = vi.fn();
const mockInvalidateGitStatusCache = vi.fn();
const mockGetGitDir = vi.fn();
const mockGetRepoOperationStateSync = vi.fn().mockReturnValue(undefined);

vi.mock("../../utils/git.js", () => ({
  getWorktreeChangesWithStats: (...args: unknown[]) => mockGetWorktreeChangesWithStats(...args),
  invalidateGitStatusCache: (...args: unknown[]) => mockInvalidateGitStatusCache(...args),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: (...args: unknown[]) => mockGetGitDir(...args),
}));

vi.mock("../../utils/gitRepoOperationState.js", () => ({
  getRepoOperationStateSync: (...args: unknown[]) => mockGetRepoOperationStateSync(...args),
  getRepoOperationState: async (...args: unknown[]) => mockGetRepoOperationStateSync(...args),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

const { mockCreateHardenedGit, mockCreateWslHardenedGit } = vi.hoisted(() => ({
  mockCreateHardenedGit: vi.fn(),
  mockCreateWslHardenedGit: vi.fn(),
}));
mockCreateHardenedGit.mockImplementation(() => ({
  raw: vi.fn(),
  log: vi.fn().mockResolvedValue({ latest: null }),
}));
mockCreateWslHardenedGit.mockImplementation(() => ({
  raw: vi.fn(),
  log: vi.fn().mockResolvedValue({ latest: null }),
}));
vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: mockCreateHardenedGit,
  createWslHardenedGit: mockCreateWslHardenedGit,
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: vi.fn().mockResolvedValue("stable"),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
}));

import { readFile } from "fs/promises";
import { categorizeWorktree } from "../../services/worktree/mood.js";
import { GitStatusPass, type GitStatusPassHost } from "../GitStatusPass.js";
import { StatPrecheck } from "../StatPrecheck.js";
import { BaseDivergence } from "../BaseDivergence.js";
import type { WatcherController } from "../WatcherController.js";
import type { AdaptivePollingStrategy } from "../../services/worktree/index.js";
import type { NoteFileReader } from "../../services/worktree/index.js";
import type { WorktreeChanges } from "../../../shared/types/git.js";

function makeChanges(overrides: Partial<WorktreeChanges> = {}): WorktreeChanges {
  return {
    worktreeId: "/test/worktree",
    rootPath: "/test/worktree",
    changes: [],
    changedFileCount: 0,
    tracking: null,
    lastCommitMessage: "Last commit",
    ...overrides,
  };
}

function makeHost(overrides: Partial<GitStatusPassHost> = {}): GitStatusPassHost {
  const state = {
    hasInitialStatus: false,
    repoState: undefined as import("../../../shared/types/git.js").RepoState | undefined,
    lastGitStatusCompletedAt: 0,
    isUpdating: false,
    branch: "feature/x" as string | undefined,
    issueNumber: undefined as number | undefined,
    branchDerivedTitle: undefined as string | undefined,
    issueTitle: undefined as string | undefined,
    isDetached: false,
    head: undefined as string | undefined,
    mood: "stable" as import("../../../shared/types/worktree.js").WorktreeMood,
    summary: undefined as string | undefined,
    worktreeChanges: null as import("../../../shared/types/git.js").WorktreeChanges | null,
  };
  return {
    id: "/test/worktree",
    path: "/test/worktree",
    name: "worktree",
    mainBranch: "main",
    isCurrent: false,
    isRunning: true,
    basePollingInterval: 5_000,
    wslInvocation: undefined,
    abortSignal: new AbortController().signal,
    prevEmittedIsDetached: false,
    prevEmittedHead: undefined,
    prevEmittedRepoState: undefined,
    get hasInitialStatus() {
      return state.hasInitialStatus;
    },
    set hasInitialStatus(v) {
      state.hasInitialStatus = v;
    },
    get repoState() {
      return state.repoState;
    },
    set repoState(v) {
      state.repoState = v;
    },
    get lastGitStatusCompletedAt() {
      return state.lastGitStatusCompletedAt;
    },
    set lastGitStatusCompletedAt(v) {
      state.lastGitStatusCompletedAt = v;
    },
    get isUpdating() {
      return state.isUpdating;
    },
    set isUpdating(v) {
      state.isUpdating = v;
    },
    get branch() {
      return state.branch;
    },
    set branch(v) {
      state.branch = v;
    },
    get issueNumber() {
      return state.issueNumber;
    },
    set issueNumber(v) {
      state.issueNumber = v;
    },
    get branchDerivedTitle() {
      return state.branchDerivedTitle;
    },
    set branchDerivedTitle(v) {
      state.branchDerivedTitle = v;
    },
    get issueTitle() {
      return state.issueTitle;
    },
    set issueTitle(v) {
      state.issueTitle = v;
    },
    get isDetached() {
      return state.isDetached;
    },
    set isDetached(v) {
      state.isDetached = v;
    },
    get head() {
      return state.head;
    },
    set head(v) {
      state.head = v;
    },
    get mood() {
      return state.mood;
    },
    set mood(v) {
      state.mood = v;
    },
    get summary() {
      return state.summary;
    },
    set summary(v) {
      state.summary = v;
    },
    get worktreeChanges() {
      return state.worktreeChanges;
    },
    set worktreeChanges(v) {
      state.worktreeChanges = v;
    },
    clearPRInfo: vi.fn(),
    clearLinked: vi.fn(),
    onBranchChanged: vi.fn(),
    onRemoved: vi.fn(),
    stop: vi.fn(),
    emitUpdate: vi.fn(),
    ...overrides,
  };
}

function makeWatcherController(): WatcherController {
  return {
    currentMode: "none",
    takePending: vi.fn().mockReturnValue(false),
    update: vi.fn(),
    markPending: vi.fn(),
    flushPendingIfReady: vi.fn(),
    scheduleDelayedFlush: vi.fn(),
    setUpstreamRef: vi.fn(),
  } as unknown as WatcherController;
}

function makePollingStrategy(): AdaptivePollingStrategy {
  return {
    recordNoChange: vi.fn(),
    recordStateChange: vi.fn(),
  } as unknown as AdaptivePollingStrategy;
}

function makeNoteReader(): NoteFileReader {
  return { read: vi.fn().mockResolvedValue({}) } as unknown as NoteFileReader;
}

function makePass(
  hostOverrides: Partial<GitStatusPassHost> = {},
  baseDivergenceOverride?: BaseDivergence
) {
  const host = makeHost(hostOverrides);
  const statPrecheck = new StatPrecheck({
    abortSignal: host.abortSignal,
    get branch() {
      return host.branch;
    },
    lastWatcherEventAt: 0,
    upstreamRef: null,
  });
  const baseDivergence =
    baseDivergenceOverride ??
    new BaseDivergence(
      {
        branch: host.branch,
        isMainWorktree: false,
        mainBranch: host.mainBranch,
        linkedPrBaseRef: undefined,
        path: host.path,
        wslInvocation: host.wslInvocation,
        abortSignal: host.abortSignal,
      },
      statPrecheck
    );
  const watcherController = makeWatcherController();
  const pollingStrategy = makePollingStrategy();
  const noteReader = makeNoteReader();
  const pass = new GitStatusPass(
    host,
    statPrecheck,
    baseDivergence,
    watcherController,
    pollingStrategy,
    noteReader
  );
  return { pass, host, statPrecheck, watcherController, pollingStrategy, noteReader };
}

describe("GitStatusPass", () => {
  beforeEach(() => {
    mockGetWorktreeChangesWithStats.mockReset();
    mockInvalidateGitStatusCache.mockReset();
    mockGetGitDir.mockReset().mockResolvedValue(null);
    mockGetRepoOperationStateSync.mockReset().mockReturnValue(undefined);
    vi.mocked(categorizeWorktree).mockReset().mockResolvedValue("stable");
    vi.mocked(readFile).mockReset().mockRejectedValue(new Error("ENOENT"));
  });

  it("calculateStateHash is a deterministic, order-insensitive numeric digest sensitive to content", () => {
    const { pass } = makePass();
    const hashOf = (changes: unknown[]) =>
      (pass as unknown as { calculateStateHash: (c: unknown) => number }).calculateStateHash({
        changes,
      });

    const a = { path: "/w/a.ts", status: "modified", insertions: 1, deletions: 2 };
    const b = { path: "/w/b.ts", status: "untracked", insertions: 5, deletions: 0 };

    const hash = hashOf([a, b]);
    expect(typeof hash).toBe("number");
    expect(hashOf([a, b])).toBe(hash);
    expect(hashOf([b, a])).toBe(hash);
    expect(hashOf([a])).not.toBe(hash);
    expect(hashOf([a, { ...b, insertions: 6 }])).not.toBe(hash);
    expect(hashOf([a, { ...b, mtimeMs: 10 }])).not.toBe(hashOf([a, { ...b, mtimeMs: 20 }]));
  });

  it("uses the actual latest dirty-file mtime on initial load instead of observation time", async () => {
    const fileMtime = Date.now() - 120_000;
    const commitTime = fileMtime - 60_000;
    mockGetWorktreeChangesWithStats.mockResolvedValue(
      makeChanges({
        changes: [
          {
            path: "/test/worktree/src/app.ts",
            status: "modified",
            insertions: 1,
            deletions: 0,
            mtimeMs: fileMtime,
          },
        ],
        changedFileCount: 1,
        latestFileMtime: fileMtime,
        lastCommitTimestampMs: commitTime,
      })
    );
    const { pass } = makePass();

    await pass.run(false);

    expect(pass.lastActivityTimestamp).toBe(fileMtime);
  });

  it("uses the newer commit when it is more recent than dirty-file mtimes", async () => {
    const commitTime = Date.now() - 30_000;
    const fileMtime = commitTime - 60_000;
    mockGetWorktreeChangesWithStats.mockResolvedValue(
      makeChanges({
        changes: [
          {
            path: "/test/worktree/src/app.ts",
            status: "modified",
            insertions: 1,
            deletions: 0,
            mtimeMs: fileMtime,
          },
        ],
        changedFileCount: 1,
        latestFileMtime: fileMtime,
        lastCommitTimestampMs: commitTime,
      })
    );
    const { pass } = makePass();

    await pass.run(false);

    expect(pass.lastActivityTimestamp).toBe(commitTime);
  });

  it("detects and emits an mtime-only dirty-file edit", async () => {
    const firstMtime = Date.now() - 120_000;
    const secondMtime = firstMtime + 60_000;
    const fileChange = {
      path: "/test/worktree/src/app.ts",
      status: "modified" as const,
      insertions: 1,
      deletions: 0,
    };
    mockGetWorktreeChangesWithStats
      .mockResolvedValueOnce(
        makeChanges({
          changes: [{ ...fileChange, mtimeMs: firstMtime }],
          changedFileCount: 1,
          latestFileMtime: firstMtime,
        })
      )
      .mockResolvedValueOnce(
        makeChanges({
          changes: [{ ...fileChange, mtimeMs: secondMtime }],
          changedFileCount: 1,
          latestFileMtime: secondMtime,
        })
      );
    const { pass, host } = makePass();
    await pass.run(false);
    vi.mocked(host.emitUpdate).mockClear();

    await pass.run(false);

    expect(pass.lastActivityTimestamp).toBe(secondMtime);
    expect(host.emitUpdate).toHaveBeenCalledTimes(1);
  });

  it("emits a force-push that leaves the ahead/behind counts unchanged (#13400)", async () => {
    const upstream = (sha: string) => ({
      baseBranchName: "main",
      aheadCount: 1,
      behindCount: 0,
      matchesUpstream: false,
      baseCompareRef: "origin/main",
      baseRemote: "origin",
      upstreamRef: "refs/remotes/origin/feature/x",
      upstreamHeadSha: sha,
    });
    const compute = vi
      .fn()
      .mockResolvedValueOnce(upstream("sha1"))
      .mockResolvedValueOnce(upstream("sha2"));
    mockGetWorktreeChangesWithStats.mockResolvedValue(
      makeChanges({ tracking: "origin/feature/x", ahead: 1, behind: 0 })
    );
    const { pass, host, watcherController } = makePass({}, {
      compute,
    } as unknown as BaseDivergence);
    await pass.run(false);
    expect(pass.upstreamHeadSha).toBe("sha1");
    expect(watcherController.setUpstreamRef).toHaveBeenCalledWith("refs/remotes/origin/feature/x");
    vi.mocked(host.emitUpdate).mockClear();

    await pass.run(false);

    expect(host.emitUpdate).toHaveBeenCalledTimes(1);
    expect(pass.upstreamHeadSha).toBe("sha2");
    expect(pass.upstreamRef).toBe("refs/remotes/origin/feature/x");
  });

  it("keeps the last upstream observation through a failed divergence pass", async () => {
    const compute = vi
      .fn()
      .mockResolvedValueOnce({
        baseBranchName: "main",
        aheadCount: 1,
        behindCount: 0,
        matchesUpstream: false,
        baseCompareRef: "origin/main",
        baseRemote: "origin",
        upstreamRef: "refs/remotes/origin/feature/x",
        upstreamHeadSha: "sha1",
      })
      .mockResolvedValueOnce(null);
    mockGetWorktreeChangesWithStats.mockResolvedValue(
      makeChanges({ tracking: "origin/feature/x", ahead: 1, behind: 0 })
    );
    const { pass, watcherController } = makePass({}, { compute } as unknown as BaseDivergence);
    await pass.run(false);
    await pass.run(true);

    expect(pass.upstreamHeadSha).toBe("sha1");
    expect(watcherController.setUpstreamRef).toHaveBeenLastCalledWith(
      "refs/remotes/origin/feature/x"
    );
  });

  it("advances and emits activity for a clean-to-clean commit", async () => {
    const firstCommitTime = Date.now() - 120_000;
    const secondCommitTime = firstCommitTime + 60_000;
    mockGetWorktreeChangesWithStats
      .mockResolvedValueOnce(makeChanges({ lastCommitTimestampMs: firstCommitTime }))
      .mockResolvedValueOnce(
        makeChanges({
          lastCommitTimestampMs: secondCommitTime,
          lastCommitMessage: "New commit",
        })
      );
    const { pass, host } = makePass();
    await pass.run(false);
    vi.mocked(host.emitUpdate).mockClear();

    await pass.run(false);

    expect(pass.lastActivityTimestamp).toBe(secondCommitTime);
    expect(host.emitUpdate).toHaveBeenCalledTimes(1);
    expect(host.summary).toBe("✅ New commit");
  });

  it("publishes a HEAD move that leaves the commit message and time unchanged (#13804)", async () => {
    const commitTime = Date.now() - 60_000;
    mockGetWorktreeChangesWithStats
      .mockResolvedValueOnce(makeChanges({ lastCommitTimestampMs: commitTime, headOid: "aaa111" }))
      .mockResolvedValueOnce(makeChanges({ lastCommitTimestampMs: commitTime, headOid: "bbb222" }));
    const { pass, host } = makePass();
    await pass.run(false);
    vi.mocked(host.emitUpdate).mockClear();

    await pass.run(false);

    expect(host.worktreeChanges?.headOid).toBe("bbb222");
    expect(host.emitUpdate).toHaveBeenCalledTimes(1);
  });

  it("uses dirty-file mtime in a repository with no commits", async () => {
    const fileMtime = Date.now() - 30_000;
    mockGetWorktreeChangesWithStats.mockResolvedValue(
      makeChanges({
        changes: [
          {
            path: "/test/worktree/README.md",
            status: "untracked",
            insertions: 1,
            deletions: 0,
            mtimeMs: fileMtime,
          },
        ],
        changedFileCount: 1,
        latestFileMtime: fileMtime,
        lastCommitTimestampMs: undefined,
        lastCommitMessage: undefined,
      })
    );
    const { pass } = makePass();

    await pass.run(false);

    expect(pass.lastActivityTimestamp).toBe(fileMtime);
  });

  it("ignores future and invalid timestamps while preserving valid observed events", async () => {
    const now = Date.now();
    const validFileMtime = now - 90_000;
    const validCommitTime = now - 120_000;
    mockGetWorktreeChangesWithStats.mockResolvedValueOnce(
      makeChanges({
        changes: [
          {
            path: "/test/worktree/src/valid.ts",
            status: "modified",
            insertions: 1,
            deletions: 0,
            mtimeMs: validFileMtime,
          },
          {
            path: "/test/worktree/src/future.ts",
            status: "modified",
            insertions: 1,
            deletions: 0,
            mtimeMs: now + 60_000,
          },
        ],
        changedFileCount: 2,
        latestFileMtime: now + 60_000,
        lastCommitTimestampMs: validCommitTime,
      })
    );
    const { pass } = makePass();

    await pass.run(false);

    expect(pass.lastActivityTimestamp).toBe(validFileMtime);
  });

  it("returns no activity when every source timestamp is invalid or in the future", async () => {
    const now = Date.now();
    mockGetWorktreeChangesWithStats.mockResolvedValue(
      makeChanges({
        changes: [
          {
            path: "/test/worktree/src/app.ts",
            status: "modified",
            insertions: 1,
            deletions: 0,
            mtimeMs: Number.NaN,
          },
        ],
        changedFileCount: 1,
        latestFileMtime: Number.POSITIVE_INFINITY,
        lastCommitTimestampMs: now + 60_000,
      })
    );
    const { pass } = makePass();

    await pass.run(false);

    expect(pass.lastActivityTimestamp).toBeNull();
  });

  it("publishes the first status over a placeholder snapshot even when nothing reads as changed (#13749)", async () => {
    // No commit metadata and no files: the state hash equals its seed and
    // every other comparison matches the placeholder's defaults.
    mockGetWorktreeChangesWithStats.mockResolvedValue(
      makeChanges({ lastCommitMessage: undefined })
    );
    const { pass, host } = makePass({}, {
      compute: vi.fn().mockResolvedValue(null),
    } as unknown as BaseDivergence);
    host.hasInitialStatus = true;

    await pass.run(false);

    expect(host.worktreeChanges).not.toBeNull();
    expect(host.emitUpdate).toHaveBeenCalled();
  });

  it("ignores stale file metadata on a clean worktree", async () => {
    const commitTime = Date.now() - 120_000;
    mockGetWorktreeChangesWithStats.mockResolvedValue(
      makeChanges({
        changedFileCount: 0,
        latestFileMtime: Date.now() - 30_000,
        lastCommitTimestampMs: commitTime,
      })
    );
    const { pass } = makePass();

    await pass.run(false);

    expect(pass.lastActivityTimestamp).toBe(commitTime);
  });

  it("survives a base-divergence failure that lands before it is awaited", async () => {
    // createGit throws for a worktree removed outside Daintree, and the
    // divergence is only awaited after the plan-file probes.
    const compute = vi
      .spyOn(BaseDivergence.prototype, "compute")
      .mockRejectedValue(new Error("Cannot use simple-git on a directory that does not exist"));
    try {
      mockGetWorktreeChangesWithStats.mockResolvedValue(makeChanges({ changes: [] }));
      const { pass } = makePass();

      await expect(pass.run(false)).resolves.not.toThrow();
    } finally {
      compute.mockRestore();
    }
  });

  it("passes the monitor's signal to status git and reads a cancelled pass as no result (#12460)", async () => {
    const first = new AbortController();
    let rejectStatus!: (error: unknown) => void;
    mockGetWorktreeChangesWithStats.mockReturnValue(
      new Promise((_res, rej) => (rejectStatus = rej))
    );
    const { pass, host } = makePass({ abortSignal: first.signal });

    const running = pass.run(true);
    await vi.waitFor(() => expect(mockGetWorktreeChangesWithStats).toHaveBeenCalled());
    expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledWith(
      "/test/worktree",
      expect.objectContaining({ signal: first.signal })
    );

    // stop() aborts, then start() mints a fresh controller before the killed
    // git rejects: the pass must judge the signal it started with.
    first.abort();
    (host as { abortSignal: AbortSignal }).abortSignal = new AbortController().signal;
    rejectStatus(new Error("the operation was aborted"));

    await expect(running).resolves.toBeUndefined();
    expect(host.mood).toBe("stable");
    expect(host.emitUpdate).not.toHaveBeenCalled();
    expect(host.isUpdating).toBe(false);
  });

  it("still surfaces a status failure the monitor did not cancel", async () => {
    mockGetWorktreeChangesWithStats.mockRejectedValue(new Error("fatal: bad object"));
    const { pass, host } = makePass();

    await expect(pass.run(true)).rejects.toThrow("bad object");
    expect(host.mood).toBe("error");
  });

  it("is a no-op single-flight guard while a pass is already in flight", async () => {
    const { pass, host } = makePass({ isUpdating: true });
    await pass.run(false);
    expect(mockGetGitDir).not.toHaveBeenCalled();
    expect(host.isUpdating).toBe(true);
  });

  it("skips the full check and emits when a blocking git operation sentinel is present", async () => {
    mockGetGitDir.mockResolvedValue("/test/worktree/.git");
    mockGetRepoOperationStateSync.mockReturnValue("merge");
    const { pass, host } = makePass({ hasInitialStatus: true });

    await pass.run(false);

    expect(host.emitUpdate).toHaveBeenCalled();
    expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
    expect(host.isUpdating).toBe(false);
  });

  it("drops the sentinel result when the monitor stops while it is being read", async () => {
    mockGetGitDir.mockResolvedValue("/test/worktree/.git");
    const controller = new AbortController();
    mockGetRepoOperationStateSync.mockImplementation(() => {
      controller.abort();
      return "REBASING";
    });
    const { pass, host } = makePass({ hasInitialStatus: true, abortSignal: controller.signal });

    await pass.run(true);

    expect(host.repoState).toBeUndefined();
    expect(host.emitUpdate).not.toHaveBeenCalled();
    expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
    expect(host.isUpdating).toBe(false);
  });

  it("runs a full check when getGitDir resolves no git directory", async () => {
    mockGetGitDir.mockResolvedValue(null);
    mockGetWorktreeChangesWithStats.mockResolvedValue({
      changes: [],
      changedFileCount: 0,
      tracking: null,
    });
    const { pass, host } = makePass();

    await pass.run(false);

    expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
    expect(host.isUpdating).toBe(false);
  });

  it("runs a full check on the first poll even with a real gitDir, since no stat baseline exists yet", async () => {
    mockGetGitDir.mockResolvedValue("/test/worktree/.git");
    mockGetWorktreeChangesWithStats.mockResolvedValue({
      changes: [],
      changedFileCount: 0,
      tracking: null,
    });
    const { pass, host } = makePass({ hasInitialStatus: true });

    await pass.run(false);

    expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
    expect(host.isUpdating).toBe(false);
  });

  it("clears the canonical PR linkage along with the flat PR fields on a branch change", async () => {
    // The PR service's own clear names the old branch, so the host's branch
    // guard drops it; without this the new branch keeps the old `linked.pr`.
    mockGetGitDir.mockResolvedValue("/test/worktree/.git");
    vi.mocked(readFile).mockImplementation((async (path: unknown) => {
      if (String(path).endsWith("HEAD")) return "ref: refs/heads/feature/y\n";
      throw new Error("ENOENT");
    }) as unknown as typeof readFile);
    mockGetWorktreeChangesWithStats.mockResolvedValue(makeChanges());
    const { pass, host } = makePass();

    await pass.run(false);

    expect(host.branch).toBe("feature/y");
    expect(host.clearPRInfo).toHaveBeenCalledTimes(1);
    expect(host.clearLinked).toHaveBeenCalledTimes(1);
    expect(host.onBranchChanged).toHaveBeenCalledWith("feature/y");
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
  });

  describe("a pass that outlives its lifecycle (#15630)", () => {
    type NoteRead = Awaited<ReturnType<NoteFileReader["read"]>>;
    type Divergence = Awaited<ReturnType<BaseDivergence["compute"]>>;

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => (resolve = res));
      return { promise, resolve };
    }

    const dirty = (file: string) =>
      makeChanges({
        changes: [
          {
            path: `/test/worktree/${file}`,
            status: "modified",
            insertions: 1,
            deletions: 0,
            mtimeMs: Date.now() - 60_000,
          },
        ],
        changedFileCount: 1,
      });

    function setUp() {
      mockGetGitDir.mockResolvedValue("/test/worktree/.git");
      mockGetWorktreeChangesWithStats.mockResolvedValue(dirty("a.ts"));
      const controller = new AbortController();
      const made = makePass({ abortSignal: controller.signal });
      const recordFullPass = vi.spyOn(made.statPrecheck, "recordFullPass");
      const dropBaseline = vi.spyOn(made.statPrecheck, "dropBaseline");
      return { ...made, controller, recordFullPass, dropBaseline };
    }

    // The host side of WorktreeMonitor.stop(): not running, lifecycle signal
    // aborted. What the pass did while still live is cleared, so assertions
    // read only what it did after the stop.
    function stopHost(made: ReturnType<typeof setUp>) {
      (made.host as { isRunning: boolean }).isRunning = false;
      made.controller.abort();
      vi.mocked(made.watcherController.setUpstreamRef).mockClear();
      vi.mocked(made.pollingStrategy.recordStateChange).mockClear();
      vi.mocked(made.pollingStrategy.recordNoChange).mockClear();
    }

    function expectNothingPublished(made: ReturnType<typeof setUp>) {
      expect(made.host.emitUpdate).not.toHaveBeenCalled();
      expect(made.host.worktreeChanges).toBeNull();
      expect(made.host.hasInitialStatus).toBe(false);
      expect(made.host.summary).toBeUndefined();
      expect(made.host.mood).toBe("stable");
      expect(made.host.lastGitStatusCompletedAt).toBe(0);
      expect(made.pass.lastActivityTimestamp).toBeNull();
      expect(made.watcherController.setUpstreamRef).not.toHaveBeenCalled();
      expect(made.watcherController.flushPendingIfReady).not.toHaveBeenCalled();
      expect(made.pollingStrategy.recordStateChange).not.toHaveBeenCalled();
      expect(made.pollingStrategy.recordNoChange).not.toHaveBeenCalled();
      expect(made.recordFullPass).not.toHaveBeenCalled();
      expect(made.host.isUpdating).toBe(false);
    }

    it("drops a pass stopped during the HEAD read", async () => {
      const made = setUp();
      const head = deferred<string>();
      let reading = false;
      vi.mocked(readFile).mockImplementation((async (path: unknown) => {
        if (!String(path).endsWith("HEAD")) throw new Error("ENOENT");
        reading = true;
        return head.promise;
      }) as unknown as typeof readFile);
      try {
        const running = made.pass.run(true);
        await vi.waitFor(() => expect(reading).toBe(true));

        stopHost(made);
        head.resolve("0123456789abcdef0123456789abcdef01234567\n");
        await running;

        expectNothingPublished(made);
        expect(made.host.isDetached).toBe(false);
        expect(made.host.head).toBeUndefined();
      } finally {
        vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      }
    });

    it("drops a pass stopped during the note read", async () => {
      const made = setUp();
      const note = deferred<NoteRead>();
      vi.mocked(made.noteReader.read).mockReturnValueOnce(note.promise);
      const compute = vi.spyOn(BaseDivergence.prototype, "compute");
      try {
        const running = made.pass.run(true);
        await vi.waitFor(() => expect(made.noteReader.read).toHaveBeenCalled());

        stopHost(made);
        note.resolve({ content: "late", timestamp: 1 });
        await running;

        expectNothingPublished(made);
        expect(made.pass.aiNote).toBeUndefined();
        expect(compute).not.toHaveBeenCalled();
      } finally {
        compute.mockRestore();
      }
    });

    it("drops a pass stopped during base divergence", async () => {
      const made = setUp();
      const divergence = deferred<Divergence>();
      const compute = vi
        .spyOn(BaseDivergence.prototype, "compute")
        .mockReturnValue(divergence.promise);
      try {
        const running = made.pass.run(true);
        await vi.waitFor(() => expect(compute).toHaveBeenCalled());

        stopHost(made);
        divergence.resolve({
          baseBranchName: "main",
          aheadCount: 1,
          behindCount: 0,
          matchesUpstream: false,
          baseCompareRef: "origin/main",
          upstreamRef: null,
          upstreamHeadSha: null,
        } as Divergence);
        await running;

        expectNothingPublished(made);
        expect(made.pass.baseBranchName).toBeUndefined();
      } finally {
        compute.mockRestore();
      }
    });

    it("drops a pass stopped during categorisation", async () => {
      const made = setUp();
      const mood = deferred<"active">();
      vi.mocked(categorizeWorktree).mockReturnValueOnce(mood.promise);

      const running = made.pass.run(true);
      await vi.waitFor(() => expect(categorizeWorktree).toHaveBeenCalled());

      stopHost(made);
      mood.resolve("active");
      await running;

      expectNothingPublished(made);
    });

    it("drops a stopped lifecycle's result and publishes the restarted one's", async () => {
      const made = setUp();
      const oldNote = deferred<NoteRead>();
      vi.mocked(made.noteReader.read)
        .mockReturnValueOnce(oldNote.promise)
        .mockResolvedValueOnce({ content: "new", timestamp: 2 });
      mockGetWorktreeChangesWithStats
        .mockResolvedValueOnce(dirty("old.ts"))
        .mockResolvedValueOnce(dirty("new.ts"));

      const old = made.pass.run(true);
      await vi.waitFor(() => expect(made.noteReader.read).toHaveBeenCalledTimes(1));

      stopHost(made);
      made.pass.abandon();
      (made.host as { isRunning: boolean }).isRunning = true;
      (made.host as { abortSignal: AbortSignal }).abortSignal = new AbortController().signal;

      await made.pass.run(true);
      expect(made.host.emitUpdate).toHaveBeenCalledTimes(1);
      expect(made.host.worktreeChanges?.changes[0]?.path).toBe("/test/worktree/new.ts");

      oldNote.resolve({ content: "old", timestamp: 1 });
      await old;

      expect(made.host.emitUpdate).toHaveBeenCalledTimes(1);
      expect(made.host.worktreeChanges?.changes[0]?.path).toBe("/test/worktree/new.ts");
      expect(made.pass.aiNote).toBe("new");
      expect(made.host.isUpdating).toBe(false);
    });

    it("leaves a newer pass alone when an abandoned pass settles late", async () => {
      const made = setUp();
      const staleNote = deferred<NoteRead>();
      const freshNote = deferred<NoteRead>();
      vi.mocked(made.noteReader.read)
        .mockReturnValueOnce(staleNote.promise)
        .mockReturnValueOnce(freshNote.promise);
      mockGetWorktreeChangesWithStats
        .mockResolvedValueOnce(dirty("stale.ts"))
        .mockResolvedValueOnce(dirty("fresh.ts"));

      const stale = made.pass.run(true);
      await vi.waitFor(() => expect(made.noteReader.read).toHaveBeenCalledTimes(1));

      // The poll watchdog gives up on it.
      made.pass.abandon();
      expect(made.dropBaseline).toHaveBeenCalledTimes(1);
      expect(made.host.isUpdating).toBe(false);
      const fresh = made.pass.run(true);
      await vi.waitFor(() => expect(made.noteReader.read).toHaveBeenCalledTimes(2));
      made.dropBaseline.mockClear();

      staleNote.resolve({ content: "stale", timestamp: 1 });
      await stale;

      expect(made.host.isUpdating).toBe(true);
      expect(made.recordFullPass).not.toHaveBeenCalled();
      expect(made.dropBaseline).not.toHaveBeenCalled();
      expect(made.watcherController.flushPendingIfReady).not.toHaveBeenCalled();
      expect(made.host.emitUpdate).not.toHaveBeenCalled();
      expect(made.host.worktreeChanges).toBeNull();

      freshNote.resolve({ content: "fresh", timestamp: 2 });
      await fresh;

      expect(made.host.emitUpdate).toHaveBeenCalledTimes(1);
      expect(made.host.worktreeChanges?.changes[0]?.path).toBe("/test/worktree/fresh.ts");
      expect(made.pass.aiNote).toBe("fresh");
      expect(made.host.isUpdating).toBe(false);
      expect(made.recordFullPass).toHaveBeenCalledTimes(1);
    });

    it("refuses to start on a monitor that is not running", async () => {
      const made = setUp();
      (made.host as { isRunning: boolean }).isRunning = false;

      await made.pass.run(true);

      expect(mockGetGitDir).not.toHaveBeenCalled();
      expect(made.host.isUpdating).toBe(false);
    });

    it("refuses to start under an aborted lifecycle while still marked running", async () => {
      const made = setUp();
      made.controller.abort();

      await made.pass.run(true);

      expect(mockGetGitDir).not.toHaveBeenCalled();
      expect(made.host.isUpdating).toBe(false);
    });

    it("leaves repo state alone when stopped while the git dir resolves", async () => {
      const made = setUp();
      made.host.repoState = "REBASING";
      const gitDir = deferred<string | null>();
      mockGetGitDir.mockReturnValueOnce(gitDir.promise);

      const running = made.pass.run(true);
      await vi.waitFor(() => expect(mockGetGitDir).toHaveBeenCalled());

      stopHost(made);
      gitDir.resolve(null);
      await running;

      expect(made.host.repoState).toBe("REBASING");
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
      expect(made.watcherController.flushPendingIfReady).not.toHaveBeenCalled();
      expect(made.host.isUpdating).toBe(false);
    });

    it("records nothing for a stat skip that lands after the stop", async () => {
      const made = setUp();
      made.host.hasInitialStatus = true;
      made.host.worktreeChanges = dirty("a.ts");
      const skip = deferred<boolean>();
      const shouldSkip = vi
        .spyOn(made.statPrecheck, "shouldSkip")
        .mockReturnValueOnce(skip.promise);

      const running = made.pass.run(false);
      await vi.waitFor(() => expect(shouldSkip).toHaveBeenCalled());

      stopHost(made);
      skip.resolve(true);
      await running;

      expect(made.pollingStrategy.recordNoChange).not.toHaveBeenCalled();
      expect(made.host.lastGitStatusCompletedAt).toBe(0);
      expect(made.watcherController.flushPendingIfReady).not.toHaveBeenCalled();
      expect(mockGetWorktreeChangesWithStats).not.toHaveBeenCalled();
    });

    it("holds the slot until the baseline lands", async () => {
      const made = setUp();
      const recording = deferred<void>();
      made.recordFullPass.mockReturnValueOnce(recording.promise);

      const first = made.pass.run(true);
      await vi.waitFor(() => expect(made.recordFullPass).toHaveBeenCalledTimes(1));
      expect(made.host.isUpdating).toBe(true);

      await made.pass.run(true);
      expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1);
      expect(made.watcherController.flushPendingIfReady).not.toHaveBeenCalled();

      recording.resolve();
      await first;

      expect(made.host.isUpdating).toBe(false);
      expect(made.watcherController.flushPendingIfReady).toHaveBeenCalledTimes(1);
    });

    it("discards a baseline capture its pass was abandoned during", async () => {
      const made = setUp();
      const recording = deferred<void>();
      made.recordFullPass.mockReturnValueOnce(recording.promise);

      const running = made.pass.run(true);
      await vi.waitFor(() => expect(made.recordFullPass).toHaveBeenCalledTimes(1));
      const isCurrent = made.recordFullPass.mock.calls[0][1] as () => boolean;
      expect(isCurrent()).toBe(true);

      made.pass.abandon();
      expect(isCurrent()).toBe(false);
      recording.resolve();
      await running;

      expect(made.watcherController.flushPendingIfReady).not.toHaveBeenCalled();
    });

    it.each(["fatal: bad object", "Unable to create '.git/index.lock': File exists"])(
      "swallows an abandoned pass's failure (%s) without touching the newer pass",
      async (message) => {
        const made = setUp();
        let rejectStale!: (error: unknown) => void;
        const freshNote = deferred<NoteRead>();
        mockGetWorktreeChangesWithStats.mockReturnValueOnce(
          new Promise((_res, rej) => (rejectStale = rej))
        );
        vi.mocked(made.noteReader.read).mockReturnValueOnce(freshNote.promise);

        const stale = made.pass.run(true);
        await vi.waitFor(() => expect(mockGetWorktreeChangesWithStats).toHaveBeenCalledTimes(1));
        made.pass.abandon();
        const fresh = made.pass.run(true);
        await vi.waitFor(() => expect(made.noteReader.read).toHaveBeenCalledTimes(1));
        made.dropBaseline.mockClear();

        rejectStale(new Error(message));
        await expect(stale).resolves.toBeUndefined();

        expect(made.host.mood).toBe("stable");
        expect(made.host.emitUpdate).not.toHaveBeenCalled();
        expect(made.watcherController.markPending).not.toHaveBeenCalled();
        expect(made.watcherController.scheduleDelayedFlush).not.toHaveBeenCalled();
        expect(made.dropBaseline).not.toHaveBeenCalled();
        expect(made.host.isUpdating).toBe(true);

        freshNote.resolve({ content: "fresh", timestamp: 2 });
        await fresh;
        expect(made.host.emitUpdate).toHaveBeenCalledTimes(1);
      }
    );

    it("ignores an abandon signal that fires after its pass finished", async () => {
      const made = setUp();
      const done = new AbortController();
      await made.pass.run(true, done.signal);

      const freshNote = deferred<NoteRead>();
      vi.mocked(made.noteReader.read).mockReturnValueOnce(freshNote.promise);
      const fresh = made.pass.run(true);
      await vi.waitFor(() => expect(made.noteReader.read).toHaveBeenCalledTimes(2));
      made.dropBaseline.mockClear();

      done.abort();

      expect(made.host.isUpdating).toBe(true);
      expect(made.dropBaseline).not.toHaveBeenCalled();
      freshNote.resolve({ content: "fresh", timestamp: 2 });
      await fresh;
      expect(made.pass.aiNote).toBe("fresh");
    });
  });

  describe("HEAD detection", () => {
    const sha1 = "a".repeat(40);
    const sha256 = "b".repeat(64);

    async function runWithHead(
      head: string | Error,
      initial: { isDetached: boolean; head?: string } = { isDetached: false }
    ) {
      mockGetGitDir.mockResolvedValue("/test/worktree/.git");
      vi.mocked(readFile).mockImplementation((async (path: unknown) => {
        if (String(path).endsWith("HEAD")) {
          if (head instanceof Error) throw head;
          return head;
        }
        throw new Error("ENOENT");
      }) as unknown as typeof readFile);
      mockGetWorktreeChangesWithStats.mockResolvedValue(makeChanges());
      const made = makePass();
      made.host.isDetached = initial.isDetached;
      made.host.head = initial.head;
      await made.pass.run(false);
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
      return made.host;
    }

    it.each([
      ["SHA-1", sha1],
      ["SHA-256", sha256],
    ])("reports a detached %s HEAD with the full OID", async (_n, oid) => {
      const host = await runWithHead(`${oid}\n`);
      expect(host.isDetached).toBe(true);
      expect(host.head).toBe(oid);
    });

    it("reports a symbolic ref as attached", async () => {
      const host = await runWithHead("ref: refs/heads/main\n", { isDetached: true, head: sha1 });
      expect(host.isDetached).toBe(false);
      expect(host.head).toBeUndefined();
    });

    it("keeps the detached state when the HEAD read fails", async () => {
      const host = await runWithHead(new Error("EACCES"), { isDetached: true, head: sha256 });
      expect(host.isDetached).toBe(true);
      expect(host.head).toBe(sha256);
    });

    it("keeps the last observed state on malformed HEAD content", async () => {
      const host = await runWithHead("abc123", { isDetached: true, head: sha1 });
      expect(host.isDetached).toBe(true);
      expect(host.head).toBe(sha1);
    });
  });
});
