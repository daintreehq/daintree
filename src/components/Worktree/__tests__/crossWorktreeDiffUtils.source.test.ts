import { describe, expect, it } from "vitest";
import { committedSourceForPatch } from "../crossWorktreeDiffUtils";

function patch(index: string | null): string {
  return [
    "diff --git a/f.ts b/f.ts",
    ...(index ? [`index ${index} 100644`] : []),
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -2 +2 @@",
    "-two",
    "+TWO",
  ].join("\n");
}

function wholeFile(index: string | null): string {
  return [
    "diff --git a/f.ts b/f.ts",
    ...(index ? [`index ${index} 100644`] : []),
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
  ].join("\n");
}

const SOURCE = "one\nTWO\nthree";

describe("committedSourceForPatch", () => {
  it("reads the source when both diffs name the same blobs", () => {
    expect(committedSourceForPatch(wholeFile("abc1234..def5678"), patch("abc1234..def5678"))).toBe(
      SOURCE
    );
  });

  it("drops a source whose compare side is a different blob than the patch's", () => {
    expect(
      committedSourceForPatch(wholeFile("abc1234..9990000"), patch("abc1234..def5678"))
    ).toBeNull();
  });

  it("drops a source whose base side is a different blob than the patch's", () => {
    expect(
      committedSourceForPatch(wholeFile("1110000..def5678"), patch("abc1234..def5678"))
    ).toBeNull();
  });

  it("drops a source whose id only extends the patch's abbreviation", () => {
    expect(
      committedSourceForPatch(wholeFile("abc1234..def5678a"), patch("abc1234..def5678"))
    ).toBeNull();
  });

  it("reads the source when the diffs carry no blob ids to compare", () => {
    expect(committedSourceForPatch(wholeFile(null), patch(null))).toBe(SOURCE);
  });

  it("has nothing to read without a whole-file diff", () => {
    expect(committedSourceForPatch(null, patch("abc1234..def5678"))).toBeNull();
  });
});
