import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migration036 } from "../036-structured-voice-dictionary.js";
import { sanitizeDictionary } from "../../../../shared/utils/voiceDictionary.js";

const NOW = 1_760_000_000_000;

function run(initial: Record<string, unknown>, times = 1) {
  const data: Record<string, unknown> = structuredClone(initial);
  const store = {
    get: vi.fn((key: string) => structuredClone(data[key])),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration036.up>[0];
  for (let i = 0; i < times; i++) migration036.up(store);
  return { data, store };
}

describe("migration036 — structured voice dictionary entries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("moves every word into an entry, in order, and deletes the old list", () => {
    const { data } = run({
      voiceInput: {
        enabled: true,
        language: "en",
        customDictionary: ["Daintree", "Zustand", "node-pty", "xterm"],
        suggestedDictionary: [{ word: "Vite", utterance: "veet", suggestedAt: 1, frequency: 2 }],
      },
    });

    expect(data.voiceInput).toEqual({
      enabled: true,
      language: "en",
      dictionary: ["Daintree", "Zustand", "node-pty", "xterm"].map((term) => ({
        term,
        heardAs: [],
        source: "manual",
        addedAt: NOW,
      })),
      suggestedDictionary: [{ word: "Vite", utterance: "veet", suggestedAt: 1, frequency: 2 }],
    });
  });

  it("keeps long and unusual terms exactly as written, trimming only the ends", () => {
    const long = "x".repeat(1_400);
    const { data } = run({
      voiceInput: {
        customDictionary: ["  spaced term  ", "Docker   Compose", long, "C++", "12345", "日本語"],
      },
    });

    const terms = (data.voiceInput as { dictionary: { term: string }[] }).dictionary.map(
      (e) => e.term
    );
    expect(terms).toEqual(["spaced term", "Docker   Compose", long, "C++", "12345", "日本語"]);

    // Reading the migrated entries back changes none of them.
    const migrated = (data.voiceInput as { dictionary: unknown[] }).dictionary;
    expect(sanitizeDictionary(migrated, NOW + 1)).toEqual(migrated);
  });

  it("keeps the first spelling of a repeat that differs only in case, and drops blanks and non-strings", () => {
    const { data } = run({
      voiceInput: {
        customDictionary: ["Daintree", "", "   ", 42, null, "daintree", "DAINTREE", "Go"],
      },
    });

    const terms = (data.voiceInput as { dictionary: { term: string }[] }).dictionary.map(
      (e) => e.term
    );
    expect(terms).toEqual(["Daintree", "Go"]);
  });

  it("appends to an existing entry list without duplicating its terms", () => {
    const existing = { term: "Zustand", heardAs: ["zoo stand"], source: "learned", addedAt: 5 };
    const { data } = run({
      voiceInput: { dictionary: [existing], customDictionary: ["zustand", "Daintree"] },
    });

    expect((data.voiceInput as { dictionary: unknown[] }).dictionary).toEqual([
      existing,
      { term: "Daintree", heardAs: [], source: "manual", addedAt: NOW },
    ]);
  });

  it("turns an empty or malformed list into an empty dictionary", () => {
    for (const customDictionary of [[], "Daintree", { 0: "Daintree" }, null]) {
      const { data } = run({ voiceInput: { enabled: false, customDictionary } });
      expect(data.voiceInput).toEqual({ enabled: false, dictionary: [] });
    }
  });

  it("is idempotent", () => {
    const initial = { voiceInput: { customDictionary: ["Daintree", "Zustand"] } };
    expect(run(initial, 2).data).toEqual(run(initial, 1).data);
  });

  it("leaves a store without voice settings, or already migrated, untouched", () => {
    const none = run({ sessionRestore: { enabled: true } });
    expect(none.data).toEqual({ sessionRestore: { enabled: true } });
    expect(none.store.set).not.toHaveBeenCalled();

    const current = run({ voiceInput: { dictionary: [], enabled: true } });
    expect(current.store.set).not.toHaveBeenCalled();
  });
});
