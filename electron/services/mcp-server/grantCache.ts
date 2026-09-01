import { randomUUID } from "node:crypto";
import type {
  McpGrantActorType,
  McpGrantLifecyclePayload,
  McpGrantRecordType,
  McpGrantRevokedReason,
} from "../../../shared/types/ipc/mcpServer.js";
import { isGenericNativeGrantEligible } from "../../../shared/config/nativeGrantUsePolicies.js";
import {
  MCP_DENIAL_SILENCE_THRESHOLD,
  MCP_GRANT_MAX_LIFETIME_MS,
  MCP_GRANT_SWEEP_INTERVAL_MS,
  MCP_GRANT_TTL_MS,
  MCP_NATIVE_GRANT_DEFAULT_MAX_USES,
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
  { granted: true; issuedAt: number; expiresAt: number } | { granted: false };

/**
 * A native session-scoped automation grant (#10648). Unlike a {@link GrantEntry}
 * — which authorizes a single `(sessionId, toolId)` pair with no use ceiling —
 * a native grant is approved once for a bounded *set* of tools and a bounded
 * number of uses, then exhausts. It is keyed by its own stable `id` (a UUID)
 * rather than `${sessionId}:${toolId}` because it spans multiple tools.
 *
 * `remainingUses` is the only mutable field after issuance and is decremented
 * atomically inside {@link GrantCache.checkNativeGrant} — the synchronous
 * decrement-before-return is what makes the use ceiling race-free against two
 * concurrent in-flight tool calls (JS is single-threaded; no `await` sits
 * between the read and the write). `issuedAt` doubles as the hard wall-clock
 * ceiling anchor, exactly like {@link GrantEntry}.
 */
export interface NativeGrantEntry {
  id: string;
  sessionId: string;
  actorId: string;
  actorType: McpGrantActorType;
  allowedTools: ReadonlySet<string>;
  maxUses: number;
  remainingUses: number;
  issuedAt: number;
  expiresAt: number;
  ttlMs: number;
}

export type NativeGrantCheckResult = { granted: true; grantId: string } | { granted: false };

/** Parameters for minting a native grant via {@link GrantCache.issueNativeGrant}. */
export interface IssueNativeGrantParams {
  sessionId: string;
  actorId: string;
  actorType: McpGrantActorType;
  allowedTools: readonly string[];
  /** Use ceiling. Defaults to {@link MCP_NATIVE_GRANT_DEFAULT_MAX_USES}. */
  maxUses?: number;
  /** Sliding-TTL window. Defaults to the cache's per-tool grant TTL. */
  ttlMs?: number;
}

export interface GrantLifecycleEmitter {
  (sessionId: string, payload: McpGrantLifecyclePayload): void;
}

interface GrantCacheOptions {
  ttlMs?: number;
  /**
   * Hard wall-clock ceiling on a grant's total lifetime, measured from its
   * immutable `issuedAt`. Once `now > issuedAt + maxLifetimeMs` the grant is
   * forcibly revoked on the next `check`/`refresh`/`sweep` regardless of how
   * recently the sliding TTL was refreshed. Defaults to
   * {@link MCP_GRANT_MAX_LIFETIME_MS}.
   */
  maxLifetimeMs?: number;
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
  // Native session-scoped automation grants (#10648), keyed by their own UUID
  // (not `${sessionId}:${toolId}`) because each spans a set of tools. Held in
  // the same cache as the per-tool grants so sweep/revokeSession/clearAll/
  // dispose cover both stores from one place and can never drift.
  private readonly nativeGrants = new Map<string, NativeGrantEntry>();
  private readonly ttlMs: number;
  private readonly maxLifetimeMs: number;
  private readonly sweepIntervalMs: number;
  private readonly denialSilenceThreshold: number;
  private readonly emit?: GrantLifecycleEmitter;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: GrantCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? MCP_GRANT_TTL_MS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? MCP_GRANT_MAX_LIFETIME_MS;
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
    const now = this.now();
    // The hard ceiling is a stricter constraint than the sliding TTL: a grant
    // refreshed moments ago can still have a future `expiresAt` while having
    // crossed `issuedAt + maxLifetimeMs`. `grant-ceiling` is reserved for that
    // case — a grant whose sliding TTL was still valid (recently refreshed)
    // when the hard cap cut it off. A grant that has already lapsed its TTL is
    // a passive `grant.expired` timeout regardless of whether the ceiling has
    // also passed, so it keeps the truthful "idled out" audit signal.
    const pastCeiling = now > entry.issuedAt + this.maxLifetimeMs;
    const pastTtl = now > entry.expiresAt;
    if (pastCeiling || pastTtl) {
      this.grants.delete(k);
      this.emitSafely(
        sessionId,
        pastCeiling && !pastTtl
          ? {
              type: "grant.revoked",
              sessionId,
              toolId,
              ttlMs: entry.ttlMs,
              revokedReason: "grant-ceiling",
            }
          : {
              type: "grant.expired",
              sessionId,
              toolId,
              ttlMs: entry.ttlMs,
            }
      );
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
    const now = this.now();
    // Hard wall-clock ceiling: once the grant's total lifetime is exhausted
    // no amount of recent use can extend it. Revoke and force re-approval
    // rather than sliding the window forward again (#9161).
    if (now > entry.issuedAt + this.maxLifetimeMs) {
      this.grants.delete(k);
      this.emitSafely(sessionId, {
        type: "grant.revoked",
        sessionId,
        toolId,
        ttlMs: entry.ttlMs,
        revokedReason: "grant-ceiling",
      });
      return false;
    }
    entry.expiresAt = now + entry.ttlMs;
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
    // Native grants are UUID-keyed, so they can't be prefix-matched — scan by
    // the `sessionId` field instead. This is the fail-closed teardown path:
    // when the pinned session ends, every native automation grant it held is
    // dropped (the `revokeSession(sessionId, "session-ended")` calls in
    // httpLifecycle on SSE/HTTP close cover native grants through here).
    for (const entry of [...this.nativeGrants.values()]) {
      if (entry.sessionId !== sessionId) continue;
      this.nativeGrants.delete(entry.id);
      revoked += 1;
      this.emitSafely(sessionId, this.nativeRevokedPayload(entry, reason));
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
    for (const entry of [...this.nativeGrants.values()]) {
      if (entry.sessionId === sessionId) this.nativeGrants.delete(entry.id);
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
   * Like {@link getActiveGrants} but returns only grants that are live by every
   * condition {@link check} enforces — not past the sliding TTL and not past
   * the hard wall-clock ceiling. Unlike `check`, it never evicts and never
   * emits a lifecycle event, so a read-only caller (discovery filtering, status
   * snapshots) cannot fire a spurious `grant.expired` push. `getActiveGrants`
   * establishes no liveness at all, so it is the wrong read for those callers.
   */
  getLiveGrants(sessionId?: string): Array<{ sessionId: string; toolId: string } & GrantEntry> {
    const now = this.now();
    return this.getActiveGrants(sessionId).filter(
      (entry) => now <= entry.expiresAt && now <= entry.issuedAt + this.maxLifetimeMs
    );
  }

  /**
   * Mint a native session-scoped automation grant (#10648). Authorizes the
   * given `allowedTools` for the session for up to `maxUses` dispatches within
   * the sliding TTL (capped by the hard `maxLifetimeMs` ceiling). Returns the
   * minted entry whose `id` is the revoke/refresh handle.
   *
   * Validation of the actor, the tool allowlist, and the bounds is the
   * caller's responsibility (`httpLifecycle.issueNativeGrant`) — the cache
   * clamps `maxUses` to at least 1 so an exhausted-on-issue grant can never
   * exist, and trusts the rest.
   */
  issueNativeGrant(params: IssueNativeGrantParams): NativeGrantEntry {
    if (this.disposed) {
      throw new Error("GrantCache has been disposed");
    }
    const issuedAt = this.now();
    const ttlMs = params.ttlMs ?? this.ttlMs;
    const maxUses = Math.max(1, Math.floor(params.maxUses ?? MCP_NATIVE_GRANT_DEFAULT_MAX_USES));
    const entry: NativeGrantEntry = {
      id: randomUUID(),
      sessionId: params.sessionId,
      actorId: params.actorId,
      actorType: params.actorType,
      allowedTools: new Set(params.allowedTools),
      maxUses,
      remainingUses: maxUses,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
      ttlMs,
    };
    this.nativeGrants.set(entry.id, entry);
    this.emitSafely(entry.sessionId, this.nativeIssuedPayload(entry));
    return entry;
  }

  /**
   * Authorize `toolId` for the session under a live native grant WITHOUT
   * consuming a use — the use is charged separately by {@link consumeNativeGrantUse}
   * once the call clears the rate limiter and is committed to dispatch, so a
   * call that authorizes but is then rate-limited can't burn a use it never
   * spent (#10648 review). Returns the authorizing grant's id on success.
   *
   * Picks the first (insertion-order) live grant whose allowlist covers the
   * tool. Expired / ceiling-past grants are lazily evicted (emitting the same
   * `grant.expired`/`grant.revoked` signals as the per-tool path) before being
   * skipped — eviction is hygiene, not use-consumption, so it is safe here.
   *
   * A tool whose cost is per-resolved-target (#12121) is refused outright,
   * before any grant is examined: no grant can cover it, so walking the map
   * could only evict entries on a call that was never going to be authorized.
   * Issuance already rejects these tools, so reaching here means a grant was
   * minted through the cache directly — defence in depth, not the main gate.
   */
  peekNativeGrant(sessionId: string, toolId: string): NativeGrantCheckResult {
    if (!isGenericNativeGrantEligible(toolId)) return { granted: false };
    const now = this.now();
    for (const entry of this.nativeGrants.values()) {
      if (entry.sessionId !== sessionId) continue;
      if (!entry.allowedTools.has(toolId)) continue;
      const pastCeiling = now > entry.issuedAt + this.maxLifetimeMs;
      const pastTtl = now > entry.expiresAt;
      if (pastCeiling || pastTtl) {
        this.nativeGrants.delete(entry.id);
        this.emitSafely(
          entry.sessionId,
          pastCeiling && !pastTtl
            ? this.nativeRevokedPayload(entry, "grant-ceiling")
            : this.nativeExpiredPayload(entry, toolId)
        );
        continue;
      }
      if (entry.remainingUses <= 0) {
        // Defensive: an exhausted grant should already have been deleted.
        this.nativeGrants.delete(entry.id);
        continue;
      }
      return { granted: true, grantId: entry.id };
    }
    return { granted: false };
  }

  /**
   * Charge one use against a native grant previously authorized by
   * {@link peekNativeGrant}. Synchronous decrement — paired with a peek that
   * ran with no intervening `await`, two concurrent in-flight calls against a
   * `maxUses: 1` grant can never both consume it. When the consumed use is the
   * last one the grant is deleted and a `grant.exhausted` record is emitted (a
   * natural terminal state, distinct from a forced revoke). Returns false and
   * fails closed when the grant is gone or has aged past its TTL/ceiling since
   * the peek — the caller must reject the dispatch in that case.
   *
   * Also fails closed for a per-resolved-target tool (#12121), after the
   * TTL/ceiling checks so a caller holding a stale id still learns the grant
   * aged out. A policy refusal leaves `remainingUses` untouched and emits no
   * usage record — nothing was authorized, so nothing was spent — and does not
   * delete the grant, which may still cover eligible siblings.
   */
  consumeNativeGrantUse(grantId: string, toolId: string): boolean {
    const entry = this.nativeGrants.get(grantId);
    if (!entry) return false;
    const now = this.now();
    const pastCeiling = now > entry.issuedAt + this.maxLifetimeMs;
    const pastTtl = now > entry.expiresAt;
    if (pastCeiling || pastTtl) {
      this.nativeGrants.delete(grantId);
      this.emitSafely(
        entry.sessionId,
        pastCeiling && !pastTtl
          ? this.nativeRevokedPayload(entry, "grant-ceiling")
          : this.nativeExpiredPayload(entry, toolId)
      );
      return false;
    }
    if (!isGenericNativeGrantEligible(toolId)) return false;
    if (entry.remainingUses <= 0) {
      this.nativeGrants.delete(grantId);
      return false;
    }
    entry.remainingUses -= 1;
    if (entry.remainingUses <= 0) {
      this.nativeGrants.delete(grantId);
      this.emitSafely(entry.sessionId, this.nativeUsedPayload(entry, toolId, "grant.exhausted"));
    } else {
      this.emitSafely(entry.sessionId, this.nativeUsedPayload(entry, toolId, "grant.used"));
    }
    return true;
  }

  /**
   * Extend a native grant's sliding TTL after a successful dispatch. Keyed by
   * the grant id captured at {@link checkNativeGrant} time, so a grant revoked
   * or exhausted mid-dispatch (its id already gone) makes this a silent no-op —
   * the same resurrection-race guard as the per-tool {@link refresh}. Does NOT
   * refund a use; uses are consumed at authorization and never returned.
   */
  refreshNativeGrant(grantId: string): boolean {
    const entry = this.nativeGrants.get(grantId);
    if (!entry) return false;
    const now = this.now();
    if (now > entry.issuedAt + this.maxLifetimeMs) {
      this.nativeGrants.delete(grantId);
      this.emitSafely(entry.sessionId, this.nativeRevokedPayload(entry, "grant-ceiling"));
      return false;
    }
    entry.expiresAt = now + entry.ttlMs;
    return true;
  }

  /**
   * Explicitly revoke a single native grant by id. Emits `grant.revoked` with
   * the given reason. Returns false when the id was already gone (exhausted,
   * expired, or torn down with its session) so a renderer dismissal cleanup is
   * an idempotent no-op.
   */
  revokeNativeGrant(grantId: string, reason: McpGrantRevokedReason = "user"): boolean {
    const entry = this.nativeGrants.get(grantId);
    if (!entry) return false;
    this.nativeGrants.delete(grantId);
    this.emitSafely(entry.sessionId, this.nativeRevokedPayload(entry, reason));
    return true;
  }

  /**
   * Snapshot of live native grants, optionally filtered to one session.
   * Iteration order is insertion order for deterministic assertions. Does not
   * evict — callers filter expired entries by `expiresAt` like the per-tool
   * {@link getActiveGrants} consumers do.
   */
  getActiveNativeGrants(sessionId?: string): NativeGrantEntry[] {
    const out: NativeGrantEntry[] = [];
    for (const entry of this.nativeGrants.values()) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      out.push(entry);
    }
    return out;
  }

  /**
   * Like {@link getActiveNativeGrants} but returns only grants that are live by
   * every condition — uses remaining, not past TTL, and not past the hard
   * wall-clock ceiling. Used for the settings live-status snapshot so a grant
   * that is logically dead (but not yet swept) never shows as active with a
   * misleading countdown. Read-only: does not evict.
   */
  getLiveNativeGrants(sessionId?: string): NativeGrantEntry[] {
    const now = this.now();
    const out: NativeGrantEntry[] = [];
    for (const entry of this.nativeGrants.values()) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      if (entry.remainingUses <= 0) continue;
      if (now > entry.expiresAt) continue;
      if (now > entry.issuedAt + this.maxLifetimeMs) continue;
      out.push(entry);
    }
    return out;
  }

  /**
   * Look up a single native grant by id. Returns the live entry (or undefined
   * when already gone) — used by the revoke path's caller-pin check, which
   * reads `sessionId` to verify the requester owns the grant's session.
   */
  getNativeGrant(grantId: string): NativeGrantEntry | undefined {
    return this.nativeGrants.get(grantId);
  }

  private nativeIssuedPayload(entry: NativeGrantEntry): McpGrantLifecyclePayload {
    return {
      type: "grant.issued",
      sessionId: entry.sessionId,
      toolId: "*",
      ttlMs: entry.ttlMs,
      expiresAt: entry.expiresAt,
      grantId: entry.id,
      actorId: entry.actorId,
      actorType: entry.actorType,
      maxUses: entry.maxUses,
      remainingUses: entry.remainingUses,
      allowedTools: [...entry.allowedTools],
    };
  }

  private nativeUsedPayload(
    entry: NativeGrantEntry,
    toolId: string,
    type: "grant.used" | "grant.exhausted"
  ): McpGrantLifecyclePayload {
    return {
      type,
      sessionId: entry.sessionId,
      toolId,
      ttlMs: entry.ttlMs,
      expiresAt: type === "grant.used" ? entry.expiresAt : undefined,
      grantId: entry.id,
      actorId: entry.actorId,
      actorType: entry.actorType,
      maxUses: entry.maxUses,
      remainingUses: entry.remainingUses,
    };
  }

  private nativeRevokedPayload(
    entry: NativeGrantEntry,
    reason: McpGrantRevokedReason
  ): McpGrantLifecyclePayload {
    return {
      type: "grant.revoked",
      sessionId: entry.sessionId,
      toolId: "*",
      ttlMs: entry.ttlMs,
      revokedReason: reason,
      grantId: entry.id,
      actorId: entry.actorId,
      actorType: entry.actorType,
      maxUses: entry.maxUses,
      remainingUses: entry.remainingUses,
      allowedTools: [...entry.allowedTools],
    };
  }

  private nativeExpiredPayload(entry: NativeGrantEntry, toolId: string): McpGrantLifecyclePayload {
    return {
      type: "grant.expired",
      sessionId: entry.sessionId,
      toolId,
      ttlMs: entry.ttlMs,
      grantId: entry.id,
      actorId: entry.actorId,
      actorType: entry.actorType,
      maxUses: entry.maxUses,
      remainingUses: entry.remainingUses,
    };
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
    for (const [id, entry] of [...this.nativeGrants]) {
      const pastCeiling = now > entry.issuedAt + this.maxLifetimeMs;
      const pastTtl = now > entry.expiresAt;
      if (!pastCeiling && !pastTtl) continue;
      this.nativeGrants.delete(id);
      evicted += 1;
      this.emitSafely(
        entry.sessionId,
        pastCeiling && !pastTtl
          ? this.nativeRevokedPayload(entry, "grant-ceiling")
          : this.nativeExpiredPayload(entry, "*")
      );
    }
    for (const [k, entry] of [...this.grants]) {
      // Ceiling-expired entries can still have a future `expiresAt` (they were
      // refreshed recently), so they survive the TTL skip — evict on either
      // condition. Mirror `check()`'s audit semantics: `grant-ceiling` only
      // when the sliding TTL was still valid (recently refreshed) at the
      // moment the hard cap hit; an already-lapsed TTL stays `grant.expired`.
      const pastCeiling = now > entry.issuedAt + this.maxLifetimeMs;
      const pastTtl = now > entry.expiresAt;
      if (!pastCeiling && !pastTtl) continue;
      this.grants.delete(k);
      evicted += 1;
      const colon = k.indexOf(":");
      if (colon < 0) continue;
      const sessionId = k.substring(0, colon);
      const toolId = k.substring(colon + 1);
      this.emitSafely(
        sessionId,
        pastCeiling && !pastTtl
          ? {
              type: "grant.revoked",
              sessionId,
              toolId,
              ttlMs: entry.ttlMs,
              revokedReason: "grant-ceiling",
            }
          : {
              type: "grant.expired",
              sessionId,
              toolId,
              ttlMs: entry.ttlMs,
            }
      );
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
    this.nativeGrants.clear();
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
    this.nativeGrants.clear();
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

  /** @internal */
  _peekNative(grantId: string): NativeGrantEntry | undefined {
    return this.nativeGrants.get(grantId);
  }
}

export type { McpGrantActorType, McpGrantRecordType, McpGrantRevokedReason };
