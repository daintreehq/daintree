import { useEffect, useRef } from "react";
import { useProjectStore } from "@/store";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectSettings } from "../useProjectSettings";
import { useNotificationStore } from "@/store/notificationStore";

const DEV_SCRIPT_PRIORITY = ["dev", "start", "serve"];

export function useDevServerDiscovery() {
  const currentProject = useProjectStore((state) => state.currentProject);
  const { settings, allDetectedRunners } = useProjectSettingsStore();
  const { saveSettings } = useProjectSettings();
  const { addNotification, removeNotification } = useNotificationStore();
  const lastNotifiedProjectRef = useRef<string | null>(null);
  const notificationIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentProject?.id || !settings || !allDetectedRunners) {
      return;
    }

    if (settings.devServerCommand) {
      return;
    }

    if (settings.devServerDismissed) {
      return;
    }

    if (lastNotifiedProjectRef.current === currentProject.id) {
      return;
    }

    const devServerCandidate = DEV_SCRIPT_PRIORITY.map((name) =>
      allDetectedRunners.find((runner) => runner.name === name)
    ).find((runner) => runner !== undefined);

    if (!devServerCandidate) {
      return;
    }

    lastNotifiedProjectRef.current = currentProject.id;

    const notificationId = addNotification({
      type: "info",
      placement: "grid-bar",
      title: "Dev Server Detected",
      message: (
        <span>
          Found{" "}
          <code className="rounded border border-white/10 bg-black/20 px-1 py-0.5 font-mono text-[11px]">
            {devServerCandidate.command}
          </code>{" "}
          in package.json. Enable dev preview server for this project?
        </span>
      ),
      actions: [
        {
          label: "Enable",
          variant: "primary",
          onClick: async () => {
            try {
              const latestSettings = useProjectSettingsStore.getState().settings;
              if (!latestSettings) return;

              await saveSettings({
                ...latestSettings,
                devServerCommand: devServerCandidate.command,
                devServerAutoDetected: true,
                devServerDismissed: false,
              });
              removeNotification(notificationId);
            } catch (err) {
              console.error("Failed to enable dev server:", err);
              addNotification({
                type: "error",
                title: "Failed to enable dev server",
                message: err instanceof Error ? err.message : "Unknown error",
                duration: 6000,
              });
              lastNotifiedProjectRef.current = null;
            }
          },
        },
        {
          label: "Ignore",
          variant: "secondary",
          onClick: async () => {
            try {
              const latestSettings = useProjectSettingsStore.getState().settings;
              if (!latestSettings) return;

              await saveSettings({
                ...latestSettings,
                devServerDismissed: true,
                devServerAutoDetected: false,
              });
              removeNotification(notificationId);
            } catch (err) {
              console.error("Failed to save dev server preference:", err);
              addNotification({
                type: "error",
                title: "Failed to save preference",
                message: err instanceof Error ? err.message : "Unknown error",
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
    settings,
    allDetectedRunners,
    saveSettings,
    addNotification,
    removeNotification,
  ]);
}
