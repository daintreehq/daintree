import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { idleBackgroundAutoCloseClient } from "@/clients/idleBackgroundAutoCloseClient";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";

const NAMED_PROJECTS_LIMIT = 3;

/** `"A"`, `"A" and "B"`, `"A", "B" and "C"`, then `"A", "B", "C" and 2 other projects`. */
export function formatProjectNames(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length <= 1) return quoted.join("");
  if (quoted.length <= NAMED_PROJECTS_LIMIT) {
    return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  }
  const rest = quoted.length - NAMED_PROJECTS_LIMIT;
  return `${quoted.slice(0, NAMED_PROJECTS_LIMIT).join(", ")} and ${pluralize(rest, "other project")}`;
}

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

      // Putting an idle background project to sleep is an ambient, ignorable
      // event — the user can keep working and reopen the project at any time.
      // Per the Runtime Signals rules it routes to the durable inbox only
      // (`priority: "low"` → no toast). One payload is one sweep, so it is one
      // row naming everything that sweep slept.
      const message = `${formatProjectNames(projects.map((p) => p.projectName))} ${
        projects.length === 1 ? "was" : "were"
      } put to sleep to free memory. Reopen ${projects.length === 1 ? "it" : "them"} any time.`;

      notify({
        type: "info",
        title: projects.length === 1 ? "Project slept" : "Projects slept",
        message,
        inboxMessage: message,
        priority: "low",
        // Ambient host/resource-management event (memory reclaim), like the
        // disk-space warnings — routes via EVENT_POLICY's "host" kind.
        context: {
          eventKind: "host",
          projectId: projects.length === 1 ? projects[0]?.projectId : undefined,
        },
      });
    });

    // Latch only after a successful subscribe.
    ipcListenerAttached = true;
  }, []);
}
