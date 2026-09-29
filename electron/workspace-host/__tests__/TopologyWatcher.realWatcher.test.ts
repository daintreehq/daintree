import { describe, it, expect, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TopologyWatcher, type TopologyWatcherHost } from "../TopologyWatcher.js";
import { closeAllParcelWatcherSubscriptions } from "../../utils/parcelWatcherBackend.js";

/**
 * Runs the topology watcher against a real `.git/worktrees/` with a real
 * @parcel/watcher subscription, so the claim that ordinary git activity inside
 * a linked worktree (commit, status, add) is not a topology change is checked
 * against what git and the OS actually write — while add/remove/lock still are.
 *
 * `TOPOLOGY_BENCH_ITERATIONS` scales the churn loop for benchmarking.
 */

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const ITERATIONS = Number(process.env.TOPOLOGY_BENCH_ITERATIONS ?? 3);
// Past the watcher's 500ms post-reconcile cooldown, so each git command is
// judged on its own rather than coalesced into its neighbour's reconcile.
const SPACING_MS = 650;
const SETTLE_MS = 1500;

const roots: string[] = [];
const watchers: TopologyWatcher[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"], env: GIT_ENV });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

interface Fixture {
  repo: string;
  worktrees: string[];
  topology: () => string;
}

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "daintree-topology-")));
  roots.push(base);
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore", env: GIT_ENV });
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  const worktrees = ["wt-a", "wt-b"].map((name) => {
    const path = join(base, name);
    git(repo, ["worktree", "add", "-b", name, path]);
    return path;
  });
  const topology = () =>
    execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
      env: GIT_ENV,
    });
  return { repo, worktrees, topology };
}

interface Probe {
  reconciles: number;
  listSpawns: number;
  listMs: number;
  lastTopology: string;
}

async function arm(fixture: Fixture): Promise<Probe> {
  const probe: Probe = { reconciles: 0, listSpawns: 0, listMs: 0, lastTopology: "" };
  const host: TopologyWatcherHost = {
    pollingEnabled: true,
    projectRootPath: fixture.repo,
    activeWorktreeId: null,
    monitors: new Map(),
    // Stands in for WorkspaceService.discoverAndSyncWorktrees: its fixed cost
    // is one `git worktree list --porcelain` spawn before the monitor re-sync.
    discoverAndSyncWorktrees: async () => {
      probe.reconciles++;
      probe.listSpawns++;
      const start = performance.now();
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
        cwd: fixture.repo,
        env: GIT_ENV,
      });
      probe.listMs += performance.now() - start;
      probe.lastTopology = stdout;
    },
    setActiveWorktree: () => {},
    sendEvent: () => {},
  };
  const watcher = new TopologyWatcher(host);
  watchers.push(watcher);
  await watcher.startWatcher();
  // Prove the subscription is live before counting: a watcher that never
  // armed would otherwise pass the no-churn assertion vacuously.
  const calibrate = fixture.worktrees[0]!;
  git(fixture.repo, ["worktree", "lock", calibrate]);
  await waitFor(() => probe.reconciles > 0 && probe.lastTopology.includes("locked"), 10_000);
  git(fixture.repo, ["worktree", "unlock", calibrate]);
  await waitFor(() => !probe.lastTopology.includes("locked"), 10_000);
  await sleep(SETTLE_MS);
  probe.reconciles = 0;
  probe.listSpawns = 0;
  probe.listMs = 0;
  return probe;
}

afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  await closeAllParcelWatcherSubscriptions();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("TopologyWatcher (real watcher)", () => {
  it("does not reconcile for commit/status/add churn inside linked worktrees", async () => {
    const fixture = makeFixture();
    const probe = await arm(fixture);

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      for (const wt of fixture.worktrees) {
        writeFileSync(join(wt, `file-${i}.txt`), `${i}\n`);
        git(wt, ["add", "."]);
        git(wt, ["commit", "-m", `change ${i}`]);
        // Plain `git status` refreshes the index (optional locks on).
        writeFileSync(join(wt, "README.md"), `touched ${i}\n`);
        git(wt, ["checkout", "--", "README.md"]);
        git(wt, ["status"]);
      }
      await sleep(SPACING_MS);
    }
    await sleep(SETTLE_MS);
    const elapsed = performance.now() - start;

    if (process.env.TOPOLOGY_BENCH_ITERATIONS) {
      process.stderr.write(
        `[topology-bench] iterations=${ITERATIONS} worktrees=${fixture.worktrees.length} ` +
          `reconciles=${probe.reconciles} listSpawns=${probe.listSpawns} ` +
          `listMs=${probe.listMs.toFixed(1)} elapsedMs=${elapsed.toFixed(0)}\n`
      );
    }

    expect(probe.reconciles).toBe(0);
  }, 120_000);

  it("reconciles promptly on worktree add, lock, unlock and remove", async () => {
    const fixture = makeFixture();
    const probe = await arm(fixture);
    const newPath = join(fixture.repo, "..", "wt-new");

    const step = async (args: string[], expectTopology: (t: string) => boolean) => {
      const before = probe.reconciles;
      git(fixture.repo, args);
      await waitFor(() => probe.reconciles > before && expectTopology(probe.lastTopology));
      // Drain the cooldown so the next step is judged on its own events.
      await sleep(SPACING_MS);
    };

    await step(["worktree", "add", "-b", "wt-new", newPath], (t) => t.includes("wt-new"));
    const record = (t: string) => t.split("\n\n").find((r) => r.includes("wt-new")) ?? "";
    await step(["worktree", "lock", "--reason", "busy", newPath], (t) =>
      record(t).includes("locked busy")
    );
    await step(["worktree", "unlock", newPath], (t) => !record(t).includes("locked"));
    await step(["worktree", "remove", newPath], (t) => !t.includes("wt-new"));
    expect(probe.lastTopology).toBe(fixture.topology());
  }, 60_000);

  it("reconciles when a linked worktree switches branch", async () => {
    const fixture = makeFixture();
    const probe = await arm(fixture);
    const wt = fixture.worktrees[0];
    git(wt, ["checkout", "-b", "renamed-branch"]);
    await waitFor(() => probe.reconciles > 0 && probe.lastTopology.includes("renamed-branch"));
  }, 30_000);
});
