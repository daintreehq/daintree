import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
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

  it("is unknown when a .git file points nowhere, even for a folder known not to be a repository", async () => {
    const { worktree } = linkedWorktree("feature", () => `gitdir: ${path.join(root, "gone")}`);
    expect((await probeRepositorySleepSafety([worktree])).state).toBe("unknown");
    expect(await probeRepositorySleepSafety([worktree], { missingRepoIsClear: true })).toEqual({
      state: "unknown",
      reason: "ENOENT",
    });
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
    // One namespace directory, one module inside it and 255 modules inside that: 257 directories.
    const outer = absorbedModule("ns/outer");
    for (let i = 0; i < 255; i++) absorbedModule(`inner-${i}`, outer);
    expect(await probeRepositorySleepSafety([repo])).toEqual({
      state: "unknown",
      reason: "read-failed",
    });
  });

  it("shares the submodule budget across independent repositories", async () => {
    busyRepository(0, 128);
    const other = path.join(root, "other");
    for (let i = 0; i < 129; i++) absorbedModule(`mod-${i}`, path.join(other, ".git"));
    expect(await probeRepositorySleepSafety([repo, other])).toEqual({
      state: "unknown",
      reason: "read-failed",
    });
  });

  it.each([
    ["superproject first", false],
    ["submodule checkout first", true],
  ])(
    "walks a submodule checkout passed beside its superproject once (%s)",
    async (_order, moduleFirst) => {
      const moduleDir = absorbedModule("shared");
      for (let i = 0; i < 255; i++) absorbedModule(`inner-${i}`, moduleDir);
      const checkout = path.join(root, "shared");
      mkdirSync(checkout);
      writeFileSync(path.join(checkout, ".git"), `gitdir: ${moduleDir}\n`);
      const roots = moduleFirst ? [checkout, repo] : [repo, checkout];
      expect(await probeRepositorySleepSafety(roots)).toEqual({ state: "clear" });

      const moduleWorktree = path.join(moduleDir, "worktrees", "side");
      mkdirSync(moduleWorktree, { recursive: true });
      writeFileSync(path.join(moduleWorktree, "index.lock"), "");
      expect(await probeRepositorySleepSafety(roots)).toEqual({
        state: "busy",
        marker: "index.lock",
      });
    }
  );

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

  it("finds an operation in a submodule initialized from a linked worktree", async () => {
    // `git submodule update --init` in a linked worktree keeps the module under that worktree's git dir.
    const { linked, roots } = busyRepository(2, 20);
    const moduleDir = absorbedModule("dep", linked[1]!.gitDir);
    writeFileSync(path.join(moduleDir, "index.lock"), "");
    for (const checkouts of [[repo], roots]) {
      expect(await probeRepositorySleepSafety(checkouts)).toEqual({
        state: "busy",
        marker: "index.lock",
      });
    }
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

  it.skipIf(process.platform === "win32")(
    "resolves a relative gitdir from where a symlinked checkout really lives",
    async () => {
      const { gitDir } = linkedWorktree("wt");
      writeFileSync(path.join(gitDir, "index.lock"), "");
      const checkout = path.join(root, "nest", "wt");
      mkdirSync(checkout, { recursive: true });
      writeFileSync(path.join(checkout, ".git"), "gitdir: ../../repo/.git/worktrees/wt\n");
      // A clean repository where the same relative path lands when read through the link.
      const lookalike = path.join(root, "a", "repo", ".git", "worktrees", "wt");
      mkdirSync(lookalike, { recursive: true });
      writeFileSync(path.join(lookalike, "commondir"), "../..\n");
      mkdirSync(path.join(root, "a", "b"));
      const alias = path.join(root, "a", "b", "alias");
      symlinkSync(checkout, alias, "dir");
      expect(await probeRepositorySleepSafety([alias])).toEqual({
        state: "busy",
        marker: "index.lock",
      });
    }
  );

  it.skipIf(process.platform === "win32")(
    "agrees on a repository whichever symlink each checkout reaches it through",
    async () => {
      const moduleDir = absorbedModule("shared");
      for (let i = 0; i < 255; i++) absorbedModule(`inner-${i}`, moduleDir);
      const alias = path.join(root, "alias");
      symlinkSync(repo, alias, "dir");
      const gitLink = path.join(root, "git-link");
      symlinkSync(path.join(repo, ".git"), gitLink, "dir");
      const { worktree, gitDir } = linkedWorktree("wt");
      writeFileSync(path.join(gitDir, "commondir"), `${gitLink}\n`);
      const moduleLink = path.join(root, "module-link");
      symlinkSync(moduleDir, moduleLink, "dir");
      const moduleCheckout = path.join(root, "shared");
      mkdirSync(moduleCheckout);
      writeFileSync(path.join(moduleCheckout, ".git"), `gitdir: ${moduleLink}\n`);
      expect(await probeRepositorySleepSafety([alias, worktree, moduleCheckout])).toEqual({
        state: "clear",
      });
    }
  );

  it.skipIf(process.platform === "win32")(
    "follows a symlink in a relative gitdir before the .. after it, as git does",
    async () => {
      const checkout = path.join(root, "checkout");
      mkdirSync(checkout);
      mkdirSync(path.join(root, "deep", "x"), { recursive: true });
      symlinkSync(path.join(root, "deep", "x"), path.join(checkout, "hop"), "dir");
      writeFileSync(path.join(checkout, ".git"), "gitdir: hop/../admin\n");
      const admin = path.join(root, "deep", "admin");
      mkdirSync(admin);
      writeFileSync(path.join(admin, "commondir"), `${path.join(repo, ".git")}\n`);
      writeFileSync(path.join(admin, "index.lock"), "");
      // Where `hop/../admin` lands when the .. is collapsed before following the link.
      const lexical = path.join(checkout, "admin");
      mkdirSync(lexical);
      writeFileSync(path.join(lexical, "commondir"), `${path.join(repo, ".git")}\n`);
      expect(await probeRepositorySleepSafety([checkout])).toEqual({
        state: "busy",
        marker: "index.lock",
      });
    }
  );

  it.skipIf(process.platform === "win32")(
    "is unknown for a dangling .git symlink, even for a folder known not to be a repository",
    async () => {
      const folder = path.join(root, "unmounted");
      mkdirSync(folder);
      symlinkSync(path.join(root, "volume", ".git"), path.join(folder, ".git"), "dir");
      expect(await probeRepositorySleepSafety([folder], { missingRepoIsClear: true })).toEqual({
        state: "unknown",
        reason: "ENOENT",
      });
    }
  );

  it.skipIf(process.platform === "win32")(
    "is unknown when a linked worktree's commondir is a dangling symlink",
    async () => {
      const { worktree, gitDir } = linkedWorktree("feature");
      rmSync(path.join(gitDir, "commondir"));
      symlinkSync(path.join(root, "gone", "commondir"), path.join(gitDir, "commondir"));
      expect(await probeRepositorySleepSafety([worktree])).toEqual({
        state: "unknown",
        reason: "ENOENT",
      });
    }
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([
    ["neither listed nor searched", 0o000],
    ["searched but not listed", 0o111],
  ])("is unknown when a submodule directory can't be read (%s)", async (_access, mode) => {
    const { roots } = busyRepository(2, 3);
    const unreadable = path.join(repo, ".git", "modules", "libs");
    absorbedModule("libs/vendor");
    chmodSync(unreadable, mode);
    try {
      expect(await probeRepositorySleepSafety(roots, { missingRepoIsClear: true })).toEqual({
        state: "unknown",
        reason: "EACCES",
      });
    } finally {
      chmodSync(unreadable, 0o755);
    }
  });

  it("is unknown for a folder with no .git unless it is known not to be a repository", async () => {
    const folder = path.join(root, "plain");
    mkdirSync(folder);
    expect((await probeRepositorySleepSafety([folder])).state).toBe("unknown");
    expect(await probeRepositorySleepSafety([folder], { missingRepoIsClear: true })).toEqual({
      state: "clear",
    });
  });
});
