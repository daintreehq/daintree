// Host-internal capabilities that must not ride on the objects plugins
// receive. A built-in plugin holds `host.fs` and `host.db` in process, so a
// property there would be reachable from plugin code; a WeakMap keyed by those
// objects is not. Kept free of heavy imports so the worker bridge can use it.

import type {
  BuiltinPluginFsApi,
  PluginDatabaseApi,
  PluginHostApi,
} from "../../../shared/types/plugin.js";

/** Approves a file another host component writes, through `host.fs`'s write gate. */
export const fsWriteApprovers = new WeakMap<
  BuiltinPluginFsApi,
  (op: string, targetPath: string) => Promise<string>
>();

/** Approves a `host.db` backup destination for a declared database id. */
export const databaseBackupApprovers = new WeakMap<
  PluginDatabaseApi,
  (id: string, destPath: string) => Promise<string>
>();

/** Approve a backup destination for a plugin's database. Used by the worker bridge. */
export function approvePluginDatabaseBackup(
  db: PluginDatabaseApi,
  id: string,
  destPath: string
): Promise<string> {
  const approve = databaseBackupApprovers.get(db);
  if (!approve) return Promise.reject(new Error("db.backup is not available on this host"));
  return approve(id, destPath);
}

/**
 * Observes whether a renderer in the host's scope listens on a push channel,
 * without registering a plugin event subscription: the observation backs a
 * worker's synchronous `host.hasListeners` cache, so it must not count towards
 * idle-disposal governance or keep the listener registry's reconcile running.
 * Returns the current value and an idempotent disposer; `callback` gets each
 * change after that.
 */
export type PushListenerObserver = (
  channel: string,
  callback: (hasListeners: boolean) => void
) => { current: boolean; dispose: () => void };

export const pushListenerObservers = new WeakMap<PluginHostApi, PushListenerObserver>();

/**
 * Observe `channel`'s listener state for `host`, or `null` for a host that
 * cannot say (callers then assume a listener). Used by the worker bridge.
 */
export function observePluginPushListeners(
  host: PluginHostApi,
  channel: string,
  callback: (hasListeners: boolean) => void
): { current: boolean; dispose: () => void } | null {
  const observe = pushListenerObservers.get(host);
  return observe ? observe(channel, callback) : null;
}
