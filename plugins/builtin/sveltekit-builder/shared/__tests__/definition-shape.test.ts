import { describe, expect, it } from "vitest";
import { DefinitionSchema } from "../model.js";

const base = {
  location: { file: "src/routes/+page.svelte", line: 12, column: 2 },
  range: { start: 100, end: 160 },
  tagName: "button",
  revision: "a".repeat(64),
  renderedOccurrences: 1,
};

describe("the definition's placement evidence", () => {
  it("accepts a sibling count larger than any ceiling worth guessing at", () => {
    // A 700 KB page — inside the 1 MiB source cap — really can put 100,001
    // elements at one level. A bound here made that a failed selection rather
    // than a selection without evidence, which is the wrong trade: `shape` is
    // optional, and nothing should break a selection by being absent.
    const parsed = DefinitionSchema.safeParse({
      ...base,
      shape: { levelCounts: [1, 100_001], agrees: true },
    });
    expect(parsed.success).toBe(true);
  });

  it("still refuses counts that are not counts, and a path deeper than a path goes", () => {
    for (const levelCounts of [[-1], [1.5], [], Array.from({ length: 65 }, () => 1)]) {
      expect(
        DefinitionSchema.safeParse({ ...base, shape: { levelCounts, agrees: true } }).success,
        JSON.stringify(levelCounts).slice(0, 40)
      ).toBe(false);
    }
  });

  it("is optional, and unknown fields beside it are still refused", () => {
    expect(DefinitionSchema.safeParse(base).success).toBe(true);
    expect(DefinitionSchema.safeParse({ ...base, somethingElse: 1 }).success).toBe(false);
  });
});
