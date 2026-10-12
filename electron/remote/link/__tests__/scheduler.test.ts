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

  it("puts one terminal's echo ahead of another terminal's backlog", () => {
    const s = new LaneScheduler();
    for (let i = 0; i < 200; i++) {
      s.enqueue(
        { lane: Lane.INTERACTIVE, kind: 1, streamId: i, payload: new Uint8Array(4096) },
        "build-log"
      );
    }
    s.enqueue(
      { lane: Lane.INTERACTIVE, kind: 1, streamId: 999, payload: new Uint8Array(1) },
      "shell"
    );
    const first = [s.next()!.streamId, s.next()!.streamId];
    expect(first).toContain(999);
  });

  it("takes flows a frame each and keeps every flow in its own order", () => {
    const s = new LaneScheduler();
    const frame = (id: number): LinkFrame => ({
      lane: Lane.INTERACTIVE,
      kind: 1,
      streamId: id,
      payload: new Uint8Array(),
    });
    for (const id of [1, 2, 3]) s.enqueue(frame(id), "a");
    for (const id of [11, 12]) s.enqueue(frame(id), "b");
    s.enqueue(frame(21));
    const order: number[] = [];
    for (let fr = s.next(); fr; fr = s.next()) order.push(fr.streamId);
    expect(order).toEqual([1, 11, 21, 2, 12, 3]);
    expect(s.isEmpty).toBe(true);
  });

  it("counts every flow against the lane's bytes, frame cap and drain", () => {
    const s = new LaneScheduler(tight);
    const drained: Lane[] = [];
    s.onDrain((lane) => drained.push(lane));
    expect(s.enqueue(f(Lane.INTERACTIVE, 8), "a")).toBe("queued");
    expect(s.enqueue(f(Lane.INTERACTIVE, 8), "b")).toBe("over-high-water");
    expect(s.enqueue(f(Lane.INTERACTIVE, 8), "c")).toBe("refused");
    expect(s.queuedBytes(Lane.INTERACTIVE)).toBe(16 + 2 * H);
    s.next();
    s.next();
    expect(drained).toEqual([Lane.INTERACTIVE]);

    const capped = new LaneScheduler({
      ...tight,
      3: { highWaterBytes: 1e9, hardCapBytes: 1e9, maxFrames: 2 },
    });
    capped.enqueue(f(Lane.INTERACTIVE, 0), "a");
    capped.enqueue(f(Lane.INTERACTIVE, 0), "b");
    expect(capped.enqueue(f(Lane.INTERACTIVE, 0), "c")).toBe("refused");
  });

  it("keeps turns fair and in order across thousands of flows", () => {
    const s = new LaneScheduler({
      ...tight,
      3: { highWaterBytes: 1e9, hardCapBytes: 1e9, maxFrames: 1e6 },
    });
    const flows = 5000;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < flows; i++) {
        s.enqueue(
          {
            lane: Lane.INTERACTIVE,
            kind: 1,
            streamId: round * flows + i,
            payload: new Uint8Array(),
          },
          `t${i}`
        );
      }
    }
    const seen: number[] = [];
    for (let fr = s.next(); fr; fr = s.next()) seen.push(fr.streamId);
    expect(seen).toHaveLength(3 * flows);
    // Every flow's first frame leaves before any flow's second.
    expect(Math.max(...seen.slice(0, flows))).toBeLessThan(flows);
    expect(s.isEmpty).toBe(true);
  });
});
