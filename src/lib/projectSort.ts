/**
 * Sort order for the project switcher's "Other projects" band, and for the
 * welcome screen's recent-projects list — the two surfaces that render the same
 * frecency-ranked residual set and carry a standing promise never to disagree
 * on order (#11455).
 *
 * Scoped to that band alone. Needs attention (severity, then oldest first),
 * Pinned (alphabetical), and Running (most work first) each encode a decision
 * this preference must not override.
 */
export const OTHER_PROJECTS_SORT_MODES = ["hottest", "recent", "alphabetical"] as const;

export type OtherProjectsSortMode = (typeof OTHER_PROJECTS_SORT_MODES)[number];

export const DEFAULT_OTHER_PROJECTS_SORT_MODE: OtherProjectsSortMode = "hottest";

export function isOtherProjectsSortMode(value: unknown): value is OtherProjectsSortMode {
  return (
    typeof value === "string" && (OTHER_PROJECTS_SORT_MODES as readonly string[]).includes(value)
  );
}

/**
 * The fields any sortable project must expose. Callers normalise into this
 * shape so the comparator can't be handed a raw persisted score by mistake:
 * `frecencyScore` here is the READ-TIME DECAYED value, never the stored one.
 * Comparing stored scores compares snapshots frozen on different dates, which
 * is how a months-dormant project once held a top slot.
 */
export interface SortableProject {
  id: string;
  name: string;
  lastOpened: number;
  frecencyScore: number;
}

/**
 * Order within the Other band for `mode`.
 *
 * Every mode ends on `id` so the order is a total one: two projects sharing a
 * name (or a score and a timestamp) must not swap places between renders, or
 * rows move under the pointer for no reason the user can see.
 */
export function compareProjectsByMode(
  a: SortableProject,
  b: SortableProject,
  mode: OtherProjectsSortMode
): number {
  if (mode === "alphabetical") {
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  }

  // Hottest keeps frecency as the primary key; Recent drops it entirely and
  // ranks on the timestamp the rows already show. Both then fall through to
  // the same tie-breaks, so switching modes never changes how ties resolve.
  if (mode === "hottest" && a.frecencyScore !== b.frecencyScore) {
    return b.frecencyScore - a.frecencyScore;
  }
  if (a.lastOpened !== b.lastOpened) return b.lastOpened - a.lastOpened;
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}
