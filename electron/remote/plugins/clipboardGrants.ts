import type { HostId } from "../../../shared/types/remoteHosts.js";
import type { HostPluginClipboardGrant } from "../../../shared/types/ipc/remoteHosts.js";
import { store } from "../../store.js";

/** What a host's plugin wants from this machine's clipboard. */
export type ClipboardAccess = "read" | "write";

export type ClipboardGrantDecision = "allow" | "deny";

export type ClipboardGrantRecord = Partial<Record<ClipboardAccess, ClipboardGrantDecision>>;

/** Grants keyed by host, then by the plugin's instance id on that host. */
export type ClipboardGrantsState = Record<string, Record<string, ClipboardGrantRecord>>;

/**
 * The person's answers about host plugins reaching this machine's clipboard.
 * Owned by this machine: a host can neither read nor set them.
 */
export interface ClipboardGrantStore {
  get(hostId: HostId, pluginId: string, access: ClipboardAccess): ClipboardGrantDecision | null;
  set(
    hostId: HostId,
    pluginId: string,
    access: ClipboardAccess,
    decision: ClipboardGrantDecision
  ): void;
}

/** The persisted store, which the settings page can also list and clear. */
export interface PersistedClipboardGrantStore extends ClipboardGrantStore {
  list(hostId: HostId): HostPluginClipboardGrant[];
  /** Forget one plugin's answers on `hostId`, or every plugin's; each is asked again. */
  reset(hostId: HostId, pluginId?: string): void;
}

function isDecision(value: unknown): value is ClipboardGrantDecision {
  return value === "allow" || value === "deny";
}

function readState(): ClipboardGrantsState {
  const raw: unknown = store.get("remoteHostPluginClipboardGrants");
  return raw && typeof raw === "object" ? (raw as ClipboardGrantsState) : {};
}

/** The persisted store: `remoteHostPluginClipboardGrants` in this machine's settings. */
export const persistedClipboardGrants: PersistedClipboardGrantStore = {
  get(hostId, pluginId, access) {
    const hosts = readState();
    const plugins = Object.hasOwn(hosts, hostId) ? hosts[hostId] : undefined;
    const record = plugins && Object.hasOwn(plugins, pluginId) ? plugins[pluginId] : undefined;
    const decision = record && Object.hasOwn(record, access) ? record[access] : undefined;
    return isDecision(decision) ? decision : null;
  },
  set(hostId, pluginId, access, decision) {
    const hosts = readState();
    const plugins = Object.hasOwn(hosts, hostId) ? { ...hosts[hostId] } : {};
    const record = Object.hasOwn(plugins, pluginId) ? { ...plugins[pluginId] } : {};
    record[access] = decision;
    plugins[pluginId] = record;
    store.set("remoteHostPluginClipboardGrants", { ...hosts, [hostId]: plugins });
  },
  list(hostId) {
    const hosts = readState();
    const plugins = Object.hasOwn(hosts, hostId) ? hosts[hostId] : undefined;
    if (!plugins || typeof plugins !== "object") return [];
    const out: HostPluginClipboardGrant[] = [];
    for (const [pluginId, record] of Object.entries(plugins)) {
      if (!record || typeof record !== "object") continue;
      const read = Object.hasOwn(record, "read") ? record.read : undefined;
      const write = Object.hasOwn(record, "write") ? record.write : undefined;
      if (!isDecision(read) && !isDecision(write)) continue;
      out.push({
        pluginId,
        ...(isDecision(read) ? { read } : {}),
        ...(isDecision(write) ? { write } : {}),
      });
    }
    return out.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  },
  reset(hostId, pluginId) {
    const hosts = readState();
    if (!Object.hasOwn(hosts, hostId)) return;
    const next = { ...hosts };
    if (pluginId === undefined) {
      delete next[hostId];
    } else {
      const plugins = { ...next[hostId] };
      if (!Object.hasOwn(plugins, pluginId)) return;
      delete plugins[pluginId];
      next[hostId] = plugins;
    }
    store.set("remoteHostPluginClipboardGrants", next);
  },
};
