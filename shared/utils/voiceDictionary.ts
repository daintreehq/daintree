import type {
  DismissedSuggestion,
  HeardAsConflict,
  HeardAsConflictPolicy,
  SuggestedDictionaryEntry,
  VoiceDictionaryEntry,
  VoiceDictionarySource,
  VoiceDictionaryState,
} from "../types/ipc/api.js";
import { isEverydayPhrase, type CorrectionCandidate } from "./phoneticSimilarity.js";

/** Deepgram rejects any keyterm over 100 characters, so a term or heard-as phrase can't be longer. */
export const MAX_DICTIONARY_TERM_LENGTH = 100;

/** Line breaks and other control characters: a phrase holding one could step out of a prompt's term list. */
export const DICTIONARY_CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/** Heard-as phrases one add or edit can carry; main refuses a longer list. */
export const MAX_DICTIONARY_HEARD_AS = 200;

/** Cap on the pending-suggestions queue; accepted words live in the dictionary. */
export const MAX_SUGGESTED_WORDS = 50;

/** Cap on remembered dismissals, high enough that a dismissed pair staying dismissed holds in practice. */
export const MAX_DISMISSED_SUGGESTIONS = 5000;

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

/** A heard-as phrase as a rule tells it apart: any case, any run of spaces. */
export function heardAsKey(phrase: string): string {
  return phrase.trim().split(/\s+/).join(" ").toLowerCase();
}

/**
 * The term each heard-as phrase fires for, keyed by `heardAsKey`: the first
 * entry that lists it, as the dictation rules give phrases out.
 */
export function heardAsOwners(entries: readonly VoiceDictionaryEntry[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const { term, heardAs } of entries) {
    for (const phrase of heardAs) {
      const key = heardAsKey(phrase);
      if (!owners.has(key)) owners.set(key, term);
    }
  }
  return owners;
}

/**
 * The phrases in `heardAs` that fire for an entry other than the one `term`
 * names, one conflict per phrase. A phrase that entry already fires for is
 * no conflict, even where a later entry lists it too.
 */
export function findHeardAsConflicts(
  owners: ReadonlyMap<string, string>,
  term: string,
  heardAs: readonly string[]
): HeardAsConflict[] {
  const self = fold(term.trim());
  const seen = new Set<string>();
  const conflicts: HeardAsConflict[] = [];
  for (const raw of heardAs) {
    const key = heardAsKey(raw);
    const owner = owners.get(key);
    if (owner === undefined || fold(owner) === self || seen.has(key)) continue;
    seen.add(key);
    conflicts.push({ phrase: raw.trim(), owner });
  }
  return conflicts;
}

/** Takes the conflicting phrases, in any case or spacing, off every entry but the one `term` names. */
function releaseHeardAs(
  entries: VoiceDictionaryEntry[],
  term: string,
  conflicts: readonly HeardAsConflict[]
): VoiceDictionaryEntry[] {
  if (conflicts.length === 0) return entries;
  const keys = new Set(conflicts.map(({ phrase }) => heardAsKey(phrase)));
  return entries.map((entry) => {
    if (fold(entry.term) === fold(term)) return entry;
    const heardAs = entry.heardAs.filter((phrase) => !keys.has(heardAsKey(phrase)));
    return heardAs.length === entry.heardAs.length ? entry : { ...entry, heardAs };
  });
}

/** The written terms, oldest first: the plain list keyterm assembly and the correction prompt take. */
export function dictionaryTerms(entries: readonly VoiceDictionaryEntry[]): string[] {
  return entries.map((entry) => entry.term);
}

/**
 * The dictionary one dictation uses: the target project's entries first, then
 * the user's own. A term in both is the project's entry, heard-as forms and
 * all, so a rule the project dropped can't come back from the global list.
 */
export function sessionDictionary(
  global: readonly VoiceDictionaryEntry[],
  project: readonly VoiceDictionaryEntry[]
): VoiceDictionaryEntry[] {
  const projectTerms = new Set(project.map((entry) => fold(entry.term)));
  return [...project, ...global.filter((entry) => !projectTerms.has(fold(entry.term)))];
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

const isDismissed = (dismissed: readonly DismissedSuggestion[], word: string, utterance: string) =>
  dismissed.some((d) => fold(d.word) === fold(word) && fold(d.utterance) === fold(utterance));

/** Repair the dismissed-pair list the store holds: drop malformed or repeated pairs, keep the newest. */
export function sanitizeDismissedSuggestions(raw: unknown): DismissedSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: DismissedSuggestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const word = normalizePhrase((item as Record<string, unknown>).word);
    const utterance = normalizePhrase((item as Record<string, unknown>).utterance) ?? "";
    if (!word || word.length > MAX_DICTIONARY_TERM_LENGTH) continue;
    if (isDismissed(out, word, utterance)) continue;
    out.push({ word, utterance });
  }
  return out.slice(-MAX_DISMISSED_SUGGESTIONS);
}

export interface AddDictionaryEntryInput {
  term: string;
  heardAs?: readonly string[];
  source?: VoiceDictionarySource;
  /** Keeps the original time on a restored entry; defaults to now. */
  addedAt?: number;
  /** A heard-as phrase another entry has refuses the add unless this says otherwise. */
  heardAsConflict?: HeardAsConflictPolicy;
}

/**
 * Add a term, or, when it is already there under any casing, add only the
 * heard-as forms it doesn't have yet. The stored casing, source and time stay.
 * A phrase another entry has is never saved beside it as a rule that can't
 * fire: the add is refused, the phrase left out, or the phrase moved, by
 * `heardAsConflict`. Refused and left-out phrases are pushed onto
 * `conflicts`. Returns the same array when nothing changed.
 */
export function addDictionaryEntry(
  entries: VoiceDictionaryEntry[],
  input: AddDictionaryEntryInput,
  now: number,
  conflicts?: HeardAsConflict[]
): VoiceDictionaryEntry[] {
  const term = requirePhrase(input.term, "term");
  const requested = (input.heardAs ?? []).map((phrase) => requirePhrase(phrase, "heard-as phrase"));
  const policy = input.heardAsConflict ?? "reject";
  const claimed = findHeardAsConflicts(heardAsOwners(entries), term, requested);
  if (claimed.length > 0 && policy !== "move") {
    conflicts?.push(...claimed);
    if (policy === "reject") return entries;
  }
  const taken = new Set(claimed.map(({ phrase }) => heardAsKey(phrase)));
  const heardAs =
    policy === "move" ? requested : requested.filter((phrase) => !taken.has(heardAsKey(phrase)));
  const base = policy === "move" ? releaseHeardAs(entries, term, claimed) : entries;
  const index = base.findIndex((entry) => fold(entry.term) === fold(term));
  if (index < 0) {
    return [
      ...base,
      {
        term,
        heardAs: appendHeardAs([], heardAs),
        source: input.source ?? "manual",
        addedAt: isTime(input.addedAt) ? input.addedAt : now,
      },
    ];
  }
  const existing = base[index]!;
  const merged = appendHeardAs(existing.heardAs, heardAs);
  if (merged.length === existing.heardAs.length) return base;
  return base.map((entry, i) => (i === index ? { ...existing, heardAs: merged } : entry));
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
  /** A heard-as phrase another entry has refuses the edit unless it is moved here. */
  heardAsConflict?: Exclude<HeardAsConflictPolicy, "skip">;
}

/**
 * Change one entry, found by its term ignoring case. An entry that has gone
 * since the caller last saw it is left gone. Source and time never change.
 * New heard-as forms that fire for another entry refuse the edit, pushed onto
 * `conflicts`, unless `heardAsConflict` moves them here.
 * Returns the same array when nothing changed.
 */
export function updateDictionaryEntry(
  entries: VoiceDictionaryEntry[],
  term: string,
  changes: DictionaryEntryChanges,
  conflicts?: HeardAsConflict[]
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
  let base = entries;
  let nextHeardAs = existing.heardAs;
  if (changes.heardAs !== undefined) {
    const requested = changes.heardAs.map((phrase) => requirePhrase(phrase, "heard-as phrase"));
    const claimed = findHeardAsConflicts(heardAsOwners(entries), existing.term, requested);
    if (claimed.length > 0 && changes.heardAsConflict !== "move") {
      conflicts?.push(...claimed);
      return entries;
    }
    base = releaseHeardAs(entries, existing.term, claimed);
    nextHeardAs = appendHeardAs([], requested);
  }
  if (nextTerm === existing.term && sameList(nextHeardAs, existing.heardAs)) return base;
  return base.map((entry, i) =>
    i === index ? { ...existing, term: nextTerm, heardAs: nextHeardAs } : entry
  );
}

/**
 * Merge freshly-detected correction candidates into the suggestion queue: skip
 * words already in the dictionary, words that couldn't be added to it and
 * pairs the user dismissed, bump
 * frequency on a repeat, newest first, capped. Returns null when nothing changed.
 */
export function mergeSuggestions(
  candidates: readonly CorrectionCandidate[],
  entries: VoiceDictionaryEntry[],
  suggested: readonly SuggestedDictionaryEntry[],
  now: number,
  dismissed: readonly DismissedSuggestion[] = []
): SuggestedDictionaryEntry[] | null {
  const confirmed = new Set(entries.map((entry) => fold(entry.term)));
  const next = [...suggested];
  let changed = false;

  for (const candidate of candidates) {
    const word = normalizePhrase(candidate.word);
    if (!word || word.length > MAX_DICTIONARY_TERM_LENGTH) continue;
    const original = candidate.original.trim();
    const lower = fold(word);
    if (confirmed.has(lower) || isDismissed(dismissed, word, original)) continue;
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
 * was heard as, unless that is everyday English: a heard-as form rewrites
 * every dictation, and a fix to "just" was right where it was made, not
 * everywhere the word is said, so the entry teaches only its term. A word no
 * longer queued was dismissed or accepted from somewhere else, so acting on
 * it now is acting on a stale copy: nothing changes, and a term removed since
 * stays removed. A heard form another entry already fires for is left out and
 * pushed onto `conflicts`; the word is still learned.
 */
export function acceptSuggestion(
  state: VoiceDictionaryState,
  word: string,
  now: number,
  utterance?: string,
  conflicts?: HeardAsConflict[]
): VoiceDictionaryState {
  const key = fold(normalizePhrase(word) ?? "");
  const suggestion = state.suggestedDictionary.find((entry) => fold(entry.word) === key);
  if (!suggestion) return state;
  // The pair the user saw, when the queue's copy has since been overwritten.
  const heard = normalizePhrase(utterance ?? suggestion.utterance);
  const keepsHeard =
    heard !== null && heard.length <= MAX_DICTIONARY_TERM_LENGTH && !isEverydayPhrase(heard);
  return {
    dictionary: addDictionaryEntry(
      state.dictionary,
      {
        term: suggestion.word,
        heardAs: keepsHeard ? [heard] : [],
        source: "learned",
        heardAsConflict: "skip",
      },
      now,
      conflicts
    ),
    suggestedDictionary: state.suggestedDictionary.filter((entry) => entry !== suggestion),
  };
}

/**
 * Drop a suggestion matched ignoring case and remember its word and
 * utterance, so the same substitution isn't offered again. A word no longer
 * queued changes nothing. With the utterance the user saw, that pair is the one
 * remembered, and the queued entry is dropped only if it is that pair.
 */
export function dismissSuggestion(
  suggested: SuggestedDictionaryEntry[],
  dismissed: DismissedSuggestion[],
  word: string,
  seenUtterance?: string
): {
  suggestedDictionary: SuggestedDictionaryEntry[];
  dismissedSuggestions: DismissedSuggestion[];
} {
  const key = fold(normalizePhrase(word) ?? "");
  const entry = suggested.find((e) => fold(e.word) === key);
  if (!entry) return { suggestedDictionary: suggested, dismissedSuggestions: dismissed };
  const utterance = (seenUtterance ?? entry.utterance).trim();
  const sameAsQueued = utterance === entry.utterance.trim();
  return {
    suggestedDictionary: sameAsQueued ? suggested.filter((e) => e !== entry) : suggested,
    dismissedSuggestions: isDismissed(dismissed, entry.word, utterance)
      ? dismissed
      : [...dismissed, { word: entry.word, utterance }].slice(-MAX_DISMISSED_SUGGESTIONS),
  };
}
