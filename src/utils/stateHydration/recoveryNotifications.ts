import { notify } from "@/lib/notify";
import type { HydrateResult } from "@shared/types/ipc/app";

// One-shot guard so the GPU-disabled toast fires at most once per renderer
// lifecycle. Per-window module singleton; reset on app restart.
export const gpuAccelNotifiedRef = { current: false };

export function __resetGpuAccelNotifiedForTests(): void {
  gpuAccelNotifiedRef.current = false;
}

export function dispatchRecoveryNotifications(hydrateResult: HydrateResult): void {
  if (hydrateResult.gpuHardwareAccelerationDisabled && !gpuAccelNotifiedRef.current) {
    gpuAccelNotifiedRef.current = true;
    notify({
      type: "warning",
      title: "Hardware acceleration disabled",
      message:
        "Daintree disabled GPU acceleration after repeated GPU crashes. Performance may be reduced — re-enable it in Settings > Troubleshooting.",
      priority: "watch",
      duration: 0,
    });
  }

  if (hydrateResult.settingsRecovery) {
    const recovery = hydrateResult.settingsRecovery;
    const pathNote = recovery.quarantinedPath
      ? `\nCorrupt file preserved at: ${recovery.quarantinedPath}`
      : "";

    if (recovery.kind === "restored-from-backup") {
      notify({
        type: "warning",
        title: "Settings restored from backup",
        message: `Your settings file was corrupted and has been restored from a backup. Some recent changes may have been lost.${pathNote}`,
        priority: "high",
        duration: 8000,
      });
    } else {
      notify({
        type: "warning",
        title: "Settings reset to defaults",
        message: `Your settings file was corrupted and no backup was available. Settings have been reset to defaults.${pathNote}`,
        priority: "high",
        duration: 0,
      });
    }
  }

  if (hydrateResult.projectStateRecovery) {
    const { quarantinedPath } = hydrateResult.projectStateRecovery;
    notify({
      type: "warning",
      title: "Project state corrupted",
      message: `Your project state was corrupted and has been reset. The corrupt file is preserved at: ${quarantinedPath}`,
      priority: "high",
      duration: 0,
    });
  }
}
