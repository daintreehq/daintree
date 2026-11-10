import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitFileWatcher } from "../gitFileWatcher.js";

// The unit suite fires synthetic fs.watch names. These run real ref
// transactions under the platform's real watcher, because #16678 turns on
// which names a commit in one linked worktree produces in the common dir every
// other worktree watches: `packed-refs.lock` and the branch's own loose ref.

let root: string;
const watchers: GitFileWatcher[] = [];
const probes: fs.FSWatcher[] = [];
/** Last time a probe heard a name or a watcher requested a refresh. */
let lastActivityAt = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: path.join(root, "home"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      LC_ALL: "C",
    },
  });
}

function gitVersionAtLeast(major: number, minor: number): boolean {
  const match = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }));
  if (!match) return false;
  const [have, haveMinor] = [Number(match[1]), Number(match[2])];
  return have > major || (have === major && haveMinor >= minor);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DEBOUNCE_MS = 100;
const QUIET_MS = DEBOUNCE_MS * 4;

/**
 * Wait until neither the probes nor the watchers have reported anything for
 * `QUIET_MS`, so a late or replayed event (FSEvents can replay writes from
 * just before a stream opened) has landed before counts are read or reset.
 * Bounded: absence after a quiet window is evidence, not a drain guarantee.
 */
async function settle(): Promise<void> {
  const deadline = Date.now() + 5000;
  await delay(QUIET_MS);
  while (Date.now() - lastActivityAt < QUIET_MS && Date.now() < deadline) {
    await delay(50);
  }
}

function commit(worktree: string, content: string): void {
  fs.writeFileSync(path.join(worktree, "file.txt"), content);
  git(worktree, "add", "file.txt");
  git(worktree, "commit", "-q", "-m", content);
}

const repoPath = () => path.join(root, "repo");
const worktreePath = (name: string) => path.join(root, name);

interface Armed {
  changes: () => number;
}

/**
 * Arm real watchers on each worktree, plus raw probes on the shared
 * directories they watch, recording every name the platform reports. The
 * common-dir probe hears `packed-refs.lock` through the same directory a
 * sibling's watcher does, so it shows the stimulus reached that watcher.
 */
async function arm(
  targets: Array<{ worktree: string; branch: string }>
): Promise<{ armed: Armed[]; commonNames: string[] }> {
  const counts = targets.map(() => 0);
  for (const [index, { worktree, branch }] of targets.entries()) {
    const watcher = new GitFileWatcher({
      worktreePath: worktree,
      branch,
      debounceMs: DEBOUNCE_MS,
      onChange: () => {
        counts[index]++;
        lastActivityAt = Date.now();
      },
    });
    watchers.push(watcher);
    expect(await watcher.start()).toBe(true);
  }

  const commonDir = path.join(repoPath(), ".git");
  const commonNames: string[] = [];
  for (const dir of [
    commonDir,
    path.join(commonDir, "refs", "heads"),
    path.join(commonDir, "logs"),
  ]) {
    probes.push(
      fs.watch(dir, (_type, name) => {
        if (dir === commonDir) commonNames.push(name ? name.toString() : "");
        lastActivityAt = Date.now();
      })
    );
  }

  await settle();
  commonNames.length = 0;
  counts.fill(0);
  return {
    armed: counts.map((_, index) => ({ changes: () => counts[index] })),
    commonNames,
  };
}

/**
 * Wait for the transaction's `packed-refs.lock` to reach the common dir. A git
 * that doesn't take it for this transaction never had the fan-out, so the
 * case has nothing to prove there.
 */
async function heardPackedRefsLock(commonNames: string[]): Promise<boolean> {
  try {
    await vi.waitFor(() => expect(commonNames).toContain("packed-refs.lock"), { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function setUp(): void {
  // The Windows temp directory can use an 8.3 alias that git expands.
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-packed-refs-")));
  fs.mkdirSync(path.join(root, "home"));
  // The watcher resolves the git dir with the process environment.
  vi.stubEnv("HOME", path.join(root, "home"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "home"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

  const repo = repoPath();
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  // Nothing but the transaction under test may touch the common dir.
  git(repo, "config", "gc.auto", "0");
  git(repo, "config", "maintenance.auto", "false");
  commit(repo, "one");
  git(repo, "worktree", "add", "-q", "-b", "feat-a", worktreePath("wt-a"));
  git(repo, "worktree", "add", "-q", "-b", "feat-b", worktreePath("wt-b"));
}

// `init -b` needs 2.28.
describe.skipIf(!gitVersionAtLeast(2, 28))(
  "packed-refs.lock in the shared common dir (#16678)",
  () => {
    beforeEach(setUp);

    afterEach(() => {
      for (const watcher of watchers.splice(0)) watcher.dispose();
      for (const probe of probes.splice(0)) probe.close();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("refreshes only the worktree that committed", async (ctx) => {
      const packedRefsPath = path.join(repoPath(), ".git", "packed-refs");
      const readPackedRefs = () =>
        fs.existsSync(packedRefsPath) ? fs.readFileSync(packedRefsPath, "utf8") : null;
      const packedRefsBefore = readPackedRefs();
      const {
        armed: [a, b],
        commonNames,
      } = await arm([
        { worktree: worktreePath("wt-a"), branch: "feat-a" },
        { worktree: worktreePath("wt-b"), branch: "feat-b" },
      ]);

      commit(worktreePath("wt-a"), "two");

      if (!(await heardPackedRefsLock(commonNames))) ctx.skip();
      await vi.waitFor(() => expect(a.changes()).toBeGreaterThan(0), { timeout: 5000 });
      await settle();

      // Directory notifications vary by OS; packed refs must stay unchanged
      // while the committing worktree's loose ref moves.
      expect(readPackedRefs()).toBe(packedRefsBefore);
      expect(b.changes()).toBe(0);
    });

    it("refreshes no sibling when a linked worktree creates and switches to a branch", async (ctx) => {
      const {
        armed: [a, b],
        commonNames,
      } = await arm([
        { worktree: worktreePath("wt-a"), branch: "feat-a" },
        { worktree: worktreePath("wt-b"), branch: "feat-b" },
      ]);

      git(worktreePath("wt-a"), "switch", "-q", "-c", "feat-a2");

      if (!(await heardPackedRefsLock(commonNames))) ctx.skip();
      await vi.waitFor(() => expect(a.changes()).toBeGreaterThan(0), { timeout: 5000 });
      await settle();

      expect(commonNames.every((name) => name === "packed-refs.lock")).toBe(true);
      expect(b.changes()).toBe(0);
    });

    // The main worktree's branch is every sibling's default base, and it moves
    // only through the main worktree, whose reflog is the shared logs/HEAD.
    it("still refreshes a linked worktree when the main worktree commits", async () => {
      const {
        armed: [b],
      } = await arm([{ worktree: worktreePath("wt-b"), branch: "feat-b" }]);

      commit(repoPath(), "two");

      await vi.waitFor(() => expect(b.changes()).toBeGreaterThan(0), { timeout: 5000 });
    });

    it("still refreshes every worktree when pack-refs rewrites packed-refs", async () => {
      const {
        armed: [a, b],
      } = await arm([
        { worktree: worktreePath("wt-a"), branch: "feat-a" },
        { worktree: worktreePath("wt-b"), branch: "feat-b" },
      ]);

      // Loose refs stay, so the packed-refs rename is the only signal.
      git(repoPath(), "pack-refs", "--all", "--no-prune");

      await vi.waitFor(() => expect(a.changes()).toBeGreaterThan(0), { timeout: 5000 });
      await vi.waitFor(() => expect(b.changes()).toBeGreaterThan(0), { timeout: 5000 });
    });

    it("still refreshes a sibling when a packed branch is deleted", async () => {
      git(repoPath(), "branch", "gone");
      git(repoPath(), "pack-refs", "--all");
      const {
        armed: [b],
      } = await arm([{ worktree: worktreePath("wt-b"), branch: "feat-b" }]);

      // Plumbing, because `git branch -D` also rewrites the config, which is
      // a signal of its own.
      git(worktreePath("wt-a"), "update-ref", "-d", "refs/heads/gone");

      await vi.waitFor(() => expect(b.changes()).toBeGreaterThan(0), { timeout: 5000 });
    });
  }
);
