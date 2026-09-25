import type { MouseEvent } from "react";
import type { HostId } from "@shared/types/remoteHosts";
import { isMac } from "@/lib/platform";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/** Cmd-click on macOS, Ctrl-click elsewhere: open the host in a new window. */
export function isNewWindowClick(event: Pick<MouseEvent, "metaKey" | "ctrlKey">): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

/** Switch this window (or a new one) to a host, optionally straight into one of its projects. */
export async function switchToHost(
  hostId: HostId,
  newWindow: boolean,
  projectId?: string
): Promise<void> {
  try {
    await window.electron.remoteHosts.switchWindowHost(
      projectId === undefined ? { hostId, newWindow } : { hostId, newWindow, projectId }
    );
  } catch (error) {
    notify({
      type: "error",
      context: { eventKind: "connectivity" },
      title: "Couldn't switch host",
      message: formatErrorMessage(error, "The window stayed on its current host."),
      actions: [
        {
          label: "Retry",
          variant: "primary",
          onClick: () => void switchToHost(hostId, newWindow, projectId),
        },
      ],
    });
  }
}
