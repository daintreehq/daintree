import { useEffect, useRef } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { notify } from "@/lib/notify";
import { detectCloudSyncService, type Platform } from "@/utils/cloudSyncDetection";
import { getCloudSyncWarningCopy } from "@/utils/cloudSyncWarningCopy";
import { isMac, isLinux } from "@/lib/platform";

function getPlatform(): Platform {
  if (isMac()) return "mac";
  if (isLinux()) return "linux";
  return "windows";
}

export function useCloudSyncWarning(homeDir?: string) {
  const currentProject = useProjectStore((state) => state.currentProject);
  const settingsProjectId = useProjectSettingsStore((s) => s.projectId);
  const hasSettings = useProjectSettingsStore((s) => s.settings !== null);
  const cloudSyncWarningDismissed = useProjectSettingsStore(
    (s) => s.settings?.cloudSyncWarningDismissed === true
  );
  const lastInboxedProjectRef = useRef<string | null>(null);

  useEffect(() => {
    const setBanner = useCloudSyncBannerStore.getState().setBanner;

    if (
      !currentProject?.id ||
      settingsProjectId !== currentProject.id ||
      !hasSettings ||
      !homeDir
    ) {
      setBanner({ service: null, projectId: null });
      return;
    }

    if (cloudSyncWarningDismissed) {
      setBanner({ service: null, projectId: null });
      return;
    }

    const service = detectCloudSyncService(currentProject.path, homeDir, getPlatform());

    if (!service) {
      setBanner({ service: null, projectId: null });
      return;
    }

    setBanner({ service, projectId: currentProject.id });

    // Inbox entry once per project — banner is the live surface; the entry is
    // an audit trail that survives when a higher-priority global banner
    // suppresses the live banner. Explicit priority:"low" keeps it inbox-only
    // (it overrides the host kind's time-sensitive default); the project-scoped
    // supersedeKey retires the prior row when the same project re-detects, and
    // the ref guards against re-firing on rerenders.
    if (lastInboxedProjectRef.current !== currentProject.id) {
      lastInboxedProjectRef.current = currentProject.id;
      const copy = getCloudSyncWarningCopy(service);
      notify({
        type: "warning",
        priority: "low",
        title: copy.title,
        message: copy.description,
        supersedeKey: `cloud-sync:${currentProject.id}`,
        countable: false,
        context: { eventKind: "host" },
      });
    }
  }, [
    currentProject?.id,
    currentProject?.path,
    settingsProjectId,
    hasSettings,
    cloudSyncWarningDismissed,
    homeDir,
  ]);
}
