import { powerMonitor } from "electron";

export interface SleepPeriod {
  start: number;
  end: number;
  duration: number;
}

export interface SystemSleepMetrics {
  totalSleepMs: number;
  sleepPeriods: SleepPeriod[];
  isCurrentlySleeping: boolean;
  currentSleepStart: number | null;
}

type WakeCallback = (sleepDurationMs: number) => void;

/**
 * SystemSleepService - Tracks system sleep/wake cycles for accurate timing.
 *
 * @pattern Factory/Accessor Methods (Pattern C)
 *
 * Why this pattern:
 * - Requires explicit initialization (powerMonitor listeners registered via initialize())
 * - Has dispose() method that must be called to remove event listeners
 * - Factory accessor pattern pairs initialize()/dispose() for resource management
 * - Stateful resource: tracks sleep periods, must be reset/disposed properly
 *
 * When to use Pattern C:
 * - Service registers system-level event handlers that need cleanup
 * - Service has initialize()/dispose() lifecycle methods
 * - Creation and initialization are separate concerns
 * - Memory/resource cleanup is critical (removing listeners, clearing state)
 */
class SystemSleepService {
  private sleepStart: number | null = null;
  private sleepPeriods: SleepPeriod[] = [];
  private totalSleepMs = 0;
  private listeners = new Set<WakeCallback>();
  private initialized = false;
  private serviceStartTime: number = 0;

  // Cap sleep periods to last 100 entries to prevent unbounded growth
  private readonly MAX_SLEEP_PERIODS = 100;

  constructor() {
    // Singleton constructor - initialization happens via initialize()
  }

  initialize(): void {
    if (this.initialized) {
      console.log("[SystemSleepService] Already initialized");
      return;
    }

    // Remove any existing listeners to prevent stacking on re-initialization
    powerMonitor.off("suspend", this.handleSuspend);
    powerMonitor.off("resume", this.handleResume);

    powerMonitor.on("suspend", this.handleSuspend);
    powerMonitor.on("resume", this.handleResume);
    this.initialized = true;
    this.serviceStartTime = Date.now();
    console.log("[SystemSleepService] Initialized and listening for power events");
  }

  private handleSuspend = (): void => {
    // Guard against duplicate suspend events
    if (this.sleepStart !== null) {
      console.log("[SystemSleepService] Already suspended, ignoring duplicate suspend event");
      return;
    }
    this.sleepStart = Date.now();
    console.log("[SystemSleepService] System suspending");
  };

  private handleResume = (): void => {
    if (this.sleepStart !== null) {
      const now = Date.now();
      const sleepDuration = now - this.sleepStart;
      this.totalSleepMs += sleepDuration;

      const period: SleepPeriod = {
        start: this.sleepStart,
        end: now,
        duration: sleepDuration,
      };
      this.sleepPeriods.push(period);

      // Trim old periods to prevent unbounded growth
      if (this.sleepPeriods.length > this.MAX_SLEEP_PERIODS) {
        this.sleepPeriods.shift();
      }

      console.log(
        `[SystemSleepService] System resumed after ${Math.round(sleepDuration / 1000)}s sleep`
      );

      this.sleepStart = null;

      // Notify listeners with sleep duration
      for (const callback of this.listeners) {
        try {
          callback(sleepDuration);
        } catch (error) {
          console.error("[SystemSleepService] Wake callback error:", error);
        }
      }
    }
  };

  /**
   * Calculate elapsed time minus any sleep periods that occurred.
   * Use this instead of `Date.now() - startTimestamp` for accurate "awake" durations.
   */
  getAwakeTimeSince(startTimestamp: number): number {
    const now = Date.now();

    // Clamp startTimestamp to service initialization time
    // Sleep periods before initialization are not tracked
    const clampedStart = Math.max(startTimestamp, this.serviceStartTime);
    const elapsed = now - clampedStart;

    // Calculate sleep time that occurred within our window
    let sleepWithinWindow = 0;
    for (const period of this.sleepPeriods) {
      // Only count sleep periods that overlap with our measurement window
      const overlapStart = Math.max(period.start, clampedStart);
      const overlapEnd = Math.min(period.end, now);

      if (overlapEnd > overlapStart) {
        sleepWithinWindow += overlapEnd - overlapStart;
      }
    }

    // If currently sleeping, add ongoing sleep time
    if (this.sleepStart !== null && this.sleepStart < now) {
      const ongoingSleepStart = Math.max(this.sleepStart, clampedStart);
      sleepWithinWindow += now - ongoingSleepStart;
    }

    return Math.max(0, elapsed - sleepWithinWindow);
  }

  /**
   * Get total accumulated sleep time since service started.
   */
  getTotalSleepTime(): number {
    let total = this.totalSleepMs;
    // Add ongoing sleep if currently sleeping
    if (this.sleepStart !== null) {
      total += Date.now() - this.sleepStart;
    }
    return total;
  }

  /**
   * Check if system is currently sleeping.
   */
  isSleeping(): boolean {
    return this.sleepStart !== null;
  }

  /**
   * Subscribe to wake events with sleep duration.
   * Returns cleanup function.
   */
  onWake(callback: WakeCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Reset accumulated sleep tracking (e.g., when starting a new session).
   */
  reset(): void {
    this.totalSleepMs = 0;
    this.sleepPeriods = [];
    this.sleepStart = null;
    console.log("[SystemSleepService] Reset sleep tracking");
  }

  /**
   * Get detailed metrics about sleep tracking.
   */
  getMetrics(): SystemSleepMetrics {
    return {
      totalSleepMs: this.getTotalSleepTime(),
      sleepPeriods: [...this.sleepPeriods],
      isCurrentlySleeping: this.isSleeping(),
      currentSleepStart: this.sleepStart,
    };
  }

  /**
   * Cleanup listeners and remove power monitor handlers.
   */
  dispose(): void {
    if (!this.initialized) return;

    powerMonitor.off("suspend", this.handleSuspend);
    powerMonitor.off("resume", this.handleResume);
    this.listeners.clear();
    this.initialized = false;
    console.log("[SystemSleepService] Disposed");
  }
}

// Singleton instance
let systemSleepService: SystemSleepService | null = null;

export function getSystemSleepService(): SystemSleepService {
  if (!systemSleepService) {
    systemSleepService = new SystemSleepService();
  }
  return systemSleepService;
}

export function initializeSystemSleepService(): SystemSleepService {
  const service = getSystemSleepService();
  service.initialize();
  return service;
}

export { SystemSleepService };
