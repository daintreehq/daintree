import type { PRMergeIntent, PRMergeMethod } from "../types/forge.js";

export function mergeIntentEqual(
  a: PRMergeIntent | null | undefined,
  b: PRMergeIntent | null | undefined
): boolean {
  if (a == null || b == null) return a === b;
  if (a.kind === "queued") return b.kind === "queued" && a.position === b.position;
  if (b.kind === "queued") return false;
  return a.method === b.method && a.enabledAt === b.enabledAt && a.enabledBy === b.enabledBy;
}

export const HEAD_MOVED_WHILE_ARMED_TEXT =
  "New commits landed after auto-merge was armed — GitHub may merge them without another review";

const METHOD_LABEL: Record<PRMergeMethod, string> = {
  merge: "merge commit",
  squash: "squash",
  rebase: "rebase",
};

export function mergeMethodLabel(method: PRMergeMethod): string {
  return METHOD_LABEL[method];
}

/**
 * Short chip label for a pending merge: "auto-merge · squash", "queued #3".
 * Only what the forge reported — no method when a merge queue picks it, no
 * position when the read didn't carry one.
 */
export function mergeIntentLabel(intent: PRMergeIntent): string {
  if (intent.kind === "queued") {
    return intent.position !== null ? `queued #${intent.position}` : "queued";
  }
  return intent.method ? `auto-merge · ${METHOD_LABEL[intent.method]}` : "auto-merge";
}

/** Sentence for tooltips and accessible names, attributing who armed it. */
export function describeMergeIntent(intent: PRMergeIntent): string {
  if (intent.kind === "queued") {
    return intent.position !== null
      ? `In the merge queue at position ${intent.position}`
      : "In the merge queue";
  }
  const how = intent.method ? ` (${METHOD_LABEL[intent.method]})` : "";
  const who = intent.enabledBy ? ` by ${intent.enabledBy}` : "";
  return `Auto-merge armed${who}${how} — GitHub merges it once requirements pass`;
}
