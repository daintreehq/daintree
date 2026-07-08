/**
 * HostSignalAggregator - OR-aggregation of process-scoped PTY host signals
 * (`host-throttled`, `host-memory-warning`) across every live shard.
 *
 * Consumers of these events treat the payload as THE terminal backend's
 * state, so with multiple shards a healthy sibling's release must not clear
 * a struggling shard's warning — this aggregates the per-shard booleans and
 * only forwards a transition when the aggregate actually flips. Extracted
 * verbatim from PtyClient.ts (#11007) — no behavior changes.
 */

import type { HostThrottlePayload } from "../../../shared/types/pty-host.js";

/** Payload shape the event router emits for `host-memory-warning`. */
export interface HostMemoryWarningPayload {
  isWarning: boolean;
  utilizationPercent: number;
  heapMb?: number;
  externalMb?: number;
  workerHeapMb?: number;
  workerExternalMb?: number;
  timestamp: number;
}

export interface HostSignalAggregatorDeps {
  emit: (event: string, payload: unknown) => boolean;
}

export class HostSignalAggregator {
  private readonly throttledShards = new Set<string>();
  private aggregateThrottled = false;
  private readonly memoryWarningShards = new Set<string>();
  private aggregateMemoryWarning = false;

  constructor(private readonly deps: HostSignalAggregatorDeps) {}

  recordThrottle(shardKey: string, payload: HostThrottlePayload): boolean {
    if (payload.isThrottled) {
      this.throttledShards.add(shardKey);
    } else {
      this.throttledShards.delete(shardKey);
    }
    const aggregate = this.throttledShards.size > 0;
    if (aggregate === this.aggregateThrottled) return false;
    this.aggregateThrottled = aggregate;
    return this.deps.emit("host-throttled", { ...payload, isThrottled: aggregate });
  }

  recordMemoryWarning(shardKey: string, payload: HostMemoryWarningPayload): boolean {
    if (payload.isWarning) {
      this.memoryWarningShards.add(shardKey);
    } else {
      this.memoryWarningShards.delete(shardKey);
    }
    const aggregate = this.memoryWarningShards.size > 0;
    if (aggregate === this.aggregateMemoryWarning) return false;
    this.aggregateMemoryWarning = aggregate;
    return this.deps.emit("host-memory-warning", { ...payload, isWarning: aggregate });
  }

  /**
   * Drop a departed shard's attribution from the aggregated signals and emit
   * the release edge if the aggregate flipped — a retired/crashed shard must
   * not pin "throttled"/"memory warning" on forever.
   */
  dropShard(shardKey: string): void {
    if (this.throttledShards.delete(shardKey)) {
      const aggregate = this.throttledShards.size > 0;
      if (aggregate !== this.aggregateThrottled) {
        this.aggregateThrottled = aggregate;
        this.deps.emit("host-throttled", {
          isThrottled: aggregate,
          reason: "host-shard-gone",
          timestamp: Date.now(),
        });
      }
    }
    if (this.memoryWarningShards.delete(shardKey)) {
      const aggregate = this.memoryWarningShards.size > 0;
      if (aggregate !== this.aggregateMemoryWarning) {
        this.aggregateMemoryWarning = aggregate;
        this.deps.emit("host-memory-warning", {
          isWarning: aggregate,
          utilizationPercent: 0,
          timestamp: Date.now(),
        });
      }
    }
  }

  /** Reset all aggregation state — called from PtyClient.dispose(). */
  clear(): void {
    this.throttledShards.clear();
    this.memoryWarningShards.clear();
  }
}
