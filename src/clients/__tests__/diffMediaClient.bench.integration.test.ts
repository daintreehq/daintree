// Benchmark for the image-diff viewer's media loads while navigating between
// files already viewed. Drives the renderer client against the real
// diffMedia handler over a real git repo with six 2–7.5 MB images, each
// modified in the working tree. Not part of `npm test`; run with
//   npx vitest run --config vitest.integration.config.ts src/clients/__tests__/diffMediaClient.bench.integration.test.ts
// Results are appended as `[bench] …` lines to $DIFF_MEDIA_BENCH_OUT (default:
// a file in the OS temp dir).
import { describe, it, afterAll, beforeAll, expect, vi } from "vitest";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { performance } from "perf_hooks";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
    removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
  },
}));

import { diffMediaClient, resetDiffMediaCacheForTests } from "../diffMediaClient";
import type {
  DiffMediaFileVersionsResponse,
  DiffMediaReadFileVersionsPayload,
} from "@shared/types";

// Main-process modules load through computed specifiers so the renderer
// project's typecheck doesn't pull the electron graph in under its own rules.
const ELECTRON_IPC = "../../../electron/ipc";
let _resetRateLimitQueuesForTest: () => void;

const OUT = process.env.DIFF_MEDIA_BENCH_OUT ?? join(tmpdir(), "daintree-diff-media-bench.log");
const SIZES_MB = [2, 3, 4, 5, 6, 7.5];
const REPEATS = Number(process.env.DIFF_MEDIA_BENCH_REPEATS ?? 3);

function report(line: string): void {
  appendFileSync(OUT, line + "\n");
  process.stderr.write(line + "\n");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let repo = "";
const files = SIZES_MB.map((_, i) => `assets/img${i}.png`);

interface Stats {
  ipcCalls: number;
  bytes: number;
  handlerMs: number;
  cloneMs: number;
  rejections: number;
}

let stats: Stats;

function stubWindow(channel: string): void {
  const handler = ipcHandlers.get(channel) as (
    event: unknown,
    payload: DiffMediaReadFileVersionsPayload
  ) => Promise<DiffMediaFileVersionsResponse>;
  (globalThis as unknown as { window: unknown }).window = {
    electron: {
      diffMedia: {
        readFileVersions: async (payload: DiffMediaReadFileVersionsPayload) => {
          stats.ipcCalls++;
          const t0 = performance.now();
          let result: DiffMediaFileVersionsResponse;
          try {
            result = await handler({ sender: {} }, structuredClone(payload));
          } catch (error) {
            stats.handlerMs += performance.now() - t0;
            if ((error as { code?: string }).code === "RATE_LIMITED") stats.rejections++;
            throw error;
          }
          stats.handlerMs += performance.now() - t0;
          if (process.env.DIFF_MEDIA_BENCH_TRACE) {
            process.stderr.write(
              `[trace] ${payload.filePath} known=${payload.known ? "y" : "n"} ms=${(performance.now() - t0).toFixed(1)}\n`
            );
          }
          for (const side of [result.head, result.working]) {
            if (side.ok && "dataUrl" in side) stats.bytes += side.dataUrl.length;
          }
          // Stand-in for the IPC structured-clone hop.
          const c0 = performance.now();
          const cloned = structuredClone(result);
          stats.cloneMs += performance.now() - c0;
          return cloned;
        },
      },
    },
  };
}

/** Six first visits, then A→B→A→B… and a second sweep over all six. */
function navigationSequence(): string[] {
  const seq = [...files];
  for (let i = 0; i < 12; i++) seq.push(files[i % 2]!);
  seq.push(...files);
  return seq;
}

function fmt(phase: string, s: Stats, navigations: number, failed: number): string {
  return (
    `${phase}: navigations=${navigations} ipcCalls=${s.ipcCalls} ` +
    `bytesMB=${(s.bytes / 1e6).toFixed(1)} handlerMs=${s.handlerMs.toFixed(0)} ` +
    `cloneMs=${s.cloneMs.toFixed(0)} rateLimited=${s.rejections} failedNavigations=${failed}`
  );
}

async function run(label: string, paced: boolean): Promise<void> {
  _resetRateLimitQueuesForTest();
  // Optional so the same file replays against a pre-cache client.
  resetDiffMediaCacheForTests?.();
  stats = { ipcCalls: 0, bytes: 0, handlerMs: 0, cloneMs: 0, rejections: 0 };
  const sequence = navigationSequence();
  let firstVisit: Stats | null = null;
  let failed = 0;
  let firstVisitFailed = 0;
  for (const [i, filePath] of sequence.entries()) {
    if (i === files.length) {
      firstVisit = { ...stats };
      firstVisitFailed = failed;
    }
    // "paced" models ≥1 s per navigation — the limiter window never fills.
    if (paced) _resetRateLimitQueuesForTest();
    try {
      const result = await diffMediaClient.readFileVersions({ cwd: repo, filePath });
      if (!result.head.ok || !result.working.ok) failed++;
    } catch {
      failed++;
    }
  }
  const first = firstVisit!;
  const revisit: Stats = {
    ipcCalls: stats.ipcCalls - first.ipcCalls,
    bytes: stats.bytes - first.bytes,
    handlerMs: stats.handlerMs - first.handlerMs,
    cloneMs: stats.cloneMs - first.cloneMs,
    rejections: stats.rejections - first.rejections,
  };
  report(
    `[bench] ${label} | ${fmt("total", stats, sequence.length, failed)} | ` +
      `${fmt("revisits", revisit, sequence.length - files.length, failed - firstVisitFailed)}`
  );
}

beforeAll(async () => {
  const { markIpcSecurityReady } = await import(/* @vite-ignore */ `${ELECTRON_IPC}/ipcGuard.js`);
  const { registerDiffMediaHandlers } = await import(
    /* @vite-ignore */ `${ELECTRON_IPC}/handlers/diffMedia.js`
  );
  const { DIFF_MEDIA_METHOD_CHANNELS } = await import(
    /* @vite-ignore */ `${ELECTRON_IPC}/handlers/diffMedia.preload.js`
  );
  ({ _resetRateLimitQueuesForTest } = await import(/* @vite-ignore */ `${ELECTRON_IPC}/utils.js`));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "daintree-diffmediabench-")));
  git(repo, "init", "-q", "-b", "develop");
  git(repo, "config", "user.email", "bench@example.com");
  git(repo, "config", "user.name", "Bench");
  git(repo, "config", "commit.gpgsign", "false");
  execFileSync("mkdir", ["-p", join(repo, "assets")]);
  SIZES_MB.forEach((mb, i) => writeFileSync(join(repo, files[i]!), randomBytes(mb * 1024 * 1024)));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "images");
  SIZES_MB.forEach((mb, i) => writeFileSync(join(repo, files[i]!), randomBytes(mb * 1024 * 1024)));
  // Let the edits age past the handler's racy-timestamp window, as files
  // being reviewed normally have.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  markIpcSecurityReady();
  registerDiffMediaHandlers();
  stubWindow(DIFF_MEDIA_METHOD_CHANNELS.readFileVersions);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("diffMedia navigation bench", () => {
  it("paced navigation (limiter never saturates)", async () => {
    for (let r = 0; r < REPEATS; r++) await run(`paced#${r}`, true);
  });

  it("rapid navigation (real limiter)", async () => {
    for (let r = 0; r < REPEATS; r++) await run(`rapid#${r}`, false);
  });

  it("picks up a working-tree edit on revisit", async () => {
    _resetRateLimitQueuesForTest();
    const target = files[0]!;
    const before = await diffMediaClient.readFileVersions({ cwd: repo, filePath: target });
    const replacement = randomBytes(1024 * 1024);
    writeFileSync(join(repo, target), replacement);
    const after = await diffMediaClient.readFileVersions({ cwd: repo, filePath: target });
    expect(after.working.ok && after.working.byteSize).toBe(replacement.byteLength);
    expect(after.working).not.toEqual(before.working);
    expect(after.head).toEqual(before.head);

    git(repo, "add", target);
    git(repo, "commit", "-q", "-m", "edit");
    const committed = await diffMediaClient.readFileVersions({ cwd: repo, filePath: target });
    expect(committed.head.ok && committed.head.byteSize).toBe(replacement.byteLength);
    expect(committed.working).toEqual(after.working);
  });
});
