export class PatternBuffer {
  private buffer = "";
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  update(data: string): void {
    this.buffer += data;
    if (this.buffer.length > this.maxSize) {
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
