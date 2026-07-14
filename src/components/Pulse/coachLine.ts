import type { ProjectPulse } from "@shared/types";
import type { ForgeProjectHealthPayload } from "@shared/types/ipc/forge";

/**
 * Narrows health down to the payload the chips below the coach line are willing
 * to render, so the two can never disagree about whether forge data is usable —
 * a coach line claiming "12 changes merged" above an error hint would be a lie.
 *
 * Returns the payload rather than a `health is ForgeProjectHealthPayload`
 * predicate on purpose: an errored payload is still a payload, so a type
 * predicate's false branch would wrongly narrow callers to `null` and hide the
 * `hasRemote` they need to pick an error hint.
 */
export function getUsableHealth(
  health: ForgeProjectHealthPayload | null
): ForgeProjectHealthPayload | null {
  if (health === null || health.error || !health.repoUrl) return null;
  return health;
}

/**
 * Coaching is framed around what shipped, not what got committed (#11172). A
 * commit count in Daintree mostly measures how busy the agents were; merged
 * changes are the outcome the user actually cares about. Every branch is
 * neutral or positive — none can express failure, and none asks for a commit.
 */
export function getCoachLine(
  pulse: ProjectPulse,
  health: ForgeProjectHealthPayload | null
): string {
  // Only a positive merge count is claimed as an outcome: zero is ambiguous,
  // because the provider zero-fills when its supplementary velocity query
  // fails. Read pulse.rangeDays rather than the selector's — the line describes
  // the snapshot on screen.
  const usable = getUsableHealth(health);
  const merged = usable ? (usable.mergeVelocity.mergedCounts[pulse.rangeDays] ?? 0) : 0;

  if (merged > 0) {
    // "change", not "pull request" — the forge layer is provider-neutral.
    return `${merged} change${merged !== 1 ? "s" : ""} merged in the last ${pulse.rangeDays} days — that's shipped work.`;
  }

  const sortedCells = [...pulse.heatmap]
    .filter((cell) => !isNaN(new Date(cell.date).getTime()))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // No `.at(-1)` fallback: with no real isToday cell, a stale trailing cell
  // would get reported as activity "today".
  const today = sortedCells.find((c) => c.isToday);
  if (today && today.count > 0) {
    return "There's fresh activity today.";
  }

  if (sortedCells.slice(-7).some((c) => c.count > 0)) {
    return "There's been activity this week.";
  }

  return "It's quiet right now — that's part of the work too.";
}
