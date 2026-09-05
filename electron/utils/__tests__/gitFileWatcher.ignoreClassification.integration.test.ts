import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitFileWatcher } from "../gitFileWatcher.js";

/**
 * The burst-skip decision rests on claims about what real `git check-ignore`
 * reports, and the unit tests mock exactly those claims away. Two of them are
 * counter-intuitive enough that they were both wrong in review before being
 * measured against a real repository:
 *
 *  - a `.gitignore` that ignores ITSELF is untracked and ignored, so plain
 *    check-ignore reports it — editing it still changes what git status shows;
 *  - git's tracked-file exemption is a case-SENSITIVE index lookup, so on a
 *    case-insensitive filesystem a force-added `Keep.txt` renamed on disk to
 *    `keep.txt` stays tracked while check-ignore calls it ignored.
 *
 * These run the real watcher against real repositories with real git, so a
 * change to either assumption fails here rather than silently stranding the
 * sidebar on stale status.
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

const roots: string[] = [];
const watchers: GitFileWatcher[] = [];

function makeRepo(): { root: string; git: (args: string[]) => void } {
  const root = mkdtempSync(join(tmpdir(), "daintree-ignore-"));
  roots.push(root);
  const git = (args: string[]) => {
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"], env: GIT_ENV });
  };
  git(["init", "-b", "main", "."]);
  return { root, git };
}

interface Observed {
  changes: number;
  fileSignals: number;
}

/** Arm a real watcher on `root`, run `act`, and report what the callbacks saw. */
async function observe(root: string, act: () => void): Promise<Observed> {
  let changes = 0;
  let fileSignals = 0;
  const watcher = new GitFileWatcher({
    worktreePath: root,
    branch: "main",
    debounceMs: 300,
    watchWorktree: true,
    worktreeMinDebounceMs: 150,
    worktreeMaxDebounceMs: 400,
    onChange: () => {
      changes++;
    },
    onWorktreeFilesChanged: () => {
      fileSignals++;
    },
  });
  watchers.push(watcher);
  expect(await watcher.start()).toBe(true);
  // The recursive subscription arms asynchronously; let it settle so the
  // mutation under test is not raced by the arm itself.
  await new Promise((resolve) => setTimeout(resolve, 900));
  changes = 0;
  fileSignals = 0;
  act();
  await new Promise((resolve) => setTimeout(resolve, 3500));
  return { changes, fileSignals };
}

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worktree burst ignore classification against real git", () => {
  it("skips the status recompute for a burst confined to an ignored directory", async () => {
    const { root, git } = makeRepo();
    writeFileSync(join(root, ".gitignore"), ".output/\n");
    writeFileSync(join(root, "src.txt"), "committed\n");
    mkdirSync(join(root, ".output"));
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);

    const observed = await observe(root, () => {
      for (let i = 0; i < 15; i++) {
        writeFileSync(join(root, ".output", `chunk-${i}.js`), `build output ${i}\n`);
      }
    });

    expect(observed.changes).toBe(0);
    // The file browser must still learn about the writes (#11330).
    expect(observed.fileSignals).toBeGreaterThan(0);
  });

  it("refreshes for a tracked write in the same shape", async () => {
    const { root, git } = makeRepo();
    writeFileSync(join(root, ".gitignore"), ".output/\n");
    writeFileSync(join(root, "src.txt"), "committed\n");
    mkdirSync(join(root, ".output"));
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);

    const observed = await observe(root, () => {
      writeFileSync(join(root, "src.txt"), "modified\n");
    });

    expect(observed.changes).toBeGreaterThan(0);
  });

  it("refreshes for an edit to a .gitignore that ignores itself", async () => {
    const { root, git } = makeRepo();
    // Ignoring itself makes `.gitignore` untracked AND ignored, so plain
    // check-ignore reports it — the burst would classify as skippable on
    // membership alone while the rule change it carries alters status.
    writeFileSync(join(root, ".gitignore"), ".gitignore\n.output/\n");
    writeFileSync(join(root, "scratch.txt"), "visible\n");
    mkdirSync(join(root, ".output"));
    git(["add", "scratch.txt"]);
    git(["commit", "-m", "init"]);

    const observed = await observe(root, () => {
      appendFileSync(join(root, ".gitignore"), "scratch.txt\n");
    });

    expect(observed.changes).toBeGreaterThan(0);
  });

  it("refreshes for a modified tracked file whose on-disk case left the index behind", async () => {
    const { root, git } = makeRepo();
    writeFileSync(join(root, ".gitignore"), ".output/\n");
    mkdirSync(join(root, ".output"));
    writeFileSync(join(root, ".output", "Keep.txt"), "v1\n");
    git(["add", ".gitignore"]);
    git(["add", "-f", ".output/Keep.txt"]);
    git(["commit", "-m", "init"]);
    // Case-only rename through a temp name so it works on case-insensitive
    // filesystems too. The index keeps saying `Keep.txt`.
    renameSync(join(root, ".output", "Keep.txt"), join(root, ".output", "tmp-rename"));
    renameSync(join(root, ".output", "tmp-rename"), join(root, ".output", "keep.txt"));

    const observed = await observe(root, () => {
      writeFileSync(join(root, ".output", "keep.txt"), "v2 modified\n");
    });

    // On a case-insensitive filesystem check-ignore calls this path ignored
    // even though it is tracked and modified; the tracked-ignored guard is
    // what keeps the refresh happening. On a case-sensitive filesystem the
    // file is genuinely untracked-and-ignored, but the guard still fires
    // because `.output/Keep.txt` remains a tracked path matching an ignore
    // rule — so the expectation holds on both.
    expect(observed.changes).toBeGreaterThan(0);
  });
});
