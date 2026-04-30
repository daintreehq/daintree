import { useEffect, useRef } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import { notify } from "@/lib/notify";
import { isElectronAvailable } from "@/hooks/useElectron";

const DISK_SPACE_CORRELATION_ID = "disk-space-warning";

let ipcListenerAttached = false;

function findLiveDiskSpaceToastId(): string | null {
  const match = useNotificationStore
    .getState()
    .notifications.find((n) => !n.dismissed && n.correlationId === DISK_SPACE_CORRELATION_ID);
  return match?.id ?? null;
}

export function useDiskSpaceWarnings(): void {
  const didAttachListener = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    ipcListenerAttached = true;
    didAttachListener.current = true;

    const unsubscribe = window.electron.window.onDiskSpaceStatus((payload) => {
      if (payload.status === "normal") {
        const liveId = findLiveDiskSpaceToastId();
        if (liveId) {
          useNotificationStore.getState().dismissNotification(liveId);
        }
        return;
      }

      const mb = Math.round(payload.availableMb);

      // urgent: critical/low disk warnings must surface even during quiet hours.
      // correlationId routes repeats through the store's collapse path so a
      // critical→low transition updates the same toast in place.
      if (payload.status === "critical") {
        notify({
          type: "error",
          priority: "high",
          urgent: true,
          correlationId: DISK_SPACE_CORRELATION_ID,
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
        const liveId = findLiveDiskSpaceToastId();
        if (liveId) {
          useNotificationStore.getState().dismissNotification(liveId);
        }
      }
    };
  }, []);
}
