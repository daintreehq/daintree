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
 * Arm real watchers on each worktree, plus raw probes on the common dir and
 * its refs/heads that record every name the platform reports, so a quiet
 * watcher can be told apart from a transaction the platform never reported.
 */
async function arm(
  targets: Array<{ worktree: string; branch: string }>
): Promise<{ armed: Armed[]; commonNames: string[]; refNames: string[] }> {
  const counts = targets.map(() => 0);
  for (const [index, { worktree, branch }] of targets.entries()) {
    const watcher = new GitFileWatcher({
      worktreePath: worktree,
      branch,
      debounceMs: DEBOUNCE_MS,
      onChange: () => {
        counts[index]++;
      },
    });
    watchers.push(watcher);
    expect(await watcher.start()).toBe(true);
  }

  const commonDir = path.join(repoPath(), ".git");
  const commonNames: string[] = [];
  const refNames: string[] = [];
  probes.push(
    fs.watch(commonDir, (_type, name) => {
      commonNames.push(name ? name.toString() : "");
    }),
    fs.watch(path.join(commonDir, "refs", "heads"), (_type, name) => {
      refNames.push(name ? name.toString() : "");
    })
  );

  // FSEvents can replay writes from just before the stream opened.
  await delay(500);
  commonNames.length = 0;
  refNames.length = 0;
  counts.fill(0);
  return {
    armed: counts.map((_, index) => ({ changes: () => counts[index] })),
    commonNames,
    refNames,
  };
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

    it("refreshes only the worktree that committed", async () => {
      const {
        armed: [a, b],
        commonNames,
        refNames,
      } = await arm([
        { worktree: worktreePath("wt-a"), branch: "feat-a" },
        { worktree: worktreePath("wt-b"), branch: "feat-b" },
      ]);

      commit(worktreePath("wt-a"), "two");

      // B shares both probed directories, so once the probe has heard the
      // branch ref land, B's watchers have too; then outlast the debounce.
      await vi.waitFor(() => expect(refNames).toContain("feat-a"), { timeout: 5000 });
      await vi.waitFor(() => expect(a.changes()).toBeGreaterThan(0), { timeout: 5000 });
      await delay(DEBOUNCE_MS * 5);

      // Whatever the commit wrote straight into the common dir was a lock.
      expect(commonNames.every((name) => name === "packed-refs.lock")).toBe(true);
      expect(b.changes()).toBe(0);
    });

    it("refreshes no sibling when a linked worktree creates and switches to a branch", async () => {
      const {
        armed: [a, b],
        refNames,
      } = await arm([
        { worktree: worktreePath("wt-a"), branch: "feat-a" },
        { worktree: worktreePath("wt-b"), branch: "feat-b" },
      ]);

      git(worktreePath("wt-a"), "switch", "-q", "-c", "feat-a2");

      await vi.waitFor(() => expect(refNames).toContain("feat-a2"), { timeout: 5000 });
      await vi.waitFor(() => expect(a.changes()).toBeGreaterThan(0), { timeout: 5000 });
      await delay(DEBOUNCE_MS * 5);

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

      git(repoPath(), "pack-refs", "--all");

      await vi.waitFor(() => expect(a.changes()).toBeGreaterThan(0), { timeout: 5000 });
      await vi.waitFor(() => expect(b.changes()).toBeGreaterThan(0), { timeout: 5000 });
    });

    it("still refreshes a sibling when a packed branch is deleted", async () => {
      git(repoPath(), "branch", "gone");
      git(repoPath(), "pack-refs", "--all");
      const {
        armed: [b],
      } = await arm([{ worktree: worktreePath("wt-b"), branch: "feat-b" }]);

      git(worktreePath("wt-a"), "branch", "-q", "-D", "gone");

      await vi.waitFor(() => expect(b.changes()).toBeGreaterThan(0), { timeout: 5000 });
    });
  }
);
