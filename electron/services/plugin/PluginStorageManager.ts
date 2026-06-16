import path from "path";
import { PluginSettingsStore } from "../PluginSettingsStore.js";
import { projectStore } from "../ProjectStore.js";
import type { PluginStorageScope } from "../../../shared/types/plugin.js";

export function assertStorageKey(
  pluginId: string,
  method: string,
  key: unknown
): asserts key is string {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(`Plugin "${pluginId}" storage.${method}: key must be a non-empty string`);
  }
}

interface StorageSubscriber {
  key: string;
  scope: PluginStorageScope;
  cb: (value: unknown) => void;
}

interface PluginStorageManagerDeps {
  /** Getter for the user-plugins root; {@link PluginStorageManager.storageRoot} derives from it. */
  getPluginsRoot: () => string;
  /**
   * Resolve the active worktree's absolute path, or `undefined` when none is
   * active (or the workspace client isn't wired yet). Injected so the manager
   * stays testable without the Electron workspace host — `PluginService` wires
   * it to the same `getAllStatesAsync()` / `isCurrent` lookup `getActiveWorktree`
   * uses.
   */
  getActiveWorktreePath: () => Promise<string | undefined>;
}

/**
 * Owns the per-(plugin, scope, path) {@link PluginSettingsStore} cache, scope and
 * file-path resolution, the subscriber set and notification, and serializability
 * guards for the private {@link import("../../../shared/types/plugin.js").StorageApi}.
 *
 * This is the machine-owned counterpart to {@link import("./PluginSettingsManager.js").PluginSettingsManager}:
 * deliberately stripped of every settings-specific concern (declared-key gating,
 * secret routing, the settings-UI bridge). Storage values are plaintext JSON,
 * never declared, never surfaced in the settings UI. The `"worktree"` scope —
 * which settings has no analog for — resolves the active worktree at call time
 * through the injected `getActiveWorktreePath` callback, so storage paths track
 * worktree switches exactly as the `"project"` scope tracks project switches.
 */
export class PluginStorageManager {
  private readonly deps: PluginStorageManagerDeps;

  /**
   * Storage stores keyed by `{pluginId}\u0000{scope}\u0000{filePath}`. The NUL
   * (`\u0000`) separator is unambiguous because a valid plugin id can never
   * contain it. Keyed on the resolved path (not just scope) so a project /
   * worktree switch — which changes the resolved path — creates a fresh store
   * without evicting the old target's cache. Entries for a plugin are dropped on
   * unload.
   */
  private storageStores = new Map<string, PluginSettingsStore>();
  /**
   * Active `host.storage.onDidChange` subscriptions per plugin. Held here (not on
   * the store) so they survive project / worktree switches and are flushed in one
   * place on unload. Each disposer is also tracked in the facade's
   * `pluginEventCleanups`.
   */
  private storageSubscribers = new Map<string, Set<StorageSubscriber>>();

  constructor(deps: PluginStorageManagerDeps) {
    this.deps = deps;
  }

  /**
   * Root directory for user-scope plugin storage: a sibling of the plugins dir
   * and of `plugin-settings`. Production: `~/.daintree/plugin-storage`. Derived
   * from the plugins root so tests that pass a custom root stay isolated. A
   * distinct dir from `plugin-settings` so machine-owned state can be
   * `.gitignore`'d independently of user config.
   */
  storageRoot(): string {
    return path.join(path.dirname(this.deps.getPluginsRoot()), "plugin-storage");
  }

  /**
   * Resolve the JSON file backing a plugin's storage for a scope. User scope is
   * fixed; project scope resolves the active project at call time; worktree scope
   * resolves the active worktree (async) via the injected callback. Returns
   * `undefined` when the `"project"` / `"worktree"` target is not active.
   */
  async resolveStorageFilePath(
    pluginId: string,
    scope: PluginStorageScope
  ): Promise<string | undefined> {
    if (scope === "worktree") {
      const root = await this.deps.getActiveWorktreePath();
      if (!root) return undefined;
      return path.join(root, ".daintree", "plugin-storage", `${pluginId}.json`);
    }
    if (scope === "project") {
      const root = projectStore.getCurrentProject()?.path;
      if (!root) return undefined;
      return path.join(root, ".daintree", "plugin-storage", `${pluginId}.json`);
    }
    return path.join(this.storageRoot(), `${pluginId}.json`);
  }

  getOrCreateStorageStore(
    pluginId: string,
    scope: PluginStorageScope,
    filePath: string
  ): PluginSettingsStore {
    const cacheKey = `${pluginId}\u0000${scope}\u0000${filePath}`;
    let store = this.storageStores.get(cacheKey);
    if (!store) {
      store = new PluginSettingsStore(filePath);
      this.storageStores.set(cacheKey, store);
    }
    return store;
  }

  /**
   * Storage persists through `PluginSettingsStore.cloneValue`, which
   * JSON-round-trips the value. Probe serializability up front so a
   * non-serializable value surfaces a clear error rather than a raw JSON failure
   * deep in the store.
   */
  assertStorageSerializable(pluginId: string, key: string, value: unknown): void {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      throw new Error(`Plugin "${pluginId}" storage: value for "${key}" is not JSON-serializable`);
    }
  }

  /** Register a `host.storage.onDidChange` subscriber. */
  addSubscriber(pluginId: string, sub: StorageSubscriber): void {
    let subs = this.storageSubscribers.get(pluginId);
    if (!subs) {
      subs = new Set();
      this.storageSubscribers.set(pluginId, subs);
    }
    subs.add(sub);
  }

  /** Drop a `host.storage.onDidChange` subscriber, pruning the plugin's set when empty. */
  removeSubscriber(pluginId: string, sub: StorageSubscriber): void {
    const set = this.storageSubscribers.get(pluginId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.storageSubscribers.delete(pluginId);
  }

  notifyStorageSubscribers(
    pluginId: string,
    scope: PluginStorageScope,
    key: string,
    value: unknown
  ): void {
    const subs = this.storageSubscribers.get(pluginId);
    if (!subs) return;
    // Snapshot so a callback that disposes itself doesn't mutate the live set
    // mid-iteration.
    for (const sub of [...subs]) {
      if (sub.key !== key || sub.scope !== scope) continue;
      try {
        sub.cb(value);
      } catch (err) {
        console.error(
          `[PluginService] storage.onDidChange callback for "${pluginId}" key "${key}" failed:`,
          err
        );
      }
    }
  }

  clearPluginStorageState(pluginId: string): void {
    this.storageSubscribers.delete(pluginId);
    const prefix = `${pluginId}\u0000`;
    for (const cacheKey of [...this.storageStores.keys()]) {
      if (cacheKey.startsWith(prefix)) this.storageStores.delete(cacheKey);
    }
  }
}
