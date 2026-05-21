import { DEFAULT_CONFIG } from "../../types/config.js";

const DEFAULT_BASE_INTERVAL = 2000;
const DEFAULT_MAX_INTERVAL = DEFAULT_CONFIG.monitor?.pollIntervalMax ?? 30000;
const DEFAULT_ADAPTIVE_BACKOFF = DEFAULT_CONFIG.monitor?.adaptiveBackoff ?? true;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = DEFAULT_CONFIG.monitor?.circuitBreakerThreshold ?? 3;

// Idle backoff: after N consecutive polls observed no state change, lengthen
// the next interval. Each additional IDLE_MISS_THRESHOLD-sized batch doubles
// the multiplier (1× → 2× → 4×) up to IDLE_BACKOFF_CEILING_MULTIPLIER, then
// caps. The final interval is still bounded by `maxInterval`, so this cannot
// push the cadence past the configured ceiling.
const IDLE_MISS_THRESHOLD = 3;
const IDLE_BACKOFF_CEILING_MULTIPLIER = 4;

function normalizeInterval(ms: number | undefined, fallback: number): number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return fallback;
  }

  const rounded = Math.floor(ms);
  return rounded >= 1 ? rounded : fallback;
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.floor(value);
  return rounded >= 1 ? rounded : fallback;
}

function normalizeDuration(ms: number): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export interface AdaptivePollingConfig {
  baseInterval: number;
  maxInterval: number;
  adaptiveBackoff: boolean;
  circuitBreakerThreshold: number;
}

export interface AdaptivePollingMetrics {
  lastOperationDuration: number;
  lastQueueDelay: number;
  consecutiveFailures: number;
  circuitBreakerTripped: boolean;
  currentInterval: number;
}

export class AdaptivePollingStrategy {
  private baseInterval: number;
  private maxInterval: number;
  private adaptiveBackoff: boolean;
  private circuitBreakerThreshold: number;

  private lastOperationDuration: number = 0;
  private lastQueueDelay: number = 0;
  private consecutiveFailures: number = 0;
  private circuitBreakerTripped: boolean = false;
  private consecutiveUnchangedCount: number = 0;

  constructor(config?: Partial<AdaptivePollingConfig>) {
    this.baseInterval = normalizeInterval(config?.baseInterval, DEFAULT_BASE_INTERVAL);
    this.maxInterval = Math.max(
      this.baseInterval,
      normalizeInterval(config?.maxInterval, DEFAULT_MAX_INTERVAL)
    );
    this.adaptiveBackoff = config?.adaptiveBackoff ?? DEFAULT_ADAPTIVE_BACKOFF;
    this.circuitBreakerThreshold = normalizeThreshold(
      config?.circuitBreakerThreshold,
      DEFAULT_CIRCUIT_BREAKER_THRESHOLD
    );
  }

  public calculateNextInterval(): number {
    const boundedMaxInterval = Math.max(this.maxInterval, this.baseInterval);
    const idleMultiplier = this.idleBackoffMultiplier();

    let baseAdaptive: number;
    if (!this.adaptiveBackoff || this.lastOperationDuration <= 0) {
      baseAdaptive = this.baseInterval;
    } else {
      const adaptiveInterval = Math.ceil(this.lastOperationDuration * 1.5);
      if (!Number.isFinite(adaptiveInterval) || adaptiveInterval < 1) {
        baseAdaptive = this.baseInterval;
      } else {
        baseAdaptive = Math.max(this.baseInterval, adaptiveInterval);
      }
    }

    const scaled = baseAdaptive * idleMultiplier;
    return Math.min(scaled, boundedMaxInterval);
  }

  private idleBackoffMultiplier(): number {
    if (this.consecutiveUnchangedCount < IDLE_MISS_THRESHOLD) {
      return 1;
    }
    const steps = Math.floor(this.consecutiveUnchangedCount / IDLE_MISS_THRESHOLD);
    const multiplier = 2 ** steps;
    return Math.min(multiplier, IDLE_BACKOFF_CEILING_MULTIPLIER);
  }

  public recordSuccess(durationMs: number, queueDelayMs: number = 0): void {
    const duration = normalizeDuration(durationMs);
    const queueDelay = normalizeDuration(queueDelayMs);
    this.lastOperationDuration = duration + queueDelay;
    this.lastQueueDelay = queueDelay;
    this.consecutiveFailures = 0;
    if (this.circuitBreakerTripped) {
      this.circuitBreakerTripped = false;
    }
  }

  /**
   * A completed poll observed no relevant state change. Lengthens the next
   * interval (in tandem with the multiplier in `calculateNextInterval`) so a
   * quiet repo doesn't burn fork-exec cycles on every base-interval tick.
   * Only call after a real git check; cheap stat-skips bypass this so the
   * counter measures git-confirmed quiet time, not all quiet ticks.
   */
  public recordNoChange(): void {
    this.consecutiveUnchangedCount++;
  }

  /**
   * Reset the idle counter — a poll observed change, a watcher event fired,
   * or focus shifted to this worktree. The next interval drops back to the
   * base cadence so the user sees fresh activity right after something moves.
   */
  public recordStateChange(): void {
    this.consecutiveUnchangedCount = 0;
  }

  public recordFailure(durationMs: number, queueDelayMs: number = 0): boolean {
    const duration = normalizeDuration(durationMs);
    const queueDelay = normalizeDuration(queueDelayMs);
    this.lastOperationDuration = duration + queueDelay;
    this.lastQueueDelay = queueDelay;
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
      this.circuitBreakerTripped = true;
      return true;
    }
    return false;
  }

  public isCircuitBreakerTripped(): boolean {
    return this.circuitBreakerTripped;
  }

  public reset(): void {
    this.circuitBreakerTripped = false;
    this.consecutiveFailures = 0;
    this.lastOperationDuration = 0;
    this.lastQueueDelay = 0;
    this.consecutiveUnchangedCount = 0;
  }

  public getMetrics(): AdaptivePollingMetrics {
    return {
      lastOperationDuration: this.lastOperationDuration,
      lastQueueDelay: this.lastQueueDelay,
      consecutiveFailures: this.consecutiveFailures,
      circuitBreakerTripped: this.circuitBreakerTripped,
      currentInterval: this.calculateNextInterval(),
    };
  }

  public setBaseInterval(ms: number): void {
    this.baseInterval = normalizeInterval(ms, this.baseInterval);
    if (this.maxInterval < this.baseInterval) {
      this.maxInterval = this.baseInterval;
    }
  }

  public updateConfig(adaptiveBackoff?: boolean, maxInterval?: number, threshold?: number): void {
    if (typeof adaptiveBackoff === "boolean") {
      this.adaptiveBackoff = adaptiveBackoff;
    }
    if (maxInterval !== undefined) {
      const normalizedMax = normalizeInterval(maxInterval, this.maxInterval);
      this.maxInterval = Math.max(normalizedMax, this.baseInterval);
    }
    if (threshold !== undefined) {
      this.circuitBreakerThreshold = normalizeThreshold(threshold, this.circuitBreakerThreshold);
    }
  }
}
