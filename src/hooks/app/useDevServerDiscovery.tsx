import { useEffect, useRef } from "react";
import { useProjectStore } from "@/store";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectSettings } from "../useProjectSettings";
import { useNotificationStore } from "@/store/notificationStore";
import { Button } from "@/components/ui/button";

const DEV_SCRIPT_PRIORITY = ["dev", "start", "serve"];
const snoozedProjects = new Set<string>();

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

    if (snoozedProjects.has(currentProject.id)) {
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
      title: "Dev Server Detected",
      message: (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Found{" "}
            <code className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">
              {devServerCandidate.command}
            </code>{" "}
            in package.json. Enable dev preview server?
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={async () => {
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
              }}
            >
              Enable
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
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
                  console.error("Failed to dismiss dev server:", err);
                  addNotification({
                    type: "error",
                    title: "Failed to save preference",
                    message: err instanceof Error ? err.message : "Unknown error",
                    duration: 6000,
                  });
                  lastNotifiedProjectRef.current = null;
                }
              }}
            >
              Not a web project
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                removeNotification(notificationId);
                snoozedProjects.add(currentProject.id);
              }}
            >
              Remind me later
            </Button>
          </div>
        </div>
      ),
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
