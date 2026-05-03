export class WorkingSignalDebouncer {
  private sustainedSince = 0;
  private _delayMs: number;

  constructor(delayMs: number) {
    this._delayMs = delayMs;
  }

  get delayMs(): number {
    return this._delayMs;
  }

  // Background polling tier shortens this delay so recovery fires after one
  // polling cycle instead of three (3 × 500ms = 1500ms would be too coarse).
  setDelay(delayMs: number): void {
    this._delayMs = delayMs;
  }

  shouldTriggerRecovery(now: number, signalPresent: boolean): boolean {
    if (signalPresent) {
      if (this.sustainedSince === 0) {
        this.sustainedSince = now;
        if (process.env.DAINTREE_VERBOSE) {
          console.log(
            `[ActivityMonitor] Working signal detected, starting debounce timer (${this._delayMs}ms)`
          );
        }
      }
      const sustained = now - this.sustainedSince >= this._delayMs;
      if (sustained && process.env.DAINTREE_VERBOSE) {
        console.log(
          `[ActivityMonitor] Working signal sustained for ${now - this.sustainedSince}ms, triggering recovery`
        );
      }
      return sustained;
    } else {
      if (this.sustainedSince !== 0 && process.env.DAINTREE_VERBOSE) {
        console.log(`[ActivityMonitor] Working signal lost, resetting debounce timer`);
      }
      this.sustainedSince = 0;
      return false;
    }
  }

  reset(): void {
    this.sustainedSince = 0;
  }
}
