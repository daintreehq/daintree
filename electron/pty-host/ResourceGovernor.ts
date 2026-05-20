import v8 from "node:v8";
import type { AgentState } from "../../shared/types/agent.js";
import type { PtyHostEvent, TerminalFlowStatus } from "../../shared/types/pty-host.js";
import type { ResourceProfile } from "../../shared/types/resourceProfile.js";
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
  getTerminalPids: () => Array<{ id: string; pid: number | undefined }>;
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
}

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
  private isThrottling = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private throttleStartTime = 0;
  private readonly fdMonitor: FdMonitor;
  private readonly killedPids = new Map<number, number>();
  private readonly ORPHAN_GRACE_MS = 4000;
  private prevThroughputTimestamp = 0;
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
    const heapStats = v8.getHeapStatistics();
    const heapLimitMb = heapStats.heap_size_limit / 1024 / 1024;
    const utilizationPercent = (heapUsedMb / heapLimitMb) * 100;

    // EMA smoothing — rejects single-tick GC sawtooth spikes. Seeded with the
    // first real reading (not 0) to avoid a warmup ramp that falsely stays
    // below threshold. Mirrors the seeding idiom used by prevThroughputTimestamp.
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
        `[ResourceGovernor] Memory warning: ${utilizationPercent.toFixed(1)}% heap used ` +
          `(threshold: ${warnThreshold}%).`
      );
      this.deps.sendEvent({
        type: "host-memory-warning",
        isWarning: true,
        utilizationPercent: Math.round(utilizationPercent),
        timestamp: Date.now(),
      });
    } else if (this.isWarning && utilizationPercent < warnClear) {
      this.isWarning = false;
      console.log(
        `[ResourceGovernor] Memory warning cleared: ${utilizationPercent.toFixed(1)}% heap used.`
      );
      this.deps.sendEvent({
        type: "host-memory-warning",
        isWarning: false,
        utilizationPercent: Math.round(utilizationPercent),
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
        if (!isCritical && !this.trimAttemptedForCurrentPressure && this.deps.trimBuffers) {
          // Trim first as a one-shot reclaim — drops JS references synchronously
          // so the next GC can collect old-gen scrollback strings. heapUsed won't
          // drop in this tick (GC hasn't run yet) so we wait one tick before
          // escalating to pause. Wrapped in try/catch because trim is best-effort:
          // a failure shouldn't block the eventual pause path.
          try {
            this.deps.trimBuffers();
            console.log(
              `[ResourceGovernor] Trimmed buffers as pre-pause reclaim ` +
                `(${utilizationPercent.toFixed(1)}% raw, ${smoothedPercent.toFixed(1)}% smoothed).`
            );
          } catch (err) {
            console.warn("[ResourceGovernor] trimBuffers failed:", err);
          }
          this.trimAttemptedForCurrentPressure = true;
        } else {
          this.engageThrottle(heapUsedMb, utilizationPercent);
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
        this.disengageThrottle(heapUsedMb, utilizationPercent, maxPauseExceeded);
      }
    }

    this.checkFdUsage();
    this.emitPendingBytesGauge();
    this.emitThroughputRateGauge();
  }

  private checkFdUsage(): void {
    if (!this.fdMonitor.supported) return;

    const now = Date.now();

    // Collect orphan candidates: PIDs killed long enough ago to have exited
    const orphanCandidates: number[] = [];
    for (const [pid, killedAt] of this.killedPids) {
      if (now - killedAt > this.ORPHAN_GRACE_MS) {
        orphanCandidates.push(pid);
        this.killedPids.delete(pid);
      }
    }

    const terminals = this.deps.getTerminalPids();
    const result = this.fdMonitor.checkForLeaks(terminals.length, orphanCandidates);

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

    // First tick: seed baselines without emitting. Prevents epoch-scale
    // division on the first real interval (prevThroughputTimestamp starts at 0).
    if (this.prevThroughputTimestamp === 0) {
      this.prevThroughputTimestamp = snapshot.timestamp;
      this.prevPauseCount = snapshot.pauseCount;
      return;
    }

    // Always track pauseCount baseline so idle ticks don't accumulate deltas
    // that get misattributed to the next byte-producing tick.
    const pauseCountDelta = snapshot.pauseCount - this.prevPauseCount;
    this.prevPauseCount = snapshot.pauseCount;

    if (snapshot.totalBytes <= 0) return;

    const elapsedMs = snapshot.timestamp - this.prevThroughputTimestamp;
    const elapsedSec = elapsedMs > 0 ? elapsedMs / 1000 : 2;
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

    this.prevThroughputTimestamp = snapshot.timestamp;
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
      } else if (coordinator.hasToken("backpressure")) {
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
    console.log("[ResourceGovernor] Disposed");
  }
}
