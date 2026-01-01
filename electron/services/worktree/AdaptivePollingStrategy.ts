import { DEFAULT_CONFIG } from "../../types/config.js";

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

  constructor(config?: Partial<AdaptivePollingConfig>) {
    this.baseInterval = config?.baseInterval ?? 2000;
    this.maxInterval = config?.maxInterval ?? DEFAULT_CONFIG.monitor?.pollIntervalMax ?? 30000;
    this.adaptiveBackoff =
      config?.adaptiveBackoff ?? DEFAULT_CONFIG.monitor?.adaptiveBackoff ?? true;
    this.circuitBreakerThreshold =
      config?.circuitBreakerThreshold ?? DEFAULT_CONFIG.monitor?.circuitBreakerThreshold ?? 3;
  }

  public calculateNextInterval(): number {
    if (!this.adaptiveBackoff || this.lastOperationDuration === 0) {
      return this.baseInterval;
    }

    const adaptiveInterval = Math.ceil(this.lastOperationDuration * 1.5);
    const nextInterval = Math.max(this.baseInterval, adaptiveInterval);
    return Math.min(nextInterval, this.maxInterval);
  }

  public recordSuccess(durationMs: number, queueDelayMs: number = 0): void {
    const queueDelay = Math.max(0, queueDelayMs);
    this.lastOperationDuration = durationMs + queueDelay;
    this.lastQueueDelay = queueDelay;
    this.consecutiveFailures = 0;
    if (this.circuitBreakerTripped) {
      this.circuitBreakerTripped = false;
    }
  }

  public recordFailure(durationMs: number, queueDelayMs: number = 0): boolean {
    const queueDelay = Math.max(0, queueDelayMs);
    this.lastOperationDuration = durationMs + queueDelay;
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
    this.baseInterval = ms;
  }

  public updateConfig(adaptiveBackoff?: boolean, maxInterval?: number, threshold?: number): void {
    if (adaptiveBackoff !== undefined) {
      this.adaptiveBackoff = adaptiveBackoff;
    }
    if (maxInterval !== undefined) {
      this.maxInterval = maxInterval;
    }
    if (threshold !== undefined) {
      this.circuitBreakerThreshold = threshold;
    }
  }
}
