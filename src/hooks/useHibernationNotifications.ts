import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { hibernationClient } from "@/clients/hibernationClient";
import { notify } from "@/lib/notify";

// One-way latch: app-lifetime, notify-only singleton listener with no teardown.
// Never reset this — resetting on unmount allowed a remount to re-subscribe and
// fire duplicate toasts (#10455).
let ipcListenerAttached = false;

export function useHibernationNotifications(): void {
  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    ipcListenerAttached = true;

    hibernationClient.onProjectHibernated((payload) => {
      const { projectId, projectName, terminalsKilled, reason } = payload;
      const reasonLabel = reason === "memory-pressure" ? " (memory pressure)" : "";

      notify({
        type: "info",
        title: "Project hibernated",
        message: `"${projectName}" — ${terminalsKilled} terminal${terminalsKilled === 1 ? "" : "s"} suspended${reasonLabel}`,
        inboxMessage: `"${projectName}" — ${terminalsKilled} terminal${terminalsKilled === 1 ? "" : "s"} suspended${reasonLabel}`,
        priority: "low",
        context: { projectId },
        coalesce: {
          key: "hibernation:project",
          windowMs: 10000,
          buildMessage: (count) =>
            `${count} project${count === 1 ? "" : "s"} hibernated to save resources`,
          buildTitle: () => "Projects hibernated",
          buildInboxMessage: (count) =>
            `${count} project${count === 1 ? "" : "s"} hibernated to save resources`,
        },
      });
    });
  }, []);
}
