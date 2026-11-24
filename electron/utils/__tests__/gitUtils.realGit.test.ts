import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  clearGitCommonDirCache,
  clearGitDirCache,
  getGitCommonDir,
  getGitDir,
  readGitBranch,
} from "../gitUtils.js";

// Real git: the unit suite mocks child_process, so it cannot show a probe
// resolving a different repository from the one every other git call uses.

const require = createRequire(import.meta.url);
const cjsCp = require("child_process") as typeof import("child_process");

let root: string;
let home: string;
let main: string;
let linked: string;
let elsewhere: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
    stdio: "ignore",
  });
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(
    dir,
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=T",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init"
  );
}

beforeAll(() => {
  // The Windows temp directory can use an 8.3 alias that git expands.
  root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "daintree-gitutils-realgit-"))
  );
  home = path.join(root, "home");
  main = path.join(root, "main");
  linked = path.join(root, "linked");
  elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(home);
  makeRepo(main);
  makeRepo(elsewhere);
  git(main, "worktree", "add", "-q", "-b", "topic", linked);
  fs.mkdirSync(path.join(linked, "sub"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("git dir probes with another repository inherited through the environment", () => {
  beforeEach(() => {
    // The probes spawn with the process env, so keep the developer's config out.
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CEILING_DIRECTORIES", undefined);

    vi.stubEnv("GIT_DIR", path.join(elsewhere, ".git"));
    vi.stubEnv("GIT_COMMON_DIR", path.join(elsewhere, ".git"));
    vi.stubEnv("GIT_WORK_TREE", elsewhere);
    vi.stubEnv("GIT_INDEX_FILE", path.join(elsewhere, ".git", "index"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    clearGitDirCache();
    clearGitCommonDirCache();
  });

  // A subdirectory has no `.git` entry, so these go through `git rev-parse`.
  it("resolves the worktree's own common dir through git", async () => {
    const commonDir = await getGitCommonDir(path.join(linked, "sub"), { cache: false });
    expect(commonDir && fs.realpathSync(commonDir)).toBe(path.join(main, ".git"));
  });

  it("resolves the worktree's own git dir through git", async () => {
    const gitDir = await getGitDir(path.join(linked, "sub"), { cache: false });
    expect(gitDir && fs.realpathSync(gitDir)).toBe(path.join(main, ".git", "worktrees", "linked"));
  });

  it("resolves the same common dir from the `.git` entry without spawning git", async () => {
    const execFile = vi.spyOn(cjsCp, "execFile");
    syncBuiltinESMExports();

    const commonDir = await getGitCommonDir(linked, { cache: false });

    expect(commonDir && fs.realpathSync(commonDir)).toBe(path.join(main, ".git"));
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("branch reads", () => {
  let repo: string;
  let outside: string;

  beforeAll(() => {
    repo = path.join(root, "branchy");
    outside = path.join(root, "outside");
    makeRepo(repo);
    fs.mkdirSync(outside);
  });

  const read = (cwd: string) => readGitBranch(cwd, { timeout: 10_000 });

  beforeEach(() => {
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    // Discovery stops at the fixture root, so `outside` can't find a repo above it.
    vi.stubEnv("GIT_CEILING_DIRECTORIES", root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers a branch, then a detached HEAD, as git's own word rather than a failure", async () => {
    await expect(read(repo)).resolves.toEqual({
      branch: "main",
      unreadable: false,
    });

    git(repo, "checkout", "-q", "--detach");
    await expect(read(repo)).resolves.toEqual({
      branch: null,
      unreadable: false,
    });

    git(repo, "checkout", "-q", "main");
    await expect(read(repo)).resolves.toEqual({
      branch: "main",
      unreadable: false,
    });
  });

  it("answers a detached HEAD while git warns about the repository's config", async () => {
    const warned = path.join(root, "warned");
    makeRepo(warned);
    git(warned, "checkout", "-q", "--detach");
    git(warned, "config", "core.fsync", "not-a-component");
    await expect(read(warned)).resolves.toEqual({ branch: null, unreadable: false });
  });

  it("names a branch before its first commit, fresh or orphaned", async () => {
    const fresh = path.join(root, "fresh");
    fs.mkdirSync(fresh);
    git(fresh, "init", "-q", "-b", "trunk");
    await expect(read(fresh)).resolves.toEqual({ branch: "trunk", unreadable: false });

    const orphaned = path.join(root, "orphaned");
    makeRepo(orphaned);
    git(orphaned, "checkout", "-q", "--orphan", "rewrite");
    await expect(read(orphaned)).resolves.toEqual({ branch: "rewrite", unreadable: false });
  });

  it("calls a worktree whose metadata is gone unreadable, not branchless", async () => {
    const base = path.join(root, "pointed");
    const stranded = path.join(root, "stranded");
    makeRepo(base);
    git(base, "worktree", "add", "-q", "-b", "side", stranded);
    await expect(read(stranded)).resolves.toEqual({ branch: "side", unreadable: false });

    fs.rmSync(path.join(base, ".git", "worktrees", "stranded"), { recursive: true, force: true });
    await expect(read(stranded)).resolves.toEqual({ branch: null, unreadable: true });
  });

  it("answers a folder outside git as branchless", async () => {
    await expect(read(outside)).resolves.toEqual({
      branch: null,
      unreadable: false,
    });
  });
});
