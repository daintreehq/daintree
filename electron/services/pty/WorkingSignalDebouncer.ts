export class WorkingSignalDebouncer {
  private sustainedSince = 0;
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  shouldTriggerRecovery(now: number, signalPresent: boolean): boolean {
    if (signalPresent) {
      if (this.sustainedSince === 0) {
        this.sustainedSince = now;
        if (process.env.CANOPY_VERBOSE) {
          console.log(
            `[ActivityMonitor] Working signal detected, starting debounce timer (${this.delayMs}ms)`
          );
        }
      }
      const sustained = now - this.sustainedSince >= this.delayMs;
      if (sustained && process.env.CANOPY_VERBOSE) {
        console.log(
          `[ActivityMonitor] Working signal sustained for ${now - this.sustainedSince}ms, triggering recovery`
        );
      }
      return sustained;
    } else {
      if (this.sustainedSince !== 0 && process.env.CANOPY_VERBOSE) {
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
