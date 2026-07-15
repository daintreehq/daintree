import type { ProjectPulse, PulseRangeDays } from "@shared/types";
import type { ForgeProjectHealthPayload } from "@shared/types/ipc/forge";

const RECENT_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * What the card has to say, before it's put into words. Splitting the decision
 * from the copy keeps the branch order and the data it selects testable without
 * pinning down the wording.
 */
export type CoachSignal =
  | { kind: "merged"; count: number; rangeDays: PulseRangeDays }
  | { kind: "today" }
  | { kind: "recent" }
  | { kind: "quiet" };

/**
 * Narrows health down to the payload the chips below the coach line are willing
 * to render, so the two can never disagree about whether forge data is usable —
 * a coach line claiming merges above an error hint would be a lie.
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
 * Coaching is framed around what landed, not what got committed (#11172). A
 * commit count in Daintree mostly measures how busy the agents were; merged
 * changes are the outcome the user actually cares about.
 */
export function getCoachSignal(
  pulse: ProjectPulse,
  health: ForgeProjectHealthPayload | null
): CoachSignal {
  // Only a positive merge count is claimed as an outcome: zero is ambiguous,
  // because the provider zero-fills when its supplementary velocity query
  // fails. Read pulse.rangeDays rather than the selector's — the signal
  // describes the snapshot on screen.
  const usable = getUsableHealth(health);
  const merged = usable ? (usable.mergeVelocity.mergedCounts[pulse.rangeDays] ?? 0) : 0;
  if (merged > 0) return { kind: "merged", count: merged, rangeDays: pulse.rangeDays };

  const cells = [...pulse.heatmap]
    .filter((cell) => !Number.isNaN(new Date(cell.date).getTime()))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Recency is anchored to the cell the service marked as today, never to the
  // tail of the array: a heatmap that stops short of today would otherwise have
  // its last entries read as "recent" no matter how old they are. With no such
  // cell there is no way to date the activity, so the card stays quiet.
  const today = cells.find((cell) => cell.isToday);
  if (!today) return { kind: "quiet" };
  if (today.count > 0) return { kind: "today" };

  // Bounded at both ends: a cell dated past today (clock skew, a bad fixture)
  // isn't evidence of recent work either.
  const todayAt = new Date(today.date).getTime();
  const cutoff = todayAt - (RECENT_WINDOW_DAYS - 1) * DAY_MS;
  const recently = cells.some((cell) => {
    if (cell.count === 0) return false;
    const at = new Date(cell.date).getTime();
    return at >= cutoff && at <= todayAt;
  });
  return recently ? { kind: "recent" } : { kind: "quiet" };
}

/**
 * States what happened. Never asks for anything, never praises, and never
 * frames a quiet stretch as a shortfall — no branch here can express failure.
 */
export function getCoachLine(
  pulse: ProjectPulse,
  health: ForgeProjectHealthPayload | null
): string {
  const signal = getCoachSignal(pulse, health);
  switch (signal.kind) {
    case "merged":
      // "change" and "landed", not "pull request" or "shipped" — the forge layer
      // is provider-neutral, and a merge means it landed on the base branch, not
      // that it reached anyone's machine.
      return `${signal.count} change${signal.count !== 1 ? "s" : ""} landed in the last ${signal.rangeDays} days.`;
    case "today":
      return "There's activity today.";
    case "recent":
      return "There's been activity in the last seven days.";
    case "quiet":
      // Deliberately unscoped: this branch also covers a heatmap with no cell
      // dated today, where no particular window can be vouched for.
      return "It's been quiet lately.";
    default:
      return assertNever(signal);
  }
}

function assertNever(signal: never): never {
  throw new Error(`unhandled coach signal: ${JSON.stringify(signal)}`);
}
