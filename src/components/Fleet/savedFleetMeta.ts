import type { FleetSavedScope, PredicateFleetSavedScope } from "@shared/types";

const STATE_LABEL: Record<PredicateFleetSavedScope["stateFilter"], string> = {
  all: "All panes",
  waiting: "Waiting",
  working: "Working",
  finished: "Finished",
};

const SCOPE_LABEL: Record<PredicateFleetSavedScope["scope"], string> = {
  current: "this worktree",
  all: "all worktrees",
};

/** What a live rule selects, in the same words the save dialog offers. */
export function describeRule(scope: PredicateFleetSavedScope): string {
  return `${STATE_LABEL[scope.stateFilter]} · ${SCOPE_LABEL[scope.scope]}`;
}

/** How many distinct panes a snapshot stored when it was saved. */
export function storedPaneCount(scope: FleetSavedScope): number {
  if (scope.kind !== "snapshot" || !Array.isArray(scope.terminalIds)) return 0;
  return new Set(scope.terminalIds).size;
}

/**
 * The count a row shows. A snapshot that lost panes says so ("2 of 4") —
 * otherwise an intact pair and a four-pane fleet that lost half its members
 * read identically, and recall arms fewer panes than the user remembers.
 */
export function formatSavedFleetCount(scope: FleetSavedScope, count: number): string {
  if (scope.kind !== "snapshot") return String(count);
  const stored = storedPaneCount(scope);
  return count < stored ? `${count} of ${stored}` : String(count);
}

function panes(n: number): string {
  return `${n} pane${n === 1 ? "" : "s"}`;
}

/** The row's accessible name: the fleet, what it selects, and what recall would arm. */
export function savedFleetAccessibleName(scope: FleetSavedScope, count: number): string {
  if (scope.kind !== "snapshot") {
    return `${scope.name}, ${describeRule(scope).replace(" · ", " in ")}, ${panes(count)}`;
  }
  const stored = storedPaneCount(scope);
  if (count === 0) return `${scope.name}, none of its saved panes are open`;
  if (count < stored) return `${scope.name}, ${count} of ${panes(stored)} open`;
  return `${scope.name}, ${panes(count)}`;
}
