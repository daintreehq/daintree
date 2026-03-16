import { describe, it, expect, beforeEach } from "vitest";
import { InputTracker } from "../InputTracker.js";

describe("InputTracker", () => {
  let tracker: InputTracker;

  beforeEach(() => {
    tracker = new InputTracker();
  });

  describe("process", () => {
    it("ignores soft newline sequences", () => {
      const result = tracker.process("\x1b\r", 1000);
      expect(result.kind).toBe("ignored");
    });

    it("returns no-enter for non-enter input", () => {
      const result = tracker.process("abc", 1000);
      expect(result.kind).toBe("no-enter");
    });

    it("returns enter with hadText=false for empty Enter", () => {
      const result = tracker.process("\r", 1000);
      expect(result).toEqual({ kind: "enter", hadText: false });
    });

    it("returns enter with hadText=true after typing", () => {
      tracker.process("abc", 1000);
      const result = tracker.process("\r", 1001);
      expect(result).toEqual({ kind: "enter", hadText: true });
    });

    it("tracks backspace reducing char count", () => {
      tracker.process("abc", 1000);
      tracker.process("\x7f\x7f\x7f", 1001);
      const result = tracker.process("\r", 1002);
      expect(result).toEqual({ kind: "enter", hadText: false });
    });

    it("tracks Ctrl-U clearing input", () => {
      tracker.process("abc", 1000);
      tracker.process("\x15", 1001);
      const result = tracker.process("\r", 1002);
      expect(result).toEqual({ kind: "enter", hadText: false });
    });

    it("tracks Ctrl-W clearing input", () => {
      tracker.process("abc", 1000);
      tracker.process("\x17", 1001);
      const result = tracker.process("\r", 1002);
      expect(result).toEqual({ kind: "enter", hadText: false });
    });

    it("handles bracketed paste mode", () => {
      // Start paste
      tracker.process("\x1b[200~hello world\x1b[201~", 1000);
      // The paste content doesn't count as typed characters for the Enter check
      // but the paste itself counts as input
      const result = tracker.process("\r", 1001);
      expect(result).toEqual({ kind: "enter", hadText: true });
    });

    it("exits bracketed paste after timeout", () => {
      tracker.process("\x1b[200~", 1000);
      // Paste timeout is 5000ms
      const result = tracker.process("x", 7000);
      // After timeout, paste mode exits
      expect(tracker.process("\r", 7001)).toEqual({ kind: "enter", hadText: true });
    });

    it("handles escape sequences in input", () => {
      // Arrow key sequence
      const result = tracker.process("\x1b[A", 1000);
      expect(result.kind).toBe("no-enter");
    });

    it("handles partial escape sequences across calls", () => {
      tracker.process("\x1b", 1000);
      // Next call should prepend the partial
      const result = tracker.process("[A", 1001);
      expect(result.kind).toBe("no-enter");
    });

    it("resets pendingInputChars on Enter", () => {
      tracker.process("abc", 1000);
      tracker.process("\r", 1001);
      // After Enter, chars should be 0
      const result = tracker.process("\r", 1002);
      expect(result).toEqual({ kind: "enter", hadText: false });
    });

    it("updates lastUserInputAt", () => {
      tracker.process("a", 5000);
      expect(tracker.lastUserInputAt).toBe(5000);
    });
  });

  describe("isRecentUserInput", () => {
    it("returns false when no input was sent", () => {
      expect(tracker.isRecentUserInput(1000)).toBe(false);
    });

    it("returns true within echo window", () => {
      tracker.process("a", 1000);
      expect(tracker.isRecentUserInput(1500)).toBe(true);
    });

    it("returns false after echo window expires", () => {
      tracker.process("a", 1000);
      expect(tracker.isRecentUserInput(2500)).toBe(false);
    });
  });

  describe("isLikelyUserEcho", () => {
    it("returns false when no recent input", () => {
      expect(tracker.isLikelyUserEcho("a", 1000)).toBe(false);
    });

    it("returns true for small printable data after recent input", () => {
      tracker.process("a", 1000);
      expect(tracker.isLikelyUserEcho("a", 1100)).toBe(true);
    });

    it("returns false if data contains escape sequences", () => {
      tracker.process("a", 1000);
      expect(tracker.isLikelyUserEcho("\x1b[31m", 1100)).toBe(false);
    });

    it("returns false if data contains newlines", () => {
      tracker.process("a", 1000);
      expect(tracker.isLikelyUserEcho("a\n", 1100)).toBe(false);
    });

    it("returns false for large data", () => {
      tracker.process("a", 1000);
      expect(tracker.isLikelyUserEcho("a".repeat(30), 1100)).toBe(false);
    });

    it("returns false during pending input confirmation", () => {
      tracker.pendingInputUntil = 2000;
      tracker.process("a", 1000);
      expect(tracker.isLikelyUserEcho("a", 1100)).toBe(false);
    });

    it("returns false for control characters", () => {
      tracker.process("a", 1000);
      expect(tracker.isLikelyUserEcho("\x01", 1100)).toBe(false);
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      tracker.process("abc", 1000);
      tracker.pendingInputUntil = 2000;
      tracker.pendingInputWasNonEmpty = true;
      tracker.reset();
      expect(tracker.lastUserInputAt).toBe(0);
      expect(tracker.pendingInputUntil).toBe(0);
      expect(tracker.pendingInputWasNonEmpty).toBe(false);
    });
  });

  describe("findEscapeSequenceEnd", () => {
    it("returns null for non-escape", () => {
      expect(InputTracker.findEscapeSequenceEnd("abc")).toBeNull();
    });

    it("returns null for incomplete CSI", () => {
      expect(InputTracker.findEscapeSequenceEnd("\x1b[")).toBeNull();
    });

    it("parses CSI sequence", () => {
      expect(InputTracker.findEscapeSequenceEnd("\x1b[A")).toBe(3);
    });

    it("parses OSC sequence with BEL", () => {
      // \x1b ] 0 ; t i t l e \x07 = indices 0-9, end at 10
      expect(InputTracker.findEscapeSequenceEnd("\x1b]0;title\x07")).toBe(10);
    });

    it("parses OSC sequence with ST", () => {
      // \x1b ] 0 ; t i t l e \x1b \ — ST at index 9, end = 9+2 = 11
      expect(InputTracker.findEscapeSequenceEnd("\x1b]0;title\x1b\\")).toBe(11);
    });

    it("parses DCS sequence", () => {
      // \x1b P d a t a \x1b \ = indices 0-7, end at 9 (accounting for the 2-char ST)
      expect(InputTracker.findEscapeSequenceEnd("\x1bPdata\x1b\\")).toBe(8);
    });

    it("parses single-char escape", () => {
      expect(InputTracker.findEscapeSequenceEnd("\x1bM")).toBe(2);
    });
  });
});
