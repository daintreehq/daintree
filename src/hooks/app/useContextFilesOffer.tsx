import { useEffect, useRef } from "react";
import { useProjectStore } from "@/store";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectSettings } from "../useProjectSettings";
import { notify } from "@/lib/notify";
import { useNotificationStore } from "@/store/notificationStore";
import { projectClient } from "@/clients";

function formatFileList(files: string[]): string {
  if (files.length === 1) return files[0];
  if (files.length === 2) return `${files[0]} and ${files[1]}`;
  return `${files.slice(0, -1).join(", ")}, and ${files[files.length - 1]}`;
}

export function useContextFilesOffer() {
  const currentProject = useProjectStore((state) => state.currentProject);
  const { settings, projectId: settingsProjectId } = useProjectSettingsStore();
  const { saveSettings } = useProjectSettings();
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  const lastCheckedProjectRef = useRef<string | null>(null);
  const notificationIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentProject?.id || settingsProjectId !== currentProject.id || !settings) {
      return;
    }

    if (currentProject.inRepoSettings) {
      return;
    }

    if (settings.contextFilesOfferDismissed) {
      return;
    }

    if (lastCheckedProjectRef.current === currentProject.id) {
      return;
    }

    lastCheckedProjectRef.current = currentProject.id;

    const targetProjectId = currentProject.id;
    let cancelled = false;

    (async () => {
      let foundFiles: string[];
      try {
        foundFiles = await projectClient.detectContextFiles(targetProjectId);
      } catch (error) {
        console.error("Failed to detect project context files:", error);
        if (lastCheckedProjectRef.current === targetProjectId) {
          lastCheckedProjectRef.current = null;
        }
        return;
      }

      if (cancelled) return;
      if (foundFiles.length === 0) return;

      const latestState = useProjectSettingsStore.getState();
      if (
        latestState.projectId !== targetProjectId ||
        latestState.settings?.contextFilesOfferDismissed
      ) {
        return;
      }

      const projectStillCurrent = useProjectStore.getState().currentProject;
      if (projectStillCurrent?.id !== targetProjectId || projectStillCurrent.inRepoSettings) {
        return;
      }

      const fileList = formatFileList(foundFiles);
      const pluralSuffix = foundFiles.length === 1 ? "this file" : "these files";

      const markDismissed = async (): Promise<boolean> => {
        const freshSettings = useProjectSettingsStore.getState().settings;
        if (!freshSettings) return false;
        await saveSettings({ ...freshSettings, contextFilesOfferDismissed: true });
        return true;
      };

      const notificationId = notify({
        type: "info",
        placement: "grid-bar",
        title: "Agent context files detected",
        message: `Found ${fileList} in this project. Use ${pluralSuffix} with your agents?`,
        inboxMessage: `Agent context files detected: ${foundFiles.join(", ")}`,
        actions: [
          {
            label: "Yes, use them",
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
                console.error("Failed to enable in-repo settings from context offer:", err);
                notify({
                  type: "error",
                  title: "Failed to enable project context",
                  message: err instanceof Error ? err.message : "Unknown error",
                  duration: 6000,
                });
                lastCheckedProjectRef.current = null;
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
                console.error("Failed to dismiss context files offer:", err);
                notify({
                  type: "error",
                  title: "Failed to save preference",
                  message: err instanceof Error ? err.message : "Unknown error",
                  duration: 6000,
                });
                lastCheckedProjectRef.current = null;
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

      notificationIdRef.current = notificationId || null;
    })();

    return () => {
      cancelled = true;
      if (notificationIdRef.current) {
        removeNotification(notificationIdRef.current);
        notificationIdRef.current = null;
      }
    };
  }, [
    currentProject?.id,
    currentProject?.inRepoSettings,
    settingsProjectId,
    settings,
    saveSettings,
    removeNotification,
  ]);
}
