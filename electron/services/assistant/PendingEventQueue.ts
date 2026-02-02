import { randomUUID } from "node:crypto";

export interface PendingEvent {
  id: string;
  sessionId: string;
  listenerId: string;
  eventType: string;
  data: unknown;
  timestamp: number;
  acknowledged: boolean;
}

const MAX_EVENTS_PER_SESSION = 100;

export class PendingEventQueue {
  private events = new Map<string, PendingEvent>();
  private sessionEventIds = new Map<string, Set<string>>();

  push(sessionId: string, listenerId: string, eventType: string, data: unknown): PendingEvent {
    const event: PendingEvent = {
      id: randomUUID(),
      sessionId,
      listenerId,
      eventType,
      data,
      timestamp: Date.now(),
      acknowledged: false,
    };

    // Ensure session tracking exists
    let sessionIds = this.sessionEventIds.get(sessionId);
    if (!sessionIds) {
      sessionIds = new Set();
      this.sessionEventIds.set(sessionId, sessionIds);
    }

    // FIFO eviction if at capacity - prefer evicting acknowledged events
    if (sessionIds.size >= MAX_EVENTS_PER_SESSION) {
      // First try to evict oldest acknowledged event
      const oldestAcknowledged = this.getOldestAcknowledged(sessionId);
      if (oldestAcknowledged) {
        this.events.delete(oldestAcknowledged.id);
        sessionIds.delete(oldestAcknowledged.id);
      } else {
        // Fall back to evicting oldest unacknowledged event
        const oldestUnacknowledged = this.getOldestUnacknowledged(sessionId);
        if (oldestUnacknowledged) {
          this.events.delete(oldestUnacknowledged.id);
          sessionIds.delete(oldestUnacknowledged.id);
        }
      }
    }

    this.events.set(event.id, event);
    sessionIds.add(event.id);

    return event;
  }

  getPending(sessionId: string): PendingEvent[] {
    const sessionIds = this.sessionEventIds.get(sessionId);
    if (!sessionIds) {
      return [];
    }

    const result: PendingEvent[] = [];
    for (const eventId of sessionIds) {
      const event = this.events.get(eventId);
      if (event && !event.acknowledged) {
        result.push(event);
      }
    }

    // Sort by timestamp ascending (oldest first)
    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  getAll(sessionId: string): PendingEvent[] {
    const sessionIds = this.sessionEventIds.get(sessionId);
    if (!sessionIds) {
      return [];
    }

    const result: PendingEvent[] = [];
    for (const eventId of sessionIds) {
      const event = this.events.get(eventId);
      if (event) {
        result.push(event);
      }
    }

    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  acknowledge(eventId: string, sessionId?: string): boolean {
    const event = this.events.get(eventId);
    if (!event) {
      return false;
    }

    // Enforce session ownership if sessionId is provided
    if (sessionId && event.sessionId !== sessionId) {
      return false;
    }

    event.acknowledged = true;
    return true;
  }

  acknowledgeAll(sessionId: string): number {
    const pending = this.getPending(sessionId);
    for (const event of pending) {
      event.acknowledged = true;
    }
    return pending.length;
  }

  clearSession(sessionId: string): number {
    const sessionIds = this.sessionEventIds.get(sessionId);
    if (!sessionIds) {
      return 0;
    }

    const count = sessionIds.size;
    for (const eventId of sessionIds) {
      this.events.delete(eventId);
    }
    this.sessionEventIds.delete(sessionId);

    if (count > 0) {
      console.log(`[PendingEventQueue] Cleared ${count} event(s) for session ${sessionId}`);
    }

    return count;
  }

  clearAll(): number {
    const count = this.events.size;
    this.events.clear();
    this.sessionEventIds.clear();

    if (count > 0) {
      console.log(`[PendingEventQueue] Cleared all ${count} event(s) across all sessions`);
    }

    return count;
  }

  countPending(sessionId: string): number {
    return this.getPending(sessionId).length;
  }

  countAll(sessionId: string): number {
    const sessionIds = this.sessionEventIds.get(sessionId);
    return sessionIds?.size ?? 0;
  }

  private getOldestUnacknowledged(sessionId: string): PendingEvent | null {
    const pending = this.getPending(sessionId);
    return pending.length > 0 ? pending[0] : null;
  }

  private getOldestAcknowledged(sessionId: string): PendingEvent | null {
    const sessionIds = this.sessionEventIds.get(sessionId);
    if (!sessionIds) {
      return null;
    }

    let oldest: PendingEvent | null = null;
    for (const eventId of sessionIds) {
      const event = this.events.get(eventId);
      if (event && event.acknowledged) {
        if (!oldest || event.timestamp < oldest.timestamp) {
          oldest = event;
        }
      }
    }

    return oldest;
  }
}

export const pendingEventQueue = new PendingEventQueue();
