import { usePanelStore } from "@/store";
import { useLayoutUndoStore } from "@/store/layoutUndoStore";
import {
  consultPanelCloseGuards,
  hasPanelCloseGuard,
  isPanelClosePending,
} from "@/services/panelCloseGuard";

function commitTrash(panelId: string): void {
  useLayoutUndoStore.getState().pushLayoutSnapshot();
  usePanelStore.getState().trashPanelGroup(panelId);
}

/**
 * Dropping a panel on the Trash pill is a close, so it trashes the whole tab
 * group the way the X does and asks the same unsaved-work questions first
 * (#14943). A cancel on any member leaves the group where it was. A drop with
 * no guarded member trashes synchronously, as it always did.
 */
export function trashDroppedPanel(panelId: string): void {
  const group = usePanelStore.getState().getPanelGroup(panelId);
  const memberIds = group ? [...group.panelIds] : [panelId];

  if (!memberIds.some(hasPanelCloseGuard)) {
    commitTrash(panelId);
    return;
  }

  // A prompt for one of these panels is already open; the first answer decides.
  if (memberIds.some(isPanelClosePending)) return;

  void consultPanelCloseGuards(memberIds).then((proceed) => {
    if (!proceed) return;
    // The prompt took time; the panel may have been removed or trashed by
    // another path meanwhile.
    const panel = usePanelStore.getState().panelsById[panelId];
    if (panel === undefined || panel.location === "trash") return;
    commitTrash(panelId);
  });
}
