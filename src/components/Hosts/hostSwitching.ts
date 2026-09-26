import type { MouseEvent } from "react";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";
import type { SwitchWindowHostResult } from "@shared/types/ipc/remoteHosts";
import { isMac } from "@/lib/platform";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isClientAppError } from "@/utils/clientAppError";
import { requestHostProjectPicker } from "@/components/HostSwitch/hostProjectPickerRequests";
import { getHostListSnapshot } from "./hostList";
import { clientPlatform, localHostLabel } from "./hostModel";
import { hostUpdateOffer, runHostUpdate } from "./hostUpdate";

/** Cmd-click on macOS, Ctrl-click elsewhere: open the host in a new window. */
export function isNewWindowClick(event: Pick<MouseEvent, "metaKey" | "ctrlKey">): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

/** The host as the host menu names it. */
function hostName(hostId: HostId): string {
  if (hostId === LOCAL_HOST_ID) return localHostLabel(clientPlatform());
  const entry = getHostListSnapshot().hosts.find((candidate) => candidate.descriptor.id === hostId);
  return entry?.descriptor.name ?? hostId;
}

/**
 * Where a switch that named no project lands when the host had nothing to
 * return to: that host's project list, shown in this window to pick from.
 */
export function followSwitchResult(result: SwitchWindowHostResult | null | undefined): void {
  if (result?.outcome !== "choose-project") return;
  if (requestHostProjectPicker(result.hostId)) return;
  notify({
    type: "info",
    context: { eventKind: "connectivity" },
    title: `No project to return to on ${hostName(result.hostId)}`,
    message:
      "Pick one from the project switcher, or Cmd/Ctrl-click the host to open it in a new window.",
  });
}

/** Switch this window (or a new one) to a host, optionally straight into one of its projects. */
export async function switchToHost(
  hostId: HostId,
  newWindow: boolean,
  projectId?: string
): Promise<void> {
  try {
    const result = await window.electron.remoteHosts.switchWindowHost(
      projectId === undefined ? { hostId, newWindow } : { hostId, newWindow, projectId }
    );
    followSwitchResult(result);
  } catch (error) {
    // Refused for its build: the update is what gets this host back, so it is
    // offered right here as well as in the host menu.
    const entry =
      isClientAppError(error) && error.code === "HOST_VERSION_MISMATCH"
        ? getHostListSnapshot().hosts.find((candidate) => candidate.descriptor.id === hostId)
        : undefined;
    const update = entry ? hostUpdateOffer(entry) : null;
    notify({
      type: "error",
      context: { eventKind: "connectivity" },
      title: `Couldn't switch to ${hostName(hostId)}`,
      message: formatErrorMessage(error, "The window stayed on its current host."),
      actions: update
        ? [
            {
              label: update.label,
              variant: "primary",
              onClick: () => runHostUpdate(update.target, update.hostId),
            },
          ]
        : [
            {
              label: "Retry",
              variant: "primary",
              onClick: () => void switchToHost(hostId, newWindow, projectId),
            },
          ],
    });
  }
}
