import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { ProjectRowTone } from "./projectRowStatus";

/**
 * Attention bands, worst-first.
 *
 * The order is the product decision: a run that has stopped and may not restart
 * on input outranks one merely asking a question, which outranks finished work,
 * which outranks work still in flight. Everything else is context rather than a
 * demand, and lives below the fold.
 *
 * Deliberately the same ordering the project switcher's status line already
 * implies (`src/lib/projectRowStatus.ts`), one grain finer. Two surfaces
 * disagreeing about which agent is most urgent is worse than either ordering
 * being individually wrong.
 */
export const FLEET_BANDS = ["blocked", "needs-you", "review", "running", "done", "idle"] as const;

export type FleetBand = (typeof FLEET_BANDS)[number];

/** Bands that constitute a demand on the user — the ones a quiet fleet has none of. */
const DEMAND_BANDS: ReadonlySet<FleetBand> = new Set<FleetBand>(["blocked", "needs-you", "review"]);

export function isDemandBand(band: FleetBand): boolean {
  return DEMAND_BANDS.has(band);
}

/**
 * Tone for a band, reusing the switcher's palette so one vocabulary of status
 * colour serves both surfaces. Never the accent: status is a status token, and
 * the accent is reserved for the single focus anchor in the region.
 */
export const BAND_TONE: Record<FleetBand, ProjectRowTone> = {
  blocked: "blocked",
  "needs-you": "waiting",
  review: "review",
  running: "working",
  done: "muted",
  idle: "muted",
};

/**
 * Which band a run belongs to.
 *
 * `acknowledgedAt` is the workspace's completion watermark: a completion at or
 * before it has already been seen, so it stops being a hand-back and becomes a
 * fact. Without it every finished run demands attention forever, and a user who
 * has reviewed everything still reads "3 agents need you" — the switcher makes
 * exactly this distinction (`getWorkspaceActivityStatus`) and the two surfaces
 * have to agree about what is still outstanding.
 *
 * A completion with no `since` cannot be compared to the watermark and stays in
 * `review`: unknown is not evidence of having been seen.
 */
export function bandForRun(run: FleetRunRow, acknowledgedAt?: number): FleetBand {
  switch (run.agentState) {
    case "waiting":
      return run.waitingReason === "error" ? "blocked" : "needs-you";
    case "completed":
      return acknowledgedAt !== undefined && run.since !== undefined && run.since <= acknowledgedAt
        ? "done"
        : "review";
    case "working":
    case "directing":
      return "running";
    default:
      return "idle";
  }
}

/**
 * The band's own name for what the run is doing.
 *
 * Derived from the band rather than re-read from `agentState` so the visible
 * label, the tone and the ordering can never disagree — an acknowledged
 * completion must not still say "ready for review" while sorting as done.
 * `running` and `idle` split on state because they each cover two situations
 * the user can tell apart and would want to.
 *
 * "Waiting" rather than "Needs you" for the same reason the filter segment says
 * it: the sidebar has called this state waiting since it shipped, and one state
 * with two names across two surfaces is a vocabulary the user has to learn
 * twice. The prose sentences elsewhere ("2 agents need you") are sentences, not
 * state labels, and keep their own phrasing.
 */
export function bandLabel(band: FleetBand, run: FleetRunRow): string {
  switch (band) {
    case "blocked":
      return "Blocked";
    case "needs-you":
      return "Waiting";
    case "review":
      return "Ready for review";
    case "running":
      return run.agentState === "directing" ? "Directing" : "Working";
    case "done":
      return "Finished";
    default:
      return run.agentState === "exited" ? "Exited" : "Idle";
  }
}

/**
 * Sort key within a band: oldest demand first.
 *
 * Oldest-first rather than newest-first is the anti-starvation choice. A stream
 * of fresh completions must never bury the run that has been stuck for forty
 * minutes — that is the exact failure that teaches a user to stop trusting the
 * top of the list.
 *
 * A run with no `since` sorts last within its band rather than first: an
 * unknown age is not evidence of urgency, and treating it as infinitely old
 * would let a pre-detection boot window outrank a genuine forty-minute block.
 */
export function compareWithinBand(a: FleetRunRow, b: FleetRunRow): number {
  const aSince = a.since;
  const bSince = b.since;
  if (aSince !== undefined && bSince !== undefined && aSince !== bSince) return aSince - bSince;
  // An unknown age sorts after a known one, and two unknowns fall through to
  // the id tiebreak — so the comparator stays a total order rather than
  // reporting an arbitrary winner for a pair it cannot actually rank.
  if (aSince === undefined && bSince !== undefined) return 1;
  if (bSince === undefined && aSince !== undefined) return -1;
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? -1 : 1;
}

/**
 * Runs per band, for summary copy.
 *
 * Bands are counted rather than the raw run total because a raw total cannot be
 * described truthfully: a fleet of eight rows holding two working agents and six
 * exited ones is not "8 agents running", and a summary line that overstates what
 * is live is the fastest way to stop being believed.
 */
export type FleetBandCounts = Record<FleetBand, number>;

export function emptyBandCounts(): FleetBandCounts {
  return { blocked: 0, "needs-you": 0, review: 0, running: 0, done: 0, idle: 0 };
}
