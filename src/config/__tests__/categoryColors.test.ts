import { describe, expect, it } from "vitest";
import { ACTION_CATEGORY_COLORS, ACTION_CATEGORY_DEFAULT_COLOR } from "@/config/categoryColors";

/**
 * Contract tests for the action palette category chip tokens. These assert
 * structural invariants (which token family each entry draws from), not the
 * literal class strings — the goal is to guard the legibility migration from
 * raw `cat-{hue}/15` tints to the engineered `category-{hue}-*` set, so the
 * chip label keeps its WCAG-compliant contrast.
 */
describe("ACTION_CATEGORY_COLORS", () => {
  const entries = Object.entries(ACTION_CATEGORY_COLORS);

  it("maps at least one category", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("draws every category from the engineered category-{hue} token set", () => {
    for (const [category, classes] of entries) {
      expect(
        /\bbg-category-[a-z]+-subtle\b/.test(classes),
        `${category} missing bg-category-*-subtle: ${classes}`
      ).toBe(true);
      expect(
        /\btext-category-[a-z]+-text\b/.test(classes),
        `${category} missing text-category-*-text: ${classes}`
      ).toBe(true);
      expect(
        /\bborder-category-[a-z]+-border\b/.test(classes),
        `${category} missing border-category-*-border: ${classes}`
      ).toBe(true);
    }
  });

  it("never falls back to the flat cat-{hue} opacity tint", () => {
    for (const [category, classes] of entries) {
      expect(
        /\b(?:bg|text|border)-cat-[a-z]+\b/.test(classes),
        `${category} still uses a raw cat-* token: ${classes}`
      ).toBe(false);
    }
  });

  it("uses a single consistent hue per entry", () => {
    for (const [category, classes] of entries) {
      const hues = new Set(
        [...classes.matchAll(/-category-([a-z]+)-(?:subtle|text|border)\b/g)].map((m) => m[1])
      );
      expect(hues.size, `${category} mixes hues: ${classes}`).toBe(1);
    }
  });

  it("keeps the default fallback neutral (no hue token)", () => {
    expect(/-category-[a-z]+-/.test(ACTION_CATEGORY_DEFAULT_COLOR)).toBe(false);
    expect(/-cat-[a-z]+\b/.test(ACTION_CATEGORY_DEFAULT_COLOR)).toBe(false);
  });
});
