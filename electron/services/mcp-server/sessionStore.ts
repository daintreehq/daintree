import type { McpTier, McpSseSession, McpHttpSession } from "./shared.js";
import { MCP_SSE_IDLE_TIMEOUT_MS } from "./shared.js";

export class SessionStore {
  readonly sessions = new Map<string, McpSseSession>();
  readonly httpSessions = new Map<string, McpHttpSession>();
  readonly sessionTierMap = new Map<string, McpTier>();
  readonly resourceSubscriptions = new Map<string, Map<string, () => void>>();

  private readonly cleanupResourceSubscriptionsFn: (sessionId: string) => void;

  constructor(cleanupResourceSubscriptions: (sessionId: string) => void) {
    this.cleanupResourceSubscriptionsFn = cleanupResourceSubscriptions;
  }

  createIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      this.sessions.delete(sessionId);
      this.sessionTierMap.delete(sessionId);
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

  drain(rejectReason: string): void {
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
