import { randomUUID } from "node:crypto";
import type {
  Listener,
  ListenerFilter,
  AutoResumeOptions,
} from "../../../shared/types/listener.js";
import { RegisterListenerOptionsSchema } from "../../../shared/types/listener.js";
import { continuationManager } from "./ContinuationManager.js";

export interface ListenerEvent {
  listenerId: string;
  eventType: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface Waiter {
  resolve: (event: ListenerEvent) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  startTime: number;
}

export class ListenerWaiter {
  private waiters = new Map<string, Waiter & { sessionId: string }>();

  wait(listenerId: string, timeoutMs: number, sessionId: string): Promise<ListenerEvent> {
    if (this.waiters.has(listenerId)) {
      return Promise.reject(new Error("already_awaiting"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(listenerId);
        reject(new Error("timeout"));
      }, timeoutMs);

      this.waiters.set(listenerId, {
        resolve,
        reject,
        timeout,
        startTime: Date.now(),
        sessionId,
      });
    });
  }

  notify(listenerId: string, event: ListenerEvent): boolean {
    const waiter = this.waiters.get(listenerId);
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
      this.waiters.delete(listenerId);
      return true;
    }
    return false;
  }

  cancel(listenerId: string, reason: string): void {
    const waiter = this.waiters.get(listenerId);
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(reason));
      this.waiters.delete(listenerId);
    }
  }

  cancelAll(reason: string): void {
    for (const [listenerId] of this.waiters) {
      this.cancel(listenerId, reason);
    }
  }

  cancelForSession(sessionId: string, reason: string): number {
    let count = 0;
    for (const [listenerId, waiter] of this.waiters) {
      if (waiter.sessionId === sessionId) {
        this.cancel(listenerId, reason);
        count++;
      }
    }
    return count;
  }

  isAwaiting(listenerId: string): boolean {
    return this.waiters.has(listenerId);
  }

  getWaitedMs(listenerId: string): number {
    const waiter = this.waiters.get(listenerId);
    if (!waiter) {
      return 0;
    }
    return Date.now() - waiter.startTime;
  }
}

const STALE_LISTENER_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const STALE_CHECK_INTERVAL_MS = 60 * 1000; // Check every 1 minute

export class ListenerManager {
  private listeners = new Map<string, Listener>();
  private staleCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startStaleListenerCheck();
  }

  register(
    sessionId: string,
    eventType: string,
    filter?: ListenerFilter,
    once?: boolean,
    autoResume?: AutoResumeOptions
  ): string {
    const validation = RegisterListenerOptionsSchema.safeParse({
      sessionId,
      eventType,
      filter,
      once,
      autoResume,
    });

    if (!validation.success) {
      throw new Error(`Invalid listener registration: ${validation.error.message}`);
    }

    const id = randomUUID();
    const listener: Listener = {
      id,
      sessionId,
      eventType,
      filter,
      once,
      autoResume,
      createdAt: Date.now(),
    };
    this.listeners.set(id, listener);

    // Create continuation if autoResume is specified
    if (autoResume) {
      continuationManager.create(sessionId, id, autoResume.prompt, autoResume.context || {});
    }

    return id;
  }

  unregister(listenerId: string): boolean {
    const deleted = this.listeners.delete(listenerId);
    if (deleted) {
      listenerWaiter.cancel(listenerId, "listener_removed");
      continuationManager.removeByListenerId(listenerId);
    }
    return deleted;
  }

  get(listenerId: string): Listener | undefined {
    return this.listeners.get(listenerId);
  }

  listForSession(sessionId: string): Listener[] {
    const result: Listener[] = [];
    for (const listener of this.listeners.values()) {
      if (listener.sessionId === sessionId) {
        result.push(listener);
      }
    }
    return result;
  }

  countForSession(sessionId: string): number {
    let count = 0;
    for (const listener of this.listeners.values()) {
      if (listener.sessionId === sessionId) {
        count++;
      }
    }
    return count;
  }

  clearSession(sessionId: string): number {
    const toRemove: string[] = [];
    for (const listener of this.listeners.values()) {
      if (listener.sessionId === sessionId) {
        toRemove.push(listener.id);
      }
    }
    for (const id of toRemove) {
      this.listeners.delete(id);
    }
    listenerWaiter.cancelForSession(sessionId, "session_cleared");
    continuationManager.clearSession(sessionId);
    if (toRemove.length > 0) {
      console.log(
        `[ListenerManager] Cleared ${toRemove.length} listener(s) for session ${sessionId}`
      );
    }
    return toRemove.length;
  }

  clearAllSessions(): number {
    const count = this.listeners.size;
    this.listeners.clear();
    listenerWaiter.cancelAll("all_sessions_cleared");
    continuationManager.clearAll();
    if (count > 0) {
      console.log(`[ListenerManager] Cleared all ${count} listener(s) across all sessions`);
    }
    return count;
  }

  getMatchingListeners(eventType: string, data: unknown): Listener[] {
    const result: Listener[] = [];
    const allListeners = Array.from(this.listeners.values());

    for (const listener of allListeners) {
      if (listener.eventType !== eventType) {
        continue;
      }
      if (this.matchesFilter(listener.filter, data)) {
        result.push(listener);
      }
    }

    // Log diagnostic when no listeners match but listeners exist for this event type
    if (result.length === 0 && allListeners.length > 0) {
      const listenersForEventType = allListeners.filter((l) => l.eventType === eventType);
      if (listenersForEventType.length > 0) {
        const isObject = typeof data === "object" && data !== null;
        const dataRecord = isObject ? (data as Record<string, unknown>) : null;

        // Build diagnostic payload with filter key comparisons
        const diagnosticPayload: any = {
          dataType: typeof data,
          isObject,
        };

        if (dataRecord) {
          // Extract common filter keys for comparison
          const filterKeys = new Set<string>();
          listenersForEventType.forEach((l) => {
            if (l.filter) {
              Object.keys(l.filter).forEach((k) => filterKeys.add(k));
            }
          });

          // Show event data for the filter keys that exist
          diagnosticPayload.eventData = {};
          filterKeys.forEach((key) => {
            if (key in dataRecord) {
              diagnosticPayload.eventData[key] = dataRecord[key];
            }
          });

          diagnosticPayload.activeListeners = listenersForEventType.map((l) => ({
            id: l.id.substring(0, 8),
            filter: l.filter,
            autoResume: !!l.autoResume,
            sessionId: l.sessionId.substring(0, 8),
          }));
        } else {
          // Non-object data - just show listener count
          diagnosticPayload.listenerCount = listenersForEventType.length;
        }

        console.warn(
          `[ListenerManager] No listeners matched ${eventType} event`,
          JSON.stringify(diagnosticPayload)
        );
      }
    }

    return result;
  }

  private matchesFilter(filter: ListenerFilter, data: unknown): boolean {
    if (!filter || Object.keys(filter).length === 0) {
      return true;
    }

    if (typeof data !== "object" || data === null) {
      return false;
    }

    const dataRecord = data as Record<string, unknown>;
    for (const [key, value] of Object.entries(filter)) {
      if (!Object.prototype.hasOwnProperty.call(dataRecord, key)) {
        return false;
      }
      if (!Object.is(dataRecord[key], value)) {
        return false;
      }
    }
    return true;
  }

  size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }

  detectStaleListeners(): void {
    const now = Date.now();
    const staleListeners: Array<{
      id: string;
      eventType: string;
      filter: unknown;
      ageMinutes: number;
      sessionId: string;
      lastWarned?: number;
    }> = [];

    for (const listener of this.listeners.values()) {
      const age = now - listener.createdAt;
      if (age > STALE_LISTENER_THRESHOLD_MS && listener.autoResume) {
        // Check if we've warned about this listener recently (within last 5 minutes)
        const lastWarned = (listener as any).lastStaleWarning || 0;
        const timeSinceLastWarning = now - lastWarned;

        // Only warn if this is the first time crossing threshold or it's been 5+ minutes since last warning
        if (timeSinceLastWarning >= STALE_LISTENER_THRESHOLD_MS) {
          staleListeners.push({
            id: listener.id.substring(0, 8),
            eventType: listener.eventType,
            filter: listener.filter,
            ageMinutes: Math.round(age / 60000),
            sessionId: listener.sessionId.substring(0, 8),
          });
          // Mark that we've warned about this listener
          (listener as any).lastStaleWarning = now;
        }
      }
    }

    if (staleListeners.length > 0) {
      // Truncate list if too large to avoid log spam
      const logListeners = staleListeners.slice(0, 10);
      const truncated = staleListeners.length > 10;
      console.warn(
        `[ListenerManager] Stale autoResume listener(s) detected (waiting >5 min)`,
        JSON.stringify({
          count: staleListeners.length,
          listeners: logListeners,
          ...(truncated && { truncated: `+${staleListeners.length - 10} more` }),
        })
      );
    }
  }

  private startStaleListenerCheck(): void {
    if (this.staleCheckInterval) {
      return;
    }
    this.staleCheckInterval = setInterval(() => {
      this.detectStaleListeners();
    }, STALE_CHECK_INTERVAL_MS);

    // Don't prevent process exit
    this.staleCheckInterval.unref();
  }

  destroy(): void {
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }
    this.clear();
  }
}

export const listenerManager = new ListenerManager();
export const listenerWaiter = new ListenerWaiter();
