import { describe, expect, it } from "vitest";
import {
  alignWordStarts,
  buildCaptions,
  estimateTiming,
  hashNarration,
  narrationFingerprint,
  parseNarration,
  stripDirectionTags,
} from "../tourNarration";

describe("parseNarration", () => {
  it("strips cue markers and records the word each cue fires on", () => {
    const parsed = parseNarration("Click the [[plus]]plus button, then [[type]] type a name.");
    expect(parsed.text).toBe("Click the plus button, then type a name.");
    expect(parsed.words[parsed.cueWordIndex.plus!]).toBe("plus");
    expect(parsed.words[parsed.cueWordIndex.type!]).toBe("type");
  });

  it("keeps delivery directions for the voice and out of the words and cues", () => {
    const parsed = parseNarration(
      "[informative] Click [[plus]] the plus. [lower voice, more serious] Then [sigh] wait."
    );
    expect(parsed.text).toBe("Click the plus. Then wait.");
    expect(parsed.words[parsed.cueWordIndex.plus!]).toBe("the");
    expect(parsed.spoken).toBe(
      "[informative] Click the plus. [lower voice, more serious] Then [sigh] wait."
    );
  });

  it("rejects a delivery direction with nothing to say after it", () => {
    expect(() => parseNarration("All done. [happy]")).toThrow(/no words after it/);
  });

  it("rejects duplicate cues and cues with nothing after them", () => {
    expect(() => parseNarration("[[a]] one [[a]] two")).toThrow(/Duplicate/);
    expect(() => parseNarration("one two [[end]]")).toThrow(/no word/);
  });
});

describe("alignWordStarts", () => {
  it("pins every word through tokenizer differences in punctuation and spacing", () => {
    const words = ["Welcome", "to", "Daintree.", "Every", "task"];
    const aligned = alignWordStarts(words, {
      words: ["", "Welcome", " ", "to", " ", "Daintree", ". ", "Every", " ", "task", ""],
      wordStartTimeSeconds: [0, 0.3, 0.8, 0.8, 0.9, 0.94, 1.75, 2.31, 2.7, 2.73, 3.4],
      wordEndTimeSeconds: [0.3, 0.8, 0.8, 0.94, 0.94, 1.75, 2.31, 2.73, 2.73, 3.4, 3.5],
    });
    expect(aligned).toEqual({ starts: [0.3, 0.8, 0.94, 2.31, 2.73], matched: 5 });
  });

  it("keeps every matching word on its real time when one word was misheard", () => {
    const words = ["Now", "wait", "then", "click", "plus", "and", "done"];
    const aligned = alignWordStarts(words, {
      words: ["Now", "weight", "then", "click", "plus", "and", "done"],
      wordStartTimeSeconds: [0, 0.5, 1, 1.5, 2, 2.5, 3],
      wordEndTimeSeconds: [0.4, 0.9, 1.4, 1.9, 2.4, 2.9, 3.4],
    });
    expect(aligned.matched).toBe(6);
    expect(aligned.starts[4]).toBe(2);
    expect(aligned.starts[1]).toBeGreaterThan(0);
    expect(aligned.starts[1]).toBeLessThan(1);
  });

  it("reports nothing matched for an empty alignment", () => {
    expect(
      alignWordStarts(["a", "b"], { words: [], wordStartTimeSeconds: [], wordEndTimeSeconds: [] })
        .matched
    ).toBe(0);
  });
});

describe("buildCaptions", () => {
  it("splits on sentence ends and chains each caption to the next start", () => {
    const captions = buildCaptions(["One", "two.", "Three", "four?", "Five"], [0, 1, 2, 3, 4], 6);
    expect(captions).toEqual([
      { start: 0, end: 2, text: "One two." },
      { start: 2, end: 4, text: "Three four?" },
      { start: 4, end: 6, text: "Five" },
    ]);
  });
});

describe("estimateTiming", () => {
  it("orders cues by their position in the narration", () => {
    const timing = estimateTiming("First [[a]] alpha, then later [[b]] bravo. And [[c]] charlie.");
    expect(timing.cues.a!).toBeLessThan(timing.cues.b!);
    expect(timing.cues.b!).toBeLessThan(timing.cues.c!);
    expect(timing.duration).toBeGreaterThan(timing.cues.c!);
    expect(timing.audioUrl).toBeNull();
  });
});

describe("hashNarration", () => {
  it("changes when the spoken text changes", () => {
    expect(hashNarration("a b c")).not.toBe(hashNarration("a b d"));
    expect(hashNarration("a b c")).toBe(hashNarration("a b c"));
  });
});

describe("narrationFingerprint", () => {
  it("changes when only a delivery direction changes", () => {
    expect(narrationFingerprint(parseNarration("[happy] Welcome in"))).not.toBe(
      narrationFingerprint(parseNarration("[sad] Welcome in"))
    );
  });

  it("changes when a cue moves or is renamed even though the words don't", () => {
    const base = narrationFingerprint(parseNarration("Click [[a]] the plus button"));
    expect(narrationFingerprint(parseNarration("Click the [[a]] plus button"))).not.toBe(base);
    expect(narrationFingerprint(parseNarration("Click [[b]] the plus button"))).not.toBe(base);
    expect(narrationFingerprint(parseNarration("Click [[a]] the plus button"))).toBe(base);
  });
});

describe("stripDirectionTags", () => {
  it("drops delivery tags so the spoken words still align exactly", () => {
    const alignment = stripDirectionTags({
      words: ["[informative]", " ", "Welcome", " ", "to", " ", "Daintree", "."],
      wordStartTimeSeconds: [0, 0, 0, 0.41, 0.41, 0.53, 0.53, 1.11],
      wordEndTimeSeconds: [0, 0, 0.41, 0.41, 0.53, 0.53, 1.11, 1.2],
    });
    expect(alignment.words).not.toContain("[informative]");
    expect(alignWordStarts(["Welcome", "to", "Daintree."], alignment)).toEqual({
      starts: [0, 0.41, 0.53],
      matched: 3,
    });
  });
});
