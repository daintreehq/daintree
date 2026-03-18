import v8 from "node:v8";
import type { PtyHostEvent } from "../../shared/types/pty-host.js";
import { FdMonitor } from "./FdMonitor.js";
import { metricsEnabled } from "./metrics.js";

export interface ResourceGovernorDeps {
  getTerminals: () => Array<{ ptyProcess: { pause: () => void; resume: () => void } }>;
  getTerminalPids: () => Array<{ id: string; pid: number | undefined }>;
  incrementPauseCount: (count: number) => void;
  sendEvent: (event: PtyHostEvent) => void;
}

export class ResourceGovernor {
  private readonly MEMORY_LIMIT_PERCENT = 85;
  private readonly RESUME_THRESHOLD_PERCENT = 60;
  private readonly FORCE_RESUME_MS = 10000;
  private readonly CHECK_INTERVAL_MS = 2000;
  private isThrottling = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private throttleStartTime = 0;
  private readonly fdMonitor: FdMonitor;
  private readonly killedPids = new Map<number, number>();
  private readonly ORPHAN_GRACE_MS = 4000;

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

  private checkResources(): void {
    const memory = process.memoryUsage();
    const heapUsedMb = memory.heapUsed / 1024 / 1024;
    const heapStats = v8.getHeapStatistics();
    const heapLimitMb = heapStats.heap_size_limit / 1024 / 1024;
    const utilizationPercent = (heapUsedMb / heapLimitMb) * 100;

    if (!this.isThrottling && utilizationPercent > this.MEMORY_LIMIT_PERCENT) {
      this.engageThrottle(heapUsedMb, utilizationPercent);
    } else if (this.isThrottling) {
      const throttleDuration = Date.now() - this.throttleStartTime;
      const shouldForceResume = throttleDuration > this.FORCE_RESUME_MS;
      const belowThreshold = utilizationPercent < this.RESUME_THRESHOLD_PERCENT;

      if (shouldForceResume || belowThreshold) {
        this.disengageThrottle(heapUsedMb, utilizationPercent, shouldForceResume);
      }
    }

    this.checkFdUsage();
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
    const activePids = new Set(terminals.map((t) => t.pid).filter((p): p is number => p !== undefined));

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
        estimatedLeaked: result.estimatedTerminalFds - result.activeTerminals,
        orphanedPids: result.orphanedPids,
        ptmxLimit: result.ptmxLimit,
        timestamp: now,
      });
    }
  }

  private engageThrottle(currentUsageMb: number, percent: number): void {
    console.warn(
      `[ResourceGovernor] High memory usage (${Math.round(currentUsageMb)}MB, ${percent.toFixed(1)}%). Pausing all terminals.`
    );
    this.isThrottling = true;
    this.throttleStartTime = Date.now();

    const terminals = this.deps.getTerminals();
    let pausedCount = 0;
    for (const term of terminals) {
      try {
        term.ptyProcess.pause();
        pausedCount++;
      } catch {
        // Ignore dead processes
      }
    }
    this.deps.incrementPauseCount(pausedCount);
    console.log(`[ResourceGovernor] Paused ${pausedCount}/${terminals.length} terminals`);

    if (global.gc) {
      global.gc();
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

    const terminals = this.deps.getTerminals();
    let resumedCount = 0;
    for (const term of terminals) {
      try {
        term.ptyProcess.resume();
        resumedCount++;
      } catch {
        // Ignore dead processes
      }
    }
    console.log(`[ResourceGovernor] Resumed ${resumedCount}/${terminals.length} terminals`);

    this.deps.sendEvent({
      type: "host-throttled",
      isThrottled: false,
      duration,
      timestamp: Date.now(),
    });
  }

  dispose(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.killedPids.clear();
    console.log("[ResourceGovernor] Disposed");
  }
}
