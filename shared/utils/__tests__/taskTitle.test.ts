import { describe, it, expect } from "vitest";
import { cleanTaskTitle, stripIdentityAffixes } from "../taskTitle.js";

describe("cleanTaskTitle", () => {
  it("strips Claude's leading spinner glyph", () => {
    expect(cleanTaskTitle("✳ Explore possible solution approach")).toBe(
      "Explore possible solution approach"
    );
  });

  it("strips each glyph of Claude's spinner set", () => {
    for (const glyph of ["·", "✢", "✳", "✶", "✻", "✽", "●", "✼", "✾", "⟡", "◇", "◆", "○"]) {
      expect(cleanTaskTitle(`${glyph} fix auth bug`)).toBe("fix auth bug");
    }
  });

  it("strips Gemini's state glyphs (they encode agent state, not task text)", () => {
    expect(cleanTaskTitle("✦ writing tests")).toBe("writing tests");
    expect(cleanTaskTitle("✋ waiting for approval")).toBe("waiting for approval");
  });

  it("strips stacked glyph clusters", () => {
    expect(cleanTaskTitle("✳ ✻ task")).toBe("task");
  });

  it("leaves interior glyphs alone", () => {
    expect(cleanTaskTitle("deploy ✳ prod")).toBe("deploy ✳ prod");
  });

  it("does not strip leading words, parens, or colons", () => {
    expect(cleanTaskTitle("(re)do the thing")).toBe("(re)do the thing");
    expect(cleanTaskTitle("fix: auth bug")).toBe("fix: auth bug");
  });

  it("returns empty string for null/undefined/whitespace/glyph-only input", () => {
    expect(cleanTaskTitle(null)).toBe("");
    expect(cleanTaskTitle(undefined)).toBe("");
    expect(cleanTaskTitle("   ")).toBe("");
    expect(cleanTaskTitle("✳ ")).toBe("");
  });

  it("strips braille spinners (Codex, Grok, Claude busy indicator)", () => {
    expect(cleanTaskTitle("⣿ daintree")).toBe("daintree");
    expect(cleanTaskTitle("⠋ Fix duplicate Claude prefix in terminal titles")).toBe(
      "Fix duplicate Claude prefix in terminal titles"
    );
  });

  it("strips trailing state glyphs (Gemini's ◇/✦/✋ suffix position)", () => {
    expect(cleanTaskTitle("writing tests ✦")).toBe("writing tests");
    expect(cleanTaskTitle("✳ task ⠿")).toBe("task");
  });

  it("keeps text-plausible trailing characters (* is only spinner noise when leading)", () => {
    expect(cleanTaskTitle("document glob *")).toBe("document glob *");
    expect(cleanTaskTitle("* document glob")).toBe("document glob");
  });
});

describe("stripIdentityAffixes", () => {
  const noise = (segment: string) => ["grok", "oc", "opencode"].includes(segment.toLowerCase());

  it("strips a trailing identity suffix (Grok's ' - grok')", () => {
    expect(stripIdentityAffixes("User Greets AI and Queries Project Details - grok", noise)).toBe(
      "User Greets AI and Queries Project Details"
    );
  });

  it("strips a leading identity prefix (OpenCode's 'OC | ')", () => {
    expect(stripIdentityAffixes("OC | Greeting and project overview", noise)).toBe(
      "Greeting and project overview"
    );
  });

  it("drops bare separator runs left behind (Grok's busy '- Responding - grok')", () => {
    expect(stripIdentityAffixes("- Responding - grok", noise)).toBe("Responding");
  });

  it("never touches interior segments", () => {
    expect(stripIdentityAffixes("fix auth - update tests - grok", noise)).toBe(
      "fix auth - update tests"
    );
  });

  it("leaves non-noise affix segments alone", () => {
    expect(stripIdentityAffixes("fix: auth bug", noise)).toBe("fix: auth bug");
    expect(stripIdentityAffixes("auth bug - part two", noise)).toBe("auth bug - part two");
  });

  it("does not split hyphenated words (no whitespace around the separator)", () => {
    expect(stripIdentityAffixes("re-grok the config", noise)).toBe("re-grok the config");
  });

  it("leaves a final all-noise segment for the caller's classifier (no separator left to split on)", () => {
    expect(stripIdentityAffixes("OC | grok", noise)).toBe("grok");
  });
});
