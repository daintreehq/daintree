import { MAX_DICTIONARY_TERM_LENGTH } from "@shared/utils/voiceDictionary";

export interface ParsedDictionaryTerm {
  term: string;
  heardAs: string[];
}

export interface ParsedDictionaryInput {
  terms: ParsedDictionaryTerm[];
  /** Items dropped for being longer than a keyterm can be. */
  skipped: number;
}

const ARROW = /\s*(?:->|=>|→)\s*/;

/**
 * Read pasted dictionary input: one item per line or comma-separated terms,
 * and `heard -> Term` pairs for a mishearing. Repeats of a term (any casing)
 * fold into one with all their heard-as forms.
 */
export function parseDictionaryInput(text: string): ParsedDictionaryInput {
  const byTerm = new Map<string, ParsedDictionaryTerm>();
  let skipped = 0;

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
      entry = { term, heardAs: [] };
      byTerm.set(key, entry);
    }
    if (heard && !entry.heardAs.some((h) => h.toLowerCase() === heard.toLowerCase())) {
      entry.heardAs.push(heard);
    }
  };

  for (const line of text.split(/\r?\n/)) {
    for (const item of line.split(",")) {
      const pair = item.split(ARROW);
      if (pair.length === 2) take(pair[1]!, pair[0]);
      else take(item);
    }
  }

  return { terms: [...byTerm.values()], skipped };
}

/** Heard-as forms typed into one field, one per line: a phrase may itself hold a comma. */
export function parseHeardAsField(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}
