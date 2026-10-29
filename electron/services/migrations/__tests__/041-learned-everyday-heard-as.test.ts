import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migration041 } from "../041-learned-everyday-heard-as.js";
import type { VoiceDictionaryEntry } from "../../../../shared/types/ipc/api.js";
import { dictionaryTerms } from "../../../../shared/utils/voiceDictionary.js";
import {
  collectHeardAsRules,
  createHeardAsRewriter,
} from "../../../../shared/utils/voiceHeardAs.js";

function run(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = structuredClone(initial);
  const store = {
    get: vi.fn((key: string) => structuredClone(data[key])),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration041.up>[0];
  migration041.up(store);
  return { data, store };
}

function entry(
  term: string,
  heardAs: string[],
  source: VoiceDictionaryEntry["source"] = "learned"
): VoiceDictionaryEntry {
  return { term, heardAs, source, addedAt: 1 };
}

describe("migration041 — learned entries stop rewriting an everyday word", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("takes the everyday form a learned entry was learned from off it, and nothing else", () => {
    const { data } = run({
      voiceInput: {
        enabled: true,
        dictionary: [
          entry("Jest", ["just", "jessed", "next"]),
          entry("useState", ["use state"]),
          entry("Zustand", ["zoo stand", "just"]),
          entry("Revue", ["review"], "manual"),
          entry("Nuxt", ["next"], "imported"),
        ],
      },
    });
    const voiceInput = data.voiceInput as { enabled: boolean; dictionary: VoiceDictionaryEntry[] };
    expect(voiceInput.enabled).toBe(true);
    expect(voiceInput.dictionary).toEqual([
      entry("Jest", ["jessed", "next"]),
      entry("useState", []),
      entry("Zustand", ["zoo stand", "just"]),
      entry("Revue", ["review"], "manual"),
      entry("Nuxt", ["next"], "imported"),
    ]);
  });

  it("leaves an entry stored that way teaching its term without rewriting the word", () => {
    const { data } = run({
      voiceInput: {
        dictionary: [entry("Jest", ["just"]), entry("Zustand", ["zoo stand"])],
      },
    });
    const { dictionary } = data.voiceInput as { dictionary: VoiceDictionaryEntry[] };
    const rewrite = createHeardAsRewriter(collectHeardAsRules(dictionary));
    expect(rewrite("I just want to check zoo stand")).toBe("I just want to check Zustand");
    expect(dictionaryTerms(dictionary)).toEqual(["Jest", "Zustand"]);
  });

  it("writes nothing when no learned entry starts with an everyday form", () => {
    const { store } = run({
      voiceInput: {
        dictionary: [entry("Zustand", ["zoo stand"]), entry("Jest", []), entry("Vite", ["veet"])],
      },
    });
    expect(store.set).not.toHaveBeenCalled();
  });

  it("skips a store without a dictionary and keeps malformed entries as they are", () => {
    expect(run({}).store.set).not.toHaveBeenCalled();
    expect(run({ voiceInput: { dictionary: "words" } }).store.set).not.toHaveBeenCalled();

    const odd = [null, "Jest", { term: "Jest", source: "learned", heardAs: "just" }];
    const { data } = run({ voiceInput: { dictionary: [...odd, entry("Jest", ["next"])] } });
    expect((data.voiceInput as { dictionary: unknown }).dictionary).toEqual([
      ...odd,
      entry("Jest", []),
    ]);
  });
});
