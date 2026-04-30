import { useEffect, useRef } from "react";
import { isElectronAvailable } from "./useElectron";
import { idleTerminalClient } from "@/clients/idleTerminalClient";
import { notify } from "@/lib/notify";
import { useUIStore } from "@/store/uiStore";

let ipcListenerAttached = false;

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function useIdleTerminalNotifications(): void {
  const didAttachListener = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    ipcListenerAttached = true;
    didAttachListener.current = true;

    const unsubscribe = idleTerminalClient.onNotify((payload) => {
      const projects = payload.projects ?? [];
      if (projects.length === 0) return;

      const single = projects.length === 1 ? projects[0] : null;

      // Single-project: action targets that project. Multi-project: open the
      // notification center (the coalesce buildAction can't safely close
      // multiple projects from a closure that only sees a count).
      const closeAction = single
        ? {
            label: "Close Them",
            onClick: () => {
              void idleTerminalClient.closeProject(single.projectId);
            },
          }
        : {
            label: "View",
            onClick: () => {
              useUIStore.getState().openNotificationCenter();
            },
          };

      const dismissAction = {
        label: "Mute project",
        onClick: () => {
          if (single) {
            void idleTerminalClient.dismissProject(single.projectId);
          } else {
            for (const p of projects) {
              void idleTerminalClient.dismissProject(p.projectId);
            }
          }
        },
      };

      const title = single ? `Idle terminals in "${single.projectName}"` : "Idle terminals";
      const message = single
        ? `${pluralize(single.terminalCount, "terminal")} inactive for ${single.idleMinutes}m`
        : `${pluralize(projects.length, "project")} have idle terminals`;

      notify({
        type: "info",
        title,
        message,
        inboxMessage: message,
        priority: "high",
        duration: 0,
        actions: [closeAction, dismissAction],
        coalesce: {
          key: "idle-terminal-notify:projects",
          windowMs: 30_000,
          buildTitle: () => "Idle terminals",
          buildMessage: (count) => `${pluralize(count, "project")} have idle terminals`,
          buildInboxMessage: (count) => `${pluralize(count, "project")} have idle terminals`,
          buildAction: (count) =>
            count > 1
              ? {
                  label: "View",
                  onClick: () => {
                    useUIStore.getState().openNotificationCenter();
                  },
                }
              : undefined,
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
