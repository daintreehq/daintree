import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
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
    // The fs fast path probes .git asynchronously before falling back to the
    // subprocess, so wait for the (single, deduped) spawn to be issued.
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));

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

describe("filesystem fast path (no subprocess)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(pathJoin(tmpdir(), "daintree-gitdir-fastpath-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeGitDir(base: string): string {
    const gitDir = pathJoin(base, ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(pathJoin(gitDir, "HEAD"), "ref: refs/heads/main\n");
    return gitDir;
  }

  it("resolves a regular repo's .git directory without spawning git", async () => {
    const gitDir = makeGitDir(root);
    await expect(getGitDir(root)).resolves.toBe(gitDir);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("resolves a linked worktree's gitdir pointer file without spawning git", async () => {
    const mainRoot = pathJoin(root, "main");
    mkdirSync(mainRoot, { recursive: true });
    const mainGitDir = makeGitDir(mainRoot);
    const wtGitDir = pathJoin(mainGitDir, "worktrees", "wt1");
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(pathJoin(wtGitDir, "HEAD"), "ref: refs/heads/feature\n");
    const wtRoot = pathJoin(root, "wt1");
    mkdirSync(wtRoot, { recursive: true });
    writeFileSync(pathJoin(wtRoot, ".git"), `gitdir: ${wtGitDir}\n`);

    await expect(getGitDir(wtRoot)).resolves.toBe(wtGitDir);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("resolves a relative gitdir pointer against the worktree path", async () => {
    const target = pathJoin(root, "meta");
    mkdirSync(target, { recursive: true });
    writeFileSync(pathJoin(target, "HEAD"), "ref: refs/heads/main\n");
    const wtRoot = pathJoin(root, "wt");
    mkdirSync(wtRoot, { recursive: true });
    writeFileSync(pathJoin(wtRoot, ".git"), "gitdir: ../meta\n");

    await expect(getGitDir(wtRoot)).resolves.toBe(target);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("falls back to the subprocess when .git exists but has no HEAD", async () => {
    mkdirSync(pathJoin(root, ".git"), { recursive: true });
    mockGitFailure("not a git repository");
    await expect(getGitDir(root)).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the subprocess when no .git entry exists", async () => {
    mockGitFailure("not a git repository");
    await expect(getGitDir(root)).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("resolves the common dir through the commondir pointer without spawning git", async () => {
    const mainRoot = pathJoin(root, "main");
    mkdirSync(mainRoot, { recursive: true });
    const mainGitDir = makeGitDir(mainRoot);
    const wtGitDir = pathJoin(mainGitDir, "worktrees", "wt1");
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(pathJoin(wtGitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(pathJoin(wtGitDir, "commondir"), "../..\n");
    const wtRoot = pathJoin(root, "wt1");
    mkdirSync(wtRoot, { recursive: true });
    writeFileSync(pathJoin(wtRoot, ".git"), `gitdir: ${wtGitDir}\n`);

    await expect(getGitCommonDir(wtRoot)).resolves.toBe(mainGitDir);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns the git dir itself as common dir for a main worktree", async () => {
    const gitDir = makeGitDir(root);
    await expect(getGitCommonDir(root)).resolves.toBe(gitDir);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
