import { describe, it, expect } from "vitest";
import { isUselessTitle } from "../isUselessTitle.js";

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
    expect(isUselessTitle("some/path$")).toBe(true);
    expect(isUselessTitle("root@box#")).toBe(true);
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
