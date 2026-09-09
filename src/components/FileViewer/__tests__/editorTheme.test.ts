import { describe, it, expect } from "vitest";
import { tags as t } from "@lezer/highlight";
import { daintreeThemeStyles } from "../editorTheme";

describe("daintreeTheme — issue #5981 (caret-only accent)", () => {
  describe("headings do not paint with the chrome accent", () => {
    const headingTags = [t.heading, t.heading1, t.heading2, t.heading3];

    it.each(headingTags.map((tag, i) => [`heading${i === 0 ? "" : i}`, tag] as const))(
      "%s uses --theme-syntax-keyword and is bold",
      (_label, tag) => {
        const entry = daintreeThemeStyles.find((s) => s.tag === tag);
        // First-match-wins in @lezer/highlight: each level needs its own color/weight,
        // not just fontSize, otherwise the base t.heading styling is silently shadowed.
        expect(entry).toBeDefined();
        expect(entry?.color).not.toBe("var(--theme-accent-primary)");
      }
    );
  });

  it("does not style t.list — lezer-markdown tags entire list-item subtrees with t.list, not just markers, so any color here washes the whole list rather than the bullet", () => {
    const entry = daintreeThemeStyles.find((s) => s.tag === t.list);
    expect(entry).toBeUndefined();
  });

  describe("Markdown inline tags (#12323)", () => {
    const find = (tag: unknown) =>
      daintreeThemeStyles.find(
        (s) => s.tag === tag || (Array.isArray(s.tag) && s.tag.includes(tag))
      );

    it.each([
      ["heading4", t.heading4],
      ["heading5", t.heading5],
      ["heading6", t.heading6],
    ])("%s is bold in the keyword role without a size step", (_label, tag) => {
      const entry = find(tag);
      expect(entry?.color).toBe("var(--theme-syntax-keyword)");
      expect(entry?.fontWeight).toBe("bold");
      expect(entry?.fontSize).toBeUndefined();
    });

    it("emphasis and strong are typographic only — body text keeps its colour", () => {
      expect(find(t.emphasis)).toMatchObject({ fontStyle: "italic" });
      expect(find(t.emphasis)?.color).toBeUndefined();
      expect(find(t.strong)).toMatchObject({ fontWeight: "bold" });
      expect(find(t.strong)?.color).toBeUndefined();
    });

    it("strikethrough, inline code, and thematic breaks map onto existing syntax roles", () => {
      expect(find(t.strikethrough)).toMatchObject({ textDecoration: "line-through" });
      expect(find(t.monospace)?.color).toBe("var(--theme-syntax-string)");
      expect(find(t.contentSeparator)?.color).toBe("var(--theme-syntax-punctuation)");
    });

    it("markup characters take the comment role so they read as scaffolding", () => {
      expect(find(t.processingInstruction)?.color).toBe("var(--theme-syntax-comment)");
      expect(find(t.meta)?.color).toBe("var(--theme-syntax-comment)");
    });
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
