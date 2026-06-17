import path from "path";
import { SCOPED_PLUGIN_NAME_PATTERN } from "../../schemas/plugin.js";
import { PluginSettingsStore } from "../PluginSettingsStore.js";
import { projectStore } from "../ProjectStore.js";
import type {
  PluginManifest,
  PluginSettingsScope,
  PluginSettingsUiValues,
  SettingDefinition,
} from "../../../shared/types/plugin.js";

export function assertSettingsKey(
  pluginId: string,
  method: string,
  key: unknown
): asserts key is string {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(`Plugin "${pluginId}" settings.${method}: key must be a non-empty string`);
  }
}

interface SettingsSubscriber {
  key: string;
  scope: PluginSettingsScope;
  cb: (value: unknown) => void;
}

interface PluginSettingsManagerDeps {
  /** Getter for the user-plugins root; {@link PluginSettingsManager.settingsRoot} derives from it. */
  getPluginsRoot: () => string;
  /** Narrow manifest lookup — the manifest stays owned by core lifecycle. */
  getManifest: (pluginId: string) => PluginManifest | undefined;
}

/**
 * Owns the per-(plugin, scope, path) {@link PluginSettingsStore} cache, scope and
 * file-path resolution (user vs project, main-current-project vs explicit-projectId
 * UI variants), the subscriber set and notification, serializability / declared-key /
 * secret guards, the `${settings:<id>}` template resolver, and the renderer-facing
 * settings-UI bridge (read / write / delete / reveal).
 */
export class PluginSettingsManager {
  private readonly deps: PluginSettingsManagerDeps;

  /**
   * Persisted-settings stores keyed by `{pluginId}\u0000{scope}\u0000{filePath}`.
   * The NUL (`\u0000`) separator is unambiguous because a valid plugin id can
   * never contain it (see the manifest name pattern). Keyed on the resolved path
   * (not just scope) so a project switch — which changes the `project`-scope
   * path — creates a fresh store without evicting the old project's cache.
   * Entries for a plugin are dropped on unload.
   */
  private settingsStores = new Map<string, PluginSettingsStore>();
  /**
   * Active `host.settings.onDidChange` subscriptions per plugin. Held here (not
   * on the store) so they survive project-root switches and are flushed in one
   * place on unload. Each disposer is also tracked in the facade's
   * `pluginEventCleanups`.
   */
  private settingsSubscribers = new Map<string, Set<SettingsSubscriber>>();

  constructor(deps: PluginSettingsManagerDeps) {
    this.deps = deps;
  }

  /**
   * Root directory for user-scope plugin settings: a sibling of the plugins
   * dir. Production: `~/.daintree/plugin-settings`. Derived from the plugins
   * root so tests that pass a custom root stay isolated.
   */
  settingsRoot(): string {
    return path.join(path.dirname(this.deps.getPluginsRoot()), "plugin-settings");
  }

  /**
   * Resolve the JSON file backing a plugin's settings for a scope. User scope is
   * fixed; project scope resolves the active project at call time and returns
   * `undefined` when none is active.
   */
  resolveSettingsFilePath(pluginId: string, scope: PluginSettingsScope): string | undefined {
    if (scope === "project") {
      const root = projectStore.getCurrentProject()?.path;
      if (!root) return undefined;
      return path.join(root, ".daintree", "plugin-settings", `${pluginId}.json`);
    }
    return path.join(this.settingsRoot(), `${pluginId}.json`);
  }

  getOrCreateSettingsStore(
    pluginId: string,
    scope: PluginSettingsScope,
    filePath: string
  ): PluginSettingsStore {
    const cacheKey = `${pluginId}\u0000${scope}\u0000${filePath}`;
    let store = this.settingsStores.get(cacheKey);
    if (!store) {
      store = new PluginSettingsStore(filePath);
      this.settingsStores.set(cacheKey, store);
    }
    return store;
  }

  /**
   * Enforce `contributes.settings` key declarations on `set`/`delete`. When a
   * manifest declares no settings (absent or empty array), any key is accepted;
   * once a plugin declares them, undeclared keys are rejected. When a key IS
   * declared, its declared `scope` (default `"user"`) must match the requested
   * scope — the write counterpart to the scope filter the read/reveal paths
   * apply, so a `user`-scoped key can't be written under `project` (or
   * vice-versa) via the host API or the settings-UI bridge.
   */
  assertSettingDeclared(pluginId: string, key: string, scope: PluginSettingsScope): void {
    const declared = this.deps.getManifest(pluginId)?.contributes.settings;
    if (!declared || declared.length === 0) return;
    const def = declared.find((s) => s.id === key);
    if (!def) {
      throw new Error(
        `Plugin "${pluginId}" settings.set: key "${key}" is not declared in contributes.settings`
      );
    }
    if ((def.scope ?? "user") !== scope) {
      throw new Error(
        `Plugin "${pluginId}" settings.set: key "${key}" is declared in "${def.scope ?? "user"}" scope, not "${scope}"`
      );
    }
  }

  /**
   * Reject a `host.settings.onDidChange` subscription whose `scope` mismatches a
   * declared key's `scope`. Undeclared keys (or manifests with no declarations)
   * are left alone — only the declared scope is enforced, mirroring the set/delete
   * guard in {@link assertSettingDeclared} without also gating undeclared keys.
   */
  assertSettingScope(pluginId: string, key: string, scope: PluginSettingsScope): void {
    const def = this.deps.getManifest(pluginId)?.contributes.settings?.find((s) => s.id === key);
    if (def && (def.scope ?? "user") !== scope) {
      throw new Error(
        `Plugin "${pluginId}" settings.onDidChange: key "${key}" is declared in "${def.scope ?? "user"}" scope, not "${scope}"`
      );
    }
  }

  /**
   * Resolve the manifest-declared scope for a key so the read path (`settings.get`)
   * can target the same scope the write path enforces via {@link assertSettingDeclared}.
   * Returns the declared scope (default `"user"`) when the key is declared, or
   * `undefined` when the manifest declares no settings or doesn't declare this key —
   * the same permissive fallback the write/secret guards take, so reads of undeclared
   * keys keep working against the caller-supplied (or `"user"`) scope.
   */
  getDeclaredScope(pluginId: string, key: string): PluginSettingsScope | undefined {
    const def = this.deps.getManifest(pluginId)?.contributes.settings?.find((s) => s.id === key);
    return def ? (def.scope ?? "user") : undefined;
  }

  /**
   * Both settings write paths (host `settings.set` and the UI bridge) persist
   * through `PluginSettingsStore.cloneValue`, which JSON-round-trips the value.
   * Probe serializability up front so a non-serializable value surfaces a clear
   * error rather than a raw JSON failure deep in the store.
   */
  assertSettingSerializable(pluginId: string, key: string, value: unknown): void {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      throw new Error(`Plugin "${pluginId}" settings: value for "${key}" is not JSON-serializable`);
    }
  }

  /** Register a `host.settings.onDidChange` subscriber. */
  addSubscriber(pluginId: string, sub: SettingsSubscriber): void {
    let subs = this.settingsSubscribers.get(pluginId);
    if (!subs) {
      subs = new Set();
      this.settingsSubscribers.set(pluginId, subs);
    }
    subs.add(sub);
  }

  /** Drop a `host.settings.onDidChange` subscriber, pruning the plugin's set when empty. */
  removeSubscriber(pluginId: string, sub: SettingsSubscriber): void {
    const set = this.settingsSubscribers.get(pluginId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.settingsSubscribers.delete(pluginId);
  }

  notifySettingsSubscribers(
    pluginId: string,
    scope: PluginSettingsScope,
    key: string,
    value: unknown
  ): void {
    const subs = this.settingsSubscribers.get(pluginId);
    if (!subs) return;
    // Snapshot so a callback that disposes itself doesn't mutate the live set
    // mid-iteration.
    for (const sub of [...subs]) {
      if (sub.key !== key || sub.scope !== scope) continue;
      try {
        sub.cb(value);
      } catch (err) {
        console.error(
          `[PluginService] settings.onDidChange callback for "${pluginId}" key "${key}" failed:`,
          err
        );
      }
    }
  }

  clearPluginSettingsState(pluginId: string): void {
    this.settingsSubscribers.delete(pluginId);
    const prefix = `${pluginId}\u0000`;
    for (const cacheKey of [...this.settingsStores.keys()]) {
      if (cacheKey.startsWith(prefix)) this.settingsStores.delete(cacheKey);
    }
  }

  /**
   * Resolve a `${settings:<id>}` template by reading the named user-scope
   * setting and stringifying the value. Booleans and numbers become their
   * JSON representation; objects/arrays become JSON-encoded strings. An
   * undefined or missing setting resolves to the empty string so the
   * substituted command remains a valid argv entry rather than a literal
   * `"undefined"`.
   */
  async resolveSettingTemplate(pluginId: string, settingId: string): Promise<string> {
    const filePath = this.resolveSettingsFilePath(pluginId, "user");
    if (!filePath) return "";
    const value = await this.getOrCreateSettingsStore(pluginId, "user", filePath).get<unknown>(
      settingId,
      { secret: this.isSecretKey(pluginId, settingId) }
    );
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  // ============================================================
  // Settings UI bridge (#9301)
  //
  // Renderer-facing read/write/reveal/clear for the generated settings form.
  // These reuse the same per-(plugin, scope) store and subscriber path as the
  // plugin-facing `host.settings` API, so a write from the form fires the
  // owning plugin's `onDidChange` without it reactivating. Project scope is
  // resolved from an explicit `projectId` (not the main-process "current
  // project") so a settings form in one window can't read or write another
  // window's active-project values.
  // ============================================================

  private uiSettingDefinitions(pluginId: string): SettingDefinition[] {
    return this.deps.getManifest(pluginId)?.contributes.settings ?? [];
  }

  /**
   * A setting is secret when it declares the canonical `type: "secret"` OR the
   * legacy `secret: true` flag. Both must be checked — the manifest schema keeps
   * the boolean when coercing `secret: true` to `type: "secret"`, but a manifest
   * authored directly as `{ type: "secret" }` carries no boolean, so a
   * `secret`-only check would leak its value into {@link getSettingValuesForUi}.
   */
  private isSecretSetting(def: SettingDefinition): boolean {
    return def.type === "secret" || def.secret === true;
  }

  /**
   * Whether the declared setting `key` is secret, for routing its at-rest value
   * through the OS keychain (#9167). A manifest that declares no settings — or an
   * undeclared key — is treated as non-secret: the same permissive stance
   * {@link assertSettingDeclared} takes, so the host `settings` API used before a
   * plugin declares its settings keeps working as plaintext.
   */
  isSecretKey(pluginId: string, key: string): boolean {
    const def = this.deps.getManifest(pluginId)?.contributes.settings?.find((s) => s.id === key);
    return def ? this.isSecretSetting(def) : false;
  }

  /**
   * Resolve the settings file path for a UI call. User scope is fixed; project
   * scope resolves the explicit `projectId` (returns `null` for an
   * unknown/absent id, which callers treat as "no project active").
   *
   * Invariant: the renderer passes its own `currentProject.id`, the same id
   * space `projectStore.getProjectById` is keyed on. This is what makes
   * per-window project scoping correct — a form in one window resolves *its*
   * project, not the main process's globally-"current" project, which may
   * belong to a different window.
   */
  private resolveUiSettingsFilePath(
    pluginId: string,
    scope: PluginSettingsScope,
    projectId: string | null
  ): string | null {
    // Defense-in-depth: pluginId is joined onto the settings root for fs reads
    // and writes, so reject anything that isn't a scoped plugin name before any
    // path.join — blocks `..` traversal and separators (mirrors uninstallPlugin).
    if (!SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) {
      throw new Error("plugin settings: pluginId must be a scoped plugin name (publisher.name)");
    }
    if (scope !== "user" && scope !== "project") {
      throw new Error(`plugin settings: invalid scope "${String(scope)}"`);
    }
    if (scope === "project") {
      if (!projectId) return null;
      const root = projectStore.getProjectById(projectId)?.path;
      if (!root) return null;
      return path.join(root, ".daintree", "plugin-settings", `${pluginId}.json`);
    }
    return path.join(this.settingsRoot(), `${pluginId}.json`);
  }

  /**
   * Read stored values for one plugin + scope, for the settings form. Secret
   * settings are never returned by value — their ids appear in `secretsSet` when
   * a value is stored. Only settings whose declared scope matches `scope` are
   * included, so a stray key in the wrong file can't surface under the other
   * scope.
   */
  async getSettingValuesForUi(
    pluginId: string,
    scope: PluginSettingsScope,
    projectId: string | null
  ): Promise<PluginSettingsUiValues> {
    const values: Record<string, unknown> = {};
    const secretsSet: string[] = [];
    const secretsPlaintext: string[] = [];
    const filePath = this.resolveUiSettingsFilePath(pluginId, scope, projectId);
    if (!filePath) {
      return { values, secretsSet, secretsPlaintext, secretTier: "plaintext" };
    }
    const store = this.getOrCreateSettingsStore(pluginId, scope, filePath);
    const defs = this.uiSettingDefinitions(pluginId).filter((d) => (d.scope ?? "user") === scope);
    await Promise.all(
      defs.map(async (def) => {
        const secret = this.isSecretSetting(def);
        const stored = await store.get<unknown>(def.id, { secret });
        if (stored === undefined) return;
        if (secret) {
          secretsSet.push(def.id);
          // Surface a value still sitting in plaintext so the form can nudge a
          // re-save once a keychain is available.
          if ((await store.storedSecretTier(def.id)) === "plaintext") {
            secretsPlaintext.push(def.id);
          }
        } else {
          values[def.id] = stored;
        }
      })
    );
    return { values, secretsSet, secretsPlaintext, secretTier: store.secretTier() };
  }

  /**
   * Persist a value from the settings form, firing the plugin's `onDidChange`.
   * Returns whether the stored value actually changed, so callers can skip
   * change-driven side effects (e.g. an MCP server restart on secret rotation,
   * #10619) on a redundant re-save of the same value.
   */
  async setSettingValueFromUi(
    pluginId: string,
    key: string,
    value: unknown,
    scope: PluginSettingsScope,
    projectId: string | null
  ): Promise<boolean> {
    assertSettingsKey(pluginId, "set", key);
    if (value === undefined) {
      throw new Error(
        `Plugin "${pluginId}" settings: value for "${key}" is undefined — settings cannot store undefined`
      );
    }
    this.assertSettingSerializable(pluginId, key, value);
    this.assertSettingDeclared(pluginId, key, scope);
    const filePath = this.resolveUiSettingsFilePath(pluginId, scope, projectId);
    if (!filePath) {
      throw new Error(
        `Plugin "${pluginId}" settings: no active project — "project" scope has no target`
      );
    }
    const store = this.getOrCreateSettingsStore(pluginId, scope, filePath);
    const changed = await store.set(key, value, { secret: this.isSecretKey(pluginId, key) });
    if (changed) this.notifySettingsSubscribers(pluginId, scope, key, value);
    return changed;
  }

  /**
   * Clear a stored value (the form's "reset to default" — resetting removes the
   * stored override rather than writing the declared default). Fires
   * `onDidChange` with `undefined` so the plugin falls back to its default.
   * Returns whether anything was actually removed (see
   * {@link setSettingValueFromUi} for why the changed signal matters).
   */
  async deleteSettingValueFromUi(
    pluginId: string,
    key: string,
    scope: PluginSettingsScope,
    projectId: string | null
  ): Promise<boolean> {
    assertSettingsKey(pluginId, "delete", key);
    this.assertSettingDeclared(pluginId, key, scope);
    const filePath = this.resolveUiSettingsFilePath(pluginId, scope, projectId);
    if (!filePath) return false;
    const store = this.getOrCreateSettingsStore(pluginId, scope, filePath);
    const changed = await store.delete(key);
    if (changed) this.notifySettingsSubscribers(pluginId, scope, key, undefined);
    return changed;
  }

  /**
   * Fetch a single secret value for in-place reveal. Returns `null` when unset.
   * Non-string secrets are JSON-stringified so the form can display them.
   *
   * Only a declared `secret`-typed setting may be revealed — this is the secret
   * counterpart to the masking in {@link getSettingValuesForUi}. The guard stops
   * the channel being used as a generic read-any-key bypass that would let a
   * caller pull non-secret (or undeclared) values one at a time.
   */
  async revealSecretSettingForUi(
    pluginId: string,
    key: string,
    scope: PluginSettingsScope,
    projectId: string | null
  ): Promise<string | null> {
    assertSettingsKey(pluginId, "get", key);
    const def = this.uiSettingDefinitions(pluginId).find((s) => s.id === key);
    if (!def || !this.isSecretSetting(def)) return null;
    // Only reveal from the setting's own declared scope — mirrors the scope
    // filter in getSettingValuesForUi so a user-scoped secret can't be probed
    // under "project" by passing a projectId.
    if ((def.scope ?? "user") !== scope) return null;
    const filePath = this.resolveUiSettingsFilePath(pluginId, scope, projectId);
    if (!filePath) return null;
    const value = await this.getOrCreateSettingsStore(pluginId, scope, filePath).get<unknown>(key, {
      secret: true,
    });
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  }
}
