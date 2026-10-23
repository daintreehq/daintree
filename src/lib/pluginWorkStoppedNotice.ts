import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import type { PluginWorkStopped } from "@shared/types/ipc/project";

/**
 * The record a user Sleep leaves when it interrupted plugin work (#14093): an
 * unfinished task or a call still in flight. The project's view went with the
 * sleep, so nothing else on screen says that work ended. Managed processes
 * alone are expected to stop with their project and leave no record.
 */
export function describePluginWorkStopped(
  projectName: string,
  stopped: PluginWorkStopped | null | undefined
): string | null {
  const tasks = stopped?.tasks ?? [];
  const calls = stopped?.calls ?? 0;
  if (tasks.length === 0 && calls === 0) return null;
  const first = tasks[0];
  const what =
    tasks.length === 1 && first
      ? `${first.pluginName}'s "${first.title}"`
      : tasks.length > 1
        ? pluralize(tasks.length, "plugin task")
        : pluralize(calls, "plugin call");
  const processes = stopped?.processes ?? 0;
  const extras = [
    tasks.length > 0 && calls > 0 ? pluralize(calls, "plugin call") : null,
    processes > 0 ? pluralize(processes, "plugin process", "plugin processes") : null,
  ].filter((extra): extra is string => extra !== null);
  const alongside = extras.length > 0 ? `, along with ${extras.join(" and ")}` : "";
  return `${what} stopped when ${projectName} went to sleep${alongside}. Run it again once the project is open.`;
}

export function notifyPluginWorkStopped(
  projectName: string,
  stopped: PluginWorkStopped | null | undefined
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
