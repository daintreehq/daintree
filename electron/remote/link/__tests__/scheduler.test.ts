import { describe, expect, it } from "vitest";
import { Lane, type LinkFrame } from "../frames.js";
import { FRAME_HEADER_BYTES } from "../frames.js";
import {
  INTERACTIVE_BURST_BYTES,
  INTERACTIVE_BURST_FRAMES,
  LaneScheduler,
  type LaneLimits,
} from "../scheduler.js";

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

  it("serves a frame from the queue it was put in, counted there, with its own lane intact", () => {
    const roomy: LaneLimits = { highWaterBytes: 1e9, hardCapBytes: 1e9, maxFrames: 1e9 };
    const s = new LaneScheduler({ ...tight, [Lane.BULK]: roomy });
    const drained: Lane[] = [];
    s.onDrain((lane) => drained.push(lane));
    s.enqueue(f(Lane.RPC));
    s.enqueue(f(Lane.EVENTS));
    s.enqueue(f(Lane.BULK));
    const promoted = f(Lane.BULK, 8);
    expect(s.enqueue(promoted, undefined, undefined, Lane.CONTROL)).toBe("queued");
    expect(s.enqueue(f(Lane.BULK, 8), undefined, undefined, Lane.CONTROL)).toBe("over-high-water");
    expect(s.enqueue(f(Lane.BULK, 8), undefined, undefined, Lane.CONTROL)).toBe("refused");
    expect(s.queuedBytes(Lane.CONTROL)).toBe(16 + 2 * H);
    expect(s.queuedBytes(Lane.BULK)).toBe(1 + H);
    expect(s.next()).toBe(promoted);
    expect(promoted.lane).toBe(Lane.BULK);
    const order: number[] = [];
    for (let fr = s.next(); fr; fr = s.next()) order.push(fr.lane);
    expect(order).toEqual([Lane.BULK, Lane.RPC, Lane.EVENTS, Lane.BULK]);
    expect(drained).toEqual([Lane.CONTROL]);
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

  it("gives a waiting rpc frame a turn once large interactive frames pass the byte budget", () => {
    const s = new LaneScheduler();
    const big = 64 * 1024;
    for (let i = 0; i < 16; i++) s.enqueue(f(Lane.INTERACTIVE, big), `t${i % 3}`);
    s.enqueue(f(Lane.RPC));
    const order: number[] = [];
    for (let i = 0; i < 6; i++) order.push(s.next()!.lane);
    const rpcAt = order.indexOf(Lane.RPC);
    expect(rpcAt).toBeGreaterThan(0);
    // Served once the interactive bytes before it reached the budget, not after 32 frames.
    expect(rpcAt * (big + H)).toBeGreaterThanOrEqual(INTERACTIVE_BURST_BYTES);
    expect((rpcAt - 1) * (big + H)).toBeLessThan(INTERACTIVE_BURST_BYTES);
  });
});

describe("LaneScheduler endpoint closes (#15881)", () => {
  /** A frame told apart by its stream id. */
  const tagged = (lane: Lane, tag: number): LinkFrame => ({
    lane,
    kind: 1,
    streamId: tag,
    payload: new Uint8Array(1),
  });

  /** Serves everything ready, reporting each frame written as the session does. */
  function drain(s: LaneScheduler): number[] {
    const order: number[] = [];
    for (let fr = s.next(); fr; fr = s.next()) {
      order.push(fr.streamId);
      s.written(fr);
    }
    return order;
  }

  it("holds a close until its endpoint's earlier frames on every lane are written", () => {
    const s = new LaneScheduler();
    s.enqueue(tagged(Lane.RPC, 1), undefined, { endpointIds: ["e1"] });
    s.enqueue(tagged(Lane.INTERACTIVE, 2), undefined, { endpointIds: ["e1"] });
    s.enqueue(tagged(Lane.CONTROL, 3), undefined, { closes: "e1" });
    // Control traffic with no stake in the endpoint still goes first.
    s.enqueue(tagged(Lane.CONTROL, 4));
    expect(drain(s)).toEqual([4, 2, 1, 3]);
    expect(s.isEmpty).toBe(true);
  });

  it("waits for the transport to take a frame, not for the frame to be served", () => {
    const s = new LaneScheduler();
    s.enqueue(tagged(Lane.RPC, 1), undefined, { endpointIds: ["e1"] });
    s.enqueue(tagged(Lane.CONTROL, 2), undefined, { closes: "e1" });
    const served = s.next()!;
    expect(served.streamId).toBe(1);
    // Taken from the queue but not yet written (a write that threw, a shutdown).
    expect(s.next()).toBeUndefined();
    expect(s.isEmpty).toBe(false);
    s.written(served);
    expect(s.next()?.streamId).toBe(2);
  });

  it("closes at once when nothing of its endpoint is waiting, whatever other endpoints have queued", () => {
    const s = new LaneScheduler();
    s.enqueue(tagged(Lane.RPC, 1), undefined, { endpointIds: ["e2"] });
    s.enqueue(tagged(Lane.RPC, 2), undefined, { endpointIds: ["e1"] });
    s.written(s.next()!);
    s.written(s.next()!);
    s.enqueue(tagged(Lane.RPC, 3), undefined, { endpointIds: ["e2"] });
    s.enqueue(tagged(Lane.CONTROL, 4), undefined, { closes: "e1" });
    expect(drain(s)).toEqual([4, 3]);
  });

  it("keeps a reopen behind the held close, and frames after the close never hold it", () => {
    const s = new LaneScheduler();
    s.enqueue(tagged(Lane.RPC, 1), undefined, { endpointIds: ["e1"] });
    s.enqueue(tagged(Lane.CONTROL, 2), undefined, { closes: "e1" });
    s.enqueue(tagged(Lane.CONTROL, 3), undefined, { endpointIds: ["e1"] });
    s.enqueue(tagged(Lane.RPC, 4), undefined, { endpointIds: ["e1"] });
    s.enqueue(tagged(Lane.CONTROL, 5), undefined, { closes: "e1" });
    expect(drain(s)).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts held closes against their lane's limits, frames and bytes alike", () => {
    // Control holds two frames and calls one past high water; bytes never cap it.
    const s = new LaneScheduler({
      ...tight,
      [Lane.CONTROL]: { highWaterBytes: 1 + H, hardCapBytes: 1e6, maxFrames: 2 },
    });
    s.enqueue(tagged(Lane.RPC, 1), undefined, { endpointIds: ["e1"] });
    expect(s.enqueue(tagged(Lane.CONTROL, 2), undefined, { closes: "e1" })).toBe("queued");
    expect(s.enqueue(tagged(Lane.CONTROL, 3), undefined, { closes: "e1" })).toBe("over-high-water");
    expect(s.next()?.streamId).toBe(1);
    expect(s.enqueue(tagged(Lane.CONTROL, 4))).toBe("refused");
    expect(s.queuedBytes(Lane.CONTROL)).toBe(2 * (1 + H));
  });

  it("releases a frame held behind a close into the queue it was counted in", () => {
    const s = new LaneScheduler();
    s.enqueue(tagged(Lane.RPC, 1), undefined, { endpointIds: ["e1"] });
    s.enqueue(tagged(Lane.CONTROL, 2), undefined, { closes: "e1" });
    s.enqueue(tagged(Lane.BULK, 3), undefined, { endpointIds: ["e1"] }, Lane.CONTROL);
    expect(s.queuedBytes(Lane.CONTROL)).toBe(2 * (1 + H));
    expect(drain(s)).toEqual([1, 2, 3]);
    expect(s.queuedBytes(Lane.CONTROL)).toBe(0);
    expect(s.queuedBytes(Lane.BULK)).toBe(0);
    expect(s.isEmpty).toBe(true);
  });

  it("forgets what a closed session left unwritten", () => {
    const s = new LaneScheduler();
    s.enqueue(tagged(Lane.RPC, 1), undefined, { endpointIds: ["e1"] });
    s.enqueue(tagged(Lane.CONTROL, 2), undefined, { closes: "e1" });
    // Served but never written, as a session that closed mid-flush leaves it.
    const served = s.next()!;
    s.clear();
    expect(s.isEmpty).toBe(true);
    expect(s.queuedBytes(Lane.CONTROL)).toBe(0);
    s.written(served);
    s.enqueue(tagged(Lane.CONTROL, 3), undefined, { closes: "e1" });
    expect(drain(s)).toEqual([3]);
  });

  it("never holds a close behind a frame its lane refused", () => {
    const s = new LaneScheduler(tight);
    expect(s.enqueue(tagged(Lane.RPC, 1), undefined, { endpointIds: ["e1"] })).not.toBe("refused");
    const tooBig: LinkFrame = {
      ...tagged(Lane.RPC, 2),
      payload: new Uint8Array(limit.hardCapBytes),
    };
    expect(s.enqueue(tooBig, undefined, { endpointIds: ["e1"] })).toBe("refused");
    s.written(s.next()!);
    s.enqueue(tagged(Lane.CONTROL, 3), undefined, { closes: "e1" });
    expect(drain(s)).toEqual([3]);
  });
});
