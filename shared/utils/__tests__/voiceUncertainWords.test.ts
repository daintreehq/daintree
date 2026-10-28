import { describe, expect, it } from "vitest";
import {
  carrySpansThroughEdits,
  flagUncertainWords,
  locateWords,
  sliceSpans,
  spansInKeptStart,
  splitSpansByLine,
  type VoiceTextSpan,
} from "../voiceUncertainWords.js";

const words = (...pairs: Array<[string, number]>) =>
  pairs.map(([text, confidence]) => ({ text, confidence }));

const read = (text: string, spans: readonly (VoiceTextSpan | null)[]) =>
  spans.map((span) => (span ? text.slice(span.from, span.to) : null));

describe("locateWords", () => {
  it("places every word of a transcript its words spell out", () => {
    const text = "Fix the login bug, then ship.";
    const spans = locateWords(text, ["Fix", "the", "login", "bug,", "then", "ship."]);
    expect(read(text, spans)).toEqual(["Fix", "the", "login", "bug,", "then", "ship."]);
  });

  it("places each copy of a repeated word at its own position", () => {
    const text = "test foo test";
    expect(locateWords(text, ["test", "foo", "test"])).toEqual([
      { from: 0, to: 4 },
      { from: 5, to: 8 },
      { from: 9, to: 13 },
    ]);
  });

  it("leaves only the words a formatter rewrote unplaced", () => {
    const text = "It costs $25 a month";
    const spans = locateWords(text, ["It", "costs", "twenty", "five", "dollars", "a", "month"]);
    expect(read(text, spans)).toEqual(["It", "costs", null, null, null, "a", "month"]);
  });

  it("places words written without spaces between them", () => {
    const text = "こんにちは世界";
    expect(read(text, locateWords(text, ["こんにちは", "世界"]))).toEqual(["こんにちは", "世界"]);
  });

  it("never places a word that is only the start of a longer one", () => {
    expect(locateWords("abx yz", ["a", "b", "c", "yz"])).toEqual([
      null,
      null,
      null,
      { from: 4, to: 6 },
    ]);
    expect(locateWords("and more", ["a", "more"])).toEqual([null, { from: 4, to: 8 }]);
  });

  it("keeps an empty or missing word in its slot instead of closing the gap", () => {
    const text = "one two three";
    expect(read(text, locateWords(text, ["one", "", "three"]))).toEqual(["one", null, "three"]);
  });

  it("matches what remains of the transcript from its end when the start doesn't fit", () => {
    const text = "  $25 then done ";
    expect(read(text, locateWords(text, ["twenty", "five", "then", "done"]))).toEqual([
      null,
      null,
      "then",
      "done",
    ]);
  });
});

describe("flagUncertainWords", () => {
  it("flags exactly the words below the cut-off, by position", () => {
    const text = "test foo test bar";
    expect(
      flagUncertainWords(
        text,
        words(["test", 0.95], ["foo", 0.9], ["test", 0.4], ["bar", 0.99]),
        0.65
      )
    ).toEqual([{ from: 9, to: 13 }]);
  });

  it("treats the cut-off itself as confident", () => {
    expect(flagUncertainWords("hello", words(["hello", 0.65]), 0.65)).toEqual([]);
  });

  it("leaves prose punctuation outside a flag but keeps a symbol that is part of the word", () => {
    const text = '"Hello," said C++ (maybe).';
    const flagged = flagUncertainWords(
      text,
      words(['"Hello,"', 0.2], ["said", 0.9], ["C++", 0.3], ["(maybe).", 0.1]),
      0.65
    );
    expect(read(text, flagged)).toEqual(["Hello", "C++", "maybe"]);
  });

  it("flags nothing where a word can't be placed or has no confidence", () => {
    const text = "It costs $25";
    expect(
      flagUncertainWords(
        text,
        [
          { text: "It", confidence: Number.NaN },
          { text: "costs", confidence: 0.9 },
          { text: "twenty", confidence: 0.1 },
          { text: "five", confidence: 0.1 },
        ],
        0.65
      )
    ).toEqual([]);
  });

  it("measures offsets in UTF-16 units past astral characters", () => {
    const text = "🙂 deploy";
    expect(
      read(text, flagUncertainWords(text, words(["🙂", 0.99], ["deploy", 0.2]), 0.65))
    ).toEqual(["deploy"]);
  });
});

describe("spansInKeptStart", () => {
  it("keeps the spans a trailing rewrite left alone and drops the rest", () => {
    const before = "fix it now new line";
    const after = "fix it now\n";
    expect(
      spansInKeptStart(before, after, [
        { from: 4, to: 6 },
        { from: 11, to: 14 },
      ])
    ).toEqual([{ from: 4, to: 6 }]);
  });
});

describe("carrySpansThroughEdits", () => {
  it("moves spans past the edits before them and drops any an edit reached", () => {
    // "type script is fast and next jess is not"
    const spans = [
      { from: 5, to: 11 },
      { from: 15, to: 19 },
      { from: 34, to: 36 },
      { from: 37, to: 40 },
    ];
    const edits = [
      { from: 0, to: 11, insert: "TypeScript" },
      { from: 24, to: 33, insert: "Next.js" },
    ];
    expect(carrySpansThroughEdits(spans, edits)).toEqual([
      { from: 14, to: 18 },
      { from: 31, to: 33 },
      { from: 34, to: 37 },
    ]);
  });

  it("drops a span an insertion lands inside, but not one it lands beside", () => {
    const spans = [
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ];
    expect(carrySpansThroughEdits(spans, [{ from: 5, to: 5, insert: "x" }])).toEqual([
      { from: 0, to: 3 },
    ]);
    expect(carrySpansThroughEdits(spans, [{ from: 3, to: 3, insert: "xx" }])).toEqual([
      { from: 0, to: 3 },
      { from: 6, to: 9 },
    ]);
  });
});

describe("sliceSpans", () => {
  it("keeps only the spans wholly inside, relative to its start", () => {
    expect(
      sliceSpans(
        [
          { from: 0, to: 2 },
          { from: 3, to: 5 },
          { from: 5, to: 9 },
        ],
        3,
        7
      )
    ).toEqual([{ from: 0, to: 2 }]);
  });
});

describe("splitSpansByLine", () => {
  it("gives each trimmed piece its own spans, as the split main makes", () => {
    const text = " first word \n\n second word\nthird ";
    const spans = [
      { from: 1, to: 6 },
      { from: 22, to: 26 },
      { from: 27, to: 32 },
    ];
    const pieces = text.split(/\s*\n\s*/).map((piece) => piece.trim());
    const byPiece = splitSpansByLine(text, spans);
    expect(byPiece).toHaveLength(pieces.length);
    expect(byPiece.map((piece, i) => read(pieces[i]!, piece))).toEqual([
      ["first"],
      ["word"],
      ["third"],
    ]);
  });

  it("gives a span across a line break to no piece", () => {
    expect(splitSpansByLine("a\nb", [{ from: 0, to: 3 }])).toEqual([[], []]);
  });
});
