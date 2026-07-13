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

function makePass(hostOverrides: Partial<GitStatusPassHost> = {}) {
  const host = makeHost(hostOverrides);
  const statPrecheck = new StatPrecheck({
    abortSignal: host.abortSignal,
    get branch() {
      return host.branch;
    },
    lastWatcherEventAt: 0,
  });
  const baseDivergence = new BaseDivergence(
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
  return { pass, host, statPrecheck, watcherController };
}

describe("GitStatusPass", () => {
  beforeEach(() => {
    mockGetWorktreeChangesWithStats.mockReset();
    mockInvalidateGitStatusCache.mockReset();
    mockGetGitDir.mockReset().mockResolvedValue(null);
    mockGetRepoOperationStateSync.mockReset().mockReturnValue(undefined);
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
});
