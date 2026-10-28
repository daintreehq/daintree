import { create } from "zustand";
import {
  pluginManifestIdFromInstanceKey,
  type PluginWorktreeReviewCheck,
} from "@shared/types/plugin";

/**
 * Renderer mirror of the readiness checks plugins publish via
 * `host.setWorktreeReviewChecks` (#13806), keyed `projectId → pluginId →
 * worktreeId → checks`. Each `plugin:worktree-review-checks-changed` event
 * carries one plugin's COMPLETE map for one project, so it replaces that entry
 * wholesale; an empty map (also what an unload or project close sends) drops
 * it. Main sends a project's checks only to that project's views, and the
 * preload buffers them for a store that subscribes late. Not persisted.
 */
type ChecksByPlugin = Record<string, Record<string, PluginWorktreeReviewCheck[]>>;
type ChecksByProject = Record<string, ChecksByPlugin>;

interface PluginWorktreeReviewChecksState {
  checksByProject: ChecksByProject;
  /** Idempotent: subscribes to live check updates. */
  init: () => void;
}

let initialized = false;
let unsubscribeChanged: (() => void) | null = null;

export const usePluginWorktreeReviewChecksStore = create<PluginWorktreeReviewChecksState>(
  (set) => ({
    checksByProject: {},
    init: () => {
      if (initialized) return;
      // Tolerate a partially-stubbed bridge, and stay retryable until it exists.
      const plugin = window.electron?.plugin;
      if (typeof plugin?.onWorktreeReviewChecksChanged !== "function") return;
      initialized = true;

      unsubscribeChanged = plugin.onWorktreeReviewChecksChanged(
        ({ pluginId, projectId, checks }) => {
          set((state) => {
            const byPlugin = state.checksByProject[projectId] ?? {};
            let nextByPlugin: ChecksByPlugin;
            if (Object.keys(checks).length === 0) {
              if (!(pluginId in byPlugin)) return state;
              const { [pluginId]: _removed, ...rest } = byPlugin;
              nextByPlugin = rest;
            } else {
              nextByPlugin = { ...byPlugin, [pluginId]: checks };
            }
            if (Object.keys(nextByPlugin).length === 0) {
              const { [projectId]: _dropped, ...checksByProject } = state.checksByProject;
              return { checksByProject };
            }
            return {
              checksByProject: { ...state.checksByProject, [projectId]: nextByPlugin },
            };
          });
        }
      );
    },
  })
);

export interface WorktreeReviewPluginChecks {
  pluginId: string;
  checks: readonly PluginWorktreeReviewCheck[];
}

/**
 * Every plugin's checks on one worktree, ordered by manifest id and then
 * instance id, so the rows keep their places while display names load.
 */
export function worktreeReviewChecksFor(
  byPlugin: ChecksByPlugin | undefined,
  worktreeId: string
): WorktreeReviewPluginChecks[] {
  if (!byPlugin) return [];
  const entries: WorktreeReviewPluginChecks[] = [];
  for (const [pluginId, byWorktree] of Object.entries(byPlugin)) {
    const checks = byWorktree[worktreeId];
    if (checks && checks.length > 0) entries.push({ pluginId, checks });
  }
  if (entries.length < 2) return entries;
  return entries.sort((a, b) => {
    const byManifest = pluginManifestIdFromInstanceKey(a.pluginId).localeCompare(
      pluginManifestIdFromInstanceKey(b.pluginId)
    );
    return byManifest !== 0 ? byManifest : a.pluginId.localeCompare(b.pluginId);
  });
}

/** Test-only: reset the module-level init guard and state between cases. */
export function _resetPluginWorktreeReviewChecksStoreForTest(): void {
  unsubscribeChanged?.();
  unsubscribeChanged = null;
  initialized = false;
  usePluginWorktreeReviewChecksStore.setState({ checksByProject: {} });
}
