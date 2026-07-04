import type { AgentState } from "../../shared/types/agent.js";
import type {
  PtyHostEvent,
  ResourceGovernorSnapshot,
  TerminalFlowStatus,
} from "../../shared/types/pty-host.js";
import type { ResourceProfile } from "../../shared/types/resourceProfile.js";
import { SCROLLBACK_MIN } from "../../shared/config/scrollback.js";
import {
  PRESSURE_MAX_PRESERVED_TERMINAL_SNAPSHOTS,
  TERMINAL_RETENTION_BUDGETS,
  type TerminalRetentionTier,
} from "../../shared/config/terminalRetention.js";
import { FdMonitor } from "./FdMonitor.js";
import { metricsEnabled } from "./metrics.js";
import type { PtyPauseCoordinator } from "./PtyPauseCoordinator.js";

export interface TerminalActivityInfo {
  id: string;
  lastOutputTime: number;
  lastInputTime: number;
  agentState?: AgentState;
}

export interface ResourceGovernorDeps {
  getTerminalIds: () => string[];
  getPauseCoordinator: (id: string) => PtyPauseCoordinator | undefined;
  getTerminalCount: () => number;
  incrementPauseCount: (count: number) => void;
  sendEvent: (event: PtyHostEvent) => void;
  emitTerminalStatus: (
    id: string,
    status: TerminalFlowStatus,
    bufferUtilization?: number,
    pauseDuration?: number,
    reason?: string
  ) => void;
  getTerminalActivity: () => TerminalActivityInfo[];
  trimBuffers?: () => void;
  /**
   * Per-terminal scrollback dimensions for memory-aware ranking and targeted
   * trimming. `scrollbackLines × cols × 12` is the cheap closed-form estimate of
   * each terminal's headless-buffer footprint (3 uint32s per cell). Read at the
   * metric tick; never serializes a buffer. `tier` (when stamped by the
   * retention coordinator) makes the targeted trim state-aware: foreground
   * terminals are exempt until critical pressure and each tier trims to its
   * own retention floor instead of the uniform SCROLLBACK_MIN.
   */
  getTerminalBufferSizes?: () => Array<{
    id: string;
    scrollbackLines: number;
    cols: number;
    tier?: TerminalRetentionTier;
  }>;
  /**
   * Prune preserved exit snapshots down to `max` under memory pressure.
   * Preserved snapshots are pure retained memory with no live producer —
   * the safest reclaim, run before any live-terminal trim.
   */
  prunePreservedSnapshots?: (max: number) => void;
  /**
   * Targeted pre-pause reclaim: trim each listed terminal's scrollback to its
   * mapped target-line count (heaviest contributors trimmed hardest). Replaces the
   * uniform `trimBuffers` flatten in the non-critical pre-pause path so lighter
   * terminals keep their history. Best-effort per terminal; never throws to caller.
   */
  trimBuffersTargeted?: (targetsByTerminalId: Map<string, number>) => void;
  getPendingBytesSnapshot?: () => {
    totalPendingBytes: number;
    perTerminal: Array<{ terminalId: string; pendingBytes: number }>;
  };
  getThroughputSnapshot?: () => {
    timestamp: number;
    totalBytes: number;
    totalPackets: number;
    perTerminal: Array<{ terminalId: string; byteCount: number; packetCount: number }>;
    pauseCount: number;
  } | null;
  /**
   * Per-paused-terminal held duration snapshot, aggregated across SAB, IPC,
   * and per-window MessagePort pause sources via a closure-scoped map in
   * pty-host.ts. `heldDurationMs` is sampled at the metric tick.
   */
  getPausedDurationsSnapshot?: () => Array<{
    terminalId: string;
    heldDurationMs: number;
  }>;
  /**
   * Per-terminal queue depth for the live IPC + per-window MessagePort
   * paths. Excludes the FUTURE_SAB path (dead in production). Each entry
   * is tagged with the path `layer` so consumers can attribute bytes per
   * transport.
   */
  getQueueDepthSnapshot?: () => Array<{
    terminalId: string;
    layer: "ipc" | "port";
    pendingBytes: number;
  }>;
  /**
   * Data-loss counter snapshot. Returns accumulated drop-event count and
   * dropped bytes since the last call. Counter is unconditional in
   * pty-host.ts (gated only by drop site entry); this emission is gated
   * separately by `metricsEnabled()`. Reset semantics: snapshot-and-reset.
   */
  getDropSnapshot?: () => {
    droppedBytesDelta: number;
    dataLossCountDelta: number;
  };
}

// Process memory budget for the combined heap + external signal. The pty-host
// is forked with --max-old-space-size matching PtyClient's DEFAULT_CONFIG
// memoryLimitMb (512) — keep HEAP_BUDGET_MB in sync with it. That flag bounds
// only the V8 heap; ArrayBuffer backing stores (queued PTY output slabs,
// xterm typed arrays) are allocated outside it and show up in
// process.memoryUsage().external, so the governor budgets them separately.
const HEAP_BUDGET_MB = 512;
const EXTERNAL_HEADROOM_MB = 256;
const TOTAL_PROCESS_BUDGET_MB = HEAP_BUDGET_MB + EXTERNAL_HEADROOM_MB;

export class ResourceGovernor {
  private readonly MEMORY_LIMIT_PERCENT = 85;
  private readonly RESUME_THRESHOLD_PERCENT = 60;
  private readonly FORCE_RESUME_MS = 10000;
  private readonly CHECK_INTERVAL_MS = 2000;
  private readonly WARNING_THRESHOLD_PERCENT = 70;
  private readonly WARNING_CLEAR_PERCENT = 65;
  private readonly CRITICAL_PERCENT = 95;
  private readonly EFFICIENCY_MEMORY_LIMIT_PERCENT = 70;
  private readonly EFFICIENCY_RESUME_PERCENT = 50;
  private readonly EFFICIENCY_WARNING_PERCENT = 55;
  private readonly EFFICIENCY_WARNING_CLEAR_PERCENT = 45;
  // EMA: α = 2/(N+1) for an N-tick window. At 2s polls, N=10 gives a ~20s
  // smoothing window that rejects single-tick GC sawtooth spikes while
  // detecting sustained pressure within 4–5 ticks.
  private readonly EMA_ALPHA = 2 / 11;
  // Suppress engage during EMA warmup so a startup heap spike doesn't trigger
  // before the smoothed signal has had time to stabilize.
  private readonly WARMUP_TICKS = 5;
  // After a force-resume (bounded-pause guarantee fires), block re-engagement
  // for this long even if pressure persists. Prevents the pause(10s)/resume(2s)
  // flap that issue #8616 reports — terminals keep running (possibly slowly
  // under OS-level backpressure) rather than getting repeatedly hard-paused.
  private readonly REENGAGE_COOLDOWN_MS = 30000;
  // Bytes per headless-buffer cell: xterm stores 3 uint32s per cell (codepoint +
  // fg attr + bg attr). `scrollbackLines × cols × BYTES_PER_CELL` is the cheap
  // closed-form estimate used to rank per-terminal buffer-memory contribution.
  private readonly BYTES_PER_CELL = 12;
  private isThrottling = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private throttleStartTime = 0;
  private readonly fdMonitor: FdMonitor;
  private readonly killedPids = new Map<number, number>();
  private readonly ORPHAN_GRACE_MS = 4000;
  private hasThroughputBaseline = false;
  private prevPauseCount = 0;
  private readonly pausedTerminalIds = new Set<string>();
  private isWarning = false;
  private profileOverride: ResourceProfile | null = null;
  private smoothedUtilizationPercent: number | undefined = undefined;
  private sampleCount = 0;
  private lastDisengageAt = 0;
  // Tracks whether buffer trimming has been attempted for the current pressure
  // episode. Trim is a one-shot pre-pause reclaim — re-trimming on every tick
  // would thrash scrollback without freeing additional heap.
  private trimAttemptedForCurrentPressure = false;

  constructor(private readonly deps: ResourceGovernorDeps) {
    this.fdMonitor = new FdMonitor();
  }

  start(): void {
    this.checkInterval = setInterval(() => this.checkResources(), this.CHECK_INTERVAL_MS);
    console.log("[ResourceGovernor] Started monitoring memory usage");
    if (this.fdMonitor.supported) {
      console.log("[ResourceGovernor] FD monitoring enabled");
    }
  }

  trackKilledPid(pid: number): void {
    this.killedPids.set(pid, Date.now());
  }

  /**
   * Point-in-time governor state for the on-demand flow-control diagnostics
   * snapshot. `smoothedUtilizationPercent` is passed through as null during EMA
   * warmup (it starts undefined for ~5 ticks; see #8660) rather than coerced to
   * 0, so consumers can distinguish "not yet warmed up" from "0% heap used".
   */
  getSnapshot(): ResourceGovernorSnapshot {
    return {
      isThrottling: this.isThrottling,
      isWarning: this.isWarning,
      activeProfile: this.profileOverride ?? "balanced",
      smoothedUtilizationPercent: this.smoothedUtilizationPercent ?? null,
      throttleDurationMs: this.isThrottling ? Date.now() - this.throttleStartTime : 0,
    };
  }

  setResourceProfile(profile: ResourceProfile): void {
    this.profileOverride = profile;
    if (profile === "efficiency") {
      console.log(
        `[ResourceGovernor] Efficiency profile active — lowering thresholds ` +
          `(throttle: ${this.EFFICIENCY_MEMORY_LIMIT_PERCENT}%, ` +
          `warning: ${this.EFFICIENCY_WARNING_PERCENT}%)`
      );
    } else {
      console.log(`[ResourceGovernor] Profile set to ${profile} — using default thresholds`);
    }
  }

  private get memoryLimitPercent(): number {
    return this.profileOverride === "efficiency"
      ? this.EFFICIENCY_MEMORY_LIMIT_PERCENT
      : this.MEMORY_LIMIT_PERCENT;
  }

  private get resumeThresholdPercent(): number {
    return this.profileOverride === "efficiency"
      ? this.EFFICIENCY_RESUME_PERCENT
      : this.RESUME_THRESHOLD_PERCENT;
  }

  private get warningThresholdPercent(): number {
    return this.profileOverride === "efficiency"
      ? this.EFFICIENCY_WARNING_PERCENT
      : this.WARNING_THRESHOLD_PERCENT;
  }

  private get warningClearPercent(): number {
    return this.profileOverride === "efficiency"
      ? this.EFFICIENCY_WARNING_CLEAR_PERCENT
      : this.WARNING_CLEAR_PERCENT;
  }

  private checkResources(): void {
    const memory = process.memoryUsage();
    const heapUsedMb = memory.heapUsed / 1024 / 1024;
    // `external` already includes all ArrayBuffer/Buffer backing stores —
    // memory.arrayBuffers is a subset of it, so adding it would double-count.
    const externalMb = (memory.external ?? 0) / 1024 / 1024;
    // Combined signal: V8 heap + external. Heap-only was blind to the memory
    // this governor actually manages — queued PTY output and xterm backing
    // stores live in external, outside the --max-old-space-size cap (#9905).
    const combinedMb = heapUsedMb + externalMb;
    // Utilization is the binding constraint: heap against its own V8 cap AND
    // combined against the total process budget. The combined ratio alone can
    // never reach the engage thresholds on pure heap pressure — heap is capped
    // at HEAP_BUDGET_MB, only ~67% of the total budget — so a runaway JS heap
    // must be measured against its own ceiling. max() keeps this a single
    // continuous signal feeding one EMA, and the disengage hysteresis then
    // requires BOTH ratios to clear the resume threshold.
    const utilizationPercent =
      Math.max(combinedMb / TOTAL_PROCESS_BUDGET_MB, heapUsedMb / HEAP_BUDGET_MB) * 100;

    // EMA smoothing — rejects single-tick GC sawtooth spikes. Seeded with the
    // first real reading (not 0) to avoid a warmup ramp that falsely stays
    // below threshold. Mirrors the hasThroughputBaseline seeding idiom used
    // by the throughput gauge.
    let smoothedPercent: number;
    if (this.smoothedUtilizationPercent === undefined) {
      this.smoothedUtilizationPercent = utilizationPercent;
      smoothedPercent = utilizationPercent;
    } else {
      smoothedPercent =
        this.EMA_ALPHA * utilizationPercent +
        (1 - this.EMA_ALPHA) * this.smoothedUtilizationPercent;
      this.smoothedUtilizationPercent = smoothedPercent;
    }
    this.sampleCount++;

    // Warning band uses raw utilization — it's an advisory signal, not a
    // throttle decision, so smoothing would only introduce unhelpful lag.
    const warnThreshold = this.warningThresholdPercent;
    const warnClear = this.warningClearPercent;
    if (!this.isWarning && utilizationPercent > warnThreshold) {
      this.isWarning = true;
      console.warn(
        `[ResourceGovernor] Memory warning: ${utilizationPercent.toFixed(1)}% of process budget ` +
          `(heap ${Math.round(heapUsedMb)}MB + external ${Math.round(externalMb)}MB, ` +
          `threshold: ${warnThreshold}%).`
      );
      this.deps.sendEvent({
        type: "host-memory-warning",
        isWarning: true,
        utilizationPercent: Math.round(utilizationPercent),
        heapMb: Math.round(heapUsedMb),
        externalMb: Math.round(externalMb),
        timestamp: Date.now(),
      });
    } else if (this.isWarning && utilizationPercent < warnClear) {
      this.isWarning = false;
      console.log(
        `[ResourceGovernor] Memory warning cleared: ${utilizationPercent.toFixed(1)}% of process budget ` +
          `(heap ${Math.round(heapUsedMb)}MB + external ${Math.round(externalMb)}MB).`
      );
      this.deps.sendEvent({
        type: "host-memory-warning",
        isWarning: false,
        utilizationPercent: Math.round(utilizationPercent),
        heapMb: Math.round(heapUsedMb),
        externalMb: Math.round(externalMb),
        timestamp: Date.now(),
      });
    }

    const limitPercent = this.memoryLimitPercent;
    const resumePercent = this.resumeThresholdPercent;
    // Critical pressure bypasses smoothing and the cooldown gate — if raw
    // utilization is at 95%+, the next allocation could OOM the process,
    // so engage immediately regardless of EMA warmup or recent disengage.
    const isCritical = utilizationPercent >= this.CRITICAL_PERCENT;

    if (!this.isThrottling) {
      const warmedUp = this.sampleCount >= this.WARMUP_TICKS;
      const cooledDown = Date.now() - this.lastDisengageAt > this.REENGAGE_COOLDOWN_MS;
      const aboveThreshold = smoothedPercent > limitPercent;

      if (isCritical || (aboveThreshold && warmedUp && cooledDown)) {
        const canTrim =
          !isCritical &&
          !this.trimAttemptedForCurrentPressure &&
          (this.deps.trimBuffersTargeted != null || this.deps.trimBuffers != null);
        if (canTrim) {
          // Trim first as a one-shot reclaim — drops JS references synchronously
          // so the next GC can collect old-gen scrollback strings and ArrayBuffer
          // backing stores. Neither heapUsed nor external drops in this tick (GC
          // hasn't run yet) so we wait one tick before escalating to pause.
          // Best-effort: a failure shouldn't block the eventual pause path. At
          // critical pressure (≥95%) this branch is skipped entirely — the global
          // pause runs immediately.
          this.performPrePauseTrim(utilizationPercent, smoothedPercent);
          this.trimAttemptedForCurrentPressure = true;
        } else {
          this.engageThrottle(combinedMb, utilizationPercent);
        }
      } else if (!aboveThreshold && this.trimAttemptedForCurrentPressure) {
        // Pressure cleared after trim but before engage — preserve the
        // "one-shot per pressure episode" contract by re-arming the flag so
        // a fresh episode can trim again.
        this.trimAttemptedForCurrentPressure = false;
      }
    } else {
      const throttleDuration = Date.now() - this.throttleStartTime;
      const maxPauseExceeded = throttleDuration > this.FORCE_RESUME_MS;
      // Disengage uses RAW utilization (not smoothed) so terminals resume
      // promptly when pressure truly clears. The 85→60% hysteresis band plus
      // the REENGAGE_COOLDOWN_MS gate prevent any oscillation risk from a
      // single-tick low reading triggering an early resume.
      const belowThreshold = utilizationPercent < resumePercent;

      if (maxPauseExceeded || belowThreshold) {
        this.disengageThrottle(combinedMb, utilizationPercent, maxPauseExceeded);
      }
    }

    this.checkFdUsage();
    this.emitPendingBytesGauge();
    this.emitThroughputRateGauge();
    this.emitPausedDurationGauge();
    this.emitQueueDepthGauge();
    this.emitDataLossCount();
    this.emitBufferMemoryGauge();
  }

  /** Retention floor a pressure trim may take a terminal down to. Untiered
   * entries (retention coordinator not wired / not yet swept) keep the legacy
   * uniform SCROLLBACK_MIN floor. */
  private pressureFloorFor(tier: TerminalRetentionTier | undefined): number {
    return tier ? TERMINAL_RETENTION_BUDGETS[tier].pressureMirrorFloorLines : SCROLLBACK_MIN;
  }

  /**
   * Pre-pause buffer reclaim. Prunes preserved exit snapshots first (pure
   * retained memory), then prefers the targeted trim path — heaviest
   * contributor first, each terminal trimmed to its retention tier's pressure
   * floor, and foreground (visible/focused active) terminals exempt; those are
   * only touched by the critical-pressure emergency trim. Falls back to the
   * uniform flatten when buffer-size attribution isn't wired (or the targeted
   * call throws). Pure reclaim: no pause, no governor state mutation. Caller
   * owns the one-shot `trimAttemptedForCurrentPressure`.
   */
  private performPrePauseTrim(rawPercent: number, smoothedPercent: number): void {
    try {
      this.deps.prunePreservedSnapshots?.(PRESSURE_MAX_PRESERVED_TERMINAL_SNAPSHOTS);
    } catch (err) {
      console.warn("[ResourceGovernor] preserved-snapshot prune failed:", err);
    }

    if (this.deps.trimBuffersTargeted && this.deps.getTerminalBufferSizes) {
      try {
        const sizes = this.deps.getTerminalBufferSizes();
        // Heaviest-first so the Map's insertion order (and the log) leads with
        // the biggest contributor.
        const targets = new Map<string, number>();
        for (const t of sizes
          .filter((s) => s.tier !== "foreground")
          .filter((s) => s.scrollbackLines > this.pressureFloorFor(s.tier))
          .sort(
            (a, b) =>
              b.scrollbackLines * b.cols * this.BYTES_PER_CELL -
              a.scrollbackLines * a.cols * this.BYTES_PER_CELL
          )) {
          targets.set(t.id, this.pressureFloorFor(t.tier));
        }
        if (targets.size > 0) {
          this.deps.trimBuffersTargeted(targets);
          console.log(
            `[ResourceGovernor] Targeted pre-pause trim of ${targets.size} heaviest buffer(s) ` +
              `(${rawPercent.toFixed(1)}% raw, ${smoothedPercent.toFixed(1)}% smoothed).`
          );
        }
        return;
      } catch (err) {
        // Do NOT fall back to the uniform flatten here: it would trim
        // foreground terminals at non-critical pressure, breaking the
        // retention exemption. Reclaim is lost for this tick only — if
        // pressure persists, the next tick escalates to the global pause,
        // which reliably stops growth without destroying any history.
        console.warn("[ResourceGovernor] targeted trim failed; skipping reclaim this tick:", err);
        return;
      }
    }

    if (this.deps.trimBuffers) {
      try {
        this.deps.trimBuffers();
        console.log(
          `[ResourceGovernor] Trimmed buffers as pre-pause reclaim ` +
            `(${rawPercent.toFixed(1)}% raw, ${smoothedPercent.toFixed(1)}% smoothed).`
        );
      } catch (err) {
        console.warn("[ResourceGovernor] trimBuffers failed:", err);
      }
    }
  }

  /**
   * Critical-pressure emergency reclaim, run AFTER the immediate global pause
   * (the pause must not wait on anything at ≥95%). Unlike the pre-pause trim,
   * this includes foreground terminals — at critical pressure the next
   * allocation could OOM the host, which is strictly worse for the visible
   * terminal than losing mirror history it can regrow. Best-effort; never
   * throws to the pause path.
   */
  private performCriticalTrim(): void {
    try {
      this.deps.prunePreservedSnapshots?.(PRESSURE_MAX_PRESERVED_TERMINAL_SNAPSHOTS);
      if (!this.deps.trimBuffersTargeted || !this.deps.getTerminalBufferSizes) return;
      const targets = new Map<string, number>();
      for (const t of this.deps
        .getTerminalBufferSizes()
        .filter((s) => s.scrollbackLines > this.pressureFloorFor(s.tier))
        .sort(
          (a, b) =>
            b.scrollbackLines * b.cols * this.BYTES_PER_CELL -
            a.scrollbackLines * a.cols * this.BYTES_PER_CELL
        )) {
        targets.set(t.id, this.pressureFloorFor(t.tier));
      }
      if (targets.size > 0) {
        this.deps.trimBuffersTargeted(targets);
        console.log(
          `[ResourceGovernor] Critical-pressure emergency trim of ${targets.size} buffer(s) after global pause.`
        );
      }
    } catch (err) {
      console.warn("[ResourceGovernor] critical-pressure trim failed:", err);
    }
  }

  /**
   * Advisory per-terminal buffer-memory attribution. Emits every warning-band
   * tick (matching the other persistent-state gauges) so operators can see which
   * terminals drive scrollback memory under sustained pressure. PURE observability
   * — it must never trim or mutate governor state; all reclaim lives in
   * `performPrePauseTrim`, gated by the one-shot flag.
   */
  private emitBufferMemoryGauge(): void {
    if (!metricsEnabled()) return;
    if (!this.isWarning) return;
    if (!this.deps.getTerminalBufferSizes) return;

    const sizes = this.deps.getTerminalBufferSizes();
    if (sizes.length === 0) return;

    const perTerminalBufferMemory = sizes
      .map((t) => ({
        terminalId: t.id,
        scrollbackEstimateBytes: t.scrollbackLines * t.cols * this.BYTES_PER_CELL,
        scrollbackLines: t.scrollbackLines,
        cols: t.cols,
      }))
      .sort((a, b) => b.scrollbackEstimateBytes - a.scrollbackEstimateBytes);

    const estimatedBufferMemoryBytes = perTerminalBufferMemory.reduce(
      (sum, t) => sum + t.scrollbackEstimateBytes,
      0
    );

    this.deps.sendEvent({
      type: "terminal-reliability-metric",
      payload: {
        terminalId: "resource-governor",
        metricType: "buffer-memory-gauge",
        timestamp: Date.now(),
        estimatedBufferMemoryBytes,
        perTerminalBufferMemory,
      },
    });
  }

  private checkFdUsage(): void {
    const now = Date.now();

    // Collect orphan candidates: PIDs killed long enough ago to have exited.
    // Runs unconditionally — `killedPids` is populated on every platform via
    // `trackKilledPid`, but FD monitoring is unsupported on Windows. Gating the
    // sweep behind `fdMonitor.supported` (as before) leaked the map there until
    // `dispose()`; prune first, then bail out of the FD-leak check (#10842).
    const orphanCandidates: number[] = [];
    for (const [pid, killedAt] of this.killedPids) {
      if (now - killedAt > this.ORPHAN_GRACE_MS) {
        orphanCandidates.push(pid);
        this.killedPids.delete(pid);
      }
    }

    if (!this.fdMonitor.supported) return;

    const result = this.fdMonitor.checkForLeaks(this.deps.getTerminalCount(), orphanCandidates);

    if (metricsEnabled()) {
      console.log(
        `[ResourceGovernor] FDs: ${result.totalFds} total, ` +
          `~${result.estimatedTerminalFds} terminal-related, ` +
          `${result.activeTerminals} active terminals` +
          (result.ptmxLimit != null ? `, ptmx limit: ${result.ptmxLimit}` : "")
      );
    }

    // Log orphaned PIDs (killed but still alive after grace period)
    if (result.orphanedPids.length > 0) {
      console.warn(
        `[ResourceGovernor] Orphaned PTY PIDs detected (killed but still alive): ${result.orphanedPids.join(", ")}`
      );
    }

    if (result.isWarning) {
      console.warn(
        `[ResourceGovernor] FD leak warning: ${result.totalFds} open FDs ` +
          `(baseline: ${result.baselineFds}, ~${result.estimatedTerminalFds} terminal-related) ` +
          `with only ${result.activeTerminals} active terminals`
      );

      this.deps.sendEvent({
        type: "fd-leak-warning",
        fdCount: result.totalFds,
        activeTerminals: result.activeTerminals,
        estimatedLeaked: Math.max(0, result.estimatedTerminalFds - result.activeTerminals),
        orphanedPids: result.orphanedPids,
        ptmxLimit: result.ptmxLimit,
        timestamp: now,
      });
    }
  }

  private emitPendingBytesGauge(): void {
    if (!metricsEnabled()) return;
    if (!this.deps.getPendingBytesSnapshot) return;

    const snapshot = this.deps.getPendingBytesSnapshot();
    if (snapshot.totalPendingBytes <= 0) return;

    this.deps.sendEvent({
      type: "terminal-reliability-metric",
      payload: {
        terminalId: "resource-governor",
        metricType: "pending-bytes-gauge",
        timestamp: Date.now(),
        totalPendingBytes: snapshot.totalPendingBytes,
        perTerminal: snapshot.perTerminal,
      },
    });
  }

  private emitThroughputRateGauge(): void {
    if (!metricsEnabled()) return;
    if (!this.deps.getThroughputSnapshot) return;

    const snapshot = this.deps.getThroughputSnapshot();
    if (!snapshot) return;

    // First non-null snapshot seeds the pause baseline without emitting.
    // Throughput snapshots are already bounded by the fixed poll interval
    // (the accumulator in pty-host.ts is reset on every tick), so we don't
    // need a timestamp baseline to compute the rate.
    if (!this.hasThroughputBaseline) {
      this.hasThroughputBaseline = true;
      this.prevPauseCount = snapshot.pauseCount;
      return;
    }

    // Always track pauseCount baseline on sampled ticks so zero-byte
    // windows don't get misattributed to the next byte-producing tick.
    const pauseCountDelta = snapshot.pauseCount - this.prevPauseCount;
    this.prevPauseCount = snapshot.pauseCount;

    if (snapshot.totalBytes <= 0) return;

    // The accumulator in pty-host.ts is reset on every poll, so the byte
    // count always represents the last CHECK_INTERVAL_MS window — no need
    // to subtract a stored timestamp.
    const elapsedSec = this.CHECK_INTERVAL_MS / 1000;
    const totalBytesPerSecond = Math.round(snapshot.totalBytes / elapsedSec);

    const perTerminalThroughput = snapshot.perTerminal.map((entry) => ({
      terminalId: entry.terminalId,
      bytesPerSecond: Math.round(entry.byteCount / elapsedSec),
      avgPacketSizeBytes:
        entry.packetCount > 0 ? Math.round(entry.byteCount / entry.packetCount) : 0,
    }));

    this.deps.sendEvent({
      type: "terminal-reliability-metric",
      payload: {
        terminalId: "resource-governor",
        metricType: "throughput-rate",
        timestamp: snapshot.timestamp,
        totalBytesPerSecond,
        pauseCountDelta,
        perTerminalThroughput,
      },
    });
  }

  private emitPausedDurationGauge(): void {
    // The pause-duration gauge is a load-bearing recovery signal (the renderer's
    // Tier-1 paused-flow pill held-duration tooltip depends on it), so it
    // bypasses the `DAINTREE_TERMINAL_METRICS` opt-in gate. Other ResourceGovernor
    // gauges (pending-bytes-gauge, throughput-rate, queue-depth-gauge,
    // data-loss-count) stay gated as diagnostic-only telemetry.
    //
    // Emits directly via `this.deps.sendEvent` rather than routing through
    // the host funnel (`emitReliabilityMetricWithTracking`) because the
    // gauge has no per-source pause attribution to track — the snapshot is
    // already aggregated by `getPausedDurationsSnapshot` from the closure
    // `pausedTerminals` map. Routing through the funnel would re-do the
    // same aggregation the snapshot already performed.
    if (!this.deps.getPausedDurationsSnapshot) return;

    const snapshot = this.deps.getPausedDurationsSnapshot();
    if (snapshot.length === 0) return;

    this.deps.sendEvent({
      type: "terminal-reliability-metric",
      payload: {
        terminalId: "resource-governor",
        metricType: "pause-duration-gauge",
        timestamp: Date.now(),
        perTerminalHeld: snapshot,
      },
    });
  }

  private emitQueueDepthGauge(): void {
    if (!metricsEnabled()) return;
    if (!this.deps.getQueueDepthSnapshot) return;

    const snapshot = this.deps.getQueueDepthSnapshot();
    if (snapshot.length === 0) return;

    this.deps.sendEvent({
      type: "terminal-reliability-metric",
      payload: {
        terminalId: "resource-governor",
        metricType: "queue-depth-gauge",
        timestamp: Date.now(),
        perTerminalQueueDepth: snapshot,
      },
    });
  }

  private emitDataLossCount(): void {
    if (!this.deps.getDropSnapshot) return;

    // Always call the snapshotter so the counter resets on every tick
    // regardless of the metrics gate. Without this, the counter would
    // accumulate indefinitely while `DAINTREE_TERMINAL_METRICS=0`, then
    // dump the entire historical backlog as a single "regression" on the
    // first emit after the gate opens. Counter is therefore bounded to
    // "since last tick" regardless of gate state.
    const snapshot = this.deps.getDropSnapshot();
    if (!metricsEnabled()) return;
    // Skip-when-zero matches the throughput-rate gauge contract: a tick
    // with no drops produces no wire event.
    if (snapshot.dataLossCountDelta === 0 && snapshot.droppedBytesDelta === 0) return;

    this.deps.sendEvent({
      type: "terminal-reliability-metric",
      payload: {
        terminalId: "resource-governor",
        metricType: "data-loss-count",
        timestamp: Date.now(),
        dataLossCountDelta: snapshot.dataLossCountDelta,
        droppedBytesDelta: snapshot.droppedBytesDelta,
      },
    });
  }

  private engageThrottle(currentUsageMb: number, percent: number): void {
    console.warn(
      `[ResourceGovernor] High memory usage (${Math.round(currentUsageMb)}MB, ${percent.toFixed(1)}%). Pausing all terminals.`
    );
    this.isThrottling = true;
    this.throttleStartTime = Date.now();

    const ids = this.deps.getTerminalIds();
    const isCritical = percent >= this.CRITICAL_PERCENT;

    // Build ordered list: idle first, active-agent terminals last.
    // At critical pressure (95%+), skip triage — pause everything immediately.
    let orderedIds: string[];
    if (!isCritical && ids.length > 1) {
      const activity = new Map(this.deps.getTerminalActivity().map((a) => [a.id, a] as const));
      orderedIds = [...ids].sort((a, b) => {
        const aa = activity.get(a);
        const bb = activity.get(b);
        const aAgentActive = aa?.agentState === "working" || aa?.agentState === "directing";
        const bAgentActive = bb?.agentState === "working" || bb?.agentState === "directing";
        // Active-agent terminals sort last (paused last)
        if (aAgentActive && !bAgentActive) return 1;
        if (!aAgentActive && bAgentActive) return -1;
        // Among peers, most recently active sorts last
        const aTime = aa?.lastOutputTime ?? 0;
        const bTime = bb?.lastOutputTime ?? 0;
        return bTime - aTime;
      });
    } else {
      orderedIds = ids;
    }

    if (isCritical) {
      console.warn(
        `[ResourceGovernor] Critical pressure (${percent.toFixed(1)}%) — pausing all terminals immediately.`
      );
    }

    let pausedCount = 0;
    for (const id of orderedIds) {
      const coordinator = this.deps.getPauseCoordinator(id);
      if (coordinator) {
        coordinator.pause("resource-governor");
        this.pausedTerminalIds.add(id);
        this.deps.emitTerminalStatus(
          id,
          "paused-resource-governor",
          undefined,
          undefined,
          `Memory pressure: ${Math.round(currentUsageMb)}MB (${percent.toFixed(1)}%)`
        );
        pausedCount++;
      }
    }
    this.deps.incrementPauseCount(pausedCount);
    console.log(`[ResourceGovernor] Paused ${pausedCount}/${ids.length} terminals`);

    // Critical pressure: the pause alone stops growth but frees nothing.
    // Reclaim retained analysis memory now — including foreground terminals,
    // which the pre-pause targeted trim deliberately spares — so utilization
    // can actually recede before the 10s force-resume fires.
    if (isCritical) {
      this.performCriticalTrim();
    }

    this.deps.sendEvent({
      type: "host-throttled",
      isThrottled: true,
      reason: `High memory usage: ${Math.round(currentUsageMb)}MB (${percent.toFixed(1)}%)`,
      timestamp: Date.now(),
    });
  }

  private disengageThrottle(currentUsageMb: number, percent: number, forced: boolean): void {
    const duration = Date.now() - this.throttleStartTime;
    console.log(
      `[ResourceGovernor] ${forced ? "Force resuming" : "Memory stabilized"} ` +
        `(${Math.round(currentUsageMb)}MB, ${percent.toFixed(1)}%). ` +
        `Resuming terminals after ${duration}ms.`
    );
    this.isThrottling = false;
    this.lastDisengageAt = Date.now();
    // Reset trim attempt — by the time REENGAGE_COOLDOWN_MS expires, the heap
    // has had 30s to recover, so any subsequent pressure episode is genuinely
    // new and warrants a fresh trim attempt.
    this.trimAttemptedForCurrentPressure = false;

    // Resume in idle-first, active-last order. Reverses the engage triage so
    // working agents get the most runway after the heap has breathed. We
    // iterate pausedTerminalIds (not getTerminalIds) so we only resume
    // terminals this governor actually paused.
    const activity = new Map(this.deps.getTerminalActivity().map((a) => [a.id, a] as const));
    const orderedPausedIds = [...this.pausedTerminalIds].sort((a, b) => {
      const aa = activity.get(a);
      const bb = activity.get(b);
      const aAgentActive = aa?.agentState === "working" || aa?.agentState === "directing";
      const bAgentActive = bb?.agentState === "working" || bb?.agentState === "directing";
      // Active-agent terminals sort last (resumed last — least likely to
      // immediately re-pressure the heap).
      if (aAgentActive && !bAgentActive) return 1;
      if (!aAgentActive && bAgentActive) return -1;
      // Among peers, least recently active sorts first (idle longer → less
      // likely to immediately allocate on resume).
      const aTime = aa?.lastOutputTime ?? 0;
      const bTime = bb?.lastOutputTime ?? 0;
      return aTime - bTime;
    });

    let resumedCount = 0;
    for (const id of orderedPausedIds) {
      const coordinator = this.deps.getPauseCoordinator(id);
      if (coordinator) {
        if (coordinator.hasToken("resource-governor")) {
          coordinator.resume("resource-governor");
          resumedCount++;
        }
      }
      if (!coordinator?.isPaused) {
        this.deps.emitTerminalStatus(id, "running", undefined, duration);
      } else if (coordinator.hasAnyBackpressureToken()) {
        // Restore backpressure status — the governor's pause
        // overwrote it in the dedup map during engage.
        this.deps.emitTerminalStatus(id, "paused-backpressure", undefined, duration);
      }
    }
    this.pausedTerminalIds.clear();
    console.log(`[ResourceGovernor] Resumed ${resumedCount}/${orderedPausedIds.length} terminals`);

    this.deps.sendEvent({
      type: "host-throttled",
      isThrottled: false,
      reason: `High memory usage: ${Math.round(currentUsageMb)}MB (${percent.toFixed(1)}%)`,
      duration,
      forced,
      timestamp: Date.now(),
    });
  }

  dispose(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.isThrottling) {
      // Iterate only governor-paused terminals so we don't emit spurious
      // "running" statuses for terminals the governor never touched.
      for (const id of this.pausedTerminalIds) {
        const coordinator = this.deps.getPauseCoordinator(id);
        coordinator?.resume("resource-governor");
        if (!coordinator?.isPaused) {
          this.deps.emitTerminalStatus(id, "running");
        }
      }
      this.isThrottling = false;
      this.throttleStartTime = 0;
    }
    this.pausedTerminalIds.clear();
    this.isWarning = false;
    this.profileOverride = null;
    this.killedPids.clear();
    this.smoothedUtilizationPercent = undefined;
    this.sampleCount = 0;
    this.lastDisengageAt = 0;
    this.trimAttemptedForCurrentPressure = false;
    this.hasThroughputBaseline = false;
    this.prevPauseCount = 0;
    console.log("[ResourceGovernor] Disposed");
  }
}
