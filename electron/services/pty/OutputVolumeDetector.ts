export interface OutputVolumeConfig {
  enabled?: boolean;
  windowMs?: number;
  minFrames?: number;
  minBytes?: number;
}

export class OutputVolumeDetector {
  readonly enabled: boolean;
  readonly windowMs: number;
  private readonly minFrames: number;
  private readonly minBytes: number;
  private windowStart = 0;
  private framesInWindow = 0;
  private bytesInWindow = 0;

  constructor(config?: OutputVolumeConfig) {
    const defaults = { enabled: false, windowMs: 500, minFrames: 3, minBytes: 2048 };
    const c = { ...defaults, ...config };
    this.enabled = c.enabled;
    this.windowMs = c.windowMs;
    this.minFrames = c.minFrames;
    this.minBytes = c.minBytes;
  }

  update(dataLength: number, now: number): boolean {
    if (!this.enabled) {
      return false;
    }

    if (this.windowStart === 0 || now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.framesInWindow = 1;
      this.bytesInWindow = dataLength;
    } else {
      this.framesInWindow++;
      this.bytesInWindow += dataLength;
    }

    if (
      (this.framesInWindow >= this.minFrames && this.bytesInWindow >= this.minBytes) ||
      this.bytesInWindow >= this.minBytes
    ) {
      this.resetWindow();
      return true;
    }

    return false;
  }

  resetWindow(): void {
    this.windowStart = 0;
    this.framesInWindow = 0;
    this.bytesInWindow = 0;
  }

  reset(): void {
    this.resetWindow();
  }
}
