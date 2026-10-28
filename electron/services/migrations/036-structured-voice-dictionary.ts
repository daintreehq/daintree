import type { Migration } from "../StoreMigrations.js";

/**
 * Turn the flat voice dictionary word list into structured entries (issue
 * #14598). Every word comes across as written, trimmed, in its original order,
 * as a hand-added term with no heard-as forms, stamped with the migration time
 * since the list never recorded when a word was added. A repeat that differs
 * only in case keeps the first spelling, the one keyterm assembly was already
 * sending. The old key is deleted so it can't come back alongside the new one.
 *
 * Self-contained on purpose: a migration is a snapshot, so it doesn't share
 * the live dictionary helpers, which may change after this ships.
 */
export const migration036: Migration = {
  version: 36,
  description: "Store voice dictionary words as structured entries (issue #14598)",
  up: (store) => {
    const voiceInput = store.get("voiceInput") as Record<string, unknown> | undefined;
    if (!voiceInput || typeof voiceInput !== "object") {
      console.log("[Migration 036] No voiceInput settings found, skipping");
      return;
    }
    if (!("customDictionary" in voiceInput)) {
      console.log("[Migration 036] No legacy voice dictionary, skipping");
      return;
    }

    const { customDictionary, ...rest } = voiceInput;
    const dictionary: unknown[] = Array.isArray(rest.dictionary) ? [...rest.dictionary] : [];
    const seen = new Set<string>();
    for (const entry of dictionary) {
      const term = (entry as { term?: unknown } | null)?.term;
      if (typeof term === "string") seen.add(term.trim().toLowerCase());
    }

    const addedAt = Date.now();
    let migrated = 0;
    for (const word of Array.isArray(customDictionary) ? customDictionary : []) {
      if (typeof word !== "string") continue;
      const term = word.trim();
      if (!term || seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());
      dictionary.push({ term, heardAs: [], source: "manual", addedAt });
      migrated++;
    }

    console.log(`[Migration 036] Moved ${migrated} voice dictionary terms into entries`);
    store.set("voiceInput", { ...rest, dictionary });
  },
};
