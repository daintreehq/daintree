import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import type { PluginWorkStopped } from "@shared/types/ipc/project";

/**
 * The record a user Sleep leaves when it stopped plugin tasks (#14093). The
 * project's view went with the sleep, so nothing else on screen says the work
 * ended; managed processes alone are expected to stop and leave no record.
 */
export function describePluginWorkStopped(
  projectName: string,
  stopped: PluginWorkStopped | undefined
): string | null {
  const tasks = stopped?.tasks ?? [];
  if (tasks.length === 0) return null;
  const first = tasks[0]!;
  const what =
    tasks.length === 1
      ? `${first.pluginName}'s "${first.title}"`
      : pluralize(tasks.length, "plugin task");
  const processes = stopped?.processes ?? 0;
  const alongside =
    processes > 0
      ? `, along with ${pluralize(processes, "plugin process", "plugin processes")}`
      : "";
  return `${what} stopped when ${projectName} went to sleep${alongside}. Run it again once the project is open.`;
}

export function notifyPluginWorkStopped(
  projectName: string,
  stopped: PluginWorkStopped | undefined
): void {
  const message = describePluginWorkStopped(projectName, stopped);
  if (!message) return;
  notify({
    type: "info",
    title: "Plugin work stopped",
    message,
    // A record of what the user's own Sleep interrupted, not an interruption.
    priority: "low",
    context: { eventKind: "uiFeedback" },
  });
}
