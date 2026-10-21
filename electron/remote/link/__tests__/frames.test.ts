import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_FRAME_BYTES,
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

  describe("reassembly capacity", () => {
    const big = (n: number) => {
      const payload = new Uint8Array(n);
      for (let i = 0; i < n; i++) payload[i] = i & 0xff;
      return { lane: Lane.BULK, kind: 1, streamId: 3, payload };
    };
    // toEqual walks typed arrays entry by entry, which is far too slow at MiB sizes.
    const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

    it("releases oversized storage once small traffic settles after a large frame", () => {
      const d = new FrameDecoder();
      const [large] = d.push(encodeFrame(big(9 * 1024 * 1024)));
      expect(large!.payload.byteLength).toBe(9 * 1024 * 1024);
      expect(d.capacityBytes).toBeGreaterThanOrEqual(9 * 1024 * 1024);
      for (let i = 0; i < 100; i++) {
        const out = d.push(encodeFrame(frame(Lane.EVENTS, 1)));
        expect(out).toHaveLength(1);
      }
      expect(d.bufferedBytes).toBe(0);
      expect(d.capacityBytes).toBeLessThanOrEqual(128 * 1024);
      expect(sameBytes(large!.payload, big(9 * 1024 * 1024).payload)).toBe(true);
    });

    it("keeps the warmed buffer while large frames keep arriving", () => {
      const d = new FrameDecoder();
      d.push(encodeFrame(big(1024 * 1024)));
      const warmed = d.capacityBytes;
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 15; i++) d.push(encodeFrame(frame(Lane.CONTROL, 2)));
        expect(d.capacityBytes).toBe(warmed);
        d.push(encodeFrame(big(1024 * 1024)));
        expect(d.capacityBytes).toBe(warmed);
      }
    });

    it("shrinks on the sixteenth consecutive small frame, coalesced or not", () => {
      const small = encodeFrame(frame(Lane.RPC, 3));
      const a = new FrameDecoder();
      a.push(encodeFrame(big(1024 * 1024)));
      for (let i = 0; i < 15; i++) a.push(small);
      expect(a.capacityBytes).toBeGreaterThan(256 * 1024);
      a.push(small);
      expect(a.capacityBytes).toBe(128 * 1024);

      const b = new FrameDecoder();
      const out = b.push(
        Buffer.concat([encodeFrame(big(1024 * 1024)), ...Array.from({ length: 16 }, () => small)])
      );
      expect(out).toHaveLength(17);
      expect(sameBytes(out[0]!.payload, big(1024 * 1024).payload)).toBe(true);
      expect(b.capacityBytes).toBe(128 * 1024);
    });

    it("never shrinks under a partial frame and decodes it intact afterwards", () => {
      const d = new FrameDecoder();
      d.push(encodeFrame(big(1024 * 1024)));
      const small = encodeFrame(frame(Lane.RPC, 3));
      for (let i = 0; i < 15; i++) d.push(small);
      const next = encodeFrame(big(600 * 1024));
      // The sixteenth small frame shares a chunk with the head of a large frame.
      const out = d.push(Buffer.concat([small, next.subarray(0, 2)]));
      expect(out).toHaveLength(1);
      expect(d.bufferedBytes).toBe(2);
      expect(d.capacityBytes).toBe(128 * 1024);
      const rest = [...d.push(next.subarray(2, 5)), ...d.push(next.subarray(5))];
      expect(rest).toHaveLength(1);
      expect(sameBytes(rest[0]!.payload, big(600 * 1024).payload)).toBe(true);
    });

    it("counts frames of exactly the settled size as small and anything larger as large", () => {
      const settled = 128 * 1024 - FRAME_HEADER_BYTES;
      const d = new FrameDecoder();
      d.push(encodeFrame(big(1024 * 1024)));
      const warmed = d.capacityBytes;
      for (let i = 0; i < 15; i++) d.push(encodeFrame(big(settled)));
      d.push(encodeFrame(big(settled + 1)));
      expect(d.capacityBytes).toBe(warmed);
      for (let i = 0; i < 16; i++) d.push(encodeFrame(big(settled)));
      expect(d.capacityBytes).toBe(128 * 1024);
    });

    it("accepts a maximum legal frame and rejects one byte more", () => {
      const max = DEFAULT_MAX_FRAME_BYTES - FRAME_HEADER_BYTES;
      const d = new FrameDecoder();
      const [f] = d.push(encodeFrame(big(max)));
      expect(f!.payload.byteLength).toBe(max);
      const header = new Uint8Array(FRAME_HEADER_BYTES);
      new DataView(header.buffer).setUint32(0, DEFAULT_MAX_FRAME_BYTES - 3);
      expect(() => d.push(header)).toThrow(/invalid frame length/);
      expect(d.capacityBytes).toBe(0);
    });
  });
});
