import { describe, it, expect } from "vitest";
import {
  soundex,
  levenshtein,
  levenshteinRatio,
  isLearnableTerm,
  findCorrectionCandidates,
} from "../phoneticSimilarity.js";
import { isCommonEnglishWord } from "../commonEnglishWords.js";

describe("soundex", () => {
  it("encodes a word as a letter followed by three digits", () => {
    expect(soundex("Robert")).toBe("R163");
    expect(soundex("Rupert")).toBe("R163");
  });

  it("pads short encodings with zeros", () => {
    expect(soundex("Lee")).toBe("L000");
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

  it("ignores a capital the user added at the start of a sentence", () => {
    expect(findCorrectionCandidates("install it. then run", "install it. Then run")).toEqual([]);
    expect(findCorrectionCandidates("zustand is next", "Zustand is next")).toEqual([]);
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
    expect(result.map((c) => c.word)).not.toContain("Zustand and tests");
  });

  it("handles empty input without throwing", () => {
    expect(findCorrectionCandidates("", "")).toEqual([]);
    expect(findCorrectionCandidates("hello", "")).toEqual([]);
  });
});

describe("findCorrectionCandidates: rewording versus mishearing (#14645)", () => {
  it.each([
    ["modal", "model"],
    ["settings", "sessions"],
    ["faster", "further"],
    ["push", "publish"],
  ])("does not suggest the rewording %s → %s", (said, sent) => {
    expect(findCorrectionCandidates(`check the ${said} first`, `check the ${sent} first`)).toEqual(
      []
    );
  });

  it.each([
    ["daintree", "Daintree"],
    ["use state", "useState"],
    ["dock or compose", "Docker Compose"],
    ["ex term", "xterm"],
  ])("suggests the fix %s → %s", (said, sent) => {
    const result = findCorrectionCandidates(`check the ${said} first`, `check the ${sent} first`);
    expect(result).toEqual([{ word: sent, original: said }]);
  });

  it("does not suggest a correction to a common English word", () => {
    expect(findCorrectionCandidates("open the wonder now", "open the window now")).toEqual([]);
    expect(findCorrectionCandidates("check the stations", "check the sessions")).toEqual([]);
  });

  it("still suggests a capitalised name that is also a common word", () => {
    const result = findCorrectionCandidates("migrate to racked now", "migrate to React now");
    expect(result.map((c) => c.word)).toEqual(["React"]);
  });

  it("does not suggest lowering a capital the dictation had", () => {
    expect(findCorrectionCandidates("open Daintree now", "open daintree now")).toEqual([]);
  });

  it("treats inflected forms of everyday words as everyday words", () => {
    expect(findCorrectionCandidates("the bitter one", "the better one")).toEqual([]);
    expect(findCorrectionCandidates("two stations left", "two sessions left")).toEqual([]);
    expect(findCorrectionCandidates("it was stopped", "it was shopped")).toEqual([]);
  });

  it("does not suggest a capital the user added to an everyday word", () => {
    expect(findCorrectionCandidates("pick a model now", "pick a Model now")).toEqual([]);
  });

  it("does not suggest a long rewrite as one term", () => {
    expect(
      findCorrectionCandidates("use zoo stand for all the state", "use Zustand Redux Jotai MobX")
    ).toEqual([]);
  });
});

describe("isCommonEnglishWord", () => {
  it("recognises base forms and their inflections", () => {
    expect(isCommonEnglishWord("session")).toBe(true);
    expect(isCommonEnglishWord("sessions")).toBe(true);
    expect(isCommonEnglishWord("studies")).toBe(true);
    expect(isCommonEnglishWord("stopped")).toBe(true);
    expect(isCommonEnglishWord("bigger")).toBe(true);
  });

  it("does not recognise technical names", () => {
    for (const word of ["zustand", "kubernetes", "daintree", "xterm", "docker", "usestate"]) {
      expect(isCommonEnglishWord(word)).toBe(false);
    }
  });
});
