import { describe, it, expect } from "vitest";
import { dropLeadingBytes, streamRangeOf, stripCoveredOutput, utf8Length } from "../streamFence";

const encoder = new TextEncoder();
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const painted = (paint: string | Uint8Array) => (typeof paint === "string" ? paint : decode(paint));

describe("streamFence", () => {
  it("measures strings in the UTF-8 bytes the host counts, lone surrogates included", () => {
    for (const text of [
      "ascii",
      "é",
      "日本",
      "😀",
      "a😀é日",
      "\ud83d",
      "x\ude00y",
      "\ud83d\ud83d",
    ]) {
      expect(utf8Length(text), JSON.stringify(text)).toBe(encoder.encode(text).byteLength);
    }
  });

  it("drops a leading byte count at a character boundary in strings and bytes", () => {
    const head = "é😀";
    const text = `${head}tail`;
    const cut = encoder.encode(head).byteLength;
    expect(dropLeadingBytes(text, cut)).toBe("tail");
    expect(decode(dropLeadingBytes(encoder.encode(text), cut))).toBe("tail");
  });

  it("places a chunk in the stream from its end offset alone", () => {
    expect(streamRangeOf("dé", 6)).toEqual({ start: 3, end: 6 });
    expect(streamRangeOf(encoder.encode("dé"), 6)).toEqual({ start: 3, end: 6 });
    expect(streamRangeOf("dé", undefined)).toBeUndefined();
  });

  describe("stripCoveredOutput", () => {
    it("paints nothing of a chunk the fence covers, through a truthy write entry", () => {
      // An empty string would end xterm's flushSync drain and discard every
      // write queued behind it.
      for (const data of ["abc", encoder.encode("abc")]) {
        expect(stripCoveredOutput(10, data, { start: 7, end: 10 })).toEqual(new Uint8Array(0));
      }
    });

    it("paints the suffix past the fence of a straddling chunk, strings and bytes alike", () => {
      const text = "é😀 tail";
      const cut = encoder.encode("é😀").byteLength;
      const range = streamRangeOf(text, 100 + encoder.encode(text).byteLength)!;
      const fence = range.start + cut;
      expect(painted(stripCoveredOutput(fence, text, range))).toBe(" tail");
      expect(painted(stripCoveredOutput(fence, encoder.encode(text), range))).toBe(" tail");
    });

    it("paints a chunk starting at or past the fence in full", () => {
      expect(stripCoveredOutput(5, "xyz", { start: 5, end: 8 })).toBe("xyz");
    });

    it("keeps covering late chunks after later output has already arrived", () => {
      // A chunk that took the other transport can land after its successor.
      expect(stripCoveredOutput(10, "new", { start: 10, end: 13 })).toBe("new");
      expect(stripCoveredOutput(10, "old", { start: 7, end: 10 })).toEqual(new Uint8Array(0));
    });

    it("leaves chunks untouched without a fence or an offset", () => {
      expect(stripCoveredOutput(undefined, "abc", { start: 0, end: 3 })).toBe("abc");
      expect(stripCoveredOutput(50, "abc", undefined)).toBe("abc");
    });
  });
});
