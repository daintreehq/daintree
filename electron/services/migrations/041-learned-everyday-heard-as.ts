import type { Migration } from "../StoreMigrations.js";
import { isEverydayPhrase } from "../../../shared/utils/phoneticSimilarity.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Take the everyday word a correction taught off each learned dictionary
 * entry (#15071). Accepting "just" fixed to Jest stored "just" as a heard-as
 * form, which rewrote "just" in every dictation; accepting one now keeps such a
 * word out. A learned entry was created with the form it was learned from
 * first, so only that one goes: anything after it was added by hand. The term
 * stays, so it still reaches keyterms and cleanup.
 */
export const migration041: Migration = {
  version: 41,
  description: "Stop learned voice dictionary entries rewriting an everyday word (#15071)",
  up: (store) => {
    const settings = store.get("voiceInput");
    if (!isPlainObject(settings) || !Array.isArray(settings.dictionary)) {
      console.log("[Migration 041] No voice dictionary found, skipping");
      return;
    }

    let stripped = 0;
    const dictionary = settings.dictionary.map((entry: unknown) => {
      if (!isPlainObject(entry) || entry.source !== "learned" || !Array.isArray(entry.heardAs)) {
        return entry;
      }
      const [learnedFrom, ...rest] = entry.heardAs as unknown[];
      if (typeof learnedFrom !== "string" || !isEverydayPhrase(learnedFrom)) return entry;
      stripped++;
      return { ...entry, heardAs: rest };
    });

    if (stripped === 0) {
      console.log("[Migration 041] No learned entry rewrites an everyday word, skipping");
      return;
    }
    console.log(`[Migration 041] Took an everyday heard-as form off ${stripped} learned entries`);
    store.set("voiceInput", { ...settings, dictionary });
  },
};
