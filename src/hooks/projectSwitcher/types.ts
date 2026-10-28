import type { Project } from "@shared/types";
import type { ProjectGroup } from "@shared/types/project";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { ProjectPresenceState } from "@shared/types/ipc/projectPresence";
import type { ProjectGroupBandKey } from "@/lib/projectGroupBands";

export type ProjectSwitcherMode = "modal" | "dropdown";
/** How a palette row was committed — only the perf-trace entry point reads it. */
export type ProjectSwitchSelectSource = "keyboard" | "pointer";

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
  "archived",
  "unavailable",
] as const;

export type ProjectSectionKey = (typeof PROJECT_SECTION_ORDER)[number];

/**
 * Every band a project row can render under: the built-in sections plus one
 * per user-made group. Groups sit between Snoozed and Other projects, in the
 * user's order — see {@link buildBandRanks}.
 */
export type ProjectBandKey = ProjectSectionKey | ProjectGroupBandKey;

export interface SearchableProject extends WorkspaceRowStatusFields {
  id: string;
  name: string;
  path: string;
  emoji: string;
  color?: string;
  status: Project["status"];
  /** Set when the project was auto-closed by the background-idle sweep (#10830). */
  autoParkedAt?: number;
  /** Opted out of the background-idle sweep; manual Sleep still works. */
  neverAutoSleep?: boolean;
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
   * Filed away by the user. Live work still lifts it out of the Archived band.
   * Absent reads as not archived.
   */
  isArchived?: boolean;
  /**
   * The group this project is filed under, resolved against the live group
   * list — an id naming a deleted group is dropped here, so a row never claims
   * membership of a band that doesn't exist.
   */
  groupId?: string;
  /** Name of {@link groupId}'s group, for search matching and the result label. */
  groupName?: string;
  /**
   * Another window owns this project, so picking it goes to that window rather
   * than opening it here (#12597). Absent when no other window holds it, and
   * until main has answered. Never set on the current project: `isActive`
   * keeps meaning "current in this window", and this is its own field.
   *
   * Advisory — the switch re-checks ownership when it runs, so a stale value
   * costs a wrong label, never a duplicate view.
   */
  openInOtherWindow?: ProjectPresenceState;
  /**
   * This window already holds a view of the project — the current one, or one
   * it keeps cached.
   */
  isOpenInThisWindow?: boolean;
  /**
   * The view this window holds is only cached, in the background. Asking for a
   * new window moves it there (#13274), where one in front or still activating
   * has no second window to go to.
   */
  isCachedInThisWindow?: boolean;
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
  section: ProjectBandKey;
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

/**
 * One browse band, WITHOUT its rows.
 *
 * A collapsed band contributes nothing to {@link UseProjectSwitcherPaletteReturn.results},
 * so its header would vanish along with its rows and leave no way to unfold it
 * again. This carries the header's facts — which bands exist, and how many
 * projects each is holding — separately from the array the arrow keys walk, so
 * bands stay a *view* over `results` rather than a second, wider list (#11071).
 */
export interface ProjectSwitcherBrowseBand {
  key: ProjectBandKey;
  label: string;
  /** Projects in the band, collapsed or not — what the header's count reports. */
  itemCount: number;
  collapsed: boolean;
  /** Set on a user-made group's band; the header's menu acts on it. */
  group?: ProjectGroup;
  /**
   * Group members rendering in a band above this one — current, asking, or
   * pinned. What an otherwise empty group says instead of looking abandoned.
   * Absent reads as none.
   */
  liftedCount?: number;
  /**
   * Agents running across the band's projects. A folded group keeps its
   * running members in place rather than lifting them out, so its header has
   * to say they're there. Absent reads as none.
   */
  activeAgentCount?: number;
  /**
   * Projects in the band whose assistant is working. Counted apart from
   * `activeAgentCount` — an assistant is not a run the user launched — but it
   * is live work all the same, and a folded group must not hide it.
   */
  workingAssistantCount?: number;
}

export interface UseProjectSwitcherPaletteReturn {
  isOpen: boolean;
  mode: ProjectSwitcherMode;
  query: string;
  /**
   * The rows the palette renders, in render order — and the only array
   * `selectedIndex` may be read against. Browse is section-ordered (see
   * {@link PROJECT_SECTION_ORDER}) and search is rank-ordered; neither is
   * capped.
   *
   * Browse omits the rows of bands the user has folded away, which is what
   * keeps every entry a RENDERED row: the highlight, `aria-activedescendant`
   * and Enter all address this array, and none of them may name a row that is
   * not on screen (#11071). Collapsed bands keep their headers via
   * {@link browseBands}. Search never applies the collapse — a query that
   * silently skipped its own matches would be worse than a band unfolding.
   *
   * Browse rows are all projects; the scratches belong to the pinned section
   * below the list. Search rows are mixed, so a scratch is reachable by name
   * from the keyboard (#11466) — narrow on `kind` before touching anything a
   * scratch doesn't have.
   */
  results: ProjectSwitcherRow[];
  /**
   * Every browse band in render order, including ones holding no visible rows
   * because the user collapsed them. Always describes the BROWSE layout — a
   * surface rendering the ranked search list ignores it, since search has no
   * bands. See {@link ProjectSwitcherBrowseBand}.
   */
  browseBands: ProjectSwitcherBrowseBand[];
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
  /**
   * Moves the cursor to the row the pointer is over, by id — the same state the
   * arrow keys drive, so there is only ever one highlighted row.
   */
  hoverRow: (rowId: string) => void;
  selectProject: (project: SearchableProject, source?: ProjectSwitchSelectSource) => void;
  /**
   * Commits a row of {@link results}, dispatching on its kind. The palette's
   * primary select handler — a surface that renders `results` must use this
   * rather than `selectProject`, which cannot accept a scratch row.
   */
  selectRow: (row: ProjectSwitcherRow, source?: ProjectSwitchSelectSource) => void;
  /**
   * Schedule a 150ms trailing-edge hover prefetch that primes the
   * main-process hydrate cache for `projectId`. Mouse-only — touch and pen
   * pointers are ignored. Does nothing for the currently active project or
   * for projects flagged as missing.
   */
  onHoverProject: (projectId: string, pointerType: string) => void;
  /** Cancel any pending hover prefetch for `projectId`. */
  onHoverProjectEnd: (pointerType: string) => void;
  /**
   * Asked by the anchored dropdown once per close. Answers true — and disarms —
   * only for the close that committed a switch, so that close does not bounce
   * focus back to the toolbar pill: the view is about to be parked, and a
   * warm return would otherwise send keystrokes to a button.
   */
  consumeCloseAutoFocusSuppression: () => boolean;
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
  /**
   * Close the picker and run `project.restart`, whose confirmation is the
   * app-level sleep dialog: an open picker would sit over it.
   */
  restartProject: (projectId: string) => void;
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
