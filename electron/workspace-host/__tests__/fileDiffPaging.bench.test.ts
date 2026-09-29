/**
 * Paged file-diff benchmark. Skipped unless DAINTREE_BENCH=1:
 *
 *   DAINTREE_BENCH=1 npx vitest run electron/workspace-host/__tests__/fileDiffPaging.bench.test.ts
 *
 * Builds a real temp git repo with a tracked file rewritten line-for-line, so
 * `git diff HEAD` over it is ~10MB / ~20MB, then reads the whole diff through
 * a real WorkspaceService by following `nextOffset` — first at the 1MB
 * transport ceiling, then at the 24KB default window agents page with.
 * Reports git spawns (all, and full `git diff` runs), bytes git wrote to stdout, wall time, host CPU time and
 * sampled peak memory (heapUsed + external + arrayBuffers above the pre-read
 * level; run with NODE_OPTIONS=--expose-gc for a settled starting point).
 */
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";
import {
  GIT_FILE_DIFF_DEFAULT_MAX_BYTES,
  GIT_FILE_DIFF_MAX_BYTES,
} from "../../../shared/config/gitReadLimits.js";

vi.mock("../../utils/parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: vi.fn(() => Promise.resolve({ unsubscribe: vi.fn() })),
}));

const BENCH = process.env.DAINTREE_BENCH === "1";
const REPEATS = Number(process.env.DAINTREE_BENCH_REPEATS ?? 3);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Bench",
  GIT_AUTHOR_EMAIL: "bench@example.test",
  GIT_COMMITTER_NAME: "Bench",
  GIT_COMMITTER_EMAIL: "bench@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" });
}

function lines(bytes: number, tag: string): string {
  const out: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `${tag} line ${i} ${"x".repeat(60)} é ${i % 97}`;
    out.push(line);
    size += Buffer.byteLength(line) + 1;
  }
  return out.join("\n") + "\n";
}

type DiffResult = Extract<WorkspaceHostEvent, { type: "get-file-diff-result" }>;

let spawnCount = 0;
let diffSpawnCount = 0;
let gitStdoutBytes = 0;
const originalSpawn = childProcess.spawn;

describe.skipIf(!BENCH)("paged getFileDiff benchmark", () => {
  let tmp: string;
  let repo: string;
  let service: WorkspaceService;
  let last: DiffResult | null = null;
  const report: string[] = [];

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), "diff-page-bench-")));
    repo = path.join(tmp, "repo");
    git(tmp, "init", "-q", "-b", "main", repo);
    // Each file is fully rewritten, so the diff is roughly old + new bytes.
    writeFileSync(path.join(repo, "d10.txt"), lines(5 * 1024 * 1024, "old"));
    writeFileSync(path.join(repo, "d20.txt"), lines(10 * 1024 * 1024, "old"));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    writeFileSync(path.join(repo, "d10.txt"), lines(5 * 1024 * 1024, "new"));
    writeFileSync(path.join(repo, "d20.txt"), lines(10 * 1024 * 1024, "new"));

    (childProcess as { spawn: typeof originalSpawn }).spawn = ((...args: unknown[]) => {
      spawnCount++;
      if (Array.isArray(args[1]) && args[1].includes("diff")) diffSpawnCount++;
      const child = (originalSpawn as (...a: unknown[]) => ReturnType<typeof originalSpawn>)(
        ...args
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        gitStdoutBytes += chunk.length;
      });
      return child;
    }) as typeof originalSpawn;
    // simple-git's ESM build binds `spawn` as a named import.
    syncBuiltinESMExports();

    const { WorkspaceService } = await import("../WorkspaceService.js");
    service = new WorkspaceService((event) => {
      if (event.type === "get-file-diff-result") last = event;
    });
  }, 120_000);

  afterAll(() => {
    (childProcess as { spawn: typeof originalSpawn }).spawn = originalSpawn;
    syncBuiltinESMExports();
    service?.dispose();
    rmSync(tmp, { recursive: true, force: true });
    if (report.length) process.stderr.write("\n" + report.join("\n") + "\n");
  });

  async function readAll(file: string, pageBytes: number, maxPages = Infinity) {
    const pages: string[] = [];
    let offset: number | null = 0;
    let totalBytes = 0;
    while (offset !== null && pages.length < maxPages) {
      last = null;
      await service.getFileDiff("bench", repo, file, "modified", false, offset, pageBytes);
      const result = last as DiffResult | null;
      if (!result || result.error) throw new Error(result?.error ?? "no result");
      pages.push(result.diff);
      totalBytes = result.totalBytes;
      offset = result.nextOffset;
    }
    return { pages, totalBytes };
  }

  async function measure(label: string, file: string, pageBytes: number, maxPages?: number) {
    const rows: {
      ms: number;
      cpu: number;
      spawns: number;
      diffSpawns: number;
      gitMb: number;
      peakMb: number;
      pages: number;
    }[] = [];
    let reference: string | null = null;
    for (let i = 0; i < REPEATS; i++) {
      // Rewriting the file moves its stat, so each repeat starts cold.
      writeFileSync(path.join(repo, file), lines(file === "d10.txt" ? 5 << 20 : 10 << 20, "new"));
      (globalThis as { gc?: () => void }).gc?.();
      const mem = () => {
        const m = process.memoryUsage();
        return m.heapUsed + m.external + m.arrayBuffers;
      };
      const base = mem();
      let peak = base;
      const sampler = setInterval(() => {
        peak = Math.max(peak, mem());
      }, 1);
      spawnCount = 0;
      diffSpawnCount = 0;
      gitStdoutBytes = 0;
      const cpu0 = process.cpuUsage();
      const t0 = performance.now();
      let read: Awaited<ReturnType<typeof readAll>>;
      try {
        read = await readAll(file, pageBytes, maxPages);
      } finally {
        clearInterval(sampler);
      }
      const { pages, totalBytes } = read;
      const ms = performance.now() - t0;
      const cpu = process.cpuUsage(cpu0);
      peak = Math.max(peak, mem());
      const joined = pages.join("");
      if (maxPages === undefined) expect(Buffer.byteLength(joined)).toBe(totalBytes);
      if (reference !== null) expect(joined).toBe(reference);
      reference = joined;
      rows.push({
        ms,
        cpu: (cpu.user + cpu.system) / 1000,
        spawns: spawnCount,
        diffSpawns: diffSpawnCount,
        gitMb: gitStdoutBytes / 1024 / 1024,
        peakMb: (peak - base) / 1024 / 1024,
        pages: pages.length,
      });
    }
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    report.push(
      `${label.padEnd(34)} pages=${rows[0].pages} spawns=${rows[0].spawns} (diff ${rows[0].diffSpawns})` +
        ` gitStdout=${rows[0].gitMb.toFixed(1)}MB` +
        ` wall=${med(rows.map((r) => r.ms)).toFixed(0)}ms` +
        ` cpu=${med(rows.map((r) => r.cpu)).toFixed(0)}ms` +
        ` peak=${med(rows.map((r) => r.peakMb)).toFixed(1)}MB` +
        `  (wall runs: ${rows.map((r) => r.ms.toFixed(0)).join(", ")})`
    );
  }

  it("~10MB diff, 1MB pages", async () => {
    await measure("~10MB diff / 1MB pages", "d10.txt", GIT_FILE_DIFF_MAX_BYTES);
  }, 600_000);

  it("~20MB diff, 1MB pages", async () => {
    await measure("~20MB diff / 1MB pages", "d20.txt", GIT_FILE_DIFF_MAX_BYTES);
  }, 600_000);

  it("~10MB diff, 24KB default window (first 100 pages)", async () => {
    await measure("~10MB diff / 24KB pages (100)", "d10.txt", GIT_FILE_DIFF_DEFAULT_MAX_BYTES, 100);
  }, 600_000);
});
