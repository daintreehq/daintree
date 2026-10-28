import { scanProtectedSpans, type ProtectedSpan } from "../../shared/utils/voiceProtectedSpans.js";

/**
 * The one check a spoken rewrite of selected text has to pass before it
 * replaces the selection: its code, references, URLs and flags come back
 * exactly and in order, and none are invented. Paths may gain company, since
 * a rewrite that names another file is still the one asked for, but every one
 * the selection had stays, in order. Everything else is the rewrite's to change.
 */
export type RewriteGuardResult = { ok: true } | { ok: false; reason: "protected_span" };

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let found = 0;
  for (const value of haystack) {
    if (found < needle.length && value === needle[found]) found++;
  }
  return found === needle.length;
}

export function validateRewrite(selection: string, rewritten: string): RewriteGuardResult {
  const texts = (spans: ProtectedSpan[], paths: boolean) =>
    spans.filter((span) => (span.kind === "path") === paths).map((span) => span.text);
  const before = scanProtectedSpans(selection);
  const after = scanProtectedSpans(rewritten);
  return isSubsequence(texts(before, true), texts(after, true)) &&
    sameSequence(texts(before, false), texts(after, false))
    ? { ok: true }
    : { ok: false, reason: "protected_span" };
}
