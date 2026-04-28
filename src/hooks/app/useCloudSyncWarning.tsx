import { useEffect, useRef } from "react";
import { useProjectStore } from "@/store";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectSettings } from "../useProjectSettings";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { useNotificationStore } from "@/store/notificationStore";
import { detectCloudSyncService, type Platform } from "@/utils/cloudSyncDetection";
import { isMac, isLinux } from "@/lib/platform";
import { formatErrorMessage } from "@shared/utils/errorMessage";

function getPlatform(): Platform {
  if (isMac()) return "mac";
  if (isLinux()) return "linux";
  return "windows";
}

export function useCloudSyncWarning(homeDir?: string) {
  const currentProject = useProjectStore((state) => state.currentProject);
  const { settings, projectId: settingsProjectId } = useProjectSettingsStore();
  const { saveSettings } = useProjectSettings();
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  const lastNotifiedProjectRef = useRef<string | null>(null);
  const notificationIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentProject?.id || settingsProjectId !== currentProject.id || !settings || !homeDir) {
      return;
    }

    if (settings.cloudSyncWarningDismissed) {
      return;
    }

    if (lastNotifiedProjectRef.current === currentProject.id) {
      return;
    }

    const service = detectCloudSyncService(currentProject.path, homeDir, getPlatform());

    if (!service) {
      return;
    }

    lastNotifiedProjectRef.current = currentProject.id;

    const notificationId = notify({
      type: "warning",
      placement: "grid-bar",
      title: "Cloud Sync Folder Detected",
      message: `This project is in a ${service}-synced folder. File sync can interfere with terminal operations and git. Consider moving the project to a local folder.`,
      inboxMessage: `Cloud sync warning: project is in a ${service}-synced folder`,
      actions: [
        {
          label: "Don\u2019t Show Again",
          variant: "secondary",
          onClick: async () => {
            try {
              const latestSettings = useProjectSettingsStore.getState().settings;
              if (!latestSettings) return;

              await saveSettings({
                ...latestSettings,
                cloudSyncWarningDismissed: true,
              });
              removeNotification(notificationId);
            } catch (err) {
              logError("Failed to save cloud sync warning preference", err);
              notify({
                type: "error",
                title: "Failed to save preference",
                message: formatErrorMessage(err, "Failed to save cloud sync warning preference"),
                duration: 6000,
              });
              lastNotifiedProjectRef.current = null;
            }
          },
        },
      ],
      duration: 0,
    });

    notificationIdRef.current = notificationId;

    return () => {
      if (notificationIdRef.current) {
        removeNotification(notificationIdRef.current);
      }
    };
  }, [
    currentProject?.id,
    currentProject?.path,
    settingsProjectId,
    settings,
    homeDir,
    saveSettings,
    removeNotification,
  ]);
}
