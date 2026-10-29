import { useLayoutUndoStore } from "@/store/layoutUndoStore";
import { usePanelStore } from "@/store/panelStore";

/**
 * Tab-strip reorders skip DndProvider, so they take their own undo snapshot.
 * It is taken only when the store will accept the order and it differs from the
 * current one, so a rejected or no-op drag adds no history entry and does not
 * clear the redo stack.
 */
export function reorderGroupTabsWithUndo(groupId: string, newOrder: string[]): void {
  const panelStore = usePanelStore.getState();
  const group = panelStore.tabGroups.get(groupId);
  if (!group) return;

  const current = group.panelIds;
  if (current.length !== newOrder.length) return;
  const currentSet = new Set(current);
  if (currentSet.size !== new Set(newOrder).size || !newOrder.every((id) => currentSet.has(id))) {
    return;
  }
  if (current.every((id, i) => id === newOrder[i])) return;

  useLayoutUndoStore.getState().pushLayoutSnapshot();
  panelStore.reorderPanelsInGroup(groupId, newOrder);
}
