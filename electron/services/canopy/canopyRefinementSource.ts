import type { RunCanopyRefinement } from "../../../shared/types/ipc/fleet.js";

/**
 * Where the fleet and the project counts read Canopy's refinements from,
 * without importing Canopy: the service is made lazily behind its IPC handler,
 * and a leaf module is what lets the two services that decorate and count runs
 * stay ignorant of whether it exists. No source means no refinements, which is
 * exactly the free rules.
 */
type RefinementSource = (runId: string, spawnedAt: number) => RunCanopyRefinement | undefined;

let source: RefinementSource | null = null;
const listeners = new Set<() => void>();

/** The refinement placing a run, if Canopy has one for this incarnation. */
export function canopyRefinementFor(
  runId: string,
  spawnedAt: number
): RunCanopyRefinement | undefined {
  return source?.(runId, spawnedAt);
}

/** Installs (or with null, removes) the source, and tells every listener. */
export function setCanopyRefinementSource(next: RefinementSource | null): void {
  if (source === next) return;
  source = next;
  notifyCanopyRefinementsChanged();
}

/** What the source answers has changed for at least one run. */
export function notifyCanopyRefinementsChanged(): void {
  for (const listener of [...listeners]) listener();
}

/** Be told each time the refinements change. Returns the unsubscribe. */
export function onCanopyRefinementsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
