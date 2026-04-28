import { useEffect, useRef } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";

const AVAILABLE_HINT = 'Use "Check for Updates..." to check again.';
const UPDATE_CORRELATION_ID = "app-update";

function DownloadProgress({ percent }: { percent: number }) {
  const pct = Math.round(percent);
  return (
    <div className="space-y-1">
      <span>{pct}% complete</span>
      <div className="h-1 w-full rounded-full bg-tint/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-daintree-accent transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function findLiveUpdateToastId(): string | null {
  const match = useNotificationStore
    .getState()
    .notifications.find((n) => !n.dismissed && n.correlationId === UPDATE_CORRELATION_ID);
  return match?.id ?? null;
}

export function useUpdateListener(suppressToasts = false): void {
  const suppressRef = useRef(suppressToasts);
  const pendingUpdateRef = useRef<{ version: string; downloaded: boolean } | null>(null);

  // Keep ref in sync
  useEffect(() => {
    suppressRef.current = suppressToasts;
  }, [suppressToasts]);

  // Surface pending update when suppression lifts
  useEffect(() => {
    if (suppressToasts) return;
    if (!pendingUpdateRef.current) return;

    const { version, downloaded } = pendingUpdateRef.current;
    pendingUpdateRef.current = null;

    if (downloaded) {
      useNotificationStore.getState().addNotification({
        type: "success",
        title: "Update Ready",
        message: `Version ${version} is ready to install.`,
        inboxMessage: `Version ${version} ready to install`,
        priority: "high",
        duration: 0,
        correlationId: UPDATE_CORRELATION_ID,
        action: {
          label: "Restart to Update",
          onClick: () => window.electron?.update?.quitAndInstall(),
        },
      });
    } else {
      notify({
        type: "info",
        title: "Update Available",
        message: `Version ${version} is downloading...`,
        inboxMessage: `Version ${version} is downloading. ${AVAILABLE_HINT}`,
        priority: "high",
        duration: 0,
        correlationId: UPDATE_CORRELATION_ID,
        // Explicit undefined: if a prior "Update Ready" toast is live (stage
        // regression), clear its "Restart to Update" action so the user does
        // not accidentally restart into a stale build while a newer one is
        // still downloading.
        action: undefined,
        onDismiss: () => {
          void window.electron?.update
            ?.notifyDismiss?.(version)
            ?.catch((err) => logError("[useUpdateListener] notifyDismiss failed", err));
        },
      });
    }
  }, [suppressToasts]);

  useEffect(() => {
    if (!window.electron?.update) return;

    const cleanupAvailable = window.electron.update.onUpdateAvailable((info) => {
      if (suppressRef.current) {
        // Never downgrade a pending "downloaded" to "available" — a follow-up
        // re-check during the startup quiet period must not roll the stored
        // state back so the user is still told "Update Ready" once toasts
        // unmute.
        if (!pendingUpdateRef.current?.downloaded) {
          pendingUpdateRef.current = { version: info.version, downloaded: false };
        }
        return;
      }
      // Repeats and re-checks collapse onto the same toast via correlationId;
      // no bespoke dedup ref needed. The store's collapse path resets the
      // auto-dismiss timer and increments the count badge.
      const version = info.version;
      notify({
        type: "info",
        title: "Update Available",
        message: `Version ${version} is downloading...`,
        inboxMessage: `Version ${version} is downloading. ${AVAILABLE_HINT}`,
        priority: "high",
        duration: 0,
        correlationId: UPDATE_CORRELATION_ID,
        // Explicit undefined: see the pending-update effect above — same
        // rationale (stage regression from Update Ready must not leave the
        // restart action attached to a downloading-again toast).
        action: undefined,
        // Forwarded to main only when the user explicitly closes the toast —
        // MAX_VISIBLE_TOASTS eviction and programmatic dismissals bypass this.
        onDismiss: () => {
          void window.electron?.update
            ?.notifyDismiss?.(version)
            ?.catch((err) => logError("[useUpdateListener] notifyDismiss failed", err));
        },
      });
    });

    const cleanupProgress = window.electron.update.onDownloadProgress((info) => {
      const liveId = findLiveUpdateToastId();
      if (!liveId) return;
      useNotificationStore.getState().updateNotification(liveId, {
        title: "Downloading Update",
        message: <DownloadProgress percent={info.percent} />,
        inboxMessage: `Downloading update: ${Math.round(info.percent)}%`,
      });
    });

    const cleanupDownloaded = window.electron.update.onUpdateDownloaded((info) => {
      if (suppressRef.current) {
        pendingUpdateRef.current = { version: info.version, downloaded: true };
        return;
      }
      const liveId = findLiveUpdateToastId();
      if (liveId) {
        // Stage transition: clear the Available-stage onDismiss so dismissing
        // the Update Ready toast does not start the 24h Available cooldown.
        // The user still needs to be re-reminded about the pending install.
        useNotificationStore.getState().updateNotification(liveId, {
          type: "success",
          title: "Update Ready",
          message: `Version ${info.version} is ready to install.`,
          inboxMessage: `Version ${info.version} ready to install`,
          duration: 0,
          dismissed: false,
          onDismiss: undefined,
          action: {
            label: "Restart to Update",
            onClick: () => window.electron?.update?.quitAndInstall(),
          },
        });
      } else {
        // Either the quiet period was active when update-available fired, or
        // the user dismissed the "Available" toast. Either way, the
        // "Downloaded" stage is a distinct notification and must not be
        // swallowed by the Available-stage cooldown — create a fresh toast.
        useNotificationStore.getState().addNotification({
          type: "success",
          title: "Update Ready",
          message: `Version ${info.version} is ready to install.`,
          inboxMessage: `Version ${info.version} ready to install`,
          priority: "high",
          duration: 0,
          correlationId: UPDATE_CORRELATION_ID,
          action: {
            label: "Restart to Update",
            onClick: () => window.electron?.update?.quitAndInstall(),
          },
        });
      }
    });

    return () => {
      cleanupAvailable();
      cleanupProgress();
      cleanupDownloaded();
    };
  }, []);
}
