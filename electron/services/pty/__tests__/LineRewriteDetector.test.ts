import { describe, it, expect, beforeEach } from "vitest";
import {
  countLineRewrites,
  isStatusLineRewrite,
  LineRewriteDetector,
} from "../LineRewriteDetector.js";

describe("countLineRewrites", () => {
  it("returns 0 for normal text", () => {
    expect(countLineRewrites("hello world")).toBe(0);
  });

  it("counts CR not followed by LF", () => {
    expect(countLineRewrites("abc\rdef")).toBe(1);
  });

  it("ignores CR followed by LF", () => {
    expect(countLineRewrites("abc\r\ndef")).toBe(0);
  });

  it("counts multiple CR rewrites", () => {
    expect(countLineRewrites("a\rb\rc")).toBe(2);
  });

  it("counts ANSI erase line sequence", () => {
    expect(countLineRewrites("\x1b[2K")).toBe(1);
  });

  it("counts ANSI erase to end of line", () => {
    expect(countLineRewrites("\x1b[K")).toBe(1);
  });

  it("counts cursor up sequence", () => {
    expect(countLineRewrites("\x1b[A")).toBe(1);
  });

  it("counts cursor up with number", () => {
    expect(countLineRewrites("\x1b[3A")).toBe(1);
  });
});

describe("isStatusLineRewrite", () => {
  it("returns false for normal text", () => {
    expect(isStatusLineRewrite("hello world")).toBe(false);
  });

  it("returns false for text without rewrite indicators", () => {
    expect(isStatusLineRewrite("working on task")).toBe(false);
  });

  it("returns true for spinner with token count", () => {
    expect(isStatusLineRewrite("\r100 tokens")).toBe(true);
  });

  it("returns true for spinner with cost", () => {
    expect(isStatusLineRewrite("\r$0.05")).toBe(true);
  });

  it("returns true for rewrite with token count", () => {
    expect(isStatusLineRewrite("\r150 tokens used")).toBe(true);
  });

  it("returns true for braille spinner characters", () => {
    expect(isStatusLineRewrite("\r⠋ Working")).toBe(true);
  });

  it("returns true for esc to interrupt marker", () => {
    expect(isStatusLineRewrite("\resc to interrupt")).toBe(true);
  });

  it("returns false for CR at end of chunk", () => {
    expect(isStatusLineRewrite("text\r")).toBe(false);
  });

  it("returns false for rewrite with ordinary content", () => {
    expect(isStatusLineRewrite("\rhello world")).toBe(false);
  });

  it("returns false for ANSI erase with ordinary content", () => {
    expect(isStatusLineRewrite("\x1b[2Khello world")).toBe(false);
  });

  it("returns true for ANSI erase with status content", () => {
    expect(isStatusLineRewrite("\x1b[2K⠋ Working on task")).toBe(true);
  });

  it("returns true for new Claude spinner char ✢", () => {
    expect(isStatusLineRewrite("\r✢ Thinking…")).toBe(true);
  });

  it("returns true for new Claude spinner char ✶", () => {
    expect(isStatusLineRewrite("\r✶ Working…")).toBe(true);
  });

  it("returns true for Claude middle dot spinner", () => {
    expect(isStatusLineRewrite("\r· Deliberating…")).toBe(true);
  });

  it("returns true for new Claude spinner char ✳", () => {
    expect(isStatusLineRewrite("\r✳ Cogitating…")).toBe(true);
  });

  it("returns true for reduced-motion spinner ●", () => {
    expect(isStatusLineRewrite("\r● Processing…")).toBe(true);
  });

  it("returns true for ASCII asterisk spinner", () => {
    expect(isStatusLineRewrite("\r* Working…")).toBe(true);
  });
});

describe("LineRewriteDetector", () => {
  let detector: LineRewriteDetector;

  beforeEach(() => {
    detector = new LineRewriteDetector({
      enabled: true,
      windowMs: 500,
      minRewrites: 2,
    });
  });

  it("returns false when disabled", () => {
    const d = new LineRewriteDetector({ enabled: false });
    expect(d.update("a\rb", 1000)).toBe(false);
  });

  it("returns false for single rewrite below threshold", () => {
    expect(detector.update("a\rb", 1000)).toBe(false);
  });

  it("returns true when rewrite count meets threshold", () => {
    expect(detector.update("a\rb\rc", 1000)).toBe(true);
  });

  it("accumulates across calls within window", () => {
    detector.update("a\rb", 1000);
    expect(detector.update("c\rd", 1200)).toBe(true);
  });

  it("resets window after expiry", () => {
    detector.update("a\rb", 1000);
    expect(detector.update("c\rd", 1600)).toBe(false);
  });

  it("updates lastSpinnerDetectedAt on trigger", () => {
    detector.update("a\rb\rc", 1000);
    expect(detector.lastSpinnerDetectedAt).toBe(1000);
  });

  it("isSpinnerActive returns true within window", () => {
    detector.update("a\rb\rc", 1000);
    expect(detector.isSpinnerActive(1500, 1500)).toBe(true);
  });

  it("isSpinnerActive returns false after window", () => {
    detector.update("a\rb\rc", 1000);
    expect(detector.isSpinnerActive(3000, 1500)).toBe(false);
  });

  it("reset clears all state", () => {
    detector.update("a\rb\rc", 1000);
    detector.reset();
    expect(detector.lastSpinnerDetectedAt).toBe(0);
    expect(detector.isSpinnerActive(1000, 1500)).toBe(false);
  });
});
