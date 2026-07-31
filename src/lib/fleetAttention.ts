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
export const FLEET_BANDS = ["blocked", "needs-you", "review", "running", "idle"] as const;

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
  idle: "muted",
};

/**
 * Which band a run belongs to.
 *
 * `completed` maps to review unconditionally — whether the user has *seen* that
 * completion is an acknowledgement question, and acknowledgement is tracked per
 * workspace, not per run. Consumers that want an unacknowledged-only view have
 * to filter with a watermark they own; folding it in here would make this
 * function silently disagree with itself across surfaces.
 */
export function bandForRun(run: FleetRunRow): FleetBand {
  switch (run.agentState) {
    case "waiting":
      return run.waitingReason === "error" ? "blocked" : "needs-you";
    case "completed":
      return "review";
    case "working":
    case "directing":
      return "running";
    default:
      return "idle";
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

export interface FleetBandGroup {
  band: FleetBand;
  runs: FleetRunRow[];
}

/**
 * Group runs into bands, worst-first, each internally oldest-first.
 *
 * Empty bands are omitted rather than rendered as a zero. A band heading
 * reading "Blocked 0" is a lit element making no demand, which is precisely
 * what a supervision surface must not spend attention on.
 */
export function groupRunsByBand(runs: readonly FleetRunRow[]): FleetBandGroup[] {
  const byBand = new Map<FleetBand, FleetRunRow[]>();
  for (const run of runs) {
    const band = bandForRun(run);
    const bucket = byBand.get(band);
    if (bucket) bucket.push(run);
    else byBand.set(band, [run]);
  }

  const groups: FleetBandGroup[] = [];
  for (const band of FLEET_BANDS) {
    const bucket = byBand.get(band);
    if (!bucket || bucket.length === 0) continue;
    bucket.sort(compareWithinBand);
    groups.push({ band, runs: bucket });
  }
  return groups;
}

/** How many runs currently constitute a demand on the user. */
export function countDemands(runs: readonly FleetRunRow[]): number {
  let count = 0;
  for (const run of runs) {
    if (isDemandBand(bandForRun(run))) count++;
  }
  return count;
}
