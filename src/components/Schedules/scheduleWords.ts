import { nextCronOccurrence } from "@shared/utils/cron";
import { describeParsedCron } from "@shared/utils/cronDescription";
import { validateCadence } from "@shared/utils/scheduledRuns";
import type {
  ScheduleCadence,
  ScheduleDonePolicy,
  ScheduleLaunch,
  ScheduleMissedRunPolicy,
  ScheduleOverlapPolicy,
} from "@shared/types/scheduledRuns";

export const WORKTREE_UNCONFIRMED_LABEL = "Worktree unconfirmed";
export const WORKTREE_MISSING_LABEL = "Missing worktree";

/**
 * A fixed worktree target the listed choices don't name. Called missing only
 * once the project's worktrees are known (`worktreeIds` non-null): before that
 * the list is empty, still loading or out of date, so the target stays
 * unconfirmed. A known id with no choice of its own is the main checkout.
 */
export function unlistedWorktreeLabel(
  worktreeId: string,
  worktreeIds: ReadonlySet<string> | null
): string {
  if (worktreeIds === null) return WORKTREE_UNCONFIRMED_LABEL;
  return worktreeIds.has(worktreeId) ? "Main checkout" : WORKTREE_MISSING_LABEL;
}

/** Where a schedule's runs start, in words; null for the main checkout. */
export function scheduleWorktreeLabel(
  launch: Pick<ScheduleLaunch, "worktreeId" | "newWorktree">,
  labels: ReadonlyMap<string, string>,
  worktreeIds: ReadonlySet<string> | null
): string | null {
  if (launch.newWorktree) return `New worktree from ${launch.newWorktree.baseBranch}`;
  if (launch.worktreeId === null) return null;
  return labels.get(launch.worktreeId) ?? unlistedWorktreeLabel(launch.worktreeId, worktreeIds);
}

/** The cadence in words, or null when it has no short reading and the expression has to speak for itself. */
export function cadenceWords(cadence: ScheduleCadence): string | null {
  const validation = validateCadence(cadence);
  return validation.ok ? describeParsedCron(validation.cron) : null;
}

/** When the schedule next fires after `now`, or null when its cadence can't be read. */
export function nextRunAt(cadence: ScheduleCadence, now: number): number | null {
  const validation = validateCadence(cadence);
  if (!validation.ok) return null;
  try {
    return nextCronOccurrence(validation.cron, validation.timeZone, now);
  } catch {
    return null;
  }
}

export const MISSED_RUN_OPTIONS: readonly { value: ScheduleMissedRunPolicy; label: string }[] = [
  { value: "run-once-late", label: "Run once late" },
  { value: "skip", label: "Skip" },
];

export const MISSED_RUN_CONSEQUENCE: Record<ScheduleMissedRunPolicy, string> = {
  "run-once-late":
    "Runs missed while the computer slept or Daintree was closed catch up as one run when it's back",
  skip: "Runs missed while the computer slept or Daintree was closed are recorded as skipped",
};

export const OVERLAP_OPTIONS: readonly { value: ScheduleOverlapPolicy; label: string }[] = [
  { value: "skip", label: "Skip" },
  { value: "start-another", label: "Start another" },
  { value: "replace", label: "Replace" },
];

export const OVERLAP_CONSEQUENCE: Record<ScheduleOverlapPolicy, string> = {
  skip: "The new run is skipped while the last one is still going",
  "start-another": "The new run starts alongside the one still going",
  replace: "The run still going is stopped and the new one takes its place",
};

export const DONE_OPTIONS: readonly { value: ScheduleDonePolicy; label: string }[] = [
  { value: "keep", label: "Keep" },
  { value: "background", label: "Background" },
  { value: "close", label: "Close" },
];

export const DONE_CONSEQUENCE: Record<ScheduleDonePolicy, string> = {
  keep: "The terminal stays where it opened",
  background: "The terminal moves to the background, still running",
  close: "The terminal closes; its conversation can still be resumed",
};
