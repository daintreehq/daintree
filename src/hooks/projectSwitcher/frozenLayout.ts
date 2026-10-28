import { computeSearchActivityKey, type SearchActivityKey } from "@/lib/projectSwitcherSearch";
import { compareProjectsByMode, type OtherProjectsSortMode } from "@/lib/projectSort";
import type { ProjectGroupBandKey } from "@/lib/projectGroupBands";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import { bandRank, compareWithinSection, isSortableBand } from "./ordering";
import type { ProjectBandKey, SearchableProject, SearchableScratch } from "./types";

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
export function isStatsSensitive(project: SearchableProject): boolean {
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
export function countSearchRowsAwaitingStats(
  projects: SearchableProject[],
  scratches: SearchableScratch[],
  stats: ProjectStatusMap
): { total: number; unkeyed: number } {
  let unkeyed = 0;
  for (const project of projects) if (stats[project.id] === undefined) unkeyed += 1;
  for (const scratch of scratches) if (stats[scratch.id] === undefined) unkeyed += 1;
  return { total: projects.length + scratches.length, unkeyed };
}

export interface FrozenLayout {
  order: string[];
  sections: Map<string, ProjectBandKey>;
  /**
   * Each row's filing — group and archive state — when it was frozen. Filing
   * only changes because the user just asked for it, so a row whose filing
   * moves is re-banded on the spot instead of held: a project the user just
   * archived staying where it was would read as the menu doing nothing. See
   * {@link filingOf}.
   */
  filing: Map<string, string>;
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
export interface FrozenSearchActivity {
  keys: Map<string, SearchActivityKey>;
  /**
   * Same meaning as {@link FrozenLayout.isProvisional}, but reached on its own
   * terms — search asks about a wider set of rows, so a session can be
   * provisional for one freeze and settled for the other.
   */
  isProvisional: boolean;
}

/** A row's filing as one comparable value — see {@link FrozenLayout.filing}. */
export function filingOf(project: SearchableProject): string {
  return `${project.groupId ?? ""}|${project.isArchived === true ? 1 : 0}`;
}

/**
 * `layout` with `band`'s rows re-sorted for `mode` IN THEIR EXISTING SLOTS,
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
export function resortBand(
  layout: FrozenLayout,
  live: Map<string, SearchableProject>,
  band: ProjectBandKey,
  mode: OtherProjectsSortMode
): { order: string[]; ids: string[] } | null {
  const slots: number[] = [];
  const ids: string[] = [];
  layout.order.forEach((id, index) => {
    if (layout.sections.get(id) === band) {
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
 * `order` with `project` inserted into its band at the place that band's own
 * order gives it, every other row keeping its frozen slot. Used for a row the
 * user just refiled: re-sorting the whole destination band instead would also
 * move rows whose live activity changed since the palette opened — exactly the
 * movement the freeze exists to prevent.
 *
 * The band's rows are compared as they are held — under the band the freeze
 * gave them — so the comparator orders them by the band they are drawn in.
 */
export function insertIntoBand(
  order: string[],
  sections: ReadonlyMap<string, ProjectBandKey>,
  live: ReadonlyMap<string, SearchableProject>,
  project: SearchableProject,
  sortModeFor: (band: "other" | ProjectGroupBandKey) => OtherProjectsSortMode
): string[] {
  const band = project.section;
  let lastSlot = -1;
  for (let index = 0; index < order.length; index++) {
    const id = order[index]!;
    if (sections.get(id) !== band) continue;
    const row = live.get(id);
    if (row && compareWithinSection(project, { ...row, section: band }, sortModeFor) < 0) {
      return [...order.slice(0, index), project.id, ...order.slice(index)];
    }
    lastSlot = index;
  }
  // Last in its band, or — with the band empty — anywhere: `browseOrdered`'s
  // regroup carries it to its band's rank.
  const at = lastSlot === -1 ? order.length : lastSlot + 1;
  return [...order.slice(0, at), project.id, ...order.slice(at)];
}

export function captureLayout(projects: SearchableProject[], isProvisional = false): FrozenLayout {
  return {
    order: projects.map((project) => project.id),
    sections: new Map(projects.map((project) => [project.id, project.section])),
    filing: new Map(projects.map((project) => [project.id, filingOf(project)])),
    isProvisional,
  };
}

export function captureSearchActivity(
  projects: SearchableProject[],
  scratches: SearchableScratch[],
  isProvisional = false
): FrozenSearchActivity {
  const keys = new Map<string, SearchActivityKey>();
  // Every row, including the active and the missing ones: search has no band
  // that spares a row from being ranked on what it is doing.
  for (const project of projects) keys.set(project.id, computeSearchActivityKey(project));
  for (const scratch of scratches) keys.set(scratch.id, computeSearchActivityKey(scratch));
  return { keys, isProvisional };
}

/**
 * The browse freeze for a session opening now, taken from the live order —
 * never from the layout the previous session left behind.
 *
 * Provisional means EVERY stats-sensitive row is unkeyed, not that the map is
 * empty: a keyed all-zero entry is real data about an idle project, and one
 * unkeyed row among settled ones is a project main hasn't reported yet —
 * neither should unlock rows the user is already looking at. Active and
 * unavailable rows are banded without stats, so they say nothing about
 * hydration; pinned rows do, since attention outranks a pin.
 */
export function freezeBrowseLayout(
  liveOrder: SearchableProject[],
  stats: ProjectStatusMap
): FrozenLayout {
  const statsSensitive = liveOrder.filter(isStatsSensitive);
  const isProvisional =
    statsSensitive.length > 0 && statsSensitive.every((project) => stats[project.id] === undefined);
  return captureLayout(liveOrder, isProvisional);
}

/**
 * Search's freeze for a session opening now. Its own verdict, over its own
 * rows: search ranks scratches and the active row too, so browse's answer does
 * not cover the set it froze.
 */
export function freezeSearchActivity(
  liveProjects: SearchableProject[],
  liveScratches: SearchableScratch[],
  stats: ProjectStatusMap
): FrozenSearchActivity {
  const searchRows = countSearchRowsAwaitingStats(liveProjects, liveScratches, stats);
  return captureSearchActivity(
    liveProjects,
    liveScratches,
    // No rows counts as provisional, unlike browse's check. Loading the
    // workspace lists is itself async and retried, so a palette opened during
    // boot can capture nothing at all — and calling that snapshot settled
    // would let the scratches that arrive a moment later fold in as quiet with
    // no recapture ever due.
    searchRows.unkeyed === searchRows.total
  );
}

/**
 * The sortable bands whose mode moved between two mode maps. A band only in
 * `next` is a group just created, not a mode the user changed, and a band only
 * in `previous` has nothing left to re-sort.
 */
export function changedSortBands(
  previous: ReadonlyMap<"other" | ProjectGroupBandKey, OtherProjectsSortMode>,
  next: ReadonlyMap<"other" | ProjectGroupBandKey, OtherProjectsSortMode>
): ("other" | ProjectGroupBandKey)[] {
  return [...next]
    .filter(([band, mode]) => previous.has(band) && previous.get(band) !== mode)
    .map(([band]) => band);
}

/**
 * `layout` with every band in `changed` re-sorted in place (see
 * {@link resortBand}). Sections and provisionality are untouched:
 * provisionality describes the DATA, so a mode change during a cold open must
 * not cancel the pending one-time regroup (#11452).
 */
export function resortChangedBands(
  layout: FrozenLayout,
  live: Map<string, SearchableProject>,
  changed: readonly ("other" | ProjectGroupBandKey)[],
  sortModesByBand: ReadonlyMap<"other" | ProjectGroupBandKey, OtherProjectsSortMode>
): FrozenLayout {
  let next = layout;
  for (const band of changed) {
    const resorted = resortBand(next, live, band, sortModesByBand.get(band)!);
    if (resorted) next = { ...next, order: resorted.order };
  }
  return next;
}

/**
 * Where the highlight lands after `changed` bands were re-sorted: the top of
 * its band when that band is one the user just re-ordered, otherwise where it
 * already was.
 *
 * The highlight normally follows its PROJECT across a reorder — the list
 * churns on its own, and a highlight left addressing whatever row inherited
 * the slot is how Enter commits a project the user never chose (#11071) — but
 * a mode they picked a moment ago is not that kind of churn. They asked to see
 * this band differently; the answer starts at the top of it instead of chasing
 * their old row down the list. Scoped to the band that actually moved: a
 * highlight parked in Needs attention stays put, since this control never
 * claimed to order that band.
 */
export function bandTopAfterResort(
  layout: FrozenLayout,
  live: Map<string, SearchableProject>,
  selectedId: string | null,
  changed: readonly ("other" | ProjectGroupBandKey)[],
  sortModesByBand: ReadonlyMap<"other" | ProjectGroupBandKey, OtherProjectsSortMode>
): string | null {
  if (selectedId === null) return selectedId;
  const band = layout.sections.get(selectedId);
  if (band === undefined || !isSortableBand(band) || !changed.includes(band)) {
    return selectedId;
  }
  const resorted = resortBand(layout, live, band, sortModesByBand.get(band)!);
  if (!resorted) return selectedId;
  // Same skip as `open()`'s preselect: a project that went missing while the
  // palette was open keeps its frozen slot, and a reflexive Enter landing on
  // it opens the relocation dialog rather than switching projects.
  return resorted.ids.find((id) => live.get(id)?.isMissing === false) ?? resorted.ids[0]!;
}

/**
 * Whether a provisional browse freeze can be resolved: no row is still a
 * guess.
 *
 * Judged against the rows that are live now, not a set captured at open: a
 * project that registers while the session is still provisional would
 * otherwise be folded in at its own guessed band and then locked there by the
 * recapture, reproducing #11452 for that row. Reading live also means a project
 * that goes away simply stops holding the regroup up.
 *
 * Waiting for all of them keeps the regroup one decision rather than a trickle
 * of rows moving under the pointer; if a row never resolves, the session just
 * behaves as it did before any of this.
 */
export function isBrowseFreezeSettled(
  liveBrowseOrder: SearchableProject[],
  stats: ProjectStatusMap
): boolean {
  return !liveBrowseOrder.some(
    (project) => isStatsSensitive(project) && stats[project.id] === undefined
  );
}

/**
 * Rows the freeze has to take in: arrivals registered after it was cut, and
 * rows the user refiled since.
 *
 * Refiled rows beat the freeze the way a sort change does: the user just moved
 * them between groups or in or out of the archive, and a row that stayed put
 * would read as the menu doing nothing.
 */
export function findLayoutDrift(
  layout: FrozenLayout,
  liveBrowseOrder: SearchableProject[]
): { arrivals: SearchableProject[]; refiled: SearchableProject[] } {
  const arrivals = liveBrowseOrder.filter((project) => !layout.sections.has(project.id));
  const refiled = liveBrowseOrder.filter((project) => {
    const frozenFiling = layout.filing.get(project.id);
    return frozenFiling !== undefined && frozenFiling !== filingOf(project);
  });
  return { arrivals, refiled };
}

/**
 * `previous` with `arrivals` appended at the end of the order — the position
 * the renderer already gives them, the end of their live band — and each
 * `refiled` row moved into its new band. Only a refiled row moves; every other
 * row keeps its frozen band and slot.
 *
 * Pure over `previous`, so the caller can run it in a `setFrozenLayout`
 * updater against whatever layout React has actually applied; rows already
 * taken in by an earlier pass are skipped.
 */
export function foldIntoLayout(
  previous: FrozenLayout,
  arrivals: readonly SearchableProject[],
  refiled: readonly SearchableProject[],
  live: ReadonlyMap<string, SearchableProject>,
  sortModeFor: (band: "other" | ProjectGroupBandKey) => OtherProjectsSortMode
): FrozenLayout {
  let order = [...previous.order];
  const sections = new Map(previous.sections);
  const filing = new Map(previous.filing);
  for (const project of arrivals) {
    if (sections.has(project.id)) continue;
    order.push(project.id);
    sections.set(project.id, project.section);
    filing.set(project.id, filingOf(project));
  }
  for (const project of refiled) {
    if (filing.get(project.id) === filingOf(project)) continue;
    filing.set(project.id, filingOf(project));
    // A refile that leaves the row in the band it was frozen in — an asking
    // project changing group still asks — moves nothing at all.
    if (sections.get(project.id) === project.section) continue;
    sections.set(project.id, project.section);
    order = insertIntoBand(
      order.filter((id) => id !== project.id),
      sections,
      live,
      project,
      sortModeFor
    );
  }
  // Spread, so a session still waiting on its first stats stays provisional
  // and folds this arrival into its pending regroup.
  return { ...previous, order, sections, filing };
}

/**
 * The live rows laid out in the frozen order and bands. Counts, ages and
 * status text stay live; only sequence and band membership are held.
 */
export function applyFrozenLayout(
  frozen: FrozenLayout | null,
  liveBrowseOrder: SearchableProject[],
  bandRanks: ReadonlyMap<ProjectBandKey, number>
): SearchableProject[] {
  if (!frozen) return liveBrowseOrder;

  const byId = new Map(liveBrowseOrder.map((project) => [project.id, project]));
  const held = (project: SearchableProject): SearchableProject => {
    const section = frozen.sections.get(project.id);
    return section === undefined || section === project.section ? project : { ...project, section };
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
  //
  // Band ranks are read live, not frozen: the only thing that changes them is
  // the user reordering their groups, which — like a sort change — must show.
  return ordered.sort((a, b) => bandRank(bandRanks, a.section) - bandRank(bandRanks, b.section));
}

/**
 * Whether a provisional search freeze can be resolved: no row search ranks is
 * still a guess. `total > 0` so an empty session waits for its rows instead of
 * resolving against nothing and locking whatever arrives next in as quiet.
 */
export function isSearchFreezeSettled(
  projects: SearchableProject[],
  scratches: SearchableScratch[],
  stats: ProjectStatusMap
): boolean {
  const { total, unkeyed } = countSearchRowsAwaitingStats(projects, scratches, stats);
  return total > 0 && unkeyed === 0;
}

/**
 * `previous` with each row it has no key for seated at its key of the moment,
 * or `previous` itself when every row is already keyed.
 */
export function foldSearchArrivals(
  previous: FrozenSearchActivity,
  arrivals: readonly (SearchableProject | SearchableScratch)[]
): FrozenSearchActivity {
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
}
