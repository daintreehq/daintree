import { AlertTriangle } from "lucide-react";
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
      notify({
        type: "error",
        title: "Couldn't save preference",
        message: formatErrorMessage(err, "Failed to save cloud sync warning preference"),
        duration: 6000,
      });
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 px-4 py-2 bg-[var(--color-status-warning)]/15 border-b border-[var(--color-status-warning)]/30 text-[var(--color-status-warning)] text-sm shrink-0"
    >
      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">
        This project is in a {service}-synced folder, which can interfere with terminal operations
        and git. Consider moving it to a local folder.
      </span>
      <button
        type="button"
        onClick={handleDismiss}
        className="text-xs px-2 py-1 rounded border border-[var(--color-status-warning)]/30 hover:bg-[var(--color-status-warning)]/10 transition-colors shrink-0"
      >
        Don&rsquo;t show again
      </button>
    </div>
  );
}
