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
    lastWatcherEventAt: 0,
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
    currentMode: "polling",
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
  const statPrecheck = new StatPrecheck({ abortSignal: host.abortSignal });
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

  it("runs a full check when there is no gitDir sentinel and no stat baseline yet", async () => {
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
});
