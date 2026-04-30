import { useEffect, useRef } from "react";
import { isElectronAvailable } from "./useElectron";
import { hibernationClient } from "@/clients/hibernationClient";
import { notify } from "@/lib/notify";

let ipcListenerAttached = false;

export function useHibernationNotifications(): void {
  const didAttachListener = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    ipcListenerAttached = true;
    didAttachListener.current = true;

    const unsubscribe = hibernationClient.onProjectHibernated((payload) => {
      const { projectId, projectName, terminalsKilled, reason } = payload;
      const reasonLabel = reason === "memory-pressure" ? " (memory pressure)" : "";

      notify({
        type: "info",
        title: "Project hibernated",
        message: `"${projectName}" — ${terminalsKilled} terminal${terminalsKilled === 1 ? "" : "s"} suspended${reasonLabel}`,
        inboxMessage: `"${projectName}" — ${terminalsKilled} terminal${terminalsKilled === 1 ? "" : "s"} suspended${reasonLabel}`,
        priority: "watch",
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

    return () => {
      if (didAttachListener.current) {
        unsubscribe();
        ipcListenerAttached = false;
      }
    };
  }, []);
}
