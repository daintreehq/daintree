import { describe, expect, it } from "vitest";
import { SESSION_TAB_TITLE_MAX_CHARS, trimSessionTabTitle } from "../sessionTabTitle";

describe("trimSessionTabTitle", () => {
  it("returns null when nothing readable is left", () => {
    expect(trimSessionTabTitle(undefined)).toBeNull();
    expect(trimSessionTabTitle(null)).toBeNull();
    expect(trimSessionTabTitle("")).toBeNull();
    expect(trimSessionTabTitle(" \n\t ")).toBeNull();
  });

  it("collapses whitespace runs and newlines to single spaces", () => {
    expect(trimSessionTabTitle("  fix   auth\n\ttests  ")).toEqual({
      label: "fix auth tests",
      fullTitle: "fix auth tests",
    });
  });

  it("leaves a title at the cap untouched", () => {
    const exact = "a".repeat(SESSION_TAB_TITLE_MAX_CHARS);
    expect(trimSessionTabTitle(exact)?.label).toBe(exact);
  });

  it("cuts a long title at a word boundary and keeps the whole of it as the full title", () => {
    const long = "refactor the assistant session strip so every lane carries a name";
    const result = trimSessionTabTitle(long)!;

    expect(result.label).toBe("refactor the assistant…");
    expect(Array.from(result.label).length).toBeLessThanOrEqual(SESSION_TAB_TITLE_MAX_CHARS);
    expect(result.fullTitle).toBe(long);
  });

  it("cuts mid-word when the nearest word boundary would throw away most of the text", () => {
    const result = trimSessionTabTitle("fix supercalifragilisticexpialidocious-handling", 20)!;
    expect(result.label).toBe("fix supercalifragil…");
  });

  it("drops punctuation left dangling at the cut", () => {
    expect(trimSessionTabTitle("update auth: rotate the refresh tokens", 14)!.label).toBe(
      "update auth…"
    );
  });

  it("never splits a surrogate pair", () => {
    const result = trimSessionTabTitle("🚀".repeat(30), 10)!;
    expect(result.label).toBe(`${"🚀".repeat(9)}…`);
  });
});
