import type { Scratch } from "@shared/types/scratch";

/**
 * What an empty canvas should offer, given the active workspace (#11076).
 *
 * `project` defers to the grid's own context-driven empty state; `scratch`
 * needs the launcher built from scratch-derived props (it has no worktree, so
 * the grid context can't supply them); `welcome` is the only true
 * no-workspace case.
 */
export type EmptyCanvas =
  | { kind: "project" }
  | { kind: "scratch"; scratch: Scratch }
  | { kind: "welcome" };

/**
 * The two workspace pointers are mutually exclusive — switching to a scratch
 * clears the project and vice versa. Project-first only guards the transient
 * state where both are briefly set.
 */
export function resolveEmptyCanvas(
  currentProject: { id: string } | null,
  currentScratch: Scratch | null
): EmptyCanvas {
  if (currentProject !== null) return { kind: "project" };
  if (currentScratch !== null) return { kind: "scratch", scratch: currentScratch };
  return { kind: "welcome" };
}
