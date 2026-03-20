import { describe, it, expect } from "vitest";
import { classifyWaitingReason } from "../WaitingReasonClassifier.js";

describe("classifyWaitingReason", () => {
  describe("approval detection", () => {
    it("detects [y/N] approval pattern", () => {
      const lines = ["Some output", "Allow this tool? [y/N]"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("detects (y/n) approval pattern", () => {
      const lines = ["Run command? (y/n)"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("detects Allow keyword", () => {
      const lines = ["Allow this tool once"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("detects Approve keyword", () => {
      const lines = ["Approve Once"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("detects waiting for approval", () => {
      const lines = ["Waiting for approval..."];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("detects do you want to proceed", () => {
      const lines = ["Do you want to proceed with this change?"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("detects bypass permissions", () => {
      const lines = ["bypass permissions to continue"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("detects confirmation required", () => {
      const lines = ["confirmation required from you"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("approval takes priority over prompt detection", () => {
      const lines = ["Allow? [y/N]"];
      expect(classifyWaitingReason(lines, true)).toBe("approval");
    });

    it("approval takes priority over question", () => {
      const lines = ["Do you want to allow this tool? [y/N]"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });
  });

  describe("prompt detection", () => {
    it("returns prompt when isPromptDetected is true", () => {
      const lines = ["$ "];
      expect(classifyWaitingReason(lines, true)).toBe("prompt");
    });

    it("returns prompt as default when no patterns match", () => {
      const lines = ["some random output"];
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
    it("strips ANSI codes before matching approval", () => {
      const lines = ["\x1b[1m\x1b[33mAllow this tool?\x1b[0m [y/N]"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

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

    it("only scans last 5 non-empty lines for approval", () => {
      const lines = ["Allow this tool? [y/N]", "line 1", "line 2", "line 3", "line 4", "line 5"];
      // The approval line is pushed out of the last 5
      expect(classifyWaitingReason(lines, false)).not.toBe("approval");
    });
  });
});
