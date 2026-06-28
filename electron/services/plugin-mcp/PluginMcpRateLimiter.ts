/**
 * Per-server token-bucket rate limiter for plugin-MCP `tools/call` dispatch.
 *
 * Each `(pluginId, serverId)` pair gets an independent bucket so one plugin's
 * tool spam can't throttle another's. The model's parallel tool calls arrive in
 * bursts, so the bucket allows a burst up to `capacity` and refills steadily at
 * `refillPerSec` — 20-token burst, 1 token/sec sustained (60 calls/min) by
 * default, generous for interactive assistant use while bounding a runaway loop.
 *
 * Refill is lazy wall-clock arithmetic computed at `check()` time — no
 * `setInterval`, no async, no cleanup. Buckets are dropped on plugin uninstall
 * and server restart so the map can't grow unbounded.
 *
 * The pair is keyed through a nested map rather than a `${pluginId}:${serverId}`
 * string so an id containing the separator can't collide with another pair
 * (the same JSON-vs-join hazard `PluginMcpConsentStore` guards against).
 */

const DEFAULT_CAPACITY = 20;
const DEFAULT_REFILL_PER_SEC = 1;

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

export type PluginMcpRateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

export class PluginMcpRateLimiter {
  private readonly buckets = new Map<string, Map<string, TokenBucket>>();

  constructor(
    private readonly capacity: number = DEFAULT_CAPACITY,
    private readonly refillPerSec: number = DEFAULT_REFILL_PER_SEC,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Consume one token for a `(pluginId, serverId)` pair. Returns `allowed: true`
   * when a token was available (and consumed), otherwise `allowed: false` with
   * the milliseconds until the next token refills. A brand-new bucket starts
   * full, so the first call after a cold start always passes.
   */
  check(pluginId: string, serverId: string): PluginMcpRateLimitResult {
    const now = this.now();
    const bucket = this.resolveBucket(pluginId, serverId, now);

    const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsedMs * this.refillPerSec) / 1000);
    bucket.lastRefillMs = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    const deficit = 1 - bucket.tokens;
    return { allowed: false, retryAfterMs: Math.ceil((deficit / this.refillPerSec) * 1000) };
  }

  /** Drop every bucket for a plugin — call on uninstall so a reinstall starts fresh. */
  dropPlugin(pluginId: string): void {
    this.buckets.delete(pluginId);
  }

  /** Drop a single server's bucket — call on restart so a respawn isn't throttled by stale debt. */
  dropServer(pluginId: string, serverId: string): void {
    const servers = this.buckets.get(pluginId);
    if (!servers) return;
    servers.delete(serverId);
    if (servers.size === 0) this.buckets.delete(pluginId);
  }

  private resolveBucket(pluginId: string, serverId: string, now: number): TokenBucket {
    let servers = this.buckets.get(pluginId);
    if (!servers) {
      servers = new Map();
      this.buckets.set(pluginId, servers);
    }
    let bucket = servers.get(serverId);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: now };
      servers.set(serverId, bucket);
    }
    return bucket;
  }

  _resetForTest(): void {
    this.buckets.clear();
  }
}
