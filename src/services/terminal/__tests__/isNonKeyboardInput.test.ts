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

  describe("navigation sequences (must match)", () => {
    it("matches arrow keys (normal mode)", () => {
      expect(isNonKeyboardInput("\x1b[A")).toBe(true);
      expect(isNonKeyboardInput("\x1b[B")).toBe(true);
      expect(isNonKeyboardInput("\x1b[C")).toBe(true);
      expect(isNonKeyboardInput("\x1b[D")).toBe(true);
    });

    it("matches arrow keys (application cursor mode)", () => {
      expect(isNonKeyboardInput("\x1bOA")).toBe(true);
      expect(isNonKeyboardInput("\x1bOB")).toBe(true);
      expect(isNonKeyboardInput("\x1bOC")).toBe(true);
      expect(isNonKeyboardInput("\x1bOD")).toBe(true);
    });

    it("matches Home/End (normal mode)", () => {
      expect(isNonKeyboardInput("\x1b[H")).toBe(true);
      expect(isNonKeyboardInput("\x1b[F")).toBe(true);
    });

    it("matches Home/End (application mode)", () => {
      expect(isNonKeyboardInput("\x1bOH")).toBe(true);
      expect(isNonKeyboardInput("\x1bOF")).toBe(true);
    });

    it("matches Page Up/Down", () => {
      expect(isNonKeyboardInput("\x1b[5~")).toBe(true);
      expect(isNonKeyboardInput("\x1b[6~")).toBe(true);
    });

    it("matches Insert and Forward Delete keys", () => {
      expect(isNonKeyboardInput("\x1b[2~")).toBe(true);
      expect(isNonKeyboardInput("\x1b[3~")).toBe(true);
    });

    it("matches F1–F4 (SS3 prefix)", () => {
      expect(isNonKeyboardInput("\x1bOP")).toBe(true);
      expect(isNonKeyboardInput("\x1bOQ")).toBe(true);
      expect(isNonKeyboardInput("\x1bOR")).toBe(true);
      expect(isNonKeyboardInput("\x1bOS")).toBe(true);
    });

    it("matches F5–F12 (tilde-terminated)", () => {
      expect(isNonKeyboardInput("\x1b[15~")).toBe(true); // F5
      expect(isNonKeyboardInput("\x1b[17~")).toBe(true); // F6
      expect(isNonKeyboardInput("\x1b[18~")).toBe(true); // F7
      expect(isNonKeyboardInput("\x1b[19~")).toBe(true); // F8
      expect(isNonKeyboardInput("\x1b[20~")).toBe(true); // F9
      expect(isNonKeyboardInput("\x1b[21~")).toBe(true); // F10
      expect(isNonKeyboardInput("\x1b[23~")).toBe(true); // F11
      expect(isNonKeyboardInput("\x1b[24~")).toBe(true); // F12
    });

    it("matches lone Escape", () => {
      expect(isNonKeyboardInput("\x1b")).toBe(true);
    });

    it("matches modifier-bearing arrow keys (Shift+Up, Ctrl+Left, etc.)", () => {
      expect(isNonKeyboardInput("\x1b[1;2A")).toBe(true); // Shift+Up
      expect(isNonKeyboardInput("\x1b[1;5C")).toBe(true); // Ctrl+Right
      expect(isNonKeyboardInput("\x1b[1;3D")).toBe(true); // Alt+Left
      expect(isNonKeyboardInput("\x1b[1;2H")).toBe(true); // Shift+Home
      expect(isNonKeyboardInput("\x1b[1;5F")).toBe(true); // Ctrl+End
    });

    it("matches modifier-bearing F-keys (Shift+F1, Ctrl+F5, etc.)", () => {
      expect(isNonKeyboardInput("\x1b[1;2P")).toBe(true); // Shift+F1
      expect(isNonKeyboardInput("\x1b[1;5Q")).toBe(true); // Ctrl+F2
      expect(isNonKeyboardInput("\x1b[15;2~")).toBe(true); // Shift+F5
      expect(isNonKeyboardInput("\x1b[24;5~")).toBe(true); // Ctrl+F12
    });

    it("matches modifier-bearing PgUp/PgDn/Insert/Delete", () => {
      expect(isNonKeyboardInput("\x1b[5;2~")).toBe(true); // Shift+PgUp
      expect(isNonKeyboardInput("\x1b[6;5~")).toBe(true); // Ctrl+PgDn
      expect(isNonKeyboardInput("\x1b[3;5~")).toBe(true); // Ctrl+Delete
      expect(isNonKeyboardInput("\x1b[2;2~")).toBe(true); // Shift+Insert
    });
  });

  describe("control characters (must match)", () => {
    it("matches Ctrl+C", () => {
      expect(isNonKeyboardInput("\x03")).toBe(true);
    });

    it("matches Ctrl+D", () => {
      expect(isNonKeyboardInput("\x04")).toBe(true);
    });

    it("matches Ctrl+L", () => {
      expect(isNonKeyboardInput("\x0c")).toBe(true);
    });

    it("matches Ctrl+Z", () => {
      expect(isNonKeyboardInput("\x1a")).toBe(true);
    });
  });

  describe("keyboard input (must NOT match)", () => {
    it("does NOT match printable characters", () => {
      expect(isNonKeyboardInput("a")).toBe(false);
      expect(isNonKeyboardInput("hello")).toBe(false);
      expect(isNonKeyboardInput(" ")).toBe(false);
    });

    it("does NOT match Enter", () => {
      expect(isNonKeyboardInput("\r")).toBe(false);
      expect(isNonKeyboardInput("\x0d")).toBe(false);
    });

    it("does NOT match Backspace", () => {
      expect(isNonKeyboardInput("\x7f")).toBe(false);
      expect(isNonKeyboardInput("\x08")).toBe(false);
    });

    it("does NOT match Tab", () => {
      expect(isNonKeyboardInput("\x09")).toBe(false);
    });

    it("does NOT match Alt+key sequences", () => {
      expect(isNonKeyboardInput("\x1ba")).toBe(false);
      expect(isNonKeyboardInput("\x1bb")).toBe(false);
      expect(isNonKeyboardInput("\x1bf")).toBe(false);
    });

    it("does NOT match bracketed paste delimiters", () => {
      expect(isNonKeyboardInput("\x1b[200~")).toBe(false);
      expect(isNonKeyboardInput("\x1b[201~")).toBe(false);
    });

    it("does NOT match Kitty keyboard protocol sequences", () => {
      expect(isNonKeyboardInput("\x1b[13;2u")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false for empty string", () => {
      expect(isNonKeyboardInput("")).toBe(false);
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
