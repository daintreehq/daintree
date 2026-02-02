import { randomUUID } from "node:crypto";
import type { Listener, ListenerFilter } from "../../../shared/types/listener.js";
import { RegisterListenerOptionsSchema } from "../../../shared/types/listener.js";

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

export class ListenerManager {
  private listeners = new Map<string, Listener>();

  register(sessionId: string, eventType: string, filter?: ListenerFilter, once?: boolean): string {
    const validation = RegisterListenerOptionsSchema.safeParse({
      sessionId,
      eventType,
      filter,
      once,
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
      createdAt: Date.now(),
    };
    this.listeners.set(id, listener);
    return id;
  }

  unregister(listenerId: string): boolean {
    const deleted = this.listeners.delete(listenerId);
    if (deleted) {
      listenerWaiter.cancel(listenerId, "listener_removed");
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
    if (count > 0) {
      console.log(`[ListenerManager] Cleared all ${count} listener(s) across all sessions`);
    }
    return count;
  }

  getMatchingListeners(eventType: string, data: unknown): Listener[] {
    const result: Listener[] = [];
    for (const listener of this.listeners.values()) {
      if (listener.eventType !== eventType) {
        continue;
      }
      if (this.matchesFilter(listener.filter, data)) {
        result.push(listener);
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
}

export const listenerManager = new ListenerManager();
export const listenerWaiter = new ListenerWaiter();
