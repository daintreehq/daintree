import { randomUUID } from "node:crypto";

export interface ContinuationContext {
  plan?: string;
  lastToolCalls?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface Continuation {
  id: string;
  sessionId: string;
  listenerId: string;
  resumePrompt: string;
  context: ContinuationContext;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STALE_WARNING_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const STALE_CHECK_INTERVAL_MS = 60 * 1000; // Check every 1 minute

export class ContinuationManager {
  private continuations = new Map<string, Continuation>();
  private listenerToContinuation = new Map<string, string>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private staleCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanupInterval();
    // Stale warning check starts lazily when first continuation is added
  }

  create(
    sessionId: string,
    listenerId: string,
    resumePrompt: string,
    context: ContinuationContext = {},
    expirationMs: number = DEFAULT_EXPIRATION_MS
  ): Continuation {
    // Remove any existing continuation for this listener
    const existingId = this.listenerToContinuation.get(listenerId);
    if (existingId) {
      this.continuations.delete(existingId);
    }

    const id = randomUUID();
    const now = Date.now();

    const continuation: Continuation = {
      id,
      sessionId,
      listenerId,
      resumePrompt,
      context,
      createdAt: now,
      expiresAt: now + expirationMs,
    };

    this.continuations.set(id, continuation);
    this.listenerToContinuation.set(listenerId, id);

    // Start stale warning check when first continuation is added
    if (this.continuations.size === 1) {
      this.startStaleWarningCheck();
    }

    return continuation;
  }

  get(id: string): Continuation | undefined {
    const continuation = this.continuations.get(id);
    if (continuation && this.isExpired(continuation)) {
      this.remove(id);
      return undefined;
    }
    return continuation;
  }

  getByListenerId(listenerId: string): Continuation | undefined {
    const id = this.listenerToContinuation.get(listenerId);
    if (!id) {
      return undefined;
    }
    return this.get(id);
  }

  remove(id: string): boolean {
    const continuation = this.continuations.get(id);
    if (continuation) {
      this.listenerToContinuation.delete(continuation.listenerId);
      this.continuations.delete(id);

      // Stop stale warning check if no continuations remain
      if (this.continuations.size === 0) {
        this.stopStaleWarningCheck();
      }

      return true;
    }
    return false;
  }

  removeByListenerId(listenerId: string): boolean {
    const id = this.listenerToContinuation.get(listenerId);
    if (id) {
      return this.remove(id);
    }
    return false;
  }

  listForSession(sessionId: string): Continuation[] {
    const result: Continuation[] = [];
    for (const continuation of this.continuations.values()) {
      if (continuation.sessionId === sessionId && !this.isExpired(continuation)) {
        result.push(continuation);
      }
    }
    return result;
  }

  clearSession(sessionId: string): number {
    const toRemove: string[] = [];
    for (const continuation of this.continuations.values()) {
      if (continuation.sessionId === sessionId) {
        toRemove.push(continuation.id);
      }
    }

    for (const id of toRemove) {
      this.remove(id);
    }

    // Stop stale warning check if no continuations remain after session clear
    if (this.continuations.size === 0) {
      this.stopStaleWarningCheck();
    }

    if (toRemove.length > 0) {
      console.log(
        `[ContinuationManager] Cleared ${toRemove.length} continuation(s) for session ${sessionId}`
      );
    }

    return toRemove.length;
  }

  clearExpired(): number {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const continuation of this.continuations.values()) {
      if (continuation.expiresAt <= now) {
        toRemove.push(continuation.id);
      }
    }

    for (const id of toRemove) {
      this.remove(id);
    }

    if (toRemove.length > 0) {
      console.log(`[ContinuationManager] Cleared ${toRemove.length} expired continuation(s)`);
    }

    return toRemove.length;
  }

  clearAll(): number {
    const count = this.continuations.size;
    this.continuations.clear();
    this.listenerToContinuation.clear();

    // Stop stale warning check when all continuations are cleared
    this.stopStaleWarningCheck();

    if (count > 0) {
      console.log(`[ContinuationManager] Cleared all ${count} continuation(s)`);
    }

    return count;
  }

  size(): number {
    return this.continuations.size;
  }

  private isExpired(continuation: Continuation): boolean {
    return Date.now() >= continuation.expiresAt;
  }

  private startCleanupInterval(): void {
    if (this.cleanupInterval) {
      return;
    }
    this.cleanupInterval = setInterval(() => {
      this.clearExpired();
    }, CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    this.cleanupInterval.unref();
  }

  detectStaleContinuations(): void {
    const now = Date.now();
    const staleContinuations: Array<{
      id: string;
      listenerId: string;
      ageMinutes: number;
      sessionId: string;
    }> = [];

    for (const continuation of this.continuations.values()) {
      const age = now - continuation.createdAt;
      if (age > STALE_WARNING_THRESHOLD_MS) {
        staleContinuations.push({
          id: continuation.id.substring(0, 8),
          listenerId: continuation.listenerId.substring(0, 8),
          ageMinutes: Math.round(age / 60000),
          sessionId: continuation.sessionId.substring(0, 8),
        });
      }
    }

    if (staleContinuations.length > 0) {
      // Truncate list to first 10 to avoid excessive log size
      const logContinuations = staleContinuations.slice(0, 10);
      const truncated = staleContinuations.length > 10;
      console.warn(
        `[ContinuationManager] Stale autoResume continuation(s) detected (waiting >5 min)`,
        JSON.stringify({
          count: staleContinuations.length,
          continuations: logContinuations,
          ...(truncated && { truncated: `+${staleContinuations.length - 10} more` }),
        })
      );
    }
  }

  private startStaleWarningCheck(): void {
    if (this.staleCheckInterval) {
      return;
    }
    this.staleCheckInterval = setInterval(() => {
      this.detectStaleContinuations();
    }, STALE_CHECK_INTERVAL_MS);

    // Don't prevent process exit
    this.staleCheckInterval.unref();
  }

  private stopStaleWarningCheck(): void {
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }
    this.clearAll();
  }
}

export const continuationManager = new ContinuationManager();
