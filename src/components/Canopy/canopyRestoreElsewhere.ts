import type { HostId } from "@shared/types/remoteHosts";
import type { ProjectFocusOnActivateIntent } from "@shared/types/ipc/project";
import { isScratchWorkspaceId } from "@shared/utils/workspaceIds";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { switchToHost } from "@/components/Hosts/hostSwitching";
import { notify } from "@/lib/notify";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { placeOf } from "./canopyInboxPlace";
import type { CanopyTrashItem } from "./canopyTrash";

/**
 * Restore a run from Canopy's Trash whose project has no view open on its
 * host: the window goes to that project, as Go to terminal takes it, and the
 * project asks its host again once it is up, landing on the pane the run
 * comes back in. The panel closes with the switch, as it does for Go to
 * terminal; on another host it closes once the window lands there.
 */
export function restoreInItsProject(
  item: Pick<CanopyTrashItem, "runId" | "spawnedAt" | "expiresAt" | "row">,
  shown: { hostId: HostId | null; ownHostId: HostId },
  panel: { closeForTerminal: (runId: string) => void; stillShows: () => boolean }
): void {
  const place = placeOf(
    { runId: item.runId, workspaceId: item.row.run.workspaceId },
    shown.hostId,
    shown.ownHostId
  );
  const focusIntent: ProjectFocusOnActivateIntent = {
    intent: "restore-trashed",
    runId: place.runId,
    spawnedAt: item.spawnedAt,
    expiresAt: item.expiresAt,
  };
  if (place.hostId !== null) {
    void switchToHost(place.hostId, false, place.workspaceId, {
      focusIntent,
      onLanded: () => {
        if (panel.stillShows()) panel.closeForTerminal(item.runId);
      },
    });
    return;
  }
  panel.closeForTerminal(item.runId);
  const switching = isScratchWorkspaceId(place.workspaceId)
    ? useScratchStore.getState().switchScratch(place.workspaceId, { focusIntent })
    : useProjectStore.getState().switchProject(place.workspaceId, { focusIntent });
  void Promise.resolve(switching).catch((error: unknown) => {
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "error",
      title: "Couldn't restore terminal",
      message: formatErrorMessage(error, "Daintree couldn't open the project it ran in."),
      context: { eventKind: "agent" },
      duration: 6000,
    });
  });
}
