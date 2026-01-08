import v8 from "node:v8";
import type { PtyHostEvent } from "../../shared/types/pty-host.js";

export interface ResourceGovernorDeps {
  getTerminals: () => Array<{ ptyProcess: { pause: () => void; resume: () => void } }>;
  incrementPauseCount: (count: number) => void;
  sendEvent: (event: PtyHostEvent) => void;
}

export class ResourceGovernor {
  private readonly MEMORY_LIMIT_PERCENT = 80;
  private readonly RESUME_THRESHOLD_PERCENT = 60;
  private readonly FORCE_RESUME_MS = 10000;
  private readonly CHECK_INTERVAL_MS = 2000;
  private isThrottling = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private throttleStartTime = 0;

  constructor(private readonly deps: ResourceGovernorDeps) {}

  start(): void {
    this.checkInterval = setInterval(() => this.checkResources(), this.CHECK_INTERVAL_MS);
    console.log("[ResourceGovernor] Started monitoring memory usage");
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
    console.log("[ResourceGovernor] Disposed");
  }
}
