import { describe, expect, it } from "vitest";
import { mapWordCuts } from "../wordAlignment";

/** The cut between `left` and `right` as dictated, joined by one space. */
function cutBetween(left: string, right: string) {
  return { before: `${left} ${right}`, cut: { end: left.length, start: left.length + 1 } };
}

function pieces(after: string, cut: { end: number; start: number } | null) {
  return cut ? [after.slice(0, cut.end), after.slice(cut.start)] : null;
}

describe("mapWordCuts", () => {
  it("places a cut whose words either side came through, recased and punctuated", () => {
    const { before, cut } = cutBetween("so the cache is stale", "we should clear it");
    const after = "So the cache is stale. We should clear it.";
    expect(pieces(after, mapWordCuts(before, after, [cut])[0]!)).toEqual([
      "So the cache is stale.",
      "We should clear it.",
    ]);
  });

  it("keeps a word rewritten at the end of the earlier run on its side", () => {
    const { before, cut } = cutBetween("add zoo stand", "to the store");
    const after = "add Zustand to the store";
    expect(pieces(after, mapWordCuts(before, after, [cut])[0]!)).toEqual([
      "add Zustand",
      "to the store",
    ]);
  });

  it("keeps a filler dropped from the start of the later run on its side", () => {
    const { before, cut } = cutBetween("we should deploy", "um then rerun the tests");
    const after = "We should deploy, then rerun the tests.";
    expect(pieces(after, mapWordCuts(before, after, [cut])[0]!)).toEqual([
      "We should deploy,",
      "then rerun the tests.",
    ]);
  });

  it("can't place a cut a self-correction runs across", () => {
    const { before, cut } = cutBetween("use the staging server", "no wait the local one");
    expect(mapWordCuts(before, "Use the local one.", [cut])).toEqual([null]);
  });

  it("can't place a cut where the rewrite wrote words of its own between kept ones", () => {
    const { before, cut } = cutBetween("open the file", "close it");
    expect(mapWordCuts(before, "Open the file and then close it.", [cut])).toEqual([null]);
  });

  it("maps several cuts independently", () => {
    const before = "first part here second part there third part too";
    const cuts = [
      { end: "first part here".length, start: "first part here ".length },
      {
        end: "first part here second part there".length,
        start: "first part here second part there ".length,
      },
    ];
    const after = "First part here. Second part there. Third part too.";
    const [one, two] = mapWordCuts(before, after, cuts);
    expect(after.slice(0, one!.end)).toBe("First part here.");
    expect(after.slice(one!.start, two!.end)).toBe("Second part there.");
    expect(after.slice(two!.start)).toBe("Third part too.");
  });
});
