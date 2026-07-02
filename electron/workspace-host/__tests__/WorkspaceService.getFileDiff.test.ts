import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

const mockSimpleGit = {
  raw: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
  diff: vi.fn().mockResolvedValue(""),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockSimpleGit),
}));

vi.mock("../../utils/fs.js", () => ({
  waitForPathExists: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => mockSimpleGit),
  validateCwd: vi.fn(),
  validateBranchName: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  invalidateGitStatusCache: vi.fn(),
  getWorktreeChangesWithStats: vi.fn().mockResolvedValue({
    head: "abc123",
    isDirty: false,
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    conflictedFileCount: 0,
    changedFileCount: 0,
    changes: [],
  }),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockReturnValue("/test/worktree/.git"),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

vi.mock("../../services/worktree/mood.js", () => ({
  categorizeWorktree: vi.fn().mockReturnValue("stable"),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../services/worktree/index.js", () => ({
  AdaptivePollingStrategy: vi.fn(function () {
    return {
      getCurrentInterval: vi.fn().mockReturnValue(2000),
      updateInterval: vi.fn(),
      reportActivity: vi.fn(),
      updateConfig: vi.fn(),
      isCircuitBreakerTripped: vi.fn().mockReturnValue(false),
      reset: vi.fn(),
      setBaseInterval: vi.fn(),
      calculateNextInterval: vi.fn().mockReturnValue(2000),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
  }),
  NoteFileReader: vi.fn(function () {
    return {
      read: vi.fn().mockResolvedValue({}),
    };
  }),
}));

vi.mock("../../services/PullRequestService.js", () => ({
  pullRequestService: {
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    refresh: vi.fn(),
    getStatus: vi.fn().mockReturnValue({
      state: "idle",
      isPolling: false,
      candidateCount: 0,
      resolvedCount: 0,
      isEnabled: true,
    }),
  },
}));

vi.mock("../../services/events.js", () => ({
  events: new EventEmitter(),
}));

vi.mock("../../utils/gitFileWatcher.js", () => {
  return {
    GitFileWatcher: class {
      start() {
        return Promise.resolve(false);
      }
      dispose() {}
    },
  };
});

vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from("content")),
}));

describe("WorkspaceService.getFileDiff", () => {
  let service: WorkspaceService;
  let mockSendEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendEvent = vi.fn();

    const WorkspaceServiceModule = await import("../WorkspaceService.js");
    service = new WorkspaceServiceModule.WorkspaceService(
      mockSendEvent as unknown as (event: WorkspaceHostEvent) => void
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows Next.js catch-all route filenames with [...slug]", async () => {
    await service.getFileDiff("req-1", "/test/repo", "pages/[...slug].tsx", "untracked");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "get-file-diff-result",
        requestId: "req-1",
        diff: expect.stringContaining("+++ b/pages/[...slug].tsx"),
      })
    );
    // Should NOT contain an error
    expect(mockSendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it("allows nested catch-all routes like app/blog/[...slug]/page.tsx", async () => {
    await service.getFileDiff("req-2", "/test/repo", "app/blog/[...slug]/page.tsx", "untracked");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "get-file-diff-result",
        requestId: "req-2",
        diff: expect.stringContaining("+++ b/app/blog/[...slug]/page.tsx"),
      })
    );
  });

  it("allows filenames containing double-dots that are not traversal segments", async () => {
    await service.getFileDiff("req-3", "/test/repo", "notes..backup.txt", "untracked");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "get-file-diff-result",
        requestId: "req-3",
        diff: expect.stringContaining("+++ b/notes..backup.txt"),
      })
    );
  });

  it("rejects traversal paths with ../", async () => {
    await service.getFileDiff("req-4", "/test/repo", "../secrets.txt", "modified");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "get-file-diff-result",
        requestId: "req-4",
        diff: "",
        error: "Path traversal detected",
      })
    );
  });

  it("rejects absolute paths", async () => {
    await service.getFileDiff("req-5", "/test/repo", "/etc/passwd", "modified");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "get-file-diff-result",
        requestId: "req-5",
        diff: "",
        error: "Absolute paths are not allowed",
      })
    );
  });

  it("passes --no-textconv on the modified-file diff to defeat textconv drivers", async () => {
    mockSimpleGit.diff.mockResolvedValueOnce("diff --git a/foo.ts b/foo.ts\n+change");
    await service.getFileDiff("req-6", "/test/repo", "foo.ts", "modified");

    expect(mockSimpleGit.diff).toHaveBeenCalledWith(expect.arrayContaining(["--no-textconv"]));
  });

  it("returns FILE_TOO_LARGE without reading when the file exceeds 1MB", async () => {
    const { stat, readFile } = await import("fs/promises");
    vi.mocked(stat).mockResolvedValueOnce({ size: 1024 * 1024 + 1 } as never);

    await service.getFileDiff("req-7", "/test/repo", "huge.txt", "untracked");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "get-file-diff-result",
        requestId: "req-7",
        diff: "FILE_TOO_LARGE",
      })
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(mockSimpleGit.diff).not.toHaveBeenCalled();
  });

  it("returns FILE_TOO_LARGE when the tracked-file diff output exceeds 1MB", async () => {
    mockSimpleGit.diff.mockResolvedValueOnce(
      "diff --git a/foo.ts b/foo.ts\n" + "+x".repeat(1024 * 1024)
    );

    await service.getFileDiff("req-8", "/test/repo", "foo.ts", "modified");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "get-file-diff-result",
        requestId: "req-8",
        diff: "FILE_TOO_LARGE",
      })
    );
  });

  it("passes --ignore-all-space when ignoreWhitespace is true", async () => {
    mockSimpleGit.diff.mockResolvedValueOnce("diff --git a/foo.ts b/foo.ts\n+change");
    await service.getFileDiff("req-9", "/test/repo", "foo.ts", "modified", true);

    expect(mockSimpleGit.diff).toHaveBeenCalledWith(expect.arrayContaining(["--ignore-all-space"]));
  });

  it("omits --ignore-all-space when ignoreWhitespace is not set", async () => {
    mockSimpleGit.diff.mockResolvedValueOnce("diff --git a/foo.ts b/foo.ts\n+change");
    await service.getFileDiff("req-10", "/test/repo", "foo.ts", "modified");

    expect(mockSimpleGit.diff).not.toHaveBeenCalledWith(
      expect.arrayContaining(["--ignore-all-space"])
    );
  });
});
