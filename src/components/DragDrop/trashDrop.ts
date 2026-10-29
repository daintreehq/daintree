import { usePanelStore } from "@/store";
import {
  consultPanelCloseGuards,
  hasPanelCloseGuard,
  isPanelClosePending,
} from "@/services/panelCloseGuard";

function groupMemberIds(panelId: string): string[] {
  const group = usePanelStore.getState().getPanelGroup(panelId);
  return group ? [...group.panelIds] : [panelId];
}

/**
 * Dropping a panel on the Trash pill is a close, so it trashes the whole tab
 * group the way the X does and asks the same unsaved-work questions first
 * (#14943). A cancel on any member leaves the group where it was. A drop with
 * no guarded member trashes synchronously, as it always did.
 */
export function trashDroppedPanel(panelId: string): void {
  const memberIds = groupMemberIds(panelId);

  // A prompt for one of these panels is already open; the first answer decides.
  if (memberIds.some(isPanelClosePending)) return;

  if (!memberIds.some(hasPanelCloseGuard)) {
    usePanelStore.getState().trashPanelGroup(panelId);
    return;
  }

  void consultPanelCloseGuards(memberIds).then((proceed) => {
    if (!proceed) return;
    // The prompt took time. The panel may have been removed or trashed by
    // another path meanwhile, or its group may have gained a member nobody
    // was asked about — the next drop will ask.
    const panel = usePanelStore.getState().panelsById[panelId];
    if (panel === undefined || panel.location === "trash") return;
    const currentIds = groupMemberIds(panelId);
    if (
      currentIds.length !== memberIds.length ||
      currentIds.some((id) => !memberIds.includes(id))
    ) {
      return;
    }
    usePanelStore.getState().trashPanelGroup(panelId);
  });
}
