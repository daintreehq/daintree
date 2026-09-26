// Host-internal capabilities that must not ride on the objects plugins
// receive. A built-in plugin holds `host.fs` and `host.db` in process, so a
// property there would be reachable from plugin code; a WeakMap keyed by those
// objects is not. Kept free of heavy imports so the worker bridge can use it.

import type { BuiltinPluginFsApi, PluginDatabaseApi } from "../../../shared/types/plugin.js";

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
