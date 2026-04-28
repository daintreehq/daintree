import { describe, it, expect } from "vitest";
import { tags as t } from "@lezer/highlight";
import { daintreeThemeSettings, daintreeThemeStyles } from "../editorTheme";

describe("daintreeTheme — issue #5981 (caret-only accent)", () => {
  it("keeps the caret on the accent token (singleton position anchor)", () => {
    expect(daintreeThemeSettings.caret).toBe("var(--theme-accent-primary)");
  });

  describe("headings do not paint with the chrome accent", () => {
    const headingTags = [t.heading, t.heading1, t.heading2, t.heading3];

    it.each(headingTags.map((tag, i) => [`heading${i === 0 ? "" : i}`, tag] as const))(
      "%s uses --theme-syntax-keyword and is bold",
      (_label, tag) => {
        const entry = daintreeThemeStyles.find((s) => s.tag === tag);
        expect(entry).toBeDefined();
        // First-match-wins in @lezer/highlight: each level needs its own color/weight,
        // not just fontSize, otherwise the base t.heading styling is silently shadowed.
        expect(entry?.color).toBe("var(--theme-syntax-keyword)");
        expect(entry?.fontWeight).toBe("bold");
        expect(entry?.color).not.toBe("var(--theme-accent-primary)");
      }
    );
  });

  it("does not style t.list — lezer-markdown tags entire list-item subtrees with t.list, not just markers, so any color here washes the whole list rather than the bullet", () => {
    const entry = daintreeThemeStyles.find((s) => s.tag === t.list);
    expect(entry).toBeUndefined();
  });

  it("no style references the accent token in any color-bearing property", () => {
    const accentMatches = daintreeThemeStyles.flatMap((style) =>
      Object.entries(style)
        .filter(([key]) => key !== "tag")
        .filter(([, value]) => value === "var(--theme-accent-primary)")
    );
    expect(accentMatches).toEqual([]);
  });
});
