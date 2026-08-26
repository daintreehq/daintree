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
  /** Preset colour when the user picked one; the mark wears it like any other brand hex. */
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
  /**
   * The park's note, drawn on the row: a parked run's one line of intent is
   * the whole reason to look at it. Null for everything unparked, and also on
   * the row's search surface — "after the migration" is a plausible thing to
   * type when hunting for the run you shelved behind it.
   */
  parkNote: string | null;
  /**
   * How long a working run has been silent, once main judged the silence
   * worth reporting. Null for a healthy busy agent — so the row only ever
   * says "quiet 12m" when there is genuinely something to look at.
   */
  quietFor: string | null;
}

export type PilotWorkspaceKind = "project" | "scratch" | "unknown";

/**
 * What every group has, whichever axis it was cut on.
 *
 * The narrowing pipeline — query, band filter, counts, summary — works on this
 * and nothing else, so both axes inherit one set of invariants rather than
 * growing a second, drifting copy. `axis` discriminates the two only where a
 * header is drawn.
 */
export interface PilotGroupCore {
  /**
   * Identity within one tree: DOM ids, React keys, and the pointer order-hold
   * all key on it.
   *
   * Deliberately NOT a workspace id. A worktree group's id names a worktree, so
   * anything that needs the workspace a run belongs to has to read it off the
   * RUN — which is where it has always been true.
   */
  groupId: string;
  axis: "workspace" | "worktree";
  name: string;
  rows: PilotRow[];
  /** Runs in this group that constitute a demand on the user. */
  demandCount: number;
  /**
   * Worst band among the rows below, recomputed rather than inherited whenever
   * the group is narrowed. A derived summary of the group's contents only —
   * group ORDER is never severity, and the header draws identity, not severity.
   */
  topBand: FleetBand;
}

export interface PilotProjectGroup extends PilotGroupCore {
  axis: "workspace";
  workspaceId: string;
  kind: PilotWorkspaceKind;
  emoji: string | null;
  /** Project tile colour, so the header carries the same identity as the switcher's rows. */
  color: string | null;
  /** True for the workspace this view already owns — opening its runs costs no switch. */
  isCurrent: boolean;
}

export interface PilotWorktreeGroup extends PilotGroupCore {
  axis: "worktree";
  /**
   * The run's normalized worktree path, or null for the bucket holding runs the
   * snapshot files under no worktree at all.
   *
   * Opaque here: a grouping key and a source of basename, never joined against
   * a worktree store. The id has two mint sites that can spell the same
   * worktree differently, and the store that would answer only exists for the
   * one project a renderer view owns.
   */
  worktreeId: string | null;
}

export type PilotDisplayGroup = PilotProjectGroup | PilotWorktreeGroup;

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
  /**
   * When the workspace was last switched to, which is what orders the groups.
   * A project-to-project switch also stamps the project being LEFT, a
   * millisecond behind, so that pair stays adjacent at the top; switches
   * involving a scratch stamp only the one being entered. Anything but a
   * finite positive number sorts as undateable.
   */
  lastOpened?: number;
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

/** The chrome the panel header and dock would derive for this run. */
export function derivePilotRunChrome(run: FleetRunRow): TerminalChromeDescriptor {
  return deriveTerminalChrome({
    kind: "terminal",
    ...(run.agentId !== undefined ? { detectedAgentId: run.agentId } : {}),
    ...(run.launchAgentId !== undefined ? { launchAgentId: run.launchAgentId } : {}),
    ...(run.everDetectedAgent !== undefined ? { everDetectedAgent: run.everDetectedAgent } : {}),
    ...(run.agentState !== undefined ? { agentState: run.agentState } : {}),
    ...(run.agentPresetColor !== undefined ? { agentPresetColor: run.agentPresetColor } : {}),
  });
}

/**
 * A run's display title, composed through the app's one title pipeline rather
 * than assembled ad hoc. Reading `lastObservedTitle` directly is what made
 * rows read "Claude Code" — the agent naming itself, which the pipeline
 * recognises as an identity echo and suppresses. `compact` because every
 * caller here pairs the string with the brand icon, so a prefix would only
 * push the task out of the truncation window. Shared by the row build and the
 * park surfaces (editor, release notification), which must all name a run the
 * same way.
 */
export function composePilotRunTitle(run: FleetRunRow, chrome?: TerminalChromeDescriptor): string {
  const resolved = chrome ?? derivePilotRunChrome(run);
  return (
    composeTitledPanel(
      {
        title: run.title ?? resolved.label,
        ...(run.titleMode !== undefined ? { titleMode: run.titleMode } : {}),
        ...(run.lastObservedTitle !== undefined
          ? { lastObservedTitle: run.lastObservedTitle }
          : {}),
        ...(run.agentId !== undefined ? { detectedAgentId: run.agentId } : {}),
        ...(run.agentState !== undefined ? { agentState: run.agentState } : {}),
        cwd: run.cwd,
      },
      "compact"
    ).trim() || resolved.label
  );
}

/**
 * A group restricted to a subset of its own rows, with both derived fields
 * recomputed rather than inherited.
 *
 * `topBand` is found by RANK across the survivors rather than read off
 * `rows[0]`. Rows reaching a filter may have been re-sorted into an order the
 * fleet overview is holding still under a pointer, so the first row is not
 * guaranteed to be the worst one present. Inheriting either field would put a
 * group's derived facts at odds with the rows directly underneath it.
 */
function narrowGroup<T extends PilotGroupCore>(group: T, rows: PilotRow[]): T {
  let topBand: FleetBand = "idle";
  // Annotated: `FLEET_BANDS` is a const tuple, so its `length` narrows to a
  // literal and the accumulator would refuse every rank assigned below it.
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
  // `Object.assign` rather than a spread: spreading a generic widens it to an
  // intersection the return type will not accept, and the alternative is a cast
  // that would stop the compiler from checking this at all.
  return Object.assign({}, group, { rows, demandCount, topBand });
}

/**
 * An opening time reduced to something the comparator can total-order on.
 *
 * Anything that is not a finite positive number — absent metadata, a corrupt
 * row, an infinity that would subtract to `NaN` — collapses to 0 and ranks as
 * undateable. A `NaN` reaching the comparator is the reason this exists: it
 * compares equal to every timestamp it meets, so the sort would silently stop
 * being transitive and the same fleet could open two different ways.
 */
function openedAt(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Group every run under the project that owns it.
 *
 * Project is the primary axis because that is the unit the user thinks in, and
 * groups read in workspace MRU order: newest `lastOpened` first, then name and
 * id to settle the rest. Severity never lifts one project above another — a
 * blocked agent in a project left an hour ago does not outrank the one being
 * worked in now (#11678).
 *
 * This is not the recency #11626 rejected. That ordering read `latestActivity`,
 * which moves while the palette is open, so groups reshuffled between openings
 * the user had not caused and spatial memory never formed. `lastOpened` moves
 * only when the user switches workspace, so the order holds still across
 * openings and changes only where they changed it themselves.
 *
 * A workspace this view cannot date sorts LAST, not first. Ranking an anomaly
 * above everything is the worse failure here: the two name stores hydrate on
 * separate promises, so a half-loaded palette would open with its unresolved
 * groups on top and watch them drop as the names land — the unstable order
 * again, through the back door. An undateable group still renders and still
 * filters; it just does not outrank a workspace with a real history.
 *
 * Severity and anti-starvation stay the ROW rule inside each group: worst band
 * first, then oldest `since`. A project's demands still surface at the top of
 * its own rows — they just no longer move the project itself.
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

  const groups: Array<PilotProjectGroup & { lastOpened: number }> = [];
  for (const [workspaceId, workspaceRuns] of byWorkspace) {
    const meta = ctx.workspaces.get(workspaceId);
    // A run whose workspace has been removed from the store still has to render
    // — dropping it would hide a live agent because a lookup missed.
    const name = meta?.name ?? "Unknown workspace";
    const acknowledgedAt = meta?.lastCompletionSeenAt;

    const sorted = [...workspaceRuns].sort((a, b) => {
      const bandA = bandForRun(a, acknowledgedAt);
      const byBand = rank(bandA) - rank(bandForRun(b, acknowledgedAt));
      if (byBand !== 0) return byBand;
      // Parked rows order on the park, not the underlying state: `since` is
      // whenever the agent last transitioned, which predates the decision the
      // band is actually about. Oldest park first, same anti-starvation rule.
      if (bandA === "parked" && a.park !== undefined && b.park !== undefined) {
        if (a.park.parkedAt !== b.park.parkedAt) return a.park.parkedAt - b.park.parkedAt;
        return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
      }
      return compareWithinBand(a, b);
    });

    const rows: PilotRow[] = sorted.map((run) => {
      const band = bandForRun(run, acknowledgedAt);
      const chrome = derivePilotRunChrome(run);
      const title = composePilotRunTitle(run, chrome);

      return {
        run,
        band,
        title,
        chrome,
        presetColor: run.agentPresetColor,
        statusLabel: bandLabel(band, run),
        worktreeLabel: disambiguatingLabel(directoryLabel(run.cwd), name),
        // A parked row's age is the age of the PARK. Dating it from `since`
        // read "Parked · 3h" the moment a three-hour-old waiting run was
        // parked, which answers "how long has it waited" when the row is now
        // about "how long ago did I shelve this".
        age:
          band === "parked" && run.park !== undefined
            ? formatWaitAge(run.park.parkedAt, ctx.nowMs)
            : run.since !== undefined
              ? formatWaitAge(run.since, ctx.nowMs)
              : null,
        parkNote: run.park?.note ?? null,
        quietFor:
          band === "running" && run.quietSince !== undefined
            ? formatWaitAge(run.quietSince, ctx.nowMs)
            : null,
      };
    });

    groups.push({
      // The project's own id doubles as the group id on this axis, which is
      // what keeps every existing group DOM id unchanged.
      groupId: workspaceId,
      axis: "workspace",
      workspaceId,
      kind: meta?.kind ?? "unknown",
      name,
      emoji: meta?.emoji ?? null,
      color: meta?.color ?? null,
      isCurrent: workspaceId === ctx.currentWorkspaceId,
      rows,
      demandCount: rows.filter((r) => isDemandBand(r.band)).length,
      topBand: rows[0]?.band ?? "idle",
      lastOpened: openedAt(meta?.lastOpened),
    });
  }

  groups.sort((a, b) => {
    const byRecency = b.lastOpened - a.lastOpened;
    if (byRecency !== 0) return byRecency;

    // Equal recency means MRU has nothing left to say, so what settles the pair
    // is stable identity rather than agent state — a group must not change
    // place because a run inside it started or blocked.
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    // Workspace id last, so the comparator is a TRUE total order. Two projects
    // sharing a name is ordinary (a scratch and a project, or two checkouts),
    // and leaving them to `sort`'s arbitrary decision would make "the same
    // fleet opens in the same order" false exactly where it is hardest to see.
    if (a.workspaceId === b.workspaceId) return 0;
    return a.workspaceId < b.workspaceId ? -1 : 1;
  });

  return groups.map(({ lastOpened: _lastOpened, ...group }) => group);
}

/**
 * The bucket for runs the snapshot files under no worktree at all.
 *
 * Not "project root", which would be a claim the data cannot support: a run
 * loses its `worktreeId` both when it was launched with no worktree target
 * (a project-root launch, and every scratch run) and when the pty-host
 * positively proves the worktree belongs to another project. The two are
 * indistinguishable here, so the label states only what is known.
 */
const NO_WORKTREE_GROUP_ID = "wt:none";
const NO_WORKTREE_LABEL = "No worktree";

/**
 * A worktree's group id.
 *
 * Encoded rather than raw: the id is an absolute path, so it can carry spaces
 * and separators, and this string becomes a DOM id. `encodeURIComponent` is
 * reversible, which keeps two different worktrees from ever colliding into one
 * group the way a lossy sanitiser would.
 */
function worktreeGroupId(worktreeId: string): string {
  return `wt:${encodeURIComponent(worktreeId)}`;
}

function pathSegments(id: string): string[] {
  return id.split(/[/\\]+/).filter((segment) => segment.length > 0);
}

function trailingSegments(segments: readonly string[], depth: number): string {
  return segments.slice(Math.max(0, segments.length - depth)).join("/");
}

/**
 * The shortest trailing path fragment that tells each worktree from the others.
 *
 * A basename alone is the label worth reading — "feature-auth", not four levels
 * of checkout directory — but two worktrees in one project sharing a basename
 * is ordinary (`repos/a/feature-x` beside `repos/b/feature-x`), and two headers
 * reading the same word file their agents under a distinction the user cannot
 * see. Each colliding id grows one segment at a time until it stands alone, so
 * only the ids that actually collide pay for the disambiguation.
 *
 * Collisions are detected case-insensitively because the case-preserving
 * filesystems this runs on treat those paths as the same name to read, even
 * where they are distinct paths to open. Anything still ambiguous at full depth
 * differs only in case or above its own root, and falls back to the whole id —
 * the one string guaranteed to be unique, since the ids were map keys.
 */
function worktreeLabels(ids: readonly string[]): Map<string, string> {
  const segments = new Map(ids.map((id) => [id, pathSegments(id)]));
  const labels = new Map<string, string>();
  const unresolved = new Set(ids);

  let maxDepth = 1;
  for (const parts of segments.values()) maxDepth = Math.max(maxDepth, parts.length);

  for (let depth = 1; depth <= maxDepth && unresolved.size > 0; depth++) {
    const byLabel = new Map<string, string[]>();
    for (const id of unresolved) {
      const label = trailingSegments(segments.get(id) ?? [], depth) || id;
      const bucket = byLabel.get(label.toLowerCase());
      if (bucket) bucket.push(id);
      else byLabel.set(label.toLowerCase(), [id]);
    }
    for (const contenders of byLabel.values()) {
      const only = contenders.length === 1 ? contenders[0] : undefined;
      if (only === undefined) continue;
      labels.set(only, trailingSegments(segments.get(only) ?? [], depth) || only);
      unresolved.delete(only);
    }
  }

  for (const id of unresolved) labels.set(id, id);
  return labels;
}

/**
 * How many worktrees one project's runs are spread across, counting the runs
 * that have no worktree as a bucket of their own.
 */
function countWorktreeBuckets(runs: readonly Pick<FleetRunRow, "worktreeId">[]): number {
  const seen = new Set<string | null>();
  for (const run of runs) seen.add(run.worktreeId ?? null);
  return seen.size;
}

/**
 * Whether regrouping this project's runs by worktree would say anything new.
 *
 * The one rule behind both ways in: the header only offers the drill when this
 * is true, and the scoped shortcut falls back to the whole fleet when it is
 * false — so the affordance and the chord can never disagree about whether a
 * project has a worktree axis.
 *
 * Two buckets is the floor because one bucket regroups a project into a single
 * section holding the rows it already had. That is also, for free, the right
 * answer to the two cases the issue left open: a scratch workspace's runs never
 * carry a worktree id, and neither does a project being worked only in its own
 * root, so both fall back rather than opening a list that tells the user
 * nothing. A project with no runs at all has no buckets and falls back too,
 * which is what keeps an empty scoped list unreachable.
 *
 * Deliberately derived from the runs alone. The tempting alternative — compare
 * each `worktreeId` against the project's own path — joins two independently
 * minted spellings of the same directory, and the app has been bitten by that
 * before; there is no version of it that is worth a correct answer here.
 */
export function hasWorktreeAxis(runs: readonly Pick<FleetRunRow, "worktreeId">[]): boolean {
  return countWorktreeBuckets(runs) >= 2;
}

/**
 * One project's runs, re-cut along the worktree axis.
 *
 * Takes the built project group rather than the raw rows, so every derivation
 * the rows already carry — the acknowledgement-aware band, the composed title,
 * the chrome, the park-aware age — is reused rather than repeated. Bucketing
 * preserves array order, so each worktree's rows keep the ranking the project
 * gave them: worst band first, then oldest `since`, parked rows on their park.
 *
 * Group ORDER is severity-independent, exactly as it is across projects
 * (#11678). A worktree whose agent blocks does not climb over the others; it
 * turns its own header's chip on and stays where it was. Position is the
 * no-worktree bucket first, then the disambiguated label, then the full id so
 * the comparator is a true total order.
 *
 * The no-worktree bucket leads because it holds the project's root work, and
 * burying that under thirty alphabetically-sorted checkouts hides the runs
 * most likely to be the ones being worked right now.
 */
export function buildPilotWorktreeGroups(project: PilotProjectGroup): PilotWorktreeGroup[] {
  const byWorktree = new Map<string | null, PilotRow[]>();
  for (const row of project.rows) {
    const key = row.run.worktreeId ?? null;
    const bucket = byWorktree.get(key);
    if (bucket) bucket.push(row);
    else byWorktree.set(key, [row]);
  }

  const labels = worktreeLabels(
    [...byWorktree.keys()].filter((key): key is string => key !== null)
  );

  const groups: PilotWorktreeGroup[] = [];
  for (const [worktreeId, rows] of byWorktree) {
    groups.push(
      // Through `narrowGroup` rather than counting inline, so a worktree
      // header's demand chip is computed by the one function that already
      // recomputes rather than inherits — the discipline every narrowing pass
      // downstream relies on.
      narrowGroup<PilotWorktreeGroup>(
        {
          groupId: worktreeId === null ? NO_WORKTREE_GROUP_ID : worktreeGroupId(worktreeId),
          axis: "worktree",
          name: worktreeId === null ? NO_WORKTREE_LABEL : (labels.get(worktreeId) ?? worktreeId),
          worktreeId,
          rows,
          demandCount: 0,
          topBand: "idle",
        },
        rows
      )
    );
  }

  groups.sort((a, b) => {
    if ((a.worktreeId === null) !== (b.worktreeId === null)) return a.worktreeId === null ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    // Two worktrees can share a display label only when the disambiguator ran
    // out of path to distinguish them, so the id settles it — and settles it
    // the same way every time, which is what "the same fleet opens in the same
    // order" needs.
    const idA = a.worktreeId ?? "";
    const idB = b.worktreeId ?? "";
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });

  return groups;
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
export function filterPilotGroups<T extends PilotGroupCore>(
  groups: readonly T[],
  query: string
): T[] {
  const needle = query.trim();
  if (!needle) return [...groups];

  const out: T[] = [];
  for (const group of groups) {
    const projectMatches = isFilterMatch(needle, group.name);
    const rows = group.rows.filter(
      (row) =>
        projectMatches ||
        isFilterMatch(needle, row.title) ||
        (row.worktreeLabel !== null && isFilterMatch(needle, row.worktreeLabel)) ||
        // The agent's name is on the row as an icon rather than as text, but
        // "codex" is still a plausible thing to type when looking for one.
        isFilterMatch(needle, row.chrome.label) ||
        // A park note is the user's own words about the run — the string they
        // are most likely to remember it by.
        (row.parkNote !== null && isFilterMatch(needle, row.parkNote))
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
export type PilotBandFilter = "all" | "needs-you" | "working" | "finished" | "parked";

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
 *
 * "Parked" gets a segment of its own because it is the one band the user
 * authored: "show me everything I shelved, with my notes" is a real question,
 * and a run parked while waiting must be findable somewhere other than the
 * bottom of All.
 */
const BAND_FILTER_SETS: Record<Exclude<PilotBandFilter, "all">, ReadonlySet<FleetBand>> = {
  "needs-you": new Set<FleetBand>(["blocked", "needs-you"]),
  working: new Set<FleetBand>(["running"]),
  finished: new Set<FleetBand>(["review", "done"]),
  parked: new Set<FleetBand>(["parked"]),
};

/** The narrowing segments, in the order the bar renders them after All. */
export const PILOT_BAND_FILTERS: readonly Exclude<PilotBandFilter, "all">[] = [
  "needs-you",
  "working",
  "finished",
  "parked",
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
  parked: "Parked",
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
export function countPilotBands(groups: readonly PilotGroupCore[]): PilotBandFilterCounts {
  const counts: PilotBandFilterCounts = {
    all: 0,
    "needs-you": 0,
    working: 0,
    finished: 0,
    parked: 0,
  };
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
export function filterPilotBands<T extends PilotGroupCore>(
  groups: readonly T[],
  filter: PilotBandFilter
): T[] {
  if (filter === "all") return [...groups];

  const bands = BAND_FILTER_SETS[filter];
  const out: T[] = [];
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
export function summarizePilotGroups(groups: readonly PilotGroupCore[]): PilotSummary {
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
