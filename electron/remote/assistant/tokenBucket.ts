/** Lazily refilled; nothing ticks while nobody calls. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    now: number
  ) {
    this.tokens = capacity;
    this.updatedAt = now;
  }

  /** Milliseconds until one token is there; 0 means one is. */
  waitFor(now: number): number {
    this.refill(now);
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  take(now: number): void {
    this.refill(now);
    this.tokens -= 1;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.updatedAt = now;
  }
}
