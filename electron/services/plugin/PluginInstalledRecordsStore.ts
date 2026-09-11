import { store } from "../../store.js";
import type { InstalledPluginRecord, PluginInstallSource } from "../../../shared/types/plugin.js";
import { parseProjectPluginInstanceKey } from "../../../shared/types/plugin.js";
import { DEFAULT_DISABLED_PLUGIN_IDS } from "../../../shared/config/pluginDefaults.js";

/**
 * Owns the electron-store-backed `plugins.installed` provenance record CRUD and
 * the `plugins.disabled` read/write. Pure persistence with no PluginService
 * runtime-state dependencies — reads/writes only the injected `store` singleton.
 */
export class PluginInstalledRecordsStore {
  /**
   * Read disabled plugin ids (built-in and user) from the user store.
   * Defensive against missing keys (in-memory fallback during tests) and read
   * failures. Opt-in built-ins stay disabled until an explicit enable choice
   * is saved; absence from the legacy disabled list isn't that choice.
   */
  getDisabledIds(): Set<string> {
    try {
      const value = store.get("plugins") as { disabled?: unknown; enabled?: unknown } | undefined;
      const list = Array.isArray(value?.disabled) ? value.disabled : [];
      const enabled = Array.isArray(value?.enabled) ? value.enabled : [];
      return new Set([
        ...DEFAULT_DISABLED_PLUGIN_IDS.filter((id) => !enabled.includes(id)),
        ...list.filter((id): id is string => typeof id === "string"),
      ]);
    } catch (err) {
      console.warn("[PluginService] Failed to read disabled plugins from store:", err);
      return new Set(DEFAULT_DISABLED_PLUGIN_IDS);
    }
  }

  getInstalledRecords(): Record<string, InstalledPluginRecord> {
    try {
      const plugins = store.get("plugins") as { installed?: unknown } | undefined;
      const raw = plugins?.installed;
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        return raw as Record<string, InstalledPluginRecord>;
      }
      return {};
    } catch {
      return {};
    }
  }

  getInstalledRecord(name: string): InstalledPluginRecord | undefined {
    return this.getInstalledRecords()[name];
  }

  writeInstalledRecords(records: Record<string, InstalledPluginRecord>): void {
    try {
      const current = store.get("plugins");
      store.set("plugins", { ...current, installed: records });
    } catch (err) {
      console.warn("[PluginService] Failed to write installed plugin records:", err);
    }
  }

  upsertInstalledRecord(
    name: string,
    patch: Partial<InstalledPluginRecord>
  ): InstalledPluginRecord {
    const records = this.getInstalledRecords();
    // A project plugin is not installed: it has no provenance, no archive hash,
    // no update channel and no disable toggle, and its identity is local to one
    // machine's project id. Writing one here would persist that machine-local
    // id into `plugins.installed` forever and surface it in the plugin manager
    // as an installed row. The load and activation paths call this
    // unconditionally, so the guard belongs here rather than at each of the
    // seven call sites.
    if (parseProjectPluginInstanceKey(name) !== null) {
      return (
        records[name] ?? {
          source: "sideload" as PluginInstallSource,
          installedAt: Date.now(),
          archiveHash: null,
          originalUrl: null,
          disabled: false,
          updateAvailable: null,
          devMode: false,
          loadError: null,
          ...patch,
        }
      );
    }
    const existing = records[name];
    const updated: InstalledPluginRecord = existing
      ? { ...existing, ...patch }
      : {
          source: "sideload" as PluginInstallSource,
          installedAt: Date.now(),
          archiveHash: null,
          originalUrl: null,
          disabled: false,
          updateAvailable: null,
          devMode: false,
          loadError: null,
          ...patch,
        };
    records[name] = updated;
    this.writeInstalledRecords(records);
    return updated;
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    if (typeof pluginId !== "string" || pluginId.trim().length === 0) {
      throw new Error("setEnabled: pluginId must be a non-empty string");
    }
    if (typeof enabled !== "boolean") {
      throw new Error("setEnabled: enabled must be a boolean");
    }
    const plugins =
      (store.get("plugins") as { disabled?: unknown; enabled?: unknown } | undefined) ?? {};
    const current = Array.isArray(plugins.disabled)
      ? plugins.disabled.filter((id): id is string => typeof id === "string")
      : [];
    const next = enabled
      ? current.filter((id) => id !== pluginId)
      : Array.from(new Set([...current, pluginId]));
    const explicit = Array.isArray(plugins.enabled)
      ? plugins.enabled.filter((id): id is string => typeof id === "string")
      : [];
    store.set("plugins", {
      ...plugins,
      disabled: next,
      ...(DEFAULT_DISABLED_PLUGIN_IDS.includes(pluginId)
        ? {
            enabled: enabled
              ? Array.from(new Set([...explicit, pluginId]))
              : explicit.filter((id) => id !== pluginId),
          }
        : {}),
    } as never);
  }
}
