export interface HighOutputConfig {
  enabled?: boolean;
  windowMs?: number;
  bytesPerSecond?: number;
  recoveryEnabled?: boolean;
  recoveryDelayMs?: number;
}

export class HighOutputDetector {
  private readonly enabled: boolean;
  private readonly windowMs: number;
  private readonly bytesPerSecond: number;
  private readonly recoveryEnabled: boolean;
  private readonly recoveryDelayMs: number;
  private windowStart = 0;
  private bytesInWindow = 0;
  private sustainedSince = 0;

  constructor(config?: HighOutputConfig) {
    const defaults = {
      enabled: true,
      windowMs: 500,
      bytesPerSecond: 2048,
      recoveryEnabled: true,
      recoveryDelayMs: 500,
    };
    const c = { ...defaults, ...config };
    this.enabled = c.enabled;
    this.windowMs = c.windowMs;
    this.bytesPerSecond = c.bytesPerSecond;
    this.recoveryEnabled = c.recoveryEnabled;
    this.recoveryDelayMs = c.recoveryDelayMs;
  }

  update(dataLength: number, now: number): void {
    if (!this.enabled) {
      return;
    }

    if (this.windowStart === 0 || now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.bytesInWindow = dataLength;
      this.sustainedSince = 0;
    } else {
      this.bytesInWindow += dataLength;
    }
  }

  isHighOutput(now: number): boolean {
    if (!this.enabled) {
      return false;
    }

    if (this.windowStart === 0) {
      return false;
    }

    const windowAge = now - this.windowStart;
    if (windowAge > this.windowMs) {
      return false;
    }

    const effectiveWindowMs = Math.max(windowAge, 50);
    const bps = (this.bytesInWindow / effectiveWindowMs) * 1000;

    return bps >= this.bytesPerSecond;
  }

  shouldTriggerRecovery(now: number): boolean {
    if (!this.enabled || !this.recoveryEnabled) {
      return false;
    }

    const isHigh = this.isHighOutput(now);

    if (isHigh) {
      if (this.sustainedSince === 0) {
        this.sustainedSince = now;
      }
      return now - this.sustainedSince >= this.recoveryDelayMs;
    } else {
      this.sustainedSince = 0;
      return false;
    }
  }

  resetWindow(): void {
    this.windowStart = 0;
    this.bytesInWindow = 0;
    this.sustainedSince = 0;
  }

  reset(): void {
    this.resetWindow();
  }
}
