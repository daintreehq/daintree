import { useState, useCallback, useMemo, useEffect, useRef, useDeferredValue } from "react";
import {
  computeSearchActivityKey,
  rankSwitcherMatches,
  type SearchActivityKey,
} from "@/lib/projectSwitcherSearch";
import { buildDisplayPaths } from "@/lib/projectDisplayPath";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useScratchStore } from "@/store/scratchStore";
import { usePaletteStore } from "@/store/paletteStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { compareProjectsByMode, type OtherProjectsSortMode } from "@/lib/projectSort";
import { useProjectRelocationStore } from "@/store/projectRelocationStore";
import { notify } from "@/lib/notify";
import { closeAndAnnounce } from "@/lib/accessibility";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { logError } from "@/utils/logger";
import type { Project, Scratch } from "@shared/types";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import { assistantNeedsAttention, classifyAssistantActivity } from "@/lib/projectAssistantActivity";
import { decayFrecencyScore, FRECENCY_COLD_START } from "@shared/utils/frecency";
import { projectClient, scratchClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export type ProjectSwitcherMode = "modal" | "dropdown";

/**
 * The agent-activity fields a switcher row's status line is derived from —
 * exactly the subset both kinds of workspace share.
 *
 * Extracted so `getWorkspaceActivityStatus` can serve projects and scratches
 * without either widening to the other's shape: a structural parameter keeps
 * the two view-models disjoint while letting one formatter read both (#11518).
 */
export interface WorkspaceRowStatusFields {
  activeAgentCount: number;
  waitingAgentCount: number;
  /** Waiting agents blocked on an error — a subset of `waitingAgentCount`. */
  blockedAgentCount: number;
  /** Epoch ms the oldest current wait began, absent when nothing is waiting. */
  oldestWaitingSince?: number;
  /** Agents settled in `completed` — finished work awaiting review. */
  completedAgentCount: number;
  /** Completions the user hasn't seen yet — a subset of `completedAgentCount`. */
  unacknowledgedCompletedAgentCount: number;
  /** Earliest unseen completion, absent when everything was seen. */
  oldestUnacknowledgedCompletionAt?: number;
  /** Latest unseen completion, absent when everything was seen. */
  latestUnacknowledgedCompletionAt?: number;
  /** Latest completion regardless of acknowledgement, absent when none. */
  latestCompletionAt?: number;
  /**
   * Agents the user snoozed. NOT a subset of the counts above — a snoozed run
   * still counts as active or completed, but is withheld from the waiting,
   * blocked and unacknowledged tallies that make a project read as demanding.
   */
  snoozedAgentCount: number;
  /**
   * Earliest wake time among snoozed agents, absent when nothing is snoozed or
   * when every snooze is the unlimited option.
   */
  nextSnoozeWakeAt?: number;
  processCount: number;
  /**
   * What the live Daintree Assistant is doing, absent when there is no live
   * assistant here (#11806). Raw state, not a verdict — `classifyAssistantActivity`
   * is the one place that decides what it means, so the band, the ordering and
   * the status line cannot disagree about it.
   *
   * Never a member of the counts above. The assistant is not a run the user
   * launched, and folding it in would make every worker tally a lie.
   */
  assistantState?: AgentState;
  /** Why the assistant is waiting; only ever set alongside a `waiting` state. */
  assistantWaitingReason?: WaitingReason;
  /** The assistant's transition into its current state, absent when unrecorded. */
  assistantStateSince?: number;
  /**
   * When the user last had this workspace as their current one — stamped both
   * on arrival and on departure, so it dates the last time they actually had
   * it on screen. Shared by both kinds because both can host an assistant, and
   * it is what decides whether a wait has gone unseen.
   */
  lastOpened: number;
  isActive: boolean;
}

/** Lightweight searchable scratch view-model for the palette section. */
export interface SearchableScratch extends WorkspaceRowStatusFields {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  /**
   * How many saved agent panels this scratch would restore if opened (#11821).
   * Main derives it from the persisted state, so the row draws its dot without
   * reading anything. Absent means not yet computed — distinct from a known 0,
   * which is an answer.
   */
  resumableAgentCount?: number;
}

/**
 * Frozen targets for a pending "delete all scratches" confirm.
 *
 * Deliberately excludes the live fields (`isActive`, `lastOpened`): the run needs
 * only the ids it agreed to delete plus the names it may have to name in a failure
 * summary. Re-deriving from the reactive `scratches` array mid-run would shrink the
 * list as each removal lands, and would silently enrol a scratch created after the
 * user read the count (lesson #4729).
 */
export type DeleteAllScratchesSnapshot = ReadonlyArray<
  Readonly<Pick<SearchableScratch, "id" | "name">>
>;

/**
 * Target of a pending single-scratch delete, frozen when the user opened the
 * confirmation.
 *
 * Frozen for the same reason as the bulk snapshot: the row can be removed under
 * the open dialog by a `scratch:removed` push from another window, and the run
 * still has to name what the user agreed to.
 */
export type DeleteScratchTarget = Readonly<Pick<SearchableScratch, "id" | "name" | "path">>;

/**
 * Band a project renders under in browse. Ordered exactly as the sections
 * appear, so the flat `results` array can be sorted by section index and the
 * component can emit a header wherever the key changes — sections stay a *view*
 * over the one array the arrow keys walk, never a second, narrower list
 * (#11071).
 */
export const PROJECT_SECTION_ORDER = [
  "current",
  "attention",
  "pinned",
  "running",
  "snoozed",
  "other",
  "unavailable",
] as const;

export type ProjectSectionKey = (typeof PROJECT_SECTION_ORDER)[number];

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
  unavailable: "Unavailable",
};

/**
 * Rows the Other band needs before its sort control is worth advertising
 * (#11455). Below this there is too little order to be worth naming, so the
 * control would be chrome answering a question nobody asked. The preference
 * still applies — only the visible affordance is gated.
 */
export const OTHER_PROJECTS_SORT_CONTROL_MIN_ROWS = 4;

export interface SearchableProject extends WorkspaceRowStatusFields {
  id: string;
  name: string;
  path: string;
  emoji: string;
  color?: string;
  status: Project["status"];
  /** Set when the project was auto-closed by the background-idle sweep (#10830). */
  autoParkedAt?: number;
  /**
   * How many saved agent panels this project would restore if opened (#11801).
   * Main derives it from the persisted state, so the row draws its dot without
   * reading anything. Absent means not yet computed — distinct from a known 0,
   * which is an answer.
   */
  resumableAgentCount?: number;
  isBackground: boolean;
  isMissing: boolean;
  isPinned: boolean;
  /**
   * Effective (read-time decayed) frecency, computed against one shared `now`
   * per list build — never the raw persisted snapshot.
   */
  frecencyScore: number;
  /**
   * Latest transition into `working`, absent when nothing is working. Project
   * only: it orders rows inside the Running band, which scratches never enter.
   */
  latestWorkingSince?: number;
  displayPath: string;
  /** Browse band. Not meaningful while searching, where rank order wins. */
  section: ProjectSectionKey;
}

/**
 * A row of the palette's one list, tagged with what it actually is.
 *
 * Flattened rather than wrapped (`{ kind, project }`) so the fields both kinds
 * share — `id`, `name`, `isActive` — stay reachable at the sites that only care
 * about identity: the derived index, the arrow-key step, `aria-activedescendant`
 * and the scroll-into-view query. Only the row renderer and the commit dispatch
 * need to narrow.
 *
 * Scratches are NOT synthesized into a `SearchableProject` with a flag. Sharing
 * the shape would make every project-only path — the status line, "Pin project",
 * Sleep, ⌘⌫ remove — type-reachable with a scratch id behind it.
 */
export type ProjectSwitcherProjectRow = { kind: "project" } & SearchableProject;
export type ProjectSwitcherScratchRow = { kind: "scratch" } & SearchableScratch;
export type ProjectSwitcherRow = ProjectSwitcherProjectRow | ProjectSwitcherScratchRow;

function toProjectRow(project: SearchableProject): ProjectSwitcherProjectRow {
  return { kind: "project", ...project };
}

export interface UseProjectSwitcherPaletteReturn {
  isOpen: boolean;
  mode: ProjectSwitcherMode;
  query: string;
  /**
   * The rows the palette renders, in render order — and the only array
   * `selectedIndex` may be read against. Every mode lists every registered
   * project: browse is section-ordered (see {@link PROJECT_SECTION_ORDER}) and
   * search is rank-ordered, but neither is scoped or capped.
   *
   * Browse rows are all projects; the scratches belong to the pinned section
   * below the list. Search rows are mixed, so a scratch is reachable by name
   * from the keyboard (#11466) — narrow on `kind` before touching anything a
   * scratch doesn't have.
   */
  results: ProjectSwitcherRow[];
  /** True while `deferredQuery` has not yet caught up to `query` — the results shown are from the previous query. */
  isFiltering: boolean;
  /**
   * True exactly while {@link results} is the ranked list, which is the only
   * time it carries scratches. Trails `query` by a commit, because the ranking
   * runs on the deferred query — so a surface that also renders scratches
   * elsewhere must hide them on THIS, not on a non-empty query, or they would
   * belong to neither list for a frame.
   */
  isRankedSearch: boolean;
  /**
   * The currently active project as a `SearchableProject`, with stats and
   * pin/missing flags enriched. Decoupled from `results` so callers (e.g. the
   * toolbar pill context menu) can read pin/processCount/etc. even when the
   * active project is filtered out by the current `query`.
   */
  activeProject: SearchableProject | null;
  /**
   * Index into {@link results}. Always in range whenever `results` is
   * non-empty, so `results[selectedIndex]` is guaranteed to be a rendered row.
   */
  selectedIndex: number;
  open: (mode?: ProjectSwitcherMode) => void;
  close: () => void;
  toggle: (mode?: ProjectSwitcherMode) => void;
  setQuery: (query: string) => void;
  selectPrevious: () => void;
  selectNext: () => void;
  selectProject: (project: SearchableProject) => void;
  /**
   * Commits a row of {@link results}, dispatching on its kind. The palette's
   * primary select handler — a surface that renders `results` must use this
   * rather than `selectProject`, which cannot accept a scratch row.
   */
  selectRow: (row: ProjectSwitcherRow) => void;
  /**
   * Schedule a 150ms trailing-edge hover prefetch that primes the
   * main-process hydrate cache for `projectId`. Mouse-only — touch and pen
   * pointers are ignored. Does nothing for the currently active project or
   * for projects flagged as missing.
   */
  onHoverProject: (projectId: string, pointerType: string) => void;
  /** Cancel any pending hover prefetch for `projectId`. */
  onHoverProjectEnd: (pointerType: string) => void;
  confirmSelection: () => void;
  addProject: () => Promise<void>;
  cloneRepo: () => void;
  stopProject: (projectId: string) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  /**
   * Reclaim a background project's resident memory (renderer + PTYs + workspace
   * host) while keeping it in the list as `closed` for a non-destructive
   * reopen. Shows a confirm dialog when the project has live processes, runs
   * silently otherwise. No-op (with a toast) for the active project.
   */
  sleepProject: (projectId: string) => Promise<void>;
  /** Missing-project recovery: open the relocation dialog in reattach mode. */
  locateProject: (projectId: string) => void;
  /** Healthy-project "Move or rename": open the relocation dialog in move mode. */
  moveOrRenameProject: (projectId: string) => void;
  togglePinProject: (projectId: string) => Promise<void>;
  /**
   * Write the project's absolute path to the clipboard and surface a transient
   * "Path copied" toast. Used by the Copy path context menu action in all
   * project picker render sites (sidebar dropdown, toolbar dropdown, modal).
   */
  copyPath: (path: string) => void;
  stopConfirmProjectId: string | null;
  setStopConfirmProjectId: (projectId: string | null) => void;
  confirmStopProject: () => Promise<void>;
  isStoppingProject: boolean;
  removeConfirmProject: SearchableProject | null;
  setRemoveConfirmProject: (project: SearchableProject | null) => void;
  confirmRemoveProject: () => Promise<void>;
  isRemovingProject: boolean;
  /**
   * Frozen snapshot of the project pending a Sleep confirmation —
   * captured at menu-select time so the dialog's process/agent counts don't
   * drift if agents finish while the dialog is open (lesson #8725). Null when
   * no confirm is pending (D0 path runs without it).
   */
  sleepConfirmProject: SearchableProject | null;
  setSleepConfirmProject: (project: SearchableProject | null) => void;
  confirmSleep: () => Promise<void>;
  isSleepingProject: boolean;
  backgroundWaitingCount: number;
  /**
   * Agent totals across every non-active project, uncapped and independent of
   * `mode`/`query`. Kept off `results` on purpose: that array is scoped for
   * presentation, and a project whose agent counts have landed before its
   * process count (the two arrive from separate `ProjectStatsService` calls)
   * would otherwise drop out of the toolbar badge for a beat.
   */
  nonActiveAgentCounts: {
    activeAgentCount: number;
    waitingAgentCount: number;
    /**
     * Non-active projects with at least one WAITING agent — the badge's
     * number. Deliberately narrower than the switcher's attention band, which
     * also holds unreviewed completions: the badge is an interruption signal,
     * and nagging the tray for every finished agent would train it away.
     */
    waitingProjectCount: number;
  };
  /**
   * What is still executing across EVERY workspace — projects and scratches,
   * the current one included — for the palette header's "is it safe to look
   * away?" line (#11832). Unfiltered by the search query on purpose.
   */
  fleetLiveness: {
    /** Agents the user launched, across all workspaces. Assistants never counted here. */
    runningAgentCount: number;
    /** Workspaces whose assistant is mid-task — a separate tally, not an agent. */
    workingAssistantCount: number;
  };
  /** Scratch (one-off agent workspace) view-models, sorted by lastOpened desc. */
  scratchResults: SearchableScratch[];
  /**
   * Create and immediately switch to a new scratch. Closes the palette on success.
   * An empty or omitted name falls back to the main-process default.
   */
  createScratch: (name?: string) => Promise<void>;
  /** Switch to an existing scratch. Closes the palette on success. */
  selectScratch: (scratch: SearchableScratch) => Promise<void>;
  /**
   * Target of a pending single-scratch delete confirmation, frozen when the
   * user opened it, or null when no confirm is open.
   */
  deleteScratchConfirm: DeleteScratchTarget | null;
  /** Open the single-scratch delete confirmation. A no-op for an unknown id. */
  requestDeleteScratch: (scratchId: string) => void;
  dismissDeleteScratchConfirm: () => void;
  /** Delete the frozen target (folder + DB row). Announces the outcome. */
  confirmDeleteScratch: () => Promise<void>;
  isDeletingScratch: boolean;
  /**
   * Targets of a pending "delete all scratches" confirmation, frozen when the
   * user opened it, or null when no confirm is open.
   */
  deleteAllScratchesConfirm: DeleteAllScratchesSnapshot | null;
  /** Open the bulk-delete confirmation. A no-op when there are no scratches. */
  requestDeleteAllScratches: () => void;
  dismissDeleteAllScratchesConfirm: () => void;
  /** Delete every scratch in the frozen snapshot. Emits one summary notification. */
  confirmDeleteAllScratches: () => Promise<void>;
  isDeletingAllScratches: boolean;
  /** Rename a scratch in place. Leaves the palette open. A blank name is a no-op. */
  renameScratch: (scratchId: string, name: string) => Promise<void>;
  /**
   * Open the directory picker and save the scratch as a project. On success
   * exposes a follow-up confirmation via {@link saveAsProjectConfirm} so the
   * user can optionally delete the original scratch.
   */
  saveAsProject: (scratchId: string) => Promise<void>;
  /**
   * Pending "Delete original?" confirmation surfaced after a successful
   * Save-as-Project copy. Cleared by `confirmDeleteOriginalScratch` or
   * `dismissSaveAsProjectConfirm`.
   */
  saveAsProjectConfirm: { scratch: SearchableScratch; project: Project } | null;
  dismissSaveAsProjectConfirm: () => void;
  confirmDeleteOriginalScratch: () => Promise<void>;
  isDeletingOriginalScratch: boolean;
}

/**
 * Whether this project's BAND is a guess until main reports stats for it.
 *
 * The active row is banded `current` and a missing one `unavailable` without
 * consulting stats, so neither says anything about hydration — they are excluded
 * from the question, never from the freeze itself.
 *
 * Browse only. Search bands nothing and reads an active row's activity like any
 * other's, so it asks a wider question — see {@link countSearchRowsAwaitingStats}.
 */
function isStatsSensitive(project: SearchableProject): boolean {
  return !project.isActive && !project.isMissing;
}

/**
 * How many rows search ranks, and how many of those main has not reported on.
 *
 * Wider than {@link isStatsSensitive} on both axes, because search ranks every
 * row on what it is doing: the active project and the unavailable one included,
 * and scratches alongside projects (#11466). Gating search on browse's
 * project-only question would strand a session that has scratches but no
 * projects — with nothing to ask about it would read as hydrated at once, and
 * freeze every scratch as quiet for the rest of the session.
 *
 * Safe to ask about every row because the bulk pull seeds an entry for each id
 * it is handed, present or absent, and it is handed both kinds
 * (`projectAgentCounts`). A row stays unkeyed only if the pull never lands, and
 * a session that never hydrates simply behaves as it did before any of this —
 * the same floor browse's regroup has.
 */
function countSearchRowsAwaitingStats(
  projects: SearchableProject[],
  scratches: SearchableScratch[],
  stats: ProjectStatusMap
): { total: number; unkeyed: number } {
  let unkeyed = 0;
  for (const project of projects) if (stats[project.id] === undefined) unkeyed += 1;
  for (const scratch of scratches) if (stats[scratch.id] === undefined) unkeyed += 1;
  return { total: projects.length + scratches.length, unkeyed };
}

interface FrozenLayout {
  order: string[];
  sections: Map<string, ProjectSectionKey>;
  /**
   * True while this freeze is still a guess: it was taken before any stats
   * reached the view, so every band in it is a placeholder. Cleared by the one
   * regroup that resolves the session.
   */
  isProvisional: boolean;
}

/**
 * Search's own freeze: what every workspace was asking of the user when the
 * palette opened, keyed by row id (#11861).
 *
 * Separate from {@link FrozenLayout} rather than folded into it, because that
 * one answers a different question. It holds browse's ORDER and BAND membership
 * — current/pinned/snoozed policy search has no use for — and it covers projects
 * only, while search ranks scratches in the same list (#11466).
 *
 * What is frozen is the SORT KEY, never the row. The view-models stay live, so a
 * promoted row's status line keeps counting up while the row itself holds still.
 */
interface FrozenSearchActivity {
  keys: Map<string, SearchActivityKey>;
  /** Same meaning as {@link FrozenLayout.isProvisional}, resolved on the same commit. */
  isProvisional: boolean;
}

/**
 * `layout` with its Other rows re-sorted for `mode` IN THEIR EXISTING SLOTS,
 * plus those rows' new sequence. Null when the band holds fewer than two rows,
 * where no order is observable.
 *
 * Rewriting slots rather than rebuilding from the live order is the whole
 * point: a blanket recapture would also adopt live BAND membership, so a
 * project whose agent finished while the palette was open would jump out of
 * Needs attention the moment the user touched an unrelated sort control. The
 * user changed one band's order; nothing else may move.
 *
 * Pure, and takes the layout as an argument, so the caller can run it inside a
 * `setFrozenLayout` updater against whatever layout React has actually applied.
 */
function resortOtherBand(
  layout: FrozenLayout,
  live: Map<string, SearchableProject>,
  mode: OtherProjectsSortMode
): { order: string[]; ids: string[] } | null {
  const slots: number[] = [];
  const ids: string[] = [];
  layout.order.forEach((id, index) => {
    if (layout.sections.get(id) === "other") {
      slots.push(index);
      ids.push(id);
    }
  });
  if (ids.length < 2) return null;

  const resorted = [...ids].sort((a, b) => {
    const projectA = live.get(a);
    const projectB = live.get(b);
    // A row whose project has gone away is dropped downstream anyway; order it
    // last so this stays a total order rather than an inconsistent one.
    if (!projectA || !projectB) {
      if (projectA) return -1;
      if (projectB) return 1;
      return a.localeCompare(b);
    }
    return compareProjectsByMode(projectA, projectB, mode);
  });

  const order = [...layout.order];
  slots.forEach((slot, index) => {
    order[slot] = resorted[index]!;
  });
  return { order, ids: resorted };
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
 */
function sectionForProject(project: SearchableProject): ProjectSectionKey {
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
  if (project.isPinned) return "pinned";
  if (project.activeAgentCount > 0 || assistant === "working") return "running";
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
function attentionClass(project: SearchableProject): number {
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
 * - Other: whichever order the user picked (#11455); effective frecency by
 *   default, which is what this band has always done.
 * - Current: effective frecency, though it is a single row either way.
 *
 * Only Other reads the preference. The other bands' orders are decisions in
 * their own right — a user asking for A-Z in the residual band is not asking
 * for their blocked agents to be alphabetised.
 */
function compareWithinSection(
  a: SearchableProject,
  b: SearchableProject,
  otherProjectsSortMode: OtherProjectsSortMode
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
  } else if (section === "pinned" || section === "unavailable") {
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
  } else if (section === "other") {
    // `frecencyScore` is already read-time decayed here (see `searchableProjects`),
    // so it is safe to hand straight to the shared comparator.
    return compareProjectsByMode(a, b, otherProjectsSortMode);
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
function buildResults(
  browseRows: ProjectSwitcherRow[],
  browseOrdered: SearchableProject[],
  scratches: SearchableScratch[],
  rankQuery: string,
  isSearching: boolean,
  activityKeys: ReadonlyMap<string, SearchActivityKey> | null
): ProjectSwitcherRow[] {
  if (isSearching && rankQuery.trim()) {
    return rankSwitcherMatches(rankQuery, browseOrdered, scratches, activityKeys);
  }
  return browseRows;
}

/**
 * Trailing-edge debounce window for the project hover prefetch. Matches the
 * GitHub-stats toolbar pattern (#6282) — long enough to filter cursor
 * traversal across the list, short enough to feel "instant" on intentional
 * dwell.
 */
const PROJECT_HOVER_PREFETCH_DELAY_MS = 150;

/**
 * Renderer-side freshness gate. If the cache was primed for this project less
 * than this many milliseconds ago, the hover handler skips re-prefetching.
 * Shorter than the main-process TTL (30s) so re-hover after a back-and-forth
 * sweep doesn't keep firing the same IPC, but generous enough to span the
 * realistic time between hover and click.
 */
const PROJECT_PREFETCH_FRESHNESS_MS = 15_000;

export function useProjectSwitcherPalette(): UseProjectSwitcherPaletteReturn {
  const modalIsOpen = usePaletteStore((state) => state.activePaletteId === "project-switcher");
  const [dropdownIsOpen, setDropdownIsOpen] = useState(false);
  const [mode, setMode] = useState<ProjectSwitcherMode>("modal");
  const isOpen = mode === "modal" ? modalIsOpen : dropdownIsOpen;
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isSearching = query.trim().length > 0;
  // Only stale while a search is still catching up. Clearing the box restores
  // browse in the same commit, so that transition is never "filtering".
  const isFiltering = isSearching && query !== deferredQuery;
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [stopConfirmProjectId, setStopConfirmProjectId] = useState<string | null>(null);
  const [isStoppingProject, setIsStoppingProject] = useState(false);
  const [removeConfirmProject, setRemoveConfirmProject] = useState<SearchableProject | null>(null);
  const [isRemovingProject, setIsRemovingProject] = useState(false);
  const [sleepConfirmProject, setSleepConfirmProject] = useState<SearchableProject | null>(null);
  const [isSleepingProject, setIsSleepingProject] = useState(false);
  const [saveAsProjectConfirm, setSaveAsProjectConfirm] = useState<{
    scratch: SearchableScratch;
    project: Project;
  } | null>(null);
  const [isDeletingOriginalScratch, setIsDeletingOriginalScratch] = useState(false);
  const [deleteAllScratchesConfirm, setDeleteAllScratchesConfirm] =
    useState<DeleteAllScratchesSnapshot | null>(null);
  const [isDeletingAllScratches, setIsDeletingAllScratches] = useState(false);
  // Rapid double-Enter on the confirm button lands twice before React re-renders
  // the disabled state, so the gate has to be synchronous (lesson #4024).
  const isDeletingAllScratchesRef = useRef(false);
  const [deleteScratchConfirm, setDeleteScratchConfirm] = useState<DeleteScratchTarget | null>(
    null
  );
  const [isDeletingScratch, setIsDeletingScratch] = useState(false);
  const isDeletingScratchRef = useRef(false);
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchInFlightRef = useRef<Set<string>>(new Set());
  const prefetchLastAtRef = useRef<Map<string, number>>(new Map());

  const projects = useProjectStore((state) => state.projects);
  const currentProject = useProjectStore((state) => state.currentProject);
  const switchProject = useProjectStore((state) => state.switchProject);
  const reopenProject = useProjectStore((state) => state.reopenProject);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const addProjectFn = useProjectStore((state) => state.addProject);
  const closeActiveProject = useProjectStore((state) => state.closeActiveProject);
  const sleepProjectAction = useProjectStore((state) => state.sleepProject);
  const closeProject = useProjectStore((state) => state.closeProject);
  const removeProject = useProjectStore((state) => state.removeProject);
  const openRelocation = useProjectRelocationStore((state) => state.open);
  const projectStats = useProjectStatsStore((state) => state.stats);

  const { copy: copyToClipboard } = useCopyWithFeedback();

  const scratches = useScratchStore((state) => state.scratches);
  const currentScratch = useScratchStore((state) => state.currentScratch);
  const loadScratches = useScratchStore((state) => state.loadScratches);
  const createScratchAction = useScratchStore((state) => state.createScratch);
  const switchScratchAction = useScratchStore((state) => state.switchScratch);
  const removeScratchActionStore = useScratchStore((state) => state.removeScratch);
  const renameScratchActionStore = useScratchStore((state) => state.renameScratch);

  useEffect(() => {
    if (!isOpen) return;
    // Pull a fresh agent-status snapshot on open so rows show live status
    // immediately instead of waiting for the next passive broadcast, which
    // would otherwise leave a busy project rendering as a silent, idle row.
    //
    // Both stores are awaited because the pull covers scratch rows too (#11518)
    // — the push channel is best-effort, so this is the only guaranteed
    // hydration path for a view that has never received a broadcast.
    //
    // Settled, not `all`: the two loads are independent, and letting either
    // rejection short-circuit the pair would mean one store's IPC failure
    // silently costs the OTHER kind of row its status line. Whichever list did
    // load still gets hydrated from the ids it has.
    void Promise.allSettled([loadProjects(), loadScratches()])
      .then(() => {
        const ids = [
          ...useProjectStore.getState().projects.map((p) => p.id),
          ...useScratchStore.getState().scratches.map((s) => s.id),
        ];
        if (ids.length === 0) return;
        return projectClient.getBulkStats(ids).then((bulk) => {
          // Seed only — never overwrite.
          //
          // Bulk and the push service now compute agent state from the same
          // helper, so a seed is as accurate as a push. It is still only ever a
          // seed: the push service suppresses broadcasts whose payload is
          // unchanged, which is what would make a late bulk response landing on
          // top of a newer push stick until the underlying counts next moved.
          //
          // Bulk covers the one gap the push model leaves: a renderer that has
          // never received a broadcast has nothing to show. Fill absent entries
          // and leave every present one alone.
          const previous = useProjectStatsStore.getState().stats;
          const seeded: ProjectStatusMap = { ...previous };
          let changed = false;
          for (const [id, entry] of Object.entries(bulk)) {
            if (previous[id] !== undefined) continue;
            seeded[id] = {
              activeAgentCount: entry.activeAgentCount,
              waitingAgentCount: entry.waitingAgentCount,
              blockedAgentCount: entry.blockedAgentCount,
              ...(entry.oldestWaitingSince !== undefined
                ? { oldestWaitingSince: entry.oldestWaitingSince }
                : {}),
              completedAgentCount: entry.completedAgentCount,
              unacknowledgedCompletedAgentCount: entry.unacknowledgedCompletedAgentCount,
              ...(entry.oldestUnacknowledgedCompletionAt !== undefined
                ? { oldestUnacknowledgedCompletionAt: entry.oldestUnacknowledgedCompletionAt }
                : {}),
              ...(entry.latestUnacknowledgedCompletionAt !== undefined
                ? { latestUnacknowledgedCompletionAt: entry.latestUnacknowledgedCompletionAt }
                : {}),
              ...(entry.latestCompletionAt !== undefined
                ? { latestCompletionAt: entry.latestCompletionAt }
                : {}),
              ...(entry.latestWorkingSince !== undefined
                ? { latestWorkingSince: entry.latestWorkingSince }
                : {}),
              snoozedAgentCount: entry.snoozedAgentCount,
              ...(entry.nextSnoozeWakeAt !== undefined
                ? { nextSnoozeWakeAt: entry.nextSnoozeWakeAt }
                : {}),
              ...(entry.assistantState !== undefined
                ? { assistantState: entry.assistantState }
                : {}),
              ...(entry.assistantWaitingReason !== undefined
                ? { assistantWaitingReason: entry.assistantWaitingReason }
                : {}),
              ...(entry.assistantStateSince !== undefined
                ? { assistantStateSince: entry.assistantStateSince }
                : {}),
              processCount: entry.processCount,
            };
            changed = true;
          }
          if (changed) useProjectStatsStore.getState().setStats(seeded);
        });
      })
      .catch(() => {
        // Project load or stats refresh failed; rows just render without a
        // status line. This background freshness pull must never surface an
        // error.
      });
  }, [isOpen, loadProjects, loadScratches]);

  const displayPathById = useMemo(() => buildDisplayPaths(projects), [projects]);

  const searchableProjects = useMemo<SearchableProject[]>(() => {
    // One `now` for the whole build keeps every row's effective score on the
    // same clock. Ordering between untouched projects is invariant as time
    // passes (all scores decay by the same factor), so computing at build time
    // rather than on a tick is exact, not an approximation.
    const frecencyNow = Date.now();
    return projects.map((p) => {
      const stats = projectStats[p.id];
      const isActive = p.id === currentProject?.id;
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

      const project: SearchableProject = {
        id: p.id,
        name: p.name,
        path: p.path,
        emoji: p.emoji || "🌲",
        color: p.color,
        lastOpened: p.lastOpened ?? 0,
        status: p.status,
        autoParkedAt: p.autoParkedAt,
        // Passed through as-is. Coercing an absent count to 0 here would turn
        // "not computed yet" into "restores nothing" — the one distinction the
        // dot depends on.
        resumableAgentCount: p.resumableAgentCount,
        isActive,
        isBackground,
        isMissing,
        isPinned: p.pinned ?? false,
        frecencyScore: decayFrecencyScore(
          p.frecencyScore ?? FRECENCY_COLD_START,
          p.lastAccessedAt ?? 0,
          frecencyNow
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
        displayPath: displayPathById.get(p.id) ?? p.path,
        section: "other",
      };
      project.section = sectionForProject(project);
      return project;
    });
  }, [projects, projectStats, currentProject?.id, displayPathById]);

  useEffect(() => {
    if (!isOpen || searchableProjects.length === 0) return;
    const ids = searchableProjects.map((p) => p.id);
    void useProjectSettingsStore.getState().loadNotificationOverridesForProjects(ids);
  }, [isOpen, searchableProjects]);

  const backgroundWaitingCount = useMemo(
    () =>
      searchableProjects
        .filter((p) => !p.isActive && p.isBackground && p.waitingAgentCount > 0)
        .reduce((sum, p) => sum + p.waitingAgentCount, 0),
    [searchableProjects]
  );

  const nonActiveAgentCounts = useMemo(() => {
    let activeAgentCount = 0;
    let waitingAgentCount = 0;
    // Projects, not agents. The badge answers "how many places are waiting on
    // me?" — a number that stays legible while eight agents wait in one repo,
    // where an agent tally would read as eight separate obligations. Waiting
    // only, not the full attention band: unreviewed completions surface in the
    // switcher, but the tray badge is reserved for interruptions.
    let waitingProjectCount = 0;
    for (const project of searchableProjects) {
      if (project.isActive) continue;
      activeAgentCount += project.activeAgentCount;
      waitingAgentCount += project.waitingAgentCount;
      if (project.waitingAgentCount > 0) waitingProjectCount += 1;
    }
    return { activeAgentCount, waitingAgentCount, waitingProjectCount };
  }, [searchableProjects]);

  const otherProjectsSortMode = usePreferencesStore((state) => state.projectSwitcherOtherSortMode);

  const liveBrowseOrder = useMemo<SearchableProject[]>(() => {
    return [...searchableProjects].sort((a, b) => {
      if (a.section !== b.section) {
        return PROJECT_SECTION_ORDER.indexOf(a.section) - PROJECT_SECTION_ORDER.indexOf(b.section);
      }
      return compareWithinSection(a, b, otherProjectsSortMode);
    });
  }, [searchableProjects, otherProjectsSortMode]);

  // Layout is frozen for the lifetime of an open palette; content stays live.
  //
  // Browse ranks on agent state, and agent state changes constantly — an agent
  // finishing mid-read would otherwise pull its project out of "Needs attention"
  // and drop it several rows down, moving every row under the pointer between
  // the moment the user decided to click and the moment they clicked.
  //
  // Both the sequence AND each row's band are frozen, because they're one
  // decision: the component cuts section headers from contiguous runs, so a row
  // that kept its frozen slot while its band changed underneath would split its
  // old band in two and print that header twice. Counts, ages and status text
  // are read fresh every render, so rows still update in place.
  // Captured in `open()`/`close()` rather than during render. A ref written
  // while rendering leaks into the committed tree if React abandons that render,
  // and it never resets on a mode change that leaves the palette open.
  // A session that opened before any stats reached this view froze a guess, not
  // a decision: with no entry every row reads as zero agents and lands in
  // "Other", so the palette shows one ungrouped band and only re-bands on the
  // next open (#11452). Such a session stays provisional until real data lands,
  // and is then regrouped once, in place.
  const [frozenLayout, setFrozenLayout] = useState<FrozenLayout | null>(null);

  const captureLayout = useCallback(
    (projects: SearchableProject[], isProvisional = false): FrozenLayout => ({
      order: projects.map((project) => project.id),
      sections: new Map(projects.map((project) => [project.id, project.section])),
      isProvisional,
    }),
    []
  );

  // Search's activity keys are frozen for the same reason and over the same
  // session, but separately: browse's freeze is projects-and-bands, and search
  // ranks scratches in the same list with no bands at all (#11861).
  const [frozenSearchActivity, setFrozenSearchActivity] = useState<FrozenSearchActivity | null>(
    null
  );

  const captureSearchActivity = useCallback(
    (
      projects: SearchableProject[],
      scratches: SearchableScratch[],
      isProvisional = false
    ): FrozenSearchActivity => {
      const keys = new Map<string, SearchActivityKey>();
      // Every row, including the active and the missing ones: search has no band
      // that spares a row from being ranked on what it is doing.
      for (const project of projects) keys.set(project.id, computeSearchActivityKey(project));
      for (const scratch of scratches) keys.set(scratch.id, computeSearchActivityKey(scratch));
      return { keys, isProvisional };
    },
    []
  );

  // Changing the sort order is the one input that must beat the freeze. The
  // freeze exists so rows don't move on their own; a mode the user just picked
  // is the opposite of that, and holding it until the next open would read as
  // the menu doing nothing.
  //
  // Guarded on the mode having actually changed, via a ref rather than the
  // effect's own dependencies: `liveBrowseOrder` and `frozenLayout` are both
  // dependencies because the re-sort must read the freshly ranked projects
  // against the layout it is rewriting, and without the guard every stats push
  // would re-sort and destroy the freeze outright.
  const previousOtherProjectsSortMode = useRef(otherProjectsSortMode);
  useEffect(() => {
    if (previousOtherProjectsSortMode.current === otherProjectsSortMode) return;
    previousOtherProjectsSortMode.current = otherProjectsSortMode;
    // A change while closed needs no re-sort: the next `open()` captures the
    // new order anyway, and re-sorting here would queue it against a stale list.
    if (!isOpen || !frozenLayout) return;

    const live = new Map(liveBrowseOrder.map((project) => [project.id, project]));

    // Rewritten through an updater, against whatever layout React has applied
    // rather than the one this render closed over. The sibling effect below
    // folds newly registered projects in with an updater of its own, and a
    // plain replacement here would drop an arrival queued behind this click —
    // it would return at the band's end on the next pass, out of the order the
    // user just asked for.
    //
    // Sections and provisionality are untouched: provisionality describes the
    // DATA, so a mode change during a cold open must not cancel the pending
    // one-time regroup (#11452).
    setFrozenLayout((previous) => {
      if (!previous) return previous;
      const resorted = resortOtherBand(previous, live, otherProjectsSortMode);
      return resorted ? { ...previous, order: resorted.order } : previous;
    });

    // A band the user just re-ordered is read from the top. The highlight
    // normally follows its PROJECT across a reorder — the list churns on its
    // own, and a highlight left addressing whatever row inherited the slot is
    // how Enter commits a project the user never chose (#11071) — but a mode
    // they picked a moment ago is not that kind of churn. They asked to see
    // this band differently; the answer starts at the top of it instead of
    // chasing their old row down the list.
    //
    // Scoped to the band that actually moved: a highlight parked in Needs
    // attention stays put, since this control never claimed to order that band.
    // Skipped while searching — the sort control only renders on a browse
    // header today, so this is what keeps the reset honest if search ever grows
    // one: query-ranked rows are not sequenced by this preference, and seating
    // the highlight on a browse-order row would land it anywhere.
    if (isSearching) return;
    // Decided against the layout this render saw, unlike the rewrite above. An
    // arrival is never the row the user had selected, and can only be the new
    // band top in the same narrow window — so a snapshot costs at most one row
    // of accuracy there, and buys a pure computation of the target.
    const resorted = resortOtherBand(frozenLayout, live, otherProjectsSortMode);
    if (!resorted) return;
    // Same skip as `open()`'s preselect: a project that went missing while the
    // palette was open keeps its frozen slot, and a reflexive Enter landing on
    // it opens the relocation dialog rather than switching projects.
    const target = resorted.ids.find((id) => live.get(id)?.isMissing === false) ?? resorted.ids[0]!;
    setSelectedRowId((previousId) =>
      previousId !== null && frozenLayout.sections.get(previousId) === "other" ? target : previousId
    );
  }, [otherProjectsSortMode, isOpen, liveBrowseOrder, frozenLayout, isSearching]);

  // Fold projects that appeared after the freeze into it, at the position the
  // renderer already gives them (end of their live band). Without this they are
  // the one part of the list still re-banding on every stats push, so the freeze
  // the palette advertises would hold for the session's original rows only.
  useEffect(() => {
    if (!frozenLayout) return;

    // A provisional freeze is a placeholder. Once no row is still a guess,
    // recapture the whole layout so bands AND within-band order come from
    // `liveBrowseOrder`'s real sort, and stop being provisional.
    //
    // Judged against the rows that are live now, not a set captured at open: a
    // project that registers while the session is still provisional would
    // otherwise be folded in at its own guessed band and then locked there by
    // the recapture, reproducing this very bug for that row. Reading live also
    // means a project that goes away simply stops holding the regroup up.
    //
    // Waiting for all of them keeps the regroup one decision rather than a
    // trickle of rows moving under the pointer; if a row never resolves, the
    // session just behaves as it did before this fix.
    if (frozenLayout.isProvisional) {
      const stillGuessing = liveBrowseOrder.some(
        (project) => isStatsSensitive(project) && projectStats[project.id] === undefined
      );
      if (!stillGuessing) {
        setFrozenLayout((previous) =>
          // Identity, not truthiness: an effect left over from a previous open
          // session must not recapture this one with a stale order.
          previous === frozenLayout ? captureLayout(liveBrowseOrder) : previous
        );
        return;
      }
    }

    const arrivals = liveBrowseOrder.filter((project) => !frozenLayout.sections.has(project.id));
    if (arrivals.length === 0) return;
    setFrozenLayout((previous) => {
      if (!previous) return previous;
      const order = [...previous.order];
      const sections = new Map(previous.sections);
      for (const project of arrivals) {
        if (sections.has(project.id)) continue;
        order.push(project.id);
        sections.set(project.id, project.section);
      }
      // Spread, so a session still waiting on its first stats stays provisional
      // and folds this arrival into its pending regroup.
      return { ...previous, order, sections };
    });
  }, [liveBrowseOrder, frozenLayout, projectStats, captureLayout]);

  const browseOrdered = useMemo<SearchableProject[]>(() => {
    const frozen = frozenLayout;
    if (!frozen) return liveBrowseOrder;

    const byId = new Map(liveBrowseOrder.map((project) => [project.id, project]));
    const held = (project: SearchableProject): SearchableProject => {
      const section = frozen.sections.get(project.id);
      return section === undefined || section === project.section
        ? project
        : { ...project, section };
    };

    const ordered: SearchableProject[] = [];
    for (const id of frozen.order) {
      const project = byId.get(id);
      if (project) {
        ordered.push(held(project));
        byId.delete(id);
      }
    }
    // A project registered while the palette is open has no frozen slot, so it
    // takes its live band and joins the end of it.
    for (const project of liveBrowseOrder) {
      if (byId.has(project.id)) ordered.push(project);
    }

    // Regroup by band. The sort is stable, so this only moves rows across bands
    // — within a band the frozen sequence survives untouched. Doing it here
    // rather than trusting the freeze makes contiguity structural: the component
    // cuts headers at every section change, so a band appearing twice would
    // print its header twice, and a late arrival must not be able to cause that.
    return ordered.sort(
      (a, b) => PROJECT_SECTION_ORDER.indexOf(a.section) - PROJECT_SECTION_ORDER.indexOf(b.section)
    );
  }, [liveBrowseOrder, frozenLayout]);

  // Recency order, which is what the pinned browse section renders. Search takes
  // this same list but re-ranks it against the query (#11466), so it has to be
  // built before `results` rather than beside the other scratch callbacks below.
  const scratchResults = useMemo<SearchableScratch[]>(() => {
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
        isActive: currentScratch?.id === s.id,
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
  }, [scratches, currentScratch?.id, projectStats]);

  // The search freeze's counterpart to the browse regroup above, gated on the
  // same predicate so both resolve on one commit.
  //
  // A provisional snapshot read every row as quiet, which is not an ordering —
  // it is the absence of one. Once no stats-sensitive row is still a guess it is
  // recaptured whole, exactly once, and holds from there.
  //
  // Rows that appear afterwards are folded in at their key of the moment. Until
  // that lands they rank as quiet rather than as their live counts
  // (`rankSwitcherMatches`), so an arrival still never moves on a stats push —
  // it takes its one position and then holds like everything else.
  useEffect(() => {
    if (!frozenSearchActivity) return;

    if (frozenSearchActivity.isProvisional) {
      const { unkeyed } = countSearchRowsAwaitingStats(
        searchableProjects,
        scratchResults,
        projectStats
      );
      if (unkeyed === 0) {
        setFrozenSearchActivity((previous) =>
          // Identity, not truthiness: an effect left over from a previous open
          // session must not recapture this one against stale rows.
          previous === frozenSearchActivity
            ? captureSearchActivity(searchableProjects, scratchResults)
            : previous
        );
        return;
      }
    }

    const arrivals = [...searchableProjects, ...scratchResults].filter(
      (row) => !frozenSearchActivity.keys.has(row.id)
    );
    if (arrivals.length === 0) return;
    setFrozenSearchActivity((previous) => {
      // Identity, for the same reason the recapture above checks it: an updater
      // queued against a previous open session must not seat its arrivals in
      // this one. Bailing is free — the snapshot is a dependency, so the effect
      // fires again against whichever one React actually applied.
      if (previous !== frozenSearchActivity) return previous;
      const keys = new Map(previous.keys);
      let added = false;
      for (const row of arrivals) {
        if (keys.has(row.id)) continue;
        keys.set(row.id, computeSearchActivityKey(row));
        added = true;
      }
      if (!added) return previous;
      // Spread, so a session still waiting on its first stats stays provisional
      // and folds this arrival into its pending recapture.
      return { ...previous, keys };
    });
  }, [
    searchableProjects,
    scratchResults,
    projectStats,
    frozenSearchActivity,
    captureSearchActivity,
  ]);

  /**
   * What is executing across every workspace, for the palette header (#11832).
   *
   * Broader than `nonActiveAgentCounts` above in both directions, because the
   * two answer different questions. That one is the trigger's badge — "is
   * somewhere else asking for me?" — so it excludes the project on screen. This
   * one is "is it safe to look away?", which the work in front of you counts
   * toward as much as the work behind you, and scratches host agents too.
   *
   * Assistants are counted, separately. They are not runs the user launched, so
   * folding them into the agent tally would misreport it — but an assistant
   * mid-task is a reason the app is not finished with itself.
   */
  const fleetLiveness = useMemo(() => {
    let runningAgentCount = 0;
    let workingAssistantCount = 0;
    for (const workspace of [...searchableProjects, ...scratchResults]) {
      runningAgentCount += workspace.activeAgentCount;
      if (classifyAssistantActivity(workspace) === "working") workingAssistantCount += 1;
    }
    return { runningAgentCount, workingAssistantCount };
  }, [searchableProjects, scratchResults]);

  // Clearing the box reverts to browse immediately rather than holding the
  // deferred ranking for a commit — otherwise browse would flash the stale
  // search ranking on the way back to an empty query.
  const resultsQuery = isSearching ? deferredQuery : "";

  // Held apart from `results` so browse keeps a stable array identity across
  // scratch-store traffic. Folded into the same memo, a rename in the pinned
  // section below would hand the component a fresh array of identical project
  // rows, and its scroll-into-view effect would yank the list back to the
  // highlighted project while the user was reading the section.
  const browseRows = useMemo<ProjectSwitcherRow[]>(
    () => browseOrdered.map(toProjectRow),
    [browseOrdered]
  );

  // True exactly when `results` is the ranked, scratch-carrying list — which is
  // one commit behind `isSearching`, since the ranking runs on the deferred
  // query. The pinned scratch section hides on THIS, never on the live query:
  // hiding a commit early would leave the scratches nowhere for that frame.
  const isRankedSearch = isSearching && resultsQuery.trim().length > 0;

  const results = useMemo<ProjectSwitcherRow[]>(
    () =>
      buildResults(
        browseRows,
        browseOrdered,
        scratchResults,
        resultsQuery,
        isSearching,
        frozenSearchActivity?.keys ?? null
      ),
    [browseRows, browseOrdered, scratchResults, resultsQuery, isSearching, frozenSearchActivity]
  );

  // The selected ROW is the state; its index is derived. Tracking an index
  // instead would let it outlive the row it pointed at — a list that shrinks
  // under an open palette (a project closing, a stats push) would leave the
  // index addressing a different row than the user selected, and Enter would
  // commit that one (#11071). Deriving means the highlight follows the row
  // across reorders and never addresses a row that isn't rendered.
  const selectedIndex = useMemo(() => {
    if (results.length === 0) return 0;
    const index = selectedRowId ? results.findIndex((row) => row.id === selectedRowId) : -1;
    return index >= 0 ? index : 0;
  }, [results, selectedRowId]);

  // Decoupled from `results` so the toolbar pill keeps the active project's
  // pin/process state even when the current search filters it out.
  const activeProject = useMemo<SearchableProject | null>(
    () => searchableProjects.find((p) => p.isActive) ?? null,
    [searchableProjects]
  );

  // A new query re-ranks the list, so fall back to the top match.
  useEffect(() => {
    if (query) {
      setSelectedRowId(null);
    }
  }, [query]);

  useEffect(() => {
    if (!removeConfirmProject) return;
    const stillExists = searchableProjects.some((p) => p.id === removeConfirmProject.id);
    if (!stillExists) {
      setRemoveConfirmProject(null);
    }
  }, [removeConfirmProject, searchableProjects]);

  useEffect(() => {
    if (!sleepConfirmProject) return;
    const stillExists = searchableProjects.some((p) => p.id === sleepConfirmProject.id);
    if (!stillExists) {
      setSleepConfirmProject(null);
    }
  }, [sleepConfirmProject, searchableProjects]);

  const open = useCallback(
    (nextMode: ProjectSwitcherMode = "modal") => {
      setMode(nextMode);
      if (nextMode === "modal") {
        usePaletteStore.getState().openPalette("project-switcher");
      } else {
        setDropdownIsOpen(true);
      }
      setQuery("");
      // Freeze the layout for this open session. Taken from the live order,
      // not `browseOrdered`, which is still holding the previous session's
      // frozen shape at this point.
      //
      // Provisional means EVERY stats-sensitive row is unkeyed, not that the
      // map is empty: a keyed all-zero entry is real data about an idle
      // project, and one unkeyed row among settled ones is a project main
      // hasn't reported yet — neither should unlock rows the user is already
      // looking at. Active and unavailable rows are banded without stats, so
      // they say nothing about hydration; pinned rows do, since attention
      // outranks a pin.
      const statsSensitive = liveBrowseOrder.filter(isStatsSensitive);
      const isProvisional =
        statsSensitive.length > 0 &&
        statsSensitive.every((project) => projectStats[project.id] === undefined);
      setFrozenLayout(captureLayout(liveBrowseOrder, isProvisional));
      // Its own verdict, over its own rows: search ranks scratches and the
      // active row too, so browse's answer does not cover the set it froze.
      const searchRows = countSearchRowsAwaitingStats(
        searchableProjects,
        scratchResults,
        projectStats
      );
      setFrozenSearchActivity(
        captureSearchActivity(
          searchableProjects,
          scratchResults,
          searchRows.total > 0 && searchRows.unkeyed === searchRows.total
        )
      );
      // Preselect the first ENABLED row that isn't the project we're already
      // in, so open-then-Enter is a one-two return that never defaults onto an
      // Unavailable row (selecting one opens the relocation dialog — the right
      // response to a click, the wrong one to a reflexive Enter). Both modes
      // render the same section-ordered browse list now, so this is the browse
      // order regardless of which surface is opening. From a scratch there is
      // no active row, so it lands on row 1 rather than skipping past it
      // (#11085); an all-missing list still preselects something rather than
      // nothing.
      const initial =
        liveBrowseOrder.find((project) => !project.isActive && !project.isMissing) ??
        liveBrowseOrder.find((project) => !project.isActive) ??
        liveBrowseOrder[0];
      setSelectedRowId(initial?.id ?? null);
    },
    [
      liveBrowseOrder,
      captureLayout,
      projectStats,
      captureSearchActivity,
      searchableProjects,
      scratchResults,
    ]
  );

  const close = useCallback(() => {
    if (mode === "modal") {
      usePaletteStore.getState().closePalette("project-switcher");
    } else {
      setDropdownIsOpen(false);
    }
    setQuery("");
    setSelectedRowId(null);
    setFrozenLayout(null);
    setFrozenSearchActivity(null);
  }, [mode]);

  // Steps the selection by `delta` rows, wrapping. Resolves the current row
  // from the id inside the updater so two calls batched into one tick compose
  // (the second sees where the first landed) instead of collapsing into one.
  const step = useCallback(
    (delta: number) => {
      if (results.length === 0) return;
      setSelectedRowId((previousId) => {
        const current = previousId ? results.findIndex((project) => project.id === previousId) : -1;
        const from = current >= 0 ? current : 0;
        const next = (from + delta + results.length) % results.length;
        return results[next]!.id;
      });
    },
    [results]
  );

  const toggle = useCallback(
    (nextMode: ProjectSwitcherMode = "modal") => {
      const currentlyOpen = nextMode === "modal" ? modalIsOpen : dropdownIsOpen;
      if (currentlyOpen) {
        step(1);
      } else {
        open(nextMode);
      }
    },
    [modalIsOpen, dropdownIsOpen, open, step]
  );

  const selectPrevious = useCallback(() => step(-1), [step]);

  const selectNext = useCallback(() => step(1), [step]);

  const selectProject = useCallback(
    async (project: SearchableProject) => {
      // Picking the project already on screen is a "never mind", not a dead
      // end: there is nothing to switch to, but leaving the palette open with
      // no feedback reads as a swallowed keypress. Mirrors `selectScratch`.
      if (project.isActive) {
        close();
        return;
      }

      close();

      // A project whose folder moved used to be an inert row: selecting it did
      // nothing at all, with no feedback explaining why. Route it to the
      // relocation dialog instead, so the obvious gesture repairs the thing the
      // row is complaining about. Inlined rather than calling the shared
      // `openRelocationDialog` below it, which isn't bound yet at this point.
      if (project.isMissing) {
        openRelocation({
          projectId: project.id,
          mode: "reattach",
          oldPath: project.path,
          name: project.name,
        });
        return;
      }

      if (project.isBackground) {
        void reopenProject(project.id);
      } else {
        void switchProject(project.id);
      }
    },
    [close, switchProject, reopenProject, openRelocation]
  );

  const selectScratch = useCallback(
    async (scratch: SearchableScratch) => {
      if (scratch.isActive) {
        close();
        return;
      }
      close();
      try {
        await switchScratchAction(scratch.id);
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Couldn't switch scratch",
          message: formatErrorMessage(error, "Couldn't switch to scratch workspace"),
        });
      }
    },
    [close, switchScratchAction]
  );

  // The one commit path for a row of `results`. Both branches are fire-and-
  // forget by design — each closes the palette first and reports its own
  // failure, so there is nothing here for a caller to await.
  const selectRow = useCallback(
    (row: ProjectSwitcherRow) => {
      if (row.kind === "scratch") {
        void selectScratch(row);
        return;
      }
      void selectProject(row);
    },
    [selectProject, selectScratch]
  );

  const clearPendingPrefetchTimer = useCallback(() => {
    if (prefetchTimerRef.current !== null) {
      clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  }, []);

  const runPrefetch = useCallback((projectId: string) => {
    if (prefetchInFlightRef.current.has(projectId)) return;
    const lastAt = prefetchLastAtRef.current.get(projectId) ?? 0;
    if (lastAt > 0 && Date.now() - lastAt < PROJECT_PREFETCH_FRESHNESS_MS) return;

    prefetchInFlightRef.current.add(projectId);
    // projectClient.prefetchHydrate swallows errors (fire-and-forget), so this
    // .then() runs whether the main-process build succeeded or failed. We mark
    // the freshness ref either way: a hover-induced retry-storm against a
    // genuinely failing build is worse than a 15s window where the user gets
    // the normal (uncached) hydrate. The click-time hydrate falls through to
    // the full read path on a cache miss with no user-visible difference.
    void projectClient
      .prefetchHydrate(projectId)
      .then(() => {
        prefetchLastAtRef.current.set(projectId, Date.now());
      })
      .finally(() => {
        prefetchInFlightRef.current.delete(projectId);
      });
  }, []);

  const onHoverProject = useCallback(
    (projectId: string, pointerType: string) => {
      if (pointerType !== "mouse") return;
      const project = searchableProjects.find((p) => p.id === projectId);
      if (!project || project.isActive || project.isMissing) return;
      clearPendingPrefetchTimer();
      prefetchTimerRef.current = setTimeout(() => {
        prefetchTimerRef.current = null;
        runPrefetch(projectId);
      }, PROJECT_HOVER_PREFETCH_DELAY_MS);
    },
    [searchableProjects, clearPendingPrefetchTimer, runPrefetch]
  );

  const onHoverProjectEnd = useCallback(
    (pointerType: string) => {
      if (pointerType !== "mouse") return;
      clearPendingPrefetchTimer();
    },
    [clearPendingPrefetchTimer]
  );

  // Cancel any pending prefetch when the palette closes — the user has either
  // committed to a project (whose hydrate will run via the click path) or
  // bailed out (no need to keep filling the cache).
  useEffect(() => {
    if (isOpen) return;
    clearPendingPrefetchTimer();
  }, [isOpen, clearPendingPrefetchTimer]);

  useEffect(() => () => clearPendingPrefetchTimer(), [clearPendingPrefetchTimer]);

  const confirmSelection = useCallback(() => {
    if (results.length === 0) return;
    selectRow(results[selectedIndex]!);
  }, [results, selectedIndex, selectRow]);

  const addProject = useCallback(async () => {
    close();
    await addProjectFn();
  }, [close, addProjectFn]);

  const cloneRepo = useCallback(() => {
    close();
    useProjectStore.getState().openCloneRepoDialog();
  }, [close]);

  // "Locate moved project" (missing) and "Move or rename project" (healthy) both
  // open the shared relocation dialog (#11282, phase 4), superseding the old
  // picker-then-mutate `project:locate` path. The palette closes first so its
  // overlay doesn't contend with the dialog's focus trap.
  const openRelocationDialog = useCallback(
    (projectId: string, mode: "move" | "reattach") => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;
      close();
      openRelocation({ projectId, mode, oldPath: project.path, name: project.name });
    },
    [projects, close, openRelocation]
  );

  const locateProject = useCallback(
    (projectId: string) => openRelocationDialog(projectId, "reattach"),
    [openRelocationDialog]
  );

  const moveOrRenameProject = useCallback(
    (projectId: string) => openRelocationDialog(projectId, "move"),
    [openRelocationDialog]
  );

  const copyPath = useCallback(
    (path: string) => {
      void copyToClipboard(path).then((ok) => {
        if (ok) {
          notify({ type: "info", title: "Path copied", message: path, transient: true });
        }
      });
    },
    [copyToClipboard]
  );

  const togglePinProject = useCallback(
    async (projectId: string) => {
      const project = searchableProjects.find((p) => p.id === projectId);
      if (!project) return;
      const wantPinned = !project.isPinned;
      try {
        await projectClient.update(projectId, { pinned: wantPinned });
        await loadProjects();
      } catch (error) {
        const retry = async () => {
          try {
            await projectClient.update(projectId, { pinned: wantPinned });
            await loadProjects();
          } catch (retryError) {
            notify({
              type: "error",
              title: "Couldn't update project",
              message: formatErrorMessage(retryError, "Couldn't update project"),
              actions: [{ label: "Try again", variant: "primary", onClick: retry }],
            });
          }
        };
        notify({
          type: "error",
          title: "Couldn't update project",
          message: formatErrorMessage(error, "Couldn't update project"),
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
        });
      }
    },
    [searchableProjects, loadProjects]
  );

  const stopProject = useCallback(
    async (projectId: string) => {
      close();
      setStopConfirmProjectId(projectId);
    },
    [close]
  );

  const confirmStopProject = useCallback(async () => {
    if (!stopConfirmProjectId) return;
    setIsStoppingProject(true);

    const capturedId = stopConfirmProjectId;

    try {
      const isActive = useProjectStore.getState().currentProject?.id === capturedId;
      if (isActive) {
        await closeActiveProject(capturedId);
      } else {
        await closeProject(capturedId, { killTerminals: true });
      }
      setStopConfirmProjectId(null);
    } catch (error) {
      const retry = async () => {
        const isActive = useProjectStore.getState().currentProject?.id === capturedId;
        try {
          if (isActive) {
            await closeActiveProject(capturedId);
          } else {
            await closeProject(capturedId, { killTerminals: true });
          }
        } catch (retryError) {
          notify({
            type: "error",
            title: "Couldn't stop project",
            message: formatErrorMessage(retryError, "Couldn't stop project"),
            actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          });
        }
      };
      notify({
        type: "error",
        title: "Couldn't stop project",
        message: formatErrorMessage(error, "Couldn't stop project"),
        actions: [{ label: "Try again", variant: "primary", onClick: retry }],
      });
    } finally {
      setIsStoppingProject(false);
    }
  }, [stopConfirmProjectId, closeActiveProject, closeProject]);

  const removeProjectFromList = useCallback(
    async (projectId: string) => {
      const project = searchableProjects.find((p) => p.id === projectId);
      if (!project) return;

      if (removeConfirmProject) return;

      setRemoveConfirmProject(project);
    },
    [searchableProjects, removeConfirmProject]
  );

  const doSleepProject = useCallback(
    async (projectId: string) => {
      // Through the store, not projectClient: sleeping the ACTIVE project also
      // has to flush pending panel saves before the teardown and drop the window
      // to the no-project state after it.
      const run = () => sleepProjectAction(projectId);
      try {
        await run();
      } catch (error) {
        const retry = async () => {
          try {
            await run();
          } catch (retryError) {
            notify({
              type: "error",
              title: "Couldn't sleep project",
              message: formatErrorMessage(retryError, "Couldn't put the project to sleep"),
              actions: [{ label: "Try again", variant: "primary", onClick: retry }],
              context: { eventKind: "uiFeedback" },
            });
          }
        };
        notify({
          type: "error",
          title: "Couldn't sleep project",
          message: formatErrorMessage(error, "Couldn't put the project to sleep"),
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          context: { eventKind: "uiFeedback" },
        });
      }
    },
    [sleepProjectAction]
  );

  const sleepProject = useCallback(
    async (projectId: string) => {
      const project = searchableProjects.find((p) => p.id === projectId);
      if (!project) return;

      close();

      const hasProcesses =
        project.processCount > 0 || project.activeAgentCount > 0 || project.waitingAgentCount > 0;

      // D1 (confirm) when live processes would be stopped, or when the target is
      // the project on screen here — that tears down what the user is looking
      // at. D0 (immediate) for a background project with nothing running to
      // interrupt. The snapshot freezes the counts the dialog previews.
      //
      // `isActive` only covers THIS window, and no cross-window signal is
      // available here: the persisted `status` is a singleton keyed to the
      // last-switched project, so "active" doesn't mean "open in some window".
      // A project open in ANOTHER window can therefore be slept without a
      // confirm — bounded harm, since nothing is running in that case and the
      // other window is told what happened (`useSleptProjectTransition`).
      if (hasProcesses || project.isActive) {
        setSleepConfirmProject(project);
      } else {
        await doSleepProject(projectId);
      }
    },
    [searchableProjects, close, doSleepProject]
  );

  const confirmSleep = useCallback(async () => {
    if (!sleepConfirmProject || isSleepingProject) return;
    setIsSleepingProject(true);
    const capturedId = sleepConfirmProject.id;
    try {
      await doSleepProject(capturedId);
      setSleepConfirmProject(null);
    } finally {
      setIsSleepingProject(false);
    }
  }, [sleepConfirmProject, isSleepingProject, doSleepProject]);

  const createScratch = useCallback(
    async (name?: string) => {
      close();
      // An empty name is forwarded as undefined so main applies its own
      // `defaultScratchName` — same behavior as before the naming affordance.
      const requestedName = name?.trim() ? name.trim() : undefined;
      // Resume at the step that failed. Retrying the whole thing after the
      // scratch already exists would create a second one and orphan its folder.
      let createdId: string | null = null;
      const run = async () => {
        if (!createdId) {
          createdId = (await createScratchAction(requestedName)).id;
        }
        await switchScratchAction(createdId);
      };
      const fail = (error: unknown, retry: () => Promise<void>) => {
        const created = createdId !== null;
        notify({
          type: "error",
          title: created ? "Couldn't open scratch" : "Couldn't create scratch",
          message: formatErrorMessage(
            error,
            created
              ? "Created the scratch workspace but couldn't switch to it"
              : "Couldn't create scratch workspace"
          ),
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          context: { eventKind: "recovery" },
        });
      };
      try {
        await run();
      } catch (error) {
        const retry = async () => {
          try {
            await run();
          } catch (retryError) {
            fail(retryError, retry);
          }
        };
        fail(error, retry);
      }
    },
    [close, createScratchAction, switchScratchAction]
  );

  const renameScratch = useCallback(
    async (scratchId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const rename = async () => {
        await renameScratchActionStore(scratchId, trimmed);
      };
      try {
        await rename();
      } catch (error) {
        const retry = async () => {
          try {
            await rename();
          } catch (retryError) {
            notify({
              type: "error",
              title: "Couldn't rename scratch",
              message: formatErrorMessage(retryError, "Couldn't rename scratch workspace"),
              actions: [{ label: "Try again", variant: "primary", onClick: retry }],
              context: { eventKind: "recovery" },
            });
          }
        };
        notify({
          type: "error",
          title: "Couldn't rename scratch",
          message: formatErrorMessage(error, "Couldn't rename scratch workspace"),
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          // Not `uiFeedback`: its passive policy routes to the inbox, where this
          // closure-backed "Try again" can never be clicked.
          context: { eventKind: "recovery" },
        });
      }
    },
    [renameScratchActionStore]
  );

  const requestDeleteScratch = useCallback(
    (scratchId: string) => {
      if (isDeletingScratchRef.current || deleteScratchConfirm) return;
      const target = scratchResults.find((scratch) => scratch.id === scratchId);
      // No fallback target: a miss means the row went away between the menu
      // opening and the choice landing, and guessing which scratch the user
      // meant is exactly the silent default a destructive path must not have.
      if (!target) return;
      setDeleteScratchConfirm({ id: target.id, name: target.name, path: target.path });
    },
    [scratchResults, deleteScratchConfirm]
  );

  const dismissDeleteScratchConfirm = useCallback(() => {
    if (isDeletingScratchRef.current) return;
    setDeleteScratchConfirm(null);
  }, []);

  // A `scratch:removed` push from another window can retire the target under an
  // open dialog. Skipped while our own run is in flight, or the removal we just
  // performed would tear the dialog down before the outcome is announced.
  //
  // Gated on the STATE, not the ref that guards re-entrancy: a ref settling in
  // `finally` re-runs nothing. Another window deleting the target mid-run would
  // then be consumed by a skipped pass, and if our own call went on to reject —
  // which leaves the dialog open as its own retry surface — nothing would ever
  // reconcile it, stranding a dialog that retries a scratch already gone.
  useEffect(() => {
    if (!deleteScratchConfirm || isDeletingScratch) return;
    if (scratches.some((scratch: Scratch) => scratch.id === deleteScratchConfirm.id)) return;
    setDeleteScratchConfirm(null);
  }, [deleteScratchConfirm, scratches, isDeletingScratch]);

  const confirmDeleteScratch = useCallback(async () => {
    if (isDeletingScratchRef.current) return;
    const target = deleteScratchConfirm;
    if (!target) return;

    isDeletingScratchRef.current = true;
    setIsDeletingScratch(true);

    try {
      await removeScratchActionStore(target.id);
      const title = `Deleted '${target.name}'`;
      // Close before announcing: VoiceOver drops live-region updates raised from
      // outside a focused `aria-modal` subtree (lesson #9434).
      closeAndAnnounce(() => setDeleteScratchConfirm(null), title);
      // Reports the terminals, not the folder: main tombstones the row and then
      // treats `fs.rm` as best-effort, so a resolved call proves the workspace is
      // gone from the app, not that the directory is gone from disk.
      //
      // A focused-window receipt, deliberately best-effort: the row leaving is
      // only visible if the palette is still open on it, so a toast is worth
      // raising, but a deletion that lands while the window is blurred is dropped
      // rather than filed. `transient` is what drops it, and it stays because a
      // routine delete is not inbox-worthy — `closeAndAnnounce` above is the
      // guaranteed signal. No `context` for the same reason: suppression needs an
      // inbox entry to fall back to, and a transient payload has none.
      // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok
      notify({
        type: "success",
        title,
        message: "Its terminals were closed.",
        transient: true,
        priority: "high",
      });
    } catch (error) {
      // Another window may have deleted this scratch while our own call was in
      // flight, which is how ours came to fail. The user asked for it gone and it
      // is gone, so reconcile instead of reporting a failure — and close, because
      // the error copy below leans on the dialog surviving as its retry surface,
      // which the stale-target effect is about to take away.
      const isAlreadyGone = !useScratchStore
        .getState()
        .scratches.some((scratch: Scratch) => scratch.id === target.id);
      if (isAlreadyGone) {
        closeAndAnnounce(() => setDeleteScratchConfirm(null), `Deleted '${target.name}'`);
        return;
      }
      // The dialog stays open and its button re-arms: that button is the retry
      // surface, so the toast needs no action of its own.
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Couldn't delete scratch",
        message: formatErrorMessage(error, "Couldn't remove scratch workspace"),
      });
    } finally {
      isDeletingScratchRef.current = false;
      setIsDeletingScratch(false);
    }
  }, [deleteScratchConfirm, removeScratchActionStore]);

  const requestDeleteAllScratches = useCallback(() => {
    if (isDeletingAllScratchesRef.current || deleteAllScratchesConfirm) return;
    if (scratchResults.length === 0) return;
    setDeleteAllScratchesConfirm(
      scratchResults.map((scratch) => ({ id: scratch.id, name: scratch.name }))
    );
  }, [scratchResults, deleteAllScratchesConfirm]);

  const dismissDeleteAllScratchesConfirm = useCallback(() => {
    if (isDeletingAllScratchesRef.current) return;
    setDeleteAllScratchesConfirm(null);
  }, []);

  // A `scratch:removed` push from another window can empty the list under an open
  // dialog. Drop it only once every target is gone — a partially-stale snapshot
  // still has work to do, and shrinking it here would rewrite the count the user
  // already read. Skipped while our own run is in flight, or the last successful
  // removal would tear the dialog down before the summary lands.
  useEffect(() => {
    if (!deleteAllScratchesConfirm || isDeletingAllScratchesRef.current) return;
    const liveIds = new Set(scratches.map((scratch: Scratch) => scratch.id));
    if (deleteAllScratchesConfirm.some((target) => liveIds.has(target.id))) return;
    setDeleteAllScratchesConfirm(null);
  }, [deleteAllScratchesConfirm, scratches]);

  const confirmDeleteAllScratches = useCallback(async () => {
    if (isDeletingAllScratchesRef.current) return;
    const targets = deleteAllScratchesConfirm;
    if (!targets || targets.length === 0) {
      setDeleteAllScratchesConfirm(null);
      return;
    }

    isDeletingAllScratchesRef.current = true;
    setIsDeletingAllScratches(true);

    const total = targets.length;
    const noun = total === 1 ? "scratch workspace" : "scratch workspaces";

    try {
      // Fanned out rather than awaited in sequence: `scratch:remove` has no rate
      // limiter and each scratch owns a disjoint folder, so there is nothing to
      // serialize. `allSettled` also guarantees one bad target can't strand the rest.
      const settled = await Promise.allSettled(
        targets.map((target) => removeScratchActionStore(target.id))
      );

      const failures: { name: string; reason: string }[] = [];
      settled.forEach((outcome, index) => {
        if (outcome.status !== "rejected") return;
        const target = targets[index]!;
        failures.push({
          name: target.name,
          reason: formatErrorMessage(outcome.reason, "Deletion failed"),
        });
        logError(`[ProjectSwitcher] Failed to delete scratch ${target.id}`, outcome.reason);
      });

      const successCount = total - failures.length;
      const firstFailure = failures[0];

      // Close before announcing: VoiceOver drops live-region updates raised from
      // outside a focused `aria-modal` subtree (lesson #9434).
      const close = () => setDeleteAllScratchesConfirm(null);

      if (failures.length === 0) {
        const title = `Deleted ${total} ${noun}`;
        closeAndAnnounce(close, title);
        // Reports the terminals, not the folders: main tombstones the row and then
        // treats `fs.rm` as best-effort, swallowing a failure and leaving cleanup to
        // a later sweep (`ScratchStore.removeScratch`). A resolved call therefore
        // proves the workspace is gone from the app, not that the directory is gone
        // from disk — claiming the latter would be a lie on a locked folder.
        //
        // Transient: the section emptying in front of the user is the real
        // confirmation — this is a one-shot receipt, not an inbox entry.
        notify({
          type: "success",
          title,
          message: total === 1 ? "Its terminals were closed." : "Their terminals were closed.",
          transient: true,
          priority: "high",
          context: { eventKind: "uiFeedback" },
        });
      } else if (successCount === 0) {
        const title = total === 1 ? "Couldn't delete scratch" : "Couldn't delete scratches";
        closeAndAnnounce(close, title, "assertive");
        // No recovery action: the scratch rows survived the failure and are
        // themselves the retry surface.
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title,
          message: firstFailure
            ? `${firstFailure.name}: ${firstFailure.reason}`
            : `All ${total} deletions failed.`,
        });
      } else {
        const title = `Deleted ${successCount} of ${total} ${noun}`;
        closeAndAnnounce(close, title);
        // `priority` is set explicitly: `uiFeedback`'s passive policy would otherwise
        // route this to the inbox, and a partial failure is precisely the outcome the
        // user has to see — the survivors are still sitting in the list.
        notify({
          type: "warning",
          title,
          message:
            failures.length === 1 && firstFailure
              ? `${firstFailure.name} failed: ${firstFailure.reason}`
              : `${failures.length} couldn't be deleted.`,
          priority: "high",
          context: { eventKind: "uiFeedback" },
        });
      }
    } finally {
      isDeletingAllScratchesRef.current = false;
      setIsDeletingAllScratches(false);
    }
  }, [deleteAllScratchesConfirm, removeScratchActionStore]);

  const saveAsProject = useCallback(
    async (scratchId: string) => {
      const scratch = scratchResults.find((s) => s.id === scratchId);
      if (!scratch) return;
      try {
        const result = await scratchClient.saveAsProject(scratchId);
        if (result.status === "cancelled") return;
        await loadProjects();
        setSaveAsProjectConfirm({ scratch, project: result.project });
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Couldn't save scratch as project",
          message: formatErrorMessage(error, "Couldn't save scratch as project"),
        });
      }
    },
    [scratchResults, loadProjects]
  );

  const dismissSaveAsProjectConfirm = useCallback(() => {
    setSaveAsProjectConfirm(null);
  }, []);

  const confirmDeleteOriginalScratch = useCallback(async () => {
    if (!saveAsProjectConfirm || isDeletingOriginalScratch) return;
    setIsDeletingOriginalScratch(true);
    const scratchId = saveAsProjectConfirm.scratch.id;
    try {
      await removeScratchActionStore(scratchId);
      setSaveAsProjectConfirm(null);
    } catch (error) {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Couldn't remove original scratch",
        message: formatErrorMessage(error, "Couldn't remove the original scratch workspace"),
      });
    } finally {
      setIsDeletingOriginalScratch(false);
    }
  }, [saveAsProjectConfirm, isDeletingOriginalScratch, removeScratchActionStore]);

  const confirmRemoveProject = useCallback(async () => {
    if (!removeConfirmProject || isRemovingProject) return;

    setIsRemovingProject(true);

    const capturedId = removeConfirmProject.id;

    try {
      if (removeConfirmProject.isActive) {
        await closeActiveProject(capturedId);
      } else {
        await removeProject(capturedId);
      }
      setRemoveConfirmProject(null);
    } catch (error) {
      const retry = async () => {
        const isActive = useProjectStore.getState().currentProject?.id === capturedId;
        try {
          if (isActive) {
            await closeActiveProject(capturedId);
          } else {
            await removeProject(capturedId);
          }
        } catch (retryError) {
          notify({
            type: "error",
            title: isActive ? "Couldn't close project" : "Couldn't remove project",
            message: formatErrorMessage(
              retryError,
              isActive ? "Couldn't close project" : "Couldn't remove project"
            ),
            actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          });
        }
      };
      notify({
        type: "error",
        title: removeConfirmProject.isActive ? "Couldn't close project" : "Couldn't remove project",
        message: formatErrorMessage(
          error,
          removeConfirmProject.isActive ? "Couldn't close project" : "Couldn't remove project"
        ),
        actions: [{ label: "Try again", variant: "primary", onClick: retry }],
      });
    } finally {
      setIsRemovingProject(false);
    }
  }, [removeConfirmProject, isRemovingProject, closeActiveProject, removeProject]);

  return {
    isOpen,
    mode,
    query,
    results,
    isFiltering,
    isRankedSearch,
    activeProject,
    selectedIndex,
    open,
    close,
    toggle,
    setQuery,
    selectPrevious,
    selectNext,
    selectProject,
    selectRow,
    onHoverProject,
    onHoverProjectEnd,
    confirmSelection,
    addProject,
    cloneRepo,
    stopProject,
    removeProject: removeProjectFromList,
    sleepProject,
    locateProject,
    moveOrRenameProject,
    togglePinProject,
    copyPath,
    stopConfirmProjectId,
    setStopConfirmProjectId,
    confirmStopProject,
    isStoppingProject,
    removeConfirmProject,
    setRemoveConfirmProject,
    confirmRemoveProject,
    isRemovingProject,
    sleepConfirmProject,
    setSleepConfirmProject,
    confirmSleep,
    isSleepingProject,
    backgroundWaitingCount,
    nonActiveAgentCounts,
    fleetLiveness,
    scratchResults,
    createScratch,
    selectScratch,
    deleteScratchConfirm,
    requestDeleteScratch,
    dismissDeleteScratchConfirm,
    confirmDeleteScratch,
    isDeletingScratch,
    deleteAllScratchesConfirm,
    requestDeleteAllScratches,
    dismissDeleteAllScratchesConfirm,
    confirmDeleteAllScratches,
    isDeletingAllScratches,
    renameScratch,
    saveAsProject,
    saveAsProjectConfirm,
    dismissSaveAsProjectConfirm,
    confirmDeleteOriginalScratch,
    isDeletingOriginalScratch,
  };
}
