import { describe, expect, it } from "vitest";
import { wrapWithSyncOutput } from "../TerminalInstanceService";

const DEC_2026_BEGIN = "\x1b[?2026h";
const DEC_2026_END = "\x1b[?2026l";
const DEC_2026_BEGIN_BYTES = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68];
const DEC_2026_END_BYTES = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c];

describe("wrapWithSyncOutput", () => {
  describe("string data", () => {
    it("wraps string with DEC 2026 begin and end sequences", () => {
      const result = wrapWithSyncOutput("hello world");
      expect(result).toBe(DEC_2026_BEGIN + "hello world" + DEC_2026_END);
    });

    it("wraps empty string", () => {
      const result = wrapWithSyncOutput("");
      expect(result).toBe(DEC_2026_BEGIN + DEC_2026_END);
    });

    it("wraps string containing escape sequences", () => {
      const data = "\x1b[31mred text\x1b[0m";
      const result = wrapWithSyncOutput(data);
      expect(result).toBe(DEC_2026_BEGIN + data + DEC_2026_END);
    });

    it("wraps string containing nested DEC 2026 sequences", () => {
      const data = "\x1b[?2026hagent output\x1b[?2026l";
      const result = wrapWithSyncOutput(data);
      expect(result).toBe(DEC_2026_BEGIN + data + DEC_2026_END);
    });
  });

  describe("Uint8Array data", () => {
    it("wraps Uint8Array with DEC 2026 begin and end byte sequences", () => {
      const input = new Uint8Array([0x41, 0x42, 0x43]); // "ABC"
      const result = wrapWithSyncOutput(input);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.byteLength).toBe(input.byteLength + 16);

      const bytes = Array.from(result as Uint8Array);
      expect(bytes.slice(0, 8)).toEqual(DEC_2026_BEGIN_BYTES);
      expect(bytes.slice(8, 11)).toEqual([0x41, 0x42, 0x43]);
      expect(bytes.slice(11, 19)).toEqual(DEC_2026_END_BYTES);
    });

    it("wraps empty Uint8Array", () => {
      const input = new Uint8Array(0);
      const result = wrapWithSyncOutput(input);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.byteLength).toBe(16);

      const bytes = Array.from(result as Uint8Array);
      expect(bytes.slice(0, 8)).toEqual(DEC_2026_BEGIN_BYTES);
      expect(bytes.slice(8, 16)).toEqual(DEC_2026_END_BYTES);
    });

    it("does not mutate the original Uint8Array", () => {
      const input = new Uint8Array([0x41, 0x42, 0x43]);
      const inputCopy = new Uint8Array(input);
      wrapWithSyncOutput(input);
      expect(Array.from(input)).toEqual(Array.from(inputCopy));
    });

    it("handles large Uint8Array payloads", () => {
      const input = new Uint8Array(65536);
      input.fill(0x58); // 'X'
      const result = wrapWithSyncOutput(input) as Uint8Array;

      expect(result.byteLength).toBe(65536 + 16);
      expect(Array.from(result.slice(0, 8))).toEqual(DEC_2026_BEGIN_BYTES);
      expect(result[8]).toBe(0x58);
      expect(result[65536 + 7]).toBe(0x58);
      expect(Array.from(result.slice(65536 + 8, 65536 + 16))).toEqual(DEC_2026_END_BYTES);
    });
  });
});
