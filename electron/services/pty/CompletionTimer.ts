export class CompletionTimer {
  emitted = false;
  private timer: NodeJS.Timeout | null = null;

  emit(callback: () => void, holdMs: number): void {
    this.emitted = true;

    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      callback();
    }, holdMs);
  }

  reset(): void {
    this.emitted = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.reset();
  }
}
