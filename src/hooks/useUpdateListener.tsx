import { useEffect, useRef } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import { notify } from "@/lib/notify";

const AVAILABLE_HINT = 'Use "Check for Updates..." to check again.';

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

function isToastLive(id: string | null): boolean {
  if (!id) return false;
  const existing = useNotificationStore.getState().notifications.find((n) => n.id === id);
  return Boolean(existing && !existing.dismissed);
}

export function useUpdateListener(suppressToasts = false): void {
  const toastIdRef = useRef<string | null>(null);
  const versionRef = useRef<string | null>(null);
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
      toastIdRef.current = useNotificationStore.getState().addNotification({
        type: "success",
        title: "Update Ready",
        message: `Version ${version} is ready to install.`,
        inboxMessage: `Version ${version} ready to install`,
        priority: "high",
        duration: 0,
        action: {
          label: "Restart to Update",
          onClick: () => window.electron?.update?.quitAndInstall(),
        },
      });
      versionRef.current = version;
    } else {
      const id = notify({
        type: "info",
        title: "Update Available",
        message: `Version ${version} is downloading...`,
        inboxMessage: `Version ${version} is downloading. ${AVAILABLE_HINT}`,
        priority: "high",
        duration: 0,
        onDismiss: () => {
          void window.electron?.update
            ?.notifyDismiss?.(version)
            ?.catch((err) => console.error("[useUpdateListener] notifyDismiss failed:", err));
        },
      });
      toastIdRef.current = id || null;
      versionRef.current = id ? version : null;
    }
  }, [suppressToasts]);

  useEffect(() => {
    if (!window.electron?.update) return;

    const cleanupAvailable = window.electron.update.onUpdateAvailable((info) => {
      if (suppressRef.current) {
        pendingUpdateRef.current = { version: info.version, downloaded: false };
        return;
      }
      // Dedup: if the same-version toast is still live, don't stack a duplicate.
      // A different version always shows a fresh toast (supersedes the old one
      // via the notification store's MAX_VISIBLE_TOASTS eviction).
      if (versionRef.current === info.version && isToastLive(toastIdRef.current)) {
        return;
      }
      const version = info.version;
      const id = notify({
        type: "info",
        title: "Update Available",
        message: `Version ${version} is downloading...`,
        inboxMessage: `Version ${version} is downloading. ${AVAILABLE_HINT}`,
        priority: "high",
        duration: 0,
        // Forwarded to main only when the user explicitly closes the toast —
        // MAX_VISIBLE_TOASTS eviction and programmatic dismissals bypass this.
        onDismiss: () => {
          void window.electron?.update
            ?.notifyDismiss?.(version)
            ?.catch((err) => console.error("[useUpdateListener] notifyDismiss failed:", err));
        },
      });
      toastIdRef.current = id || null;
      versionRef.current = id ? version : null;
    });

    const cleanupProgress = window.electron.update.onDownloadProgress((info) => {
      if (!toastIdRef.current) return;
      useNotificationStore.getState().updateNotification(toastIdRef.current, {
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
      if (toastIdRef.current && isToastLive(toastIdRef.current)) {
        // Stage transition: clear the Available-stage onDismiss so dismissing
        // the Update Ready toast does not start the 24h Available cooldown.
        // The user still needs to be re-reminded about the pending install.
        useNotificationStore.getState().updateNotification(toastIdRef.current, {
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
        toastIdRef.current = useNotificationStore.getState().addNotification({
          type: "success",
          title: "Update Ready",
          message: `Version ${info.version} is ready to install.`,
          inboxMessage: `Version ${info.version} ready to install`,
          priority: "high",
          duration: 0,
          action: {
            label: "Restart to Update",
            onClick: () => window.electron?.update?.quitAndInstall(),
          },
        });
      }
      versionRef.current = info.version;
    });

    return () => {
      cleanupAvailable();
      cleanupProgress();
      cleanupDownloaded();
    };
  }, []);
}
