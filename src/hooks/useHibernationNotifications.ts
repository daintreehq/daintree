import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { hibernationClient } from "@/clients/hibernationClient";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";

// One-way latch: app-lifetime, notify-only singleton listener with no teardown.
// Never reset this — resetting on unmount allowed a remount to re-subscribe and
// fire duplicate toasts (#10455).
let ipcListenerAttached = false;

export function useHibernationNotifications(): void {
  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    hibernationClient.onProjectHibernated((payload) => {
      const { projectId, projectName, terminalsKilled, reason } = payload;
      const reasonLabel = reason === "memory-pressure" ? " (memory pressure)" : "";

      notify({
        type: "info",
        title: "Project hibernated",
        message: `"${projectName}" — ${pluralize(terminalsKilled, "terminal")} suspended${reasonLabel}`,
        inboxMessage: `"${projectName}" — ${pluralize(terminalsKilled, "terminal")} suspended${reasonLabel}`,
        priority: "low",
        context: { projectId },
        coalesce: {
          key: "hibernation:project",
          windowMs: 10000,
          buildMessage: (count) => `${pluralize(count, "project")} hibernated to save resources`,
          buildTitle: () => "Projects hibernated",
          buildInboxMessage: (count) =>
            `${pluralize(count, "project")} hibernated to save resources`,
        },
      });
    });

    // Latch only after a successful subscribe (see useIdleTerminalNotifications).
    ipcListenerAttached = true;
  }, []);
}
