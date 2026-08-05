import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { FleetBand, FleetBandCounts } from "@/lib/fleetAttention";
import {
  bandForRun,
  bandLabel,
  compareWithinBand,
  emptyBandCounts,
  FLEET_BANDS,
  isDemandBand,
} from "@/lib/fleetAttention";
import { formatWaitAge } from "@/lib/projectRowStatus";
import { isFilterMatch } from "@/lib/projectSwitcherSearch";
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
  /**
   * What the run is doing, in the same words the switcher uses for the same
   * state. Not drawn — the glyph says this now — but it carries the state into
   * the row's accessible name, which is where it may never stop being text.
   */
  statusLabel: string;
  /**
   * Worktree label, or null when it would only repeat the project name.
   *
   * Not drawn either: a scratch project's directory is a UUID, and the title
   * was truncating to make room for a string nobody can read. It stays on the
   * row because {@link filterPilotGroups} matches on it — typing a branch name
   * to find a run is useful whether or not the label is on screen.
   */
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

/**
 * A group restricted to a subset of its own rows, with both derived fields
 * recomputed rather than inherited.
 *
 * `topBand` is found by RANK across the survivors rather than read off
 * `rows[0]`. Rows reaching a filter have already been through `frozenOrder`,
 * which pins the order captured when the dialog opened — so once a run changes
 * state the first row is no longer guaranteed to be the worst one present.
 * Inheriting either field would put a header's summary and its collapsed pip
 * cluster at odds with the rows directly underneath it.
 */
function narrowGroup(group: PilotProjectGroup, rows: PilotRow[]): PilotProjectGroup {
  let topBand: FleetBand = "idle";
  // Annotated: `FLEET_BANDS` is a const tuple, so its `length` narrows to the
  // literal 6 and the accumulator would refuse every rank assigned below it.
  let best: number = FLEET_BANDS.length;
  let demandCount = 0;
  for (const row of rows) {
    const rowRank = rank(row.band);
    if (rowRank < best) {
      best = rowRank;
      topBand = row.band;
    }
    if (isDemandBand(row.band)) demandCount++;
  }
  return { ...group, rows, demandCount, topBand };
}

/**
 * Oldest still-outstanding demand in a project, or undefined when it has none.
 *
 * The group-level counterpart of {@link compareWithinBand}'s anti-starvation
 * rule, which is the point: a project whose block has been standing for forty
 * minutes stops being displaced by one that only just started asking.
 *
 * Not identical to it, deliberately. `compareWithinBand` ranks rows inside ONE
 * band; this takes the oldest demand of ANY kind, so a long-unread completion
 * can date a project whose worst band is a fresh question. That is the right
 * reading of "oldest outstanding demand" — a review nobody has looked at in two
 * hours is outstanding — but it does mean the two are not the same function.
 *
 * A demand with no `since` contributes nothing rather than counting as
 * infinitely old — an unknown age is not evidence of urgency.
 */
function oldestDemand(rows: readonly PilotRow[]): number | undefined {
  let oldest: number | undefined;
  for (const row of rows) {
    if (!isDemandBand(row.band)) continue;
    const since = row.run.since;
    if (since === undefined) continue;
    if (oldest === undefined || since < oldest) oldest = since;
  }
  return oldest;
}

/**
 * Group every run under the project that owns it.
 *
 * Project is the primary axis because that is the unit the user thinks in.
 * Ordering is by SEVERITY, never by how many agents a project holds: a project
 * running eight idle agents would otherwise bury one holding a single blocked
 * agent, which is the documented failure mode of count-based ranking in
 * operator tools. Volume is reported as a count on the header instead, where it
 * informs without competing for position.
 *
 * Ties break on the oldest outstanding demand, NOT on recency. Recency changed
 * between every single opening, so the group order was never the same twice and
 * spatial memory never formed — and it inverted the anti-starvation rule the
 * rows themselves already follow. Quiet projects, which have no demand to date,
 * fall back to the workspace this view already owns and then to name, so their
 * order is fixed for as long as they stay quiet and only genuinely demanding
 * projects float.
 *
 * The current workspace is deliberately NOT pinned above severity: putting
 * context first would bury a blocked agent in another project, which is the
 * exact failure the band ordering exists to prevent.
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

  const groups: Array<PilotProjectGroup & { oldestDemand: number | undefined }> = [];
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
      oldestDemand: oldestDemand(rows),
    });
  }

  groups.sort((a, b) => {
    const byBand = rank(a.topBand) - rank(b.topBand);
    if (byBand !== 0) return byBand;

    // Both sides share a top band here, so testing either one answers for the
    // pair. A demand band ranks by how long it has been outstanding; anything
    // else has no urgency to compare and gives primacy to the workspace this
    // view is already in, where opening a run costs no switch.
    if (isDemandBand(a.topBand)) {
      const ao = a.oldestDemand;
      const bo = b.oldestDemand;
      if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
      if (ao === undefined && bo !== undefined) return 1;
      if (bo === undefined && ao !== undefined) return -1;
    } else if (a.isCurrent !== b.isCurrent) {
      return a.isCurrent ? -1 : 1;
    }

    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    // Workspace id last, so the comparator is a TRUE total order. Two projects
    // sharing a name is ordinary (a scratch and a project, or two checkouts),
    // and leaving them to `sort`'s arbitrary decision would make "the same
    // fleet opens in the same order" false exactly where it is hardest to see.
    if (a.workspaceId === b.workspaceId) return 0;
    return a.workspaceId < b.workspaceId ? -1 : 1;
  });

  return groups.map(({ oldestDemand: _oldest, ...group }) => group);
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
 *
 * That is exactly why the fields are gated on {@link isFilterMatch} rather than
 * a bare subsequence test. Keeping band order means a weak match is not sorted
 * away from a strong one, it is interleaved with it, so match quality has to be
 * settled here or not at all — and a loose hit on `group.name` is worse still,
 * since it admits every row in the project (#11625).
 */
export function filterPilotGroups(
  groups: readonly PilotProjectGroup[],
  query: string
): PilotProjectGroup[] {
  const needle = query.trim();
  if (!needle) return [...groups];

  const out: PilotProjectGroup[] = [];
  for (const group of groups) {
    const projectMatches = isFilterMatch(needle, group.name);
    const rows = group.rows.filter(
      (row) =>
        projectMatches ||
        isFilterMatch(needle, row.title) ||
        (row.worktreeLabel !== null && isFilterMatch(needle, row.worktreeLabel)) ||
        // The agent's name is on the row as an icon rather than as text, but
        // "codex" is still a plausible thing to type when looking for one.
        isFilterMatch(needle, row.chrome.label)
    );
    if (rows.length === 0) continue;
    // Recomputed, never inherited: a query that filters the blocked run out of
    // a project leaves a group whose header would otherwise still announce
    // "0 agents blocked" over a row that is merely running.
    out.push(narrowGroup(group, rows));
  }
  return out;
}

/**
 * The state filter's vocabulary, declared beside the bands so a segment and the
 * count under it can never drift apart.
 */
export type PilotBandFilter = "all" | "needs-you" | "working" | "finished";

/**
 * Which bands each segment admits.
 *
 * `idle` is deliberately in no bucket but All: an exited terminal isn't
 * working, isn't finished, and isn't asking for anything, so putting it
 * anywhere else would make that segment lie about what it holds.
 *
 * "Needs you" is `blocked` + `needs-you` and NOT `review`, even though
 * `isDemandBand` counts review as a demand. Review is a hand-back, not a
 * block — folding it in would make the footer's demand count promise more
 * agents than applying the filter actually reveals.
 */
const BAND_FILTER_SETS: Record<Exclude<PilotBandFilter, "all">, ReadonlySet<FleetBand>> = {
  "needs-you": new Set<FleetBand>(["blocked", "needs-you"]),
  working: new Set<FleetBand>(["running"]),
  finished: new Set<FleetBand>(["review", "done"]),
};

/** The narrowing segments, in the order the bar renders them after All. */
export const PILOT_BAND_FILTERS: readonly Exclude<PilotBandFilter, "all">[] = [
  "needs-you",
  "working",
  "finished",
];

/**
 * A segment's name, declared here rather than in the bar because two surfaces
 * say it: the segment itself, and the empty state that has to name which filter
 * produced no rows.
 *
 * "Waiting", not "Needs you", so the four segments read the same here as they
 * do in the sidebar's `QuickStateFilterBar`. The key stays `needs-you` — it
 * names the band set, which has not changed.
 */
export const PILOT_BAND_FILTER_LABEL: Record<PilotBandFilter, string> = {
  all: "All",
  "needs-you": "Waiting",
  working: "Working",
  finished: "Finished",
};

export type PilotBandFilterCounts = Record<PilotBandFilter, number>;

/**
 * Rows per segment.
 *
 * Counted BEFORE the band filter runs, which is the whole reason this is a
 * separate pass: each segment has to report the query-intersected population.
 * Counting afterwards would give every segment its own filtered total, which is
 * always the length of the list already on screen and therefore tells the user
 * nothing they can't see.
 */
export function countPilotBands(groups: readonly PilotProjectGroup[]): PilotBandFilterCounts {
  const counts: PilotBandFilterCounts = { all: 0, "needs-you": 0, working: 0, finished: 0 };
  for (const group of groups) {
    for (const row of group.rows) {
      counts.all++;
      for (const filter of PILOT_BAND_FILTERS) {
        if (BAND_FILTER_SETS[filter].has(row.band)) counts[filter]++;
      }
    }
  }
  return counts;
}

/**
 * Whether a segment currently holds anything that is a demand on the user.
 *
 * "Finished" is the reason this exists: it admits `review`, which is a demand,
 * alongside `done`, which is not. Colouring the segment on membership alone
 * would paint a project whose every completion has been acknowledged in the
 * hue reserved for work still waiting to be looked at — putting back one of the
 * false signals this surface exists to remove. "Needs you" holds only demands,
 * so it is hued whenever it holds anything at all, which this returns for free.
 */
export function bandFilterHasDemand(
  bands: Readonly<FleetBandCounts>,
  filter: PilotBandFilter
): boolean {
  if (filter === "all") return false;
  for (const band of BAND_FILTER_SETS[filter]) {
    if (isDemandBand(band) && bands[band] > 0) return true;
  }
  return false;
}

/**
 * Filter groups to the rows one segment admits, dropping groups left empty.
 *
 * Composes with {@link filterPilotGroups} rather than replacing it — the query
 * and the segment intersect with AND, so "show me the blocked agents in this
 * repo" is one question rather than two mutually exclusive ones. Input order is
 * preserved: ordering is decided once, upstream, and a filter that re-sorted
 * would move rows under the cursor.
 */
export function filterPilotBands(
  groups: readonly PilotProjectGroup[],
  filter: PilotBandFilter
): PilotProjectGroup[] {
  if (filter === "all") return [...groups];

  const bands = BAND_FILTER_SETS[filter];
  const out: PilotProjectGroup[] = [];
  for (const group of groups) {
    const rows = group.rows.filter((row) => bands.has(row.band));
    if (rows.length === 0) continue;
    out.push(narrowGroup(group, rows));
  }
  return out;
}

export interface PilotSummary {
  total: number;
  demand: number;
  bands: FleetBandCounts;
}

/**
 * Fleet totals for the footer.
 *
 * Counted over whatever population the caller hands it. The fleet overview
 * passes the QUERY-filtered groups — before the band filter — so the footer
 * describes, and its demand control acts on, the same set the segment counts
 * report. Passing the band-filtered groups instead would make the footer
 * describe only what the current segment already shows.
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
