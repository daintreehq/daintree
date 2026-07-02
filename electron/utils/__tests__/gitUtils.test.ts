import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join as pathJoin } from "path";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

import {
  getGitBranch,
  getGitDir,
  getGitCommonDir,
  clearGitDirCache,
  clearGitCommonDirCache,
} from "../gitUtils.js";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

function mockGitOutput(stdout: string): void {
  execFileMock.mockImplementation((_file, _args, _opts, cb: ExecCallback) => cb(null, stdout, ""));
}

function mockGitFailure(message: string): void {
  execFileMock.mockImplementation((_file, _args, _opts, cb: ExecCallback) =>
    cb(new Error(message), "", "")
  );
}

beforeEach(() => {
  clearGitDirCache();
  clearGitCommonDirCache();
});

afterEach(() => {
  execFileMock.mockReset();
});

describe("getGitBranch", () => {
  it("returns the trimmed branch name", async () => {
    mockGitOutput("feature/foo\n");
    await expect(getGitBranch("/repo")).resolves.toBe("feature/foo");
  });

  it("returns null for a detached HEAD", async () => {
    mockGitOutput("HEAD\n");
    await expect(getGitBranch("/repo")).resolves.toBeNull();
  });

  it("returns null when git output is empty", async () => {
    mockGitOutput("\n");
    await expect(getGitBranch("/repo")).resolves.toBeNull();
  });

  it("returns null when git fails (not a repo / timeout)", async () => {
    mockGitFailure("not a git repository");
    await expect(getGitBranch("/not-a-repo")).resolves.toBeNull();
  });

  it("runs git in the given cwd with the requested timeout", async () => {
    mockGitOutput("main\n");
    await getGitBranch("/repo/path", { timeout: 1234 });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, opts] = execFileMock.mock.calls[0];
    expect(file).toBe("git");
    expect(args).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(opts).toMatchObject({ cwd: "/repo/path", timeout: 1234 });
  });

  it("defaults to a short 500ms timeout", async () => {
    mockGitOutput("main\n");
    await getGitBranch("/repo");
    expect(execFileMock.mock.calls[0][2]).toMatchObject({ timeout: 500 });
  });
});

describe("getGitDir caching", () => {
  it("resolves a relative git dir against the worktree path", async () => {
    mockGitOutput(".git\n");
    await expect(getGitDir("/repo")).resolves.toBe(pathJoin("/repo", ".git"));
  });

  it("dedupes concurrent callers into a single git spawn", async () => {
    const callbacks: ExecCallback[] = [];
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecCallback) => {
      callbacks.push(cb);
    });

    const first = getGitDir("/repo");
    const second = getGitDir("/repo");
    expect(execFileMock).toHaveBeenCalledTimes(1);

    callbacks[0](null, ".git\n", "");
    await expect(first).resolves.toBe(pathJoin("/repo", ".git"));
    await expect(second).resolves.toBe(pathJoin("/repo", ".git"));
  });

  it("serves later callers from the cache after resolution", async () => {
    mockGitOutput(".git\n");
    await getGitDir("/repo");
    await getGitDir("/repo");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("caches failures by default so a broken path doesn't re-spawn per call", async () => {
    mockGitFailure("not a git repository");
    await expect(getGitDir("/broken")).resolves.toBeNull();
    await expect(getGitDir("/broken")).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures when cacheErrors is false", async () => {
    mockGitFailure("not a git repository");
    await expect(getGitDir("/broken", { cacheErrors: false })).resolves.toBeNull();
    await expect(getGitDir("/broken", { cacheErrors: false })).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache entirely when cache is false", async () => {
    mockGitOutput(".git\n");
    await getGitDir("/repo", { cache: false });
    await getGitDir("/repo", { cache: false });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("re-resolves after clearGitDirCache", async () => {
    mockGitOutput(".git\n");
    await getGitDir("/repo");
    clearGitDirCache("/repo");
    await getGitDir("/repo");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("keeps git-dir and common-dir caches independent", async () => {
    mockGitOutput("/repo/.git\n");
    await expect(getGitDir("/repo")).resolves.toBe("/repo/.git");
    await expect(getGitCommonDir("/repo")).resolves.toBe("/repo/.git");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0][1]).toEqual(["rev-parse", "--git-dir"]);
    expect(execFileMock.mock.calls[1][1]).toEqual(["rev-parse", "--git-common-dir"]);
  });
});
