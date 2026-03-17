import { describe, it, expect, beforeEach } from "vitest";
import { isBootComplete, BOOT_COMPLETE_PATTERNS, BootDetector } from "../BootDetector.js";

describe("isBootComplete", () => {
  it("returns false for unrelated text", () => {
    expect(isBootComplete("hello world", BOOT_COMPLETE_PATTERNS)).toBe(false);
  });

  it("detects Claude Code banner", () => {
    expect(isBootComplete("Claude Code v1.2.3", BOOT_COMPLETE_PATTERNS)).toBe(true);
  });

  it("detects OpenAI Codex", () => {
    expect(isBootComplete("OpenAI Codex ready", BOOT_COMPLETE_PATTERNS)).toBe(true);
  });

  it("detects Codex version", () => {
    expect(isBootComplete("Codex v2.0", BOOT_COMPLETE_PATTERNS)).toBe(true);
  });

  it("detects Gemini CLI ready prompt", () => {
    expect(isBootComplete("Type your message to begin", BOOT_COMPLETE_PATTERNS)).toBe(true);
  });

  it("uses custom patterns", () => {
    expect(isBootComplete("ready>", [/ready>/])).toBe(true);
    expect(isBootComplete("ready>", BOOT_COMPLETE_PATTERNS)).toBe(false);
  });
});

describe("BootDetector", () => {
  let detector: BootDetector;

  beforeEach(() => {
    detector = new BootDetector();
  });

  it("starts with hasExitedBootState false", () => {
    expect(detector.hasExitedBootState).toBe(false);
  });

  it("detects boot complete via pattern", () => {
    const result = detector.check("Claude Code v1.0", false, 0, 15000);
    expect(result).toBe(true);
    expect(detector.hasExitedBootState).toBe(true);
  });

  it("detects boot complete via prompt", () => {
    const result = detector.check("random text", true, 0, 15000);
    expect(result).toBe(true);
    expect(detector.hasExitedBootState).toBe(true);
  });

  it("detects boot complete via timeout", () => {
    const result = detector.check("random text", false, 15000, 15000);
    expect(result).toBe(true);
    expect(detector.hasExitedBootState).toBe(true);
  });

  it("returns false when still booting", () => {
    const result = detector.check("random text", false, 5000, 15000);
    expect(result).toBe(false);
    expect(detector.hasExitedBootState).toBe(false);
  });

  it("returns true immediately after boot exited", () => {
    detector.markExited();
    const result = detector.check("anything", false, 0, 15000);
    expect(result).toBe(true);
  });

  it("markExited sets hasExitedBootState", () => {
    detector.markExited();
    expect(detector.hasExitedBootState).toBe(true);
  });

  it("reset clears state", () => {
    detector.markExited();
    detector.pollingStartTime = 5000;
    detector.reset();
    expect(detector.hasExitedBootState).toBe(false);
    expect(detector.pollingStartTime).toBe(0);
  });

  it("uses custom patterns", () => {
    const custom = new BootDetector([/my-agent ready/]);
    expect(custom.check("my-agent ready", false, 0, 15000)).toBe(true);
    expect(new BootDetector([/my-agent ready/]).check("Claude Code v1.0", false, 0, 15000)).toBe(
      false
    );
  });
});
