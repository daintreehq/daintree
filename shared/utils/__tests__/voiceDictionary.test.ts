import { describe, expect, it } from "vitest";
import type {
  HeardAsConflict,
  SuggestedDictionaryEntry,
  VoiceDictionaryEntry,
} from "../../types/ipc/api.js";
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
  sessionDictionary,
  sanitizeSuggestions,
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
  it("appends a term, trimmed at the ends only, as a hand-added entry stamped now", () => {
    const next = addDictionaryEntry([entry("Daintree")], { term: "  Docker   Compose \n" }, T1);
    expect(next).toEqual([
      entry("Daintree"),
      { term: "Docker   Compose", heardAs: [], source: "manual", addedAt: T1 },
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

  it("keeps a heard-as form that differs from the term only in case: it is an explicit recase rule", () => {
    const [added] = addDictionaryEntry([], { term: "Go", heardAs: ["go"] }, T1);
    expect(added!.heardAs).toEqual(["go"]);
  });

  it("records the given source and de-duplicates heard-as forms ignoring case", () => {
    const [added] = addDictionaryEntry(
      [],
      { term: "xterm", heardAs: ["ex term", "Ex Term", " ex term "], source: "imported" },
      T1
    );
    expect(added).toEqual({ term: "xterm", heardAs: ["ex term"], source: "imported", addedAt: T1 });
  });

  describe("a heard-as phrase another entry already has", () => {
    const entries = [entry("Zustand", { heardAs: ["zoo stand", "zu stand"] }), entry("Vite")];

    it("refuses the whole add by default, naming the entry it fires for", () => {
      const conflicts: HeardAsConflict[] = [];
      const next = addDictionaryEntry(
        entries,
        { term: "Zoostand", heardAs: ["zoo-stand", "Zoo  Stand"] },
        T1,
        conflicts
      );
      expect(next).toBe(entries);
      expect(conflicts).toEqual([{ phrase: "Zoo  Stand", owner: "Zustand" }]);
    });

    it("leaves the phrase out under skip, keeping the term and every free phrase", () => {
      const conflicts: HeardAsConflict[] = [];
      const next = addDictionaryEntry(
        entries,
        {
          term: "Zoostand",
          heardAs: ["Zoo  Stand", "zoo-stand"],
          source: "imported",
          heardAsConflict: "skip",
        },
        T1,
        conflicts
      );
      expect(next).toEqual([
        ...entries,
        { term: "Zoostand", heardAs: ["zoo-stand"], source: "imported", addedAt: T1 },
      ]);
      expect(next[0]).toBe(entries[0]);
      expect(conflicts).toEqual([{ phrase: "Zoo  Stand", owner: "Zustand" }]);
    });

    it("changes nothing under skip when an existing term only gains claimed phrases", () => {
      expect(
        addDictionaryEntry(
          entries,
          { term: "vite", heardAs: ["zu stand"], heardAsConflict: "skip" },
          T1
        )
      ).toBe(entries);
    });

    it("moves the phrase, in every case and spacing, keeping each entry where it was", () => {
      const legacy = [
        entry("Zustand", { heardAs: ["zoo stand", "zu stand"] }),
        entry("Vite", { source: "imported", addedAt: 7 }),
        entry("Zoo", { heardAs: ["ZOO\tSTAND", "zoo"], source: "learned", addedAt: 9 }),
        entry("Zoo2", { heardAs: [" Zoo   Stand "] }),
      ];
      const conflicts: HeardAsConflict[] = [];
      const next = addDictionaryEntry(
        legacy,
        { term: "vite", heardAs: ["zoo  stand"], heardAsConflict: "move" },
        T1,
        conflicts
      );
      expect(next).toEqual([
        entry("Zustand", { heardAs: ["zu stand"] }),
        entry("Vite", { heardAs: ["zoo  stand"], source: "imported", addedAt: 7 }),
        entry("Zoo", { heardAs: ["zoo"], source: "learned", addedAt: 9 }),
        entry("Zoo2", { heardAs: [] }),
      ]);
      expect(conflicts).toEqual([]);
    });

    it("counts only a copy that can fire as the phrase's owner", () => {
      const legacy = [
        entry("Two\nlines", { heardAs: ["zoo stand"] }),
        entry("Zustand", { heardAs: ["zoo stand", "--"] }),
      ];
      const conflicts: HeardAsConflict[] = [];
      expect(
        updateDictionaryEntry(
          legacy,
          "Zustand",
          { heardAs: ["zoo stand", "--", "zu"] },
          conflicts
        )[1]
      ).toEqual(entry("Zustand", { heardAs: ["zoo stand", "--", "zu"] }));
      expect(
        addDictionaryEntry(legacy, { term: "Dashes", heardAs: ["--"] }, T1, conflicts)
      ).toHaveLength(3);
      expect(conflicts).toEqual([]);
    });

    it("measures whether a copy can fire on its collapsed spacing and written case", () => {
      const legacy = [
        entry("Zoo", { heardAs: [`zoo${" ".repeat(120)}stand`] }),
        entry("Dotted", { heardAs: ["İ".repeat(100)] }),
      ];
      const conflicts: HeardAsConflict[] = [];
      addDictionaryEntry(
        legacy,
        { term: "New", heardAs: ["zoo stand", "İ".repeat(100)] },
        T1,
        conflicts
      );
      expect(conflicts).toEqual([
        { phrase: "zoo stand", owner: "Zoo" },
        { phrase: "İ".repeat(100), owner: "Dotted" },
      ]);
    });

    it("reports a phrase asked for twice in different spacing once", () => {
      const conflicts: HeardAsConflict[] = [];
      addDictionaryEntry(
        entries,
        { term: "Zoo", heardAs: ["zoo stand", "Zoo  Stand"] },
        T1,
        conflicts
      );
      expect(conflicts).toEqual([{ phrase: "zoo stand", owner: "Zustand" }]);
    });

    it("refuses invalid input before it looks for conflicts", () => {
      const conflicts: HeardAsConflict[] = [];
      const tooLong = "a".repeat(MAX_DICTIONARY_TERM_LENGTH + 1);
      expect(() =>
        addDictionaryEntry(entries, { term: "Zoo", heardAs: ["zoo stand", tooLong] }, T1, conflicts)
      ).toThrow(/longer than/);
      expect(() =>
        updateDictionaryEntry(
          entries,
          "Vite",
          { term: "zustand", heardAs: ["zoo stand"] },
          conflicts
        )
      ).toThrow(/already in the dictionary/);
      expect(conflicts).toEqual([]);
    });

    it("is no conflict for the entry the phrase already fires for", () => {
      const legacy = [...entries, entry("Zoo", { heardAs: ["zoo stand"] })];
      const conflicts: HeardAsConflict[] = [];
      const next = addDictionaryEntry(
        legacy,
        { term: "zustand", heardAs: ["Zoo Stand", "zustand js"] },
        T1,
        conflicts
      );
      expect(next[0]!.heardAs).toEqual(["zoo stand", "zu stand", "zustand js"]);
      expect(next[2]).toBe(legacy[2]);
      expect(conflicts).toEqual([]);
    });

    it("takes a phrase back from its owner for an entry holding a copy that never fires", () => {
      const legacy = [...entries, entry("Zoo", { heardAs: ["zoo stand"] })];
      const next = addDictionaryEntry(
        legacy,
        { term: "Zoo", heardAs: ["zoo stand"], heardAsConflict: "move" },
        T1
      );
      expect(next[0]!.heardAs).toEqual(["zu stand"]);
      expect(next[2]).toBe(legacy[2]);
    });
  });

  it("refuses an empty or over-length term or heard-as phrase", () => {
    const tooLong = "a".repeat(MAX_DICTIONARY_TERM_LENGTH + 1);
    expect(() => addDictionaryEntry([], { term: "   " }, T1)).toThrow(/empty/);
    expect(() => addDictionaryEntry([], { term: tooLong }, T1)).toThrow(/longer than/);
    expect(() => addDictionaryEntry([], { term: "ok", heardAs: [tooLong] }, T1)).toThrow(
      /longer than/
    );
    expect(
      addDictionaryEntry([], { term: "a".repeat(MAX_DICTIONARY_TERM_LENGTH) }, T1)
    ).toHaveLength(1);
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
  const entries = [
    entry("Daintree"),
    entry("zustand", { heardAs: ["zoo stand"], source: "learned", addedAt: 5 }),
  ];

  it("renames a term, including a change of case alone, keeping source and time", () => {
    const next = updateDictionaryEntry(entries, "ZUSTAND", { term: "Zustand" });
    expect(next[1]).toEqual({
      term: "Zustand",
      heardAs: ["zoo stand"],
      source: "learned",
      addedAt: 5,
    });
    expect(next[0]).toBe(entries[0]);
  });

  it("replaces the heard-as forms rather than adding to them", () => {
    const next = updateDictionaryEntry(entries, "zustand", { heardAs: ["zu stand", "Zu Stand"] });
    expect(next[1]!.heardAs).toEqual(["zu stand"]);
  });

  it("refuses a rename onto another entry's term", () => {
    expect(() => updateDictionaryEntry(entries, "zustand", { term: "daintree" })).toThrow(
      /already in the dictionary/
    );
  });

  it("keeps the term out of the refusal, since thrown IPC errors are logged", () => {
    let message = "";
    try {
      updateDictionaryEntry(entries, "zustand", { term: "daintree" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/already in the dictionary/);
    expect(message.toLowerCase()).not.toContain("daintree");
    expect(message.toLowerCase()).not.toContain("zustand");
  });

  it("refuses heard-as forms another entry fires for, reporting them rather than throwing", () => {
    const conflicts: HeardAsConflict[] = [];
    const next = updateDictionaryEntry(
      entries,
      "Daintree",
      { term: "daintree", heardAs: ["day tree", "Zoo  Stand"] },
      conflicts
    );
    expect(next).toBe(entries);
    expect(conflicts).toEqual([{ phrase: "Zoo  Stand", owner: "zustand" }]);
  });

  it("moves a phrase back from its owner to an entry holding a copy that never fires", () => {
    const legacy = [...entries, entry("Zoo", { heardAs: ["zoo stand"], addedAt: 9 })];
    const next = updateDictionaryEntry(legacy, "Zoo", {
      heardAs: ["zoo stand"],
      heardAsConflict: "move",
    });
    expect(next[1]!.heardAs).toEqual([]);
    expect(next[2]).toBe(legacy[2]);
  });

  it("moves heard-as forms from the entry that had them when asked to", () => {
    const next = updateDictionaryEntry(entries, "Daintree", {
      heardAs: ["day tree", "Zoo  Stand"],
      heardAsConflict: "move",
    });
    expect(next).toEqual([
      entry("Daintree", { heardAs: ["day tree", "Zoo  Stand"] }),
      entry("zustand", { heardAs: [], source: "learned", addedAt: 5 }),
    ]);
  });

  it("checks only a replaced heard-as list, so a rename alone keeps a copy that never fires", () => {
    const legacy = [...entries, entry("Zoo", { heardAs: ["zoo stand"] })];
    const conflicts: HeardAsConflict[] = [];
    expect(updateDictionaryEntry(legacy, "zoo", { term: "ZOO" }, conflicts)[2]).toEqual(
      entry("ZOO", { heardAs: ["zoo stand"] })
    );
    expect(updateDictionaryEntry(legacy, "Zoo", { heardAs: ["zoo stand"] }, conflicts)).toBe(
      legacy
    );
    expect(conflicts).toEqual([{ phrase: "zoo stand", owner: "zustand" }]);
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
        [
          entry("Zustand", { heardAs: ["zoo stand"] }),
          entry("zustand", { heardAs: ["zu stand"] }),
          "ZUSTAND",
        ],
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

  it("keeps a stored term's internal spacing and length as written", () => {
    expect(dictionaryTerms(sanitizeDictionary(["  Docker   Compose "], T1))).toEqual([
      "Docker   Compose",
    ]);
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

  it("accepting learns the word without a heard form another entry already fires for", () => {
    const state = {
      dictionary: [entry("Zustand", { heardAs: ["zoo stand"] })],
      suggestedDictionary: [suggestion("Zoostand", "Zoo Stand")],
    };
    const conflicts: HeardAsConflict[] = [];
    expect(acceptSuggestion(state, "Zoostand", T1, undefined, conflicts)).toEqual({
      dictionary: [
        entry("Zustand", { heardAs: ["zoo stand"] }),
        { term: "Zoostand", heardAs: [], source: "learned", addedAt: T1 },
      ],
      suggestedDictionary: [],
    });
    expect(conflicts).toEqual([{ phrase: "Zoo Stand", owner: "Zustand" }]);
  });

  it("accepting leaves an everyday heard form out, for a new term or one already there", () => {
    expect(
      acceptSuggestion(
        { dictionary: [], suggestedDictionary: [suggestion("Jest", "just")] },
        "Jest",
        T1
      ).dictionary
    ).toEqual([{ term: "Jest", heardAs: [], source: "learned", addedAt: T1 }]);

    const state = {
      dictionary: [
        entry("Jest"),
        entry("Nuxt", { source: "imported", heardAs: ["nukes"] }),
        entry("useState", { source: "learned", heardAs: ["you state"] }),
      ],
      suggestedDictionary: [
        suggestion("Jest", "just"),
        suggestion("Nuxt", "next"),
        suggestion("useState", "use state"),
      ],
    };
    let accepted = state;
    for (const word of ["Jest", "Nuxt", "useState"]) {
      accepted = acceptSuggestion(accepted, word, T1);
    }
    expect(accepted).toEqual({ dictionary: state.dictionary, suggestedDictionary: [] });
  });

  it("accepting a word no longer queued changes nothing, so a term removed since stays removed", () => {
    const state = { dictionary: [entry("Daintree")], suggestedDictionary: [suggestion("Vite")] };
    expect(acceptSuggestion(state, "Tailwind", T1)).toBe(state);
  });

  it("dismissing drops the suggestion matched ignoring case", () => {
    const queued = [suggestion("Zustand"), suggestion("Vite")];
    const dismissed = dismissSuggestion(queued, [], "ZUSTAND");
    expect(dismissed.suggestedDictionary).toEqual([suggestion("Vite")]);
    expect(dismissed.dismissedSuggestions).toEqual([
      { word: "Zustand", utterance: queued[0]!.utterance },
    ]);
    const none: never[] = [];
    const missing = dismissSuggestion(queued, none, "Bun");
    expect(missing.suggestedDictionary).toBe(queued);
    expect(missing.dismissedSuggestions).toBe(none);
  });

  it("dismissing or accepting the pair that was shown acts on that pair, not the queue's newer copy", () => {
    const queued = [{ ...suggestion("Zustand"), utterance: "zoo stan" }];
    const dismissed = dismissSuggestion(queued, [], "Zustand", "zoo stand");
    expect(dismissed.suggestedDictionary).toBe(queued);
    expect(dismissed.dismissedSuggestions).toEqual([{ word: "Zustand", utterance: "zoo stand" }]);

    const accepted = acceptSuggestion(
      { dictionary: [], suggestedDictionary: queued },
      "Zustand",
      T1,
      "zoo stand"
    );
    expect(accepted.dictionary[0]!.heardAs).toEqual(["zoo stand"]);
  });

  it("a dismissed pair is never suggested again, but the same word heard differently is", () => {
    const dismissed = [{ word: "Zustand", utterance: "zoo stand" }];
    expect(
      mergeSuggestions([{ word: "zustand", original: "Zoo Stand" }], [], [], T1, dismissed)
    ).toBeNull();
    const other = mergeSuggestions(
      [{ word: "Zustand", original: "zoo stan" }],
      [],
      [],
      T1,
      dismissed
    );
    expect(other?.map((e) => e.utterance)).toEqual(["zoo stan"]);
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

    expect(
      mergeSuggestions(
        [{ word: "Daintree", original: "dane tree" }],
        [entry("Daintree")],
        queued,
        T1
      )
    ).toBeNull();

    const full = Array.from({ length: MAX_SUGGESTED_WORDS }, (_, i) => suggestion(`word${i}`));
    const capped = mergeSuggestions([{ word: "Newest", original: "new est" }], [], full, T1)!;
    expect(capped).toHaveLength(MAX_SUGGESTED_WORDS);
    expect(capped[0]!.word).toBe("Newest");
  });
});

describe("sanitizeSuggestions", () => {
  it("defaults missing bookkeeping so a repeat can't produce a broken count", () => {
    const [repaired] = sanitizeSuggestions([{ word: " Vite " }]);
    expect(repaired).toEqual({ word: "Vite", utterance: "", suggestedAt: 0, frequency: 1 });
    const bumped = mergeSuggestions([{ word: "vite", original: "veet" }], [], [repaired!], T1);
    expect(bumped![0]!.frequency).toBe(2);
  });

  it("drops words that are blank, too long to accept, or repeated ignoring case", () => {
    const queued = sanitizeSuggestions([
      suggestion("Zustand"),
      { word: "   " },
      { word: 7 },
      null,
      suggestion("x".repeat(MAX_DICTIONARY_TERM_LENGTH + 1)),
      suggestion("zustand"),
      { word: "Vite", utterance: 3, suggestedAt: -5, frequency: 0.5 },
    ]);
    expect(queued).toEqual([
      suggestion("Zustand"),
      { word: "Vite", utterance: "", suggestedAt: 0, frequency: 1 },
    ]);
    expect(sanitizeSuggestions({ word: "Vite" })).toEqual([]);
  });

  it("trims candidates and ignores ones that could never be added", () => {
    const next = mergeSuggestions(
      [
        { word: "  Zustand ", original: " zoo stand " },
        { word: "   ", original: "um" },
        { word: "y".repeat(MAX_DICTIONARY_TERM_LENGTH + 1), original: "long" },
      ],
      [],
      [],
      T1
    );
    expect(next).toEqual([
      { word: "Zustand", utterance: "zoo stand", suggestedAt: T1, frequency: 1 },
    ]);
  });
});

describe("sessionDictionary", () => {
  const entry = (term: string, heardAs: string[] = []): VoiceDictionaryEntry => ({
    term,
    heardAs,
    source: "manual",
    addedAt: 0,
  });

  it("puts the project's entries first, and the project's entry wins a shared term", () => {
    const merged = sessionDictionary(
      [entry("Global"), entry("daintree", ["dane tree", "dan tree"])],
      [entry("Daintree", ["dane tree"]), entry("PtyClient")]
    );
    expect(merged).toEqual([entry("Daintree", ["dane tree"]), entry("PtyClient"), entry("Global")]);
  });

  it("is the global dictionary alone when the project has none", () => {
    const global = [entry("Global")];
    expect(sessionDictionary(global, [])).toEqual(global);
  });
});
