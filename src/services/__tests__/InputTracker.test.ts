import { describe, it, expect, beforeEach } from "vitest";
import { InputTracker, CLEAR_COMMANDS, MAX_TRACKED_INPUT_LENGTH } from "../clearCommandDetection";

describe("InputTracker", () => {
  let tracker: InputTracker;

  beforeEach(() => {
    tracker = new InputTracker();
  });

  describe("basic command detection", () => {
    it("detects clear command", () => {
      const results = tracker.process("clear\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });

    it("detects /clear command", () => {
      const results = tracker.process("/clear\n");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("/clear");
    });

    it("detects cls command", () => {
      const results = tracker.process("cls\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("cls");
    });

    it("detects non-clear command", () => {
      const results = tracker.process("ls -la\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(false);
      expect(results[0]!.command).toBe("ls -la");
    });

    it("does not detect partial clear command", () => {
      const results = tracker.process("clearance\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(false);
      expect(results[0]!.command).toBe("clearance");
    });
  });

  describe("multiple commands in one chunk", () => {
    it("detects all commands when multiple newlines present", () => {
      const results = tracker.process("clear\nls\n");
      expect(results).toHaveLength(2);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
      expect(results[1]!.isClear).toBe(false);
      expect(results[1]!.command).toBe("ls");
    });

    it("detects clear in middle of multiple commands", () => {
      const results = tracker.process("ls\rclear\recho done\r");
      expect(results).toHaveLength(3);
      expect(results[0]!.command).toBe("ls");
      expect(results[1]!.isClear).toBe(true);
      expect(results[1]!.command).toBe("clear");
      expect(results[2]!.command).toBe("echo done");
    });
  });

  describe("backspace handling", () => {
    it("handles backspace (DEL - 0x7f)", () => {
      const results = tracker.process("cleax\x7fr\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });

    it("handles backspace (BS - 0x08)", () => {
      const results = tracker.process("cleax\br\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });

    it("handles multiple backspaces", () => {
      const results = tracker.process("clearxxx\x7f\x7f\x7f\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });
  });

  describe("escape sequences", () => {
    it("resets buffer on arrow key (ESC[A)", () => {
      const results = tracker.process("clea\x1b[Aclear\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });

    it("resets buffer on arrow down (ESC[B)", () => {
      const results = tracker.process("text\x1b[Bclear\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });

    it("handles Home key (ESC[H)", () => {
      const results = tracker.process("text\x1b[Hclear\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });
  });

  describe("bracketed paste mode", () => {
    it("handles bracketed paste with clear command", () => {
      const results = tracker.process("\x1b[200~clear\x1b[201~\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });

    it("ignores newlines inside bracketed paste", () => {
      const results = tracker.process("\x1b[200~line1\nline2\x1b[201~\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(false);
      expect(results[0]!.command).toBe("line1\nline2");
    });

    it("does not trigger command on newline inside paste", () => {
      const results = tracker.process("\x1b[200~clear\nls\x1b[201~\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(false);
      expect(results[0]!.command).toBe("clear\nls");
    });
  });

  describe("control characters", () => {
    it("resets buffer on Ctrl+C (0x03)", () => {
      const results = tracker.process("clea\x03clear\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });

    it("resets buffer on Ctrl+D (0x04)", () => {
      const results = tracker.process("text\x04clear\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });
  });

  describe("reset functionality", () => {
    it("clears buffer on reset", () => {
      tracker.process("clear");
      tracker.reset();
      const results = tracker.process("\r");
      expect(results).toHaveLength(0);
    });

    it("resets bracketed paste state", () => {
      tracker.process("\x1b[200~text");
      tracker.reset();
      const results = tracker.process("\nmore\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.command).toBe("more");
    });
  });

  describe("edge cases", () => {
    it("returns empty array for empty input", () => {
      const results = tracker.process("");
      expect(results).toHaveLength(0);
    });

    it("returns empty array for input without newline", () => {
      const results = tracker.process("clear");
      expect(results).toHaveLength(0);
    });

    it("handles only whitespace", () => {
      const results = tracker.process("   \r");
      expect(results).toHaveLength(0);
    });

    it("trims whitespace from commands", () => {
      const results = tracker.process("  clear  \r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });
  });

  describe("buffer length cap", () => {
    it("caps tracked input at MAX_TRACKED_INPUT_LENGTH and keeps the prefix", () => {
      const input = "a".repeat(MAX_TRACKED_INPUT_LENGTH * 2);
      const results = tracker.process(input + "\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(false);
      expect(results[0]!.command).toBe("a".repeat(MAX_TRACKED_INPUT_LENGTH));
    });

    it("caps multi-line bracketed paste content", () => {
      const line = "x".repeat(1024) + "\n";
      const results = tracker.process("\x1b[200~" + line.repeat(10) + "\x1b[201~\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(false);
      expect(results[0]!.command!.length).toBeLessThanOrEqual(MAX_TRACKED_INPUT_LENGTH);
    });

    it("still detects a clear command after a capped command is submitted", () => {
      tracker.process("b".repeat(MAX_TRACKED_INPUT_LENGTH * 2) + "\r");
      const results = tracker.process("clear\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
    });

    it("does not report a false clear when backspacing leaves overflowed chars on the real line", () => {
      // "clear" + MAX x's: buffer holds "clear" + (MAX-5) x's, 5 chars overflow.
      tracker.process("clear" + "x".repeat(MAX_TRACKED_INPUT_LENGTH));
      // MAX-5 backspaces: real line is "clear" + 5 x's; pre-overflow-tracking
      // the buffer would have been sliced to exactly "clear" (false positive).
      const results = tracker.process("\x7f".repeat(MAX_TRACKED_INPUT_LENGTH - 5) + "\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(false);
      expect(results[0]!.command).toBe("clearxxxxx");
    });

    it("detects clear when an overflowed line is backspaced down to a genuine clear command", () => {
      tracker.process("clear" + "x".repeat(MAX_TRACKED_INPUT_LENGTH));
      const results = tracker.process("\x7f".repeat(MAX_TRACKED_INPUT_LENGTH) + "\r");
      expect(results).toHaveLength(1);
      expect(results[0]!.isClear).toBe(true);
      expect(results[0]!.command).toBe("clear");
    });
  });

  describe("CLEAR_COMMANDS set", () => {
    it("contains expected clear commands", () => {
      expect(CLEAR_COMMANDS.has("clear")).toBe(true);
      expect(CLEAR_COMMANDS.has("cls")).toBe(true);
      expect(CLEAR_COMMANDS.has("/clear")).toBe(true);
      expect(CLEAR_COMMANDS.has("/new")).toBe(true);
      expect(CLEAR_COMMANDS.has("/reset")).toBe(true);
    });
  });
});
