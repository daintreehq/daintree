import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { probeRepositorySleepSafety } from "../gitSleepSafety.js";

describe("probeRepositorySleepSafety", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "git-sleep-safety-"));
    repo = path.join(root, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A linked worktree laid out as `git worktree add` leaves it, including `commondir`. */
  function linkedWorktree(name: string, gitdirLine?: (gitDir: string) => string) {
    const gitDir = path.join(repo, ".git", "worktrees", name);
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "commondir"), "../..\n");
    const worktree = path.join(root, name);
    mkdirSync(worktree);
    writeFileSync(
      path.join(worktree, ".git"),
      `${gitdirLine ? gitdirLine(gitDir) : `gitdir: ${gitDir}`}\n`
    );
    return { worktree, gitDir };
  }

  /** An absorbed submodule's git directory under `gitDir/modules/<name>`, as git lays it out. */
  function absorbedModule(name: string, gitDir = path.join(repo, ".git")) {
    const moduleDir = path.join(gitDir, "modules", name);
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(path.join(moduleDir, "HEAD"), "ref: refs/heads/main\n");
    return moduleDir;
  }

  /** One main checkout, `worktrees` linked worktrees of it and `modules` submodules. */
  function busyRepository(worktrees: number, modules: number) {
    const linked = Array.from({ length: worktrees }, (_, i) => linkedWorktree(`wt-${i}`));
    for (let i = 0; i < modules; i++) absorbedModule(`mod-${i}`);
    return { linked, roots: [repo, ...linked.map(({ worktree }) => worktree)] };
  }

  it("is clear for a repository with nothing in progress", async () => {
    linkedWorktree("feature");
    expect(await probeRepositorySleepSafety([repo])).toEqual({ state: "clear" });
  });

  it.each([
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "index.lock",
  ])("is busy while %s is present", async (marker) => {
    writeFileSync(path.join(repo, ".git", marker), "");
    expect(await probeRepositorySleepSafety([repo])).toEqual({ state: "busy", marker });
  });

  it("finds an operation in a linked worktree it was never told about", async () => {
    // Created outside Daintree: only the repository's own worktrees directory knows it.
    const { gitDir } = linkedWorktree("elsewhere");
    mkdirSync(path.join(gitDir, "rebase-merge"));
    expect(await probeRepositorySleepSafety([repo])).toEqual({
      state: "busy",
      marker: "rebase-merge",
    });
  });

  it("finds an operation paused inside an absorbed submodule", async () => {
    // Nested name, as `git submodule absorbgitdirs` lays out `libs/vendor`.
    const moduleDir = path.join(repo, ".git", "modules", "libs", "vendor");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(path.join(moduleDir, "HEAD"), "ref: refs/heads/main\n");
    expect(await probeRepositorySleepSafety([repo])).toEqual({ state: "clear" });

    mkdirSync(path.join(moduleDir, "rebase-merge"));
    expect(await probeRepositorySleepSafety([repo])).toEqual({
      state: "busy",
      marker: "rebase-merge",
    });
  });

  it("follows a linked worktree's .git file and commondir back to the main repository", async () => {
    const { worktree } = linkedWorktree("feature");
    writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), "");
    expect(await probeRepositorySleepSafety([worktree])).toEqual({
      state: "busy",
      marker: "MERGE_HEAD",
    });
  });

  it("resolves a relative gitdir against the worktree", async () => {
    const { worktree, gitDir } = linkedWorktree(
      "feature",
      (dir) => `gitdir: ${path.relative(path.join(root, "feature"), dir)}`
    );
    writeFileSync(path.join(gitDir, "index.lock"), "");
    expect(await probeRepositorySleepSafety([worktree])).toEqual({
      state: "busy",
      marker: "index.lock",
    });
  });

  it("is unknown when a .git file is malformed", async () => {
    const { worktree } = linkedWorktree("feature", () => "not a gitdir line");
    expect((await probeRepositorySleepSafety([repo, worktree])).state).toBe("unknown");
  });

  it("is unknown when a .git file points nowhere", async () => {
    const { worktree } = linkedWorktree("feature", () => `gitdir: ${path.join(root, "gone")}`);
    expect((await probeRepositorySleepSafety([worktree])).state).toBe("unknown");
  });

  it("walks a repository once however many of its checkouts are passed", async () => {
    const { roots } = busyRepository(12, 20);
    expect(await probeRepositorySleepSafety([repo])).toEqual({ state: "clear" });
    expect(await probeRepositorySleepSafety(roots)).toEqual({ state: "clear" });
  });

  it("spends the submodule budget on distinct directories", async () => {
    const { roots } = busyRepository(1, 256);
    expect(await probeRepositorySleepSafety(roots)).toEqual({ state: "clear" });
  });

  it("is unknown when a repository really has more submodule directories than the budget", async () => {
    busyRepository(0, 257);
    expect(await probeRepositorySleepSafety([repo])).toEqual({
      state: "unknown",
      reason: "read-failed",
    });
  });

  it("finds an operation in one worktree among many passed together", async () => {
    const { linked, roots } = busyRepository(12, 20);
    mkdirSync(path.join(linked[7]!.gitDir, "rebase-merge"));
    expect(await probeRepositorySleepSafety(roots)).toEqual({
      state: "busy",
      marker: "rebase-merge",
    });
  });

  it("finds an operation in a submodule nested inside another", async () => {
    const { roots } = busyRepository(12, 20);
    const nested = absorbedModule("inner", absorbedModule("mod-3"));
    writeFileSync(path.join(nested, "MERGE_HEAD"), "");
    expect(await probeRepositorySleepSafety(roots)).toEqual({
      state: "busy",
      marker: "MERGE_HEAD",
    });
  });

  it("keeps a worktree's own git directory when its repository was already walked", async () => {
    // Admin directory outside `.git/worktrees`, so only the checkout's own .git file reaches it.
    const gitDir = path.join(root, "admin", "detached");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "commondir"), `${path.join(repo, ".git")}\n`);
    writeFileSync(path.join(gitDir, "index.lock"), "");
    const worktree = path.join(root, "detached");
    mkdirSync(worktree);
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    expect(await probeRepositorySleepSafety([repo, worktree])).toEqual({
      state: "busy",
      marker: "index.lock",
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "is unknown when a submodule directory can't be read",
    async () => {
      const { roots } = busyRepository(2, 3);
      const unreadable = path.join(repo, ".git", "modules", "libs");
      absorbedModule("libs/vendor");
      chmodSync(unreadable, 0o000);
      try {
        expect(await probeRepositorySleepSafety(roots)).toEqual({
          state: "unknown",
          reason: "EACCES",
        });
      } finally {
        chmodSync(unreadable, 0o755);
      }
    }
  );

  it("is unknown for a folder with no .git unless it is known not to be a repository", async () => {
    const folder = path.join(root, "plain");
    mkdirSync(folder);
    expect((await probeRepositorySleepSafety([folder])).state).toBe("unknown");
    expect(await probeRepositorySleepSafety([folder], { missingRepoIsClear: true })).toEqual({
      state: "clear",
    });
  });
});
