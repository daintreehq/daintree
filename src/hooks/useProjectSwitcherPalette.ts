import { useState, useCallback, useMemo, useEffect, useRef, useDeferredValue } from "react";
import { rankProjectMatches } from "@/lib/projectSwitcherSearch";
import { buildDisplayPaths } from "@/lib/projectDisplayPath";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useScratchStore } from "@/store/scratchStore";
import { usePaletteStore } from "@/store/paletteStore";
import { useProjectRelocationStore } from "@/store/projectRelocationStore";
import { notify } from "@/lib/notify";
import { closeAndAnnounce } from "@/lib/accessibility";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { logError } from "@/utils/logger";
import type { Project, Scratch } from "@shared/types";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import { decayFrecencyScore, FRECENCY_COLD_START } from "@shared/utils/frecency";
import { projectClient, scratchClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export type ProjectSwitcherMode = "modal" | "dropdown";

/** Lightweight searchable scratch view-model for the palette section. */
export interface SearchableScratch {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastOpened: number;
  isActive: boolean;
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
  "other",
  "unavailable",
] as const;

export type ProjectSectionKey = (typeof PROJECT_SECTION_ORDER)[number];

/**
 * Header text per band. `current` is deliberately unlabelled.
 *
 * "Other projects", not "Recent" or "Frequent": the band is the residual
 * catch-all — frecency-ordered, holding never-opened projects and acknowledged
 * completions alike — so any label naming a sort order would be a lie the row
 * timestamps immediately expose. "Running" requires live agents; projects with
 * only bare processes fall through to Pinned/Other, where their status line
 * still says "Process running".
 */
export const PROJECT_SECTION_LABELS: Record<ProjectSectionKey, string | null> = {
  current: null,
  attention: "Needs attention",
  pinned: "Pinned",
  running: "Running",
  other: "Other projects",
  unavailable: "Unavailable",
};

export interface SearchableProject {
  id: string;
  name: string;
  path: string;
  emoji: string;
  color?: string;
  lastOpened: number;
  status: Project["status"];
  /** Set when the project was auto-closed by the background-idle sweep (#10830). */
  autoParkedAt?: number;
  isActive: boolean;
  isBackground: boolean;
  isMissing: boolean;
  isPinned: boolean;
  /**
   * Effective (read-time decayed) frecency, computed against one shared `now`
   * per list build — never the raw persisted snapshot.
   */
  frecencyScore: number;
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
  /** Latest transition into `working`, absent when nothing is working. */
  latestWorkingSince?: number;
  processCount: number;
  displayPath: string;
  /** Browse band. Not meaningful while searching, where rank order wins. */
  section: ProjectSectionKey;
}

export interface UseProjectSwitcherPaletteReturn {
  isOpen: boolean;
  mode: ProjectSwitcherMode;
  query: string;
  /**
   * The projects the palette renders, in render order — and the only array
   * `selectedIndex` may be read against. Every mode lists every registered
   * project: browse is section-ordered (see {@link PROJECT_SECTION_ORDER}) and
   * search is rank-ordered, but neither is scoped or capped.
   */
  results: SearchableProject[];
  /** True while `deferredQuery` has not yet caught up to `query` — the results shown are from the previous query. */
  isFiltering: boolean;
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
  freeMemoryProject: (projectId: string) => Promise<void>;
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
   * Frozen snapshot of the project pending a "Free memory" confirmation —
   * captured at menu-select time so the dialog's process/agent counts don't
   * drift if agents finish while the dialog is open (lesson #8725). Null when
   * no confirm is pending (D0 path runs without it).
   */
  freeMemoryConfirmProject: SearchableProject | null;
  setFreeMemoryConfirmProject: (project: SearchableProject | null) => void;
  confirmFreeMemory: () => Promise<void>;
  isFreeingMemory: boolean;
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
    /** Non-active projects with at least one waiting agent — the badge's number. */
    attentionProjectCount: number;
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
  /** Remove a scratch (deletes folder + DB row). Used by context menu. */
  removeScratchAction: (scratchId: string) => Promise<void>;
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
 * Assign a project to its browse band. Actionable work first, then explicit
 * user intent, then non-actionable system activity, then habit:
 *
 * - `attention` is the action queue — agents blocked, waiting on input, or
 *   finished-and-unreviewed. A completed agent has handed responsibility back
 *   to the user, which outranks agents that are merely running.
 * - `pinned` sits above `running`: an explicit pin is a stronger signal than
 *   the operational fact that something is executing. A pinned running project
 *   stays in Pinned; its status line still says "Agent running".
 * - `running` requires live agents. Bare leftover processes are residency, not
 *   intent — those projects fall through to Pinned/Other.
 */
function sectionForProject(project: SearchableProject): ProjectSectionKey {
  if (project.isActive) return "current";
  if (project.isMissing) return "unavailable";
  if (
    project.waitingAgentCount > 0 ||
    project.blockedAgentCount > 0 ||
    project.unacknowledgedCompletedAgentCount > 0
  ) {
    return "attention";
  }
  if (project.isPinned) return "pinned";
  if (project.activeAgentCount > 0) return "running";
  return "other";
}

/**
 * Severity tier inside the attention band: blocked outranks waiting outranks
 * ready-for-review. Blocked agents may not restart on input; waiting agents
 * are stalled on the user; completed agents are done and can wait their turn.
 */
function attentionClass(project: SearchableProject): number {
  if (project.blockedAgentCount > 0) return 0;
  if (project.waitingAgentCount > 0) return 1;
  return 2;
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
 * - Other (and the single-row current): effective frecency.
 */
function compareWithinSection(a: SearchableProject, b: SearchableProject): number {
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
      const aSince = a.oldestWaitingSince ?? Number.POSITIVE_INFINITY;
      const bSince = b.oldestWaitingSince ?? Number.POSITIVE_INFINITY;
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
    const aWorking = a.latestWorkingSince ?? 0;
    const bWorking = b.latestWorkingSince ?? 0;
    if (aWorking !== bWorking) return bWorking - aWorking;
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
 * the browse-to-search transition doesn't flash "No projects match" over the
 * previous list on the first keystroke.
 */
function buildResults(
  browseOrdered: SearchableProject[],
  rankQuery: string,
  isSearching: boolean
): SearchableProject[] {
  if (isSearching && rankQuery.trim()) {
    return rankProjectMatches(rankQuery, browseOrdered);
  }
  return browseOrdered;
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
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [stopConfirmProjectId, setStopConfirmProjectId] = useState<string | null>(null);
  const [isStoppingProject, setIsStoppingProject] = useState(false);
  const [removeConfirmProject, setRemoveConfirmProject] = useState<SearchableProject | null>(null);
  const [isRemovingProject, setIsRemovingProject] = useState(false);
  const [freeMemoryConfirmProject, setFreeMemoryConfirmProject] =
    useState<SearchableProject | null>(null);
  const [isFreeingMemory, setIsFreeingMemory] = useState(false);
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
    void loadScratches();
    // Pull a fresh agent-status snapshot on open so rows show live status
    // immediately instead of waiting for the next passive broadcast, which
    // would otherwise leave them falling back to a stale relative timestamp.
    void loadProjects()
      .then(() => {
        const ids = useProjectStore.getState().projects.map((p) => p.id);
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
              processCount: entry.processCount,
            };
            changed = true;
          }
          if (changed) useProjectStatsStore.getState().setStats(seeded);
        });
      })
      .catch(() => {
        // Project load or stats refresh failed; rows fall back to the relative
        // timestamp. This background freshness pull must never surface an error.
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
        processCount: stats?.processCount ?? 0,
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
    // Projects, not agents. The badge answers "how many places need me?" — a
    // number that stays legible while eight agents wait in one repo, where an
    // agent tally would read as eight separate obligations.
    let attentionProjectCount = 0;
    for (const project of searchableProjects) {
      if (project.isActive) continue;
      activeAgentCount += project.activeAgentCount;
      waitingAgentCount += project.waitingAgentCount;
      if (project.waitingAgentCount > 0) attentionProjectCount += 1;
    }
    return { activeAgentCount, waitingAgentCount, attentionProjectCount };
  }, [searchableProjects]);

  const liveBrowseOrder = useMemo<SearchableProject[]>(() => {
    return [...searchableProjects].sort((a, b) => {
      if (a.section !== b.section) {
        return PROJECT_SECTION_ORDER.indexOf(a.section) - PROJECT_SECTION_ORDER.indexOf(b.section);
      }
      return compareWithinSection(a, b);
    });
  }, [searchableProjects]);

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
  const [frozenLayout, setFrozenLayout] = useState<{
    order: string[];
    sections: Map<string, ProjectSectionKey>;
  } | null>(null);

  const captureLayout = useCallback(
    (projects: SearchableProject[]) => ({
      order: projects.map((project) => project.id),
      sections: new Map(projects.map((project) => [project.id, project.section])),
    }),
    []
  );

  // Fold projects that appeared after the freeze into it, at the position the
  // renderer already gives them (end of their live band). Without this they are
  // the one part of the list still re-banding on every stats push, so the freeze
  // the palette advertises would hold for the session's original rows only.
  useEffect(() => {
    if (!frozenLayout) return;
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
      return { order, sections };
    });
  }, [liveBrowseOrder, frozenLayout]);

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

  // Clearing the box reverts to browse immediately rather than holding the
  // deferred ranking for a commit — otherwise browse would flash the stale
  // search ranking on the way back to an empty query.
  const resultsQuery = isSearching ? deferredQuery : "";

  const results = useMemo<SearchableProject[]>(
    () => buildResults(browseOrdered, resultsQuery, isSearching),
    [browseOrdered, resultsQuery, isSearching]
  );

  // The selected PROJECT is the state; its index is derived. Tracking an index
  // instead would let it outlive the row it pointed at — a list that shrinks
  // under an open palette (a project closing, a stats push) would leave the
  // index addressing a different project than the user selected, and Enter
  // would commit that one (#11071). Deriving means the highlight follows the
  // project across reorders and never addresses a row that isn't rendered.
  const selectedIndex = useMemo(() => {
    if (results.length === 0) return 0;
    const index = selectedProjectId
      ? results.findIndex((project) => project.id === selectedProjectId)
      : -1;
    return index >= 0 ? index : 0;
  }, [results, selectedProjectId]);

  // Decoupled from `results` so the toolbar pill keeps the active project's
  // pin/process state even when the current search filters it out.
  const activeProject = useMemo<SearchableProject | null>(
    () => searchableProjects.find((p) => p.isActive) ?? null,
    [searchableProjects]
  );

  // A new query re-ranks the list, so fall back to the top match.
  useEffect(() => {
    if (query) {
      setSelectedProjectId(null);
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
    if (!freeMemoryConfirmProject) return;
    const stillExists = searchableProjects.some((p) => p.id === freeMemoryConfirmProject.id);
    if (!stillExists) {
      setFreeMemoryConfirmProject(null);
    }
  }, [freeMemoryConfirmProject, searchableProjects]);

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
      setFrozenLayout(captureLayout(liveBrowseOrder));
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
      setSelectedProjectId(initial?.id ?? null);
    },
    [liveBrowseOrder, captureLayout]
  );

  const close = useCallback(() => {
    if (mode === "modal") {
      usePaletteStore.getState().closePalette("project-switcher");
    } else {
      setDropdownIsOpen(false);
    }
    setQuery("");
    setSelectedProjectId(null);
    setFrozenLayout(null);
  }, [mode]);

  // Steps the selection by `delta` rows, wrapping. Resolves the current row
  // from the id inside the updater so two calls batched into one tick compose
  // (the second sees where the first landed) instead of collapsing into one.
  const step = useCallback(
    (delta: number) => {
      if (results.length === 0) return;
      setSelectedProjectId((previousId) => {
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
    selectProject(results[selectedIndex]!);
  }, [results, selectedIndex, selectProject]);

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

  const doFreeMemory = useCallback(
    async (projectId: string) => {
      const run = () => projectClient.freeMemory(projectId).then(() => loadProjects());
      try {
        await run();
      } catch (error) {
        const retry = async () => {
          try {
            await run();
          } catch (retryError) {
            notify({
              type: "error",
              title: "Couldn't free memory",
              message: formatErrorMessage(retryError, "Couldn't free the project's memory"),
              actions: [{ label: "Try again", variant: "primary", onClick: retry }],
              context: { eventKind: "uiFeedback" },
            });
          }
        };
        notify({
          type: "error",
          title: "Couldn't free memory",
          message: formatErrorMessage(error, "Couldn't free the project's memory"),
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          context: { eventKind: "uiFeedback" },
        });
      }
    },
    [loadProjects]
  );

  const freeMemoryProject = useCallback(
    async (projectId: string) => {
      const project = searchableProjects.find((p) => p.id === projectId);
      if (!project) return;

      // The active project can't free its own renderer/host — surface the
      // same guidance the backend guard enforces instead of a silent no-op.
      if (project.isActive) {
        notify({
          type: "info",
          title: "Switch away first",
          message: "Switch to another project to free this one's memory.",
          context: { eventKind: "uiFeedback" },
        });
        return;
      }

      close();

      const hasProcesses =
        project.processCount > 0 || project.activeAgentCount > 0 || project.waitingAgentCount > 0;

      // D1 (confirm) when live processes would be stopped; D0 (immediate) when
      // there's nothing running to interrupt. The snapshot freezes the counts.
      if (hasProcesses) {
        setFreeMemoryConfirmProject(project);
      } else {
        await doFreeMemory(projectId);
      }
    },
    [searchableProjects, close, doFreeMemory]
  );

  const confirmFreeMemory = useCallback(async () => {
    if (!freeMemoryConfirmProject || isFreeingMemory) return;
    setIsFreeingMemory(true);
    const capturedId = freeMemoryConfirmProject.id;
    try {
      await doFreeMemory(capturedId);
      setFreeMemoryConfirmProject(null);
    } finally {
      setIsFreeingMemory(false);
    }
  }, [freeMemoryConfirmProject, isFreeingMemory, doFreeMemory]);

  const scratchResults = useMemo<SearchableScratch[]>(() => {
    const list: SearchableScratch[] = scratches.map((s: Scratch) => ({
      id: s.id,
      name: s.name,
      path: s.path,
      createdAt: s.createdAt,
      lastOpened: s.lastOpened,
      isActive: currentScratch?.id === s.id,
    }));
    list.sort((a, b) => b.lastOpened - a.lastOpened);
    return list;
  }, [scratches, currentScratch?.id]);

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

  const removeScratchAction = useCallback(
    async (scratchId: string) => {
      try {
        await removeScratchActionStore(scratchId);
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Couldn't remove scratch",
          message: formatErrorMessage(error, "Couldn't remove scratch workspace"),
        });
      }
    },
    [removeScratchActionStore]
  );

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
    activeProject,
    selectedIndex,
    open,
    close,
    toggle,
    setQuery,
    selectPrevious,
    selectNext,
    selectProject,
    onHoverProject,
    onHoverProjectEnd,
    confirmSelection,
    addProject,
    cloneRepo,
    stopProject,
    removeProject: removeProjectFromList,
    freeMemoryProject,
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
    freeMemoryConfirmProject,
    setFreeMemoryConfirmProject,
    confirmFreeMemory,
    isFreeingMemory,
    backgroundWaitingCount,
    nonActiveAgentCounts,
    scratchResults,
    createScratch,
    selectScratch,
    removeScratchAction,
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
