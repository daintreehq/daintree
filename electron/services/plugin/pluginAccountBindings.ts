import { store } from "../../store.js";
import type { PluginAccountBinding } from "../../../shared/types/plugin.js";
import { isPluginConnectionId } from "../../../shared/utils/pluginConnections.js";

/**
 * Each project's choice of connection per plugin instance (#14102): project id
 * → plugin instance id → `{ connectionId, source }`. Only a reference — the
 * tokens stay in the owning instance's account file — and kept in Daintree's
 * own settings, never the repository, so a project plugin can't ship a binding
 * to someone's machine connection.
 *
 * Read and written whole, like the setup skips: plugin and project ids are
 * never used as dotted store paths.
 */
const STORE_KEY = "projectPluginAccountBindings";

/** Longest plugin instance id a key may be; matches the setup skips bound. */
const MAX_PLUGIN_ID_LENGTH = 300;
const MAX_PROJECT_ID_LENGTH = 300;

export interface PluginAccountBindingStore {
  get(projectId: string, pluginId: string): PluginAccountBinding | null;
  /** `null` forgets the choice. Returns whether anything changed. */
  set(projectId: string, pluginId: string, binding: PluginAccountBinding | null): boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The file is user-editable, so anything malformed reads as no binding. */
export function parsePluginAccountBinding(value: unknown): PluginAccountBinding | null {
  const record = asRecord(value);
  const { connectionId, source } = record;
  if (!isPluginConnectionId(connectionId)) return null;
  if (source !== "own" && source !== "machine") return null;
  return { connectionId, source };
}

function assertKey(value: string, max: number, what: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`plugin account binding: malformed ${what}`);
  }
}

function readAll(): Record<string, unknown> {
  return asRecord(store.get(STORE_KEY) as unknown);
}

export const pluginAccountBindings: PluginAccountBindingStore = {
  get(projectId, pluginId) {
    return parsePluginAccountBinding(asRecord(readAll()[projectId])[pluginId]);
  },

  set(projectId, pluginId, binding) {
    assertKey(projectId, MAX_PROJECT_ID_LENGTH, "project id");
    assertKey(pluginId, MAX_PLUGIN_ID_LENGTH, "plugin id");
    const next = binding === null ? null : parsePluginAccountBinding(binding);
    if (binding !== null && next === null) {
      throw new Error("plugin account binding: malformed binding");
    }
    const all = readAll();
    const byPlugin = asRecord(all[projectId]);
    const current = parsePluginAccountBinding(byPlugin[pluginId]);
    const unchanged =
      next === null
        ? !Object.hasOwn(byPlugin, pluginId)
        : current?.connectionId === next.connectionId && current.source === next.source;
    if (unchanged) return false;
    const updatedProject = { ...byPlugin };
    if (next === null) delete updatedProject[pluginId];
    else updatedProject[pluginId] = next;
    const updated = { ...all };
    if (Object.keys(updatedProject).length === 0) delete updated[projectId];
    else updated[projectId] = updatedProject;
    store.set(STORE_KEY, updated);
    return true;
  },
};
