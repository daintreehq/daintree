import { FRAME_HEADER_BYTES, LANE_COUNT, LANE_PRIORITY, Lane, type LinkFrame } from "./frames.js";

/**
 * Per-lane outbound queues drained in priority order.
 *
 * Each lane is bounded in bytes (payload plus frame header, so empty frames
 * still count) and in frames. `enqueue` reports `"over-high-water"` once a
 * lane passes its high-water mark; producers on lanes that can pause
 * (terminal output, bulk transfers) stop until `onDrain` fires for that lane,
 * and producers that cannot pause (events) drop the subscriber to a snapshot
 * resync instead of growing the queue. A frame that would take a lane past
 * its hard cap is refused outright — no exceptions, so a refused producer must
 * not wait for a drain that may never come.
 *
 * Control always goes first. Interactive traffic goes next but only for a
 * bounded burst while other lanes are waiting, so sustained terminal output
 * cannot starve request/response traffic indefinitely.
 */
export interface LaneLimits {
  highWaterBytes: number;
  hardCapBytes: number;
  maxFrames: number;
}

export const DEFAULT_LANE_LIMITS: Record<Lane, LaneLimits> = {
  [Lane.CONTROL]: { highWaterBytes: 256 * 1024, hardCapBytes: 1024 * 1024, maxFrames: 4096 },
  [Lane.RPC]: { highWaterBytes: 4 * 1024 * 1024, hardCapBytes: 32 * 1024 * 1024, maxFrames: 65536 },
  [Lane.EVENTS]: {
    highWaterBytes: 4 * 1024 * 1024,
    hardCapBytes: 16 * 1024 * 1024,
    maxFrames: 65536,
  },
  [Lane.INTERACTIVE]: {
    highWaterBytes: 4 * 1024 * 1024,
    hardCapBytes: 16 * 1024 * 1024,
    maxFrames: 65536,
  },
  [Lane.BULK]: { highWaterBytes: 2 * 1024 * 1024, hardCapBytes: 8 * 1024 * 1024, maxFrames: 1024 },
};

/** Interactive frames served back to back before one frame from a waiting lower lane. */
export const INTERACTIVE_BURST_FRAMES = 32;

export type EnqueueResult = "queued" | "over-high-water" | "refused";

interface LaneQueue {
  frames: LinkFrame[];
  head: number;
  bytes: number;
  wasOverHighWater: boolean;
}

function frameCost(frame: LinkFrame): number {
  return FRAME_HEADER_BYTES + frame.payload.byteLength;
}

export class LaneScheduler {
  private readonly lanes: LaneQueue[];
  private readonly drainListeners = new Set<(lane: Lane) => void>();
  private interactiveBurst = 0;

  constructor(private readonly limits: Record<Lane, LaneLimits> = DEFAULT_LANE_LIMITS) {
    this.lanes = Array.from({ length: LANE_COUNT }, () => ({
      frames: [],
      head: 0,
      bytes: 0,
      wasOverHighWater: false,
    }));
  }

  enqueue(frame: LinkFrame): EnqueueResult {
    const q = this.lanes[frame.lane]!;
    const cost = frameCost(frame);
    const { highWaterBytes, hardCapBytes, maxFrames } = this.limits[frame.lane];
    if (q.bytes + cost > hardCapBytes || q.frames.length - q.head >= maxFrames) return "refused";
    q.frames.push(frame);
    q.bytes += cost;
    if (q.bytes > highWaterBytes) {
      q.wasOverHighWater = true;
      return "over-high-water";
    }
    return "queued";
  }

  /** Next frame to write, or undefined when idle. */
  next(): LinkFrame | undefined {
    const lane = this.pickLane();
    if (lane === undefined) return undefined;
    if (lane === Lane.INTERACTIVE) this.interactiveBurst++;
    else if (lane !== Lane.CONTROL) this.interactiveBurst = 0;
    return this.shift(lane);
  }

  private hasFrames(lane: Lane): boolean {
    const q = this.lanes[lane]!;
    return q.head < q.frames.length;
  }

  private pickLane(): Lane | undefined {
    if (this.hasFrames(Lane.CONTROL)) return Lane.CONTROL;
    if (this.hasFrames(Lane.INTERACTIVE)) {
      if (this.interactiveBurst < INTERACTIVE_BURST_FRAMES) return Lane.INTERACTIVE;
      for (const lane of LANE_PRIORITY) {
        if (lane !== Lane.CONTROL && lane !== Lane.INTERACTIVE && this.hasFrames(lane)) return lane;
      }
      this.interactiveBurst = 0;
      return Lane.INTERACTIVE;
    }
    for (const lane of LANE_PRIORITY) {
      if (this.hasFrames(lane)) return lane;
    }
    return undefined;
  }

  private shift(lane: Lane): LinkFrame {
    const q = this.lanes[lane]!;
    const frame = q.frames[q.head]!;
    q.frames[q.head] = undefined as unknown as LinkFrame;
    q.head++;
    if (q.head === q.frames.length) {
      q.frames = [];
      q.head = 0;
    } else if (q.head > 1024 && q.head * 2 > q.frames.length) {
      q.frames = q.frames.slice(q.head);
      q.head = 0;
    }
    q.bytes -= frameCost(frame);
    if (q.wasOverHighWater && q.bytes <= this.limits[lane].highWaterBytes / 2) {
      q.wasOverHighWater = false;
      for (const cb of this.drainListeners) cb(lane);
    }
    return frame;
  }

  queuedBytes(lane: Lane): number {
    return this.lanes[lane]!.bytes;
  }

  get isEmpty(): boolean {
    return this.lanes.every((q) => q.head >= q.frames.length);
  }

  onDrain(cb: (lane: Lane) => void): () => void {
    this.drainListeners.add(cb);
    return () => this.drainListeners.delete(cb);
  }

  clear(): void {
    for (const q of this.lanes) {
      q.frames = [];
      q.head = 0;
      q.bytes = 0;
      q.wasOverHighWater = false;
    }
    this.interactiveBurst = 0;
  }
}
