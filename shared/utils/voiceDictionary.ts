import type {
  SuggestedDictionaryEntry,
  VoiceDictionaryEntry,
  VoiceDictionarySource,
  VoiceDictionaryState,
} from "../types/ipc/api.js";
import type { CorrectionCandidate } from "./phoneticSimilarity.js";

/** Deepgram rejects any keyterm over 100 characters, so a term or heard-as phrase can't be longer. */
export const MAX_DICTIONARY_TERM_LENGTH = 100;

/** Cap on the pending-suggestions queue; accepted words live in the dictionary. */
export const MAX_SUGGESTED_WORDS = 50;

const SOURCES: ReadonlySet<string> = new Set<VoiceDictionarySource>([
  "manual",
  "learned",
  "imported",
]);

const fold = (phrase: string) => phrase.toLowerCase();

function normalizePhrase(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return raw.trim() || null;
}

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function requirePhrase(raw: unknown, what: string): string {
  const phrase = normalizePhrase(raw);
  if (!phrase) throw new Error(`A dictionary ${what} can't be empty`);
  if (phrase.length > MAX_DICTIONARY_TERM_LENGTH) {
    throw new Error(
      `A dictionary ${what} can't be longer than ${MAX_DICTIONARY_TERM_LENGTH} characters`
    );
  }
  return phrase;
}

function appendHeardAs(existing: readonly string[], incoming: readonly string[]): string[] {
  const out = [...existing];
  const seen = new Set(existing.map(fold));
  for (const phrase of incoming) {
    if (seen.has(fold(phrase))) continue;
    seen.add(fold(phrase));
    out.push(phrase);
  }
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** The written terms, oldest first: the plain list keyterm assembly and the correction prompt take. */
export function dictionaryTerms(entries: readonly VoiceDictionaryEntry[]): string[] {
  return entries.map((entry) => entry.term);
}

/**
 * Repair whatever the store holds into valid entries. Accepts bare strings (the
 * old word list) as hand-added terms stamped `now`, drops anything without a
 * usable term, and folds a repeat that differs only in case into the first.
 * Lengths aren't capped here: a stored term is kept as written, and keyterm
 * assembly caps what it sends.
 */
export function sanitizeDictionary(raw: unknown, now: number): VoiceDictionaryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: VoiceDictionaryEntry[] = [];
  const indexByTerm = new Map<string, number>();
  for (const item of raw) {
    const record =
      typeof item === "string" ? { term: item } : item && typeof item === "object" ? item : null;
    if (!record) continue;
    const {
      term: rawTerm,
      heardAs: rawHeardAs,
      source,
      addedAt,
    } = record as Record<string, unknown>;
    const term = normalizePhrase(rawTerm);
    if (!term) continue;
    const heardAs = Array.isArray(rawHeardAs)
      ? appendHeardAs(
          [],
          rawHeardAs.map(normalizePhrase).filter((p): p is string => p !== null)
        )
      : [];
    const existing = indexByTerm.get(fold(term));
    if (existing !== undefined) {
      out[existing] = {
        ...out[existing]!,
        heardAs: appendHeardAs(out[existing]!.heardAs, heardAs),
      };
      continue;
    }
    indexByTerm.set(fold(term), out.length);
    out.push({
      term,
      heardAs,
      source:
        typeof source === "string" && SOURCES.has(source)
          ? (source as VoiceDictionarySource)
          : "manual",
      addedAt: isTime(addedAt) ? addedAt : now,
    });
  }
  return out;
}

/**
 * Repair the suggestion queue the store holds: drop entries whose word is
 * missing or too long to ever be accepted, and anything after the first of a
 * word ignoring case; default the bookkeeping fields.
 */
export function sanitizeSuggestions(raw: unknown): SuggestedDictionaryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SuggestedDictionaryEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { word: rawWord, utterance, suggestedAt, frequency } = item as Record<string, unknown>;
    const word = normalizePhrase(rawWord);
    if (!word || word.length > MAX_DICTIONARY_TERM_LENGTH || seen.has(fold(word))) continue;
    seen.add(fold(word));
    out.push({
      word,
      utterance: typeof utterance === "string" ? utterance : "",
      suggestedAt: isTime(suggestedAt) ? suggestedAt : 0,
      frequency:
        typeof frequency === "number" && Number.isInteger(frequency) && frequency >= 1
          ? frequency
          : 1,
    });
  }
  return out.slice(0, MAX_SUGGESTED_WORDS);
}

export interface AddDictionaryEntryInput {
  term: string;
  heardAs?: readonly string[];
  source?: VoiceDictionarySource;
}

/**
 * Add a term, or, when it is already there under any casing, add only the
 * heard-as forms it doesn't have yet. The stored casing, source and time stay.
 * Returns the same array when nothing changed.
 */
export function addDictionaryEntry(
  entries: VoiceDictionaryEntry[],
  input: AddDictionaryEntryInput,
  now: number
): VoiceDictionaryEntry[] {
  const term = requirePhrase(input.term, "term");
  const heardAs = (input.heardAs ?? []).map((phrase) => requirePhrase(phrase, "heard-as phrase"));
  const index = entries.findIndex((entry) => fold(entry.term) === fold(term));
  if (index < 0) {
    return [
      ...entries,
      { term, heardAs: appendHeardAs([], heardAs), source: input.source ?? "manual", addedAt: now },
    ];
  }
  const existing = entries[index]!;
  const merged = appendHeardAs(existing.heardAs, heardAs);
  if (merged.length === existing.heardAs.length) return entries;
  return entries.map((entry, i) => (i === index ? { ...existing, heardAs: merged } : entry));
}

/** Remove a term matched ignoring case. Returns the same array when it isn't there. */
export function removeDictionaryEntry(
  entries: VoiceDictionaryEntry[],
  term: string
): VoiceDictionaryEntry[] {
  const key = fold(normalizePhrase(term) ?? "");
  const next = entries.filter((entry) => fold(entry.term) !== key);
  return next.length === entries.length ? entries : next;
}

export interface DictionaryEntryChanges {
  /** A new written form. A change of case alone is allowed; another entry's term isn't. */
  term?: string;
  /** Replaces the heard-as forms. */
  heardAs?: readonly string[];
}

/**
 * Change one entry, found by its term ignoring case. An entry that has gone
 * since the caller last saw it is left gone. Source and time never change.
 * Returns the same array when nothing changed.
 */
export function updateDictionaryEntry(
  entries: VoiceDictionaryEntry[],
  term: string,
  changes: DictionaryEntryChanges
): VoiceDictionaryEntry[] {
  const key = fold(normalizePhrase(term) ?? "");
  const index = entries.findIndex((entry) => fold(entry.term) === key);
  if (index < 0) return entries;
  const existing = entries[index]!;
  const nextTerm = changes.term === undefined ? existing.term : requirePhrase(changes.term, "term");
  if (entries.some((entry, i) => i !== index && fold(entry.term) === fold(nextTerm))) {
    // No term in the message: a thrown IPC error is logged in full, and terms are user content.
    throw new Error("That term is already in the dictionary");
  }
  const nextHeardAs =
    changes.heardAs === undefined
      ? existing.heardAs
      : appendHeardAs(
          [],
          changes.heardAs.map((phrase) => requirePhrase(phrase, "heard-as phrase"))
        );
  if (nextTerm === existing.term && sameList(nextHeardAs, existing.heardAs)) return entries;
  return entries.map((entry, i) =>
    i === index ? { ...existing, term: nextTerm, heardAs: nextHeardAs } : entry
  );
}

/**
 * Merge freshly-detected correction candidates into the suggestion queue: skip
 * words already in the dictionary and words that couldn't be added to it, bump
 * frequency on a repeat, newest first, capped. Returns null when nothing changed.
 */
export function mergeSuggestions(
  candidates: readonly CorrectionCandidate[],
  entries: VoiceDictionaryEntry[],
  suggested: readonly SuggestedDictionaryEntry[],
  now: number
): SuggestedDictionaryEntry[] | null {
  const confirmed = new Set(entries.map((entry) => fold(entry.term)));
  const next = [...suggested];
  let changed = false;

  for (const candidate of candidates) {
    const word = normalizePhrase(candidate.word);
    if (!word || word.length > MAX_DICTIONARY_TERM_LENGTH) continue;
    const original = candidate.original.trim();
    const lower = fold(word);
    if (confirmed.has(lower)) continue;
    const idx = next.findIndex((e) => fold(e.word) === lower);
    if (idx >= 0) {
      const entry = next[idx]!;
      next[idx] = {
        ...entry,
        frequency: entry.frequency + 1,
        suggestedAt: now,
        utterance: original,
      };
    } else {
      next.unshift({ word, utterance: original, suggestedAt: now, frequency: 1 });
    }
    changed = true;
  }

  return changed ? next.slice(0, MAX_SUGGESTED_WORDS) : null;
}

/**
 * Move a suggestion into the dictionary as a learned entry that keeps what it
 * was heard as. A word no longer queued was dismissed or accepted from
 * somewhere else, so acting on it now is acting on a stale copy: nothing
 * changes, and a term removed since stays removed.
 */
export function acceptSuggestion(
  state: VoiceDictionaryState,
  word: string,
  now: number
): VoiceDictionaryState {
  const key = fold(normalizePhrase(word) ?? "");
  const suggestion = state.suggestedDictionary.find((entry) => fold(entry.word) === key);
  if (!suggestion) return state;
  const heard = normalizePhrase(suggestion.utterance);
  return {
    dictionary: addDictionaryEntry(
      state.dictionary,
      {
        term: suggestion.word,
        heardAs: heard && heard.length <= MAX_DICTIONARY_TERM_LENGTH ? [heard] : [],
        source: "learned",
      },
      now
    ),
    suggestedDictionary: state.suggestedDictionary.filter((entry) => entry !== suggestion),
  };
}

/** Drop a suggestion matched ignoring case. Returns the same array when it isn't queued. */
export function dismissSuggestion(
  suggested: SuggestedDictionaryEntry[],
  word: string
): SuggestedDictionaryEntry[] {
  const key = fold(normalizePhrase(word) ?? "");
  const next = suggested.filter((entry) => fold(entry.word) !== key);
  return next.length === suggested.length ? suggested : next;
}
