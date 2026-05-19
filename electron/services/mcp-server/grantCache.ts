import type {
  McpGrantLifecyclePayload,
  McpGrantRecordType,
  McpGrantRevokedReason,
} from "../../../shared/types/ipc/mcpServer.js";
import {
  MCP_DENIAL_SILENCE_THRESHOLD,
  MCP_GRANT_SWEEP_INTERVAL_MS,
  MCP_GRANT_TTL_MS,
} from "./shared.js";

/**
 * A single per-`(sessionId, toolId)` grant. The `issuedAt` field doubles as
 * an opaque token for the race guard in {@link GrantCache.refresh}: a
 * `refresh` call carrying a stale `issuedAt` (because the entry was revoked
 * and re-issued between `check` and dispatch completion) becomes a no-op,
 * so a successful dispatch through the original grant can never resurrect
 * the revoked one. Mirrors the in-flight-fetch lesson from #2243.
 */
export interface GrantEntry {
  issuedAt: number;
  expiresAt: number;
  ttlMs: number;
}

export type GrantCheckResult =
  | { granted: true; issuedAt: number; expiresAt: number }
  | { granted: false };

export interface GrantLifecycleEmitter {
  (sessionId: string, payload: McpGrantLifecyclePayload): void;
}

interface GrantCacheOptions {
  ttlMs?: number;
  sweepIntervalMs?: number;
  denialSilenceThreshold?: number;
  /**
   * Hook invoked synchronously for every grant lifecycle transition
   * (`issued`, `expired`, `revoked`). Implementation is responsible for
   * writing an audit record and broadcasting to the pinned renderer.
   * Errors are caught so a broken emitter cannot wedge cache mutations.
   */
  emit?: GrantLifecycleEmitter;
  /**
   * Custom clock for tests. Defaults to `Date.now`.
   */
  now?: () => number;
}

function key(sessionId: string, toolId: string): string {
  return `${sessionId}:${toolId}`;
}

/**
 * Per-`(sessionId, toolId)` time-bounded grants replacing sticky session
 * tier elevation (#8442). Storage is a single `Map` keyed by the composite
 * `${sessionId}:${toolId}`. Tool IDs never contain `:` (they are dotted
 * `BuiltInActionId` strings) and session IDs are UUIDs, so the flat key
 * is collision-free.
 *
 * Expiry is lazy on read — `check()` evicts and emits `grant.expired`
 * when `now > expiresAt`. A periodic sweep is a memory-hygiene pass for
 * grants that age out without anyone reading them; lazy eviction stays
 * the source of truth so tests can drive the cache deterministically by
 * faking time and calling `check()` rather than waiting for the sweep.
 *
 * Denial counters live alongside the grants because they share the same
 * `(sessionId, toolId)` keyspace and are cleared at the same lifecycle
 * points (session drain, idle expiry, grant issuance for the pair).
 */
export class GrantCache {
  private readonly grants = new Map<string, GrantEntry>();
  private readonly denialCounts = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly denialSilenceThreshold: number;
  private readonly emit?: GrantLifecycleEmitter;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: GrantCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? MCP_GRANT_TTL_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? MCP_GRANT_SWEEP_INTERVAL_MS;
    this.denialSilenceThreshold = options.denialSilenceThreshold ?? MCP_DENIAL_SILENCE_THRESHOLD;
    this.emit = options.emit;
    this.now = options.now ?? Date.now;

    if (this.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  /**
   * Mint a fresh grant for the pair. Clears any accumulated denial counter
   * so the renderer banner re-arms after a deliberate user approval. If a
   * grant already exists it is replaced (with a fresh `issuedAt`); the
   * caller has effectively re-approved, so the race guard's identity check
   * intentionally fires against the new token.
   */
  issueGrant(sessionId: string, toolId: string): GrantEntry {
    if (this.disposed) {
      throw new Error("GrantCache has been disposed");
    }
    const issuedAt = this.now();
    const entry: GrantEntry = {
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      ttlMs: this.ttlMs,
    };
    this.grants.set(key(sessionId, toolId), entry);
    this.denialCounts.delete(key(sessionId, toolId));
    this.emitSafely(sessionId, {
      type: "grant.issued",
      sessionId,
      toolId,
      ttlMs: entry.ttlMs,
      expiresAt: entry.expiresAt,
    });
    return entry;
  }

  /**
   * Lookup the grant for the pair. Lazily evicts and emits `grant.expired`
   * if the entry has aged out. The returned `issuedAt` is the token that
   * `refresh()` must echo back to update the entry safely.
   */
  check(sessionId: string, toolId: string): GrantCheckResult {
    const k = key(sessionId, toolId);
    const entry = this.grants.get(k);
    if (!entry) return { granted: false };
    if (this.now() > entry.expiresAt) {
      this.grants.delete(k);
      this.emitSafely(sessionId, {
        type: "grant.expired",
        sessionId,
        toolId,
        ttlMs: entry.ttlMs,
      });
      return { granted: false };
    }
    return { granted: true, issuedAt: entry.issuedAt, expiresAt: entry.expiresAt };
  }

  /**
   * Extend the grant's expiry window. The `issuedAt` argument is the token
   * the caller obtained from `check()` — if a `revokeSession` (or a manual
   * re-issue) ran between then and this call, the stored `issuedAt` will
   * have moved on and this refresh is a silent no-op. That's the #2243
   * resurrection-race fix: a winning revoke must not be undone by a
   * dispatch that started before it.
   */
  refresh(sessionId: string, toolId: string, issuedAt: number): boolean {
    const k = key(sessionId, toolId);
    const entry = this.grants.get(k);
    if (!entry) return false;
    if (entry.issuedAt !== issuedAt) return false;
    entry.expiresAt = this.now() + entry.ttlMs;
    return true;
  }

  /**
   * Drop every grant held by the session. Emits `grant.revoked` per
   * entry so the audit log and renderer broadcast both see them. The
   * `reason` field lets callers distinguish a user-initiated revoke from
   * an automatic session-end cleanup.
   */
  revokeSession(sessionId: string, reason: McpGrantRevokedReason = "user"): number {
    let revoked = 0;
    const prefix = `${sessionId}:`;
    for (const k of [...this.grants.keys()]) {
      if (!k.startsWith(prefix)) continue;
      const entry = this.grants.get(k);
      this.grants.delete(k);
      revoked += 1;
      // toolId is the suffix after the first `:` — sessionIds are UUIDs
      // with no `:`, so substring(prefix.length) gives the tool id verbatim.
      const toolId = k.substring(prefix.length);
      this.emitSafely(sessionId, {
        type: "grant.revoked",
        sessionId,
        toolId,
        ttlMs: entry?.ttlMs ?? this.ttlMs,
        revokedReason: reason,
      });
    }
    return revoked;
  }

  /**
   * Drop every grant and denial counter for the session without emitting
   * `grant.revoked` events. Used by the idle reaper and full-store drain
   * — those pathways tear down sessions wholesale and don't need audit
   * noise for each per-tool grant. The audit log retains the originating
   * `grant.issued` record so the absence of a closing `grant.revoked`
   * does not look like a leak; the corresponding session-cleanup signal
   * is the {@link revokeSession} call sites pass `session-idle` or
   * `session-ended` when they want the trail.
   *
   * In practice the SessionStore idle reaper calls `revokeSession` with
   * `session-idle` for full traceability; `clearSessionState` exists as
   * a quiet variant for the wholesale `drain()` path during shutdown
   * where every session is going away simultaneously.
   */
  clearSessionState(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const k of [...this.grants.keys()]) {
      if (k.startsWith(prefix)) this.grants.delete(k);
    }
    for (const k of [...this.denialCounts.keys()]) {
      if (k.startsWith(prefix)) this.denialCounts.delete(k);
    }
  }

  /**
   * Increment the consecutive-denial counter for the pair and return the
   * new count. The session-server uses the return value to decide whether
   * to fire the renderer banner this round.
   */
  incrementDenial(sessionId: string, toolId: string): number {
    const k = key(sessionId, toolId);
    const next = (this.denialCounts.get(k) ?? 0) + 1;
    this.denialCounts.set(k, next);
    return next;
  }

  getDenialCount(sessionId: string, toolId: string): number {
    return this.denialCounts.get(key(sessionId, toolId)) ?? 0;
  }

  /**
   * Drop only the consecutive-denial suppression counters for a session,
   * leaving any active per-tool grants intact. Used by the tier-decay path
   * (#8462): a decayed session must re-show the tier-mismatch banner on its
   * next out-of-baseline call rather than have it silently suppressed by
   * denials accrued before the elevation. Grants are an orthogonal per-tool
   * approval (#8442) with their own TTL and must survive the decay, so this
   * is deliberately narrower than {@link clearSessionState}.
   */
  clearDenialCounts(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const k of [...this.denialCounts.keys()]) {
      if (k.startsWith(prefix)) this.denialCounts.delete(k);
    }
  }

  /**
   * True when the current denial for the pair should suppress the renderer
   * banner. The audit record is still written; this controls only the UI
   * surface. The check uses the post-increment count: with threshold = 2
   * the 1st and 2nd consecutive denials fire the banner, the 3rd and
   * beyond are suppressed. A successful `issueGrant` zeroes the counter,
   * so re-arming requires deliberate user approval rather than time
   * passing.
   */
  shouldSuppressBanner(sessionId: string, toolId: string): boolean {
    return this.getDenialCount(sessionId, toolId) > this.denialSilenceThreshold;
  }

  /**
   * Test/inspection hook. Returns a shallow snapshot of live grants —
   * iteration order is insertion order so callers can rely on it for
   * deterministic assertions.
   */
  getActiveGrants(sessionId?: string): Array<{ sessionId: string; toolId: string } & GrantEntry> {
    const out: Array<{ sessionId: string; toolId: string } & GrantEntry> = [];
    for (const [k, entry] of this.grants) {
      const colon = k.indexOf(":");
      if (colon < 0) continue;
      const sid = k.substring(0, colon);
      if (sessionId !== undefined && sid !== sessionId) continue;
      out.push({ sessionId: sid, toolId: k.substring(colon + 1), ...entry });
    }
    return out;
  }

  /**
   * Periodic sweep — removes expired grants without anyone having to read
   * them. Emits `grant.expired` for each so audit and broadcast match the
   * lazy-eviction path.
   */
  sweep(): number {
    if (this.disposed) return 0;
    let evicted = 0;
    const now = this.now();
    for (const [k, entry] of [...this.grants]) {
      if (now <= entry.expiresAt) continue;
      this.grants.delete(k);
      evicted += 1;
      const colon = k.indexOf(":");
      if (colon < 0) continue;
      const sessionId = k.substring(0, colon);
      const toolId = k.substring(colon + 1);
      this.emitSafely(sessionId, {
        type: "grant.expired",
        sessionId,
        toolId,
        ttlMs: entry.ttlMs,
      });
    }
    return evicted;
  }

  /**
   * Drop every grant and denial counter without stopping the sweep timer.
   * Used by {@link import("./sessionStore.js").SessionStore.drain} on
   * HTTP-server stop/restart, where the `SessionStore` instance lives on
   * and will accept fresh sessions after the next `start()`. The sweep
   * timer is `.unref()`'d so it cannot keep the process alive on its own.
   */
  clearAll(): void {
    if (this.disposed) return;
    this.grants.clear();
    this.denialCounts.clear();
  }

  /**
   * Stop the sweep interval and drop all state. Mandatory before
   * discarding the cache permanently (test teardown, app shutdown) —
   * otherwise the libuv handle keeps the test runner alive even with
   * `.unref()` because `unref` is best-effort. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.grants.clear();
    this.denialCounts.clear();
  }

  private emitSafely(sessionId: string, payload: McpGrantLifecyclePayload): void {
    if (!this.emit) return;
    try {
      this.emit(sessionId, payload);
    } catch (err) {
      console.error("[MCP] Grant lifecycle emitter threw:", err);
    }
  }

  // Test access — kept narrow on purpose.
  /** @internal */
  _peek(sessionId: string, toolId: string): GrantEntry | undefined {
    return this.grants.get(key(sessionId, toolId));
  }
}

export type { McpGrantRecordType, McpGrantRevokedReason };
