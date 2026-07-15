import { notify } from "@/lib/notify";
import { systemClient } from "@/clients/systemClient";
import type { HydrateResult } from "@shared/types/ipc/app";

// One-shot guard so the GPU-disabled toast fires at most once per renderer
// lifecycle. Per-window module singleton; reset on app restart.
export const gpuAccelNotifiedRef = { current: false };

export function __resetGpuAccelNotifiedForTests(): void {
  gpuAccelNotifiedRef.current = false;
}

export function dispatchRecoveryNotifications(hydrateResult: HydrateResult): void {
  // Only the crash-fallback disable warrants a boot notification — a user who
  // toggled acceleration off in Settings > Troubleshooting already knows.
  if (
    hydrateResult.gpuHardwareAccelerationDisabled &&
    hydrateResult.gpuDisabledReason === "crash" &&
    !gpuAccelNotifiedRef.current
  ) {
    gpuAccelNotifiedRef.current = true;
    notify({
      type: "warning",
      title: "Hardware acceleration disabled",
      message:
        "Daintree disabled GPU acceleration after repeated GPU crashes. Performance may be reduced. Re-enabling restarts the app.",
      priority: "watch",
      duration: 0,
      context: { eventKind: "recovery" },
      action: {
        label: "Re-enable",
        onClick: () => window.electron.gpu.setHardwareAcceleration(true),
      },
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
        context: { eventKind: "recovery" },
      });
    } else {
      notify({
        type: "warning",
        title: "Settings reset to defaults",
        message: `Your settings file was corrupted and no backup was available. Settings have been reset to defaults.${pathNote}`,
        priority: "high",
        duration: 0,
        context: { eventKind: "recovery" },
      });
    }
  }

  if (hydrateResult.databaseRecovery) {
    const { kind, quarantinedPath } = hydrateResult.databaseRecovery;
    const pathNote = quarantinedPath ? `\nCorrupt file preserved at: ${quarantinedPath}` : "";
    const revealAction = quarantinedPath
      ? {
          label: "Show damaged file",
          onClick: () => {
            void systemClient.showItemInFolderUnconfined(quarantinedPath);
          },
        }
      : undefined;

    if (kind === "restored-from-backup") {
      notify({
        type: "warning",
        title: "Database restored from backup",
        message: `Daintree's database was corrupted and has been restored from a backup. Projects or history added since that backup may be missing.${pathNote}`,
        priority: "high",
        duration: 8000,
        context: { eventKind: "recovery" },
        action: revealAction,
      });
    } else {
      notify({
        type: "warning",
        title: "Database reset",
        message: `Daintree's database was corrupted and no usable backup was available, so it started fresh. Re-add your projects to continue — your repositories and worktrees on disk are untouched.${pathNote}`,
        priority: "high",
        duration: 0,
        context: { eventKind: "recovery" },
        action: revealAction,
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
      context: { eventKind: "recovery" },
    });
  }

  if (hydrateResult.crashLoopStateRecovery) {
    const { quarantinedPath } = hydrateResult.crashLoopStateRecovery;
    notify({
      type: "warning",
      title: "Crash-loop state corrupted",
      message: `The crash-loop tracker file was corrupted and has been reset. The corrupt file is preserved at: ${quarantinedPath}`,
      priority: "high",
      duration: 0,
      context: { eventKind: "recovery" },
    });
  }
}
