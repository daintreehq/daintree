import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { FleetBand } from "@/lib/fleetAttention";
import { groupRunsByBand } from "@/lib/fleetAttention";
import { formatWaitAge } from "@/lib/projectRowStatus";

export interface PilotRow {
  run: FleetRunRow;
  band: FleetBand;
  /** Owning workspace's display name, or a fallback when it can't be resolved. */
  workspaceName: string;
  /** Branch-ish label for the run, or null when nothing better than the cwd exists. */
  branchLabel: string | null;
  /** Agent's display name, or null before detection commits. */
  agentLabel: string | null;
  /** Compact age of the current state, or null when the run never recorded one. */
  age: string | null;
}

export interface PilotSection {
  band: FleetBand;
  rows: PilotRow[];
}

/**
 * Last path segment of a run's working directory.
 *
 * A stand-in for the branch, not the branch itself. Worktree directories are
 * conventionally named after their branch, but main can't confirm that: branch
 * names live in the per-project workspace hosts, which are capped at a handful
 * of warm entries and torn down three minutes after a project goes background.
 * At any real fleet size most projects have no host, so a real branch name is
 * simply not available here — and a guessed one presented as fact would be
 * worse than an honest path fragment.
 */
function directoryLabel(cwd: string): string | null {
  const cleaned = cwd.replace(/[/\\]+$/, "");
  if (!cleaned) return null;
  const segments = cleaned.split(/[/\\]/);
  return segments[segments.length - 1] || null;
}

export interface PilotRowContext {
  /** Workspace id → display name, covering projects and scratches alike. */
  workspaceNames: ReadonlyMap<string, string>;
  /** Agent id → display name. */
  agentNames: ReadonlyMap<string, string>;
  nowMs: number;
}

export function buildPilotSections(
  runs: readonly FleetRunRow[],
  ctx: PilotRowContext
): PilotSection[] {
  return groupRunsByBand(runs).map(({ band, runs: banded }) => ({
    band,
    rows: banded.map((run) => ({
      run,
      band,
      // A run whose workspace has been removed from the store still has to
      // render — dropping it would hide a live agent because a lookup missed.
      workspaceName: ctx.workspaceNames.get(run.workspaceId) ?? "Unknown workspace",
      branchLabel: directoryLabel(run.cwd),
      agentLabel: run.agentId ? (ctx.agentNames.get(run.agentId) ?? run.agentId) : null,
      age: run.since !== undefined ? formatWaitAge(run.since, ctx.nowMs) : null,
    })),
  }));
}

/** Per-band heading copy. Sentence case, no trailing period. */
export const BAND_LABEL: Record<FleetBand, string> = {
  blocked: "Blocked",
  "needs-you": "Needs you",
  review: "Ready for review",
  running: "Running",
  idle: "Idle",
};
