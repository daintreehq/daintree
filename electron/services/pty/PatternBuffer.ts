export class PatternBuffer {
  private buffer = "";
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  update(data: string): void {
    this.buffer += data;
    // Trim lazily at 2× capacity: trimming on every over-cap append copies
    // ~maxSize bytes per chunk under sustained output; deferring to 2× makes
    // the copy amortized O(1) per byte. Consumers treat the buffer as "at
    // least the last maxSize chars" (detection windows to the trailing
    // lines), so briefly retaining up to 2× is harmless.
    if (this.buffer.length > this.maxSize * 2) {
      this.buffer = this.buffer.slice(-this.maxSize);
    }
  }

  getText(): string {
    return this.buffer;
  }

  clear(): void {
    this.buffer = "";
  }

  reset(): void {
    this.buffer = "";
  }
}
