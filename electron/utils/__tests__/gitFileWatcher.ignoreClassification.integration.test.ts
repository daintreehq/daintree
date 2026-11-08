import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkIgnoredPaths } from "../gitCheckIgnore.js";
import { GitFileWatcher } from "../gitFileWatcher.js";
import { buildHardenedGitEnv } from "../hardenedGit.js";
import { settleParcelWatcherLifecycle } from "../parcelWatcherBackend.js";

// Counts spawns while still answering with real git.
vi.mock("../gitCheckIgnore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gitCheckIgnore.js")>();
  return { ...actual, checkIgnoredPaths: vi.fn(actual.checkIgnoredPaths) };
});

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

/**
 * Porcelain status, so a test can prove a rule edit changed what git reports.
 * Without optional locks, as a plain status refreshes the index, and the watcher
 * would count that write as a change in whatever the test measures next.
 */
function status(root: string): string {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
    env: { ...GIT_ENV, GIT_OPTIONAL_LOCKS: "0" },
  });
}

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

/**
 * Arm a real watcher on `root` and return a probe that runs `act` and reports
 * what the callbacks saw. Reusing one probe lets a test prove the same live
 * subscription that stayed quiet for one mutation still hears another.
 */
async function arm(root: string): Promise<(act: () => void) => Promise<Observed>> {
  let changes = 0;
  let fileSignals = 0;
  let failed = false;
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
    onWatcherFailed: () => {
      failed = true;
    },
  });
  watchers.push(watcher);
  expect(await watcher.start()).toBe(true);
  // The recursive subscription arms asynchronously; let it settle so the
  // mutation under test is not raced by the arm itself.
  await settleParcelWatcherLifecycle();
  await new Promise((resolve) => setTimeout(resolve, 900));
  return async (act) => {
    changes = 0;
    fileSignals = 0;
    act();
    await new Promise((resolve) => setTimeout(resolve, 3500));
    // A dead subscription would report silence for any mutation at all.
    expect(failed).toBe(false);
    return { changes, fileSignals };
  };
}

async function observe(root: string, act: () => void): Promise<Observed> {
  return (await arm(root))(act);
}

afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.dispose();
  // Let the native unsubscribes land before the watched trees disappear.
  await settleParcelWatcherLifecycle();
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
    writeFileSync(join(root, "seed.txt"), "committed\n");
    // `scratch.txt` stays UNTRACKED on purpose. Committing it and then
    // ignoring it would leave it in status either way AND create a
    // tracked/ignored overlap, which trips the hazard probe — so the test
    // would still pass with the `.gitignore` guard deleted, proving nothing.
    writeFileSync(join(root, "scratch.txt"), "untracked and visible\n");
    mkdirSync(join(root, ".output"));
    git(["add", "seed.txt"]);
    git(["commit", "-m", "init"]);
    expect(status(root)).toContain("scratch.txt");

    const observed = await observe(root, () => {
      appendFileSync(join(root, ".gitignore"), "scratch.txt\n");
    });

    expect(observed.changes).toBeGreaterThan(0);
    // The rule edit really did change what status reports — otherwise the
    // refresh would be guarding nothing.
    expect(status(root)).not.toContain("scratch.txt");
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

describe("remembered relevant paths against real git (#16424)", () => {
  /** A repo holding a tracked file, an untracked visible one, and an ignored directory. */
  function seedRepo() {
    const repo = makeRepo();
    writeFileSync(join(repo.root, ".gitignore"), ".output/\n");
    writeFileSync(join(repo.root, "src.txt"), "committed\n");
    mkdirSync(join(repo.root, ".output"));
    writeFileSync(join(repo.root, ".output", "seed.js"), "build\n");
    repo.git(["add", ".gitignore", "src.txt"]);
    repo.git(["commit", "-m", "init"]);
    writeFileSync(join(repo.root, "scratch.txt"), "untracked and visible\n");
    return repo;
  }

  it("asks git once for repeated saves, across Daintree's own status passes", async () => {
    const { root } = seedRepo();
    const probe = await arm(root);

    const first = await probe(() => writeFileSync(join(root, "src.txt"), "one\n"));
    expect(first.changes).toBeGreaterThan(0);
    const spawns = vi.mocked(checkIgnoredPaths).mock.calls.length;
    expect(spawns).toBeGreaterThan(0);

    // The status pass runs under the hardened env: if it wrote the index, every
    // pass would wipe what the save just taught the watcher.
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      env: { ...GIT_ENV, ...buildHardenedGitEnv() },
    });

    const second = await probe(() => writeFileSync(join(root, "src.txt"), "two\n"));
    expect(second.changes).toBeGreaterThan(0);
    expect(vi.mocked(checkIgnoredPaths).mock.calls.length).toBe(spawns);
  });

  it("keeps skipping a rebuilt ignored directory after its delete was refreshed", async () => {
    const { root } = seedRepo();
    const probe = await arm(root);

    // git reports a deleted `.output` as not ignored, because `.output/` only
    // matches a directory, so this burst does refresh.
    const deleted = await probe(() => rmSync(join(root, ".output"), { recursive: true }));
    expect(deleted.changes).toBeGreaterThan(0);

    const rebuilt = await probe(() => {
      mkdirSync(join(root, ".output"));
      writeFileSync(join(root, ".output", "chunk.js"), "build\n");
    });
    expect(rebuilt.changes).toBe(0);
    expect(rebuilt.fileSignals).toBeGreaterThan(0);
  });

  it("skips a remembered path once a .gitignore rule ignores it", async () => {
    const { root } = seedRepo();
    const probe = await arm(root);
    const save = () => writeFileSync(join(root, "scratch.txt"), `${Math.random()}\n`);

    expect((await probe(save)).changes).toBeGreaterThan(0);
    expect(
      (await probe(() => appendFileSync(join(root, ".gitignore"), "scratch.txt\n"))).changes
    ).toBeGreaterThan(0);
    expect(status(root)).not.toContain("scratch.txt");

    expect((await probe(save)).changes).toBe(0);
  });

  it("skips a remembered path once .git/info/exclude ignores it", async () => {
    const { root } = seedRepo();
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    const probe = await arm(root);
    const save = () => writeFileSync(join(root, "scratch.txt"), `${Math.random()}\n`);

    expect((await probe(save)).changes).toBeGreaterThan(0);
    expect(
      (await probe(() => appendFileSync(join(root, ".git", "info", "exclude"), "scratch.txt\n")))
        .changes
    ).toBeGreaterThan(0);
    expect(status(root)).not.toContain("scratch.txt");

    expect((await probe(save)).changes).toBe(0);
  });

  it("stops trusting a remembered path in a linked worktree when the shared exclude changes", async () => {
    const { root, git } = seedRepo();
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    const linked = mkdtempSync(join(tmpdir(), "daintree-ignore-linked-"));
    rmSync(linked, { recursive: true });
    roots.push(linked);
    git(["worktree", "add", "-b", "feature", linked]);
    writeFileSync(join(linked, "scratch.txt"), "untracked and visible\n");

    const probe = await arm(linked);
    const save = () => writeFileSync(join(linked, "scratch.txt"), `${Math.random()}\n`);

    expect((await probe(save)).changes).toBeGreaterThan(0);
    expect(
      (await probe(() => appendFileSync(join(root, ".git", "info", "exclude"), "scratch.txt\n")))
        .changes
    ).toBeGreaterThan(0);
    expect(status(linked)).not.toContain("scratch.txt");

    expect((await probe(save)).changes).toBe(0);
  });

  it("stops trusting a remembered path once the index changes", async () => {
    const { root, git } = seedRepo();
    const probe = await arm(root);
    const save = () => writeFileSync(join(root, ".output", "forced.js"), `${Math.random()}\n`);

    // Force-added, so it is tracked though a rule matches it, and git says relevant.
    save();
    git(["add", "-f", ".output/forced.js"]);
    git(["commit", "-m", "force"]);
    await settleParcelWatcherLifecycle();
    expect((await probe(save)).changes).toBeGreaterThan(0);

    // `git rm --cached` leaves it untracked and ignored, which only the index shows.
    expect(
      (await probe(() => git(["rm", "--cached", "-q", ".output/forced.js"]))).changes
    ).toBeGreaterThan(0);
    git(["commit", "-m", "unforce"]);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect((await probe(save)).changes).toBe(0);
  });
});

describe("OS-level exclusion of hot directories", () => {
  it("drops writes under an excluded directory without hiding a source edit", async () => {
    // mkdtemp lands under /var on macOS, a symlink to /private/var. The
    // top-level node_modules is an OS-level exclusion; the nested one is only
    // reachable by the globs, which Parcel applies natively only when the
    // watcher subscribes at the canonical root.
    const { root, git } = makeRepo();
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileSync(join(root, "src.txt"), "committed\n");
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, "packages", "app", "node_modules"), { recursive: true });
    writeFileSync(join(root, "packages", "app", "index.ts"), "export {};\n");
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);

    const probe = await arm(root);
    const churn = await probe(() => {
      for (let i = 0; i < 15; i++) {
        for (const modules of [
          join(root, "node_modules"),
          join(root, "packages", "app", "node_modules"),
        ]) {
          mkdirSync(join(modules, `pkg-${i}`));
          writeFileSync(join(modules, `pkg-${i}`, "index.js"), `module ${i}\n`);
        }
      }
    });
    expect(churn).toEqual({ changes: 0, fileSignals: 0 });

    const edit = await probe(() => {
      writeFileSync(join(root, "src.txt"), "modified\n");
    });
    expect(edit.changes).toBeGreaterThan(0);
    expect(edit.fileSignals).toBeGreaterThan(0);
  });
});
