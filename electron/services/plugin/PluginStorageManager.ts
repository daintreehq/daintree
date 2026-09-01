import path from "path";
import { PluginSettingsStore } from "../PluginSettingsStore.js";
import { pluginManifestIdFromInstanceKey } from "./projectPluginIdentity.js";
import { projectStore } from "../ProjectStore.js";
import type { PluginStorageScope } from "../../../shared/types/plugin.js";
import {
  createListenerFailureState,
  invokeTrackedListener,
  type ListenerFailureState,
} from "./pluginCallbackUtils.js";

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
  /** Consecutive-failure counter, lazily initialized on first dispatch (#10621). */
  failures?: ListenerFailureState;
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
 * The project / worktree a storage call belongs to, when the caller knows it —
 * a project-bound plugin host pins its own target here so a project or worktree
 * switch can't move its file. An absent or `null` member means unbound, and that
 * scope falls back to the app-global active project / worktree.
 */
export interface ExplicitStorageTarget {
  readonly projectRoot?: string | null;
  readonly worktreePath?: string | null;
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
 * which settings has no analog for — resolves through the injected
 * `getActiveWorktreePath` callback when the caller supplies no explicit target,
 * so an unbound plugin's storage paths track worktree switches exactly as its
 * `"project"` scope tracks project switches.
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
   * fixed. Project and worktree scope resolve `target` when the caller supplies
   * the matching root, and otherwise the app-global active project / active
   * worktree at call time. Returns `undefined` when there is no target.
   */
  async resolveStorageFilePath(
    pluginId: string,
    scope: PluginStorageScope,
    target?: ExplicitStorageTarget
  ): Promise<string | undefined> {
    // In-repository files are named by the MANIFEST id, never by the instance
    // key. A project plugin's instance key embeds this machine's project id,
    // and `<projectRoot>/.daintree/` is git-tracked — writing that id into a
    // filename would commit one developer's local identity into everyone's
    // checkout, and a fresh clone at a different path would then read nothing.
    // The project root already provides the isolation the key would.
    const repoFileId = pluginManifestIdFromInstanceKey(pluginId);
    if (scope === "worktree") {
      // Nullish, not falsy: an empty-string path is a caller bug, and treating it
      // as "unbound" would silently target whatever worktree is active instead.
      // Unbound (installed/builtin) plugins have no project of their own, so the
      // app-global active worktree is the only target they can mean.
      const root =
        target?.worktreePath == null
          ? await this.deps.getActiveWorktreePath()
          : target.worktreePath;
      if (!root) return undefined;
      return path.join(root, ".daintree", "plugin-storage", `${repoFileId}.json`);
    }
    if (scope === "project") {
      // Same nullish rule, and the same app-global fallback for an unbound plugin.
      const root =
        target?.projectRoot == null ? projectStore.getCurrentProject()?.path : target.projectRoot;
      if (!root) return undefined;
      return path.join(root, ".daintree", "plugin-storage", `${repoFileId}.json`);
    }
    // User scope stays keyed by the INSTANCE: two projects shipping the same
    // manifest id are two different plugins, and they must not share a store.
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
      if (!sub.failures) sub.failures = createListenerFailureState();
      invokeTrackedListener(
        sub.failures,
        pluginId,
        `storage.onDidChange (key "${key}")`,
        () => sub.cb(value),
        () => this.removeSubscriber(pluginId, sub)
      );
    }
  }

  /**
   * Drop cached storage stores for the `"worktree"` scope across every plugin
   * (#10621). The cache is keyed on the resolved file path, so re-activating the
   * same worktree reuses the same store and its in-memory snapshot — which may be
   * stale if the backing file changed while the worktree was inactive. Evicting on
   * each `worktree-activated` forces a fresh read on the next access. `"user"` and
   * `"project"` scoped stores are untouched: user state is process-global and
   * project switches already change the resolved path (a fresh store).
   *
   * The cache records no provenance, so a store pinned to an explicit worktree is
   * evicted by an unrelated worktree activation too. Over-eager, not wrong: the
   * cost is one re-read from the same file.
   */
  evictWorktreeScopedStores(): void {
    const marker = "\x00worktree\x00";
    for (const cacheKey of [...this.storageStores.keys()]) {
      if (cacheKey.includes(marker)) this.storageStores.delete(cacheKey);
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
