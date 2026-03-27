import { useEffect, useRef } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import { isElectronAvailable } from "@/hooks/useElectron";

let ipcListenerAttached = false;

export function useDiskSpaceWarnings(): void {
  const didAttachListener = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    ipcListenerAttached = true;
    didAttachListener.current = true;

    let activeNotificationId: string | null = null;

    const unsubscribe = window.electron.window.onDiskSpaceStatus((payload) => {
      const store = useNotificationStore.getState();

      if (payload.status === "normal") {
        if (activeNotificationId) {
          store.dismissNotification(activeNotificationId);
          activeNotificationId = null;
        }
        return;
      }

      if (activeNotificationId) {
        store.dismissNotification(activeNotificationId);
        activeNotificationId = null;
      }

      const mb = Math.round(payload.availableMb);

      if (payload.status === "critical") {
        activeNotificationId = store.addNotification({
          type: "error",
          priority: "high",
          duration: 0,
          title: "Critical: Disk space very low",
          message: `Only ${mb} MB remaining. Session backups and terminal snapshots have been paused. Free disk space immediately.`,
          inboxMessage: `Critical disk space: ${mb} MB remaining. Writes paused.`,
        });
      } else {
        activeNotificationId = store.addNotification({
          type: "warning",
          priority: "high",
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
        if (activeNotificationId) {
          useNotificationStore.getState().dismissNotification(activeNotificationId);
        }
      }
    };
  }, []);
}
