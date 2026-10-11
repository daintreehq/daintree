import type { HostId } from "../../../shared/types/remoteHosts.js";
import { store } from "../../store.js";

/**
 * This machine's answers about running a host plugin's view code here. A
 * host's views run in this machine's own renderer, so the host alone deciding
 * a plugin is trusted is not enough: the person here says yes to one exact
 * bundle, recorded as the digest of the host's list of the plugin's files and
 * their sha256. A file outside that list, or not matching it, is never run; a
 * different list is asked about again. A host can neither read nor set any of
 * it.
 */
export interface PluginViewConsentStore {
  /** The bundle digest the person allowed for this plugin, or null when none. */
  allowedDigest(hostId: HostId, pluginId: string): string | null;
  allow(hostId: HostId, pluginId: string, digest: string): void;
  /** The plugins whose views are allowed on `hostId`. */
  list(hostId: HostId): string[];
  /** Forget one plugin's answer on `hostId`, or every plugin's; each is asked again. */
  reset(hostId: HostId, pluginId?: string): void;
}

interface ConsentRecord {
  digest: string;
}

type ConsentState = Record<string, Record<string, ConsentRecord>>;

const STORE_KEY = "remoteHostPluginViewConsent";
const DIGEST = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The stored digest when the record is well formed; anything else counts as not allowed. */
function digestOf(state: unknown, hostId: HostId, pluginId: string): string | null {
  if (!isPlainObject(state) || !Object.hasOwn(state, hostId)) return null;
  const plugins = state[hostId];
  if (!isPlainObject(plugins) || !Object.hasOwn(plugins, pluginId)) return null;
  const record = plugins[pluginId];
  if (!isPlainObject(record)) return null;
  return typeof record.digest === "string" && DIGEST.test(record.digest) ? record.digest : null;
}

function readState(): ConsentState {
  const raw: unknown = store.get(STORE_KEY);
  return isPlainObject(raw) ? (raw as ConsentState) : {};
}

function hostPlugins(state: ConsentState, hostId: HostId): Record<string, ConsentRecord> {
  const plugins = Object.hasOwn(state, hostId) ? state[hostId] : undefined;
  return isPlainObject(plugins) ? { ...plugins } : {};
}

/** The persisted store: `remoteHostPluginViewConsent` in this machine's settings. */
export const persistedPluginViewConsent: PluginViewConsentStore = {
  allowedDigest: (hostId, pluginId) => digestOf(readState(), hostId, pluginId),
  allow(hostId, pluginId, digest) {
    if (!DIGEST.test(digest)) return;
    const state = readState();
    const plugins = hostPlugins(state, hostId);
    plugins[pluginId] = { digest };
    store.set(STORE_KEY, { ...state, [hostId]: plugins });
  },
  list(hostId) {
    const state = readState();
    return Object.keys(hostPlugins(state, hostId))
      .filter((pluginId) => digestOf(state, hostId, pluginId) !== null)
      .sort();
  },
  reset(hostId, pluginId) {
    const state = readState();
    if (!Object.hasOwn(state, hostId)) return;
    const next = { ...state };
    if (pluginId === undefined) {
      delete next[hostId];
    } else {
      const plugins = hostPlugins(state, hostId);
      if (!Object.hasOwn(plugins, pluginId)) return;
      delete plugins[pluginId];
      next[hostId] = plugins;
    }
    store.set(STORE_KEY, next);
  },
};

/** An in-memory store with the same rules, for tests. */
export function createMemoryPluginViewConsent(): PluginViewConsentStore {
  let state: ConsentState = {};
  return {
    allowedDigest: (hostId, pluginId) => digestOf(state, hostId, pluginId),
    allow(hostId, pluginId, digest) {
      if (!DIGEST.test(digest)) return;
      state = { ...state, [hostId]: { ...hostPlugins(state, hostId), [pluginId]: { digest } } };
    },
    list: (hostId) =>
      Object.keys(hostPlugins(state, hostId))
        .filter((pluginId) => digestOf(state, hostId, pluginId) !== null)
        .sort(),
    reset(hostId, pluginId) {
      if (pluginId === undefined) {
        const { [hostId]: _gone, ...rest } = state;
        state = rest;
        return;
      }
      const plugins = hostPlugins(state, hostId);
      delete plugins[pluginId];
      state = { ...state, [hostId]: plugins };
    },
  };
}
