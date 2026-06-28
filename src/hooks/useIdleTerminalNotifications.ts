import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { idleTerminalClient } from "@/clients/idleTerminalClient";
import { notify } from "@/lib/notify";

// One-way latch: the broadcast IPC listener is an app-lifetime, notify-only
// singleton with no teardown. Never reset this — resetting it on unmount let a
// PostHydrationListeners remount re-subscribe and fire duplicate toasts (#10455).
let ipcListenerAttached = false;

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function useIdleTerminalNotifications(): void {
  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    idleTerminalClient.onNotify((payload) => {
      const projects = payload.projects ?? [];
      if (projects.length === 0) return;

      // Idle background terminals are an ignorable, self-recovering state — the
      // user can keep working without ever acting on it. Per the Runtime
      // Signals rules this is a passive (Tier 0/1) signal, so it routes to the
      // durable notification inbox only (`priority: "low"` → no toast, no
      // interruption) instead of a stack of sticky toasts (#10455 follow-up).
      // One inbox row per project, keyed by `supersedeKey` so a re-fire retires
      // the prior row for that project rather than accumulating near-duplicates.
      for (const project of projects) {
        const message = `${pluralize(project.terminalCount, "terminal")} inactive for ${project.idleMinutes}m`;

        notify({
          type: "info",
          title: `Idle terminals in "${project.projectName}"`,
          message,
          inboxMessage: message,
          priority: "low",
          supersedeKey: `idle-terminal:${project.projectId}`,
          // Action-backed so the affordances survive into the persisted inbox
          // row — `notify()` only keeps actions that carry an `actionId`
          // (closure-only `onClick` actions are dropped from history). The
          // inbox dispatches via `actionId`/`actionArgs`; `onClick` is the
          // equivalent toast-path handler (unused while priority is "low").
          actions: [
            {
              label: "Close them",
              variant: "primary" as const,
              actionId: "idleTerminalNotify.closeProject",
              actionArgs: { projectId: project.projectId },
              onClick: () => {
                void idleTerminalClient.closeProject(project.projectId);
              },
            },
            {
              label: "Mute project",
              variant: "secondary" as const,
              actionId: "idleTerminalNotify.muteProject",
              actionArgs: { projectId: project.projectId },
              onClick: () => {
                void idleTerminalClient.dismissProject(project.projectId);
              },
            },
          ],
          context: { projectId: project.projectId },
        });
      }
    });

    // Latch only after a successful subscribe so a throwing onNotify (e.g. a
    // partially-initialized preload) doesn't wedge the latch and silently
    // suppress all future notifications for this renderer.
    ipcListenerAttached = true;
  }, []);
}
