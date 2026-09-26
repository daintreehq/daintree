/**
 * Bounded replay rings for terminal output sent to remote clients. Each
 * terminal keeps its most recent frames under a per-terminal byte cap, and
 * every ring on the host charges one shared budget so many terminals cannot
 * add up to unbounded memory. Eviction is oldest-first: a client whose resume
 * point has been evicted gets a snapshot reset instead of a replay.
 */

export const DEFAULT_TERMINAL_RING_BYTES = 4 * 1024 * 1024;
export const DEFAULT_TOTAL_RING_BYTES = 64 * 1024 * 1024;

// Per-frame bookkeeping, so a flood of tiny frames is still bounded.
const FRAME_OVERHEAD_BYTES = 64;

export interface RingFrame {
  seq: number;
  data: Uint8Array;
  /** The pty-host's byte count for the chunk (what acks settle). */
  bytes: number;
}

function frameCost(frame: RingFrame): number {
  return frame.data.byteLength + FRAME_OVERHEAD_BYTES;
}

export class RingBudget {
  private readonly rings = new Set<TerminalRing>();
  private total = 0;

  constructor(readonly capBytes: number = DEFAULT_TOTAL_RING_BYTES) {}

  get usedBytes(): number {
    return this.total;
  }

  /** @internal */
  register(ring: TerminalRing): void {
    this.rings.add(ring);
  }

  /** @internal */
  unregister(ring: TerminalRing): void {
    this.rings.delete(ring);
  }

  /** @internal */
  charge(delta: number): void {
    this.total += delta;
  }

  /** Evict from the largest rings until the host-wide total fits. */
  enforce(): void {
    while (this.total > this.capBytes) {
      let largest: TerminalRing | null = null;
      for (const ring of this.rings) {
        if (ring.length > 0 && (!largest || ring.sizeBytes > largest.sizeBytes)) largest = ring;
      }
      if (!largest) return;
      largest.evictOldest();
    }
  }
}

export class TerminalRing {
  private frames: RingFrame[] = [];
  private head = 0;
  private bytes = 0;

  constructor(
    private readonly capBytes: number,
    private readonly budget: RingBudget
  ) {
    budget.register(this);
  }

  get length(): number {
    return this.frames.length - this.head;
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  /** Seq of the oldest retained frame, or null when empty. */
  get firstSeq(): number | null {
    return this.length > 0 ? this.frames[this.head]!.seq : null;
  }

  push(frame: RingFrame): void {
    const last = this.length > 0 ? this.frames[this.frames.length - 1]! : null;
    if (last && frame.seq !== last.seq + 1) {
      // Frames are contiguous by construction; a jump means the caller reset
      // the sequence, and nothing older can be spliced onto it.
      this.clear();
    }
    this.frames.push(frame);
    const cost = frameCost(frame);
    this.bytes += cost;
    this.budget.charge(cost);
    while (this.bytes > this.capBytes && this.length > 0) this.evictOldest();
    this.budget.enforce();
  }

  get(seq: number): RingFrame | null {
    const first = this.firstSeq;
    if (first === null || seq < first) return null;
    return this.frames[this.head + (seq - first)] ?? null;
  }

  /** Whether every frame after `afterSeq` up to `currentSeq` is still held. */
  covers(afterSeq: number, currentSeq: number): boolean {
    if (afterSeq === currentSeq) return true;
    const first = this.firstSeq;
    return first !== null && first <= afterSeq + 1;
  }

  evictOldest(): void {
    if (this.length === 0) return;
    const frame = this.frames[this.head]!;
    this.frames[this.head] = undefined as unknown as RingFrame;
    this.head++;
    const cost = frameCost(frame);
    this.bytes -= cost;
    this.budget.charge(-cost);
    if (this.head > 1024 && this.head * 2 > this.frames.length) {
      this.frames = this.frames.slice(this.head);
      this.head = 0;
    }
  }

  clear(): void {
    this.budget.charge(-this.bytes);
    this.frames = [];
    this.head = 0;
    this.bytes = 0;
  }

  dispose(): void {
    this.clear();
    this.budget.unregister(this);
  }
}
