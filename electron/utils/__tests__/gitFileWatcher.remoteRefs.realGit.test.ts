import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitFileWatcher } from "../gitFileWatcher.js";

// The unit suite fires synthetic fs.watch names. These run a real fetch under
// the platform's real watcher, because #16677 turns on which names a fetch
// actually produces in refs/remotes/origin: git 2.48+ takes HEAD.lock on every
// `git fetch <remote>`, and a moved ref lands as a rename onto its own name.

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

function commit(repo: string, content: string): void {
  fs.writeFileSync(path.join(repo, "file.txt"), content);
  git(repo, "add", "file.txt");
  git(repo, "commit", "-q", "-m", content);
}

/** The scheduled form `RepoFetchCoordinator` runs. */
function scheduledFetch(repo: string): void {
  git(repo, "fetch", "origin", "--no-auto-gc", "--prune", "--no-write-fetch-head");
}

/**
 * Arm a real watcher on `repo`, plus a raw probe on refs/remotes/origin that
 * records every name the platform reports, so a quiet watcher can be told
 * apart from a fetch that touched nothing.
 */
async function arm(
  repo: string
): Promise<{ changes: () => number; membershipChanges: () => number; names: string[] }> {
  let changes = 0;
  let membershipChanges = 0;
  const watcher = new GitFileWatcher({
    worktreePath: repo,
    branch: "main",
    debounceMs: DEBOUNCE_MS,
    onChange: () => {
      changes++;
    },
    // Every git-internal route but the remote-refs one reports membership, so
    // this stays zero only when the refresh came from refs/remotes/origin.
    onPathMembershipChanged: () => {
      membershipChanges++;
    },
  });
  watchers.push(watcher);
  expect(await watcher.start()).toBe(true);

  const names: string[] = [];
  const probe = fs.watch(path.join(repo, ".git", "refs", "remotes", "origin"), (_type, name) => {
    names.push(name ? name.toString() : "");
  });
  probes.push(probe);

  // FSEvents can replay writes from just before the stream opened.
  await delay(500);
  names.length = 0;
  changes = 0;
  membershipChanges = 0;
  return { changes: () => changes, membershipChanges: () => membershipChanges, names };
}

function setUp(): void {
  // The Windows temp directory can use an 8.3 alias that git expands.
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-remote-refs-")));
  fs.mkdirSync(path.join(root, "home"));
  // The watcher resolves the git dir with the process environment.
  vi.stubEnv("HOME", path.join(root, "home"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "home"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

  git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  commit(seed, "one");
  git(seed, "remote", "add", "origin", path.join(root, "remote.git"));
  git(seed, "push", "-q", "origin", "main");
  git(root, "clone", "-q", path.join(root, "remote.git"), "work");
}

// `init -b` needs 2.28 and `--no-write-fetch-head` 2.29.
describe.skipIf(!gitVersionAtLeast(2, 29))(
  "refs/remotes/origin watch against a real fetch (#16677)",
  () => {
    beforeEach(setUp);

    afterEach(() => {
      for (const watcher of watchers.splice(0)) watcher.dispose();
      for (const probe of probes.splice(0)) probe.close();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it.skipIf(!gitVersionAtLeast(2, 48))(
      "requests no status refresh for a fetch that moves no ref",
      async () => {
        const work = path.join(root, "work");
        const { changes, names } = await arm(work);

        scheduledFetch(work);
        // The probe shares the watcher's directory, so once it has heard the
        // fetch the watcher has too; then outlast the debounce.
        await vi.waitFor(() => expect(names.length).toBeGreaterThan(0), { timeout: 5000 });
        await delay(DEBOUNCE_MS * 5);

        // The fetch did reach the directory, as a lock and nothing else.
        expect(names.every((name) => name.endsWith(".lock"))).toBe(true);
        expect(changes()).toBe(0);
      }
    );

    it("requests a status refresh when the fetch advances origin/main", async () => {
      const work = path.join(root, "work");
      const before = git(work, "rev-parse", "refs/remotes/origin/main").trim();
      commit(path.join(root, "seed"), "two");
      git(path.join(root, "seed"), "push", "-q", "origin", "main");
      const { changes, membershipChanges } = await arm(work);

      scheduledFetch(work);

      expect(git(work, "rev-parse", "refs/remotes/origin/main").trim()).not.toBe(before);
      await vi.waitFor(() => expect(changes()).toBeGreaterThan(0), { timeout: 5000 });
      expect(membershipChanges()).toBe(0);
    });
  }
);
