import { useState, useCallback, useMemo, useEffect, useRef, useDeferredValue } from "react";
import { rankProjectMatches } from "@/lib/projectSwitcherSearch";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useScratchStore } from "@/store/scratchStore";
import { usePaletteStore } from "@/store/paletteStore";
import { notify } from "@/lib/notify";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import type { Project, Scratch } from "@shared/types";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
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
  frecencyScore: number;
  activeAgentCount: number;
  waitingAgentCount: number;
  processCount: number;
  displayPath: string;
}

export interface UseProjectSwitcherPaletteReturn {
  isOpen: boolean;
  mode: ProjectSwitcherMode;
  query: string;
  /**
   * The projects the palette renders, in render order — and the only array
   * `selectedIndex` may be read against. In modal browse this is scoped to the
   * projects the user can switch between right now; the dropdown and every
   * search list the full set.
   */
  results: SearchableProject[];
  /** True while `deferredQuery` has not yet caught up to `query` — the results shown are from the previous query. */
  isFiltering: boolean;
  /**
   * The currently active project as a `SearchableProject`, with stats and
   * pin/missing flags enriched. Decoupled from `results` so callers (e.g. the
   * toolbar pill context menu) can read pin/processCount/etc. even when the
   * active project sits outside the 15-item results window or is filtered out
   * by the current `query`.
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
  locateProject: (projectId: string) => Promise<void>;
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
  nonActiveAgentCounts: { activeAgentCount: number; waitingAgentCount: number };
  /** Scratch (one-off agent workspace) view-models, sorted by lastOpened desc. */
  scratchResults: SearchableScratch[];
  /** Create and immediately switch to a new scratch. Closes the palette on success. */
  createScratch: () => Promise<void>;
  /** Switch to an existing scratch. Closes the palette on success. */
  selectScratch: (scratch: SearchableScratch) => Promise<void>;
  /** Remove a scratch (deletes folder + DB row). Used by context menu. */
  removeScratchAction: (scratchId: string) => Promise<void>;
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

const MAX_RESULTS = 15;

/**
 * Modal browse lists only the projects the user can switch between right now.
 * Deliberately not named "switchable": the active project matches too, and
 * `selectProject` is a no-op for it.
 */
function isVisibleInModalBrowse(project: SearchableProject): boolean {
  return project.isActive || project.isBackground || project.processCount > 0;
}

/**
 * Builds the palette's one array — the rows that render AND the rows the
 * arrow keys walk. Rank (when searching), then scope, then cap: the cap
 * belongs to the eligible set, so a background project sitting past the first
 * 15 unscoped rows still surfaces in modal browse.
 */
function buildResults(
  sortedProjects: SearchableProject[],
  mode: ProjectSwitcherMode,
  query: string
): SearchableProject[] {
  const trimmed = query.trim();
  const ranked = trimmed ? rankProjectMatches(query, sortedProjects) : sortedProjects;
  const scoped = mode === "modal" && !trimmed ? ranked.filter(isVisibleInModalBrowse) : ranked;
  return scoped.slice(0, MAX_RESULTS);
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
  const isFiltering = query !== deferredQuery;
  const [selectedIndexState, setSelectedIndex] = useState(0);
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
  const selectedProjectIdRef = useRef<string | null>(null);

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
  const locateProjectFn = useProjectStore((state) => state.locateProject);
  const projectStats = useProjectStatsStore((state) => state.stats);

  const { copy: copyToClipboard } = useCopyWithFeedback();

  const scratches = useScratchStore((state) => state.scratches);
  const currentScratch = useScratchStore((state) => state.currentScratch);
  const loadScratches = useScratchStore((state) => state.loadScratches);
  const createScratchAction = useScratchStore((state) => state.createScratch);
  const switchScratchAction = useScratchStore((state) => state.switchScratch);
  const removeScratchActionStore = useScratchStore((state) => state.removeScratch);

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
          const map: ProjectStatusMap = {};
          for (const [id, entry] of Object.entries(bulk)) {
            map[id] = {
              activeAgentCount: entry.activeAgentCount,
              waitingAgentCount: entry.waitingAgentCount,
              processCount: entry.processCount,
            };
          }
          useProjectStatsStore.getState().setStats(map);
        });
      })
      .catch(() => {
        // Project load or stats refresh failed; rows fall back to the relative
        // timestamp. This background freshness pull must never surface an error.
      });
  }, [isOpen, loadProjects, loadScratches]);

  const searchableProjects = useMemo<SearchableProject[]>(() => {
    return projects.map((p) => {
      const stats = projectStats[p.id];
      const isActive = p.id === currentProject?.id;
      const isMissing = p.status === "missing";
      const hasProcesses = (stats?.processCount ?? 0) > 0;
      const isBackground = p.status === "background" || (!isActive && !isMissing && hasProcesses);

      return {
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
        frecencyScore: p.frecencyScore ?? 3.0,
        activeAgentCount: stats?.activeAgentCount ?? 0,
        waitingAgentCount: stats?.waitingAgentCount ?? 0,
        processCount: stats?.processCount ?? 0,
        displayPath: p.path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p.path,
      };
    });
  }, [projects, projectStats, currentProject?.id]);

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
    for (const project of searchableProjects) {
      if (project.isActive) continue;
      activeAgentCount += project.activeAgentCount;
      waitingAgentCount += project.waitingAgentCount;
    }
    return { activeAgentCount, waitingAgentCount };
  }, [searchableProjects]);

  const sortedProjects = useMemo<SearchableProject[]>(() => {
    return [...searchableProjects].sort((a, b) => {
      if (a.lastOpened !== b.lastOpened) {
        return b.lastOpened - a.lastOpened;
      }
      return a.name.localeCompare(b.name);
    });
  }, [searchableProjects]);

  // Clearing the box reverts to browse immediately rather than holding the
  // deferred search for a commit — otherwise modal browse would flash the
  // unscoped search results on the way back to an empty query.
  const resultsQuery = query.trim() ? deferredQuery : "";

  const results = useMemo<SearchableProject[]>(
    () => buildResults(sortedProjects, mode, resultsQuery),
    [sortedProjects, mode, resultsQuery]
  );

  // `selectedIndex` state can outrun `results` for a commit when a stats push
  // shrinks the list, and the resync effect below only lands after paint.
  // Clamping on read keeps every consumer — highlight, aria-activedescendant,
  // Enter — pointed at a row that is actually on screen.
  const selectedIndex =
    results.length === 0 ? 0 : Math.min(Math.max(selectedIndexState, 0), results.length - 1);

  // Decoupled from `results` so the toolbar pill keeps the active project's
  // pin/process state even when search filters exclude it or it sits outside
  // the MAX_RESULTS window.
  const activeProject = useMemo<SearchableProject | null>(
    () => searchableProjects.find((p) => p.isActive) ?? null,
    [searchableProjects]
  );

  useEffect(() => {
    if (results.length === 0) {
      selectedProjectIdRef.current = null;
      setSelectedIndex(0);
      return;
    }

    const selectedId = selectedProjectIdRef.current;
    if (selectedId) {
      const nextIndex = results.findIndex((project) => project.id === selectedId);
      if (nextIndex >= 0) {
        setSelectedIndex((prev) => (prev === nextIndex ? prev : nextIndex));
        return;
      }
    }

    setSelectedIndex((prev) => Math.min(prev, results.length - 1));
  }, [results]);

  useEffect(() => {
    if (results.length === 0) return;
    selectedProjectIdRef.current = results[selectedIndex]!.id;
  }, [results, selectedIndex]);

  useEffect(() => {
    if (query) {
      selectedProjectIdRef.current = null;
      setSelectedIndex(0);
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
      selectedProjectIdRef.current = null;
      // Preselect row 2 (the MRU switch target) against the list the palette is
      // about to render. `mode` state hasn't committed yet, so `results` still
      // describes the mode we're leaving — build the destination list instead.
      const initialResults = buildResults(sortedProjects, nextMode, "");
      setSelectedIndex(initialResults.length >= 2 ? 1 : 0);
    },
    [sortedProjects]
  );

  const close = useCallback(() => {
    if (mode === "modal") {
      usePaletteStore.getState().closePalette("project-switcher");
    } else {
      setDropdownIsOpen(false);
    }
    setQuery("");
    setSelectedIndex(0);
  }, [mode]);

  const toggle = useCallback(
    (nextMode: ProjectSwitcherMode = "modal") => {
      const currentlyOpen = nextMode === "modal" ? modalIsOpen : dropdownIsOpen;
      if (currentlyOpen) {
        if (results.length <= 1) return;
        const next = selectedIndex + 1;
        setSelectedIndex(next >= results.length ? 0 : next);
      } else {
        open(nextMode);
      }
    },
    [modalIsOpen, dropdownIsOpen, open, results.length, selectedIndex]
  );

  const selectPrevious = useCallback(() => {
    if (results.length === 0) return;
    setSelectedIndex(selectedIndex <= 0 ? results.length - 1 : selectedIndex - 1);
  }, [results.length, selectedIndex]);

  const selectNext = useCallback(() => {
    if (results.length === 0) return;
    setSelectedIndex(selectedIndex >= results.length - 1 ? 0 : selectedIndex + 1);
  }, [results.length, selectedIndex]);

  const selectProject = useCallback(
    async (project: SearchableProject) => {
      if (project.isActive || project.isMissing) {
        return;
      }

      close();

      if (project.isBackground) {
        void reopenProject(project.id);
      } else {
        void switchProject(project.id);
      }
    },
    [close, switchProject, reopenProject]
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

  const locateProject = useCallback(
    async (projectId: string) => {
      await locateProjectFn(projectId);
    },
    [locateProjectFn]
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

  const createScratch = useCallback(async () => {
    close();
    try {
      const created = await createScratchAction();
      await switchScratchAction(created.id);
    } catch (error) {
      const retry = async () => {
        try {
          const created = await createScratchAction();
          await switchScratchAction(created.id);
        } catch (retryError) {
          notify({
            type: "error",
            title: "Couldn't create scratch",
            message: formatErrorMessage(retryError, "Couldn't create scratch workspace"),
            actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          });
        }
      };
      notify({
        type: "error",
        title: "Couldn't create scratch",
        message: formatErrorMessage(error, "Couldn't create scratch workspace"),
        actions: [{ label: "Try again", variant: "primary", onClick: retry }],
      });
    }
  }, [close, createScratchAction, switchScratchAction]);

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
    saveAsProject,
    saveAsProjectConfirm,
    dismissSaveAsProjectConfirm,
    confirmDeleteOriginalScratch,
    isDeletingOriginalScratch,
  };
}
