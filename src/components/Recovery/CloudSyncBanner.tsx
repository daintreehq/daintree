import { AlertTriangle } from "lucide-react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export function CloudSyncBanner() {
  const service = useCloudSyncBannerStore((s) => s.service);
  const setBanner = useCloudSyncBannerStore((s) => s.setBanner);
  const { saveSettings } = useProjectSettings();

  if (!service) return null;

  const handleDismiss = async () => {
    // Guard against project switch race: the store carries the projectId the
    // banner was raised for; skip the save if it no longer matches the live
    // project (saveSettings would otherwise persist to the wrong project).
    const bannerProjectId = useCloudSyncBannerStore.getState().projectId;
    const livePid = useProjectStore.getState().currentProject?.id ?? null;
    if (!bannerProjectId || bannerProjectId !== livePid) {
      setBanner({ service: null, projectId: null });
      return;
    }

    try {
      const latestSettings = useProjectSettingsStore.getState().settings;
      if (!latestSettings) return;

      await saveSettings({
        ...latestSettings,
        cloudSyncWarningDismissed: true,
      });
      setBanner({ service: null, projectId: null });
    } catch (err) {
      logError("Failed to save cloud sync warning preference", err);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Couldn't save preference",
        message: formatErrorMessage(err, "Failed to save cloud sync warning preference"),
        duration: 6000,
      });
    }
  };

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title="Project in a synced folder"
      description={`This project is in a ${service}-synced folder, which can interfere with terminal operations and git. Consider moving it to a local folder.`}
      severity="warning"
      role="status"
      actions={[
        {
          id: "dismiss",
          label: "Don't warn for this project",
          variant: "primary",
          onClick: handleDismiss,
        },
      ]}
    />
  );
}
