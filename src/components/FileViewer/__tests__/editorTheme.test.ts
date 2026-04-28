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

  it("list bullets use --theme-syntax-punctuation, not the accent", () => {
    const entry = daintreeThemeStyles.find((s) => s.tag === t.list);
    expect(entry).toBeDefined();
    expect(entry?.color).toBe("var(--theme-syntax-punctuation)");
    expect(entry?.color).not.toBe("var(--theme-accent-primary)");
  });

  it("no syntax style (other than the caret setting) references the accent token", () => {
    const accentRefs = daintreeThemeStyles.filter((s) => s.color === "var(--theme-accent-primary)");
    expect(accentRefs).toEqual([]);
  });
});
