import { useEffect, useRef } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import { notify } from "@/lib/notify";

function DownloadProgress({ percent }: { percent: number }) {
  const pct = Math.round(percent);
  return (
    <div className="space-y-1">
      <span>{pct}% complete</span>
      <div className="h-1 w-full rounded-full bg-tint/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-canopy-accent transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export function useUpdateListener(suppressToasts = false): void {
  const toastIdRef = useRef<string | null>(null);
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
    } else {
      const id = notify({
        type: "info",
        title: "Update Available",
        message: `Version ${version} is downloading...`,
        inboxMessage: `Version ${version} is downloading`,
        priority: "high",
        duration: 0,
      });
      toastIdRef.current = id || null;
    }
  }, [suppressToasts]);

  useEffect(() => {
    if (!window.electron?.update) return;

    const cleanupAvailable = window.electron.update.onUpdateAvailable((info) => {
      if (suppressRef.current) {
        pendingUpdateRef.current = { version: info.version, downloaded: false };
        return;
      }
      const id = notify({
        type: "info",
        title: "Update Available",
        message: `Version ${info.version} is downloading...`,
        inboxMessage: `Version ${info.version} is downloading`,
        priority: "high",
        duration: 0,
      });
      toastIdRef.current = id || null;
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
      if (toastIdRef.current) {
        useNotificationStore.getState().updateNotification(toastIdRef.current, {
          type: "success",
          title: "Update Ready",
          message: `Version ${info.version} is ready to install.`,
          inboxMessage: `Version ${info.version} ready to install`,
          duration: 0,
          dismissed: false,
          action: {
            label: "Restart to Update",
            onClick: () => window.electron?.update?.quitAndInstall(),
          },
        });
      } else {
        // Quiet period was active when update-available fired — create fresh toast
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
    });

    return () => {
      cleanupAvailable();
      cleanupProgress();
      cleanupDownloaded();
    };
  }, []);
}
