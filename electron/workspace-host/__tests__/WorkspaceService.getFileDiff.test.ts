import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";
import {
  GIT_FILE_DIFF_MAX_BYTES,
  GIT_FILE_DIFF_MAX_SOURCE_BYTES,
} from "../../../shared/config/gitReadLimits.js";

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

  it("refuses a file past the source ceiling without reading it or diffing", async () => {
    const { stat, readFile } = await import("fs/promises");
    vi.mocked(stat).mockResolvedValueOnce({ size: GIT_FILE_DIFF_MAX_SOURCE_BYTES + 1 } as never);

    await service.getFileDiff("req-7", "/test/repo", "huge.txt", "untracked");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "get-file-diff-result",
        requestId: "req-7",
        diff: "FILE_TOO_LARGE",
        offset: 0,
        totalBytes: 0,
        truncated: false,
        nextOffset: null,
      })
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(mockSimpleGit.diff).not.toHaveBeenCalled();
  });

  it("applies the source ceiling to tracked files too, bounding peak memory", async () => {
    const { stat } = await import("fs/promises");
    vi.mocked(stat).mockResolvedValueOnce({ size: GIT_FILE_DIFF_MAX_SOURCE_BYTES + 1 } as never);

    await service.getFileDiff("req-16", "/test/repo", "huge.ts", "modified");

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-16", diff: "FILE_TOO_LARGE" })
    );
    // The point of the gate: git never buffers the diff of a file this size.
    expect(mockSimpleGit.diff).not.toHaveBeenCalled();
  });

  it("never windows the BINARY_FILE sentinel", async () => {
    mockSimpleGit.diff.mockResolvedValueOnce("Binary files a/x.bin and b/x.bin differ");

    await service.getFileDiff("req-17", "/test/repo", "x.bin", "modified", undefined, 0, 1);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-17",
        diff: "BINARY_FILE",
        offset: 0,
        totalBytes: 0,
        truncated: false,
        nextOffset: null,
      })
    );
  });

  it("windows a text diff whose added lines quote the binary marker", async () => {
    const textDiff = `diff --git a/README.md b/README.md
index 1a2b3c4..5d6e7f8 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Notes
+Git prints Binary files a/x and b/x differ when it skips a blob.
`;
    mockSimpleGit.diff.mockResolvedValueOnce(textDiff);

    await service.getFileDiff("req-18", "/test/repo", "README.md", "modified");

    const event = mockSendEvent.mock.calls.at(-1)?.[0];
    expect(event.diff).toBe(textDiff);
    expect(event.totalBytes).toBe(Buffer.byteLength(textDiff, "utf8"));
  });

  it("reconstructs a multibyte diff across windows without replacement characters", async () => {
    const full = "diff --git a/f.ts b/f.ts\n" + "+日本語テキスト😀\n".repeat(50);
    mockSimpleGit.diff.mockResolvedValue(full);

    let offset: number | null = 0;
    let rebuilt = "";
    let guard = 0;
    while (offset !== null) {
      await service.getFileDiff("req-mb", "/test/repo", "f.ts", "modified", undefined, offset, 7);
      const event = mockSendEvent.mock.calls.at(-1)?.[0];
      rebuilt += event.diff;
      offset = event.nextOffset;
      expect(++guard).toBeLessThan(500);
    }

    expect(rebuilt).toBe(full);
    expect(rebuilt).not.toContain("�");
  });

  it("windows a tracked-file diff past 1MB instead of refusing it (#11531)", async () => {
    const header = "diff --git a/foo.ts b/foo.ts\n";
    const body = "+x".repeat(GIT_FILE_DIFF_MAX_BYTES);
    const full = header + body;
    mockSimpleGit.diff.mockResolvedValueOnce(full);

    await service.getFileDiff("req-8", "/test/repo", "foo.ts", "modified");

    const event = mockSendEvent.mock.calls.at(-1)?.[0];
    expect(event.diff).not.toBe("FILE_TOO_LARGE");
    expect(event.diff.startsWith(header)).toBe(true);
    expect(event.truncated).toBe(true);
    expect(event.totalBytes).toBe(full.length);
    expect(event.nextOffset).toBe(GIT_FILE_DIFF_MAX_BYTES);
  });

  it("diffs a large file with a small diff, which the old 1MB gate refused", async () => {
    const { stat } = await import("fs/promises");
    vi.mocked(stat).mockResolvedValueOnce({
      size: GIT_FILE_DIFF_MAX_SOURCE_BYTES / 2,
    } as never);
    mockSimpleGit.diff.mockResolvedValueOnce("diff --git a/big.ts b/big.ts\n+one line");

    await service.getFileDiff("req-11", "/test/repo", "big.ts", "modified");

    const event = mockSendEvent.mock.calls.at(-1)?.[0];
    expect(event.diff).toContain("+one line");
    expect(event.truncated).toBe(false);
  });

  it("serves a requested window and a continuation that reconstructs the diff", async () => {
    const full = "diff --git a/foo.ts b/foo.ts\n" + "+abcdefghij".repeat(100);
    mockSimpleGit.diff.mockResolvedValue(full);

    await service.getFileDiff("req-12", "/test/repo", "foo.ts", "modified", undefined, 0, 100);
    const first = mockSendEvent.mock.calls.at(-1)?.[0];
    expect(first.diff).toHaveLength(100);
    expect(first.truncated).toBe(true);

    await service.getFileDiff(
      "req-13",
      "/test/repo",
      "foo.ts",
      "modified",
      undefined,
      first.nextOffset,
      10_000
    );
    const second = mockSendEvent.mock.calls.at(-1)?.[0];
    expect(first.diff + second.diff).toBe(full);
    expect(second.truncated).toBe(false);
    expect(second.nextOffset).toBeNull();
  });

  it("never windows a sentinel result", async () => {
    mockSimpleGit.diff.mockResolvedValueOnce("   ");

    await service.getFileDiff("req-14", "/test/repo", "foo.ts", "modified", undefined, 0, 1);

    expect(mockSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "get-file-diff-result",
        requestId: "req-14",
        diff: "NO_CHANGES",
        totalBytes: 0,
        truncated: false,
        nextOffset: null,
      })
    );
  });

  it("clamps a caller-supplied maxBytes to the 1MB transport ceiling", async () => {
    const full = "diff --git a/foo.ts b/foo.ts\n" + "+y".repeat(GIT_FILE_DIFF_MAX_BYTES);
    mockSimpleGit.diff.mockResolvedValueOnce(full);

    await service.getFileDiff(
      "req-15",
      "/test/repo",
      "foo.ts",
      "modified",
      undefined,
      0,
      Number.MAX_SAFE_INTEGER
    );

    const event = mockSendEvent.mock.calls.at(-1)?.[0];
    expect(event.diff.length).toBe(GIT_FILE_DIFF_MAX_BYTES);
    expect(event.truncated).toBe(true);
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
