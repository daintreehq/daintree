import { describe, expect, it } from "vitest";
import {
  FRAME_HEADER_BYTES,
  FrameDecoder,
  FrameProtocolError,
  Lane,
  encodeFrame,
} from "../frames.js";

const frame = (lane: Lane, n: number, streamId = 0) => ({
  lane,
  kind: 7,
  streamId,
  payload: new Uint8Array(n).fill(lane + 1),
});

describe("link frames", () => {
  it("round-trips frames split at every byte boundary", () => {
    const frames = [
      frame(Lane.CONTROL, 0),
      frame(Lane.INTERACTIVE, 5, 9),
      frame(Lane.BULK, 300, 0xfffffffe),
    ];
    const bytes = Buffer.concat(frames.map((f) => encodeFrame(f)));
    for (let split = 1; split < bytes.length; split++) {
      const d = new FrameDecoder();
      const out = [...d.push(bytes.subarray(0, split)), ...d.push(bytes.subarray(split))];
      expect(out.map((f) => [f.lane, f.kind, f.streamId, f.payload.length])).toEqual(
        frames.map((f) => [f.lane, f.kind, f.streamId, f.payload.length])
      );
      expect(d.bufferedBytes).toBe(0);
    }
  });

  it("decodes byte-at-a-time delivery", () => {
    const bytes = encodeFrame(frame(Lane.RPC, 17));
    const d = new FrameDecoder();
    const out = [];
    for (const b of bytes) out.push(...d.push(new Uint8Array([b])));
    expect(out).toHaveLength(1);
    expect(out[0]!.payload).toEqual(new Uint8Array(17).fill(Lane.RPC + 1));
  });

  it("refuses oversized frames when encoding and when decoding, then stays failed", () => {
    expect(() => encodeFrame(frame(Lane.BULK, 100), 64)).toThrow(FrameProtocolError);
    const d = new FrameDecoder(64);
    const header = new Uint8Array(FRAME_HEADER_BYTES);
    new DataView(header.buffer).setUint32(0, 1_000_000);
    expect(() => d.push(header)).toThrow(/invalid frame length/);
    expect(() => d.push(new Uint8Array(1))).toThrow(/already failed/);
  });

  it("rejects an unknown lane and a body shorter than the header", () => {
    const bad = encodeFrame(frame(Lane.RPC, 1));
    bad[4] = 9;
    expect(() => new FrameDecoder().push(bad)).toThrow(/invalid lane/);
    const short = new Uint8Array(8);
    new DataView(short.buffer).setUint32(0, 2);
    expect(() => new FrameDecoder().push(short)).toThrow(/invalid frame length/);
  });

  it("validates lane, kind and streamId when encoding", () => {
    expect(() =>
      encodeFrame({ lane: 5 as Lane, kind: 0, streamId: 0, payload: new Uint8Array() })
    ).toThrow();
    expect(() =>
      encodeFrame({ lane: Lane.RPC, kind: 256, streamId: 0, payload: new Uint8Array() })
    ).toThrow();
    expect(() =>
      encodeFrame({ lane: Lane.RPC, kind: 1, streamId: -1, payload: new Uint8Array() })
    ).toThrow();
  });
});
