import {
  CANOPY_SEARCH_MAX_ALTERNATIVES,
  CANOPY_SEARCH_MAX_TERM_LENGTH,
  CANOPY_SEARCH_MAX_TERMS,
  type CanopyScreenSearchTarget,
} from "@shared/types/ipc/canopy";
import { pluralize } from "@/lib/pluralize";
import { itemSearchText, type CanopyItem } from "./canopyModel";

/**
 * A search's alternatives: a run matches when it holds every word of any one
 * of them, ignoring case. A comma or line break separates alternatives, so a
 * pasted list finds each item on it; whitespace separates the words of one.
 */
export type CanopySearchAlternatives = readonly (readonly string[])[];

/** The most runs one search asks of the terminals: main's own cap. */
const SCREEN_SEARCH_MAX_RUNS = 500;
/**
 * The most one search's ask may weigh, in characters as JSON: a host's link
 * carries a message of at most 16 MiB, and no character takes more than three
 * bytes on it, so an ask this size reaches another host whole.
 */
const SCREEN_SEARCH_MAX_ASK_CHARS = 2 * 1024 * 1024;

/**
 * The alternatives of a query, lowercased, each word once and each alternative
 * once, as many as a search offers: `dropped` counts those past that, left out
 * of the search for the panel to name.
 */
export function parseCanopySearch(query: string): {
  alternatives: string[][];
  dropped: number;
} {
  const alternatives: string[][] = [];
  const seen = new Set<string>();
  for (const part of query.toLowerCase().split(/[,\r\n]+/)) {
    const words = [...new Set(part.split(/\s+/).filter((word) => word !== ""))];
    if (words.length === 0) continue;
    const key = [...words].sort().join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push(words);
  }
  const kept = alternatives.slice(0, CANOPY_SEARCH_MAX_ALTERNATIVES);
  return { alternatives: kept, dropped: alternatives.length - kept.length };
}

/** Whether lowercased text holds every word of any one alternative. */
export function textMatchesSearch(text: string, alternatives: CanopySearchAlternatives): boolean {
  return (
    alternatives.length === 0 ||
    alternatives.some((words) => words.every((word) => text.includes(word)))
  );
}

/**
 * Pasted text with its line breaks turned into the commas that separate a
 * search's alternatives, since a single-line field would otherwise glue the
 * lines of a pasted list into one word. Null when it has none to turn. A
 * break at either end still separates the list from the text it lands beside
 * (`before` and `after` the selection), and is dropped where there is none.
 */
export function searchPasteText(text: string, before = "", after = ""): string | null {
  if (!/[\r\n]/.test(text)) return null;
  let list = text.replace(/\s*[\r\n]\s*/g, ", ");
  if (!/[^\s,]\s*$/.test(before)) list = list.replace(/^, /, "");
  if (!/^\s*[^\s,]/.test(after)) list = list.replace(/, $/, "");
  return list;
}

/**
 * The words of each alternative of a search that a run's names and words
 * don't hold: what is left for its terminal to answer, each set once. Null
 * when they hold every word of one alternative, so nothing is left to ask.
 * Words are matched as written, never by scattered letters, which across a
 * paragraph would find a little of anything.
 */
export function unmatchedAlternatives(
  item: CanopyItem,
  alternatives: CanopySearchAlternatives
): string[][] | null {
  if (alternatives.length === 0) return null;
  const text = itemSearchText(item);
  const left = new Map<string, string[]>();
  for (const words of alternatives) {
    const missing = words.filter((word) => !text.includes(word));
    if (missing.length === 0) return null;
    const key = [...missing].sort().join(" ");
    if (!left.has(key)) left.set(key, missing);
  }
  return [...left.values()];
}

/**
 * What a search asks of the terminals, and what it leaves unasked: an
 * alternative with more words left than main takes, or a word longer, is not
 * asked of that run rather than the whole ask refused, and runs past the
 * ask's bounds are not asked at all.
 */
export interface CanopyScreenSearchPlan {
  targets: CanopyScreenSearchTarget[];
  overWords: boolean;
  overLength: boolean;
  overRuns: boolean;
}

export function canopyScreenSearchPlan(
  items: readonly CanopyItem[],
  alternatives: CanopySearchAlternatives
): CanopyScreenSearchPlan {
  const plan: CanopyScreenSearchPlan = {
    targets: [],
    overWords: false,
    overLength: false,
    overRuns: false,
  };
  if (alternatives.length === 0) return plan;
  let chars = 0;
  for (const item of items) {
    const left = unmatchedAlternatives(item, alternatives);
    if (left === null) continue;
    const asked: string[][] = [];
    for (const words of left) {
      const tooMany = words.length > CANOPY_SEARCH_MAX_TERMS;
      const tooLong = words.some((word) => word.length > CANOPY_SEARCH_MAX_TERM_LENGTH);
      if (tooMany) plan.overWords = true;
      if (tooLong) plan.overLength = true;
      if (!tooMany && !tooLong) asked.push(words);
    }
    const [terms, ...orTerms] = asked;
    if (terms === undefined) continue;
    // One alternative is the very ask a host from before alternatives knows,
    // and such a host answers for `terms` alone.
    const target: CanopyScreenSearchTarget = {
      runId: item.runId,
      spawnedAt: item.row.run.spawnedAt,
      terms,
      ...(orTerms.length > 0 ? { orTerms } : {}),
    };
    const weight = JSON.stringify(target).length;
    if (
      plan.targets.length === SCREEN_SEARCH_MAX_RUNS ||
      chars + weight > SCREEN_SEARCH_MAX_ASK_CHARS
    ) {
      plan.overRuns = true;
      break;
    }
    chars += weight;
    plan.targets.push(target);
  }
  return plan;
}

/**
 * What the search leaves out, said under the field: alternatives past those
 * a search offers, and terminals not asked for all of it.
 */
export function canopySearchNotes(
  alternatives: CanopySearchAlternatives,
  dropped: number,
  plan: Pick<CanopyScreenSearchPlan, "overWords" | "overLength" | "overRuns">
): string[] {
  const notes: string[] = [];
  if (dropped > 0) {
    notes.push(
      `Only the first ${alternatives.length} of ${pluralize(alternatives.length + dropped, "alternative")} are searched`
    );
  }
  if (plan.overWords) {
    notes.push(
      `Terminals aren't searched for more than ${pluralize(CANOPY_SEARCH_MAX_TERMS, "word")} of one alternative`
    );
  }
  if (plan.overLength) {
    notes.push(
      `Terminals aren't searched for words over ${pluralize(CANOPY_SEARCH_MAX_TERM_LENGTH, "character")}`
    );
  }
  if (plan.overRuns) notes.push("Some terminals aren't searched: narrow the search to reach them");
  return notes;
}
