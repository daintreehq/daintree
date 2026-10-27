import type { ForgeReferencePrefixes, Issue, PR } from "@shared/types/forge";

export type ForgeReferenceKind = "issue" | "pr";

/** One open issue or pull request the `#` menu can offer. */
export interface ForgeReference {
  kind: ForgeReferenceKind;
  number: number;
  /** What a row inserts, written the way the forge writes it (`#12`, `!12`). */
  reference: string;
  title: string;
  isDraft: boolean;
  updatedAt: number;
}

/**
 * Open issues and pull requests as one list, most recently updated first. A
 * kind the forge declares no prefix for is left out, and so is an issue served
 * by a tracker other than the code forge, whose number names nothing in this
 * repository. List filters are advisory, so anything closed is dropped here.
 */
export function toForgeReferences(
  issues: readonly Issue[],
  prs: readonly PR[],
  prefixes: ForgeReferencePrefixes
): ForgeReference[] {
  const refs: ForgeReference[] = [];
  if (prefixes.issue) {
    for (const issue of issues) {
      if (issue.state !== "open" || issue.providerId !== undefined || issue.key !== undefined) {
        continue;
      }
      refs.push({
        kind: "issue",
        number: issue.number,
        reference: `${prefixes.issue}${issue.number}`,
        title: issue.title,
        isDraft: false,
        updatedAt: issue.updatedAt,
      });
    }
  }
  if (prefixes.pr) {
    for (const pr of prs) {
      if (pr.state !== "open" || pr.merged) continue;
      refs.push({
        kind: "pr",
        number: pr.number,
        reference: `${prefixes.pr}${pr.number}`,
        title: pr.title,
        isDraft: pr.isDraft,
        updatedAt: pr.updatedAt,
      });
    }
  }
  return refs.sort((a, b) => b.updatedAt - a.updatedAt || b.number - a.number);
}

const DIGITS = /^\d+$/;

/**
 * The references a `#` query names. Digits narrow by number, with the exact
 * number first; anything else narrows by title, where a title word has to
 * start with it, so `#face` doesn't find "interface".
 */
export function filterForgeReferences(
  refs: readonly ForgeReference[],
  query: string,
  limit: number
): ForgeReference[] {
  if (query.length === 0) return refs.slice(0, limit);
  if (DIGITS.test(query)) {
    const exact: ForgeReference[] = [];
    const prefixed: ForgeReference[] = [];
    for (const ref of refs) {
      const digits = String(ref.number);
      if (digits === query) exact.push(ref);
      else if (digits.startsWith(query)) prefixed.push(ref);
    }
    return [...exact, ...prefixed].slice(0, limit);
  }
  const needle = query.normalize("NFC").toLocaleLowerCase();
  const matches: ForgeReference[] = [];
  for (const ref of refs) {
    if (titleWords(ref.title).some((word) => word.startsWith(needle))) {
      matches.push(ref);
      if (matches.length === limit) break;
    }
  }
  return matches;
}

// Marks stay in the word: a Devanagari vowel sign or a decomposed accent is
// part of the letter it follows, not a break.
function titleWords(title: string): string[] {
  return title
    .normalize("NFC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u);
}
