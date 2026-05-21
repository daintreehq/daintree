import type {
  ActionBreadcrumb,
  ActionBreadcrumbSource,
} from "../../shared/types/ipc/crashRecovery.js";
import type { ActionDanger } from "../../shared/types/actions.js";
import { events } from "./events.js";
import type { TypedEventBus } from "./events.js";
import { addActionBreadcrumb } from "./TelemetryService.js";

const MAX_RING = 50;
const DEDUP_WINDOW_MS = 250;

const PRIORITY: Record<ActionDanger, number> = {
  safe: 0,
  confirm: 1,
  restricted: 2,
};

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Main-process ring buffer of recent action dispatches. Feeds Sentry
 * breadcrumbs and the `recentActions` field on crash log entries.
 *
 * Lives in main so the ring survives renderer crashes — which is exactly
 * the scenario action breadcrumbs are designed to diagnose. Renderer-side
 * storage would be lost at the moment it was needed most.
 */
export class ActionBreadcrumbService {
  private ring: ActionBreadcrumb[] = [];
  private lastEntry: ActionBreadcrumb | null = null;
  private unsubscribe: (() => void) | null = null;

  initialize(bus: TypedEventBus = events): void {
    if (this.unsubscribe) return;
    this.unsubscribe = bus.on("action:dispatched", (payload) => {
      this.handleDispatched(payload);
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ring = [];
    this.lastEntry = null;
  }

  getRecentActions(): ActionBreadcrumb[] {
    return this.ring.map((entry) => ({
      ...entry,
      ...(entry.args ? { args: { ...entry.args } } : {}),
    }));
  }

  private handleDispatched(payload: {
    actionId: string;
    source: ActionBreadcrumbSource;
    timestamp: number;
    category: string;
    durationMs: number;
    danger: ActionDanger;
    safeArgs?: Record<string, unknown>;
    confirmed?: boolean;
  }): void {
    try {
      const last = this.lastEntry;
      const delta = last === null ? Infinity : payload.timestamp - last.timestamp;
      // Reject negative deltas so an out-of-order emission (a long-running dispatch
      // that started earlier but finishes later) is recorded as a distinct entry
      // rather than merged into a newer fast dispatch of the same actionId.
      // Also split entries with different confirmed values — merging different
      // consent states obscures forensic signal in crash diagnostics.
      const isDedup =
        last !== null &&
        last.actionId === payload.actionId &&
        last.confirmed === payload.confirmed &&
        delta >= 0 &&
        delta <= DEDUP_WINDOW_MS;

      if (isDedup && last) {
        last.count += 1;
        last.durationMs = payload.durationMs;
        last.timestamp = payload.timestamp;
        addActionBreadcrumb({ ...last });
        return;
      }

      const entry: ActionBreadcrumb = {
        id: createId(),
        actionId: payload.actionId,
        category: payload.category,
        source: payload.source,
        durationMs: payload.durationMs,
        timestamp: payload.timestamp,
        danger: payload.danger,
        ...(payload.safeArgs ? { args: payload.safeArgs } : {}),
        count: 1,
        ...(payload.confirmed !== undefined ? { confirmed: payload.confirmed } : {}),
      };

      this.ring.push(entry);
      if (this.ring.length > MAX_RING) {
        this.evictOne(payload.danger);
      }
      this.lastEntry = entry;
      addActionBreadcrumb({ ...entry });
    } catch (err) {
      console.warn("[ActionBreadcrumb] Failed to handle dispatched event:", err);
    }
  }

  private evictOne(incomingDanger: ActionDanger): void {
    const incomingPrio = PRIORITY[incomingDanger];

    // Scan for the newest (highest-index) entry with strictly lower priority.
    // Evicting the newest low-priority entry preserves older forensic context
    // while making room for the high-signal incoming entry.
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (PRIORITY[this.ring[i]!.danger] < incomingPrio) {
        this.ring.splice(i, 1);
        return;
      }
    }

    // No lower-priority entries. If all existing entries (excluding the one
    // just pushed) have strictly higher priority, drop the incoming entry.
    const existingRing = this.ring.slice(0, -1);
    const allExistingHigher = existingRing.every((e) => PRIORITY[e.danger] > incomingPrio);
    if (allExistingHigher) {
      this.ring.pop();
      return;
    }

    const hasHigher = existingRing.some((e) => PRIORITY[e.danger] > incomingPrio);
    if (hasHigher) {
      // Mixed ring: evict the newest same-tier entry so higher-priority
      // entries are never displaced. Search excludes the just-pushed entry.
      for (let i = this.ring.length - 2; i >= 0; i--) {
        if (PRIORITY[this.ring[i]!.danger] === incomingPrio) {
          this.ring.splice(i, 1);
          return;
        }
      }
      // Defensive: no same-tier entry found — drop incoming.
      this.ring.pop();
      return;
    }

    // All entries are the same priority as incoming — standard FIFO.
    this.ring.shift();
  }

  _resetForTest(): void {
    this.dispose();
    this.ring = [];
    this.lastEntry = null;
  }
}

let instance: ActionBreadcrumbService | null = null;

export function getActionBreadcrumbService(): ActionBreadcrumbService {
  if (!instance) {
    instance = new ActionBreadcrumbService();
  }
  return instance;
}

export function _resetActionBreadcrumbServiceForTest(): void {
  instance?._resetForTest();
  instance = null;
}
