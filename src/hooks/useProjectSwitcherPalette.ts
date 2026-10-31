import { useState, useCallback, useMemo, useEffect, useRef, useDeferredValue } from "react";
import { buildDisplayPaths } from "@/lib/projectDisplayPath";
import { useProjectStore } from "@/store/projectStore";
import { beginSwitchTrace } from "@/utils/switchTrace";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useScratchStore } from "@/store/scratchStore";
import { usePaletteStore } from "@/store/paletteStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";
import { useProjectRelocationStore } from "@/store/projectRelocationStore";
import { notify } from "@/lib/notify";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { classifyAssistantActivity } from "@/lib/projectAssistantActivity";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { Project } from "@shared/types";
import {
  buildBandRanks,
  buildBrowseBands,
  buildResults,
  buildScratchResults,
  buildSearchableProjects,
  isBandCollapsed,
  makeSortModeFor,
  sortBrowseOrder,
  toProjectRow,
  toSearchableProject,
} from "./projectSwitcher/ordering";
import { useFrozenSwitcherLayout } from "./projectSwitcher/useFrozenSwitcherLayout";
import { useProjectHoverPrefetch } from "./projectSwitcher/useProjectHoverPrefetch";
import { useProjectSwitcherHydration } from "./projectSwitcher/useProjectSwitcherHydration";
import { useProjectSwitcherProjectMutations } from "./projectSwitcher/useProjectSwitcherProjectMutations";
import { useProjectSwitcherScratchMutations } from "./projectSwitcher/useProjectSwitcherScratchMutations";
import type {
  ProjectSwitcherBrowseBand,
  ProjectSwitcherMode,
  ProjectSwitcherRow,
  ProjectSwitchSelectSource,
  SearchableProject,
  SearchableScratch,
  UseProjectSwitcherPaletteReturn,
} from "./projectSwitcher/types";

export {
  PROJECT_SECTION_ORDER,
  type DeleteAllScratchesSnapshot,
  type DeleteScratchTarget,
  type ProjectBandKey,
  type ProjectSectionKey,
  type ProjectSwitcherBrowseBand,
  type ProjectSwitcherMode,
  type ProjectSwitcherProjectRow,
  type ProjectSwitcherRow,
  type ProjectSwitcherScratchRow,
  type ProjectSwitchSelectSource,
  type SaveAsProjectFollowUp,
  type SearchableProject,
  type SearchableScratch,
  type UseProjectSwitcherPaletteReturn,
  type WorkspaceRowStatusFields,
} from "./projectSwitcher/types";
export {
  buildBandRanks,
  isBandCollapsed,
  isSortableBand,
  OTHER_PROJECTS_SORT_CONTROL_MIN_ROWS,
  PROJECT_SECTION_LABELS,
  PROJECT_SWITCHER_SCRATCH_BAND_KEY,
  type ProjectSwitcherBandKey,
} from "./projectSwitcher/ordering";

export interface UseProjectSwitcherPaletteOptions {
  /**
   * Keep the stats-derived fields live while the palette is closed. Only a
   * caller that renders them from a closed palette — a trigger badge — needs
   * this; see `projectStats` below for why it is off by default.
   */
  liveStatsWhileClosed?: boolean;
}

/** Where the highlight sits with no row chosen: the top match, or in browse the first row elsewhere. */
function defaultRowIndex(results: readonly ProjectSwitcherRow[], ranked: boolean): number {
  if (ranked) return 0;
  const index = results.findIndex(
    (row) => !row.isActive && !(row.kind === "project" && row.isMissing)
  );
  return index >= 0 ? index : 0;
}

export function useProjectSwitcherPalette({
  liveStatsWhileClosed = false,
}: UseProjectSwitcherPaletteOptions = {}): UseProjectSwitcherPaletteReturn {
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
  const suppressCloseAutoFocusRef = useRef(false);

  const projects = useProjectStore((state) => state.projects);
  const currentProject = useProjectStore((state) => state.currentProject);
  const switchProject = useProjectStore((state) => state.switchProject);
  const reopenProject = useProjectStore((state) => state.reopenProject);
  const addProjectFn = useProjectStore((state) => state.addProject);
  const openRelocation = useProjectRelocationStore((state) => state.open);
  const { copy: copyToClipboard } = useCopyWithFeedback({ announcement: false });
  const { projectStats, presenceByProjectId } = useProjectSwitcherHydration({
    isOpen,
    liveStatsWhileClosed,
  });

  const scratches = useScratchStore((state) => state.scratches);
  const currentScratch = useScratchStore((state) => state.currentScratch);
  const switchScratchAction = useScratchStore((state) => state.switchScratch);

  const displayPathById = useMemo(() => buildDisplayPaths(projects), [projects]);

  const projectGroups = useProjectGroupsStore((state) => state.groups);
  useEffect(() => useProjectGroupsStore.getState().init(), []);
  const groupsById = useMemo(
    () => new Map(projectGroups.map((group) => [group.id, group])),
    [projectGroups]
  );
  const bandRanks = useMemo(() => buildBandRanks(projectGroups), [projectGroups]);

  // What every row is built against, minus the clock: `buildSearchableProjects`
  // takes its own `now` per build.
  const rowContext = useMemo(
    () => ({
      currentProjectId: currentProject?.id,
      displayPathById,
      presenceByProjectId,
      groupsById,
    }),
    [currentProject?.id, displayPathById, presenceByProjectId, groupsById]
  );

  const searchableProjects = useMemo<SearchableProject[]>(
    () =>
      buildSearchableProjects(projects, projectStats, { ...rowContext, frecencyNow: Date.now() }),
    [projects, projectStats, rowContext]
  );

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
  const collapsedBands = usePreferencesStore((state) => state.projectSwitcherCollapsedBands);

  const sortModeFor = useMemo(
    () => makeSortModeFor(otherProjectsSortMode, groupsById),
    [otherProjectsSortMode, groupsById]
  );

  const liveBrowseOrder = useMemo<SearchableProject[]>(
    () => sortBrowseOrder(searchableProjects, sortModeFor, bandRanks),
    [searchableProjects, sortModeFor, bandRanks]
  );

  // Recency order, which is what the pinned browse section renders. Search takes
  // this same list but re-ranks it against the query (#11466), so it has to be
  // built before `results` rather than beside the other scratch callbacks below.
  const scratchResults = useMemo<SearchableScratch[]>(
    () => buildScratchResults(scratches, currentScratch?.id, projectStats),
    [scratches, currentScratch?.id, projectStats]
  );

  const { browseOrdered, searchActivityKeys, freeze, thaw } = useFrozenSwitcherLayout({
    isOpen,
    isSearching,
    liveBrowseOrder,
    searchableProjects,
    scratchResults,
    projectStats,
    otherProjectsSortMode,
    projectGroups,
    sortModeFor,
    bandRanks,
    setSelectedRowId,
  });

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

  const browseBands = useMemo<ProjectSwitcherBrowseBand[]>(
    () => buildBrowseBands(browseOrdered, collapsedBands, groupsById, projectGroups, bandRanks),
    [browseOrdered, collapsedBands, groupsById, projectGroups, bandRanks]
  );

  // Held apart from `browseRows` so an all-expanded switcher — the default, and
  // the common case — keeps browse's array identity stable rather than minting
  // a filtered copy on every unrelated re-render.
  const hasCollapsedBand = useMemo(() => browseBands.some((band) => band.collapsed), [browseBands]);

  const visibleBrowseRows = useMemo<ProjectSwitcherRow[]>(() => {
    if (!hasCollapsedBand) return browseRows;
    return browseRows.filter(
      (row) => row.kind !== "project" || !isBandCollapsed(collapsedBands, row.section)
    );
  }, [browseRows, hasCollapsedBand, collapsedBands]);

  // True exactly when `results` is the ranked, scratch-carrying list — which is
  // one commit behind `isSearching`, since the ranking runs on the deferred
  // query. The pinned scratch section hides on THIS, never on the live query:
  // hiding a commit early would leave the scratches nowhere for that frame.
  const isRankedSearch = isSearching && resultsQuery.trim().length > 0;

  const results = useMemo<ProjectSwitcherRow[]>(
    () =>
      buildResults(
        visibleBrowseRows,
        browseRows,
        browseOrdered,
        scratchResults,
        resultsQuery,
        isSearching,
        searchActivityKeys
      ),
    [
      visibleBrowseRows,
      browseRows,
      browseOrdered,
      scratchResults,
      resultsQuery,
      isSearching,
      searchActivityKeys,
    ]
  );

  // The selected ROW is the state; its index is derived. Tracking an index
  // instead would let it outlive the row it pointed at — a list that shrinks
  // under an open palette (a project closing, a stats push) would leave the
  // index addressing a different row than the user selected, and Enter would
  // commit that one (#11071). Deriving means the highlight follows the row
  // across reorders and never addresses a row that isn't rendered.
  //
  // With no row chosen, a query keeps its top match, but browse lands where
  // opening does: the first row that isn't the workspace you're in. Typing and
  // then clearing the query used to fall back to row 0 — the current project —
  // so a reflexive Enter closed the palette instead of switching.
  const selectedIndex = useMemo(() => {
    if (results.length === 0) return 0;
    const index = selectedRowId ? results.findIndex((row) => row.id === selectedRowId) : -1;
    if (index >= 0) return index;
    return defaultRowIndex(results, isRankedSearch);
  }, [results, selectedRowId, isRankedSearch]);

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

  const open = useCallback(
    (nextMode: ProjectSwitcherMode = "modal") => {
      setMode(nextMode);
      if (nextMode === "modal") {
        usePaletteStore.getState().openPalette("project-switcher");
      } else {
        setDropdownIsOpen(true);
      }
      setQuery("");
      // A closed palette renders against held stats, so the freeze is cut from
      // the store's current map rather than this render's rows.
      const stats = useProjectStatsStore.getState().stats;
      const liveProjects =
        stats === projectStats
          ? searchableProjects
          : buildSearchableProjects(projects, stats, { ...rowContext, frecencyNow: Date.now() });
      const liveOrder =
        liveProjects === searchableProjects
          ? liveBrowseOrder
          : sortBrowseOrder(liveProjects, sortModeFor, bandRanks);
      const liveScratches =
        stats === projectStats
          ? scratchResults
          : buildScratchResults(scratches, currentScratch?.id, stats);
      // Freeze the layout for this open session. Taken from the live order,
      // not `browseOrdered`, which is still holding the previous session's
      // frozen shape at this point.
      freeze({ liveOrder, liveProjects, liveScratches, stats });
      // Preselect the first ENABLED row that isn't the project we're already
      // in, so open-then-Enter is a one-two return that never defaults onto an
      // Unavailable row (selecting one opens the relocation dialog — the right
      // response to a click, the wrong one to a reflexive Enter). Both modes
      // render the same section-ordered browse list now, so this is the browse
      // order regardless of which surface is opening. From a scratch there is
      // no active row, so it lands on row 1 rather than skipping past it
      // (#11085); an all-missing list still preselects something rather than
      // nothing.
      //
      // Folded bands are not candidates: their rows are absent from `results`,
      // so preselecting one would leave the highlight addressing a row nobody
      // can see. With every band folded there is nothing to preselect, and
      // `null` is the honest answer — arrows and Enter both no-op on an empty
      // list rather than committing something offscreen.
      const selectable = liveOrder.filter(
        (project) => !isBandCollapsed(collapsedBands, project.section)
      );
      const initial =
        selectable.find((project) => !project.isActive && !project.isMissing) ??
        selectable.find((project) => !project.isActive) ??
        selectable[0];
      setSelectedRowId(initial?.id ?? null);
    },
    [
      projectStats,
      searchableProjects,
      projects,
      rowContext,
      liveBrowseOrder,
      sortModeFor,
      bandRanks,
      scratchResults,
      scratches,
      currentScratch?.id,
      freeze,
      collapsedBands,
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
    thaw();
  }, [mode, thaw]);

  const projectMutations = useProjectSwitcherProjectMutations({
    close,
    projects,
    projectStats,
    searchableProjects,
    rowContext,
    copyToClipboard,
  });

  // Steps the selection by `delta` rows, wrapping. Resolves the current row
  // from the id inside the updater so two calls batched into one tick compose
  // (the second sees where the first landed) instead of collapsing into one.
  const step = useCallback(
    (delta: number) => {
      if (results.length === 0) return;
      setSelectedRowId((previousId) => {
        const current = previousId ? results.findIndex((project) => project.id === previousId) : -1;
        // From the row the highlight is actually drawn on, so the first press
        // moves off it rather than onto it.
        const from = current >= 0 ? current : defaultRowIndex(results, isRankedSearch);
        const next = (from + delta + results.length) % results.length;
        return results[next]!.id;
      });
    },
    [results, isRankedSearch]
  );

  const [cycleRequest, setCycleRequest] = useState(0);
  const toggle = useCallback(
    (nextMode: ProjectSwitcherMode = "modal") => {
      const currentlyOpen = nextMode === "modal" ? modalIsOpen : dropdownIsOpen;
      if (currentlyOpen) {
        // The palette owns the step: its cursor walks folded headers,
        // scratches and other hosts as well as the rows this hook selects.
        setCycleRequest((count) => count + 1);
      } else {
        open(nextMode);
      }
    },
    [modalIsOpen, dropdownIsOpen, open]
  );

  const selectPrevious = useCallback(() => step(-1), [step]);

  const selectNext = useCallback(() => step(1), [step]);

  const hoverRow = useCallback((rowId: string) => setSelectedRowId(rowId), []);

  const selectProject = useCallback(
    async (project: SearchableProject, source?: ProjectSwitchSelectSource) => {
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

      // The dropdown's close must not return focus to the pill: this view is
      // being parked and comes back with focus wherever this close leaves it.
      if (mode === "dropdown") suppressCloseAutoFocusRef.current = true;
      // Perf-trace entry point: the anchored dropdown is the toolbar surface;
      // the modal palette splits on how the row was committed.
      beginSwitchTrace(
        mode === "dropdown"
          ? "toolbar"
          : source === "keyboard"
            ? "palette-keyboard"
            : "palette-mouse"
      );
      if (project.isBackground) {
        void reopenProject(project.id);
      } else {
        void switchProject(project.id);
      }
    },
    [close, mode, switchProject, reopenProject, openRelocation]
  );

  const selectScratch = useCallback(
    async (scratch: SearchableScratch) => {
      if (scratch.isActive) {
        close();
        return;
      }
      if (mode === "dropdown") suppressCloseAutoFocusRef.current = true;
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
    [close, mode, switchScratchAction]
  );

  // The one commit path for a row of `results`. Both branches are fire-and-
  // forget by design — each closes the palette first and reports its own
  // failure, so there is nothing here for a caller to await.
  // Read-and-disarm in one step so a close the shell suppressed for its own
  // reasons still spends the flag instead of leaving it for the next Escape.
  const consumeCloseAutoFocusSuppression = useCallback(() => {
    const suppress = suppressCloseAutoFocusRef.current;
    suppressCloseAutoFocusRef.current = false;
    return suppress;
  }, []);

  const selectRow = useCallback(
    (row: ProjectSwitcherRow, source?: ProjectSwitchSelectSource) => {
      if (row.kind === "scratch") {
        void selectScratch(row);
        return;
      }
      void selectProject(row, source);
    },
    [selectProject, selectScratch]
  );

  const { onHoverProject, onHoverProjectEnd } = useProjectHoverPrefetch(isOpen, searchableProjects);

  const confirmSelection = useCallback(() => {
    if (results.length === 0) return;
    selectRow(results[selectedIndex]!, "keyboard");
  }, [results, selectedIndex, selectRow]);

  const addProject = useCallback(async () => {
    close();
    await addProjectFn();
  }, [close, addProjectFn]);

  const cloneRepo = useCallback(() => {
    close();
    useProjectStore.getState().openCloneRepoDialog();
  }, [close]);

  // A project saved from a scratch a moment ago, so its row may be missing if
  // the list refresh after the save failed. The returned record still opens it.
  const openProject = useCallback(
    (project: Project) => {
      const row =
        searchableProjects.find((candidate) => candidate.id === project.id) ??
        toSearchableProject(project, projectStats[project.id], {
          ...rowContext,
          frecencyNow: Date.now(),
        });
      void selectProject(row);
    },
    [searchableProjects, projectStats, rowContext, selectProject]
  );

  const scratchMutations = useProjectSwitcherScratchMutations({
    close,
    scratches,
    scratchResults,
    openProject,
  });

  return {
    isOpen,
    mode,
    query,
    results,
    browseBands,
    isFiltering,
    isRankedSearch,
    activeProject,
    selectedIndex,
    cycleRequest,
    open,
    close,
    toggle,
    setQuery,
    selectPrevious,
    selectNext,
    hoverRow,
    selectProject,
    selectRow,
    onHoverProject,
    onHoverProjectEnd,
    consumeCloseAutoFocusSuppression,
    confirmSelection,
    addProject,
    cloneRepo,
    ...projectMutations,
    backgroundWaitingCount,
    nonActiveAgentCounts,
    fleetLiveness,
    scratchResults,
    selectScratch,
    ...scratchMutations,
  };
}
