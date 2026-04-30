import { useEffect, useRef } from "react";
import { useProjectStore } from "@/store";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { detectCloudSyncService, type Platform } from "@/utils/cloudSyncDetection";
import { isMac, isLinux } from "@/lib/platform";

function getPlatform(): Platform {
  if (isMac()) return "mac";
  if (isLinux()) return "linux";
  return "windows";
}

export function useCloudSyncWarning(homeDir?: string) {
  const currentProject = useProjectStore((state) => state.currentProject);
  const { settings, projectId: settingsProjectId } = useProjectSettingsStore();
  const lastInboxedProjectRef = useRef<string | null>(null);

  useEffect(() => {
    const setBanner = useCloudSyncBannerStore.getState().setBanner;

    if (!currentProject?.id || settingsProjectId !== currentProject.id || !settings || !homeDir) {
      setBanner({ service: null, projectId: null });
      return;
    }

    if (settings.cloudSyncWarningDismissed) {
      setBanner({ service: null, projectId: null });
      return;
    }

    const service = detectCloudSyncService(currentProject.path, homeDir, getPlatform());

    if (!service) {
      setBanner({ service: null, projectId: null });
      return;
    }

    setBanner({ service, projectId: currentProject.id });

    // Inbox entry once per project — banner is the live surface; the entry is an audit trail.
    if (lastInboxedProjectRef.current !== currentProject.id) {
      lastInboxedProjectRef.current = currentProject.id;
      useNotificationHistoryStore.getState().addEntry({
        type: "warning",
        title: "Cloud sync folder detected",
        message: `Project is in a ${service}-synced folder which can interfere with terminal operations and git.`,
        countable: false,
      });
    }
  }, [currentProject?.id, currentProject?.path, settingsProjectId, settings, homeDir]);
}
