import type {
  PtyHostEvent,
  TerminalFlowStatus,
  TerminalReliabilityMetricPayload,
  PtyHostActivityTier,
} from "../../shared/types/pty-host.js";
import type { PtyPauseCoordinator } from "./PtyPauseCoordinator.js";

export const MAX_PACKET_PAYLOAD = 65535;
// FUTURE_SAB: These caps are in bytes and bound the memory consumed by in-flight
// Uint8Array payloads queued for the SharedArrayBuffer ring buffer path.
// Currently unreachable in production — the SAB transport path is disabled
// (SharedArrayBuffer is not supported in Electron UtilityProcess). The caps
// are preserved as a skeleton for a potential Worker-thread migration that
// could revive the SAB zero-copy data path.
//
// The Uint8Array byte length closely approximates the actual memory footprint
// of these payloads. VS Code uses char-based flow control because its IPC
// routes through string-based JSON-RPC; copying that approach here would
// misrepresent the resource being protected.
export const FUTURE_SAB_MAX_PENDING_BYTES_PER_TERMINAL = 4 * 1024 * 1024;
export const FUTURE_SAB_MAX_TOTAL_PENDING_BYTES = 16 * 1024 * 1024;
export const BACKPRESSURE_SAFETY_TIMEOUT_MS = 10000;

export type PendingVisualSegment = {
  data: Uint8Array;
  offset: number;
};

export interface BackpressureStats {
  pauseCount: number;
  resumeCount: number;
  suspendCount: number;
  forceResumeCount: number;
}

export interface BackpressureDeps {
  getTerminal: (
    id: string
  ) => { ptyProcess?: { pause: () => void; resume: () => void } } | undefined;
  getPauseCoordinator: (id: string) => PtyPauseCoordinator | undefined;
  sendEvent: (event: PtyHostEvent) => void;
  metricsEnabled: () => boolean;
  /**
   * Optional override for the canonical reliability-metric funnel. When
   * supplied, internal `pause-start` / `pause-end` / `suspend` emissions
   * route through this dep (so the host can update its per-source
   * pause-tracking map before the wire event fires). When omitted, the
   * internal default just sends the wire event (legacy behavior).
   */
  emitReliabilityMetric?: (payload: TerminalReliabilityMetricPayload, forceEmit?: boolean) => void;
}

export class BackpressureManager {
  readonly stats: BackpressureStats = {
    pauseCount: 0,
    resumeCount: 0,
    suspendCount: 0,
    forceResumeCount: 0,
  };

  private readonly pausedTerminals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pauseStartTimes = new Map<string, number>();
  private readonly terminalStatuses = new Map<string, TerminalFlowStatus>();
  private readonly terminalActivityTiers = new Map<string, PtyHostActivityTier>();
  private readonly suspendedDueToStall = new Set<string>();
  private readonly pendingVisualSegments = new Map<string, PendingVisualSegment[]>();
  private readonly pendingVisualBytes = new Map<string, number>();
  private totalPendingVisualBytes = 0;

  constructor(private readonly deps: BackpressureDeps) {}

  get pausedTerminalsMap(): Map<string, ReturnType<typeof setInterval>> {
    return this.pausedTerminals;
  }

  get pauseStartTimesMap(): Map<string, number> {
    return this.pauseStartTimes;
  }

  get terminalStatusesMap(): Map<string, TerminalFlowStatus> {
    return this.terminalStatuses;
  }

  get terminalActivityTiersMap(): Map<string, PtyHostActivityTier> {
    return this.terminalActivityTiers;
  }

  get suspendedSet(): Set<string> {
    return this.suspendedDueToStall;
  }

  get pendingSegmentsMap(): Map<string, PendingVisualSegment[]> {
    return this.pendingVisualSegments;
  }

  getPauseStartTime(id: string): number | undefined {
    return this.pauseStartTimes.get(id);
  }

  setPauseStartTime(id: string, time: number): void {
    this.pauseStartTimes.set(id, time);
  }

  deletePauseStartTime(id: string): void {
    this.pauseStartTimes.delete(id);
  }

  getPausedInterval(id: string): ReturnType<typeof setInterval> | undefined {
    return this.pausedTerminals.get(id);
  }

  setPausedInterval(id: string, interval: ReturnType<typeof setInterval>): void {
    this.pausedTerminals.set(id, interval);
  }

  deletePausedInterval(id: string): void {
    this.pausedTerminals.delete(id);
  }

  isPaused(id: string): boolean {
    return this.pausedTerminals.has(id);
  }

  isSuspended(id: string): boolean {
    return this.suspendedDueToStall.has(id);
  }

  setSuspended(id: string): void {
    this.suspendedDueToStall.add(id);
  }

  clearSuspended(id: string): void {
    this.suspendedDueToStall.delete(id);
  }

  getActivityTier(id: string): PtyHostActivityTier {
    return this.terminalActivityTiers.get(id) ?? "active";
  }

  setActivityTier(id: string, tier: PtyHostActivityTier, reason?: string): void {
    const from = this.getActivityTier(id);
    if (from === tier) return;
    this.terminalActivityTiers.set(id, tier);

    if (!this.deps.metricsEnabled()) return;
    // Best-effort observability: a throwing sendEvent (detached MessagePort
    // during a shutdown race) must never abort functional tier application in
    // the callers (clearSuspended/clearPendingVisual/setActivityMonitorTier/
    // tier-changed broadcast all run after this method returns).
    try {
      const heldTokens = Array.from(this.deps.getPauseCoordinator(id)?.heldTokens ?? []).sort();
      this.emitReliabilityMetric({
        terminalId: id,
        metricType: "tier-transition",
        timestamp: Date.now(),
        tierTransitionFrom: from,
        tierTransitionTo: tier,
        tierTransitionReason: reason,
        tierTransitionHeldTokens: heldTokens,
      });
    } catch {
      // Metric emission is non-critical — the tier map is already updated.
    }
  }

  pendingBytesRemaining(segment: PendingVisualSegment): number {
    return Math.max(0, segment.data.length - segment.offset);
  }

  enqueuePendingSegment(id: string, segment: PendingVisualSegment): boolean {
    const remaining = this.pendingBytesRemaining(segment);
    if (remaining <= 0) {
      return true;
    }

    const current = this.pendingVisualBytes.get(id) ?? 0;
    const nextTerminal = current + remaining;
    const nextTotal = this.totalPendingVisualBytes + remaining;

    if (
      nextTerminal > FUTURE_SAB_MAX_PENDING_BYTES_PER_TERMINAL ||
      nextTotal > FUTURE_SAB_MAX_TOTAL_PENDING_BYTES
    ) {
      return false;
    }

    const queue = this.pendingVisualSegments.get(id) ?? [];
    queue.push(segment);
    this.pendingVisualSegments.set(id, queue);
    this.pendingVisualBytes.set(id, nextTerminal);
    this.totalPendingVisualBytes = nextTotal;
    return true;
  }

  consumePendingBytes(id: string, bytes: number): void {
    if (bytes <= 0) return;
    const current = this.pendingVisualBytes.get(id);
    if (current === undefined) return;
    const next = current - bytes;
    if (next <= 0) {
      this.pendingVisualBytes.delete(id);
    } else {
      this.pendingVisualBytes.set(id, next);
    }
    this.totalPendingVisualBytes = Math.max(0, this.totalPendingVisualBytes - bytes);
  }

  clearPendingVisual(id: string): void {
    const pendingBytes = this.pendingVisualBytes.get(id);
    if (pendingBytes !== undefined) {
      this.totalPendingVisualBytes = Math.max(0, this.totalPendingVisualBytes - pendingBytes);
      this.pendingVisualBytes.delete(id);
    }
    this.pendingVisualSegments.delete(id);
  }

  hasPendingSegments(id: string): boolean {
    return this.pendingVisualSegments.has(id);
  }

  getPendingSegments(id: string): PendingVisualSegment[] | undefined {
    return this.pendingVisualSegments.get(id);
  }

  emitTerminalStatus(
    id: string,
    status: TerminalFlowStatus,
    bufferUtilization?: number,
    pauseDuration?: number,
    reason?: string,
    timestamp?: number
  ): void {
    const previousStatus = this.terminalStatuses.get(id);
    if (previousStatus === status) {
      return;
    }
    this.terminalStatuses.set(id, status);
    this.deps.sendEvent({
      type: "terminal-status",
      id,
      status,
      bufferUtilization,
      pauseDuration,
      reason,
      timestamp: timestamp ?? Date.now(),
    });
  }

  emitReliabilityMetric(payload: TerminalReliabilityMetricPayload, forceEmit = false): void {
    if (this.deps.emitReliabilityMetric) {
      // Route through the host-supplied funnel so per-source pause
      // tracking (held-duration map) stays in sync with wire emissions.
      this.deps.emitReliabilityMetric(payload, forceEmit);
      return;
    }
    // Legacy default: just emit the wire event. The funnel dep is the
    // canonical path; this branch is kept only for tests/embedders that
    // construct BackpressureManager without supplying one.
    if (!forceEmit && !this.deps.metricsEnabled()) return;
    this.deps.sendEvent({
      type: "terminal-reliability-metric",
      payload,
    });
  }

  getPendingBytesSnapshot(): {
    totalPendingBytes: number;
    perTerminal: Array<{ terminalId: string; pendingBytes: number }>;
  } {
    const perTerminal: Array<{ terminalId: string; pendingBytes: number }> = [];
    for (const [id, bytes] of this.pendingVisualBytes) {
      perTerminal.push({ terminalId: id, pendingBytes: bytes });
    }
    return { totalPendingBytes: this.totalPendingVisualBytes, perTerminal };
  }

  // FUTURE_SAB: the only producer of the `suspended` `flowStatus`. This
  // method is reachable only via the `visualBuffers.length > 0` branch in
  // `electron/pty-host.ts:669`/`:726`, which the disabled SAB transport
  // path never enters in production (PR #7724 / issue #7653). The
  // renderer-side `Suspended` pill (`TerminalHeaderContent.tsx`), a11y
  // formatter (`useAccessibilityAnnouncements.ts`), and the lifecycle
  // listener's wake branch (`lifecycle.ts`) are all marked with // FUTURE_SAB:
  // annotations and treated as forward-looking code; see #9900.
  suspendVisualStream(
    id: string,
    reason: string,
    utilization?: number,
    pauseDuration?: number,
    shardIndex?: number
  ): void {
    const coordinator = this.deps.getPauseCoordinator(id);
    if (coordinator) {
      coordinator.resume("backpressure");
    }

    const checkInterval = this.pausedTerminals.get(id);
    if (checkInterval) {
      clearTimeout(checkInterval);
      this.pausedTerminals.delete(id);
    }
    this.pauseStartTimes.delete(id);

    this.suspendedDueToStall.add(id);
    this.stats.suspendCount++;
    this.clearPendingVisual(id);

    this.emitTerminalStatus(id, "suspended", utilization, pauseDuration, reason);

    if (utilization !== undefined) {
      console.warn(
        `[PtyHost] Suspended streaming for ${id} (${reason}) (buffer ${utilization.toFixed(1)}%).`
      );
    } else {
      console.warn(`[PtyHost] Suspended streaming for ${id} (${reason}).`);
    }

    this.emitReliabilityMetric(
      {
        terminalId: id,
        metricType: "suspend",
        timestamp: Date.now(),
        durationMs: pauseDuration,
        bufferUtilization: utilization,
        shardIndex,
      },
      true
    );
  }

  cleanupTerminal(id: string): void {
    const checkInterval = this.pausedTerminals.get(id);
    if (checkInterval) {
      clearTimeout(checkInterval);
      this.pausedTerminals.delete(id);
    }
    this.pauseStartTimes.delete(id);
    this.terminalStatuses.delete(id);
    this.terminalActivityTiers.delete(id);
    this.suspendedDueToStall.delete(id);
    this.clearPendingVisual(id);
  }

  dispose(): void {
    for (const [id, checkInterval] of this.pausedTerminals) {
      clearTimeout(checkInterval);
      console.log(`[PtyHost] Cleared backpressure monitor for terminal ${id}`);
    }
    this.pausedTerminals.clear();
    this.pauseStartTimes.clear();
    this.terminalStatuses.clear();
    this.terminalActivityTiers.clear();
    this.suspendedDueToStall.clear();
    this.pendingVisualSegments.clear();
    this.pendingVisualBytes.clear();
    this.totalPendingVisualBytes = 0;
  }
}
