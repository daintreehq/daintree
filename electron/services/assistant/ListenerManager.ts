import { randomUUID } from "node:crypto";
import type { Listener, ListenerFilter } from "../../../shared/types/listener.js";
import { RegisterListenerOptionsSchema } from "../../../shared/types/listener.js";

export class ListenerManager {
  private listeners = new Map<string, Listener>();

  register(sessionId: string, eventType: string, filter?: ListenerFilter): string {
    const validation = RegisterListenerOptionsSchema.safeParse({
      sessionId,
      eventType,
      filter,
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
      createdAt: Date.now(),
    };
    this.listeners.set(id, listener);
    return id;
  }

  unregister(listenerId: string): boolean {
    return this.listeners.delete(listenerId);
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

  clearSession(sessionId: string): void {
    const toRemove: string[] = [];
    for (const listener of this.listeners.values()) {
      if (listener.sessionId === sessionId) {
        toRemove.push(listener.id);
      }
    }
    for (const id of toRemove) {
      this.listeners.delete(id);
    }
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
