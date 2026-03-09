import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const simpleGitMock = vi.hoisted(() => vi.fn());
const gitClientMock = vi.hoisted(() => ({
  branch: vi.fn(),
  diff: vi.fn(),
  raw: vi.fn(),
  getRemotes: vi.fn(),
  revparse: vi.fn(),
}));

vi.mock("simple-git", () => ({
  simpleGit: simpleGitMock,
}));

import { GitService } from "../GitService.js";

describe("GitService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-git-service-"));
    vi.clearAllMocks();
    simpleGitMock.mockImplementation(() => gitClientMock);
    gitClientMock.branch.mockResolvedValue({ branches: {} });
    gitClientMock.diff.mockResolvedValue("");
    gitClientMock.raw.mockResolvedValue("");
    gitClientMock.getRemotes.mockResolvedValue([]);
    gitClientMock.revparse.mockResolvedValue(`${tempDir}\n`);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("allows filenames containing double-dots that are not traversal segments", async () => {
    const filePath = path.join(tempDir, "notes..backup.txt");
    await fs.writeFile(filePath, "line one\nline two", "utf8");

    const service = new GitService(tempDir);
    const diff = await service.getFileDiff("notes..backup.txt", "untracked");

    expect(diff).toContain("+++ b/notes..backup.txt");
    expect(diff).toContain("+line one");
  });

  it("rejects traversal paths in getFileDiff", async () => {
    const service = new GitService(tempDir);

    await expect(service.getFileDiff("../secrets.txt", "modified")).rejects.toThrow(
      "Path traversal detected"
    );
  });

  it("returns BINARY_FILE for untracked binary files", async () => {
    const filePath = path.join(tempDir, "blob.bin");
    await fs.writeFile(filePath, Buffer.from([0x00, 0xff, 0x00, 0x7f]));

    const service = new GitService(tempDir);
    const diff = await service.getFileDiff("blob.bin", "untracked");

    expect(diff).toBe("BINARY_FILE");
  });

  it("finds next local branch suffix while ignoring remote-only conflicts", async () => {
    gitClientMock.branch.mockResolvedValue({
      branches: {
        "feature/foo+bar": { current: false, commit: "a" },
        "feature/foo+bar-2": { current: false, commit: "b" },
        "feature/foo+bar-10": { current: false, commit: "c" },
        "remotes/origin/feature/foo+bar-999": { current: false, commit: "d" },
      },
    });

    const service = new GitService(tempDir);
    const next = await service.findAvailableBranchName("feature/foo+bar");

    expect(next).toBe("feature/foo+bar-11");
  });

  it("filters pseudo HEAD references when listing branches", async () => {
    gitClientMock.branch.mockResolvedValue({
      branches: {
        main: { current: true, commit: "1" },
        "remotes/origin/main": { current: false, commit: "1" },
        "HEAD -> origin/main": { current: false, commit: "1" },
        "remotes/origin/HEAD": { current: false, commit: "1" },
      },
    });

    const service = new GitService(tempDir);
    const branches = await service.listBranches();

    expect(branches.map((branch) => branch.name)).toEqual(["main", "origin/main"]);
  });

  describe("compareWorktrees", () => {
    it("uses two-dot range by default", async () => {
      gitClientMock.raw.mockResolvedValue("");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test");

      expect(gitClientMock.raw).toHaveBeenCalledWith(
        expect.arrayContaining(["main..feature/test"])
      );
    });

    it("uses three-dot range when useMergeBase is true", async () => {
      gitClientMock.raw.mockResolvedValue("");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test", undefined, true);

      expect(gitClientMock.raw).toHaveBeenCalledWith(
        expect.arrayContaining(["main...feature/test"])
      );
    });

    it("returns file list for two-dot range", async () => {
      gitClientMock.raw.mockResolvedValue("M\tsrc/app.ts\nA\tsrc/new.ts\n");

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test");

      expect(typeof result).toBe("object");
      if (typeof result === "object") {
        expect(result.files).toHaveLength(2);
        expect(result.files[0]).toEqual({ status: "M", path: "src/app.ts" });
        expect(result.files[1]).toEqual({ status: "A", path: "src/new.ts" });
      }
    });

    it("returns file list for three-dot range (useMergeBase)", async () => {
      gitClientMock.raw.mockResolvedValue("M\tsrc/app.ts\n");

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test", undefined, true);

      expect(typeof result).toBe("object");
      if (typeof result === "object") {
        expect(result.files).toHaveLength(1);
        expect(result.files[0]).toEqual({ status: "M", path: "src/app.ts" });
      }
    });

    it("returns NO_CHANGES string for empty file diff", async () => {
      gitClientMock.raw.mockResolvedValue("   ");

      const service = new GitService(tempDir);
      const result = await service.compareWorktrees("main", "feature/test", "src/app.ts");

      expect(result).toBe("NO_CHANGES");
    });

    it("uses three-dot range for per-file diff when useMergeBase is true", async () => {
      gitClientMock.raw.mockResolvedValue("diff --git a/src/app.ts b/src/app.ts\n+new line");

      const service = new GitService(tempDir);
      await service.compareWorktrees("main", "feature/test", "src/app.ts", true);

      expect(gitClientMock.raw).toHaveBeenCalledWith(
        expect.arrayContaining(["main...feature/test", "--", "src/app.ts"])
      );
    });
  });
});
