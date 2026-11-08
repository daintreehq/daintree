import { describe, expect, it } from "vitest";
import { CANOPY_SEARCH_MAX_ALTERNATIVES } from "@shared/types/ipc/canopy";
import {
  canopySearchNotes,
  parseCanopySearch,
  searchPasteText,
  textMatchesSearch,
} from "../canopySearch";

const NONE_UNASKED = { overWords: false, overLength: false, overRuns: false };

describe("parseCanopySearch", () => {
  it("separates alternatives by comma or line break, and the words of one by whitespace", () => {
    expect(
      parseCanopySearch("dfat-xth8, cocto-claude-20261103a, fallback-review: dfat-vjv0")
    ).toEqual({
      alternatives: [["dfat-xth8"], ["cocto-claude-20261103a"], ["fallback-review:", "dfat-vjv0"]],
      dropped: 0,
    });
    expect(parseCanopySearch("Login fix\r\nsegfault\nA  b").alternatives).toEqual([
      ["login", "fix"],
      ["segfault"],
      ["a", "b"],
    ]);
  });

  it("never leaves a comma on a word, and skips empty alternatives", () => {
    expect(parseCanopySearch("foo,").alternatives).toEqual([["foo"]]);
    expect(parseCanopySearch(",, a,,b , ").alternatives).toEqual([["a"], ["b"]]);
    expect(parseCanopySearch(" , \n ").alternatives).toEqual([]);
  });

  it("keeps each word once in an alternative, and each alternative once whatever its order", () => {
    expect(parseCanopySearch("Login login  LOGIN fix").alternatives).toEqual([["login", "fix"]]);
    expect(parseCanopySearch("a b, B A, a").alternatives).toEqual([["a", "b"], ["a"]]);
  });

  it("keeps the first alternatives a search offers and counts the rest", () => {
    const items = (count: number) => Array.from({ length: count }, (_, index) => `item${index}`);
    expect(parseCanopySearch(items(CANOPY_SEARCH_MAX_ALTERNATIVES).join(",")).dropped).toBe(0);
    // Repeats don't count toward the cap.
    const repeated = [...items(CANOPY_SEARCH_MAX_ALTERNATIVES), "item0", "ITEM1"].join(",");
    expect(parseCanopySearch(repeated).dropped).toBe(0);
    const over = parseCanopySearch(items(CANOPY_SEARCH_MAX_ALTERNATIVES + 3).join(","));
    expect(over.alternatives).toHaveLength(CANOPY_SEARCH_MAX_ALTERNATIVES);
    expect(over.alternatives.at(-1)).toEqual([`item${CANOPY_SEARCH_MAX_ALTERNATIVES - 1}`]);
    expect(over.dropped).toBe(3);
  });
});

describe("textMatchesSearch", () => {
  it("matches text holding every word of any one alternative", () => {
    const text = "fix login redirect\nwaiting on staging";
    expect(textMatchesSearch(text, [])).toBe(true);
    expect(textMatchesSearch(text, [["segfault"], ["login", "staging"]])).toBe(true);
    expect(
      textMatchesSearch(text, [
        ["login", "segfault"],
        ["staging", "econnreset"],
      ])
    ).toBe(false);
  });
});

describe("searchPasteText", () => {
  it("turns each line of a pasted list into an alternative", () => {
    expect(searchPasteText("dfat-xth8\r\n  cocto-claude \n\nfallback-review: dfat-vjv0\n")).toBe(
      "dfat-xth8, cocto-claude, fallback-review: dfat-vjv0"
    );
    expect(searchPasteText("a\rb")).toBe("a, b");
  });

  it("leaves a single line to the field", () => {
    expect(searchPasteText("one line, as typed")).toBeNull();
  });
});

describe("canopySearchNotes", () => {
  const kept = parseCanopySearch(
    Array.from({ length: CANOPY_SEARCH_MAX_ALTERNATIVES }, (_, index) => `item${index}`).join(",")
  ).alternatives;

  it("says nothing when the whole search was asked", () => {
    expect(canopySearchNotes(kept, 0, NONE_UNASKED)).toEqual([]);
  });

  it("names each thing the search leaves out", () => {
    const notes = canopySearchNotes(kept, 1_200, {
      overWords: true,
      overLength: true,
      overRuns: true,
    });
    expect(notes).toHaveLength(4);
    expect(notes[0]).toContain(`first ${CANOPY_SEARCH_MAX_ALTERNATIVES} of 1,250 alternatives`);
    for (const note of notes) {
      expect(note).not.toMatch(/\.$/);
    }
  });
});
