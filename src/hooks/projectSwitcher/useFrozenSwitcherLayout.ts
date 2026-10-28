import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SearchActivityKey } from "@/lib/projectSwitcherSearch";
import type { OtherProjectsSortMode } from "@/lib/projectSort";
import { groupBandKey, type ProjectGroupBandKey } from "@/lib/projectGroupBands";
import type { ProjectGroup } from "@shared/types/project";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import {
  applyFrozenLayout,
  bandTopAfterResort,
  captureLayout,
  captureSearchActivity,
  changedSortBands,
  findLayoutDrift,
  foldIntoLayout,
  foldSearchArrivals,
  freezeBrowseLayout,
  freezeSearchActivity,
  isBrowseFreezeSettled,
  isSearchFreezeSettled,
  resortChangedBands,
  type FrozenLayout,
  type FrozenSearchActivity,
} from "./frozenLayout";
import type { ProjectBandKey, SearchableProject, SearchableScratch } from "./types";

export interface UseFrozenSwitcherLayoutOptions {
  isOpen: boolean;
  isSearching: boolean;
  /** Every project ranked live, before any freeze is applied. */
  liveBrowseOrder: SearchableProject[];
  searchableProjects: SearchableProject[];
  scratchResults: SearchableScratch[];
  projectStats: ProjectStatusMap;
  otherProjectsSortMode: OtherProjectsSortMode;
  projectGroups: ProjectGroup[];
  sortModeFor: (band: "other" | ProjectGroupBandKey) => OtherProjectsSortMode;
  bandRanks: ReadonlyMap<ProjectBandKey, number>;
  /** Moved to the top of a band the user just re-sorted. */
  setSelectedRowId: Dispatch<SetStateAction<string | null>>;
}

export interface FrozenSwitcherLayout {
  /** `liveBrowseOrder` laid out in the session's frozen order and bands. */
  browseOrdered: SearchableProject[];
  /** Search's frozen activity keys, or null while no session is frozen. */
  searchActivityKeys: ReadonlyMap<string, SearchActivityKey> | null;
  /** Freeze both layouts for a session opening against these rows. */
  freeze: (snapshot: {
    liveOrder: SearchableProject[];
    liveProjects: SearchableProject[];
    liveScratches: SearchableScratch[];
    stats: ProjectStatusMap;
  }) => void;
  /** Drop both freezes, at the close. */
  thaw: () => void;
}

/**
 * The switcher's layout freeze, browse and search, for the lifetime of one
 * open palette. Layout is frozen; content stays live.
 *
 * Browse ranks on agent state, and agent state changes constantly — an agent
 * finishing mid-read would otherwise pull its project out of "Needs attention"
 * and drop it several rows down, moving every row under the pointer between
 * the moment the user decided to click and the moment they clicked.
 *
 * Both the sequence AND each row's band are frozen, because they're one
 * decision: the component cuts section headers from contiguous runs, so a row
 * that kept its frozen slot while its band changed underneath would split its
 * old band in two and print that header twice. Counts, ages and status text
 * are read fresh every render, so rows still update in place.
 *
 * Captured by `freeze()`/`thaw()` from `open()`/`close()` rather than during
 * render. A ref written while rendering leaks into the committed tree if React
 * abandons that render, and it never resets on a mode change that leaves the
 * palette open.
 *
 * A session that opened before any stats reached this view froze a guess, not
 * a decision: with no entry every row reads as zero agents and lands in
 * "Other", so the palette shows one ungrouped band and only re-bands on the
 * next open (#11452). Such a session stays provisional until real data lands,
 * and is then regrouped once, in place.
 */
export function useFrozenSwitcherLayout({
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
}: UseFrozenSwitcherLayoutOptions): FrozenSwitcherLayout {
  const [frozenLayout, setFrozenLayout] = useState<FrozenLayout | null>(null);

  // Search's activity keys are frozen for the same reason and over the same
  // session, but separately: browse's freeze is projects-and-bands, and search
  // ranks scratches in the same list with no bands at all (#11861).
  const [frozenSearchActivity, setFrozenSearchActivity] = useState<FrozenSearchActivity | null>(
    null
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
  //
  // Every sortable band carries its own mode — Other reads the preference, each
  // group its own — so the guard compares per band and only the bands whose
  // mode moved are re-sorted. Creating, renaming or deleting a group hands this
  // a new map without changing any band's mode, and must not re-sort anything.
  const sortModesByBand = useMemo(() => {
    const modes = new Map<"other" | ProjectGroupBandKey, OtherProjectsSortMode>([
      ["other", otherProjectsSortMode],
    ]);
    for (const group of projectGroups) modes.set(groupBandKey(group.id), group.sortMode);
    return modes;
  }, [otherProjectsSortMode, projectGroups]);
  const previousSortModes = useRef(sortModesByBand);
  useEffect(() => {
    const previous = previousSortModes.current;
    if (previous === sortModesByBand) return;
    previousSortModes.current = sortModesByBand;
    const changed = changedSortBands(previous, sortModesByBand);
    if (changed.length === 0) return;
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
    setFrozenLayout((previousLayout) =>
      previousLayout
        ? resortChangedBands(previousLayout, live, changed, sortModesByBand)
        : previousLayout
    );

    // Skipped while searching — the sort control only renders on a browse
    // header today, so this is what keeps the reset honest if search ever grows
    // one: query-ranked rows are not sequenced by this preference, and seating
    // the highlight on a browse-order row would land it anywhere.
    if (isSearching) return;
    // Decided against the layout this render saw, unlike the rewrite above. An
    // arrival is never the row the user had selected, and can only be the new
    // band top in the same narrow window — so a snapshot costs at most one row
    // of accuracy there, and buys a pure computation of the target.
    setSelectedRowId((previousId) =>
      bandTopAfterResort(frozenLayout, live, previousId, changed, sortModesByBand)
    );
  }, [sortModesByBand, isOpen, liveBrowseOrder, frozenLayout, isSearching, setSelectedRowId]);

  // Fold projects that appeared after the freeze into it, at the position the
  // renderer already gives them (end of their live band). Without this they are
  // the one part of the list still re-banding on every stats push, so the freeze
  // the palette advertises would hold for the session's original rows only.
  useEffect(() => {
    // Closed, the rows carry held stats; a session that skipped `close()` (the
    // palette store handed the slot to another palette) must not fold an
    // arrival in at a band cut from them. Reopening re-runs this live.
    if (!frozenLayout || !isOpen) return;

    // A provisional freeze is a placeholder. Once no row is still a guess,
    // recapture the whole layout so bands AND within-band order come from
    // `liveBrowseOrder`'s real sort, and stop being provisional.
    if (frozenLayout.isProvisional && isBrowseFreezeSettled(liveBrowseOrder, projectStats)) {
      setFrozenLayout((previous) =>
        // Identity, not truthiness: an effect left over from a previous open
        // session must not recapture this one with a stale order.
        previous === frozenLayout ? captureLayout(liveBrowseOrder) : previous
      );
      return;
    }

    const { arrivals, refiled } = findLayoutDrift(frozenLayout, liveBrowseOrder);
    if (arrivals.length === 0 && refiled.length === 0) return;
    const live = new Map(liveBrowseOrder.map((project) => [project.id, project]));
    setFrozenLayout((previous) =>
      previous ? foldIntoLayout(previous, arrivals, refiled, live, sortModeFor) : previous
    );
  }, [liveBrowseOrder, frozenLayout, projectStats, isOpen, sortModeFor]);

  const browseOrdered = useMemo<SearchableProject[]>(
    () => applyFrozenLayout(frozenLayout, liveBrowseOrder, bandRanks),
    [liveBrowseOrder, frozenLayout, bandRanks]
  );

  // The search freeze's counterpart to the browse regroup above, over search's
  // own set of rows rather than browse's.
  //
  // A provisional snapshot read every row as quiet, which is not an ordering —
  // it is the absence of one. Once no row search ranks is still a guess it is
  // recaptured whole, exactly once, and holds from there. A session that opened
  // before the workspace lists themselves loaded stays provisional through the
  // arrivals below, so the recapture is still ahead of it: `total === 0` is the
  // emptiest guess there is, not a settled answer.
  //
  // Rows that appear afterwards are folded in at their key of the moment. Until
  // that lands they rank as quiet rather than as their live counts
  // (`rankSwitcherMatches`) — so an arrival is seated once at the bottom of its
  // text tier and once at its real place, and never again. Browse's arrivals
  // avoid even that because their band-end slot is the same before and after;
  // search has nowhere equivalent to park one. Reading live counts for the
  // gap instead would leave that row tracking every push, which is the whole
  // thing this freeze exists to stop.
  useEffect(() => {
    // Held stats while closed, as the browse fold above.
    if (!frozenSearchActivity || !isOpen) return;

    if (
      frozenSearchActivity.isProvisional &&
      isSearchFreezeSettled(searchableProjects, scratchResults, projectStats)
    ) {
      setFrozenSearchActivity((previous) =>
        // Identity, not truthiness: an effect left over from a previous open
        // session must not recapture this one against stale rows.
        previous === frozenSearchActivity
          ? captureSearchActivity(searchableProjects, scratchResults)
          : previous
      );
      return;
    }

    const arrivals = [...searchableProjects, ...scratchResults].filter(
      (row) => !frozenSearchActivity.keys.has(row.id)
    );
    if (arrivals.length === 0) return;
    setFrozenSearchActivity((previous) =>
      // Identity, for the same reason the recapture above checks it: an updater
      // queued against a previous open session must not seat its arrivals in
      // this one. Bailing is free — the snapshot is a dependency, so the effect
      // fires again against whichever one React actually applied.
      previous === frozenSearchActivity ? foldSearchArrivals(previous, arrivals) : previous
    );
  }, [searchableProjects, scratchResults, projectStats, frozenSearchActivity, isOpen]);

  const freeze = useCallback<FrozenSwitcherLayout["freeze"]>(
    ({ liveOrder, liveProjects, liveScratches, stats }) => {
      setFrozenLayout(freezeBrowseLayout(liveOrder, stats));
      setFrozenSearchActivity(freezeSearchActivity(liveProjects, liveScratches, stats));
    },
    []
  );

  const thaw = useCallback(() => {
    setFrozenLayout(null);
    setFrozenSearchActivity(null);
  }, []);

  return {
    browseOrdered,
    searchActivityKeys: frozenSearchActivity?.keys ?? null,
    freeze,
    thaw,
  };
}
