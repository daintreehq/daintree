import type { Project } from "@shared/types";

/**
 * Return projects sorted by MRU order (most-recently-opened first), stable by name.
 * Matches the sort used by the project switcher palette.
 */
export function getMruProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort((a, b) => {
    const aLast = a.lastOpened ?? 0;
    const bLast = b.lastOpened ?? 0;
    if (aLast !== bLast) return bLast - aLast;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Advance the highlighted MRU index during a hold-scrub session.
 *
 * Index 0 is the current project and must never be selected. Valid indices are
 * 1..length-1 and the cycle wraps from the last back to 1 (older) or from 1
 * back to the last (newer).
 */
export function advanceMruIndex(
  currentIndex: number,
  direction: "older" | "newer",
  length: number
): number {
  if (length < 2) return currentIndex;
  const lastIndex = length - 1;
  if (direction === "older") {
    if (currentIndex >= lastIndex) return 1;
    const next = currentIndex + 1;
    return next < 1 ? 1 : next;
  }
  if (currentIndex <= 1) return lastIndex;
  return currentIndex - 1;
}
