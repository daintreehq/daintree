import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLONE_STAGING_PREFIX, cloneIgnoredDirectories, type CloneTree } from "../worktreeClone.js";

/**
 * Real git and a real filesystem: "ignored in both trees" rests on how
 * `check-ignore` treats a directory that does not exist yet, and the staging
 * directory's invisibility on what `git status` actually reports.
 */

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: GIT_ENV,
  }).toString("utf8");
}

/** A main checkout and a fresh worktree of it, the shape the create tail sees. */
function makeCheckouts(gitignore = "node_modules/\n.venv/\nvendor/\nbuild/\n"): {
  src: string;
  dest: string;
} {
  const src = tempDir("daintree-wtclone-src-");
  git(src, ["init", "-b", "main", "."]);
  write(src, ".gitignore", gitignore);
  write(src, "packages/app/index.js", "tracked");
  git(src, ["add", "-f", "--", ".gitignore", "packages/app/index.js"]);
  git(src, ["commit", "-m", "init"]);
  const dest = join(tempDir("daintree-wtclone-wt-"), "wt");
  git(src, ["worktree", "add", "-b", "feature", dest]);
  return { src, dest };
}

function listTree(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTree(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

function stagingDirs(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith(CLONE_STAGING_PREFIX));
}

/** Stands in for the copy-on-write backend wherever the logic, not the clone, is under test. */
const plainCopy: CloneTree = async (src, dest) => {
  await cp(src, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
  return { ok: true };
};

beforeEach(() => {
  const home = tempDir("daintree-wtclone-home-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cloneIgnoredDirectories", () => {
  it("clones an ignored directory into the worktree and leaves no staging behind", async () => {
    const { src, dest } = makeCheckouts();
    write(src, "node_modules/left-pad/index.js", "module.exports = 1;");
    write(src, "node_modules/left-pad/package.json", "{}");

    const results = await cloneIgnoredDirectories(src, dest, ["node_modules"], {
      cloneTree: plainCopy,
    });

    expect(results).toEqual([{ path: "node_modules", outcome: "cloned" }]);
    expect(listTree(join(dest, "node_modules"))).toEqual([
      "left-pad/index.js",
      "left-pad/package.json",
    ]);
    expect(stagingDirs(dest)).toEqual([]);
    expect(git(dest, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("skips a merely untracked directory and a directory holding a tracked file", async () => {
    const { src, dest } = makeCheckouts();
    write(src, "scratch/notes.txt", "untracked, not ignored");
    write(src, "vendor/lib.js", "force-added");
    git(src, ["add", "-f", "--", "vendor/lib.js"]);
    git(src, ["commit", "-m", "vendor"]);
    write(src, "vendor/other.js", "ignored sibling");
    const cloneTree = vi.fn(plainCopy);

    const results = await cloneIgnoredDirectories(src, dest, ["scratch", "vendor"], {
      cloneTree,
    });

    expect(results.map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
    expect(results[0].reason).toMatch(/doesn't ignore it in the main checkout/);
    expect(results[1].reason).toMatch(/doesn't ignore it in the main checkout/);
    expect(cloneTree).not.toHaveBeenCalled();
    expect(existsSync(join(dest, "scratch"))).toBe(false);
  });

  it("skips a directory the worktree's own branch does not ignore", async () => {
    const { src, dest } = makeCheckouts();
    write(dest, ".gitignore", ".venv/\n");
    git(dest, ["commit", "-am", "stop ignoring node_modules"]);
    write(src, "node_modules/a.js", "a");

    const results = await cloneIgnoredDirectories(src, dest, ["node_modules"], {
      cloneTree: plainCopy,
    });

    expect(results).toEqual([
      {
        path: "node_modules",
        outcome: "skipped",
        reason: "Git doesn't ignore it in this worktree",
      },
    ]);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
  });

  it("never touches a destination that already exists, even an empty directory", async () => {
    const { src, dest } = makeCheckouts();
    write(src, "node_modules/a.js", "from main");
    write(src, ".venv/bin/python", "from main");
    mkdirSync(join(dest, "node_modules"));
    symlinkSync(join(dest, "missing"), join(dest, ".venv"));

    const results = await cloneIgnoredDirectories(src, dest, ["node_modules", ".venv"], {
      cloneTree: plainCopy,
    });

    expect(results.map((r) => r.reason)).toEqual([
      "It already exists in the worktree",
      "It already exists in the worktree",
    ]);
    expect(readdirSync(join(dest, "node_modules"))).toEqual([]);
    expect(lstatSync(join(dest, ".venv")).isSymbolicLink()).toBe(true);
  });

  it("rejects paths that could leave either tree, and a source that is a symlink", async () => {
    const { src, dest } = makeCheckouts();
    const outside = tempDir("daintree-wtclone-outside-");
    write(outside, "secret.txt", "outside");
    symlinkSync(outside, join(src, "build"));

    const results = await cloneIgnoredDirectories(
      src,
      dest,
      ["../escape", "/etc", ".git", "a/../b", "", "build", `${CLONE_STAGING_PREFIX}x`],
      { cloneTree: plainCopy }
    );

    const notRelative = "It isn't a relative path inside the project";
    expect(results.map((r) => r.reason)).toEqual([
      notRelative,
      notRelative,
      notRelative,
      notRelative,
      notRelative,
      "It's a symlink in the main checkout",
      "That name is reserved for Daintree's staging folders",
    ]);
    expect(results.every((r) => r.outcome === "skipped")).toBe(true);
    expect(existsSync(join(dest, "build"))).toBe(false);
  });

  it("refuses a path whose folders lead out of either tree through a symlink", async () => {
    const { src, dest } = makeCheckouts("node_modules/\n");
    const outside = tempDir("daintree-wtclone-outside-");
    write(outside, "linked/node_modules/a.js", "outside source");
    symlinkSync(join(outside, "linked"), join(src, "linked"));
    write(src, "deep/inner/node_modules/b.js", "b");
    mkdirSync(join(outside, "inner"));
    symlinkSync(outside, join(dest, "deep"));

    const results = await cloneIgnoredDirectories(
      src,
      dest,
      ["linked/node_modules", "deep/inner/node_modules"],
      { cloneTree: plainCopy }
    );

    expect(results.map((r) => r.reason)).toEqual([
      "It leads out of the main checkout",
      "Its parent folder leads out of the worktree",
    ]);
    expect(readdirSync(join(outside, "inner"))).toEqual([]);
  });

  it("publishes nothing when the destination's parent is swapped for a symlink mid-clone", async () => {
    const { src, dest } = makeCheckouts();
    write(src, "packages/app/node_modules/x.js", "x");
    const outside = tempDir("daintree-wtclone-outside-");
    const cloneTree: CloneTree = async (from, to, signal) => {
      await plainCopy(from, to, signal);
      rmSync(join(dest, "packages/app"), { recursive: true, force: true });
      symlinkSync(outside, join(dest, "packages/app"));
      return { ok: true };
    };

    const results = await cloneIgnoredDirectories(src, dest, ["packages/app/node_modules"], {
      cloneTree,
    });

    expect(results[0]).toEqual({
      path: "packages/app/node_modules",
      outcome: "skipped",
      reason: "Its parent folder changed while it was being cloned",
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(stagingDirs(dest)).toEqual([]);
  });

  it("publishes nothing when a folder further up is swapped for a symlink mid-clone", async () => {
    const { src, dest } = makeCheckouts();
    write(src, "packages/app/node_modules/x.js", "x");
    const outside = tempDir("daintree-wtclone-outside-");
    mkdirSync(join(outside, "app"));
    const cloneTree: CloneTree = async (from, to, signal) => {
      await plainCopy(from, to, signal);
      rmSync(join(dest, "packages"), { recursive: true, force: true });
      symlinkSync(outside, join(dest, "packages"));
      return { ok: true };
    };

    const results = await cloneIgnoredDirectories(src, dest, ["packages/app/node_modules"], {
      cloneTree,
    });

    expect(results[0].reason).toBe("Its parent folder changed while it was being cloned");
    expect(readdirSync(join(outside, "app"))).toEqual([]);
  });

  it("publishes nothing when setup is cancelled during the last checks before the rename", async () => {
    const { src, dest } = makeCheckouts();
    write(src, "node_modules/a.js", "a");
    const controller = new AbortController();
    const cloneTree: CloneTree = async (from, to, signal) => {
      await plainCopy(from, to, signal);
      // Fires on a later turn of the loop: after the backend's result has been
      // read, while the destination and its parent are being looked at again.
      setImmediate(() => controller.abort());
      return { ok: true };
    };

    const results = await cloneIgnoredDirectories(src, dest, ["node_modules"], {
      cloneTree,
      signal: controller.signal,
    });

    expect(results[0].reason).toBe("Setup was cancelled");
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
  });

  it("clones a nested path only when its parent folder exists in the worktree", async () => {
    const { src, dest } = makeCheckouts();
    write(src, "packages/app/node_modules/x.js", "x");
    write(src, "packages/gone/node_modules/y.js", "y");

    const results = await cloneIgnoredDirectories(
      src,
      dest,
      ["packages/app/node_modules", "packages/gone/node_modules"],
      { cloneTree: plainCopy }
    );

    expect(results).toEqual([
      { path: "packages/app/node_modules", outcome: "cloned" },
      {
        path: "packages/gone/node_modules",
        outcome: "skipped",
        reason: "Its parent folder isn't in the worktree",
      },
    ]);
    expect(readFileSync(join(dest, "packages/app/node_modules/x.js"), "utf8")).toBe("x");
    expect(existsSync(join(dest, "packages/gone"))).toBe(false);
  });

  it("keeps the staging directory out of git status while the clone runs", async () => {
    const { src, dest } = makeCheckouts();
    write(src, "node_modules/a/b/c.js", "c");
    let statusMidClone: string | undefined;
    const cloneTree: CloneTree = async (from, to, signal) => {
      await plainCopy(from, to, signal);
      statusMidClone = git(dest, ["status", "--porcelain", "--untracked-files=all"]);
      return { ok: true };
    };

    await cloneIgnoredDirectories(src, dest, ["node_modules"], { cloneTree });

    expect(statusMidClone).toBe("");
  });

  it("reports a failed clone as skipped and removes the partial tree", async () => {
    const { src, dest } = makeCheckouts();
    write(src, "node_modules/a.js", "a");
    const cloneTree: CloneTree = async (_from, to) => {
      mkdirSync(to);
      writeFileSync(join(to, "partial.js"), "half");
      return { ok: false, reason: "This volume doesn't support copy-on-write clones" };
    };

    const results = await cloneIgnoredDirectories(src, dest, ["node_modules"], { cloneTree });

    expect(results).toEqual([
      {
        path: "node_modules",
        outcome: "skipped",
        reason: "This volume doesn't support copy-on-write clones",
      },
    ]);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
    expect(stagingDirs(dest)).toEqual([]);
  });

  // Root unlinks inside a read-only folder anyway, so only an ordinary user
  // proves the repair pass runs.
  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "removes a failed partial tree even when it holds read-only folders",
    async () => {
      const { src, dest } = makeCheckouts();
      write(src, "node_modules/a.js", "a");
      const cloneTree: CloneTree = async (_from, to) => {
        mkdirSync(join(to, "locked/inner"), { recursive: true });
        writeFileSync(join(to, "locked/inner/file.js"), "x");
        chmodSync(join(to, "locked/inner"), 0o555);
        chmodSync(join(to, "locked"), 0o555);
        return { ok: false, reason: "cp --reflink=always exited 1" };
      };

      const results = await cloneIgnoredDirectories(src, dest, ["node_modules"], { cloneTree });

      expect(results[0].reason).toBe("cp --reflink=always exited 1");
      expect(stagingDirs(dest)).toEqual([]);
    }
  );

  it("aborts a clone that outruns its budget and skips the rest", async () => {
    const { src, dest } = makeCheckouts();
    write(src, "node_modules/a.js", "a");
    write(src, ".venv/b.py", "b");
    const cloneTree = vi.fn<CloneTree>(async (_from, to, signal) => {
      mkdirSync(to);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      return { ok: false, reason: "killed" };
    });

    const results = await cloneIgnoredDirectories(src, dest, ["node_modules", ".venv"], {
      cloneTree,
      timeoutMs: 50,
    });

    expect(results.map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
    expect(results[0].reason).toMatch(/ran out of its/);
    expect(results[1].reason).toMatch(/ran out of its/);
    expect(cloneTree).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
    expect(stagingDirs(dest)).toEqual([]);
  });

  it("stops when setup is cancelled mid-clone and publishes nothing", async () => {
    const { src, dest } = makeCheckouts();
    write(src, "node_modules/a.js", "a");
    const controller = new AbortController();
    const cloneTree: CloneTree = async (from, to, signal) => {
      await plainCopy(from, to, signal);
      controller.abort();
      return { ok: true };
    };

    const results = await cloneIgnoredDirectories(src, dest, ["node_modules"], {
      cloneTree,
      signal: controller.signal,
    });

    expect(results[0]).toEqual({
      path: "node_modules",
      outcome: "skipped",
      reason: "Setup was cancelled",
    });
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
    expect(stagingDirs(dest)).toEqual([]);
  });

  it("skips every entry on a platform without copy-on-write clones", async () => {
    const results = await cloneIgnoredDirectories(
      "/nowhere/src",
      "/nowhere/dest",
      ["a", "a", "b"],
      {
        platform: "win32",
      }
    );

    expect(results).toEqual([
      { path: "a", outcome: "skipped", reason: "Copy-on-write clones aren't supported on Windows" },
      { path: "b", outcome: "skipped", reason: "Copy-on-write clones aren't supported on Windows" },
    ]);
  });

  it.runIf(process.platform === "darwin")(
    "clones with clonefile on APFS, keeping symlinks, modes and contents",
    async () => {
      const { src, dest } = makeCheckouts();
      write(src, "node_modules/pkg/lib/index.js", "module.exports = 42;");
      write(src, "node_modules/pkg/bin/cli.js", "#!/usr/bin/env node");
      chmodSync(join(src, "node_modules/pkg/bin/cli.js"), 0o755);
      mkdirSync(join(src, "node_modules/.bin"));
      symlinkSync("../pkg/bin/cli.js", join(src, "node_modules/.bin/cli"));
      symlinkSync("/definitely/not/here", join(src, "node_modules/dangling"));

      const results = await cloneIgnoredDirectories(src, dest, ["node_modules"]);

      expect(results).toEqual([{ path: "node_modules", outcome: "cloned" }]);
      const cloned = join(dest, "node_modules");
      expect(readlinkSync(join(cloned, ".bin/cli"))).toBe("../pkg/bin/cli.js");
      expect(readlinkSync(join(cloned, "dangling"))).toBe("/definitely/not/here");
      expect(statSync(join(cloned, "pkg/bin/cli.js")).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(cloned, "pkg/lib/index.js"), "utf8")).toBe("module.exports = 42;");
      expect(stagingDirs(dest)).toEqual([]);
      expect(git(dest, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    }
  );
});
