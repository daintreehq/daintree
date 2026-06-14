import { AlertTriangle } from "lucide-react";
import { actionService } from "@/services/ActionService";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useRosettaBannerStore } from "@/store/rosettaBannerStore";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";

const DOWNLOAD_URL = "https://daintree.org/download";

export function RosettaBanner() {
  const visible = useRosettaBannerStore((s) => s.visible);
  const setVisible = useRosettaBannerStore((s) => s.setVisible);

  if (!visible) return null;

  const handleDismiss = async () => {
    // Hide immediately — the dismissal is permanent (the binary's architecture
    // never changes via auto-update), and a persistence failure shouldn't
    // resurrect the banner mid-session; it just returns on the next launch.
    setVisible(false);
    try {
      await window.electron.app.dismissRosettaWarning();
    } catch (err) {
      logError("Failed to save Rosetta warning preference", err);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Couldn't save preference",
        message: formatErrorMessage(err, "Failed to save Rosetta warning preference"),
        duration: 6000,
      });
    }
  };

  const handleDownload = () => {
    void actionService.dispatch("system.openExternal", { url: DOWNLOAD_URL }, { source: "user" });
  };

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title="Running under Rosetta"
      description="This is the Intel build running translated on Apple Silicon, which degrades performance. Install the Apple Silicon build for native speed."
      severity="warning"
      role="status"
      onClose={() => void handleDismiss()}
      closeAriaLabel="Dismiss Rosetta warning"
      actions={[
        {
          id: "download",
          label: "Download Apple Silicon build",
          variant: "primary",
          onClick: handleDownload,
        },
      ]}
    />
  );
}
