import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { idleBackgroundAutoCloseClient } from "@/clients/idleBackgroundAutoCloseClient";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { formatMemory } from "@/components/Project/ProjectResourceBadge.utils";
import type { IdleBackgroundClosedProjectEntry } from "@shared/types";

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

/** `"A"` or `"A" (about 96 MB)`: the figure is the census's estimate, never a measurement. */
function describeSleptProject(project: IdleBackgroundClosedProjectEntry): string {
  const kb = project.estimatedMemoryKb;
  if (kb === undefined || !Number.isFinite(kb) || kb <= 0) return `"${project.projectName}"`;
  return `"${project.projectName}" (about ${formatMemory(Math.max(1, kb / 1024))})`;
}

/** Every project a pressure sweep slept, each with its estimate, joined as a sentence. */
export function formatPressureSleptProjects(
  projects: readonly IdleBackgroundClosedProjectEntry[]
): string {
  const parts = projects.map(describeSleptProject);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// One-way latch: app-lifetime, notify-only singleton listener with no teardown.
// Never reset this — a remount re-subscribing would fire duplicate toasts
// (mirrors useIdleTerminalNotifications, #10455).
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
      // row naming everything that sweep slept. A pressure sweep's row names
      // every project with the census's estimate of what it held (#13852).
      const one = projects.length === 1;
      const message =
        payload.trigger === "memory-pressure"
          ? `Memory ran low, so ${formatPressureSleptProjects(projects)} ${
              one ? "was" : "were"
            } put to sleep. Reopen ${one ? "it" : "them"} any time.`
          : `${formatProjectNames(projects.map((p) => p.projectName))} ${
              one ? "was" : "were"
            } put to sleep to free memory. Reopen ${one ? "it" : "them"} any time.`;

      notify({
        type: "info",
        title: one ? "Project slept" : "Projects slept",
        message,
        inboxMessage: message,
        priority: "low",
        // Ambient host/resource-management event (memory reclaim), like the
        // disk-space warnings — routes via EVENT_POLICY's "host" kind.
        context: {
          eventKind: "host",
          projectId: one ? projects[0]?.projectId : undefined,
        },
      });
    });

    // Latch only after a successful subscribe.
    ipcListenerAttached = true;
  }, []);
}
