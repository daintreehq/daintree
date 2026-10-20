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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-gitutils-realgit-")));
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
