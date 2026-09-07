import { describe, expect, it } from "vitest";
import { blockSimilarity, PAIR_SIMILARITY_THRESHOLD } from "../markdownBlockDiff";
import { inlineChangeRanges, sentenceRanges, type TextRange } from "../markdownInlineDiff";

/** One side of a comparison. Real blocks carry structural boundaries too. */
function side(text: string, segments: readonly number[] = []) {
  return { text, segments };
}

/** The marked substrings, which is what a reader actually sees. */
function marks(text: string, ranges: readonly TextRange[]): string[] {
  return ranges.map((range) => text.slice(range.start, range.end));
}

describe("sentenceRanges", () => {
  it("splits on a terminator followed by a capital", () => {
    const text = "First one here. Second one here.";
    expect(marks(text, sentenceRanges(text))).toEqual(["First one here. ", "Second one here."]);
  });

  it("splits a terminator with no space at all", () => {
    // A list's flattened text concatenates its items with no separator, so
    // without this every list in a document aligns as one blob and its word
    // marks come back as confetti.
    const text = "Runs in a real terminal.The state is read from the output.";
    expect(marks(text, sentenceRanges(text))).toEqual([
      "Runs in a real terminal.",
      "The state is read from the output.",
    ]);
  });

  it("leaves an abbreviation alone", () => {
    // The rule is "terminator then a non-lower-case character". A full stop
    // followed by a space and a lower-case letter is an abbreviation, and
    // splitting there invents an alignment that was never in the text.
    const text = "Use the flag e.g. when broadcasting to every pane.";
    expect(sentenceRanges(text)).toHaveLength(1);
  });

  it("leaves a decimal and a version alone", () => {
    expect(sentenceRanges("The ratio is 3.5 across v1.2 of the format.")).toHaveLength(1);
  });

  it("splits on a newline", () => {
    const text = "One line\nAnother line";
    expect(marks(text, sentenceRanges(text))).toEqual(["One line\n", "Another line"]);
  });
});

describe("inlineChangeRanges", () => {
  it("marks only the words that changed", () => {
    const oldText = "The quick brown fox jumps over the lazy dog.";
    const newText = "The quick brown fox leaps over the lazy dog.";
    const ranges = inlineChangeRanges(side(oldText), side(newText));

    expect(marks(oldText, ranges.old)).toEqual(["jumps"]);
    expect(marks(newText, ranges.new)).toEqual(["leaps"]);
  });

  it("leaves a sentence that survived a rewrite completely unmarked", () => {
    // The rule this whole module exists for: an edit elsewhere in the block must
    // not reach into a sentence that did not change. A flat word LCS over the
    // block would anchor this sentence's stop words against the rewrite next to
    // it and mark half of it.
    const oldText = "Agents run in real terminals. The old claim was wrong in several ways.";
    const newText = "Agents run in real terminals. Something else entirely goes here now.";
    const ranges = inlineChangeRanges(side(oldText), side(newText));

    for (const mark of [...marks(oldText, ranges.old), ...marks(newText, ranges.new)]) {
      expect(mark).not.toContain("Agents run in real terminals");
    }
  });

  it("collapses a rewritten sentence to one mark rather than dropping every mark", () => {
    // The behaviour the coverage rule used to have was "show nothing", which is
    // how a rewritten paragraph became two undifferentiated walls of text. Past
    // the coverage limit the marks stop claiming a word-by-word correspondence
    // they no longer have, but the sentence is still located for the reader.
    const oldText = "Keep this sentence exactly. Alpha beta gamma delta epsilon zeta.";
    const newText = "Keep this sentence exactly. Wholly unrelated replacement wording here.";
    const ranges = inlineChangeRanges(side(oldText), side(newText));

    expect(ranges.old).toHaveLength(1);
    expect(marks(oldText, ranges.old)).toEqual(["Alpha beta gamma delta epsilon zeta."]);
    expect(ranges.new).toHaveLength(1);
  });

  it("marks an inserted sentence whole and once", () => {
    const oldText = "There are five agents running right now.";
    const newText = "This is how I work now. There are five agents running right now.";
    const ranges = inlineChangeRanges(side(oldText), side(newText));

    expect(ranges.old).toEqual([]);
    expect(marks(newText, ranges.new)).toEqual(["This is how I work now."]);
  });

  it("absorbs a short surviving island rather than cutting one mark into three", () => {
    // `diff_cleanupSemantic`'s island rule. Without it, the "was" that survives
    // between two rewritten clauses splits one legible span into two marks with
    // a gap the reader reads as meaningful.
    const oldText = "It was going to be running more agents.";
    const newText = "It was all about adding more agents.";
    const ranges = inlineChangeRanges(side(oldText), side(newText));

    expect(ranges.new).toHaveLength(1);
    expect(marks(newText, ranges.new)).toEqual(["all about adding"]);
  });

  /**
   * The island ceiling, isolated.
   *
   * Both cases clear the relative rule (the surviving run is shorter than the
   * edits either side of it), so the only thing separating them is the character
   * ceiling. Built from generated text rather than prose because a sentence
   * natural enough to read is never precise enough to pin a boundary.
   */
  it.each([
    ["absorbs an island under the ceiling", "kept words here", 1],
    ["leaves an island over the ceiling alone", "kept quite a lot of words here", 2],
  ] as const)("%s", (_label, island, expected) => {
    // A shared head and tail keep each side's coverage well under the limit, so
    // the whole-side collapse never fires and the island rule is the only thing
    // deciding the answer.
    const head = "one two three four five six seven eight nine ten eleven twelve";
    const tail = "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
    const oldEdits = [
      "aaaa bbbb cccc dddd eeee ffff gggg",
      "hhhh iiii jjjj kkkk llll mmmm nnnn",
    ] as const;
    const newEdits = [
      "qqqq rrrr ssss tttt uuuu vvvv wwww",
      "xxxx yyyy zzzz aaab bbbc cccd ddde",
    ] as const;
    const oldText = `${head} ${oldEdits[0]} ${island} ${oldEdits[1]} ${tail}`;
    const newText = `${head} ${newEdits[0]} ${island} ${newEdits[1]} ${tail}`;
    const ranges = inlineChangeRanges(side(oldText), side(newText));

    // The relative half of the rule holds either way — the island is shorter
    // than both runs beside it — so only the ceiling separates the two cases.
    expect(island.length).toBeLessThan(newEdits[0].length);
    expect(marks(newText, ranges.new)).toHaveLength(expected);
  });

  it("returns nothing when both sides would be marked end to end", () => {
    // A side marked in full says exactly what the block's own fill already said,
    // at the cost of painting it twice.
    expect(inlineChangeRanges(side("alpha beta gamma"), side("wholly different wording"))).toEqual({
      old: [],
      new: [],
    });
  });

  it("keeps a whitespace-only edit marked", () => {
    // The mark is the only visible signal a spacing change has, which is why the
    // line diff exempts whitespace edits from suppression too.
    expect(inlineChangeRanges(side("a b"), side("a   b")).new.length).toBeGreaterThan(0);
  });

  it("judges the two sides independently", () => {
    // A block that lost a clause but gained a wholesale rewrite keeps its precise
    // deletion marks even though the insertion side is a wash.
    const oldText = "Keep this sentence exactly as it was. And also drop a clause here.";
    const newText = "Keep this sentence exactly as it was. Utterly different wording.";
    const ranges = inlineChangeRanges(side(oldText), side(newText));

    expect(ranges.old.length).toBeGreaterThan(0);
    expect(ranges.new.length).toBeGreaterThan(0);
    for (const mark of marks(oldText, ranges.old)) {
      expect(mark).not.toContain("Keep this sentence");
    }
  });

  it("never anchors one structural child's words against another's", () => {
    // A table flattens to its cells concatenated with nothing between them, so
    // without the boundaries the trailing "O" of one cell's "Option-Command-O"
    // matches the identical "O" in a different cell and both sides render a
    // mark on a character nobody touched.
    const oldText = "Option-Command-OAll agents, every projectOption-Command-INew terminal";
    const newText = "Option-Command-OEvery agent, across every projectOption-Command-INew terminal";
    const oldSegments = [0, 16, 40, 56];
    const newSegments = [0, 16, 48, 64];
    const ranges = inlineChangeRanges(side(oldText, oldSegments), side(newText, newSegments));

    for (const mark of [...marks(oldText, ranges.old), ...marks(newText, ranges.new)]) {
      expect(mark).not.toContain("Option-Command");
    }
  });

  it("never returns a range outside its text", () => {
    const oldText = "One sentence here. A second one follows it. And a third arrives.";
    const newText = "One sentence here. A second, longer one follows. Then a third arrives now.";
    const ranges = inlineChangeRanges(side(oldText), side(newText));

    for (const range of ranges.old) {
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(oldText.length);
      expect(range.end).toBeGreaterThan(range.start);
    }
    for (const range of ranges.new) {
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(newText.length);
      expect(range.end).toBeGreaterThan(range.start);
    }
  });

  it("returns ranges in order and never overlapping", () => {
    // The rehype plugin splices marks into the hast tree in one forward pass per
    // text node and would silently mis-nest on an overlap.
    const oldText = "Alpha one. Beta two. Gamma three. Delta four.";
    const newText = "Alpha ONE. Beta two. Gamma THREE. Delta FOUR.";
    const ranges = inlineChangeRanges(side(oldText), side(newText));

    for (const side of [ranges.old, ranges.new]) {
      for (let i = 1; i < side.length; i++) {
        expect(side[i]!.start).toBeGreaterThanOrEqual(side[i - 1]!.end);
      }
    }
  });
});

/**
 * The pairing threshold's real specification.
 *
 * `PAIR_SIMILARITY_THRESHOLD` is a number chosen to sit in the gap between these
 * two corpora, so the corpora are what must hold — not the number. Asserting the
 * number instead would be a test that changes whenever the thing it is testing
 * changes, which is no test at all.
 */
describe("block pairing corpus", () => {
  const SAME_BLOCK_EDITED: Array<[string, string, string]> = [
    [
      "expanded rewrite that keeps most of its wording",
      "There are five coding agents running on my machine right now, across a few different projects. And when I started working like this, I thought the hard part was going to be running more agents.",
      "This is how I'm working now. There are five coding agents running on my machine, across a few different projects, and at any moment I know exactly which one of them needs me. When I was working the old way, I always thought it was all about adding more agents.",
    ],
    [
      "one word swapped",
      "The quick brown fox jumps over the lazy dog.",
      "The quick brown fox leaps over the lazy dog.",
    ],
    [
      "a sentence appended",
      "Daintree keeps a few promises about how your agents behave.",
      "Daintree keeps a few promises about how your agents behave. Each one is checked at runtime.",
    ],
    ["a heading reworded", "Running the fleet", "Running the fleet, in practice"],
    [
      "a clause moved to the front",
      "The state you see is read from the output, never from the agent's own claims.",
      "Never from the agent's own claims: the state you see is read from the output.",
    ],
  ];

  const DIFFERENT_BLOCKS: Array<[string, string, string]> = [
    [
      "unrelated topics",
      "The quick brown fox jumps over the lazy dog.",
      "Kitchen inventory: seven mugs, three plates, one kettle.",
    ],
    [
      "same domain, different content",
      "Every agent runs in a real terminal, not a wrapper.",
      "Closing a terminal keeps its scrollback, so you can pick the thread back up.",
    ],
    [
      "sharing only their boilerplate",
      "This paragraph is going away entirely. It said something that stopped being true, and nothing replaced it.",
      "This paragraph is brand new. Nothing in the old document said anything like it, so there is no counterpart for it to be paired against.",
    ],
    [
      "generic prose with no shared subject",
      "So this video is really about how I scaled up to a lot of agents across a lot of projects.",
      "That was the main thing Daintree had to solve: how do you jump between a lot of real agents very quickly?",
    ],
  ];

  it.each(SAME_BLOCK_EDITED)("pairs: %s", (_label, oldText, newText) => {
    expect(blockSimilarity(oldText, newText)).toBeGreaterThan(PAIR_SIMILARITY_THRESHOLD);
  });

  it.each(DIFFERENT_BLOCKS)("does not pair: %s", (_label, oldText, newText) => {
    expect(blockSimilarity(oldText, newText)).toBeLessThan(PAIR_SIMILARITY_THRESHOLD);
  });

  it("keeps real headroom either side of the threshold", () => {
    // A threshold flush against the lowest true positive is how the paragraph
    // that opened this review — 0.447 against a 0.45 gate — rendered as two
    // unrelated walls of text. The gap is the thing worth protecting.
    const lowestPair = Math.min(...SAME_BLOCK_EDITED.map(([, a, b]) => blockSimilarity(a, b)));
    const highestNonPair = Math.max(...DIFFERENT_BLOCKS.map(([, a, b]) => blockSimilarity(a, b)));

    expect(lowestPair - PAIR_SIMILARITY_THRESHOLD).toBeGreaterThan(0.03);
    expect(PAIR_SIMILARITY_THRESHOLD - highestNonPair).toBeGreaterThan(0.03);
  });
});
