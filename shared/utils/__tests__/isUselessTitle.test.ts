import { describe, it, expect } from "vitest";
import {
  isUselessTitle,
  normalizeObservedTitle,
  MAX_OBSERVED_TITLE_LENGTH,
} from "../isUselessTitle.js";

describe("isUselessTitle", () => {
  it("treats null/undefined/empty as useless", () => {
    expect(isUselessTitle(null)).toBe(true);
    expect(isUselessTitle(undefined)).toBe(true);
    expect(isUselessTitle("")).toBe(true);
    expect(isUselessTitle("   ")).toBe(true);
  });

  it("filters shell binary names", () => {
    expect(isUselessTitle("bash")).toBe(true);
    expect(isUselessTitle("zsh")).toBe(true);
    expect(isUselessTitle("fish")).toBe(true);
    expect(isUselessTitle("sh")).toBe(true);
    expect(isUselessTitle("cmd")).toBe(true);
    expect(isUselessTitle("powershell")).toBe(true);
    expect(isUselessTitle("pwsh")).toBe(true);
    expect(isUselessTitle("cmd.exe")).toBe(true);
    expect(isUselessTitle("Bash")).toBe(true);
  });

  it("filters agent binary names", () => {
    expect(isUselessTitle("claude")).toBe(true);
    expect(isUselessTitle("Claude")).toBe(true);
    expect(isUselessTitle("codex")).toBe(true);
    expect(isUselessTitle("gemini")).toBe(true);
  });

  it("filters path-like strings", () => {
    expect(isUselessTitle("/Users/alice/project")).toBe(true);
    expect(isUselessTitle("~/project")).toBe(true);
    expect(isUselessTitle("C:\\Users\\alice\\project")).toBe(true);
  });

  it("filters shell prompts", () => {
    expect(isUselessTitle("alice@host:~/project$ ")).toBe(true);
    expect(isUselessTitle("alice@host:~")).toBe(true);
    expect(isUselessTitle("root@box:~#")).toBe(true);
    expect(isUselessTitle("PS C:\\Users\\alice>")).toBe(true);
    expect(isUselessTitle("/home/user$")).toBe(true);
    expect(isUselessTitle("~$")).toBe(true);
  });

  it("keeps meaningful titles with trailing punctuation", () => {
    // Prompt-character heuristic should NOT reject these
    expect(isUselessTitle("Fix >")).toBe(false);
    expect(isUselessTitle("C#")).toBe(false);
    expect(isUselessTitle("Budget $")).toBe(false);
    expect(isUselessTitle("PR #5182 >")).toBe(false);
    expect(isUselessTitle("alice@example.com: OAuth notes")).toBe(false);
  });

  it("keeps meaningful titles", () => {
    expect(isUselessTitle("Fixing auth bug")).toBe(false);
    expect(isUselessTitle("Thinking about caching strategy")).toBe(false);
    expect(isUselessTitle("Running tests")).toBe(false);
    expect(isUselessTitle("✨ Applied patch")).toBe(false);
    expect(isUselessTitle("PR #5182 — Persist closed agent sessions")).toBe(false);
  });

  it("trims whitespace before evaluating", () => {
    expect(isUselessTitle("  claude  ")).toBe(true);
    expect(isUselessTitle("  Fixing bug  ")).toBe(false);
  });
});

describe("normalizeObservedTitle", () => {
  it("returns null for non-string, empty, or whitespace input", () => {
    expect(normalizeObservedTitle(undefined)).toBeNull();
    expect(normalizeObservedTitle(null)).toBeNull();
    expect(normalizeObservedTitle(42)).toBeNull();
    expect(normalizeObservedTitle({})).toBeNull();
    expect(normalizeObservedTitle("")).toBeNull();
    expect(normalizeObservedTitle("   ")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeObservedTitle("  hello  ")).toBe("hello");
  });

  it("clamps strings longer than the cap", () => {
    const huge = "A".repeat(MAX_OBSERVED_TITLE_LENGTH + 500);
    const result = normalizeObservedTitle(huge);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(MAX_OBSERVED_TITLE_LENGTH);
  });

  it("passes normal-length strings through unchanged", () => {
    expect(normalizeObservedTitle("Fixing auth bug")).toBe("Fixing auth bug");
  });
});
