import { create } from "zustand";
import type { PluginTaskSnapshot } from "@shared/types/plugin";

/**
 * Renderer mirror of the tasks plugins run through `host.tasks` (#13819).
 * Source of truth is the task registry in main; each `plugin:tasks-changed`
 * carries one plugin's COMPLETE list, and an empty list clears it. A restored
 * view gets the current lists replayed. Not persisted.
 *
 * `tasks` is every plugin's list in one, oldest first, rebuilt only when a list
 * changes, so a component selecting it re-renders only then.
 */
interface PluginTaskState {
  tasksByPluginId: Record<string, PluginTaskSnapshot[]>;
  tasks: PluginTaskSnapshot[];
  /** Idempotent: subscribes to live task updates. */
  init: () => void;
}

let initialized = false;
let unsubscribeChanged: (() => void) | null = null;

function flatten(tasksByPluginId: Record<string, PluginTaskSnapshot[]>): PluginTaskSnapshot[] {
  return Object.values(tasksByPluginId)
    .flat()
    .sort((a, b) => a.startedAt - b.startedAt);
}

export const usePluginTaskStore = create<PluginTaskState>((set, get) => ({
  tasksByPluginId: {},
  tasks: [],
  init: () => {
    if (initialized) return;
    // Tolerate a partially-stubbed bridge, and stay retryable until it is
    // present, like the panel activity store.
    const plugin = window.electron?.plugin;
    if (typeof plugin?.onTasksChanged !== "function") return;
    initialized = true;

    unsubscribeChanged = plugin.onTasksChanged(({ pluginId, tasks }) => {
      const current = get().tasksByPluginId;
      if (tasks.length === 0 && !(pluginId in current)) return;
      const tasksByPluginId = { ...current };
      if (tasks.length === 0) delete tasksByPluginId[pluginId];
      else tasksByPluginId[pluginId] = tasks;
      set({ tasksByPluginId, tasks: flatten(tasksByPluginId) });
    });
  },
}));

/** Whether a task is still running, which is what the footer's working mark counts. */
export function isLivePluginTask(task: PluginTaskSnapshot): boolean {
  return task.state !== "interrupted";
}

/** Test-only: reset the module-level init guard and state between cases. */
export function _resetPluginTaskStoreForTest(): void {
  unsubscribeChanged?.();
  unsubscribeChanged = null;
  initialized = false;
  usePluginTaskStore.setState({ tasksByPluginId: {}, tasks: [] });
}
