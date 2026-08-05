import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { TOOLBAR_BUTTON_GROUP_ORDER, type ToolbarButtonGroup } from "./toolbarButtonMetadata";

/**
 * Resolves a button's declared group. Callers bind the plugin-registry lookup
 * so this module stays pure and directly unit-testable — `Toolbar.tsx` has too
 * many IPC dependencies to render in jsdom, so the divider algorithm can only
 * be covered for real if it lives outside the component.
 */
export type ResolveToolbarButtonGroup = (id: AnyToolbarButtonId) => ToolbarButtonGroup;

/**
 * Stable-partition button ids into `TOOLBAR_BUTTON_GROUP_ORDER`, preserving the
 * user's relative order inside each group (#11681).
 *
 * The persisted side arrays let a user interleave groups freely. Grouping at
 * render rather than rewriting what is stored keeps the fix working for every
 * existing profile — including one a stale cross-view write re-interleaves —
 * without a migration and without teaching the store what a group is.
 */
export function orderToolbarButtonsByGroup(
  ids: readonly AnyToolbarButtonId[],
  resolveGroup: ResolveToolbarButtonGroup
): AnyToolbarButtonId[] {
  const buckets = new Map<ToolbarButtonGroup, AnyToolbarButtonId[]>(
    TOOLBAR_BUTTON_GROUP_ORDER.map((group) => [group, []])
  );
  for (const id of ids) {
    buckets.get(resolveGroup(id))!.push(id);
  }
  return TOOLBAR_BUTTON_GROUP_ORDER.flatMap((group) => buckets.get(group)!);
}

/**
 * Ids that a divider follows, given already-grouped ids and which of them are
 * visible.
 *
 * Only visible buttons count: an overflow-evicted button stays mounted for
 * measurement but must not leave a divider behind, and when a whole group
 * overflows the boundary collapses to a single divider between the groups that
 * remain. Walking the visible subsequence handles both — and, because the input
 * is grouped, its adjacent pairs differ exactly at the real group boundaries.
 * Never emits a trailing divider.
 */
export function getToolbarDividerAfterIds(
  orderedIds: readonly AnyToolbarButtonId[],
  isVisible: (id: AnyToolbarButtonId) => boolean,
  resolveGroup: ResolveToolbarButtonGroup
): Set<AnyToolbarButtonId> {
  const visible = orderedIds.filter(isVisible);
  const dividerAfter = new Set<AnyToolbarButtonId>();
  for (let i = 0; i < visible.length - 1; i++) {
    if (resolveGroup(visible[i]!) !== resolveGroup(visible[i + 1]!)) {
      dividerAfter.add(visible[i]!);
    }
  }
  return dividerAfter;
}

/**
 * Where to splice `activeId` into a raw (possibly interleaved) side array so
 * that grouping the result reproduces the position the user dropped it at.
 *
 * Settings shows the grouped projection but `moveButton` splices into the
 * stored array, so a projected index can't be passed through directly. Only the
 * order relative to the button's own group peers survives grouping, so anchor
 * on those: after the nearest preceding peer, otherwise before the nearest
 * following one. With no peers at all the position is unobservable once
 * grouped, so appending is as correct as anything else.
 *
 * Each direction keeps scanning outward past peers the stored array no longer
 * holds. The projection is a snapshot taken at drag start while the stored
 * array is read at drop, and the two can diverge mid-drag — the side arrays
 * reconcile last-writer-wins across project views, so a sibling view's write
 * can drop a peer underneath an open drag.
 *
 * Assumes `activeId` is absent from `rawTargetIds` (it is — this only runs for
 * a cross-side move) and that neither list repeats an id (the store sanitizes
 * on every write, and the render boundary dedupes again).
 */
export function getGroupedInsertionIndex(
  rawTargetIds: readonly AnyToolbarButtonId[],
  projectedTargetIds: readonly AnyToolbarButtonId[],
  activeId: AnyToolbarButtonId,
  resolveGroup: ResolveToolbarButtonGroup
): number {
  const group = resolveGroup(activeId);
  const droppedAt = projectedTargetIds.indexOf(activeId);
  const peers = projectedTargetIds.filter((id) => id !== activeId && resolveGroup(id) === group);

  const preceding = peers.filter((id) => projectedTargetIds.indexOf(id) < droppedAt);
  for (let i = preceding.length - 1; i >= 0; i--) {
    const at = rawTargetIds.indexOf(preceding[i]!);
    if (at !== -1) return at + 1;
  }

  const following = peers.filter((id) => projectedTargetIds.indexOf(id) > droppedAt);
  for (const peer of following) {
    const at = rawTargetIds.indexOf(peer);
    if (at !== -1) return at;
  }

  return rawTargetIds.length;
}
