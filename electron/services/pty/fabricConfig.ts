/**
 * PTY fabric configuration — pure policy helpers for the sharded pty-host.
 *
 * The fabric dissolves the single app-global `daintree-pty-host` into a pool
 * of per-project host shards, each with its own event loop, V8 heap, and
 * resource governor. Everything here is deterministic and side-effect free so
 * placement/sizing policy is unit-testable in isolation from PtyClient.
 *
 * Kill switch: the fabric is OFF unless `DAINTREE_PTY_FABRIC=1` (or "true").
 * Off means exactly one shard ("main") with the exact legacy behavior —
 * fixed 512 MB heap, one process, one governor.
 */

import { createHash } from "crypto";

/** Shard key for the default shard — also the only shard when the fabric is off. */
export const DEFAULT_SHARD_KEY = "main";

/** UtilityProcess serviceName of the default shard (unchanged from the singleton host). */
export const DEFAULT_PTY_HOST_SERVICE_NAME = "daintree-pty-host";

/**
 * How long a project shard may sit fully idle (no live terminals, no pending
 * spawns, no window showing its project) before its process is reaped. Long
 * enough to survive a quick close-and-reopen without a refork; short enough
 * that cycling across many projects doesn't accumulate idle host processes —
 * the structural fix for the terminal-tier FD/RSS leak on view eviction.
 */
export const PTY_SHARD_IDLE_LINGER_MS = 45_000;

/** Fabric flag: opt-in via DAINTREE_PTY_FABRIC=1. Anything else is the legacy singleton. */
export function isPtyFabricEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DAINTREE_PTY_FABRIC;
  return raw === "1" || raw === "true";
}

/**
 * Cap on concurrent project shards (the default shard is not counted).
 * Matches the core count minus headroom for the main + renderer processes so
 * shard event loops don't oversubscribe the machine; projects beyond the cap
 * co-locate on the default shard (graceful degradation toward the singleton).
 */
export function maxProjectShards(cpuCount: number): number {
  if (!Number.isFinite(cpuCount) || cpuCount <= 0) return 2;
  return Math.min(8, Math.max(1, Math.floor(cpuCount) - 2));
}

/**
 * Per-shard V8 heap budget, scaled from machine RAM. The legacy singleton
 * pinned 512 MB on every machine; with the fabric each shard gets
 * `totalMem / 32` clamped to [512, 2048] MB — an 8 GB laptop keeps the legacy
 * 512, a 64 GB workstation gets 2 GB per shard. These are ceilings, not
 * allocations: V8 only commits what the shard actually uses. The same value
 * is forwarded to the shard's ResourceGovernor via DAINTREE_PTY_HEAP_BUDGET_MB
 * so governance thresholds track the real cap instead of a hardcoded 512.
 */
export function shardHeapBudgetMb(totalMemBytes: number): number {
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return 512;
  const totalMemMb = totalMemBytes / (1024 * 1024);
  return Math.min(2048, Math.max(512, Math.floor(totalMemMb / 32)));
}

/**
 * UtilityProcess serviceName for a shard. The default shard keeps the legacy
 * name (log filters, crash attribution, and tests key off it); project shards
 * get `daintree-pty-host:<sanitized-key>-<hash>` mirroring the per-project
 * workspace-host naming so Activity Monitor / crash reports attribute load to
 * a project. The hash suffix keeps names unique when sanitization collides.
 */
export function shardServiceName(shardKey: string): string {
  if (shardKey === DEFAULT_SHARD_KEY) return DEFAULT_PTY_HOST_SERVICE_NAME;
  const sanitized = shardKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || "project";
  const hash = createHash("sha1").update(shardKey).digest("hex").slice(0, 8);
  return `${DEFAULT_PTY_HOST_SERVICE_NAME}:${sanitized}-${hash}`;
}
