import {
  events,
  ALL_EVENT_TYPES,
  type CanopyEventMap,
  EVENT_META,
  getEventCategory,
} from "./events.js";
import type { EventRecord, EventCategory } from "../../shared/types/index.js";

export type { EventRecord };

export interface FilterOptions {
  types?: Array<keyof CanopyEventMap>;
  category?: EventCategory;
  categories?: EventCategory[];
  worktreeId?: string;
  agentId?: string;
  taskId?: string;
  runId?: string;
  terminalId?: string;
  issueNumber?: number;
  prNumber?: number;
  traceId?: string;
  search?: string;
  after?: number;
  before?: number;
}

export class EventBuffer {
  private buffer: EventRecord[] = [];
  private maxSize: number;
  private unsubscribe?: () => void;
  private onRecordCallbacks: Array<(record: EventRecord) => void> = [];

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  public onRecord(callback: (record: EventRecord) => void): () => void {
    this.onRecordCallbacks.push(callback);
    return () => {
      const index = this.onRecordCallbacks.indexOf(callback);
      if (index !== -1) {
        this.onRecordCallbacks.splice(index, 1);
      }
    };
  }

  private sanitizePayload(eventType: keyof CanopyEventMap, payload: any): any {
    const sensitiveEventTypes: Array<keyof CanopyEventMap> = ["agent:output", "task:created"];

    if (!sensitiveEventTypes.includes(eventType)) {
      return payload;
    }

    if (eventType === "agent:output" && payload && typeof payload.data === "string") {
      return {
        ...payload,
        data: "[REDACTED - May contain sensitive information]",
      };
    }

    if (eventType === "task:created" && payload && typeof payload.description === "string") {
      return {
        ...payload,
        description: "[REDACTED - May contain sensitive information]",
      };
    }

    return payload;
  }

  private validatePayload(eventType: keyof CanopyEventMap, payload: any): void {
    const meta = EVENT_META[eventType];
    if (!meta) {
      return;
    }

    if (meta.requiresTimestamp && (!payload || typeof payload.timestamp !== "number")) {
      console.warn(`[EventBuffer] Event ${eventType} missing required timestamp`, {
        hasPayload: !!payload,
        timestampType: payload ? typeof payload.timestamp : "undefined",
      });
    }

    if (meta.requiresContext && payload) {
      const hasContext =
        payload.worktreeId ||
        payload.agentId ||
        payload.taskId ||
        payload.terminalId ||
        payload.issueNumber ||
        payload.prNumber;
      if (!hasContext) {
        console.warn(`[EventBuffer] Event ${eventType} missing required context fields`, {
          eventType,
          availableFields: Object.keys(payload).filter((k) => payload[k] !== undefined),
        });
      }
    }
  }

  start(): void {
    if (this.unsubscribe) {
      console.warn("[EventBuffer] Already started");
      return;
    }

    const unsubscribers: Array<() => void> = [];

    for (const eventType of ALL_EVENT_TYPES) {
      const unsub = events.on(
        eventType as any,
        ((payload: any) => {
          this.validatePayload(eventType, payload);

          const eventTimestamp =
            payload && typeof payload.timestamp === "number" ? payload.timestamp : Date.now();

          this.push({
            id: this.generateId(),
            timestamp: eventTimestamp,
            type: eventType,
            category: getEventCategory(eventType),
            payload: this.sanitizePayload(eventType, payload),
            source: "main",
          });
        }) as any
      );
      unsubscribers.push(unsub);
    }

    this.unsubscribe = () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private push(event: EventRecord): void {
    this.buffer.push(event);

    for (const callback of [...this.onRecordCallbacks]) {
      try {
        callback(event);
      } catch (error) {
        console.error("[EventBuffer] Error in onRecord callback:", error);
      }
    }

    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getAll(): EventRecord[] {
    return [...this.buffer];
  }

  getFiltered(options: FilterOptions): EventRecord[] {
    let filtered = this.buffer;

    if (options.types && options.types.length > 0) {
      filtered = filtered.filter((event) =>
        options.types!.includes(event.type as keyof CanopyEventMap)
      );
    }

    if (options.category) {
      filtered = filtered.filter((event) => event.category === options.category);
    }

    if (options.categories && options.categories.length > 0) {
      filtered = filtered.filter((event) => options.categories!.includes(event.category));
    }

    if (options.after !== undefined) {
      filtered = filtered.filter((event) => event.timestamp >= options.after!);
    }
    if (options.before !== undefined) {
      filtered = filtered.filter((event) => event.timestamp <= options.before!);
    }

    if (options.worktreeId) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.worktreeId === options.worktreeId;
      });
    }

    if (options.agentId) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.agentId === options.agentId;
      });
    }

    if (options.taskId) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.taskId === options.taskId;
      });
    }

    if (options.runId) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.runId === options.runId;
      });
    }

    if (options.terminalId) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.terminalId === options.terminalId;
      });
    }

    if (options.issueNumber !== undefined) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.issueNumber === options.issueNumber;
      });
    }

    if (options.prNumber !== undefined) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.prNumber === options.prNumber;
      });
    }

    if (options.traceId) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.traceId === options.traceId;
      });
    }

    if (options.search) {
      const searchLower = options.search.toLowerCase();
      filtered = filtered.filter((event) => {
        if (event.type.toLowerCase().includes(searchLower)) {
          return true;
        }
        try {
          const payloadStr = JSON.stringify(event.payload).toLowerCase();
          return payloadStr.includes(searchLower);
        } catch {
          return false;
        }
      });
    }

    return filtered;
  }

  clear(): void {
    this.buffer = [];
  }

  onProjectSwitch(): void {
    console.log("Handling project switch in EventBuffer - clearing events");
    this.clear();
  }

  size(): number {
    return this.buffer.length;
  }

  getEventsByCategory(category: EventCategory): EventRecord[] {
    return this.buffer.filter((event) => event.category === category);
  }

  getCategoryStats(): Record<EventCategory, number> {
    const stats: Record<EventCategory, number> = {
      system: 0,
      agent: 0,
      task: 0,
      server: 0,
      file: 0,
      ui: 0,
      watcher: 0,
      artifact: 0,
    };

    for (const event of this.buffer) {
      if (event.category in stats) {
        stats[event.category]++;
      }
    }

    return stats;
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
