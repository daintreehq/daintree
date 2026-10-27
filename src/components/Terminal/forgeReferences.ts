import type { Issue, PR } from "@shared/types/forge";

export type ForgeReferenceKind = "issue" | "pr";

export type ForgeReferenceState = "open" | "draft" | "closed" | "merged";

/** One issue or pull request the `#` menu can offer, as `#number`. */
export interface ForgeReference {
  kind: ForgeReferenceKind;
  number: number;
  title: string;
  state: ForgeReferenceState;
  updatedAt: number;
}

function issueState(issue: Issue): ForgeReferenceState {
  return issue.state === "open" ? "open" : "closed";
}

function prState(pr: PR): ForgeReferenceState {
  if (pr.state === "merged" || pr.merged) return "merged";
  if (pr.state === "open") return pr.isDraft ? "draft" : "open";
  return "closed";
}

/**
 * Issues and pull requests as one list, most recently updated first. An issue
 * served by a tracker other than the code forge is left out: its number names
 * nothing in this repository, so `#N` would point at the wrong thing.
 */
export function toForgeReferences(
  issues: readonly Issue[],
  prs: readonly PR[]
): ForgeReference[] {
  const refs: ForgeReference[] = [];
  for (const issue of issues) {
    if (issue.providerId !== undefined) continue;
    refs.push({
      kind: "issue",
      number: issue.number,
      title: issue.title,
      state: issueState(issue),
      updatedAt: issue.updatedAt,
    });
  }
  for (const pr of prs) {
    refs.push({
      kind: "pr",
      number: pr.number,
      title: pr.title,
      state: prState(pr),
      updatedAt: pr.updatedAt,
    });
  }
  return refs.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** What a row inserts: the reference, and nothing it says. */
export function formatForgeReference(ref: Pick<ForgeReference, "number">): string {
  return `#${ref.number}`;
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
  const needle = query.toLocaleLowerCase();
  const matches: ForgeReference[] = [];
  for (const ref of refs) {
    if (titleWords(ref.title).some((word) => word.startsWith(needle))) {
      matches.push(ref);
      if (matches.length === limit) break;
    }
  }
  return matches;
}

function titleWords(title: string): string[] {
  return title.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u);
}
