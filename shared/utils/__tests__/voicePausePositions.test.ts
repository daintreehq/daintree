import { describe, expect, it } from "vitest";
import {
  carryPausePositionsThroughEdits,
  normalizePausePositions,
  slicePausePositions,
  splitPausePositionsByLine,
} from "../voicePausePositions.js";

describe("normalizePausePositions", () => {
  it("moves each position back onto the word before it, sorted and once", () => {
    expect(normalizePausePositions("fix it.  then\nrun", [14, 8, 7, 13, 3])).toEqual([3, 7, 13]);
  });

  it("keeps a position with no word before it as 0, and clamps ones outside the text", () => {
    expect(normalizePausePositions("  \nfix", [2, 3, 99, -4])).toEqual([0, 6]);
  });

  it("drops a position that isn't a whole number", () => {
    expect(normalizePausePositions("fix it", [Number.NaN, 2.5, 3])).toEqual([3]);
  });
});

describe("slicePausePositions", () => {
  it("gives a pause on the edge to the slice before it", () => {
    expect(slicePausePositions([3, 7, 12], 3, 7)).toEqual([4]);
    expect(slicePausePositions([3, 7, 12], 0, 3)).toEqual([3]);
  });
});

describe("carryPausePositionsThroughEdits", () => {
  // "add zoo stand and run" → "add Zustand and run"
  const zustand = [{ from: 4, to: 13, insert: "Zustand" }];

  it("moves a pause after an edit by what the edit changed", () => {
    expect(carryPausePositionsThroughEdits([17, 21], zustand)).toEqual([15, 19]);
  });

  it("keeps a pause at a rewrite's end on the rewrite's end", () => {
    expect(carryPausePositionsThroughEdits([13], zustand)).toEqual([11]);
  });

  it("puts a pause that fell between words a rewrite joined at the rewrite's end", () => {
    expect(carryPausePositionsThroughEdits([7], zustand)).toEqual([11]);
  });

  it("leaves a pause before an edit, and one an insertion lands on, where they were", () => {
    expect(carryPausePositionsThroughEdits([3], zustand)).toEqual([3]);
    expect(carryPausePositionsThroughEdits([3], [{ from: 3, to: 3, insert: "!" }])).toEqual([3]);
  });

  it("carries a pause past a deletion that ends at it back onto the word before", () => {
    // "fix it um" → "fix it"
    expect(carryPausePositionsThroughEdits([9], [{ from: 6, to: 9, insert: "" }])).toEqual([6]);
  });
});

describe("splitPausePositionsByLine", () => {
  it("places each pause in the trimmed piece it ends a word of", () => {
    const text = "fix the bug \n then run tests";
    expect(splitPausePositionsByLine(text, [11, 18, 28])).toEqual([[11], [4, 14]]);
  });

  it("puts a pause at 0 in no piece", () => {
    expect(splitPausePositionsByLine("\nnext", [0])).toEqual([[], []]);
  });
});
