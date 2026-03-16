import { describe, it, expect } from "vitest";
import { isNonKeyboardInput } from "../TerminalInstanceService";

describe("isNonKeyboardInput", () => {
  describe("mouse sequences", () => {
    it("detects X10/Normal mouse sequences (\\x1b[M + 3 bytes)", () => {
      expect(isNonKeyboardInput("\x1b[M #!")).toBe(true);
      expect(isNonKeyboardInput("\x1b[M\x00\x20\x21")).toBe(true);
    });

    it("detects SGR mouse sequences (\\x1b[< ... M or m)", () => {
      expect(isNonKeyboardInput("\x1b[<0;12;8M")).toBe(true);
      expect(isNonKeyboardInput("\x1b[<0;12;8m")).toBe(true);
      expect(isNonKeyboardInput("\x1b[<35;120;45M")).toBe(true);
    });

    it("detects URXVT mouse sequences (\\x1b[ digits;digits;digits M)", () => {
      expect(isNonKeyboardInput("\x1b[64;12;8M")).toBe(true);
      expect(isNonKeyboardInput("\x1b[32;1;1M")).toBe(true);
    });
  });

  describe("focus reports", () => {
    it("detects focus-in report (\\x1b[I)", () => {
      expect(isNonKeyboardInput("\x1b[I")).toBe(true);
    });

    it("detects focus-out report (\\x1b[O)", () => {
      expect(isNonKeyboardInput("\x1b[O")).toBe(true);
    });
  });

  describe("keyboard input (must NOT match)", () => {
    it("does NOT match arrow keys", () => {
      expect(isNonKeyboardInput("\x1b[A")).toBe(false);
      expect(isNonKeyboardInput("\x1b[B")).toBe(false);
      expect(isNonKeyboardInput("\x1b[C")).toBe(false);
      expect(isNonKeyboardInput("\x1b[D")).toBe(false);
    });

    it("does NOT match function keys", () => {
      expect(isNonKeyboardInput("\x1b[15~")).toBe(false);
      expect(isNonKeyboardInput("\x1b[17~")).toBe(false);
    });

    it("does NOT match Home/End/PgUp/PgDn", () => {
      expect(isNonKeyboardInput("\x1b[H")).toBe(false);
      expect(isNonKeyboardInput("\x1b[F")).toBe(false);
      expect(isNonKeyboardInput("\x1b[5~")).toBe(false);
      expect(isNonKeyboardInput("\x1b[6~")).toBe(false);
    });

    it("does NOT match printable characters", () => {
      expect(isNonKeyboardInput("a")).toBe(false);
      expect(isNonKeyboardInput("hello")).toBe(false);
      expect(isNonKeyboardInput("\r")).toBe(false);
      expect(isNonKeyboardInput(" ")).toBe(false);
    });

    it("does NOT match control characters", () => {
      expect(isNonKeyboardInput("\x03")).toBe(false);
      expect(isNonKeyboardInput("\x04")).toBe(false);
      expect(isNonKeyboardInput("\x1a")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false for empty string", () => {
      expect(isNonKeyboardInput("")).toBe(false);
    });

    it("returns false for lone ESC character", () => {
      expect(isNonKeyboardInput("\x1b")).toBe(false);
    });

    it("returns false for incomplete CSI prefix", () => {
      expect(isNonKeyboardInput("\x1b[")).toBe(false);
    });

    it("does NOT match CSI sequences with wrong terminators", () => {
      expect(isNonKeyboardInput("\x1b[32;1;1K")).toBe(false);
      expect(isNonKeyboardInput("\x1b[32;1;1m")).toBe(false);
    });
  });
});
