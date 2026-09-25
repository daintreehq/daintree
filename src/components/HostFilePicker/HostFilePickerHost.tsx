import { useEffect, useSyncExternalStore } from "react";
import { logError } from "@/utils/logger";
import { HostFilePickerDialog } from "./HostFilePickerDialog";
import { currentHostPick, pickHostPaths, subscribeHostPicks } from "./hostFilePickerQueue";

/**
 * Renders the open host picker, and answers pickers the main process asks
 * for: in a window attached to a remote host, the native open dialogs
 * (open folder, locate project, a plugin's path setting) arrive here as
 * requests and are answered with host paths. Mount once per view.
 */
export function HostFilePickerHost() {
  const pick = useSyncExternalStore(subscribeHostPicks, currentHostPick, () => null);

  useEffect(() => {
    const fileTransfer = window.electron?.fileTransfer;
    if (!fileTransfer?.onEvent) return;
    return fileTransfer.onEvent((event) => {
      if (event.type !== "host-pick-request") return;
      void pickHostPaths(event.request)
        .then((paths) => fileTransfer.answerHostPick({ requestId: event.requestId, paths }))
        .catch((error: unknown) =>
          logError("[HostFilePicker] Failed to answer a host pick", error)
        );
    });
  }, []);

  if (!pick) return null;
  return <HostFilePickerDialog key={pick.id} request={pick.request} onResolve={pick.resolve} />;
}
