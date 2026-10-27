import { describe, expect, it } from "vitest";
import {
  CorrectionStreamAligner,
  wordKeys,
  type StreamedRewrite,
} from "@/services/voiceCorrectionStream";

/** Each prefix main would send: the corrected text cut at its last whitespace. */
function prefixes(corrected: string): string[] {
  const out: string[] = [];
  for (const match of corrected.matchAll(/\s+/g)) out.push(corrected.slice(0, match.index));
  return out;
}

function lastKey(text: string): string | undefined {
  const words = text.trim().split(/\s+/);
  for (let i = words.length - 1; i >= 0; i--) {
    const keys = wordKeys(words[i]!);
    if (keys.length > 0) return keys[keys.length - 1];
  }
  return undefined;
}

/**
 * Streams `corrected` over `dictated` and returns every distinct rewrite,
 * checking on the way that the rewrite only moves forward and that each
 * commit ends on a word the two sides share.
 */
function stream(dictated: string, corrected: string): StreamedRewrite[] {
  const aligner = new CorrectionStreamAligner(dictated);
  const seen: StreamedRewrite[] = [];
  for (const prefix of prefixes(corrected)) {
    const rewrite = aligner.advance(prefix);
    if (!rewrite || rewrite === seen[seen.length - 1]) continue;
    const prev = seen[seen.length - 1];
    if (prev) {
      expect(rewrite.rawTo).toBeGreaterThan(prev.rawTo);
      expect(rewrite.text.startsWith(prev.text)).toBe(true);
      expect(rewrite.text.length).toBeGreaterThan(prev.text.length);
    }
    expect(corrected.startsWith(rewrite.text)).toBe(true);
    const streamedKey = lastKey(rewrite.text)!;
    const dictatedKey = lastKey(dictated.slice(0, rewrite.rawTo))!;
    expect(streamedKey === dictatedKey || streamedKey.length >= 5).toBe(true);
    seen.push(rewrite);
  }
  return seen;
}

function shown(dictated: string, rewrite: StreamedRewrite | undefined): string {
  return rewrite ? rewrite.text + dictated.slice(rewrite.rawTo) : dictated;
}

function rawTo(dictated: string, through: string): number {
  const at = dictated.indexOf(through);
  expect(at).toBeGreaterThanOrEqual(0);
  return at + through.length;
}

describe("wordKeys", () => {
  it("ignores case and punctuation", () => {
    expect(wordKeys("Parser.")).toEqual(["parser"]);
    expect(wordKeys("(maybe),")).toEqual(["maybe"]);
    expect(wordKeys("—")).toEqual([]);
  });

  it("splits on hyphens and slashes", () => {
    expect(wordKeys("well-known")).toEqual(["well", "known"]);
    expect(wordKeys("/review")).toEqual(["review"]);
  });

  it("spells out contractions, curly apostrophes included", () => {
    expect(wordKeys("don't")).toEqual(["do", "not"]);
    expect(wordKeys("Can’t")).toEqual(["can", "not"]);
    expect(wordKeys("won't")).toEqual(["will", "not"]);
    expect(wordKeys("cannot")).toEqual(["can", "not"]);
    expect(wordKeys("we're")).toEqual(["we", "are"]);
    expect(wordKeys("it's")).toEqual(["it", "is"]);
    expect(wordKeys("let's")).toEqual(["let", "us"]);
  });

  it("writes number words, ordinals and list markers as digits", () => {
    expect(wordKeys("two")).toEqual(["2"]);
    expect(wordKeys("Twenty")).toEqual(["20"]);
    expect(wordKeys("first")).toEqual(["1"]);
    expect(wordKeys("3rd")).toEqual(["3"]);
    expect(wordKeys("1.")).toEqual(["1"]);
    expect(wordKeys("2)")).toEqual(["2"]);
  });
});

describe("CorrectionStreamAligner", () => {
  it("rewrites an unchanged passage word by word, holding back the newest word", () => {
    const dictated = "fix the bug in the parser";
    const seen = stream(dictated, "Fix the bug in the parser.");
    expect(seen.map((r) => r.text)).toEqual(["Fix", "Fix the", "Fix the bug", "Fix the bug in"]);
    expect(shown(dictated, seen.at(-1))).toBe("Fix the bug in the parser");
  });

  it("follows the stream past removed filler", () => {
    const dictated = "um so I think we should uh refactor the parser";
    const seen = stream(dictated, "So I think we should refactor the parser now.");
    // Dropped filler goes once two words past it match, taking only those.
    expect(seen[0]).toEqual({ text: "So I", rawTo: rawTo(dictated, "um so I") });
    expect(seen).toContainEqual({ text: "So I think we should", rawTo: rawTo(dictated, "should") });
    expect(seen.some((r) => r.text === "So I think we should refactor")).toBe(false);
    expect(seen.at(-1)).toEqual({
      text: "So I think we should refactor the",
      rawTo: rawTo(dictated, "uh refactor the"),
    });
    expect(shown(dictated, seen.at(-1))).toBe("So I think we should refactor the parser");
  });

  it("swaps a misheard term once the stream is past it", () => {
    const dictated = "open the dame tree settings and check the postgress config now";
    const seen = stream(dictated, "Open the Daintree settings and check the Postgres config now.");
    // "Daintree" matches neither heard word; it lands with the next shared one.
    expect(seen.some((r) => r.text === "Open the Daintree")).toBe(false);
    expect(seen.some((r) => r.text === "Open the Daintree settings")).toBe(false);
    expect(seen).toContainEqual({
      text: "Open the Daintree settings and",
      rawTo: rawTo(dictated, "settings and"),
    });
    // A near spelling is the same word.
    expect(seen.at(-1)).toEqual({
      text: "Open the Daintree settings and check the Postgres",
      rawTo: rawTo(dictated, "postgress"),
    });
  });

  it("drops a self-correction only once the stream has moved past it", () => {
    const dictated = "send it to John no wait send it to Mary and copy Bob on it";
    const seen = stream(dictated, "Send it to Mary and copy Bob on it.");
    expect(seen[2]).toEqual({ text: "Send it to", rawTo: rawTo(dictated, "send it to") });
    expect(seen[3]).toEqual({ text: "Send it to Mary and", rawTo: rawTo(dictated, "Mary and") });
    for (const rewrite of seen) {
      // Either "John" still shows or "Mary" has replaced it: never neither.
      const display = shown(dictated, rewrite);
      expect(display.includes("John") || rewrite.text.includes("Mary")).toBe(true);
    }
    expect(seen.at(-1)).toEqual({
      text: "Send it to Mary and copy Bob",
      rawTo: rawTo(dictated, "copy Bob"),
    });
    expect(shown(dictated, seen.at(-1))).toBe("Send it to Mary and copy Bob on it");
  });

  it("keeps a command moved to the front from reaching for its spoken words", () => {
    const dictated = "fix the login bug and then run the review skill";
    const seen = stream(dictated, "/review fix the login bug");
    expect(seen.map((r) => r.text)).toEqual(["/review fix the"]);
    expect(seen.at(-1)!.rawTo).toBe(rawTo(dictated, "fix the"));
    expect(shown(dictated, seen.at(-1))).toBe(
      "/review fix the login bug and then run the review skill"
    );
  });

  it("lays out a spoken list as the stream reaches each item", () => {
    const dictated = "first install the deps second run the tests third ship it";
    const corrected = "1. Install the deps\n2. Run the tests\n3. Ship it";
    const seen = stream(dictated, corrected);
    expect(seen).toContainEqual({
      text: "1. Install the deps\n2.",
      rawTo: rawTo(dictated, "second"),
    });
    expect(seen.at(-1)).toEqual({
      text: "1. Install the deps\n2. Run the tests\n3.",
      rawTo: rawTo(dictated, "third"),
    });
  });

  it("doesn't pass dictated words on a match the newest word contradicts", () => {
    const dictated = "we need to ad the Add button to the toolbar";
    const seen = stream(dictated, "We need to add the Add button to the toolbar.");
    for (const rewrite of seen) {
      // "the Add" stays visible until the stream has written it.
      const display = shown(dictated, rewrite);
      expect(display.includes("the Add") || rewrite.text.includes("the Add")).toBe(true);
    }
    expect(seen.at(-1)).toEqual({
      text: "We need to add the Add button to",
      rawTo: rawTo(dictated, "button to"),
    });
  });

  it("doesn't take a repeated phrase just ahead for the one the stream is on", () => {
    const dictated = "we need to ad the Add the item button to the toolbar";
    const seen = stream(dictated, "We need to add the Add the item button to the toolbar.");
    for (const rewrite of seen) {
      const display = shown(dictated, rewrite);
      expect(
        display.includes("the Add the item") || rewrite.text.includes("the Add the item")
      ).toBe(true);
    }
    expect(seen.at(-1)).toEqual({
      text: "We need to add the Add the item button to",
      rawTo: rawTo(dictated, "button to"),
    });
  });

  it("keeps each update's alignment bounded when one word is a long path", () => {
    const path = "a/".repeat(5000);
    const aligner = new CorrectionStreamAligner(`fix ${path} tail end`);
    const started = performance.now();
    const rewrite = aligner.advance(`Fix ${path} tail and`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(rewrite).toEqual({ text: "Fix", rawTo: 3 });
  });

  it("treats a word that names a built-in property as an ordinary word", () => {
    expect(wordKeys("constructor")).toEqual(["constructor"]);
    const dictated = "fix the constructer before shipping it";
    const seen = stream(dictated, "Fix the constructor before shipping it.");
    expect(seen).toContainEqual({
      text: "Fix the constructor",
      rawTo: rawTo(dictated, "constructer"),
    });
  });

  it.each([
    ['open @"my file.ts" now and check it', 'Open @"my file.ts" now and check it.'],
    ['open (@"my file.ts") now and check it', 'Open (@"my file.ts") now and check it.'],
    [
      'open @"my \\"special file.ts" now and check it',
      'Open @"my \\"special file.ts" now and check it.',
    ],
  ])("never ends a rewrite inside a quoted file reference: %s", (dictated, corrected) => {
    const chipFrom = dictated.indexOf("@");
    const chipTo = dictated.lastIndexOf('"') + 1;
    const seen = stream(dictated, corrected);
    for (const rewrite of seen) {
      expect(rewrite.rawTo > chipFrom && rewrite.rawTo < chipTo).toBe(false);
    }
    expect(seen.some((rewrite) => rewrite.rawTo >= chipTo)).toBe(true);
  });

  it("doesn't jump ahead on one common word matching by chance", () => {
    const aligner = new CorrectionStreamAligner("alpha beta gamma the delta epsilon");
    expect(aligner.advance("Zeta eta the theta iota kappa ")).toBeNull();
  });

  it("commits nothing when the stream shares no words with the passage", () => {
    const aligner = new CorrectionStreamAligner("alpha beta gamma delta");
    expect(aligner.advance("one two three four five ")).toBeNull();
  });

  it("holds its rewrite when the stream stops agreeing with what it showed", () => {
    const aligner = new CorrectionStreamAligner("fix the bug in the parser");
    const first = aligner.advance("Fix the bug in");
    expect(first).toEqual({ text: "Fix the bug", rawTo: 11 });
    expect(aligner.advance("Mend the bug in the")).toBe(first);
  });

  it("spells a contraction the same on both sides", () => {
    const dictated = "we do not want to ship it yet";
    const seen = stream(dictated, "We don't want to ship it yet.");
    expect(seen).toContainEqual({ text: "We don't", rawTo: rawTo(dictated, "do not") });
  });

  it("keeps each update bounded on a long passage", () => {
    const words = Array.from({ length: 1500 }, (_, i) => `word${i % 37} filler${i % 11}`);
    const dictated = words.join(" ");
    const corrected = words.map((w) => w.split(" ")[0]).join(" ");
    const aligner = new CorrectionStreamAligner(dictated);
    const started = performance.now();
    let rewrite: StreamedRewrite | null = null;
    for (const prefix of prefixes(corrected)) rewrite = aligner.advance(prefix);
    expect(performance.now() - started).toBeLessThan(5000);
    // Every "fillerN" between kept words is dropped as the stream passes it;
    // the rewrite trails the stream by the words that confirm the last drop.
    expect(rewrite!.rawTo).toBeGreaterThan(dictated.length - 60);
  });
});
