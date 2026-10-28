import type {
  PluginWorktreeDeleteNote,
  PluginWorktreeSnapshot,
} from "../../../shared/types/plugin.js";

/**
 * A bound `provideNotes`, as the host calls it. `signal` is the host's
 * deadline: a worker plugin's proxy hands it to the bridge so a missed
 * deadline releases the pending invoke; an in-process plugin never sees it.
 */
export interface WorktreeDeleteNotesBinding {
  contributionId: string;
  provideNotes(
    worktree: PluginWorktreeSnapshot,
    signal: AbortSignal
  ): Promise<readonly PluginWorktreeDeleteNote[]> | readonly PluginWorktreeDeleteNote[];
}

/**
 * Runtime bindings for `contributes.worktreeDeleteNotes` (#13805), keyed by
 * plugin instance id. The manifest declares the check, so the host knows which
 * plugins to ask before any of their code runs; the binding arrives during
 * `activate()` and goes with the worker, so a missing one means "not active
 * yet", never "no check".
 */
const BINDINGS = new Map<string, WorktreeDeleteNotesBinding>();

export function registerWorktreeDeleteNotesBinding(
  pluginId: string,
  binding: WorktreeDeleteNotesBinding
): void {
  BINDINGS.set(pluginId, binding);
}

/**
 * Unbind a plugin's check. With `expected`, only when that exact binding is
 * still the current one, so a replaced binding's disposer can't remove its
 * successor.
 */
export function unregisterWorktreeDeleteNotesBinding(
  pluginId: string,
  expected?: WorktreeDeleteNotesBinding
): void {
  if (expected !== undefined && BINDINGS.get(pluginId) !== expected) return;
  BINDINGS.delete(pluginId);
}

export function getWorktreeDeleteNotesBinding(
  pluginId: string
): WorktreeDeleteNotesBinding | undefined {
  return BINDINGS.get(pluginId);
}

/** Test isolation. */
export function clearWorktreeDeleteNotesBindings(): void {
  BINDINGS.clear();
}
