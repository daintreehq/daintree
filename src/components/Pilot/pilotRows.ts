import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { FleetBand } from "@/lib/fleetAttention";
import { bandForRun, compareWithinBand, FLEET_BANDS, isDemandBand } from "@/lib/fleetAttention";
import { formatWaitAge } from "@/lib/projectRowStatus";

export interface PilotRow {
  run: FleetRunRow;
  band: FleetBand;
  /** Panel title — what the agent calls its own work. Falls back to the agent name. */
  title: string;
  /** Worktree label, or null when it would only repeat the project name. */
  worktreeLabel: string | null;
  /**
   * Agent's display name — null before detection commits, and also null when
   * the title already IS that name (an untitled run falls back to it).
   */
  agentLabel: string | null;
  /** Compact age of the current state, or null when the run never recorded one. */
  age: string | null;
}

export interface PilotProjectGroup {
  workspaceId: string;
  name: string;
  emoji: string | null;
  /** Project tile colour, so the header carries the same identity as the switcher's rows. */
  color: string | null;
  rows: PilotRow[];
  /** Runs in this project that constitute a demand on the user. */
  demandCount: number;
  /** Worst band present, which is what orders the group against its siblings. */
  topBand: FleetBand;
}

function directoryLabel(cwd: string): string | null {
  const cleaned = cwd.replace(/[/\\]+$/, "");
  if (!cleaned) return null;
  const segments = cleaned.split(/[/\\]/);
  return segments[segments.length - 1] || null;
}

/**
 * Drop a label that only repeats something already on the row.
 *
 * Two ways a row earns a redundant line. A run in the project's own root
 * worktree has a cwd whose last segment IS the project folder, so it would read
 * "Daintree · daintree". An untitled run falls back to its agent's name for the
 * title, so the agent label under it would read "Claude / Claude". Both are a
 * separator promising a second fact and then not delivering one.
 */
function disambiguatingLabel(label: string | null, against: string): string | null {
  if (label === null) return null;
  return label.toLowerCase() === against.toLowerCase() ? null : label;
}

export interface PilotWorkspaceMeta {
  name: string;
  emoji?: string;
  color?: string;
}

export interface PilotRowContext {
  workspaces: ReadonlyMap<string, PilotWorkspaceMeta>;
  agentNames: ReadonlyMap<string, string>;
  nowMs: number;
}

const BAND_RANK = new Map<FleetBand, number>(FLEET_BANDS.map((band, i) => [band, i]));

function rank(band: FleetBand): number {
  return BAND_RANK.get(band) ?? FLEET_BANDS.length;
}

/** Most recent state transition in a project, for the severity tiebreak. */
function latestActivity(runs: readonly FleetRunRow[]): number {
  let latest = 0;
  for (const run of runs) if (run.since !== undefined && run.since > latest) latest = run.since;
  return latest;
}

/**
 * Group every run under the project that owns it.
 *
 * Project is the primary axis because that is the unit the user thinks in.
 * Ordering is by SEVERITY, never by how many agents a project holds: a project
 * running eight idle agents would otherwise bury one holding a single blocked
 * agent, which is the documented failure mode of count-based ranking in
 * operator tools. Volume is reported as a count on the header instead, where it
 * informs without competing for position. Projects tied on severity fall back
 * to most-recent activity, then to name, so the order is always explainable.
 */
export function buildPilotGroups(
  runs: readonly FleetRunRow[],
  ctx: PilotRowContext
): PilotProjectGroup[] {
  const byWorkspace = new Map<string, FleetRunRow[]>();
  for (const run of runs) {
    const bucket = byWorkspace.get(run.workspaceId);
    if (bucket) bucket.push(run);
    else byWorkspace.set(run.workspaceId, [run]);
  }

  const groups: Array<PilotProjectGroup & { latestActivity: number }> = [];
  for (const [workspaceId, workspaceRuns] of byWorkspace) {
    const meta = ctx.workspaces.get(workspaceId);
    // A run whose workspace has been removed from the store still has to render
    // — dropping it would hide a live agent because a lookup missed.
    const name = meta?.name ?? "Unknown workspace";

    const sorted = [...workspaceRuns].sort((a, b) => {
      const byBand = rank(bandForRun(a)) - rank(bandForRun(b));
      return byBand !== 0 ? byBand : compareWithinBand(a, b);
    });

    const rows: PilotRow[] = sorted.map((run) => {
      const agentLabel = run.agentId ? (ctx.agentNames.get(run.agentId) ?? run.agentId) : null;
      const title = run.title?.trim() || agentLabel || "Untitled";
      return {
        run,
        band: bandForRun(run),
        title,
        worktreeLabel: disambiguatingLabel(directoryLabel(run.cwd), name),
        agentLabel: disambiguatingLabel(agentLabel, title),
        age: run.since !== undefined ? formatWaitAge(run.since, ctx.nowMs) : null,
      };
    });

    groups.push({
      workspaceId,
      name,
      emoji: meta?.emoji ?? null,
      color: meta?.color ?? null,
      rows,
      demandCount: rows.filter((r) => isDemandBand(r.band)).length,
      topBand: rows[0]?.band ?? "idle",
      latestActivity: latestActivity(workspaceRuns),
    });
  }

  groups.sort((a, b) => {
    const byBand = rank(a.topBand) - rank(b.topBand);
    if (byBand !== 0) return byBand;
    const byRecency = b.latestActivity - a.latestActivity;
    if (byRecency !== 0) return byRecency;
    return a.name.localeCompare(b.name);
  });

  return groups.map(({ latestActivity: _latest, ...group }) => group);
}

/**
 * Filter groups to rows matching a query, dropping groups left with nothing.
 *
 * Matching stays grouped rather than flattening to a ranked list: a run's
 * project is load-bearing context, and "fix the auth bug" means something
 * different in two different repos. An emptied group disappears entirely —
 * a header with no rows under it is pure scroll friction.
 *
 * Matches the panel title first because that is what the user is searching by,
 * but also the worktree, agent and project name, since any of those is a
 * plausible thing to type.
 */
export function filterPilotGroups(
  groups: readonly PilotProjectGroup[],
  query: string
): PilotProjectGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...groups];

  const out: PilotProjectGroup[] = [];
  for (const group of groups) {
    const projectMatches = group.name.toLowerCase().includes(needle);
    const rows = group.rows.filter(
      (row) =>
        projectMatches ||
        row.title.toLowerCase().includes(needle) ||
        row.worktreeLabel?.toLowerCase().includes(needle) === true ||
        row.agentLabel?.toLowerCase().includes(needle) === true
    );
    if (rows.length === 0) continue;
    out.push({
      ...group,
      rows,
      demandCount: rows.filter((r) => isDemandBand(r.band)).length,
    });
  }
  return out;
}
