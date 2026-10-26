import { MAX_DICTIONARY_HEARD_AS, MAX_DICTIONARY_TERM_LENGTH } from "@shared/utils/voiceDictionary";

/** Terms one paste adds. Each is its own write to main, so a huge paste is trimmed, not queued. */
export const MAX_DICTIONARY_IMPORT_TERMS = 500;

export interface ParsedDictionaryTerm {
  term: string;
  heardAs: string[];
}

export interface ParsedDictionaryInput {
  terms: ParsedDictionaryTerm[];
  /** Items dropped for being longer than a keyterm can be. */
  skipped: number;
  /** Distinct terms left out once the paste reached MAX_DICTIONARY_IMPORT_TERMS. */
  overflowTerms: number;
  /** Heard-as phrases left out once their term held MAX_DICTIONARY_HEARD_AS. */
  overflowHeardAs: number;
}

// The arrow needs a space (or the item's edge) either side, so a term like "ptr->next" stays a term.
const ARROW = /\s*(?<!\S)(?:->|=>|→)(?!\S)\s*/;

/**
 * Read pasted dictionary input: one item per line or comma-separated terms,
 * and `heard -> Term` pairs for a mishearing. Repeats of a term (any casing)
 * fold into one with all their heard-as forms.
 */
export function parseDictionaryInput(text: string): ParsedDictionaryInput {
  const byTerm = new Map<string, ParsedDictionaryTerm>();
  const overflow = new Set<string>();
  let skipped = 0;
  let overflowHeardAs = 0;

  const take = (rawTerm: string, rawHeard?: string) => {
    const term = rawTerm.trim();
    const heard = rawHeard?.trim();
    if (!term) return;
    if (
      term.length > MAX_DICTIONARY_TERM_LENGTH ||
      (heard && heard.length > MAX_DICTIONARY_TERM_LENGTH)
    ) {
      skipped++;
      return;
    }
    const key = term.toLowerCase();
    let entry = byTerm.get(key);
    if (!entry) {
      if (byTerm.size >= MAX_DICTIONARY_IMPORT_TERMS) {
        overflow.add(key);
        return;
      }
      entry = { term, heardAs: [] };
      byTerm.set(key, entry);
    }
    if (!heard || entry.heardAs.some((h) => h.toLowerCase() === heard.toLowerCase())) return;
    if (entry.heardAs.length >= MAX_DICTIONARY_HEARD_AS) {
      overflowHeardAs++;
      return;
    }
    entry.heardAs.push(heard);
  };

  for (const line of text.split(/\r?\n/)) {
    for (const item of line.split(",")) {
      const pair = item.split(ARROW);
      if (pair.length === 2) take(pair[1]!, pair[0]);
      else take(item);
    }
  }

  return { terms: [...byTerm.values()], skipped, overflowTerms: overflow.size, overflowHeardAs };
}

/** Heard-as forms typed into one field, one per line: a phrase may itself hold a comma. */
export function parseHeardAsField(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}
