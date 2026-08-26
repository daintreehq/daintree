import { useCallback, useMemo } from "react";
import {
  useIssueSelectionStore,
  EMPTY_SELECTED_ITEMS,
  type SelectableItem,
} from "@/store/issueSelectionStore";

export interface UseIssueSelectionReturn {
  /** The selected items, keyed by number. The selection itself. */
  selectedItems: Map<number, SelectableItem>;
  /** The selected numbers, for membership checks in row rendering. */
  selectedIds: Set<number>;
  isSelectionActive: boolean;
  toggle: (item: SelectableItem) => void;
  toggleRange: (toItem: SelectableItem, ordered: readonly SelectableItem[]) => void;
  selectAll: (items: readonly SelectableItem[]) => void;
  reconcile: (latest: readonly SelectableItem[]) => void;
  clear: () => void;
}

// Thin component-facing view over `useIssueSelectionStore`, scoped to one
// `${type}:${projectPath}` key. The returned actions are stable per key, so a
// reference captured here (e.g. handed to the bulk-create dialog) keeps working
// even if this component remounts — it just calls back into the module store.
export function useIssueSelection(
  type: "issue" | "pr",
  projectPath: string
): UseIssueSelectionReturn {
  const key = `${type}:${projectPath}`;

  const selectedItems = useIssueSelectionStore(
    (s) => s.selections.get(key)?.items ?? EMPTY_SELECTED_ITEMS
  );
  const toggleAction = useIssueSelectionStore((s) => s.toggle);
  const toggleRangeAction = useIssueSelectionStore((s) => s.toggleRange);
  const selectAllAction = useIssueSelectionStore((s) => s.selectAll);
  const reconcileAction = useIssueSelectionStore((s) => s.reconcile);
  const clearAction = useIssueSelectionStore((s) => s.clear);

  // Derived, never stored: a second container holding the same membership is
  // exactly what used to drift out of step with the items.
  const selectedIds = useMemo(() => new Set(selectedItems.keys()), [selectedItems]);

  const toggle = useCallback(
    (item: SelectableItem) => toggleAction(key, item),
    [toggleAction, key]
  );
  const toggleRange = useCallback(
    (toItem: SelectableItem, ordered: readonly SelectableItem[]) =>
      toggleRangeAction(key, toItem, ordered),
    [toggleRangeAction, key]
  );
  const selectAll = useCallback(
    (items: readonly SelectableItem[]) => selectAllAction(key, items),
    [selectAllAction, key]
  );
  const reconcile = useCallback(
    (latest: readonly SelectableItem[]) => reconcileAction(key, latest),
    [reconcileAction, key]
  );
  const clear = useCallback(() => clearAction(key), [clearAction, key]);

  return {
    selectedItems,
    selectedIds,
    isSelectionActive: selectedItems.size > 0,
    toggle,
    toggleRange,
    selectAll,
    reconcile,
    clear,
  };
}
