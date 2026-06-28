import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { idleBackgroundAutoCloseClient } from "@/clients/idleBackgroundAutoCloseClient";
import { notify } from "@/lib/notify";

// One-way latch: app-lifetime, notify-only singleton listener with no teardown.
// Never reset this — a remount re-subscribing would fire duplicate toasts
// (mirrors useHibernationNotifications / useIdleTerminalNotifications, #10455).
let ipcListenerAttached = false;

export function useIdleBackgroundCloseNotifications(): void {
  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    idleBackgroundAutoCloseClient.onClosed((payload) => {
      const projects = payload.projects ?? [];
      if (projects.length === 0) return;

      // Auto-closing an idle background project to reclaim memory is an
      // ambient, ignorable event — the user can keep working and reopen the
      // project at any time. Per the Runtime Signals rules it routes to the
      // durable inbox only (`priority: "low"` → no toast), and coalesces so a
      // multi-project sweep collapses into one row.
      for (const project of projects) {
        const message = `"${project.projectName}" was closed to free memory. Reopen it any time.`;

        notify({
          type: "info",
          title: "Project suspended",
          message,
          inboxMessage: message,
          priority: "low",
          context: { projectId: project.projectId },
          coalesce: {
            key: "idle-background:closed",
            windowMs: 10000,
            buildMessage: (count) =>
              `${count} idle project${count === 1 ? "" : "s"} closed to free memory`,
            buildTitle: () => "Projects suspended",
            buildInboxMessage: (count) =>
              `${count} idle project${count === 1 ? "" : "s"} closed to free memory`,
          },
        });
      }
    });

    // Latch only after a successful subscribe.
    ipcListenerAttached = true;
  }, []);
}
