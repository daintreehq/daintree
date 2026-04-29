import { useEffect, useRef } from "react";
import { useProjectStore } from "@/store";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { useNotificationStore } from "@/store/notificationStore";
import { projectClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";

function formatFileList(files: string[]): string {
  if (files.length === 1) return files[0]!;
  if (files.length === 2) return `${files[0]} and ${files[1]}`;
  return `${files.slice(0, -1).join(", ")}, and ${files[files.length - 1]}`;
}

export function useContextFilesOffer() {
  const currentProject = useProjectStore((state) => state.currentProject);
  const settingsProjectId = useProjectSettingsStore((s) => s.projectId);
  const settingsHydrated = useProjectSettingsStore((s) => s.settings !== null);
  const dismissed = useProjectSettingsStore((s) => s.settings?.contextFilesOfferDismissed === true);
  const removeNotification = useNotificationStore((s) => s.removeNotification);

  // Guards against double-IPC / double-notify for the same project across re-renders.
  // Set at IPC start, cleared only on project change or explicit retry.
  const inFlightProjectRef = useRef<string | null>(null);
  // The active banner's notification id, when one is actually visible.
  const notificationIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentProject?.id || settingsProjectId !== currentProject.id || !settingsHydrated) {
      return;
    }

    if (currentProject.inRepoSettings) {
      return;
    }

    if (dismissed) {
      return;
    }

    if (inFlightProjectRef.current === currentProject.id) {
      return;
    }

    const targetProjectId = currentProject.id;
    inFlightProjectRef.current = targetProjectId;
    let cancelled = false;

    (async () => {
      let foundFiles: string[];
      try {
        foundFiles = await projectClient.detectContextFiles(targetProjectId);
      } catch (error) {
        logError("Failed to detect project context files", error);
        if (inFlightProjectRef.current === targetProjectId) {
          inFlightProjectRef.current = null;
        }
        return;
      }

      if (cancelled) return;
      if (foundFiles.length === 0) return;

      const latestSettingsState = useProjectSettingsStore.getState();
      if (
        latestSettingsState.projectId !== targetProjectId ||
        latestSettingsState.settings?.contextFilesOfferDismissed
      ) {
        return;
      }

      const projectStillCurrent = useProjectStore.getState().currentProject;
      if (projectStillCurrent?.id !== targetProjectId || projectStillCurrent.inRepoSettings) {
        return;
      }

      const fileList = formatFileList(foundFiles);
      const pluralSuffix = foundFiles.length === 1 ? "this file" : "these files";

      const markDismissed = async (): Promise<void> => {
        const freshSettings = useProjectSettingsStore.getState().settings;
        if (!freshSettings) return;
        // Bind persistence to the captured project id, not whichever project is
        // current at click time — guards against rapid project switches.
        await projectClient.saveSettings(targetProjectId, {
          ...freshSettings,
          contextFilesOfferDismissed: true,
        });
      };

      const notificationId = notify({
        type: "info",
        placement: "grid-bar",
        title: "Agent context files detected",
        message: `Found ${fileList} in this project. Use ${pluralSuffix} with your agents?`,
        inboxMessage: `Agent context files detected: ${foundFiles.join(", ")}`,
        actions: [
          {
            label: "Use context files",
            variant: "primary",
            onClick: async () => {
              try {
                await projectClient.enableInRepoSettings(targetProjectId);
                await markDismissed();
                if (notificationIdRef.current) {
                  removeNotification(notificationIdRef.current);
                  notificationIdRef.current = null;
                }
              } catch (err) {
                logError("Failed to enable in-repo settings from context offer", err);
                notify({
                  type: "error",
                  title: "Failed to enable project context",
                  message: formatErrorMessage(err, "Failed to enable project context"),
                  duration: 6000,
                });
                // Allow a retry next time the effect runs for this project.
                if (inFlightProjectRef.current === targetProjectId) {
                  inFlightProjectRef.current = null;
                }
              }
            },
          },
          {
            label: "Skip",
            variant: "secondary",
            onClick: async () => {
              try {
                await markDismissed();
                if (notificationIdRef.current) {
                  removeNotification(notificationIdRef.current);
                  notificationIdRef.current = null;
                }
              } catch (err) {
                logError("Failed to dismiss context files offer", err);
                notify({
                  type: "error",
                  title: "Failed to save preference",
                  message: formatErrorMessage(err, "Failed to dismiss context files offer"),
                  duration: 6000,
                });
                if (inFlightProjectRef.current === targetProjectId) {
                  inFlightProjectRef.current = null;
                }
              }
            },
          },
        ],
        duration: 0,
      });

      if (cancelled) {
        if (notificationId) removeNotification(notificationId);
        return;
      }

      if (!notificationId) {
        // Suppressed by quiet period or notifications-disabled setting. Allow a
        // retry on the next render or the next project open so the offer isn't
        // silently dropped.
        if (inFlightProjectRef.current === targetProjectId) {
          inFlightProjectRef.current = null;
        }
        return;
      }

      notificationIdRef.current = notificationId;
    })();

    return () => {
      cancelled = true;
      if (notificationIdRef.current) {
        removeNotification(notificationIdRef.current);
        notificationIdRef.current = null;
      }
      // On project change (the only dep-driven reason this effect tears down
      // and re-runs with a different currentProject.id), clear the in-flight
      // guard so the new project can be detected. If the dep change was for the
      // same project (dismissal flip), we also clear — the next run's dismissed
      // early-return will handle it correctly.
      inFlightProjectRef.current = null;
    };
  }, [
    currentProject?.id,
    currentProject?.inRepoSettings,
    settingsProjectId,
    settingsHydrated,
    dismissed,
    removeNotification,
  ]);
}
