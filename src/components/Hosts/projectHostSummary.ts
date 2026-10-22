import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import { FLEET_BANDS, type FleetBand } from "@shared/utils/fleetBands";
import { bandLabel } from "@/lib/fleetAttention";

/**
 * What a host row counts, worst first: agents asking (blocked or waiting),
 * agents gone quiet, hand-backs nobody has read, work in flight. Finished,
 * parked, snoozed and idle agents are settled business and only reach the
 * row's hover.
 */
export const ROW_BANDS = ["asking", "quiet", "review", "running"] as const;
export type RowBand = (typeof ROW_BANDS)[number];

function rowBandOf(band: FleetBand): RowBand | null {
  if (band === "blocked" || band === "needs-you") return "asking";
  if (band === "quiet" || band === "review" || band === "running") return band;
  return null;
}

export interface HostProjectSummary {
  counts: Readonly<Record<RowBand, number>>;
  /** Which mark the asking count wears: blocked when any agent there is blocked. */
  askingBand: "blocked" | "needs-you";
  /** Every band the host observed, settled ones too, worst first, for the hover and the spoken name. */
  observed: ReadonlyMap<FleetBand, number>;
  worktreeCount: number;
  /** The newest activity any of the project's worktrees there reported; null when none did. */
  latestActivityAt: number | null;
}

function runsOf(entry: HostWorktreeEntry) {
  if (entry.runs) return entry.runs;
  // A host from before agents were listed says only the worktree's most urgent one.
  return entry.observed ? [entry.observed] : [];
}

/** What a host observed of this project's agents: agents, not worktrees, since one worktree may hold several. */
export function summarizeHostProject(entries: readonly HostWorktreeEntry[]): HostProjectSummary {
  const counts: Record<RowBand, number> = { asking: 0, quiet: 0, review: 0, running: 0 };
  const observed = new Map<FleetBand, number>();
  let blocked = false;
  let latestActivityAt: number | null = null;
  for (const entry of entries) {
    if (entry.lastActivityAt !== null && entry.lastActivityAt > (latestActivityAt ?? -Infinity)) {
      latestActivityAt = entry.lastActivityAt;
    }
    for (const run of runsOf(entry)) {
      observed.set(run.band, (observed.get(run.band) ?? 0) + 1);
      if (run.band === "blocked") blocked = true;
      const band = rowBandOf(run.band);
      if (band) counts[band] += 1;
    }
  }
  const ordered = new Map(
    FLEET_BANDS.filter((band) => observed.has(band)).map((band) => [band, observed.get(band)!])
  );
  return {
    counts,
    askingBand: blocked ? "blocked" : "needs-you",
    observed: ordered,
    worktreeCount: entries.length,
    latestActivityAt,
  };
}

/** "3 working, 1 waiting, 2 finished": every band the host observed, worst first. */
export function describeObserved(observed: ReadonlyMap<FleetBand, number>): string {
  return [...observed]
    .map(([band, n]) => `${n} ${bandLabel(band, { agentState: undefined }).toLowerCase()}`)
    .join(", ");
}
