import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import type { AgentState } from "@shared/types/agent";
import { FLEET_BANDS, type FleetBand } from "@shared/utils/fleetBands";
import { bandLabel } from "@/lib/fleetAttention";
import { branchTitle } from "@/lib/worktreeHeadline";

/**
 * The bands a host row counts, in fixed columns that never move: an agent gone
 * quiet, a hand-back nobody has read, work in flight. Agents asking (blocked,
 * waiting) are named under their host instead, so the row doesn't count them
 * twice; finished, parked, snoozed and idle agents are settled business.
 */
export const ROW_BANDS = ["quiet", "review", "running"] as const;
export type RowBand = (typeof ROW_BANDS)[number];

function isRowBand(band: FleetBand): band is RowBand {
  return (ROW_BANDS as readonly FleetBand[]).includes(band);
}

/** Only an agent asking for something is named under its host; the rest are counted. */
function isAsking(band: FleetBand): band is OtherHostAsk["band"] {
  return band === "blocked" || band === "needs-you";
}

export interface OtherHostAsk {
  projectId: string;
  worktreeId: string;
  /** Null from a host that doesn't say which terminal: the switch lands on the project. */
  terminalId: string | null;
  /** The branch without its type prefix, which is where issue numbers start. */
  label: string;
  /** The full branch (or worktree name), for the tooltip and the spoken name. */
  branch: string;
  band: "blocked" | "needs-you";
  agentState: AgentState | null;
}

export interface OtherHostSummary {
  counts: Readonly<Record<RowBand, number>>;
  /** Every band the host observed, settled ones too, for the row's spoken description. */
  observed: ReadonlyMap<FleetBand, number>;
  /** The agents asking, blocked first, in a stable order. */
  asks: readonly OtherHostAsk[];
}

function runsOf(entry: HostWorktreeEntry) {
  if (entry.runs) return entry.runs;
  // A host from before agents were listed says only the worktree's most urgent one.
  return entry.observed ? [{ ...entry.observed, terminalId: null }] : [];
}

/**
 * What a host observed of this project's agents: per-band counts of agents
 * (not worktrees: one worktree may hold several), and the asking ones by name.
 */
export function summarizeOtherHost(entries: readonly HostWorktreeEntry[]): OtherHostSummary {
  const counts: Record<RowBand, number> = { quiet: 0, review: 0, running: 0 };
  const observed = new Map<FleetBand, number>();
  const asks: OtherHostAsk[] = [];
  for (const entry of entries) {
    for (const run of runsOf(entry)) {
      observed.set(run.band, (observed.get(run.band) ?? 0) + 1);
      const band = run.band;
      if (isRowBand(band)) counts[band] += 1;
      if (isAsking(band)) {
        asks.push({
          projectId: entry.projectId,
          worktreeId: entry.worktreeId,
          terminalId: run.terminalId,
          label: branchTitle(entry.branch ?? entry.name),
          branch: entry.branch ?? entry.name,
          band,
          agentState: run.agentState,
        });
      }
    }
  }
  asks.sort(
    (a, b) =>
      FLEET_BANDS.indexOf(a.band) - FLEET_BANDS.indexOf(b.band) ||
      a.branch.localeCompare(b.branch) ||
      (a.terminalId ?? "").localeCompare(b.terminalId ?? "")
  );
  const ordered = new Map(
    FLEET_BANDS.filter((band) => observed.has(band)).map((band) => [band, observed.get(band)!])
  );
  return { counts, observed: ordered, asks };
}

/** "3 working, 1 waiting, 2 finished": every band the host observed, worst first. */
export function describeObserved(observed: ReadonlyMap<FleetBand, number>): string {
  return [...observed]
    .map(([band, n]) => `${n} ${bandLabel(band, { agentState: undefined }).toLowerCase()}`)
    .join(", ");
}
