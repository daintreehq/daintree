import type { FleetSavedScope } from "@shared/types";
import { computeFrecency } from "@/components/Terminal/RecipeRunner/recipeRunnerUtils";

export interface RankedFleetScopes {
  /** Snapshots with at least one eligible pane — frecency-ranked. */
  usable: FleetSavedScope[];
  /** Snapshots whose stored terminals no longer exist — sorted by lastUsedAt desc, kept visible for cleanup. */
  stale: FleetSavedScope[];
}

const comparator =
  (now: number) =>
  (a: FleetSavedScope, b: FleetSavedScope): number => {
    const scoreDiff =
      computeFrecency(b.usageHistory ?? [], now) - computeFrecency(a.usageHistory ?? [], now);
    if (scoreDiff !== 0) return scoreDiff;
    const lastUsedDiff = (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
    if (lastUsedDiff !== 0) return lastUsedDiff;
    const createdDiff = (b.createdAt ?? 0) - (a.createdAt ?? 0);
    if (createdDiff !== 0) return createdDiff;
    return a.name.localeCompare(b.name);
  };

/**
 * Rank saved fleet scopes by frecency for display. Stale snapshots
 * (those whose stored terminal IDs no longer resolve to eligible panes)
 * are split off into a separate list so the UI can render them in a
 * subdued sub-group — the user still needs to see them so they can be
 * deleted, but they shouldn't dominate the recall list.
 *
 * The `isStaleById` map is computed in the React layer because staleness
 * depends on `usePanelStore` and `useWorktreeSelectionStore` state; this
 * helper stays pure for testability.
 *
 * New scopes (empty `usageHistory`, no `lastUsedAt`) have frecency 0 and
 * sort to the bottom of `usable` — they appear, but don't leap to the
 * top until the user has recalled them at least once.
 */
export function rankSavedFleets(
  scopes: readonly FleetSavedScope[],
  now: number,
  isStaleById: ReadonlyMap<string, boolean>
): RankedFleetScopes {
  const usable: FleetSavedScope[] = [];
  const stale: FleetSavedScope[] = [];
  for (const scope of scopes) {
    if (isStaleById.get(scope.id) === true) {
      stale.push(scope);
    } else {
      usable.push(scope);
    }
  }
  const cmp = comparator(now);
  usable.sort(cmp);
  // Stale sub-group falls back to lastUsedAt desc (frecency is meaningless
  // for fleets with no eligible terminals; the user came to delete, not recall).
  stale.sort((a, b) => {
    const lastUsedDiff = (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
    if (lastUsedDiff !== 0) return lastUsedDiff;
    return a.name.localeCompare(b.name);
  });
  return { usable, stale };
}

/**
 * Predicate-group ranking: same frecency + tie-breaker chain, no stale
 * split (predicates re-evaluate against the current panel set on recall,
 * so there is no "no longer applies" concept).
 */
export function rankPredicateFleets(
  scopes: readonly FleetSavedScope[],
  now: number
): FleetSavedScope[] {
  return [...scopes].sort(comparator(now));
}
