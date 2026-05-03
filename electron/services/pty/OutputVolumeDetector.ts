export interface OutputVolumeConfig {
  enabled?: boolean;
  windowMs?: number;
  minFrames?: number;
  minBytes?: number;
}

export class OutputVolumeDetector {
  readonly enabled: boolean;
  private _windowMs: number;
  private readonly minFrames: number;
  private readonly minBytes: number;
  private windowStart = 0;
  private framesInWindow = 0;
  private bytesInWindow = 0;

  constructor(config?: OutputVolumeConfig) {
    const defaults = { enabled: false, windowMs: 500, minFrames: 3, minBytes: 2048 };
    const c = { ...defaults, ...config };
    this.enabled = c.enabled;
    this._windowMs = c.windowMs;
    this.minFrames = c.minFrames;
    this.minBytes = c.minBytes;
  }

  get windowMs(): number {
    return this._windowMs;
  }

  // Background polling tier (500ms) widens this window so consecutive frames
  // stop straddling the 1000ms boundary and pinning framesInWindow at 1.
  reconfigureWindow(windowMs: number): void {
    if (this._windowMs === windowMs) return;
    this._windowMs = windowMs;
    this.resetWindow();
  }

  update(dataLength: number, now: number): boolean {
    if (!this.enabled) {
      return false;
    }

    if (this.windowStart === 0 || now - this.windowStart > this._windowMs) {
      this.windowStart = now;
      this.framesInWindow = 1;
      this.bytesInWindow = dataLength;
    } else {
      this.framesInWindow++;
      this.bytesInWindow += dataLength;
    }

    // Require BOTH frames AND bytes — minFrames is the noise gate that prevents
    // a single unfiltered control sequence (e.g. an OSC variant we missed, or an
    // escape split across PTY chunks) from triggering escalation. With
    // minBytes lowered to 1 (#6365), this gate is the primary defense against
    // false-positive idle→busy escalation from protocol noise.
    if (this.framesInWindow >= this.minFrames && this.bytesInWindow >= this.minBytes) {
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
