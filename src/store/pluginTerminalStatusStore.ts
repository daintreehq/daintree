import { create } from "zustand";
import { pluginManifestIdFromInstanceKey, type PluginTerminalStatus } from "@shared/types/plugin";

/**
 * Renderer mirror of the terminal header statuses plugins set via
 * `host.setTerminalStatus` (#13802), keyed `projectId → pluginId → terminalId →
 * status`. Each `plugin:terminal-statuses-changed` event carries one plugin's
 * COMPLETE map for one project, so it replaces that entry wholesale; an empty
 * map (also what an unload or project close sends) drops it. Main only sends a
 * project's statuses to that project's views, and headers read only their own
 * project's bucket on top of that. Not persisted.
 */
type StatusesByPlugin = Record<string, Record<string, PluginTerminalStatus>>;
type StatusesByProject = Record<string, StatusesByPlugin>;

interface PluginTerminalStatusState {
  statusesByProject: StatusesByProject;
  /** Idempotent: subscribes to live status updates. */
  init: () => void;
}

let initialized = false;
let unsubscribeChanged: (() => void) | null = null;

export const usePluginTerminalStatusStore = create<PluginTerminalStatusState>((set) => ({
  statusesByProject: {},
  init: () => {
    if (initialized) return;
    // Tolerate a partially-stubbed bridge, and stay retryable until it exists.
    const plugin = window.electron?.plugin;
    if (typeof plugin?.onTerminalStatusesChanged !== "function") return;
    initialized = true;

    unsubscribeChanged = plugin.onTerminalStatusesChanged(({ pluginId, projectId, statuses }) => {
      set((state) => {
        const byPlugin = state.statusesByProject[projectId] ?? {};
        let nextByPlugin: StatusesByPlugin;
        if (Object.keys(statuses).length === 0) {
          if (!(pluginId in byPlugin)) return state;
          const { [pluginId]: _removed, ...rest } = byPlugin;
          nextByPlugin = rest;
        } else {
          nextByPlugin = { ...byPlugin, [pluginId]: statuses };
        }
        if (Object.keys(nextByPlugin).length === 0) {
          const { [projectId]: _dropped, ...statusesByProject } = state.statusesByProject;
          return { statusesByProject };
        }
        return {
          statusesByProject: { ...state.statusesByProject, [projectId]: nextByPlugin },
        };
      });
    });
  },
}));

export interface TerminalPluginStatus {
  pluginId: string;
  status: PluginTerminalStatus;
}

/**
 * Every plugin's status on one terminal, ordered by manifest id and then
 * instance id, so the chips keep their places while display names load or
 * change.
 */
export function terminalStatusesFor(
  byPlugin: StatusesByPlugin | undefined,
  terminalId: string
): TerminalPluginStatus[] {
  if (!byPlugin) return [];
  const entries: TerminalPluginStatus[] = [];
  for (const [pluginId, statuses] of Object.entries(byPlugin)) {
    const status = statuses[terminalId];
    if (status) entries.push({ pluginId, status });
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
export function _resetPluginTerminalStatusStoreForTest(): void {
  unsubscribeChanged?.();
  unsubscribeChanged = null;
  initialized = false;
  usePluginTerminalStatusStore.setState({ statusesByProject: {} });
}
