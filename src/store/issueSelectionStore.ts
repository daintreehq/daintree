import { create } from "zustand";
import type { Issue, PR } from "@shared/types/forge";

// Bulk issue/PR selection for the GitHub toolbar dropdown, keyed by
// `${type}:${projectPath}`. This lives in a module-level store rather than a
// component-local reducer so the selection — and the actions that mutate it —
// survive the dropdown being hidden (`<Activity>`), remounted (the toolbar's
// lazy/direct component swap), or handed off by value to the bulk-create
// dialog. The dialog's "Done" handler clears by key, so completion no longer
// depends on a specific `GitHubResourceList` instance still being alive.

export type SelectableItem = Issue | PR;

interface SelectionEntry {
  /**
   * The selected items themselves, keyed by number. The ITEMS are the
   * selection — there is no parallel set of ids to fall out of step with them.
   *
   * This used to be a `Set<number>` here and a `Map` of objects in the
   * dropdown's own `useState`. Ids outlive the component and objects did not,
   * so after a remount the bulk bar could read "5 selected" and hand the
   * create dialog an empty array. A later fix kept snapshots in the store but
   * refilled them from a `data` effect, which reintroduced the same skew by a
   * different route: clearing emptied the map, `data` had not changed, so the
   * effect never re-ran and the next toggle selected an id with no object
   * behind it. One map, populated at the moment of selection, cannot skew.
   */
  items: Map<number, SelectableItem>;
  /**
   * The item the next shift-extend measures from, held as an ITEM ID rather
   * than a list index. A selection outlives the search query, the state tab,
   * the sort order and pagination, so a stored index routinely pointed past
   * the end of a later, shorter list, and the shift-click threw. An id is
   * either still in the current ordering or it is not, and "not" has an
   * obvious meaning: start a new range.
   */
  anchorId: number | null;
}

interface IssueSelectionState {
  selections: Map<string, SelectionEntry>;
  toggle: (key: string, item: SelectableItem) => void;
  toggleRange: (key: string, toItem: SelectableItem, ordered: readonly SelectableItem[]) => void;
  selectAll: (key: string, items: readonly SelectableItem[]) => void;
  /** Refresh the stored copy of already-selected items from newer data. */
  reconcile: (key: string, latest: readonly SelectableItem[]) => void;
  clear: (key: string) => void;
}

/** Shared empty Map — handing back one reference keeps selector identity
 *  stable for every key that has no selection yet. Entries are never mutated
 *  in place; every mutation builds a fresh Map. */
export const EMPTY_SELECTED_ITEMS: Map<number, SelectableItem> = new Map();

const EMPTY_ENTRY: SelectionEntry = {
  items: EMPTY_SELECTED_ITEMS,
  anchorId: null,
};

export const useIssueSelectionStore = create<IssueSelectionState>((set) => ({
  selections: new Map(),

  toggle: (key, item) =>
    set((state) => {
      const entry = state.selections.get(key) ?? EMPTY_ENTRY;
      const items = new Map(entry.items);
      if (items.has(item.number)) {
        items.delete(item.number);
      } else {
        items.set(item.number, item);
      }
      const selections = new Map(state.selections);
      selections.set(key, { items, anchorId: item.number });
      return { selections };
    }),

  toggleRange: (key, toItem, ordered) =>
    set((state) => {
      const entry = state.selections.get(key) ?? EMPTY_ENTRY;
      const items = new Map(entry.items);
      const toIndex = ordered.findIndex((i) => i.number === toItem.number);
      const fromIndex =
        entry.anchorId === null ? -1 : ordered.findIndex((i) => i.number === entry.anchorId);

      let anchorId = entry.anchorId;
      if (fromIndex < 0 || toIndex < 0) {
        // No usable anchor — none seated yet, or the anchored item has dropped
        // out of the current ordering. Behave exactly like a plain click on
        // this row (toggle, not add) and seat the new anchor, so a
        // shift-click on an already-selected row still deselects it.
        if (items.has(toItem.number)) {
          items.delete(toItem.number);
        } else {
          items.set(toItem.number, toItem);
        }
        anchorId = toItem.number;
      } else {
        // Extend, but leave the anchor where it is so a follow-up shift-click
        // re-extends from the original point rather than walking.
        const start = Math.min(fromIndex, toIndex);
        const end = Math.max(fromIndex, toIndex);
        for (let i = start; i <= end; i++) {
          const item = ordered[i]!;
          items.set(item.number, item);
        }
      }
      const selections = new Map(state.selections);
      selections.set(key, { items, anchorId });
      return { selections };
    }),

  selectAll: (key, items) =>
    set((state) => {
      const next = new Map<number, SelectableItem>();
      for (const item of items) next.set(item.number, item);
      const selections = new Map(state.selections);
      // A bulk select replaces the selection wholesale, so the old anchor no
      // longer describes anything the user did — the next shift-click should
      // start a fresh range rather than extend from a forgotten row.
      selections.set(key, { items: next, anchorId: null });
      return { selections };
    }),

  reconcile: (key, latest) =>
    set((state) => {
      const entry = state.selections.get(key);
      if (!entry || entry.items.size === 0) return state;
      let next: Map<number, SelectableItem> | null = null;
      for (const item of latest) {
        const held = entry.items.get(item.number);
        // Membership and the anchor are untouched — this ONLY refreshes the
        // copy of something already selected. Without it, a background
        // revalidation that renames an issue or moves a PR's head ref leaves
        // the bulk action planning from whatever the row looked like at the
        // moment it was ticked.
        if (held === undefined || held === item) continue;
        if (!next) next = new Map(entry.items);
        next.set(item.number, item);
      }
      if (!next) return state;
      const selections = new Map(state.selections);
      selections.set(key, { ...entry, items: next });
      return { selections };
    }),

  clear: (key) =>
    set((state) => {
      if (!state.selections.has(key)) return state;
      const selections = new Map(state.selections);
      // Delete the entry outright rather than parking an empty one. Every
      // project the user visits used to leave a resident entry behind.
      selections.delete(key);
      return { selections };
    }),
}));
