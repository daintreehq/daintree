import { describe, it, expect } from "vitest";
import {
  soundex,
  levenshtein,
  levenshteinRatio,
  isLearnableTerm,
  findCorrectionCandidates,
} from "../phoneticSimilarity.js";

describe("soundex", () => {
  it("encodes a word as a letter followed by three digits", () => {
    expect(soundex("Robert")).toBe("R163");
    expect(soundex("Rupert")).toBe("R163");
  });

  it("pads short encodings with zeros", () => {
    expect(soundex("Lee")).toBe("L000");
  });

  it("treats H and W as transparent between same-coded consonants", () => {
    // Ashcraft: the S and C are both coded 2, separated by H — collapse to one.
    expect(soundex("Pfister")).toHaveLength(4);
  });

  it("returns empty string for non-alphabetic input", () => {
    expect(soundex("1234")).toBe("");
    expect(soundex("")).toBe("");
  });

  it("gives 'zoo stand' (joined) and 'zustand' the same code", () => {
    expect(soundex("zoostand")).toBe(soundex("zustand"));
  });
});

describe("levenshtein", () => {
  it("is zero for identical strings", () => {
    expect(levenshtein("zustand", "zustand")).toBe(0);
  });

  it("counts single edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("equals the other length when one side is empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });
});

describe("levenshteinRatio", () => {
  it("is 1 for identical strings and for two empty strings", () => {
    expect(levenshteinRatio("abc", "abc")).toBe(1);
    expect(levenshteinRatio("", "")).toBe(1);
  });

  it("decreases as strings diverge", () => {
    expect(levenshteinRatio("zoostand", "zustand")).toBeGreaterThan(0.7);
    expect(levenshteinRatio("cat", "zustand")).toBeLessThan(0.4);
  });
});

describe("isLearnableTerm", () => {
  it("rejects terms shorter than the minimum length", () => {
    expect(isLearnableTerm("vue")).toBe(false);
    expect(isLearnableTerm("zustand")).toBe(true);
  });

  it("rejects pure numbers", () => {
    expect(isLearnableTerm("12345")).toBe(false);
  });

  it("rejects blocklisted keywords and stop words", () => {
    expect(isLearnableTerm("number")).toBe(false);
    expect(isLearnableTerm("interface")).toBe(false);
    expect(isLearnableTerm("there")).toBe(false);
  });
});

describe("findCorrectionCandidates", () => {
  it("detects a multi-word → single-word phonetic correction", () => {
    const result = findCorrectionCandidates(
      "deploy the zoo stand store",
      "deploy the Zustand store"
    );
    expect(result.map((c) => c.word)).toEqual(["Zustand"]);
    expect(result[0]?.original).toBe("zoo stand");
  });

  it("detects a single-word phonetic correction", () => {
    const result = findCorrectionCandidates(
      "use cuber netties for orchestration",
      "use Kubernetes for orchestration"
    );
    expect(result.map((c) => c.word)).toContain("Kubernetes");
  });

  it("ignores unrelated rewrites that are not phonetically similar", () => {
    const result = findCorrectionCandidates("send the message now", "delete the message now");
    expect(result).toEqual([]);
  });

  it("ignores identical text", () => {
    expect(findCorrectionCandidates("nothing changed here", "nothing changed here")).toEqual([]);
  });

  it("ignores pure additions and deletions", () => {
    expect(findCorrectionCandidates("run the build", "run the build now please")).toEqual([]);
    expect(findCorrectionCandidates("run the full build", "run the build")).toEqual([]);
  });

  it("does not suggest blocklisted or too-short corrected words", () => {
    // "their" → "there" is a homophone but both are stop words.
    expect(findCorrectionCandidates("put it over their", "put it over there")).toEqual([]);
  });

  it("does not suggest pure numbers", () => {
    expect(findCorrectionCandidates("send 1234 now", "send 5678 now")).toEqual([]);
  });

  it("ignores case-only differences from AI correction", () => {
    expect(findCorrectionCandidates("install zustand today", "install Zustand today")).toEqual([]);
  });

  it("dedupes repeated corrections to the same term", () => {
    const result = findCorrectionCandidates(
      "zoo stand and zoo stand again",
      "Zustand and Zustand again"
    );
    expect(result.map((c) => c.word)).toEqual(["Zustand"]);
  });

  it("strips leading and trailing punctuation from the suggested word", () => {
    const result = findCorrectionCandidates("use zoo stand.", "use Zustand.");
    expect(result.map((c) => c.word)).toEqual(["Zustand"]);
  });

  it("does not learn words the user typed after the dictated term", () => {
    // "and"/"tests" were appended, not dictated — must not leak in as terms.
    const result = findCorrectionCandidates("zoo stand", "Zustand and tests");
    expect(result.map((c) => c.word)).not.toContain("tests");
  });

  it("handles empty input without throwing", () => {
    expect(findCorrectionCandidates("", "")).toEqual([]);
    expect(findCorrectionCandidates("hello", "")).toEqual([]);
  });

  it("handles unicode input without throwing", () => {
    expect(() => findCorrectionCandidates("café résumé naïve", "cafe resume naive")).not.toThrow();
  });
});
