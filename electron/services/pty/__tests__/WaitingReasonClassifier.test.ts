import { describe, it, expect } from "vitest";
import { classifyWaitingReason } from "../WaitingReasonClassifier.js";

describe("classifyWaitingReason", () => {
  describe("prompt detection", () => {
    it("returns prompt when isPromptDetected is true", () => {
      const lines = ["$ "];
      expect(classifyWaitingReason(lines, true)).toBe("prompt");
    });

    it("returns prompt as default when no patterns match", () => {
      const lines = ["some random output"];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });

    it("returns prompt for y/n patterns (no approval classification)", () => {
      const lines = ["Allow this tool? [y/N]"];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });

    it("returns prompt for approval-like text", () => {
      const lines = ["Waiting for approval..."];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });
  });

  describe("question detection", () => {
    it("detects line ending with question mark", () => {
      const lines = ["What file would you like me to edit?"];
      expect(classifyWaitingReason(lines, false)).toBe("question");
    });

    it("detects Wh-word questions without question mark", () => {
      const lines = ["Which approach do you prefer"];
      expect(classifyWaitingReason(lines, false)).toBe("question");
    });

    it("detects Should questions", () => {
      const lines = ["Should I continue with this approach"];
      expect(classifyWaitingReason(lines, false)).toBe("question");
    });

    it("suppresses question detection for help text", () => {
      const lines = ["Usage: command [options]", "What does this do?"];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });

    it("suppresses question detection for error output", () => {
      const lines = ["Error: something failed", "What went wrong?"];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });

    it("prompt takes priority over question", () => {
      const lines = ["What file?", "$ "];
      expect(classifyWaitingReason(lines, true)).toBe("prompt");
    });
  });

  describe("ANSI stripping", () => {
    it("strips ANSI codes before matching question", () => {
      const lines = ["\x1b[36mWhat would you like to do?\x1b[0m"];
      expect(classifyWaitingReason(lines, false)).toBe("question");
    });
  });

  describe("edge cases", () => {
    it("handles empty lines array", () => {
      expect(classifyWaitingReason([], false)).toBe("prompt");
    });

    it("handles lines with only whitespace", () => {
      const lines = ["  ", "  ", "  "];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });
  });
});
