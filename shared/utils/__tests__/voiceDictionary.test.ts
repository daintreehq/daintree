import { describe, expect, it } from "vitest";
import type { SuggestedDictionaryEntry, VoiceDictionaryEntry } from "../../types/ipc/api.js";
import {
  MAX_DICTIONARY_TERM_LENGTH,
  MAX_SUGGESTED_WORDS,
  acceptSuggestion,
  addDictionaryEntry,
  dictionaryTerms,
  dismissSuggestion,
  mergeSuggestions,
  removeDictionaryEntry,
  sanitizeDictionary,
  updateDictionaryEntry,
} from "../voiceDictionary.js";

const T0 = 1_000;
const T1 = 2_000;

function entry(term: string, extra: Partial<VoiceDictionaryEntry> = {}): VoiceDictionaryEntry {
  return { term, heardAs: [], source: "manual", addedAt: T0, ...extra };
}

function suggestion(word: string, utterance = ""): SuggestedDictionaryEntry {
  return { word, utterance, suggestedAt: T0, frequency: 1 };
}

describe("addDictionaryEntry", () => {
  it("appends a trimmed term as a hand-added entry stamped now", () => {
    const next = addDictionaryEntry([entry("Daintree")], { term: "  Docker   Compose \n" }, T1);
    expect(next).toEqual([
      entry("Daintree"),
      { term: "Docker Compose", heardAs: [], source: "manual", addedAt: T1 },
    ]);
  });

  it("treats a term already there under any casing as a duplicate, keeping the stored spelling", () => {
    const entries = [entry("Daintree")];
    expect(addDictionaryEntry(entries, { term: "daintree" }, T1)).toBe(entries);
    expect(addDictionaryEntry(entries, { term: "DAINTREE " }, T1)).toBe(entries);
  });

  it("adds only new heard-as forms to an existing entry, leaving its source and time", () => {
    const entries = [entry("Zustand", { heardAs: ["zoo stand"], source: "learned" })];
    const next = addDictionaryEntry(
      entries,
      { term: "zustand", heardAs: ["Zoo Stand", "zoo-stand"], source: "imported" },
      T1
    );
    expect(next).toEqual([
      entry("Zustand", { heardAs: ["zoo stand", "zoo-stand"], source: "learned" }),
    ]);
  });

  it("records the given source and de-duplicates heard-as forms ignoring case", () => {
    const [added] = addDictionaryEntry(
      [],
      { term: "xterm", heardAs: ["ex term", "Ex Term", " ex  term "], source: "imported" },
      T1
    );
    expect(added).toEqual({ term: "xterm", heardAs: ["ex term"], source: "imported", addedAt: T1 });
  });

  it("refuses an empty or over-length term or heard-as phrase", () => {
    const tooLong = "a".repeat(MAX_DICTIONARY_TERM_LENGTH + 1);
    expect(() => addDictionaryEntry([], { term: "   " }, T1)).toThrow(/empty/);
    expect(() => addDictionaryEntry([], { term: tooLong }, T1)).toThrow(/longer than/);
    expect(() => addDictionaryEntry([], { term: "ok", heardAs: [tooLong] }, T1)).toThrow(
      /longer than/
    );
    expect(addDictionaryEntry([], { term: "a".repeat(MAX_DICTIONARY_TERM_LENGTH) }, T1)).toHaveLength(
      1
    );
  });
});

describe("removeDictionaryEntry", () => {
  it("removes the entry matched ignoring case, and is a no-op for a missing term", () => {
    const entries = [entry("Daintree"), entry("Zustand")];
    expect(removeDictionaryEntry(entries, " daintree ")).toEqual([entry("Zustand")]);
    expect(removeDictionaryEntry(entries, "Vite")).toBe(entries);
  });
});

describe("updateDictionaryEntry", () => {
  const entries = [entry("Daintree"), entry("zustand", { heardAs: ["zoo stand"] })];

  it("renames a term, including a change of case alone, keeping source and time", () => {
    const next = updateDictionaryEntry(entries, "ZUSTAND", { term: "Zustand" });
    expect(next[1]).toEqual(entry("Zustand", { heardAs: ["zoo stand"] }));
    expect(next[0]).toBe(entries[0]);
  });

  it("replaces the heard-as forms", () => {
    const next = updateDictionaryEntry(entries, "zustand", { heardAs: ["zoo stand", "Zoo Stand", "zu stand"] });
    expect(next[1]!.heardAs).toEqual(["zoo stand", "zu stand"]);
  });

  it("refuses a rename onto another entry's term", () => {
    expect(() => updateDictionaryEntry(entries, "zustand", { term: "daintree" })).toThrow(
      /already in the dictionary/
    );
  });

  it("leaves the list alone when the entry is gone or nothing changes", () => {
    expect(updateDictionaryEntry(entries, "Vite", { term: "vite" })).toBe(entries);
    expect(updateDictionaryEntry(entries, "Daintree", { term: " Daintree " })).toBe(entries);
    expect(updateDictionaryEntry(entries, "zustand", { heardAs: ["zoo stand"] })).toBe(entries);
  });
});

describe("sanitizeDictionary", () => {
  it("turns bare strings into hand-added entries and keeps valid entries as stored", () => {
    const stored = entry("Zustand", { heardAs: ["zoo stand"], source: "learned", addedAt: 5 });
    expect(sanitizeDictionary(["Daintree", stored], T1)).toEqual([
      { term: "Daintree", heardAs: [], source: "manual", addedAt: T1 },
      stored,
    ]);
  });

  it("folds a repeat that differs only in case into the first, merging its heard-as forms", () => {
    expect(
      sanitizeDictionary(
        [entry("Zustand", { heardAs: ["zoo stand"] }), entry("zustand", { heardAs: ["zu stand"] }), "ZUSTAND"],
        T1
      )
    ).toEqual([entry("Zustand", { heardAs: ["zoo stand", "zu stand"] })]);
  });

  it("drops what has no usable term and repairs bad fields", () => {
    expect(
      sanitizeDictionary(
        [
          "",
          "   ",
          42,
          null,
          { heardAs: ["x"] },
          { term: "Vite", heardAs: "veet", source: "telepathy", addedAt: -1 },
          { term: "Bun", heardAs: ["", 7, "bun"], source: "imported", addedAt: Number.NaN },
        ],
        T1
      )
    ).toEqual([
      { term: "Vite", heardAs: [], source: "manual", addedAt: T1 },
      { term: "Bun", heardAs: ["bun"], source: "imported", addedAt: T1 },
    ]);
    expect(sanitizeDictionary("Daintree", T1)).toEqual([]);
    expect(sanitizeDictionary(undefined, T1)).toEqual([]);
  });

  it("keeps a stored term longer than the add limit as written", () => {
    const long = "y".repeat(MAX_DICTIONARY_TERM_LENGTH + 40);
    expect(dictionaryTerms(sanitizeDictionary([long], T1))).toEqual([long]);
  });
});

describe("suggestions", () => {
  it("accepting moves the suggestion into a learned entry that keeps its heard-as form", () => {
    const state = {
      dictionary: [entry("Daintree")],
      suggestedDictionary: [suggestion("Zustand", "zoo stand"), suggestion("Vite", "veet")],
    };
    expect(acceptSuggestion(state, "zustand", T1)).toEqual({
      dictionary: [
        entry("Daintree"),
        { term: "Zustand", heardAs: ["zoo stand"], source: "learned", addedAt: T1 },
      ],
      suggestedDictionary: [suggestion("Vite", "veet")],
    });
  });

  it("accepting a word already in the dictionary adds its heard-as form to that entry", () => {
    const state = {
      dictionary: [entry("Zustand")],
      suggestedDictionary: [suggestion("zustand", "zoo stand")],
    };
    expect(acceptSuggestion(state, "Zustand", T1)).toEqual({
      dictionary: [entry("Zustand", { heardAs: ["zoo stand"] })],
      suggestedDictionary: [],
    });
  });

  it("accepting a word no longer queued still adds it", () => {
    const state = { dictionary: [], suggestedDictionary: [] };
    const next = acceptSuggestion(state, "Tailwind", T1);
    expect(next.dictionary).toEqual([
      { term: "Tailwind", heardAs: [], source: "learned", addedAt: T1 },
    ]);
    expect(next.suggestedDictionary).toBe(state.suggestedDictionary);
  });

  it("dismissing drops the suggestion matched ignoring case", () => {
    const queued = [suggestion("Zustand"), suggestion("Vite")];
    expect(dismissSuggestion(queued, "ZUSTAND")).toEqual([suggestion("Vite")]);
    expect(dismissSuggestion(queued, "Bun")).toBe(queued);
  });

  it("merging skips dictionary terms, bumps repeats, puts new words first and caps the queue", () => {
    const queued = [suggestion("Vite", "veet")];
    const next = mergeSuggestions(
      [
        { word: "daintree", original: "dane tree" },
        { word: "vite", original: "vight" },
        { word: "Zustand", original: "zoo stand" },
      ],
      [entry("Daintree")],
      queued,
      T1
    );
    expect(next).toEqual([
      { word: "Zustand", utterance: "zoo stand", suggestedAt: T1, frequency: 1 },
      { word: "Vite", utterance: "vight", suggestedAt: T1, frequency: 2 },
    ]);

    expect(mergeSuggestions([{ word: "Daintree", original: "dane tree" }], [entry("Daintree")], queued, T1)).toBeNull();

    const full = Array.from({ length: MAX_SUGGESTED_WORDS }, (_, i) => suggestion(`word${i}`));
    const capped = mergeSuggestions([{ word: "Newest", original: "new est" }], [], full, T1)!;
    expect(capped).toHaveLength(MAX_SUGGESTED_WORDS);
    expect(capped[0]!.word).toBe("Newest");
  });
});
