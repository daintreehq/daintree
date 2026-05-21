import { useEffect, useRef } from "react";
import { notify } from "@/lib/notify";
import { isElectronAvailable } from "@/hooks/useElectron";

const DISK_SPACE_CORRELATION_ID = "disk-space-warning";
const DISK_SPACE_SUPERSEDE_KEY = "disk-space";

let ipcListenerAttached = false;

export function useDiskSpaceWarnings(): void {
  const didAttachListener = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    ipcListenerAttached = true;
    didAttachListener.current = true;

    const unsubscribe = window.electron.window.onDiskSpaceStatus((payload) => {
      if (payload.status === "normal") {
        // Resolution row: priority "low" routes to inbox only; `supersedeKey`
        // archives the prior warning entry automatically. Keyboard-only and
        // screen-reader users get an explicit "back to normal" acknowledgement.
        notify({
          type: "success",
          priority: "low",
          supersedeKey: DISK_SPACE_SUPERSEDE_KEY,
          title: "Disk space restored",
          message: "Disk space is back to normal.",
        });
        return;
      }

      const mb = Math.round(payload.availableMb);

      // urgent: critical/low disk warnings must surface even during quiet hours.
      // correlationId routes repeats through the store's collapse path so a
      // critical→low transition updates the same toast in place.
      // supersedeKey pairs the warning with a later "Disk space restored"
      // resolution row so the inbox doesn't accumulate stale stateful rows.
      if (payload.status === "critical") {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          priority: "high",
          urgent: true,
          correlationId: DISK_SPACE_CORRELATION_ID,
          supersedeKey: DISK_SPACE_SUPERSEDE_KEY,
          duration: 0,
          title: "Critical: Disk space very low",
          message: `Only ${mb} MB remaining. Session backups and terminal snapshots have been paused. Free disk space immediately.`,
          inboxMessage: `Critical disk space: ${mb} MB remaining. Writes paused.`,
        });
      } else {
        notify({
          type: "warning",
          priority: "high",
          urgent: true,
          correlationId: DISK_SPACE_CORRELATION_ID,
          supersedeKey: DISK_SPACE_SUPERSEDE_KEY,
          duration: 8000,
          title: "Low disk space",
          message: `${mb} MB remaining on the application data volume. Free disk space to avoid data loss.`,
          inboxMessage: `Low disk space: ${mb} MB remaining.`,
        });
      }
    });

    return () => {
      if (didAttachListener.current) {
        unsubscribe();
        ipcListenerAttached = false;
      }
    };
  }, []);
}
