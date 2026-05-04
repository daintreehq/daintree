export interface OutputVolumeConfig {
  enabled?: boolean;
  // Leaky-bucket drain in bytes/ms. Higher = bucket forgets older bytes faster.
  leakRatePerMs?: number;
  // Bucket level at which the detector fires.
  activationThreshold?: number;
  // Per-frame contribution cap. The noise gate that prevents a single oversized
  // chunk (status-line write, bracketed status payload) from filling the bucket
  // on its own — replaces the old minFrames AND-gate.
  maxBytesPerFrame?: number;
}

// Sample-cadence-invariant output classifier. Bytes accumulate into a bucket
// that drains at a constant rate; the result depends only on the underlying
// byte stream, not on how frequently `update()` is called. This eliminates the
// tier-specific window widening that the old fixed-window AND-gate required
// (#6641, #6666).
export class OutputVolumeDetector {
  readonly enabled: boolean;
  private readonly leakRatePerMs: number;
  private readonly activationThreshold: number;
  private readonly maxBytesPerFrame: number;
  private level = 0;
  private lastUpdateMs = 0;

  constructor(config?: OutputVolumeConfig) {
    const defaults = {
      enabled: false,
      leakRatePerMs: 2.048,
      activationThreshold: 2048,
      maxBytesPerFrame: 1024,
    };
    // Filter out explicit-undefined fields before merging so callers passing
    // `{ leakRatePerMs: undefined }` (e.g. spreading partial options) don't
    // override the defaults with undefined and trip the clamp fallback.
    const filtered = config
      ? Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined))
      : {};
    const c = { ...defaults, ...filtered } as Required<OutputVolumeConfig>;
    this.enabled = c.enabled;
    // Defensive clamps. leakRatePerMs > 0 is required so recencyWindowMs is
    // finite; activationThreshold and maxBytesPerFrame must be positive so the
    // detector can ever fire and the noise gate is meaningful.
    this.leakRatePerMs = c.leakRatePerMs > 0 ? c.leakRatePerMs : 0.001;
    this.activationThreshold = c.activationThreshold > 0 ? c.activationThreshold : 1;
    this.maxBytesPerFrame = c.maxBytesPerFrame > 0 ? c.maxBytesPerFrame : 1;
  }

  // Time after a fire-event that the consumer should still consider output
  // "recent" — derived as the time it takes to drain a full bucket from the
  // activation threshold. Replaces the old windowMs getter on line-672 of
  // ActivityMonitor's hasRecentOutputActivity check.
  get recencyWindowMs(): number {
    return this.activationThreshold / this.leakRatePerMs;
  }

  update(dataLength: number, now: number): boolean {
    if (!this.enabled) {
      return false;
    }

    if (this.lastUpdateMs > 0) {
      const elapsedMs = Math.max(0, now - this.lastUpdateMs);
      this.level = Math.max(0, this.level - elapsedMs * this.leakRatePerMs);
    }
    this.lastUpdateMs = now;

    const contribution = Math.min(Math.max(0, dataLength), this.maxBytesPerFrame);
    this.level += contribution;

    if (this.level >= this.activationThreshold) {
      this.reset();
      return true;
    }

    return false;
  }

  reset(): void {
    this.level = 0;
    this.lastUpdateMs = 0;
  }
}
