import { describe, expect, it } from "vitest";
import { Lane, type LinkFrame } from "../frames.js";
import { FRAME_HEADER_BYTES } from "../frames.js";
import { INTERACTIVE_BURST_FRAMES, LaneScheduler, type LaneLimits } from "../scheduler.js";

const f = (lane: Lane, size = 1): LinkFrame => ({
  lane,
  kind: 1,
  streamId: 0,
  payload: new Uint8Array(size),
});

const H = FRAME_HEADER_BYTES;
const limit: LaneLimits = { highWaterBytes: 10 + 2 * H, hardCapBytes: 20 + 2 * H, maxFrames: 100 };
const tight: Record<Lane, LaneLimits> = { 0: limit, 1: limit, 2: limit, 3: limit, 4: limit };

describe("LaneScheduler", () => {
  it("drains control, then interactive, then rpc, events and bulk", () => {
    const s = new LaneScheduler();
    s.enqueue(f(Lane.BULK));
    s.enqueue(f(Lane.EVENTS));
    s.enqueue(f(Lane.RPC));
    s.enqueue(f(Lane.INTERACTIVE));
    s.enqueue(f(Lane.CONTROL));
    const order: number[] = [];
    for (let fr = s.next(); fr; fr = s.next()) order.push(fr.lane);
    expect(order).toEqual([Lane.CONTROL, Lane.INTERACTIVE, Lane.RPC, Lane.EVENTS, Lane.BULK]);
    expect(s.isEmpty).toBe(true);
  });

  it("lets a keystroke overtake a queued bulk transfer", () => {
    const s = new LaneScheduler();
    for (let i = 0; i < 100; i++) s.enqueue(f(Lane.BULK, 1024));
    s.next();
    s.enqueue(f(Lane.INTERACTIVE));
    expect(s.next()!.lane).toBe(Lane.INTERACTIVE);
  });

  it("keeps FIFO order within a lane", () => {
    const s = new LaneScheduler();
    for (let i = 0; i < 3000; i++)
      s.enqueue({ lane: Lane.RPC, kind: 1, streamId: i, payload: new Uint8Array() });
    for (let i = 0; i < 3000; i++) expect(s.next()!.streamId).toBe(i);
  });

  it("reports high water, refuses past the hard cap, and fires drain at half high water", () => {
    const s = new LaneScheduler(tight);
    const drained: Lane[] = [];
    s.onDrain((lane) => drained.push(lane));
    expect(s.enqueue(f(Lane.BULK, 8))).toBe("queued");
    expect(s.enqueue(f(Lane.BULK, 8))).toBe("over-high-water");
    expect(s.enqueue(f(Lane.BULK, 8))).toBe("refused");
    expect(s.queuedBytes(Lane.BULK)).toBe(16 + 2 * H);
    s.next();
    expect(drained).toEqual([]);
    s.next();
    expect(drained).toEqual([Lane.BULK]);
  });

  it("refuses a frame over the hard cap even into an empty lane", () => {
    const s = new LaneScheduler(tight);
    expect(s.enqueue(f(Lane.RPC, 50))).toBe("refused");
  });

  it("charges header bytes and caps frame count, so empty frames can't flood a lane", () => {
    const s = new LaneScheduler({
      ...tight,
      2: { highWaterBytes: 1e9, hardCapBytes: 1e9, maxFrames: 3 },
    });
    for (let i = 0; i < 3; i++) expect(s.enqueue(f(Lane.EVENTS, 0))).not.toBe("refused");
    expect(s.enqueue(f(Lane.EVENTS, 0))).toBe("refused");
    expect(s.queuedBytes(Lane.EVENTS)).toBe(3 * H);
  });

  it("gives a waiting rpc frame a turn during sustained interactive output", () => {
    const s = new LaneScheduler();
    for (let i = 0; i < INTERACTIVE_BURST_FRAMES * 3; i++) s.enqueue(f(Lane.INTERACTIVE));
    s.enqueue(f(Lane.RPC));
    const order: number[] = [];
    for (let i = 0; i <= INTERACTIVE_BURST_FRAMES; i++) order.push(s.next()!.lane);
    expect(order.slice(0, INTERACTIVE_BURST_FRAMES).every((l) => l === Lane.INTERACTIVE)).toBe(
      true
    );
    expect(order[INTERACTIVE_BURST_FRAMES]).toBe(Lane.RPC);
  });
});
