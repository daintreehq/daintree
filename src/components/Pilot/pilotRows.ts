import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { FleetBand, FleetBandCounts } from "@/lib/fleetAttention";
import {
  bandForRun,
  bandLabel,
  BAND_TONE,
  compareWithinBand,
  emptyBandCounts,
  FLEET_BANDS,
  isDemandBand,
} from "@/lib/fleetAttention";
import { formatWaitAge, type ProjectRowTone } from "@/lib/projectRowStatus";
import { isSubsequenceMatch } from "@/lib/projectSwitcherSearch";
import { composeTitledPanel } from "@/utils/terminalTitleDisplay";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";

export interface PilotRow {
  run: FleetRunRow;
  band: FleetBand;
  /**
   * The title the panel header and tab strip show for this run, composed by
   * the app's one title pipeline rather than re-derived here.
   */
  title: string;
  /** Icon/colour identity, so the row renders the panel's own brand mark. */
  chrome: TerminalChromeDescriptor;
  /** Preset colour when the user picked one, which `BrandMark` treats as deliberate. */
  presetColor: string | undefined;
  /** What the run is doing, in the same words the switcher uses for the same state. */
  statusLabel: string;
  /** Status colour for {@link statusLabel}. Always a status token, never the accent. */
  tone: ProjectRowTone;
  /** Worktree label, or null when it would only repeat the project name. */
  worktreeLabel: string | null;
  /** Compact age of the current state, or null when the run never recorded one. */
  age: string | null;
}

export type PilotWorkspaceKind = "project" | "scratch" | "unknown";

export interface PilotProjectGroup {
  workspaceId: string;
  kind: PilotWorkspaceKind;
  name: string;
  emoji: string | null;
  /** Project tile colour, so the header carries the same identity as the switcher's rows. */
  color: string | null;
  /** True for the workspace this view already owns — opening its runs costs no switch. */
  isCurrent: boolean;
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
  kind: PilotWorkspaceKind;
  name: string;
  emoji?: string;
  color?: string;
  /**
   * The workspace's completion watermark. Completions at or before it have been
   * seen and stop counting as a hand-back — see `bandForRun`.
   */
  lastCompletionSeenAt?: number;
}

export interface PilotRowContext {
  workspaces: ReadonlyMap<string, PilotWorkspaceMeta>;
  /** Workspace this renderer view owns, so its group can be marked as already here. */
  currentWorkspaceId: string | null;
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
    const acknowledgedAt = meta?.lastCompletionSeenAt;

    const sorted = [...workspaceRuns].sort((a, b) => {
      const byBand = rank(bandForRun(a, acknowledgedAt)) - rank(bandForRun(b, acknowledgedAt));
      return byBand !== 0 ? byBand : compareWithinBand(a, b);
    });

    const rows: PilotRow[] = sorted.map((run) => {
      const band = bandForRun(run, acknowledgedAt);
      const chrome = deriveTerminalChrome({
        kind: "terminal",
        ...(run.agentId !== undefined ? { detectedAgentId: run.agentId } : {}),
        ...(run.launchAgentId !== undefined ? { launchAgentId: run.launchAgentId } : {}),
        ...(run.everDetectedAgent !== undefined
          ? { everDetectedAgent: run.everDetectedAgent }
          : {}),
        ...(run.agentState !== undefined ? { agentState: run.agentState } : {}),
        ...(run.agentPresetColor !== undefined ? { agentPresetColor: run.agentPresetColor } : {}),
      });
      // Composed through the app's one title pipeline, not assembled here.
      // Reading `lastObservedTitle` directly is what made rows read "Claude
      // Code" — the agent naming itself, which the pipeline recognises as an
      // identity echo and suppresses. `compact` because the brand icon beside
      // the title already carries identity, so a prefix would only push the
      // task out of the truncation window.
      const title =
        composeTitledPanel(
          {
            title: run.title ?? chrome.label,
            ...(run.titleMode !== undefined ? { titleMode: run.titleMode } : {}),
            ...(run.lastObservedTitle !== undefined
              ? { lastObservedTitle: run.lastObservedTitle }
              : {}),
            ...(run.agentId !== undefined ? { detectedAgentId: run.agentId } : {}),
            ...(run.agentState !== undefined ? { agentState: run.agentState } : {}),
            cwd: run.cwd,
          },
          "compact"
        ).trim() || chrome.label;

      return {
        run,
        band,
        title,
        chrome,
        presetColor: run.agentPresetColor,
        statusLabel: bandLabel(band, run),
        tone: BAND_TONE[band],
        worktreeLabel: disambiguatingLabel(directoryLabel(run.cwd), name),
        age: run.since !== undefined ? formatWaitAge(run.since, ctx.nowMs) : null,
      };
    });

    groups.push({
      workspaceId,
      kind: meta?.kind ?? "unknown",
      name,
      emoji: meta?.emoji ?? null,
      color: meta?.color ?? null,
      isCurrent: workspaceId === ctx.currentWorkspaceId,
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
 * plausible thing to type. Order is left alone: the switcher re-ranks by match
 * quality because one of its rows is the destination, whereas here the ranking
 * IS the answer — demoting a blocked agent because a fresher one matched the
 * query better would defeat the surface.
 */
export function filterPilotGroups(
  groups: readonly PilotProjectGroup[],
  query: string
): PilotProjectGroup[] {
  const needle = query.trim();
  if (!needle) return [...groups];

  const out: PilotProjectGroup[] = [];
  for (const group of groups) {
    const projectMatches = isSubsequenceMatch(needle, group.name);
    const rows = group.rows.filter(
      (row) =>
        projectMatches ||
        isSubsequenceMatch(needle, row.title) ||
        (row.worktreeLabel !== null && isSubsequenceMatch(needle, row.worktreeLabel)) ||
        // The agent's name is on the row as an icon rather than as text, but
        // "codex" is still a plausible thing to type when looking for one.
        isSubsequenceMatch(needle, row.chrome.label)
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

export interface PilotSummary {
  total: number;
  demand: number;
  bands: FleetBandCounts;
}

/**
 * Fleet totals for the footer, counted from the same rows the list renders so
 * the summary and the group chips can never disagree.
 */
export function summarizePilotGroups(groups: readonly PilotProjectGroup[]): PilotSummary {
  const bands = emptyBandCounts();
  let total = 0;
  let demand = 0;
  for (const group of groups) {
    for (const row of group.rows) {
      total++;
      bands[row.band]++;
      if (isDemandBand(row.band)) demand++;
    }
  }
  return { total, demand, bands };
}
