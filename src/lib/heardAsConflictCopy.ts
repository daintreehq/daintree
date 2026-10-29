import type { HeardAsConflict } from "@shared/types";

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Which term each conflicting heard-as phrase belongs to, grouped by term:
 * "“zoo stand” already belongs to Zustand; “vee” to Vite". Past `limit`
 * phrases the rest are only counted.
 */
export function describeHeardAsConflicts(
  conflicts: readonly HeardAsConflict[],
  limit = Infinity
): string {
  const byOwner = new Map<string, string[]>();
  for (const { phrase, owner } of conflicts.slice(0, limit)) {
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), `“${phrase}”`]);
  }
  const groups = [...byOwner].map(([owner, phrases], i) =>
    i > 0
      ? `${joinAnd(phrases)} to ${owner}`
      : `${joinAnd(phrases)} already ${phrases.length === 1 ? "belongs" : "belong"} to ${owner}`
  );
  const rest = conflicts.length - Math.min(conflicts.length, limit);
  return groups.join("; ") + (rest > 0 ? `, and ${rest} more` : "");
}
