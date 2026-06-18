import type { ActionContext } from "../../../shared/types/actions.js";
import type { McpActiveClientInfo } from "../../../shared/types/ipc/mcpServer.js";
import type { McpTier, McpSseSession, McpHttpSession, RateLimitConfig } from "./shared.js";
import {
  MCP_SSE_IDLE_TIMEOUT_MS,
  MCP_TIER_ELEVATION_TTL_MS,
  rateLimitConfigForTool,
} from "./shared.js";
import type { DedupCacheEntry, DedupInFlightEntry } from "./sessionDedup.js";
import { GrantCache, type GrantLifecycleEmitter } from "./grantCache.js";
import { getSystemSleepService } from "../SystemSleepService.js";

export interface SessionStoreOptions {
  /**
   * Lifecycle emitter wired through to the {@link GrantCache} so audit
   * entries and renderer broadcasts fire for every `issued`/`expired`/
   * `revoked` transition. Optional so the bare `new SessionStore(...)`
   * test fixture path still constructs without an emitter (the cache
   * defaults to silent).
   */
  emitGrantLifecycle?: GrantLifecycleEmitter;
  /**
   * Callback fired alongside the other per-session cleanup hooks
   * (idle expiry, explicit revoke, drain) so the {@link AbusePolicy}
   * denial counter can be pruned in lockstep. Without this, the
   * policy's internal Map grows for every session that ever opens
   * and is only pruned on the rare abuse-trip path. Optional so test
   * fixtures construct without one.
   */
  dropAbuseState?: (sessionId: string) => void;
  /**
   * Fired alongside the other per-session cleanup hooks so the live
   * bearer-connection register in `httpLifecycle` drops this session from
   * its owning bearer entry (and the entry itself once its last session
   * closes). Mirrors {@link dropAbuseState} — the register is owned by
   * `HttpLifecycle`, so the store reaches it through this callback rather
   * than holding a reference. Optional so bare test fixtures construct
   * without one.
   */
  dropBearerState?: (sessionId: string) => void;
  /**
   * Fired when a session's renderer-approved tier elevation expires and the
   * session is silently decayed back to the `workbench` baseline (#8462).
   * `httpLifecycle` wires this to `server.sendToolListChanged()` on the
   * decayed session so the model's tool manifest reflects the narrowed
   * surface immediately. Optional so bare test fixtures construct without
   * one (decay still mutates the tier map; only the notification is skipped).
   *
   * `previousTier` is the elevated tier the session left; `newTier` is the
   * baseline it decayed back to. Both are passed so the wiring can write a
   * `tier.decayed` audit record without re-reading the (already-mutated)
   * tier map.
   */
  onTierDecayed?: (sessionId: string, previousTier: McpTier, newTier: McpTier) => void;
}

/**
 * Mutable token-bucket state for one `(sessionId, toolId)` pair. `tokens`
 * is the current fractional balance; `lastRefillMs` is the wall-clock of
 * the most recent refill so the next call can recompute lazily.
 */
export interface RateLimitBucket {
  tokens: number;
  lastRefillMs: number;
}

export type ConsumeTokenResult = { allowed: true } | { allowed: false; retryAfter: number };

/**
 * Pure token-bucket step. Refills `bucket` for the time elapsed since its
 * last refill (capped at `config.capacity`), then attempts to consume one
 * token. Mutates `bucket` in place and returns whether the call is allowed;
 * on rejection `retryAfter` is the whole-seconds wait until one token has
 * accrued (always `>= 1`). Exported for direct unit coverage independent
 * of the session-store wiring.
 */
export function consumeToken(
  bucket: RateLimitBucket,
  config: RateLimitConfig,
  nowMs: number
): ConsumeTokenResult {
  const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
  bucket.tokens = Math.min(config.capacity, bucket.tokens + elapsed * config.refillPerMs);
  // Never move the refill anchor backward: a backward `Date.now()` (NTP
  // step-back, which Electron can see on macOS) would otherwise let the
  // next call accrue refill it didn't earn.
  bucket.lastRefillMs = Math.max(bucket.lastRefillMs, nowMs);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }
  const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / config.refillPerMs / 1000));
  return { allowed: false, retryAfter };
}

export class SessionStore {
  readonly sessions = new Map<string, McpSseSession>();
  readonly httpSessions = new Map<string, McpHttpSession>();
  readonly sessionTierMap = new Map<string, McpTier>();
  // sessionId → renderer WebContents id pinned at handshake. Only populated
  // for help-session bearers; api-key / pane-token sessions stay absent and
  // fall through to the focused-window dispatch path. See #7002.
  readonly sessionWebContentsMap = new Map<string, number>();
  // sessionId → ActionContext snapshot captured in the renderer at provision
  // time and bound at handshake. Populated only for help-session bearers, in
  // exact lockstep with sessionWebContentsMap. Pinned dispatch passes this as
  // `contextOverride` so a focus shift between the model's tool call and the
  // dispatch can't retarget the action. See #8317.
  readonly sessionContextMap = new Map<string, ActionContext>();
  // MCP transport sessionId → public help-session id (the one persisted in
  // the renderer's helpPanelStore). Populated only for help-session bearers,
  // in lockstep with sessionWebContentsMap. The transport mints its own
  // per-connection id, so this is the join that lets audit records and
  // turn-id lookups correlate back to the help session the user sees.
  readonly sessionHelpIdMap = new Map<string, string>();
  // Public help-session id → count of figures emitted by `help.displayImage`
  // (#9828). Keyed by the public help-session id (NOT the transport sessionId)
  // so the sequence survives a transport reconnect within one conversation.
  // Torn down when the help session's transport is reaped, by capturing the
  // public id from `sessionHelpIdMap` BEFORE that map entry is deleted.
  readonly figureCounters = new Map<string, number>();
  readonly resourceSubscriptions = new Map<string, Map<string, () => void>>();
  // Per-session idempotency dedup state for the MCP creation-tool allowlist.
  // Two phases: in-flight singleflight (same-moment duplicates share the
  // original Promise) and TTL'd result cache (post-completion duplicates
  // return the original result). Cleared on drain and idle expiry.
  readonly dedupInFlight = new Map<string, Map<string, DedupInFlightEntry>>();
  readonly dedupResultCache = new Map<string, Map<string, DedupCacheEntry>>();
  // Per-`(sessionId, toolId)` token buckets for the runaway-loop rate
  // limiter (#8468). Lazily populated on first call to a tool and torn
  // down in lockstep with the other session-scoped maps on drain, idle
  // expiry, and explicit revoke.
  readonly rateLimitBuckets = new Map<string, Map<string, RateLimitBucket>>();
  /**
   * Per-`(sessionId, toolId)` time-bounded grants — replaces the sticky
   * `sessionTierMap` elevation pathway for the "Approve once" flow (#8442).
   * Co-located with the other session-scoped maps so a single drain or
   * idle-timer firing tears them down in lockstep.
   */
  readonly grantCache: GrantCache;

  // Wall-clock timestamps recording when each session's idle timer was armed.
  // Used by recomputeIdleTimers() to calculate awake elapsed time across
  // suspend/resume cycles via SystemSleepService.getAwakeTimeSince().
  private readonly idleStartedAt = new Map<string, number>();
  private readonly httpIdleStartedAt = new Map<string, number>();

  // Connection metadata captured at handshake, keyed by sessionId, so the
  // MCP-disable confirmation can name the external clients about to be
  // severed (#8779). `connectedAtMs` is the handshake wall-clock; `userAgent`
  // is the raw header (null when absent); `clientTransport` records which
  // surface the session arrived on. Torn down in lockstep with the other
  // per-session maps on drain / revoke / idle expiry.
  private readonly sessionConnectedAtMs = new Map<string, number>();
  private readonly sessionUserAgent = new Map<string, string | null>();
  private readonly sessionTransport = new Map<string, "sse" | "streamable-http">();

  // Tier-elevation decay timers, keyed by sessionId (unique across SSE and
  // HTTP). A renderer-approved "Always allow" elevation is bounded to
  // MCP_TIER_ELEVATION_TTL_MS; on expiry the session silently decays to the
  // `workbench` baseline (#8462). `tierElevationStartedAt` drives the same
  // awake-time correction as the idle reaper; `tierElevationToken` records
  // the tier captured when the timer was armed so a fresh re-elevation
  // between arm and fire is never wiped (#2243 stale-token guard). Stored
  // off the session object (unlike `idleTimer`) so the four inline cleanup
  // paths in `httpLifecycle` can tear it down via `clearElevationTimer`.
  private readonly tierElevationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tierElevationStartedAt = new Map<string, number>();
  private readonly tierElevationToken = new Map<string, McpTier>();
  // The session's token-resolved baseline tier captured at the first
  // elevation in a chain. Decay reverts here, NOT to a hardcoded
  // `workbench` — a help-session bearer can hold a configured baseline of
  // `action`/`system` (`HelpAssistantTier`), and dropping it to `workbench`
  // would strip tools the user legitimately had from handshake. Preserved
  // across chained re-elevations (workbench→action→system still decays all
  // the way to workbench).
  private readonly tierElevationBaseline = new Map<string, McpTier>();

  private readonly cleanupResourceSubscriptionsFn: (sessionId: string) => void;
  private readonly dropAbuseStateFn: (sessionId: string) => void;
  private readonly dropBearerStateFn: (sessionId: string) => void;
  private readonly onTierDecayedFn: (
    sessionId: string,
    previousTier: McpTier,
    newTier: McpTier
  ) => void;

  constructor(
    cleanupResourceSubscriptions: (sessionId: string) => void,
    options: SessionStoreOptions = {}
  ) {
    this.cleanupResourceSubscriptionsFn = cleanupResourceSubscriptions;
    this.dropAbuseStateFn = options.dropAbuseState ?? (() => {});
    this.dropBearerStateFn = options.dropBearerState ?? (() => {});
    this.onTierDecayedFn = options.onTierDecayed ?? (() => {});
    this.grantCache = new GrantCache({ emit: options.emitGrantLifecycle });
  }

  clearDedupState(sessionId: string): void {
    this.dedupInFlight.delete(sessionId);
    this.dedupResultCache.delete(sessionId);
  }

  /**
   * Record handshake-time connection metadata for a session so the
   * MCP-disable confirmation can name it later (#8779). Called once per
   * session from the SSE and Streamable HTTP handshake paths, after the
   * tier has been stamped. Cleared by every per-session teardown path.
   */
  registerClientMetadata(
    sessionId: string,
    userAgent: string | null,
    transport: "sse" | "streamable-http"
  ): void {
    this.sessionConnectedAtMs.set(sessionId, Date.now());
    this.sessionUserAgent.set(sessionId, userAgent);
    this.sessionTransport.set(sessionId, transport);
  }

  /**
   * Drop a session's connection metadata. Public so the inline
   * `transport.onclose` / connect-failure cleanup closures in `httpLifecycle`
   * can tear it down in lockstep with the other per-session maps on a normal
   * disconnect (not just idle expiry / revoke / drain).
   */
  clearClientMetadata(sessionId: string): void {
    this.sessionConnectedAtMs.delete(sessionId);
    this.sessionUserAgent.delete(sessionId);
    this.sessionTransport.delete(sessionId);
  }

  /**
   * Snapshot the currently-connected external clients — sessions classified
   * `external` (api-key / unauthenticated loopback) that are NOT pinned to a
   * renderer WebContents. Renderer-pinned sessions are Daintree's own
   * help-assistant bearers; naming them in the disable dialog would be
   * recursive (#8779). Pane-token sessions resolve to a non-`external` tier
   * and are filtered out by the tier check. Returns one entry per live
   * session across both transports.
   */
  listExternalActiveClients(): McpActiveClientInfo[] {
    const out: McpActiveClientInfo[] = [];
    const sessionIds = new Set<string>([...this.sessions.keys(), ...this.httpSessions.keys()]);
    for (const sessionId of sessionIds) {
      if (this.sessionTierMap.get(sessionId) !== "external") continue;
      if (this.sessionWebContentsMap.has(sessionId)) continue;
      out.push({
        sessionId,
        userAgent: this.sessionUserAgent.get(sessionId) ?? null,
        connectedAtMs: this.sessionConnectedAtMs.get(sessionId) ?? Date.now(),
        transport: this.sessionTransport.get(sessionId) ?? "streamable-http",
      });
    }
    return out;
  }

  /**
   * Charge one token against the `(sessionId, toolId)` bucket, creating a
   * full bucket on first use. The tier is resolved from
   * `rateLimitConfigForTool` so an unmapped tool falls back to `standard`.
   * Thin wrapper around the pure {@link consumeToken} step.
   */
  consumeRateLimitToken(
    sessionId: string,
    toolId: string,
    nowMs: number = Date.now()
  ): ConsumeTokenResult {
    const config = rateLimitConfigForTool(toolId);
    let byTool = this.rateLimitBuckets.get(sessionId);
    if (!byTool) {
      byTool = new Map<string, RateLimitBucket>();
      this.rateLimitBuckets.set(sessionId, byTool);
    }
    let bucket = byTool.get(toolId);
    if (!bucket) {
      bucket = { tokens: config.capacity, lastRefillMs: nowMs };
      byTool.set(toolId, bucket);
    }
    return consumeToken(bucket, config, nowMs);
  }

  clearRateLimitState(sessionId: string): void {
    this.rateLimitBuckets.delete(sessionId);
  }

  /**
   * Assign the next sequential figure number for a help session and advance
   * the counter (#9828). First call for a session returns 1. Keyed by the
   * public help-session id so the sequence is stable across transport
   * reconnects within one conversation — the model never picks its own number.
   */
  nextFigureNumber(helpSessionId: string): number {
    const next = (this.figureCounters.get(helpSessionId) ?? 0) + 1;
    this.figureCounters.set(helpSessionId, next);
    return next;
  }

  /**
   * Drop a help session's figure counter. Resolve the public help-session id
   * from {@link sessionHelpIdMap} BEFORE that entry is deleted, since the
   * counter is keyed by the public id, not the transport sessionId. Public so
   * the inline `transport.onclose` / connect-failure cleanup closures in
   * `httpLifecycle` can tear it down on a normal disconnect, in lockstep with
   * the other per-session maps (mirrors {@link clearClientMetadata}).
   */
  clearFigureCounter(sessionId: string): void {
    const helpSessionId = this.sessionHelpIdMap.get(sessionId);
    if (helpSessionId !== undefined) {
      this.figureCounters.delete(helpSessionId);
    }
  }

  private expireSseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.sessionTierMap.delete(sessionId);
    // Revoke BEFORE deleting the WebContents pin so the lifecycle
    // emitter can still resolve the pinned renderer and dispatch the
    // `grant.revoked` event. The audit-record write tolerates a
    // missing pin (it doesn't need one); the targeted `wc.send` does.
    this.grantCache.revokeSession(sessionId, "session-idle");
    this.sessionWebContentsMap.delete(sessionId);
    this.sessionContextMap.delete(sessionId);
    this.clearFigureCounter(sessionId);
    this.sessionHelpIdMap.delete(sessionId);
    this.clearDedupState(sessionId);
    this.clearRateLimitState(sessionId);
    this.clearClientMetadata(sessionId);
    this.idleStartedAt.delete(sessionId);
    this.clearElevationTimer(sessionId);
    this.dropAbuseStateFn(sessionId);
    this.dropBearerStateFn(sessionId);
    this.cleanupResourceSubscriptionsFn(sessionId);
    session.transport.close().catch(() => {
      // ignore close errors during idle timeout cleanup
    });
  }

  createIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    this.idleStartedAt.set(sessionId, Date.now());
    const checkAndExpire = () => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      const startedAt = this.idleStartedAt.get(sessionId);
      if (startedAt !== undefined) {
        try {
          const awakeElapsed = getSystemSleepService().getAwakeTimeSince(startedAt);
          if (awakeElapsed < MCP_SSE_IDLE_TIMEOUT_MS) {
            const remaining = Math.max(1, MCP_SSE_IDLE_TIMEOUT_MS - awakeElapsed);
            session.idleTimer = setTimeout(checkAndExpire, remaining);
            (session.idleTimer as ReturnType<typeof setTimeout>).unref?.();
            return;
          }
        } catch {
          // Fall through to expiry.
        }
      }
      this.expireSseSession(sessionId);
    };
    const timer = setTimeout(checkAndExpire, MCP_SSE_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  resetIdleTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createIdleTimer(sessionId);
  }

  private expireHttpSession(sessionId: string): void {
    const session = this.httpSessions.get(sessionId);
    if (!session) return;
    this.httpSessions.delete(sessionId);
    this.sessionTierMap.delete(sessionId);
    // Revoke BEFORE deleting the WebContents pin — same reasoning
    // as `expireSseSession` above.
    this.grantCache.revokeSession(sessionId, "session-idle");
    this.sessionWebContentsMap.delete(sessionId);
    this.sessionContextMap.delete(sessionId);
    this.clearFigureCounter(sessionId);
    this.sessionHelpIdMap.delete(sessionId);
    this.clearDedupState(sessionId);
    this.clearRateLimitState(sessionId);
    this.clearClientMetadata(sessionId);
    this.httpIdleStartedAt.delete(sessionId);
    this.clearElevationTimer(sessionId);
    this.dropAbuseStateFn(sessionId);
    this.dropBearerStateFn(sessionId);
    this.cleanupResourceSubscriptionsFn(sessionId);
    session.transport.close().catch(() => {
      // ignore close errors during idle timeout cleanup
    });
  }

  createHttpIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    this.httpIdleStartedAt.set(sessionId, Date.now());
    const checkAndExpire = () => {
      const session = this.httpSessions.get(sessionId);
      if (!session) return;
      const startedAt = this.httpIdleStartedAt.get(sessionId);
      if (startedAt !== undefined) {
        try {
          const awakeElapsed = getSystemSleepService().getAwakeTimeSince(startedAt);
          if (awakeElapsed < MCP_SSE_IDLE_TIMEOUT_MS) {
            const remaining = Math.max(1, MCP_SSE_IDLE_TIMEOUT_MS - awakeElapsed);
            session.idleTimer = setTimeout(checkAndExpire, remaining);
            (session.idleTimer as ReturnType<typeof setTimeout>).unref?.();
            return;
          }
        } catch {
          // Fall through to expiry.
        }
      }
      this.expireHttpSession(sessionId);
    };
    const timer = setTimeout(checkAndExpire, MCP_SSE_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  resetHttpIdleTimer(sessionId: string): void {
    const session = this.httpSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createHttpIdleTimer(sessionId);
  }

  recomputeIdleTimers(): void {
    // Snapshot entries to avoid mutation-during-iteration from timer callbacks.
    const sseEntries = Array.from(this.sessions.entries());
    for (const [sessionId, session] of sseEntries) {
      let startedAt = this.idleStartedAt.get(sessionId);
      if (startedAt === undefined) {
        console.warn(`[MCP] Missing idleStartedAt for SSE session ${sessionId}, resetting`);
        startedAt = Date.now();
        this.idleStartedAt.set(sessionId, startedAt);
      }
      try {
        const awakeElapsed = getSystemSleepService().getAwakeTimeSince(startedAt);
        if (awakeElapsed >= MCP_SSE_IDLE_TIMEOUT_MS) {
          this.expireSseSession(sessionId);
        } else {
          clearTimeout(session.idleTimer);
          const remaining = Math.max(1, MCP_SSE_IDLE_TIMEOUT_MS - awakeElapsed);
          session.idleTimer = setTimeout(() => {
            this.expireSseSession(sessionId);
          }, remaining);
          (session.idleTimer as ReturnType<typeof setTimeout>).unref?.();
        }
      } catch {
        // SystemSleepService may not be initialized; keep existing timer.
      }
    }

    const httpEntries = Array.from(this.httpSessions.entries());
    for (const [sessionId, session] of httpEntries) {
      let startedAt = this.httpIdleStartedAt.get(sessionId);
      if (startedAt === undefined) {
        console.warn(`[MCP] Missing httpIdleStartedAt for HTTP session ${sessionId}, resetting`);
        startedAt = Date.now();
        this.httpIdleStartedAt.set(sessionId, startedAt);
      }
      try {
        const awakeElapsed = getSystemSleepService().getAwakeTimeSince(startedAt);
        if (awakeElapsed >= MCP_SSE_IDLE_TIMEOUT_MS) {
          this.expireHttpSession(sessionId);
        } else {
          clearTimeout(session.idleTimer);
          const remaining = Math.max(1, MCP_SSE_IDLE_TIMEOUT_MS - awakeElapsed);
          session.idleTimer = setTimeout(() => {
            this.expireHttpSession(sessionId);
          }, remaining);
          (session.idleTimer as ReturnType<typeof setTimeout>).unref?.();
        }
      } catch {
        // SystemSleepService may not be initialized; keep existing timer.
      }
    }

    // Recompute tier-elevation timers in lockstep with the idle reaper so a
    // long suspend doesn't either prematurely decay a session (sleep time
    // must not count) or leave a stale elevation parked indefinitely after
    // wake. If idle expiry above already collected the session, the
    // session-existence guard makes this a no-op cleanup. Snapshot to avoid
    // mutation-during-iteration from `decayTier`.
    const elevationEntries = Array.from(this.tierElevationStartedAt.entries());
    for (const [sessionId, startedAt] of elevationEntries) {
      if (!this.sessions.has(sessionId) && !this.httpSessions.has(sessionId)) {
        this.clearElevationTimer(sessionId);
        continue;
      }
      try {
        const awakeElapsed = getSystemSleepService().getAwakeTimeSince(startedAt);
        if (awakeElapsed >= MCP_TIER_ELEVATION_TTL_MS) {
          this.decayTier(sessionId);
        } else {
          clearTimeout(this.tierElevationTimers.get(sessionId));
          const remaining = Math.max(1, MCP_TIER_ELEVATION_TTL_MS - awakeElapsed);
          this.scheduleTierElevationCheck(sessionId, remaining);
        }
      } catch {
        // SystemSleepService may not be initialized; keep existing timer.
      }
    }
  }

  /**
   * Arm (or refresh) the decay timer for a renderer-approved tier
   * elevation. `baselineTier` is the session's pre-elevation tier (the
   * token-resolved handshake tier) — decay reverts here, not to a hardcoded
   * `workbench`. Idempotent: clearing first makes a repeat "Always allow"
   * reset the window from now. A baseline captured by an earlier elevation
   * in the same chain is preserved (workbench→action→system still decays
   * all the way to workbench). When the requested tier equals the effective
   * baseline the session isn't actually elevated, so any pending timer is
   * just cleared. Call this from `setSessionTier` after the promote-only
   * guard accepts the change.
   */
  armTierElevationTimer(sessionId: string, tier: McpTier, baselineTier: McpTier): void {
    const baseline = this.tierElevationBaseline.get(sessionId) ?? baselineTier;
    this.clearElevationTimer(sessionId);
    if (tier === baseline) return;
    this.tierElevationStartedAt.set(sessionId, Date.now());
    this.tierElevationToken.set(sessionId, tier);
    this.tierElevationBaseline.set(sessionId, baseline);
    this.scheduleTierElevationCheck(sessionId, MCP_TIER_ELEVATION_TTL_MS);
  }

  private scheduleTierElevationCheck(sessionId: string, delayMs: number): void {
    const timer = setTimeout(() => this.checkAndDecayTier(sessionId), delayMs);
    timer.unref?.();
    this.tierElevationTimers.set(sessionId, timer);
  }

  private checkAndDecayTier(sessionId: string): void {
    // Guard #1 (#3728): the session may have been reaped/closed between arm
    // and fire — its teardown path already dropped the elevation state.
    if (!this.sessions.has(sessionId) && !this.httpSessions.has(sessionId)) {
      this.clearElevationTimer(sessionId);
      return;
    }
    const startedAt = this.tierElevationStartedAt.get(sessionId);
    if (startedAt === undefined) return;
    try {
      const awakeElapsed = getSystemSleepService().getAwakeTimeSince(startedAt);
      if (awakeElapsed < MCP_TIER_ELEVATION_TTL_MS) {
        // Suspend time is excluded by getAwakeTimeSince, so re-arm against
        // the remaining awake budget without resetting startedAt/token —
        // the original deadline is preserved across sleep/wake.
        const remaining = Math.max(1, MCP_TIER_ELEVATION_TTL_MS - awakeElapsed);
        clearTimeout(this.tierElevationTimers.get(sessionId));
        this.scheduleTierElevationCheck(sessionId, remaining);
        return;
      }
    } catch {
      // SystemSleepService not initialized — fall through to decay.
    }
    this.decayTier(sessionId);
  }

  private decayTier(sessionId: string): void {
    const token = this.tierElevationToken.get(sessionId);
    const baseline = this.tierElevationBaseline.get(sessionId) ?? "workbench";
    const current = this.sessionTierMap.get(sessionId);
    this.clearElevationTimer(sessionId);
    // Guard #1: session gone — nothing to decay, nobody to notify.
    if (!this.sessions.has(sessionId) && !this.httpSessions.has(sessionId)) return;
    // Guard #2 (#2243): a fresh "Always allow" re-elevated this session
    // between arm and fire — its own timer owns the new window now; never
    // wipe a tier the user just re-approved.
    if (current === undefined || current !== token) return;
    // Already at/below the token baseline — nothing to roll back.
    if (current === baseline) return;
    this.sessionTierMap.set(sessionId, baseline);
    // Drop stale denial-suppression counters so the first post-decay
    // out-of-baseline call re-triggers the tier-mismatch banner instead of
    // being silently suppressed by denials accrued before the elevation
    // (the #8462 acceptance criterion). Per-tool grants survive — they are
    // an orthogonal explicit approval (#8442).
    this.grantCache.clearDenialCounts(sessionId);
    this.onTierDecayedFn(sessionId, current, baseline);
  }

  /**
   * Tear down a session's tier-elevation timer and bookkeeping. Public so
   * the inline cleanup paths in `httpLifecycle` (SSE/HTTP `transport.onclose`
   * and the two connect-failure catch blocks) can clear it without routing
   * through the private session-expiry helpers (#4851: every setTimeout must
   * be cleared in every exit path).
   */
  clearElevationTimer(sessionId: string): void {
    const timer = this.tierElevationTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.tierElevationTimers.delete(sessionId);
    this.tierElevationStartedAt.delete(sessionId);
    this.tierElevationToken.delete(sessionId);
    this.tierElevationBaseline.delete(sessionId);
  }

  getTier(sessionId: string): McpTier {
    return this.sessionTierMap.get(sessionId) ?? "workbench";
  }

  /**
   * Snapshot the live tier and per-tool grants for a help session, addressed
   * by its *public* help-session id (the one persisted in the renderer's
   * `helpPanelStore`, NOT the per-connection MCP transport sessionId that keys
   * these maps). Resolves the transport sessionId through {@link sessionHelpIdMap}
   * before reading the tier/grant state.
   *
   * Caller-pinned: returns `null` unless `callerWebContentsId` matches the
   * WebContents the session was pinned to at handshake — mirrors the
   * cross-window forgery defence on `setSessionTier`/`issueGrant`, so a renderer
   * can only ever read its own session's live status. Also returns `null` when
   * no live transport exists for the help id (session never connected, idled
   * out, or was revoked) so the caller renders a "no live session" state rather
   * than a stale snapshot.
   */
  getLiveStatusForHelpSession(
    helpSessionId: string,
    callerWebContentsId: number
  ): {
    tier: McpTier;
    activeGrants: Array<{
      toolId: string;
      expiresAt: number;
      ttlMs: number;
      kind?: "per-tool" | "native";
      grantId?: string;
      allowedTools?: string[];
      maxUses?: number;
      remainingUses?: number;
    }>;
  } | null {
    if (!helpSessionId) return null;
    for (const [transportSessionId, mappedHelpId] of this.sessionHelpIdMap) {
      if (mappedHelpId !== helpSessionId) continue;
      // Caller-pin: only the renderer the session was pinned to may read it.
      // `continue` (not `return null`) so a stale reconnect mapping pinned to a
      // different WebContents iterated first can't mask the caller's own live
      // transport — keep scanning, and only fail closed once nothing matches.
      if (this.sessionWebContentsMap.get(transportSessionId) !== callerWebContentsId) {
        continue;
      }
      // The tier map can briefly outlive the transport during teardown; require
      // a live transport so a decaying session never reports as connected.
      if (!this.sessions.has(transportSessionId) && !this.httpSessions.has(transportSessionId)) {
        continue;
      }
      // getActiveGrants is lazy-eviction only — a grant past expiresAt can
      // linger until the periodic sweep (~5min). Filter those out so the
      // snapshot never reports a logically-expired grant as active; the next
      // sweep's `grant.expired` push will reconcile the renderer anyway.
      const now = Date.now();
      const activeGrants = this.grantCache
        .getActiveGrants(transportSessionId)
        .filter((g) => g.expiresAt > now)
        .map((g) => ({ toolId: g.toolId, expiresAt: g.expiresAt, ttlMs: g.ttlMs }));
      // Native session-scoped automation grants (#10648) are addressed by the
      // transport sessionId in the cache; merge them into the same snapshot so
      // the settings surface shows the full grant lifecycle. Lazy-eviction
      // semantics match the per-tool grants — drop logically-expired entries.
      const nativeGrants = this.grantCache.getLiveNativeGrants(transportSessionId).map((g) => ({
        toolId: "*",
        expiresAt: g.expiresAt,
        ttlMs: g.ttlMs,
        kind: "native" as const,
        grantId: g.id,
        allowedTools: [...g.allowedTools],
        maxUses: g.maxUses,
        remainingUses: g.remainingUses,
      }));
      return {
        tier: this.getTier(transportSessionId),
        activeGrants: [...activeGrants, ...nativeGrants],
      };
    }
    return null;
  }

  /**
   * Resolve the live transport sessionId backing a public help-session id,
   * caller-pinned. Mirrors {@link getLiveStatusForHelpSession}'s scan: returns
   * the transport sessionId only when a live transport exists for the help id
   * AND it is pinned to `callerWebContentsId`, else null. Used by the native
   * grant issuance path (#10648) so the renderer can approve a grant addressed
   * by the public help id it already holds, never a transport id it can't see.
   */
  resolveLiveTransportForHelpSession(
    helpSessionId: string,
    callerWebContentsId: number
  ): string | null {
    if (!helpSessionId) return null;
    for (const [transportSessionId, mappedHelpId] of this.sessionHelpIdMap) {
      if (mappedHelpId !== helpSessionId) continue;
      if (this.sessionWebContentsMap.get(transportSessionId) !== callerWebContentsId) continue;
      if (!this.sessions.has(transportSessionId) && !this.httpSessions.has(transportSessionId)) {
        continue;
      }
      return transportSessionId;
    }
    return null;
  }

  revokeSession(sessionId: string): boolean {
    const sseSession = this.sessions.get(sessionId);
    const httpSession = this.httpSessions.get(sessionId);
    if (!sseSession && !httpSession) return false;

    if (sseSession) {
      clearTimeout(sseSession.idleTimer);
      this.sessions.delete(sessionId);
      sseSession.transport.close().catch(() => {});
    }
    if (httpSession) {
      clearTimeout(httpSession.idleTimer);
      this.httpSessions.delete(sessionId);
      httpSession.transport.close().catch(() => {});
    }

    this.sessionTierMap.delete(sessionId);
    // Revoke BEFORE deleting the WebContents pin so the lifecycle
    // emitter can still resolve the pinned renderer for the
    // `grant.revoked` push. Without this, any outstanding per-tool
    // grants would be left in the cache while the session entry is
    // torn down — the renderer would never receive the `revoked`
    // lifecycle event and the grant state would leak (#8467).
    this.grantCache.revokeSession(sessionId, "session-ended");
    this.sessionWebContentsMap.delete(sessionId);
    this.sessionContextMap.delete(sessionId);
    this.clearFigureCounter(sessionId);
    this.sessionHelpIdMap.delete(sessionId);
    this.clearDedupState(sessionId);
    this.clearRateLimitState(sessionId);
    this.clearClientMetadata(sessionId);
    this.clearElevationTimer(sessionId);
    this.dropAbuseStateFn(sessionId);
    this.dropBearerStateFn(sessionId);
    this.cleanupResourceSubscriptionsFn(sessionId);
    return true;
  }

  drain(): void {
    // Clear dedup state up-front so an in-flight `.finally()` resolving
    // after drain finds no session to write back into and does not
    // resurrect a torn-down session's cache.
    this.dedupInFlight.clear();
    this.dedupResultCache.clear();
    this.rateLimitBuckets.clear();

    for (const session of this.sessions.values()) {
      clearTimeout(session.idleTimer);
      try {
        Promise.resolve(session.transport.close()).catch(() => {
          /* best-effort during teardown */
        });
      } catch {
        // ignore synchronous close errors during teardown
      }
    }
    this.sessions.clear();
    this.idleStartedAt.clear();

    for (const session of this.httpSessions.values()) {
      clearTimeout(session.idleTimer);
      try {
        Promise.resolve(session.transport.close()).catch(() => {
          /* best-effort during teardown */
        });
      } catch {
        // ignore synchronous close errors during teardown
      }
    }
    this.httpSessions.clear();
    this.httpIdleStartedAt.clear();
    for (const timer of this.tierElevationTimers.values()) {
      clearTimeout(timer);
    }
    this.tierElevationTimers.clear();
    this.tierElevationStartedAt.clear();
    this.tierElevationToken.clear();
    this.tierElevationBaseline.clear();
    this.sessionTierMap.clear();
    this.sessionWebContentsMap.clear();
    this.sessionContextMap.clear();
    this.sessionHelpIdMap.clear();
    this.figureCounters.clear();
    this.sessionConnectedAtMs.clear();
    this.sessionUserAgent.clear();
    this.sessionTransport.clear();
    // Wholesale teardown: drop grants without per-entry audit noise but
    // keep the sweep timer so the store can be reused after a subsequent
    // `start()`. The audit ring buffer still carries each grant's original
    // `grant.issued` entry; teardown is an environmental event, not a user
    // action worth a `grant.revoked` per tool.
    this.grantCache.clearAll();

    for (const bucket of this.resourceSubscriptions.values()) {
      for (const unsub of bucket.values()) {
        try {
          unsub();
        } catch {
          // best-effort during teardown
        }
      }
    }
    this.resourceSubscriptions.clear();
  }
}
