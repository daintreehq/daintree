import type { ActionContext } from "../../../shared/types/actions.js";
import type { McpTier, McpSseSession, McpHttpSession } from "./shared.js";
import { MCP_SSE_IDLE_TIMEOUT_MS } from "./shared.js";
import type {
  CallToolResultLike,
  DedupCacheEntry,
  DedupInFlightEntry,
} from "./sessionDedup.js";
import { GrantCache, type GrantLifecycleEmitter } from "./grantCache.js";

export interface SessionStoreOptions {
  /**
   * Lifecycle emitter wired through to the {@link GrantCache} so audit
   * entries and renderer broadcasts fire for every `issued`/`expired`/
   * `revoked` transition. Optional so the bare `new SessionStore(...)`
   * test fixture path still constructs without an emitter (the cache
   * defaults to silent).
   */
  emitGrantLifecycle?: GrantLifecycleEmitter;
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
  readonly resourceSubscriptions = new Map<string, Map<string, () => void>>();
  // Per-session idempotency dedup state for the MCP creation-tool allowlist.
  // Two phases: in-flight singleflight (same-moment duplicates share the
  // original Promise) and TTL'd result cache (post-completion duplicates
  // return the original result). Cleared on drain and idle expiry.
  readonly dedupInFlight = new Map<string, Map<string, DedupInFlightEntry>>();
  readonly dedupResultCache = new Map<string, Map<string, DedupCacheEntry>>();
  /**
   * Per-`(sessionId, toolId)` time-bounded grants — replaces the sticky
   * `sessionTierMap` elevation pathway for the "Approve once" flow (#8442).
   * Co-located with the other session-scoped maps so a single drain or
   * idle-timer firing tears them down in lockstep.
   */
  readonly grantCache: GrantCache;

  private readonly cleanupResourceSubscriptionsFn: (sessionId: string) => void;

  constructor(
    cleanupResourceSubscriptions: (sessionId: string) => void,
    options: SessionStoreOptions = {}
  ) {
    this.cleanupResourceSubscriptionsFn = cleanupResourceSubscriptions;
    this.grantCache = new GrantCache({ emit: options.emitGrantLifecycle });
  }

  clearDedupState(sessionId: string): void {
    this.dedupInFlight.delete(sessionId);
    this.dedupResultCache.delete(sessionId);
  }

  createIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
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
      this.clearDedupState(sessionId);
      this.cleanupResourceSubscriptionsFn(sessionId);
      session.transport.close().catch(() => {
        // ignore close errors during idle timeout cleanup
      });
    }, MCP_SSE_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  resetIdleTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createIdleTimer(sessionId);
  }

  createHttpIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const session = this.httpSessions.get(sessionId);
      if (!session) return;
      this.httpSessions.delete(sessionId);
      this.sessionTierMap.delete(sessionId);
      // Revoke BEFORE deleting the WebContents pin — same reasoning
      // as `createIdleTimer` above.
      this.grantCache.revokeSession(sessionId, "session-idle");
      this.sessionWebContentsMap.delete(sessionId);
      this.sessionContextMap.delete(sessionId);
      this.clearDedupState(sessionId);
      this.cleanupResourceSubscriptionsFn(sessionId);
      session.transport.close().catch(() => {
        // ignore close errors during idle timeout cleanup
      });
    }, MCP_SSE_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  resetHttpIdleTimer(sessionId: string): void {
    const session = this.httpSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createHttpIdleTimer(sessionId);
  }

  getTier(sessionId: string): McpTier {
    return this.sessionTierMap.get(sessionId) ?? "workbench";
  }

  drain(): void {
    // Clear dedup state up-front so an in-flight `.finally()` resolving
    // after drain finds no session to write back into and does not
    // resurrect a torn-down session's cache.
    this.dedupInFlight.clear();
    this.dedupResultCache.clear();

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
    this.sessionTierMap.clear();
    this.sessionWebContentsMap.clear();
    this.sessionContextMap.clear();
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
