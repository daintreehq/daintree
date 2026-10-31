import { rankSwitcherMatches, type SearchActivityKey } from "@/lib/projectSwitcherSearch";
import { compareProjectsByMode, type OtherProjectsSortMode } from "@/lib/projectSort";
import {
  groupBandKey,
  groupIdOfBandKey,
  isGroupBandKey,
  sortProjectGroups,
  type ProjectGroupBandKey,
} from "@/lib/projectGroupBands";
import { assistantNeedsAttention, classifyAssistantActivity } from "@/lib/projectAssistantActivity";
import { decayFrecencyScore, FRECENCY_COLD_START } from "@shared/utils/frecency";
import type { Project, Scratch } from "@shared/types";
import type { ProjectGroup } from "@shared/types/project";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import type { ProjectPresenceState } from "@shared/types/ipc/projectPresence";
import {
  PROJECT_SECTION_ORDER,
  type ProjectBandKey,
  type ProjectSectionKey,
  type ProjectSwitcherBrowseBand,
  type ProjectSwitcherProjectRow,
  type ProjectSwitcherRow,
  type SearchableProject,
  type SearchableScratch,
} from "./types";

/**
 * Rank of every band for one group list. Groups are filing, not activity: they
 * sit below every band that reports what is happening (attention, running,
 * snoozed) and above the residual Other band, which stays the catch-all for
 * whatever the user hasn't filed.
 */
export function buildBandRanks(
  groups: readonly ProjectGroup[]
): ReadonlyMap<ProjectBandKey, number> {
  const ranks = new Map<ProjectBandKey, number>();
  const otherIndex = PROJECT_SECTION_ORDER.indexOf("other");
  PROJECT_SECTION_ORDER.slice(0, otherIndex).forEach((key, index) => ranks.set(key, index));
  sortProjectGroups(groups).forEach((group, index) =>
    ranks.set(groupBandKey(group.id), otherIndex + index)
  );
  const offset = otherIndex + groups.length;
  PROJECT_SECTION_ORDER.slice(otherIndex).forEach((key, index) => ranks.set(key, offset + index));
  return ranks;
}

/** A band absent from the ranks (a group deleted mid-session) sorts with Other. */
export function bandRank(ranks: ReadonlyMap<ProjectBandKey, number>, key: ProjectBandKey): number {
  return ranks.get(key) ?? ranks.get("other") ?? 0;
}

/**
 * Whether a band is folded. Archived starts folded — it holds what the user
 * filed away, and showing it by default would undo the filing — so only an
 * explicit unfold opens it. Every other band starts open.
 */
export function isBandCollapsed(
  collapsedBands: Readonly<Record<string, boolean>>,
  key: ProjectBandKey
): boolean {
  return collapsedBands[key] ?? key === "archived";
}

/** Bands whose order the user picks: Other projects and every group. */
export function isSortableBand(key: ProjectBandKey): key is "other" | ProjectGroupBandKey {
  return key === "other" || isGroupBandKey(key);
}

/**
 * The Scratch band's key in the persisted collapse map. Scratch is not a
 * `ProjectSectionKey` — it renders outside `results` entirely — but it folds
 * away on the same affordance, so it shares the one preference record.
 */
export const PROJECT_SWITCHER_SCRATCH_BAND_KEY = "scratch";

/** Every band the switcher can fold away, project bands plus Scratch (#11943). */
export type ProjectSwitcherBandKey = ProjectSectionKey | typeof PROJECT_SWITCHER_SCRATCH_BAND_KEY;

/**
 * Header text per band.
 *
 * `current` went unlabelled while the keyboard cursor was the loudest thing on
 * the surface — position alone read as "you are here" next to an accent-painted
 * row. Once the cursor calmed to a neutral fill (#11686) the two stopped being
 * telling apart, and the band that says where you are is the one that has to
 * say so out loud (#11692). "Current project", not "Current": the word on its
 * own could be read as the current *selection*, which is the other signal.
 *
 * "Other projects", not "Recent" or "Frequent": the band is the residual
 * catch-all — frecency-ordered, holding never-opened projects and acknowledged
 * completions alike — so any label naming a sort order would be a lie the row
 * contents immediately expose. "Running" requires live agents; projects with
 * only bare processes fall through to Pinned/Other, where their status line
 * still reports the processes.
 */
export const PROJECT_SECTION_LABELS: Record<ProjectSectionKey, string> = {
  current: "Current project",
  attention: "Needs attention",
  pinned: "Pinned",
  running: "Running",
  // Its own band rather than a line inside Other, because the two mean opposite
  // things: Other is the residual nothing-happening catch-all, and a snoozed
  // project has live agents the user deliberately quieted. Sorting them
  // together is what made a project with three snoozed agents read as dormant.
  snoozed: "Snoozed",
  other: "Other projects",
  archived: "Archived",
  unavailable: "Unavailable",
};

/**
 * Rows the Other band needs before its sort control is worth advertising
 * (#11455). Below this there is too little order to be worth naming, so the
 * control would be chrome answering a question nobody asked. The preference
 * still applies — only the visible affordance is gated.
 */
export const OTHER_PROJECTS_SORT_CONTROL_MIN_ROWS = 4;

export function toProjectRow(project: SearchableProject): ProjectSwitcherProjectRow {
  return { kind: "project", ...project };
}

/**
 * Assign a project to its browse band. Actionable work first, then explicit
 * user intent, then non-actionable system activity, then habit:
 *
 * - `attention` is the action queue — agents blocked, waiting on input, or
 *   finished-and-unreviewed. A completed agent has handed responsibility back
 *   to the user, which outranks agents that are merely running.
 * - `pinned` sits above `running`: an explicit pin is a stronger signal than
 *   the operational fact that something is executing. A pinned running project
 *   stays in Pinned; its row still prints its running count.
 * - `running` requires live agents. Bare leftover processes are residency, not
 *   intent — those projects fall through to Pinned/Other.
 *
 * The assistant joins both ends of that without joining any tally (#11806). A
 * working assistant is live activity, so it earns Running the same way a
 * worker does; an assistant that is blocked or has been waiting since before
 * the user last looked is someone waiting on nobody, so it earns attention. An
 * assistant merely parked at its prompt earns neither — it still gets a status
 * line where it lands, exactly as a project with only bare processes does.
 *
 * Filing comes after all of that, because it is the user organising, not the
 * user asking for anything:
 *
 * - `archived` outranks a pin, a group and a snooze — filing a project away
 *   that then stayed in Pinned would read as the menu doing nothing. It yields
 *   only to what is actually happening: the current project, an ask, and live
 *   agents, which still lift it to Running (the row keeps saying "Archived").
 * - A group is explicit intent, so it sits beside the pin rather than below
 *   activity: a running or snoozed project stays in its group, in place, and
 *   the group's header reports the running ones when it is folded. Moving the
 *   website out of "Crisp Vector" the moment an agent started would break the
 *   one promise a group makes — that its projects are found in it.
 */
function sectionForProject(project: SearchableProject): ProjectBandKey {
  if (project.isActive) return "current";
  if (project.isMissing) return "unavailable";
  const assistant = classifyAssistantActivity(project);
  if (
    project.waitingAgentCount > 0 ||
    project.blockedAgentCount > 0 ||
    project.unacknowledgedCompletedAgentCount > 0 ||
    assistantNeedsAttention(assistant)
  ) {
    return "attention";
  }
  const isRunning = project.activeAgentCount > 0 || assistant === "working";
  if (project.isArchived) return isRunning ? "running" : "archived";
  if (project.isPinned) return "pinned";
  if (project.groupId) return groupBandKey(project.groupId);
  if (isRunning) return "running";
  // Last stop before the residual band. Below `pinned` and `running` for the
  // same reason a pinned running project stays in Pinned: snooze withdraws a
  // demand, it does not override an explicit pin or the fact that something is
  // still executing. Above `other` because a project holding snoozed agents is
  // not the dormant shell that band is for.
  if (project.snoozedAgentCount > 0) return "snoozed";
  return "other";
}

/**
 * Severity tier inside the attention band: blocked outranks waiting outranks
 * ready-for-review. Blocked agents may not restart on input; waiting agents
 * are stalled on the user; completed agents are done and can wait their turn.
 *
 * An escalated assistant is tiered by the same rule rather than given one of
 * its own: a blocked assistant is a blocked thing and an unseen wait is a
 * wait. Without this a project escalated purely by its assistant would fall to
 * the review tier and sort below completions it has nothing to do with.
 *
 * Consulted only once no worker is asking, because the status line resolves
 * the same contest that way. A row tiered as blocked by its assistant while
 * its line reads "Agent needs input" would be sorted by a reason it never
 * states — the row would look mis-ranked, and the explanation would be
 * invisible.
 */
export function attentionClass(
  project: Pick<
    SearchableProject,
    | "blockedAgentCount"
    | "waitingAgentCount"
    | "assistantState"
    | "assistantWaitingReason"
    | "assistantStateSince"
    | "isActive"
    | "lastOpened"
  >
): number {
  if (project.blockedAgentCount > 0) return 0;
  if (project.waitingAgentCount > 0) return 1;
  const assistant = classifyAssistantActivity(project);
  if (assistant === "blocked") return 0;
  if (assistant === "waiting-unseen") return 1;
  return 2;
}

/**
 * The transition that dates a row's wait, whichever kind of wait it has.
 *
 * Assistant-only rows have no `oldestWaitingSince`, so without this they would
 * all tie at infinity and fall through to an ordering that has nothing to do
 * with how long anyone has been stuck. A row with both falls to the worker's
 * clock, matching the tier and the line it will actually show.
 */
function waitOrderingSince(project: SearchableProject): number {
  // Gated on the counts, not on whether a timestamp arrived. A worker wait
  // whose transition was never recorded is still a worker wait — it is what
  // the tier and the line both name — so it has to keep the clock even though
  // it cannot supply one. Reading the timestamp first let such a row borrow the
  // assistant's, dating it by something it never mentions.
  if (project.waitingAgentCount > 0 || project.blockedAgentCount > 0) {
    return project.oldestWaitingSince ?? Number.POSITIVE_INFINITY;
  }
  if (!assistantNeedsAttention(classifyAssistantActivity(project))) {
    return Number.POSITIVE_INFINITY;
  }
  return project.assistantStateSince ?? Number.POSITIVE_INFINITY;
}

/**
 * The transition that orders a row inside the Running band. Falls back to the
 * assistant's own so assistant-only rows are ordered by how recently they came
 * alive, rather than tying at zero and sorting on unrelated recency.
 */
function runningOrderingSince(project: SearchableProject): number {
  if (project.latestWorkingSince !== undefined) return project.latestWorkingSince;
  return classifyAssistantActivity(project) === "working" ? (project.assistantStateSince ?? 0) : 0;
}

/**
 * Order within a band.
 *
 * - Attention: severity tier, then oldest-first within it — the agent stuck or
 *   finished longest is the one Enter lands on, and oldest-first review means
 *   a completion can't starve below a stream of newer ones.
 * - Pinned/Unavailable: alphabetical. Pinning is user-curated — reordering a
 *   curated set by a hidden score reads as rows moving on their own.
 * - Running: most work first, then freshest working transition.
 * - Other and every group: whichever order the user picked for that band
 *   (#11455); effective frecency by default, which is what Other has always
 *   done.
 * - Archived: alphabetical, like Pinned — it is a filing cabinet, and a
 *   cabinet ordered by a hidden score is one nobody can find anything in.
 * - Current: effective frecency, though it is a single row either way.
 *
 * Only the sortable bands read a preference. The other bands' orders are
 * decisions in their own right — a user asking for A-Z in the residual band is
 * not asking for their blocked agents to be alphabetised.
 */
export function compareWithinSection(
  a: SearchableProject,
  b: SearchableProject,
  sortModeFor: (band: "other" | ProjectGroupBandKey) => OtherProjectsSortMode
): number {
  const section = a.section;
  if (section === "attention") {
    const aClass = attentionClass(a);
    const bClass = attentionClass(b);
    if (aClass !== bClass) return aClass - bClass;
    if (aClass === 2) {
      const aOldest = a.oldestUnacknowledgedCompletionAt ?? Number.POSITIVE_INFINITY;
      const bOldest = b.oldestUnacknowledgedCompletionAt ?? Number.POSITIVE_INFINITY;
      if (aOldest !== bOldest) return aOldest - bOldest;
      if (a.unacknowledgedCompletedAgentCount !== b.unacknowledgedCompletedAgentCount) {
        return b.unacknowledgedCompletedAgentCount - a.unacknowledgedCompletedAgentCount;
      }
    } else {
      if (a.blockedAgentCount !== b.blockedAgentCount) {
        return b.blockedAgentCount - a.blockedAgentCount;
      }
      const aSince = waitOrderingSince(a);
      const bSince = waitOrderingSince(b);
      if (aSince !== bSince) return aSince - bSince;
      if (a.waitingAgentCount !== b.waitingAgentCount) {
        return b.waitingAgentCount - a.waitingAgentCount;
      }
    }
  } else if (section === "pinned" || section === "unavailable" || section === "archived") {
    // Alphabetical primary AND the only tie-breaks: falling through to
    // lastOpened would quietly reintroduce the adaptive reordering the
    // alphabetical choice exists to avoid.
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  } else if (section === "running") {
    if (a.activeAgentCount !== b.activeAgentCount) {
      return b.activeAgentCount - a.activeAgentCount;
    }
    const aWorking = runningOrderingSince(a);
    const bWorking = runningOrderingSince(b);
    if (aWorking !== bWorking) return bWorking - aWorking;
  } else if (isSortableBand(section)) {
    // `frecencyScore` is already read-time decayed here (see `searchableProjects`),
    // so it is safe to hand straight to the shared comparator.
    return compareProjectsByMode(a, b, sortModeFor(section));
  } else if (a.frecencyScore !== b.frecencyScore) {
    return b.frecencyScore - a.frecencyScore;
  }
  if (a.lastOpened !== b.lastOpened) return b.lastOpened - a.lastOpened;
  return a.name.localeCompare(b.name);
}

/**
 * Builds the palette's one array — the rows that render AND the rows the arrow
 * keys walk. Browse is section-ordered so the component can slice it into bands
 * without ever building a second array; search is pure rank order across every
 * registered project.
 *
 * There is no result cap and no per-mode scoping. Both were real dead ends: the
 * cap made project 16 unreachable without recalling its name, and scoping modal
 * browse to live projects meant the same keystroke showed a different universe
 * than the title-bar dropdown, silently switching to the full set the moment a
 * character was typed.
 *
 * `isSearching` tracks the live query while `rankQuery` is the deferred one, so
 * the browse-to-search transition doesn't flash "No workspaces match" over the
 * previous list on the first keystroke.
 *
 * Scratches join the ranking, and only the ranking (#11466). In browse they are
 * left to the pinned section at the bottom, where create and delete-all live and
 * spatial predictability is worth more than relevance.
 *
 * They join on `rankQuery`, not on the live one, so the frame where the live
 * query has outrun the deferred one is still pure browse. The pinned section
 * keys off the same signal ({@link UseProjectSwitcherPaletteReturn.isRankedSearch}),
 * so for that frame the scratches are simply still down there — never listed
 * twice, and never briefly absent from both places.
 *
 * `activityKeys` is the session's frozen activity snapshot, which search ranks
 * by within each tier of name-match quality. Browse ignores it: its own freeze
 * already holds that order.
 */
/**
 * `visibleBrowseRows` omits the bands the user folded away; `allBrowseRows`
 * does not. Searching uses the unfolded list on BOTH its paths — not just the
 * ranked one. The ranking runs on the deferred query, so a non-empty box spends
 * a commit with no ranked rows yet, and serving the filtered browse list for
 * that frame would blink a matching project out of existence on the way in.
 */
export function buildResults(
  visibleBrowseRows: ProjectSwitcherRow[],
  allBrowseRows: ProjectSwitcherRow[],
  browseOrdered: SearchableProject[],
  scratches: SearchableScratch[],
  rankQuery: string,
  isSearching: boolean,
  activityKeys: ReadonlyMap<string, SearchActivityKey> | null
): ProjectSwitcherRow[] {
  if (isSearching) {
    if (rankQuery.trim()) {
      return rankSwitcherMatches(rankQuery, browseOrdered, scratches, activityKeys);
    }
    return allBrowseRows;
  }
  return visibleBrowseRows;
}

export interface SearchableProjectContext {
  currentProjectId: string | undefined;
  displayPathById: ReadonlyMap<string, string>;
  presenceByProjectId: {
    otherWindows: ReadonlyMap<string, ProjectPresenceState>;
    thisWindow: ReadonlyMap<string, ProjectPresenceState>;
  };
  /**
   * One `now` for a whole build keeps every row's effective score on the same
   * clock. Ordering between untouched projects is invariant as time passes (all
   * scores decay by the same factor), so computing at build time rather than on
   * a tick is exact, not an approximation.
   */
  frecencyNow: number;
  /** Live groups by id, so a row can only claim a group that still exists. */
  groupsById: ReadonlyMap<string, ProjectGroup>;
}

export function toSearchableProject(
  p: Project,
  stats: ProjectStatusMap[string] | undefined,
  context: SearchableProjectContext
): SearchableProject {
  const isActive = p.id === context.currentProjectId;
  const isMissing = p.status === "missing";
  const hasProcesses = (stats?.processCount ?? 0) > 0;
  // A scratch switch clears the project pointer without demoting or
  // broadcasting the row it left, so the pre-scratch project reaches us still
  // marked "active" while nothing is active. Untreated it is neither active
  // nor background — main makes the same repair on its next read once the
  // canonical pointer is null (#11085). View-relative by design: a project
  // another window owns isn't this view's either.
  const isStaleActive = !isActive && p.status === "active";
  const isBackground =
    p.status === "background" || isStaleActive || (!isActive && !isMissing && hasProcesses);
  const group = p.groupId ? context.groupsById.get(p.groupId) : undefined;

  const project: SearchableProject = {
    id: p.id,
    name: p.name,
    path: p.path,
    emoji: p.emoji || "🌲",
    color: p.color,
    lastOpened: p.lastOpened ?? 0,
    status: p.status,
    autoParkedAt: p.autoParkedAt,
    neverAutoSleep: p.neverAutoSleep,
    // Passed through as-is. Coercing an absent count to 0 here would turn
    // "not computed yet" into "restores nothing" — the one distinction the
    // dot depends on.
    resumableAgentCount: p.resumableAgentCount,
    isActive,
    isBackground,
    isMissing,
    isPinned: p.pinned ?? false,
    isArchived: p.archivedAt !== undefined,
    groupId: group?.id,
    groupName: group?.name,
    openInOtherWindow: isActive ? undefined : context.presenceByProjectId.otherWindows.get(p.id),
    isOpenInThisWindow: context.presenceByProjectId.thisWindow.has(p.id),
    isCachedInThisWindow: context.presenceByProjectId.thisWindow.get(p.id) === "cached",
    frecencyScore: decayFrecencyScore(
      p.frecencyScore ?? FRECENCY_COLD_START,
      p.lastAccessedAt ?? 0,
      context.frecencyNow
    ),
    activeAgentCount: stats?.activeAgentCount ?? 0,
    waitingAgentCount: stats?.waitingAgentCount ?? 0,
    blockedAgentCount: stats?.blockedAgentCount ?? 0,
    oldestWaitingSince: stats?.oldestWaitingSince,
    completedAgentCount: stats?.completedAgentCount ?? 0,
    unacknowledgedCompletedAgentCount: stats?.unacknowledgedCompletedAgentCount ?? 0,
    oldestUnacknowledgedCompletionAt: stats?.oldestUnacknowledgedCompletionAt,
    latestUnacknowledgedCompletionAt: stats?.latestUnacknowledgedCompletionAt,
    latestCompletionAt: stats?.latestCompletionAt,
    latestWorkingSince: stats?.latestWorkingSince,
    snoozedAgentCount: stats?.snoozedAgentCount ?? 0,
    nextSnoozeWakeAt: stats?.nextSnoozeWakeAt,
    processCount: stats?.processCount ?? 0,
    assistantState: stats?.assistantState,
    assistantWaitingReason: stats?.assistantWaitingReason,
    assistantStateSince: stats?.assistantStateSince,
    displayPath: context.displayPathById.get(p.id) ?? p.path,
    section: "other",
  };
  project.section = sectionForProject(project);
  return project;
}

export function buildSearchableProjects(
  projects: Project[],
  stats: ProjectStatusMap,
  context: SearchableProjectContext
): SearchableProject[] {
  return projects.map((p) => toSearchableProject(p, stats[p.id], context));
}

export function sortBrowseOrder(
  projects: SearchableProject[],
  sortModeFor: (band: "other" | ProjectGroupBandKey) => OtherProjectsSortMode,
  bandRanks: ReadonlyMap<ProjectBandKey, number>
): SearchableProject[] {
  return [...projects].sort((a, b) => {
    if (a.section !== b.section) {
      return bandRank(bandRanks, a.section) - bandRank(bandRanks, b.section);
    }
    return compareWithinSection(a, b, sortModeFor);
  });
}

/**
 * The order each sortable band asks for: Other reads the preference, a group
 * its own mode. A group that has gone away falls back to Other's mode — its
 * rows are about to re-band there anyway.
 */
export function makeSortModeFor(
  otherProjectsSortMode: OtherProjectsSortMode,
  groupsById: ReadonlyMap<string, ProjectGroup>
): (band: "other" | ProjectGroupBandKey) => OtherProjectsSortMode {
  return (band) =>
    band === "other"
      ? otherProjectsSortMode
      : (groupsById.get(groupIdOfBandKey(band))?.sortMode ?? otherProjectsSortMode);
}

export function buildScratchResults(
  scratches: Scratch[],
  currentScratchId: string | undefined,
  projectStats: ProjectStatusMap
): SearchableScratch[] {
  const list: SearchableScratch[] = scratches.map((s: Scratch) => {
    // Scratch terminals carry the scratch id as their `projectId`, so the one
    // status map covers both kinds and the join is the same lookup projects
    // do (#11518).
    const stats = projectStats[s.id];
    return {
      id: s.id,
      name: s.name,
      path: s.path,
      createdAt: s.createdAt,
      lastOpened: s.lastOpened,
      // Passed through as-is, never `?? 0`: coercing an absent count to 0
      // here would turn "not computed yet" into "restores nothing".
      resumableAgentCount: s.resumableAgentCount,
      isActive: currentScratchId === s.id,
      activeAgentCount: stats?.activeAgentCount ?? 0,
      waitingAgentCount: stats?.waitingAgentCount ?? 0,
      blockedAgentCount: stats?.blockedAgentCount ?? 0,
      oldestWaitingSince: stats?.oldestWaitingSince,
      completedAgentCount: stats?.completedAgentCount ?? 0,
      unacknowledgedCompletedAgentCount: stats?.unacknowledgedCompletedAgentCount ?? 0,
      oldestUnacknowledgedCompletionAt: stats?.oldestUnacknowledgedCompletionAt,
      latestUnacknowledgedCompletionAt: stats?.latestUnacknowledgedCompletionAt,
      latestCompletionAt: stats?.latestCompletionAt,
      snoozedAgentCount: stats?.snoozedAgentCount ?? 0,
      nextSnoozeWakeAt: stats?.nextSnoozeWakeAt,
      processCount: stats?.processCount ?? 0,
      // A scratch can host an assistant too — the session is provisioned
      // against an opaque workspace id — so it gets the same status line. It
      // never gets a band: scratches live in the pinned section regardless.
      assistantState: stats?.assistantState,
      assistantWaitingReason: stats?.assistantWaitingReason,
      assistantStateSince: stats?.assistantStateSince,
    };
  });
  list.sort((a, b) => b.lastOpened - a.lastOpened);
  return list;
}

/**
 * Every browse band in render order, derived from the COMPLETE ordered list
 * before any collapse filtering — a folded band still has to say it exists and
 * how much it is holding.
 *
 * Every group gets a band even when no row lands in it — one just created, or
 * one whose every project is lifted above by live work — so the header that
 * names it, folds it and reorders it never disappears out from under the user.
 * Its rows say why it is empty.
 */
export function buildBrowseBands(
  browseOrdered: SearchableProject[],
  collapsedBands: Readonly<Record<string, boolean>>,
  groupsById: ReadonlyMap<string, ProjectGroup>,
  projectGroups: readonly ProjectGroup[],
  bandRanks: ReadonlyMap<ProjectBandKey, number>
): ProjectSwitcherBrowseBand[] {
  const bands: ProjectSwitcherBrowseBand[] = [];
  const bandFor = (key: ProjectBandKey): ProjectSwitcherBrowseBand => {
    const group = isGroupBandKey(key) ? groupsById.get(groupIdOfBandKey(key)) : undefined;
    return {
      key,
      label: group ? group.name : isGroupBandKey(key) ? "" : PROJECT_SECTION_LABELS[key],
      itemCount: 0,
      collapsed: isBandCollapsed(collapsedBands, key),
      group,
      liftedCount: 0,
      activeAgentCount: 0,
    };
  };
  for (const project of browseOrdered) {
    let band = bands.at(-1);
    if (!band || band.key !== project.section) {
      band = bandFor(project.section);
      bands.push(band);
    }
    band.itemCount += 1;
    band.activeAgentCount = (band.activeAgentCount ?? 0) + project.activeAgentCount;
    if (classifyAssistantActivity(project) === "working") {
      band.workingAssistantCount = (band.workingAssistantCount ?? 0) + 1;
    }
  }
  const present = new Set(bands.map((band) => band.key));
  for (const group of sortProjectGroups(projectGroups)) {
    const key = groupBandKey(group.id);
    if (present.has(key)) continue;
    const rank = bandRank(bandRanks, key);
    const at = bands.findIndex((band) => bandRank(bandRanks, band.key) > rank);
    bands.splice(at === -1 ? bands.length : at, 0, bandFor(key));
  }
  // Members a group can't show because live work or a pin holds them above.
  // Archived members are not counted: they were filed away, not lifted. Nor
  // is anything in a band drawn below the group (Unavailable): the hint
  // says "shown above", and it must not point the user the wrong way.
  for (const project of browseOrdered) {
    if (!project.groupId || project.isArchived) continue;
    const key = groupBandKey(project.groupId);
    if (project.section === key) continue;
    if (bandRank(bandRanks, project.section) > bandRank(bandRanks, key)) continue;
    const band = bands.find((candidate) => candidate.key === key);
    if (band) band.liftedCount = (band.liftedCount ?? 0) + 1;
  }
  return bands;
}
