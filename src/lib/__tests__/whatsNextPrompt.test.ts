import { describe, it, expect } from "vitest";
import { buildWhatsNextPrompt } from "../whatsNextPrompt";

describe("buildWhatsNextPrompt", () => {
  it("should return a simple, concise prompt without contractions", () => {
    const prompt = buildWhatsNextPrompt();
    expect(prompt).toContain("I am returning after a break");
    expect(prompt).toContain("1-6 high-impact parallel tasks");
    expect(prompt).toContain("do not overlap");
  });

  it("should include fallback for missing GitHub access", () => {
    const prompt = buildWhatsNextPrompt();
    expect(prompt).toContain("if GitHub issues are unavailable");
    expect(prompt).toContain("README, TODOs, and recent commits");
  });

  it("should be shell-safe (no problematic characters)", () => {
    const prompt = buildWhatsNextPrompt();
    // Check for characters that cause shell escaping issues
    expect(prompt).not.toContain("'"); // Single quotes
    expect(prompt).not.toContain("`"); // Backticks
    expect(prompt).not.toContain("$"); // Variable expansion
    expect(prompt).not.toContain("\\"); // Backslashes
    expect(prompt).not.toContain("{"); // JSON braces
    expect(prompt).not.toContain("}"); // JSON braces
    expect(prompt).not.toContain("\n"); // Newlines
    expect(prompt).not.toContain("\t"); // Tabs
  });

  it("should be a reasonable length (concise)", () => {
    const prompt = buildWhatsNextPrompt();
    expect(prompt.length).toBeLessThan(500);
    expect(prompt.split(" ").length).toBeLessThan(100);
  });

  it("should mention exploring GitHub issues and codebase", () => {
    const prompt = buildWhatsNextPrompt();
    expect(prompt).toContain("GitHub issues");
    expect(prompt).toContain("codebase");
  });

  it("should request parallel tasks that do not overlap", () => {
    const prompt = buildWhatsNextPrompt();
    expect(prompt).toContain("parallel tasks");
    expect(prompt).toContain("do not overlap");
  });
});
