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
 *
 * Within a lane, frames enqueued under a flow key (one terminal's output) take
 * turns with the lane's other flows, a frame each, and stay in order within
 * their flow. One terminal pouring out a build log then delays another's
 * keystroke echo by a frame per busy terminal, not by everything they have
 * queued. Frames with no key share one flow, so a lane that never names one is
 * plain FIFO.
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
/**
 * And interactive bytes, whichever comes first: terminal output arrives in
 * batches of 64 KiB and more, so 32 frames can be megabytes, seconds on a slow
 * link, with a request's answer waiting behind them.
 */
export const INTERACTIVE_BURST_BYTES = 128 * 1024;

export type EnqueueResult = "queued" | "over-high-water" | "refused";

interface FlowQueue {
  frames: LinkFrame[];
  head: number;
  bytes: number;
}

interface LaneQueue {
  flows: Map<string, FlowQueue>;
  /** Keys of the flows with frames, in turn order, from `turnsHead`. */
  turns: string[];
  turnsHead: number;
  frameCount: number;
  bytes: number;
  wasOverHighWater: boolean;
}

/** The flow of frames enqueued without a key. */
const SHARED_FLOW = "";

function emptyLane(): LaneQueue {
  return {
    flows: new Map(),
    turns: [],
    turnsHead: 0,
    frameCount: 0,
    bytes: 0,
    wasOverHighWater: false,
  };
}

function frameCost(frame: LinkFrame): number {
  return FRAME_HEADER_BYTES + frame.payload.byteLength;
}

export class LaneScheduler {
  private readonly lanes: LaneQueue[];
  private readonly drainListeners = new Set<(lane: Lane) => void>();
  private interactiveBurst = 0;
  private interactiveBurstBytes = 0;

  constructor(private readonly limits: Record<Lane, LaneLimits> = DEFAULT_LANE_LIMITS) {
    this.lanes = Array.from({ length: LANE_COUNT }, emptyLane);
  }

  /** `flow` names the stream the frame belongs to; frames of one flow leave in order. */
  enqueue(frame: LinkFrame, flow: string = SHARED_FLOW): EnqueueResult {
    const q = this.lanes[frame.lane]!;
    const cost = frameCost(frame);
    const { highWaterBytes, hardCapBytes, maxFrames } = this.limits[frame.lane];
    if (q.bytes + cost > hardCapBytes || q.frameCount >= maxFrames) return "refused";
    let fq = q.flows.get(flow);
    if (!fq) {
      fq = { frames: [], head: 0, bytes: 0 };
      q.flows.set(flow, fq);
      q.turns.push(flow);
    }
    fq.frames.push(frame);
    fq.bytes += cost;
    q.frameCount++;
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
    const frame = this.shift(lane);
    if (lane === Lane.INTERACTIVE) {
      this.interactiveBurst++;
      this.interactiveBurstBytes += frameCost(frame);
    } else if (lane !== Lane.CONTROL) {
      this.interactiveBurst = 0;
      this.interactiveBurstBytes = 0;
    }
    return frame;
  }

  private hasFrames(lane: Lane): boolean {
    return this.lanes[lane]!.frameCount > 0;
  }

  private pickLane(): Lane | undefined {
    if (this.hasFrames(Lane.CONTROL)) return Lane.CONTROL;
    if (this.hasFrames(Lane.INTERACTIVE)) {
      if (
        this.interactiveBurst < INTERACTIVE_BURST_FRAMES &&
        this.interactiveBurstBytes < INTERACTIVE_BURST_BYTES
      ) {
        return Lane.INTERACTIVE;
      }
      for (const lane of LANE_PRIORITY) {
        if (lane !== Lane.CONTROL && lane !== Lane.INTERACTIVE && this.hasFrames(lane)) return lane;
      }
      this.interactiveBurst = 0;
      this.interactiveBurstBytes = 0;
      return Lane.INTERACTIVE;
    }
    for (const lane of LANE_PRIORITY) {
      if (this.hasFrames(lane)) return lane;
    }
    return undefined;
  }

  private shift(lane: Lane): LinkFrame {
    const q = this.lanes[lane]!;
    const flow = q.turns[q.turnsHead]!;
    q.turnsHead++;
    if (q.turnsHead > 1024 && q.turnsHead * 2 > q.turns.length) {
      q.turns = q.turns.slice(q.turnsHead);
      q.turnsHead = 0;
    }
    const fq = q.flows.get(flow)!;
    const frame = fq.frames[fq.head]!;
    fq.frames[fq.head] = undefined as unknown as LinkFrame;
    fq.head++;
    fq.bytes -= frameCost(frame);
    if (fq.head === fq.frames.length) {
      // Drained: the flow gives up its turn until it has frames again.
      q.flows.delete(flow);
    } else {
      if (fq.head > 1024 && fq.head * 2 > fq.frames.length) {
        fq.frames = fq.frames.slice(fq.head);
        fq.head = 0;
      }
      q.turns.push(flow);
    }
    q.frameCount--;
    q.bytes -= frameCost(frame);
    if (q.wasOverHighWater && q.bytes <= this.limits[lane].highWaterBytes / 2) {
      q.wasOverHighWater = false;
      for (const cb of this.drainListeners) cb(lane);
    }
    return frame;
  }

  /** Bytes waiting in a lane, or in one flow of it. */
  queuedBytes(lane: Lane, flow?: string): number {
    const q = this.lanes[lane]!;
    return flow === undefined ? q.bytes : (q.flows.get(flow)?.bytes ?? 0);
  }

  get isEmpty(): boolean {
    return this.lanes.every((q) => q.frameCount === 0);
  }

  onDrain(cb: (lane: Lane) => void): () => void {
    this.drainListeners.add(cb);
    return () => this.drainListeners.delete(cb);
  }

  clear(): void {
    for (let lane = 0; lane < this.lanes.length; lane++) this.lanes[lane] = emptyLane();
    this.interactiveBurst = 0;
    this.interactiveBurstBytes = 0;
  }
}
