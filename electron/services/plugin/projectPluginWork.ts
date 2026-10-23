import type { PluginWorkStopped } from "../../../shared/types/ipc/project.js";

/**
 * What one project-scoped plugin instance is doing right now, as the sleep
 * paths read it (#14093). App-global plugins never appear: they have no owning
 * project, and closing a project never unloads them.
 */
export interface ProjectPluginWork {
  /** The instance key, `project__{projectId}__{publisher}.{name}`. */
  pluginId: string;
  /** Tasks still `working` or `cancelling`; a cancel is only a request until the plugin finishes. */
  liveTasks: ReadonlyArray<{ id: string; pluginName: string; title: string }>;
  /** Worker invokes and host calls still in flight. */
  pendingCalls: number;
  /** Managed processes with a live OS child. Reported, never held for. */
  runningProcesses: number;
}

/**
 * Why plugin work must keep a project awake, or `null` when nothing does.
 *
 * The contract: a task is how a plugin protects work that outlives a single
 * call, and an in-flight call protects itself until it returns. A managed
 * process alone never holds a project. Nothing observable separates a language
 * server waiting for input from a build half done, and a helper that streams a
 * heartbeat would read as busy forever, so process work a plugin cares about
 * goes inside a task it finishes when the process is done. Sleep still reports
 * the processes it stops.
 */
export function pluginWorkHold(work: readonly ProjectPluginWork[]): string | null {
  const tasked = work.find((entry) => entry.liveTasks.length > 0);
  if (tasked) return `plugin-task:${tasked.pluginId}`;
  const calling = work.find((entry) => entry.pendingCalls > 0);
  if (calling) return `plugin-operation:${calling.pluginId}`;
  return null;
}

/** The interrupted-work summary for a user sleep, or `null` when it stopped nothing. */
export function summarizePluginWorkStopped(
  work: readonly ProjectPluginWork[]
): PluginWorkStopped | null {
  const tasks = work.flatMap((entry) =>
    entry.liveTasks.map(({ pluginName, title }) => ({ pluginName, title }))
  );
  const processes = work.reduce((sum, entry) => sum + entry.runningProcesses, 0);
  const calls = work.reduce((sum, entry) => sum + entry.pendingCalls, 0);
  if (tasks.length === 0 && processes === 0 && calls === 0) return null;
  return { tasks, processes, calls };
}

/**
 * The live reader a user Sleep hands `sleepProject`. Resolved before the sleep
 * starts, since it is read synchronously at the commit, and loaded lazily so
 * PluginService stays off its callers' static graph.
 */
export async function loadProjectPluginWorkReader(): Promise<
  (projectId: string) => ProjectPluginWork[]
> {
  const { pluginService } = await import("../PluginService.js");
  return (projectId) => pluginService.getProjectPluginWork(projectId);
}
