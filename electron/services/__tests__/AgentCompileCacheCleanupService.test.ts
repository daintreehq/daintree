import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => path.join(os.tmpdir(), "unused-userdata")) },
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import {
  runAgentCompileCacheCleanup,
  requestAgentCompileCacheCleanup,
  type AgentCompileCacheCleanupPolicy,
} from "../AgentCompileCacheCleanupService.js";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Budgets large enough that only the TTL pass can evict. */
const TTL_ONLY: AgentCompileCacheCleanupPolicy = {
  ttlMs: 30 * DAY_MS,
  maxBytes: Number.MAX_SAFE_INTEGER,
  maxEntries: Number.MAX_SAFE_INTEGER,
};

let root: string;

/**
 * Seed one version directory with `fileCount` blobs of `fileSize` bytes, then
 * backdate its mtime. Backdating happens last because writing a blob bumps the
 * containing directory's mtime — the very signal the TTL pass reads.
 */
async function seedVersionDir(
  agentId: string,
  versionName: string,
  opts: { ageDays: number; fileCount?: number; fileSize?: number }
): Promise<string> {
  const dir = path.join(root, agentId, versionName);
  await fs.mkdir(dir, { recursive: true });
  const fileCount = opts.fileCount ?? 1;
  const fileSize = opts.fileSize ?? 16;
  for (let i = 0; i < fileCount; i += 1) {
    await fs.writeFile(path.join(dir, `blob-${i}`), Buffer.alloc(fileSize, 1));
  }
  const mtime = new Date(NOW - opts.ageDays * DAY_MS);
  await fs.utimes(dir, mtime, mtime);
  return dir;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-compile-cache-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("runAgentCompileCacheCleanup discovery", () => {
  it("reports nothing to do when the cache root does not exist", async () => {
    const result = await runAgentCompileCacheCleanup(
      NOW,
      path.join(root, "never-created"),
      TTL_ONLY
    );
    expect(result.candidates).toBe(0);
    expect(result.expiredRemoved).toBe(0);
    expect(result.budgetRemoved).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("ignores loose files sitting directly under the root and under an agent dir", async () => {
    await seedVersionDir("claude", "v26.0.0-arm64-abc-501", { ageDays: 1 });
    await fs.writeFile(path.join(root, "stray.txt"), "x");
    await fs.writeFile(path.join(root, "claude", "stray.txt"), "x");

    const result = await runAgentCompileCacheCleanup(NOW, root, TTL_ONLY);

    expect(result.candidates).toBe(1);
    expect(await exists(path.join(root, "stray.txt"))).toBe(true);
  });

  it("sweeps agent directories that are no longer in the injection allowlist", async () => {
    // A retired agent id must not strand its cache forever.
    await seedVersionDir("retired-agent", "v22.0.0-x64-abc-501", { ageDays: 90 });

    const result = await runAgentCompileCacheCleanup(NOW, root, TTL_ONLY);

    expect(result.expiredRemoved).toBe(1);
    expect(await exists(path.join(root, "retired-agent"))).toBe(false);
  });
});

describe("runAgentCompileCacheCleanup TTL pass", () => {
  it("removes an expired version directory and keeps a fresh sibling", async () => {
    const stale = await seedVersionDir("claude", "v22.0.0-arm64-old-501", { ageDays: 90 });
    const fresh = await seedVersionDir("claude", "v26.0.0-arm64-new-501", { ageDays: 1 });

    const result = await runAgentCompileCacheCleanup(NOW, root, TTL_ONLY);

    expect(result.expiredRemoved).toBe(1);
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it("evicts an expired directory without stat-ing any of the blobs inside it", async () => {
    await seedVersionDir("claude", "v22.0.0-arm64-old-501", { ageDays: 90, fileCount: 25 });

    const result = await runAgentCompileCacheCleanup(NOW, root, TTL_ONLY);

    // The whole point of the mtime signal: expired directories cost one stat,
    // not one per blob.
    expect(result.expiredRemoved).toBe(1);
    expect(result.entriesInspected).toBe(0);
  });

  it("spans agents, evicting stale directories under each independently", async () => {
    const staleClaude = await seedVersionDir("claude", "v20-old", { ageDays: 90 });
    const freshClaude = await seedVersionDir("claude", "v26-new", { ageDays: 2 });
    const staleGemini = await seedVersionDir("gemini", "v20-old", { ageDays: 90 });

    const result = await runAgentCompileCacheCleanup(NOW, root, TTL_ONLY);

    expect(result.candidates).toBe(3);
    expect(result.expiredRemoved).toBe(2);
    expect(await exists(staleClaude)).toBe(false);
    expect(await exists(staleGemini)).toBe(false);
    expect(await exists(freshClaude)).toBe(true);
  });

  it("removes an agent directory once its last version directory is gone", async () => {
    await seedVersionDir("gemini", "v20-old", { ageDays: 90 });

    await runAgentCompileCacheCleanup(NOW, root, TTL_ONLY);

    expect(await exists(path.join(root, "gemini"))).toBe(false);
  });

  it("leaves an agent directory that still holds a surviving version directory", async () => {
    await seedVersionDir("claude", "v20-old", { ageDays: 90 });
    await seedVersionDir("claude", "v26-new", { ageDays: 1 });

    await runAgentCompileCacheCleanup(NOW, root, TTL_ONLY);

    expect(await exists(path.join(root, "claude"))).toBe(true);
  });
});

describe("runAgentCompileCacheCleanup budget pass", () => {
  const byteBudget = (maxBytes: number): AgentCompileCacheCleanupPolicy => ({
    ttlMs: 30 * DAY_MS,
    maxBytes,
    maxEntries: Number.MAX_SAFE_INTEGER,
  });

  it("evicts a fresh directory that alone exceeds the byte budget", async () => {
    // The runtime currently in use is not exempt from the cap — this is the
    // half of #11699 that a TTL alone cannot bound.
    const fresh = await seedVersionDir("claude", "v26-new", {
      ageDays: 0,
      fileCount: 4,
      fileSize: 100,
    });

    const result = await runAgentCompileCacheCleanup(NOW, root, byteBudget(150));

    expect(result.expiredRemoved).toBe(0);
    expect(result.budgetRemoved).toBe(1);
    expect(await exists(fresh)).toBe(false);
  });

  it("retains the newest directories that fit and drops the rest", async () => {
    // Each directory is 200 bytes; a 500-byte budget fits exactly two.
    const newest = await seedVersionDir("claude", "v26", {
      ageDays: 1,
      fileCount: 2,
      fileSize: 100,
    });
    const middle = await seedVersionDir("claude", "v24", {
      ageDays: 2,
      fileCount: 2,
      fileSize: 100,
    });
    const oldest = await seedVersionDir("claude", "v22", {
      ageDays: 3,
      fileCount: 2,
      fileSize: 100,
    });

    const result = await runAgentCompileCacheCleanup(NOW, root, byteBudget(500));

    expect(result.budgetRemoved).toBe(1);
    expect(await exists(newest)).toBe(true);
    expect(await exists(middle)).toBe(true);
    expect(await exists(oldest)).toBe(false);
  });

  it("ranks by recency across agents, not within each agent", async () => {
    const newestOverall = await seedVersionDir("gemini", "v26", {
      ageDays: 1,
      fileCount: 2,
      fileSize: 100,
    });
    const olderOtherAgent = await seedVersionDir("claude", "v22", {
      ageDays: 5,
      fileCount: 2,
      fileSize: 100,
    });

    await runAgentCompileCacheCleanup(NOW, root, byteBudget(250));

    expect(await exists(newestOverall)).toBe(true);
    expect(await exists(olderOtherAgent)).toBe(false);
  });

  it("stops measuring once the budget is spent, leaving older blobs un-stat'd", async () => {
    // 3 blobs fit the budget; the two older directories hold 50 blobs each and
    // must be deleted without being measured.
    await seedVersionDir("claude", "v26", { ageDays: 1, fileCount: 3, fileSize: 10 });
    await seedVersionDir("claude", "v24", { ageDays: 2, fileCount: 50, fileSize: 10 });
    await seedVersionDir("claude", "v22", { ageDays: 3, fileCount: 50, fileSize: 10 });

    const result = await runAgentCompileCacheCleanup(NOW, root, byteBudget(30));

    expect(result.budgetRemoved).toBe(2);
    // 103 blobs exist. Bounded work means inspecting the 3 that fit plus at
    // most the overrun that proved the next directory did not.
    expect(result.entriesInspected).toBeLessThan(20);
  });

  it("counts files toward the entry budget independently of their size", async () => {
    const policy: AgentCompileCacheCleanupPolicy = {
      ttlMs: 30 * DAY_MS,
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxEntries: 3,
    };
    const newest = await seedVersionDir("claude", "v26", {
      ageDays: 1,
      fileCount: 2,
      fileSize: 1,
    });
    const older = await seedVersionDir("claude", "v22", {
      ageDays: 2,
      fileCount: 40,
      fileSize: 1,
    });

    const result = await runAgentCompileCacheCleanup(NOW, root, policy);

    expect(result.budgetRemoved).toBe(1);
    expect(await exists(newest)).toBe(true);
    expect(await exists(older)).toBe(false);
  });

  it("evicts a version directory holding an unexpected nested subdirectory", async () => {
    // The flat layout is what makes the directory measurable; anything nested
    // is unmeasurable and must not escape the budget by being skipped.
    const dir = await seedVersionDir("claude", "v26", { ageDays: 1, fileCount: 1, fileSize: 1 });
    await fs.mkdir(path.join(dir, "unexpected"));

    const result = await runAgentCompileCacheCleanup(
      NOW,
      root,
      byteBudget(Number.MAX_SAFE_INTEGER)
    );

    expect(result.budgetRemoved).toBe(1);
    expect(await exists(dir)).toBe(false);
  });

  it("leaves everything in place when the whole cache fits", async () => {
    const a = await seedVersionDir("claude", "v26", { ageDays: 1, fileCount: 2, fileSize: 10 });
    const b = await seedVersionDir("claude", "v22", { ageDays: 2, fileCount: 2, fileSize: 10 });

    const result = await runAgentCompileCacheCleanup(NOW, root, byteBudget(10_000));

    expect(result.expiredRemoved).toBe(0);
    expect(result.budgetRemoved).toBe(0);
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(true);
  });
});

describe("runAgentCompileCacheCleanup failure isolation", () => {
  it("counts a failed removal and still evicts the other candidates", async () => {
    const doomed = await seedVersionDir("claude", "v20-locked", { ageDays: 90 });
    const alsoDoomed = await seedVersionDir("claude", "v21-old", { ageDays: 90 });

    const realRm = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === doomed) {
        // Stand in for a Windows lock on a blob a live agent still holds open.
        const err: NodeJS.ErrnoException = new Error("EBUSY: resource busy or locked");
        err.code = "EBUSY";
        throw err;
      }
      return realRm(target as string, options);
    });

    const result = await runAgentCompileCacheCleanup(NOW, root, TTL_ONLY);

    expect(result.failed).toBe(1);
    expect(result.expiredRemoved).toBe(1);
    expect(await exists(doomed)).toBe(true);
    expect(await exists(alsoDoomed)).toBe(false);
  });

  it("is idempotent — a second sweep over the reclaimed tree does nothing", async () => {
    await seedVersionDir("claude", "v20-old", { ageDays: 90 });
    await seedVersionDir("claude", "v26-new", { ageDays: 1 });

    const first = await runAgentCompileCacheCleanup(NOW, root, TTL_ONLY);
    const second = await runAgentCompileCacheCleanup(NOW, root, TTL_ONLY);

    expect(first.expiredRemoved).toBe(1);
    expect(second.expiredRemoved).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.candidates).toBe(1);
  });
});

describe("requestAgentCompileCacheCleanup", () => {
  it("coalesces overlapping callers onto one sweep, then allows a later one", async () => {
    // Startup, the periodic tick, and the disk-critical edge can all fire at
    // once; two concurrent sweeps would race to delete the same directories
    // and each count the other's work as a failure.
    const a = requestAgentCompileCacheCleanup();
    const b = requestAgentCompileCacheCleanup();
    expect(a).toBe(b);

    await a;

    const c = requestAgentCompileCacheCleanup();
    expect(c).not.toBe(a);
    await c;
  });
});
