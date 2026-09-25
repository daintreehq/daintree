import { describe, it, expect } from "vitest";
import {
  dropLeadingBytes,
  receiveStreamChunk,
  stripCoveredOutput,
  utf8Length,
  type StreamRange,
} from "../streamFence";

const encoder = new TextEncoder();

describe("streamFence", () => {
  it("measures strings in UTF-8 bytes, matching the host's counter", () => {
    for (const text of ["ascii", "é", "日本", "😀", "a😀é日"]) {
      expect(utf8Length(text)).toBe(encoder.encode(text).byteLength);
    }
  });

  it("drops a leading byte count at a character boundary in strings and bytes", () => {
    const head = "é😀";
    const text = `${head}tail`;
    const cut = encoder.encode(head).byteLength;
    expect(dropLeadingBytes(text, cut)).toBe("tail");
    expect(new TextDecoder().decode(dropLeadingBytes(encoder.encode(text), cut))).toBe("tail");
  });

  it("places consecutive chunks back to back in the stream", () => {
    const cursor = {};
    expect(receiveStreamChunk(cursor, "abc", 3)).toEqual({ start: 0, end: 3, epoch: 0 });
    expect(receiveStreamChunk(cursor, "dé", 6)).toEqual({ start: 3, end: 6, epoch: 0 });
  });

  it("moves to a new epoch and drops the fence when offsets go backwards", () => {
    const cursor: Parameters<typeof receiveStreamChunk>[0] = {};
    receiveStreamChunk(cursor, "abcdef", 6);
    cursor.streamFence = { offset: 6, epoch: 0 };
    // The process behind the id was replaced and its stream starts over.
    expect(receiveStreamChunk(cursor, "xy", 2)).toEqual({ start: 0, end: 2, epoch: 1 });
    expect(cursor.streamFence).toBeUndefined();
  });

  describe("stripCoveredOutput", () => {
    const range = (start: number, end: number, epoch = 0): StreamRange => ({ start, end, epoch });

    it("paints nothing of a chunk the fence covers, and keeps the fence", () => {
      const cursor = { streamFence: { offset: 10, epoch: 0 } };
      expect(stripCoveredOutput(cursor, "abc", range(4, 7))).toBe("");
      expect(cursor.streamFence).toEqual({ offset: 10, epoch: 0 });
    });

    it("paints the suffix of a chunk that straddles the fence, then retires it", () => {
      const cursor: { streamFence?: { offset: number; epoch: number } } = {
        streamFence: { offset: 5, epoch: 0 },
      };
      expect(stripCoveredOutput(cursor, "abcdef", range(2, 8))).toBe("def");
      expect(cursor.streamFence).toBeUndefined();
    });

    it("paints a chunk past the fence in full and retires it", () => {
      const cursor: { streamFence?: { offset: number; epoch: number } } = {
        streamFence: { offset: 5, epoch: 0 },
      };
      expect(stripCoveredOutput(cursor, "xyz", range(5, 8))).toBe("xyz");
      expect(cursor.streamFence).toBeUndefined();
    });

    it("leaves chunks with no offset, or from another epoch, untouched", () => {
      const cursor = { streamFence: { offset: 50, epoch: 0 } };
      expect(stripCoveredOutput(cursor, "abc", undefined)).toBe("abc");
      expect(stripCoveredOutput(cursor, "abc", range(0, 3, 1))).toBe("abc");
    });
  });
});
