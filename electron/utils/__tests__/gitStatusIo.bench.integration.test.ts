// Benchmark for the git status pass's I/O: spawns, stats and synchronous fs on
// the workspace-host loop. Not part of `npm test`; run with
//   npx vitest run --config vitest.integration.config.ts electron/utils/__tests__/gitStatusIo.bench.integration.test.ts
// Results are appended as `[bench] …` lines to $GIT_BENCH_OUT (default: a
// file in the OS temp dir, path printed to stderr).
import { describe, it, afterAll, afterEach, beforeAll, vi } from "vitest";
import { execFileSync } from "child_process";
import { createRequire, syncBuiltinESMExports } from "module";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { monitorEventLoopDelay, performance } from "perf_hooks";
import {
  getWorktreeChangesWithStats,
  __clearPerFileDiffStatCacheForTesting,
  __clearLastCommitLogCacheForTesting,
} from "../git.js";
import { GitStatusPass, type GitStatusPassHost } from "../../workspace-host/GitStatusPass.js";
import { StatPrecheck } from "../../workspace-host/StatPrecheck.js";
import { BaseDivergence } from "../../workspace-host/BaseDivergence.js";
import type { WatcherController } from "../../workspace-host/WatcherController.js";
import type { AdaptivePollingStrategy, NoteFileReader } from "../../services/worktree/index.js";

const require = createRequire(import.meta.url);
const cjsFs = require("fs") as typeof import("fs");
const cjsCp = require("child_process") as typeof import("child_process");

const roots: string[] = [];
const OUT = process.env.GIT_BENCH_OUT ?? join(tmpdir(), "daintree-git-status-io-bench.log");

function report(line: string): void {
  appendFileSync(OUT, line + "\n");
  process.stderr.write(line + "\n");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(trackedFiles: number): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "daintree-gitbench-")));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "bench@example.com");
  git(dir, "config", "user.name", "Bench");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "src"));
  for (let i = 0; i < trackedFiles; i++) {
    writeFileSync(join(dir, "src", `file-${i}.ts`), `export const v${i} = ${i};\n`);
  }
  writeFileSync(join(dir, "README.md"), "bench\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const realSpawn = cjsCp.spawn;

function countSpawns() {
  const calls: string[][] = [];
  const spy = vi.spyOn(cjsCp, "spawn").mockImplementation(((
    ...args: Parameters<typeof cjsCp.spawn>
  ) => {
    calls.push(((args[1] as string[] | undefined) ?? []).slice());
    return (realSpawn as (...a: unknown[]) => ReturnType<typeof cjsCp.spawn>)(...args);
  }) as typeof cjsCp.spawn);
  // simple-git's ESM build binds `spawn` as a named import.
  syncBuiltinESMExports();
  return {
    calls,
    count: (sub: string) => calls.filter((a) => a.includes(sub)).length,
    restore: () => {
      spy.mockRestore();
      syncBuiltinESMExports();
    },
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Spies patch the shared builtin modules; a throwing scenario must not leave
// them installed for the next one.
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.useRealTimers();
});

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("git status pass I/O bench", () => {
  beforeAll(() => {
    __clearPerFileDiffStatCacheForTesting();
    __clearLastCommitLogCacheForTesting();
  });

  it("(a) 150 modified tracked files, 10 forced passes", async () => {
    const repo = makeRepo(150);
    for (let i = 0; i < 150; i++) {
      writeFileSync(join(repo, "src", `file-${i}.ts`), `export const v${i} = ${i + 1};\n// x\n`);
    }
    const controller = new AbortController();
    // warm-up pass outside measurement is NOT done: the first pass is part of
    // the 10 so a cold+warm mix is measured the way a poll loop sees it.
    const spawns = countSpawns();
    const times: number[] = [];
    let zeroStat = 0;
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const res = await getWorktreeChangesWithStats(repo, {
        forceRefresh: true,
        signal: controller.signal,
      });
      times.push(performance.now() - t0);
      zeroStat = res.changes.filter((c) => c.insertions === 0 && c.deletions === 0).length;
    }
    spawns.restore();
    report(
      `[bench] (a) diff spawns=${spawns.count("diff")} totalSpawns=${spawns.calls.length} ` +
        `totalMs=${times.reduce((a, b) => a + b, 0).toFixed(1)} medianMs=${median(times).toFixed(1)} ` +
        `warmMedianMs=${median(times.slice(1)).toFixed(1)} filesWith0/0=${zeroStat}`
    );
  });

  it("(b) 200 untracked files, stat calls per forced pass", async () => {
    const repo = makeRepo(1);
    mkdirSync(join(repo, "untracked"));
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(repo, "untracked", `u-${i}.txt`), `line\n`.repeat((i % 7) + 1));
    }
    const controller = new AbortController();
    await getWorktreeChangesWithStats(repo, { forceRefresh: true, signal: controller.signal });
    const statSpy = vi.spyOn(cjsFs.promises, "stat");
    const passes = 5;
    for (let i = 0; i < passes; i++) {
      await getWorktreeChangesWithStats(repo, { forceRefresh: true, signal: controller.signal });
    }
    const untrackedStats = statSpy.mock.calls.filter((c) =>
      String(c[0]).includes(`${join(repo, "untracked")}`)
    ).length;
    const total = statSpy.mock.calls.length;
    statSpy.mockRestore();
    report(
      `[bench] (b) per pass: untracked-file stats=${untrackedStats / passes} allStats=${total / passes}`
    );
  });

  it("(c) spawns on a forced pass after 301s idle", async () => {
    const repo = makeRepo(20);
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(repo, "src", `file-${i}.ts`), `export const v${i} = 0;\n// y\n`);
    }
    const controller = new AbortController();
    await getWorktreeChangesWithStats(repo, { forceRefresh: true, signal: controller.signal });
    await getWorktreeChangesWithStats(repo, { forceRefresh: true, signal: controller.signal });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const warm = countSpawns();
      await getWorktreeChangesWithStats(repo, { forceRefresh: true, signal: controller.signal });
      warm.restore();
      vi.setSystemTime(Date.now() + 301_000);
      const spawns = countSpawns();
      await getWorktreeChangesWithStats(repo, { forceRefresh: true, signal: controller.signal });
      spawns.restore();
      report(
        `[bench] (c) warm pass spawns=${warm.calls.length}; after +301s spawns=${spawns.calls.length} ` +
          `(extra=${spawns.calls.length - warm.calls.length}: diff=${spawns.count("diff")} log=${spawns.count("log")})`
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("(d) sync fs per poll across 20 worktrees + event-loop delay with a slow fs", async () => {
    const main = makeRepo(5);
    const paths: string[] = [];
    for (let i = 0; i < 20; i++) {
      const wt = join(roots[roots.length - 1] + "-wt" + i);
      roots.push(wt);
      git(main, "worktree", "add", "-q", "-b", `feat-${i}`, wt);
      writeFileSync(join(wt, "src", "file-0.ts"), `changed ${i}\n`);
      paths.push(wt);
    }

    const passes = paths.map((p) => makePass(p));
    for (const { pass } of passes) await pass.run(true);

    const readdirSpy = vi.spyOn(cjsFs, "readdirSync");
    const statSyncSpy = vi.spyOn(cjsFs, "statSync");
    syncBuiltinESMExports();
    const rounds = 5;
    for (let r = 0; r < rounds; r++) {
      for (const { pass } of passes) await pass.run(false);
    }
    const idleReaddir = readdirSpy.mock.calls.length;
    const idleStat = statSyncSpy.mock.calls.length;
    readdirSpy.mockClear();
    statSyncSpy.mockClear();
    for (let r = 0; r < rounds; r++) {
      for (const { pass } of passes) await pass.run(true);
    }
    const forcedReaddir = readdirSpy.mock.calls.length;
    const forcedStat = statSyncSpy.mock.calls.length;
    readdirSpy.mockRestore();
    statSyncSpy.mockRestore();
    syncBuiltinESMExports();
    const polls = rounds * passes.length;
    report(
      `[bench] (d) idle poll: readdirSync=${idleReaddir / polls} statSync=${idleStat / polls}; ` +
        `forced pass: readdirSync=${forcedReaddir / polls} statSync=${forcedStat / polls}`
    );

    // Slow filesystem: every metadata read under a worktree's .git takes 20ms.
    // Sync reads busy-wait (blocking the loop, as a stalled mount does);
    // async reads resolve after a timer.
    const DELAY = 20;
    const busy = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        /* spin */
      }
    };
    const origReaddirSync = cjsFs.readdirSync;
    const origStatSync = cjsFs.statSync;
    const origReaddir = cjsFs.promises.readdir;
    const slowPath = (p: unknown) => typeof p === "string" && p.includes("daintree-gitbench-");
    const rs = vi.spyOn(cjsFs, "readdirSync").mockImplementation(((p: string, o?: unknown) => {
      if (slowPath(p)) busy(DELAY);
      return (origReaddirSync as (p: string, o?: unknown) => unknown)(p, o);
    }) as typeof cjsFs.readdirSync);
    const ss = vi.spyOn(cjsFs, "statSync").mockImplementation(((p: string, o?: unknown) => {
      if (slowPath(p)) busy(DELAY);
      return (origStatSync as (p: string, o?: unknown) => unknown)(p, o);
    }) as typeof cjsFs.statSync);
    const ra = vi.spyOn(cjsFs.promises, "readdir").mockImplementation((async (
      p: string,
      o?: unknown
    ) => {
      if (slowPath(p)) await new Promise((r) => setTimeout(r, DELAY));
      return (origReaddir as (p: string, o?: unknown) => Promise<unknown>)(p, o);
    }) as typeof cjsFs.promises.readdir);
    syncBuiltinESMExports();
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    const t0 = performance.now();
    await Promise.all(passes.map(({ pass }) => pass.run(false)));
    await Promise.all(passes.map(({ pass }) => pass.run(true)));
    const wall = performance.now() - t0;
    h.disable();
    rs.mockRestore();
    ss.mockRestore();
    ra.mockRestore();
    syncBuiltinESMExports();
    report(
      `[bench] (d) slow-fs 20 worktrees (idle round + forced round, concurrent): ` +
        `loopDelay max=${(h.max / 1e6).toFixed(1)}ms p99=${(h.percentile(99) / 1e6).toFixed(1)}ms ` +
        `mean=${(h.mean / 1e6).toFixed(1)}ms wall=${wall.toFixed(0)}ms`
    );
  }, 120_000);
});

function makePass(path: string) {
  const abort = new AbortController();
  const host = {
    id: path,
    path,
    name: path.split("/").pop() ?? path,
    mainBranch: "main",
    isCurrent: false,
    isRunning: true,
    basePollingInterval: 5_000,
    wslInvocation: undefined,
    abortSignal: abort.signal,
    prevEmittedIsDetached: false,
    prevEmittedHead: undefined,
    prevEmittedRepoState: undefined,
    hasInitialStatus: false,
    repoState: undefined,
    lastGitStatusCompletedAt: 0,
    isUpdating: false,
    branch: undefined,
    issueNumber: undefined,
    branchDerivedTitle: undefined,
    issueTitle: undefined,
    isDetached: false,
    head: undefined,
    mood: "stable",
    summary: undefined,
    worktreeChanges: null,
    clearPRInfo() {},
    clearLinked() {},
    onBranchChanged() {},
    onRemoved() {},
    stop() {},
    emitUpdate() {},
  } as GitStatusPassHost;
  const statPrecheck = new StatPrecheck({
    abortSignal: host.abortSignal,
    get branch() {
      return host.branch;
    },
    lastWatcherEventAt: 0,
  });
  const baseDivergence = new BaseDivergence(
    {
      get branch() {
        return host.branch;
      },
      isMainWorktree: false,
      mainBranch: "main",
      linkedPrBaseRef: undefined,
      path,
      wslInvocation: undefined,
      abortSignal: host.abortSignal,
    },
    statPrecheck
  );
  const watcherController = {
    currentMode: "none",
    takePending: () => false,
    update() {},
    markPending() {},
    flushPendingIfReady() {},
    scheduleDelayedFlush() {},
  } as unknown as WatcherController;
  const pollingStrategy = {
    recordNoChange() {},
    recordStateChange() {},
  } as unknown as AdaptivePollingStrategy;
  const noteReader = { read: async () => ({}) } as unknown as NoteFileReader;
  const pass = new GitStatusPass(
    host,
    statPrecheck,
    baseDivergence,
    watcherController,
    pollingStrategy,
    noteReader
  );
  return { pass, host };
}
