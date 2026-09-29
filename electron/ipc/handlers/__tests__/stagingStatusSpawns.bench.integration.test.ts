// Benchmark for git subprocess counts behind the staging-status IPC handler and
// the plugin `host.git.status()` surface. Not part of `npm test`; run with
//   npx vitest run --config vitest.integration.config.ts electron/ipc/handlers/__tests__/stagingStatusSpawns.bench.integration.test.ts
// Results are appended as `[bench] …` lines to $GIT_BENCH_OUT (default: a file
// in the OS temp dir).
import { describe, it, afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import { execFileSync } from "child_process";
import { createRequire, syncBuiltinESMExports } from "module";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { performance } from "perf_hooks";

const ipcMainMock = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  webContents: { fromId: vi.fn(() => null) },
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue({ uiFeedbackSoundEnabled: false }) },
}));

vi.mock("../../../services/getSoundService.js", () => ({
  getSoundService: vi.fn().mockResolvedValue({ play: vi.fn() }),
}));

import { markIpcSecurityReady } from "../../ipcGuard.js";
import { registerGitWriteHandlers } from "../git-write.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { CHANNELS } from "../../channels.js";
import { PluginHostGit } from "../../../services/plugin/pluginHostGit.js";
import type { StagingStatus } from "../../../../shared/types/git.js";

const require = createRequire(import.meta.url);
const cjsCp = require("child_process") as typeof import("child_process");
const realSpawn = cjsCp.spawn;

const roots: string[] = [];
const OUT = process.env.GIT_BENCH_OUT ?? join(tmpdir(), "daintree-staging-spawns-bench.log");

function report(line: string): void {
  appendFileSync(OUT, line + "\n");
  process.stderr.write(line + "\n");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A clone of a bare remote, on `branch`, with staged and unstaged edits. */
function makeRepo(branch: string, trackRef: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "daintree-stagingbench-")));
  roots.push(base);
  const remote = join(base, "remote.git");
  const seed = join(base, "seed");
  const repo = join(base, "repo");
  git(base, "init", "-q", "--bare", "-b", "develop", remote);
  git(base, "init", "-q", "-b", "develop", seed);
  for (const [k, v] of [
    ["user.email", "bench@example.com"],
    ["user.name", "Bench"],
    ["commit.gpgsign", "false"],
  ]) {
    git(seed, "config", k, v);
  }
  for (let i = 0; i < 20; i++) writeFileSync(join(seed, `f${i}.txt`), `line ${i}\n`);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "develop");
  git(base, "clone", "-q", remote, repo);
  git(repo, "config", "user.email", "bench@example.com");
  git(repo, "config", "user.name", "Bench");
  // Local config outranks global, so the developer's own push.default can't
  // change what the name-mismatch scenario resolves.
  git(repo, "config", "push.default", "simple");
  if (branch !== "develop") git(repo, "checkout", "-q", "-b", branch, "--track", trackRef);
  for (let i = 0; i < 5; i++) writeFileSync(join(repo, `f${i}.txt`), `staged ${i}\n`);
  git(repo, "add", "-A");
  for (let i = 5; i < 10; i++) writeFileSync(join(repo, `f${i}.txt`), `unstaged ${i}\n`);
  writeFileSync(join(repo, "new.txt"), "untracked\n");
  return repo;
}

function countSpawns() {
  const calls: string[][] = [];
  const spy = vi.spyOn(cjsCp, "spawn").mockImplementation(((
    ...args: Parameters<typeof cjsCp.spawn>
  ) => {
    calls.push(((args[1] as string[] | undefined) ?? []).slice());
    return (realSpawn as (...a: unknown[]) => ReturnType<typeof cjsCp.spawn>)(...args);
  }) as typeof cjsCp.spawn);
  syncBuiltinESMExports();
  return {
    calls,
    restore: () => {
      spy.mockRestore();
      syncBuiltinESMExports();
    },
  };
}

/** The git subcommand, skipping leading `-c k=v` pairs. */
function subcommand(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-c") {
      i++;
      continue;
    }
    if (!argv[i]!.startsWith("-")) return argv[i]!;
  }
  return "?";
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

let getStagingStatus: (cwd: string) => Promise<StagingStatus>;

beforeAll(() => {
  markIpcSecurityReady();
  registerGitWriteHandlers({} as never);
  const entry = ipcMainMock.handle.mock.calls.find((c) => c[0] === CHANNELS.GIT_GET_STAGING_STATUS);
  if (!entry) throw new Error("staging status handler not registered");
  const handler = entry[1] as (event: unknown, cwd: string) => Promise<StagingStatus>;
  getStagingStatus = (cwd) => handler({}, cwd);
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function benchStaging(label: string, repo: string, expected: Partial<StagingStatus>) {
  const RUNS = 20;
  const perCall: number[] = [];
  const times: number[] = [];
  const bySub = new Map<string, number>();
  let last: StagingStatus | null = null;
  for (let i = 0; i < RUNS; i++) {
    _resetRateLimitQueuesForTest();
    const spawns = countSpawns();
    const t0 = performance.now();
    last = await getStagingStatus(repo);
    times.push(performance.now() - t0);
    spawns.restore();
    perCall.push(spawns.calls.length);
    if (i > 0) {
      for (const argv of spawns.calls) {
        const sub = subcommand(argv);
        bySub.set(sub, (bySub.get(sub) ?? 0) + 1);
      }
    }
  }
  expect(last).toMatchObject(expected);
  expect(last!.staged.length).toBe(5);
  expect(last!.unstaged.length).toBe(6);
  const breakdown = [...bySub.entries()]
    .sort()
    .map(([k, v]) => `${k}=${(v / (RUNS - 1)).toFixed(1)}`)
    .join(" ");
  report(
    `[bench] staging ${label}: coldSpawns=${perCall[0]} warmSpawns/call=${median(perCall.slice(1))} ` +
      `totalMs=${times.reduce((a, b) => a + b, 0).toFixed(1)} medianMs=${median(times).toFixed(2)} ` +
      `[${breakdown}]`
  );
}

describe("staging status + plugin git.status spawn bench", () => {
  it("staging status: branch tracking same-name upstream", async () => {
    const repo = makeRepo("develop", "origin/develop");
    await benchStaging("same-name", repo, {
      currentBranch: "develop",
      hasRemote: true,
      pushDestination: { remote: "origin", branch: "develop" },
      pullSource: { remote: "origin", branch: "develop" },
    });
  });

  it("staging status: worktree-style branch tracking a differently named upstream", async () => {
    const repo = makeRepo("feature/topic", "origin/develop");
    await benchStaging("name-mismatch", repo, {
      currentBranch: "feature/topic",
      hasRemote: true,
      pushDestination: { remote: "origin", branch: "feature/topic" },
      pullSource: { remote: "origin", branch: "develop" },
    });
  });

  it("plugin host.git.status(): 10 concurrent calls, then 10 sequential", async () => {
    const repo = makeRepo("feature/plugin", "origin/develop");
    const hostGit = new PluginHostGit("bench");
    // Settle one-time caches (static info, commit log) outside measurement.
    await hostGit.status(repo);
    await new Promise((r) => setTimeout(r, 1_100));

    const rounds: number[] = [];
    const times: number[] = [];
    for (let r = 0; r < 5; r++) {
      const spawns = countSpawns();
      const t0 = performance.now();
      const results = await Promise.all(Array.from({ length: 10 }, () => hostGit.status(repo)));
      times.push(performance.now() - t0);
      spawns.restore();
      rounds.push(spawns.calls.length);
      expect(results.every((s) => s.changedFileCount === 11)).toBe(true);
      await new Promise((res) => setTimeout(res, 1_100));
    }

    const seqSpawns = countSpawns();
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) await hostGit.status(repo);
    const seqMs = performance.now() - t0;
    seqSpawns.restore();

    report(
      `[bench] plugin concurrent x10: spawns/round=${median(rounds)} (rounds ${rounds.join(",")}) ` +
        `medianMs=${median(times).toFixed(1)}; sequential x10 back-to-back: spawns=${seqSpawns.calls.length} ` +
        `ms=${seqMs.toFixed(1)}`
    );
  });
});
