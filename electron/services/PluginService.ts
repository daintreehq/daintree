// eager-import-allow: reads plugin settings via store.get synchronously during service init
import fs from "fs/promises";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import { app } from "electron";
import * as semver from "semver";
import { PluginManifestSchema } from "../schemas/plugin.js";
import type {
  PluginManifest,
  PluginIpcHandler,
  PluginIpcContext,
  PluginHostApi,
  PluginActivate,
  PluginActionContribution,
  PluginActionDescriptor,
  BuiltInPluginPermission,
} from "../../shared/types/plugin.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import { toPluginWorktreeSnapshot } from "../../shared/utils/pluginWorktreeSnapshot.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import {
  registerPanelKind,
  unregisterPluginPanelKinds,
  onPanelKindRegistered,
  onPanelKindUnregistered,
  getPluginPanelKinds,
} from "../../shared/config/panelKindRegistry.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
  getAllPluginToolbarButtonConfigs,
} from "../../shared/config/toolbarButtonRegistry.js";
import { registerPluginMenuItem, unregisterPluginMenuItems } from "./pluginMenuRegistry.js";
import {
  registerForgeProviderImpl,
  registerForgeProviders,
  unregisterForgeProviderImpl,
  unregisterForgeProviderImpls,
  unregisterForgeProviders,
} from "./forgeProviderRegistry.js";
import {
  registerFileDecorationProviderImpl,
  registerFileDecorationProviders,
  scopeMatchesPattern,
  unregisterFileDecorationProviderImpl,
  unregisterFileDecorationProviderImpls,
  unregisterFileDecorationProviders,
} from "./fileDecorationRegistry.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import type { LoadedPluginInfo } from "../../shared/types/plugin.js";
import type { PluginToolbarButtonId } from "../../shared/types/toolbar.js";
import { store } from "../store.js";

/** Plugin action IDs must be `{pluginId}.{actionId}`. Built-in IDs use colons, so the formats cannot collide. */
const PLUGIN_ACTION_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;

const PLUGIN_ACTION_KINDS = new Set(["command", "query"]);
const PLUGIN_ACTION_DANGERS = new Set(["safe", "confirm"]);

/**
 * Permissions whose presence in a plugin's manifest forces every action that
 * plugin contributes up to `effectiveDanger: "confirm"`, regardless of the
 * `danger` the plugin self-declared. These are the permissions that grant
 * irreversible or hard-to-undo side effects: arbitrary process execution,
 * git history mutation, project/user-config filesystem writes, and agent
 * invocation. Read-only or trivially-reversible permissions (`*-read`,
 * `network:fetch`, `clipboard:*`) are intentionally excluded — promoting on
 * those would over-confirm and train users to dismiss the dialog. The host
 * may only raise danger; a plugin declaring `"confirm"` always stays
 * `"confirm"` even with none of these.
 */
const CONFIRM_TRIGGERING_PERMISSIONS: ReadonlySet<BuiltInPluginPermission> = new Set([
  "shell:exec",
  "git:write",
  "fs:project-write",
  "fs:user-data-write",
  "agent:invoke",
]);

interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  resolvedMain?: string;
  loadedAt: number;
  isBuiltin: boolean;
}

/**
 * Diagnostic record of the most recent activation failure for a plugin id.
 * Held internally (not on {@link LoadedPluginInfo}) until #9271 lands the
 * provenance store with a public `loadError` field — at that point this Map
 * is migrated into the provenance record. Until then the Settings diagnostic
 * tab and IPC consumers may read it via {@link PluginService.getPluginLoadError}.
 */
interface PluginLoadErrorRecord {
  message: string;
  stack?: string;
  at: number;
}

const ACTIVATE_TIMEOUT_MS = 5000;

/**
 * Normalise the value thrown out of `activate()` into a serialisable record.
 * `unknown` becomes a stable `{ message, stack?, at }` shape so the Settings
 * diagnostic tab (and #9271's provenance store) don't have to re-handle raw
 * error objects.
 */
function toPluginLoadErrorRecord(err: unknown): PluginLoadErrorRecord {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, at: Date.now() };
  }
  if (typeof err === "string") {
    return { message: err, at: Date.now() };
  }
  try {
    return { message: JSON.stringify(err), at: Date.now() };
  } catch {
    return { message: String(err), at: Date.now() };
  }
}

/**
 * Run a single unload-cascade step with per-step containment. A throwing
 * disposer is logged as a warning (best-effort cleanup, not a user-actionable
 * error per the issue's containment contract) and the cascade continues so
 * subsequent registry unregisters still fire. Without this wrapping, one
 * thrown disposer would strand later steps and leak registrations that fail
 * the next load with a duplicate-id error.
 */
function runUnloadStep(pluginId: string, step: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[PluginService] Unload step "${step}" for "${pluginId}" threw:`, err);
  }
}

type WorkspaceWorktreeEvent = "worktree-update" | "worktree-activated" | "worktree-removed";

export class PluginService {
  private plugins = new Map<string, LoadedPlugin>();
  private handlerMap = new Map<string, PluginIpcHandler>();
  private cleanupMap = new Map<string, () => void>();
  private pluginActions = new Map<string, PluginActionDescriptor>();
  private pluginActionOwners = new Map<string, Set<string>>();
  private pluginEventCleanups = new Map<string, Array<() => void>>();
  /**
   * Most recent activation error per plugin id. Populated by the catch in
   * `loadPlugin()` so a thrown `activate()` no longer escapes containment.
   * Cleared on unload and on a subsequent successful activation. Exposed via
   * {@link getPluginLoadError} for Settings diagnostics and IPC introspection.
   */
  private pluginLoadErrors = new Map<string, PluginLoadErrorRecord>();
  private workspaceClient: WorkspaceClient | null = null;
  /**
   * Event subscriptions registered during plugin `activate()` when the
   * WorkspaceClient did not yet exist. Replayed in `setWorkspaceClient()`
   * so early-boot subscriptions attach to the real client instead of being
   * silently dropped.
   */
  private pendingWorktreeSubs: Array<{
    pluginId: string;
    event: WorkspaceWorktreeEvent;
    handler: () => void;
    activate: (client: WorkspaceClient) => void;
  }> = [];
  private initialized = false;
  /**
   * Plugin ids that are owned by a built-in plugin but currently disabled in
   * Preferences. Held alongside `this.plugins` so the user-dir scan cannot
   * register a third-party plugin under a trusted first-party namespace just
   * because the matching built-in is turned off — the namespace stays claimed
   * even when the activation is skipped.
   */
  private reservedBuiltinNames = new Set<string>();
  private pluginsRoot: string;
  /**
   * Optional override for the built-in plugins directory. When unset, the
   * canonical app-bundled path is resolved lazily at `initialize()` time via
   * {@link getBuiltinDir}. Tests pass an explicit path so they don't depend
   * on `app.isPackaged` / `process.resourcesPath`.
   */
  private builtinPluginsRoot: string | undefined;
  private appVersion: string;
  /**
   * Coalesces multiple registry events fired in the same tick (e.g., when a
   * plugin contributes several panel kinds, or when `unregisterPluginPanelKinds`
   * removes N kinds in one call) into a single broadcast carrying the current
   * snapshot.
   */
  private panelKindsBroadcastPending = false;
  /**
   * Same coalescing rationale as {@link panelKindsBroadcastPending}: a plugin
   * contributing N toolbar buttons calls `registerToolbarButton` N times in
   * `loadPlugin()`, and `unregisterPluginToolbarButtons` removes them in one
   * call on unload — batch into a single snapshot broadcast per tick.
   */
  private toolbarButtonsBroadcastPending = false;
  /**
   * OR-accumulated across triggers coalesced into one tick: true if any was an
   * unload (uninstall). The registry at microtask-drain time always reflects
   * the current set, so a tick that included an unload is an authoritative
   * snapshot the renderer may safely sweep against; a tick of only loads is a
   * partial/growing snapshot (concurrent load + deferred init) and must not.
   */
  private toolbarButtonsBroadcastComplete = false;
  private disposed = false;
  private readonly disposeRegistrySubscriptions: () => void;

  constructor(
    pluginsRoot?: string,
    appVersion?: string,
    options?: { builtinPluginsRoot?: string }
  ) {
    this.pluginsRoot = pluginsRoot ?? path.join(os.homedir(), ".daintree", "plugins");
    this.appVersion = appVersion ?? app.getVersion();
    this.builtinPluginsRoot = options?.builtinPluginsRoot;

    const offRegister = onPanelKindRegistered(() => this.schedulePanelKindsBroadcast());
    const offUnregister = onPanelKindUnregistered(() => this.schedulePanelKindsBroadcast());
    this.disposeRegistrySubscriptions = () => {
      offRegister();
      offUnregister();
    };
  }

  /**
   * Stop forwarding shared registry events to the renderer. Intended for
   * tests that need a clean teardown — production code holds a single
   * `pluginService` singleton for the app lifetime. Also drops any pending
   * batched broadcast so a microtask scheduled before disposal doesn't leak
   * an emit into the next test.
   */
  dispose(): void {
    this.disposed = true;
    this.disposeRegistrySubscriptions();
  }

  /**
   * Inject the WorkspaceClient after it's been created. PluginService may be
   * initialized before WorkspaceClient in the startup sequence, so we can't
   * take it in the constructor. Safe to call multiple times; the latest
   * reference wins. When set for the first time, replays any pending event
   * subscriptions that were registered during early plugin activate().
   */
  setWorkspaceClient(client: WorkspaceClient | null): void {
    this.workspaceClient = client;
    if (client && this.pendingWorktreeSubs.length > 0) {
      const pending = this.pendingWorktreeSubs;
      this.pendingWorktreeSubs = [];
      for (const sub of pending) {
        sub.activate(client);
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Built-ins load first so user plugins with a colliding manifest.name are
    // rejected by the duplicate guard in loadPlugin() — built-in wins.
    const builtinDir = this.builtinPluginsRoot ?? this.getBuiltinDir();
    try {
      const builtinLoaded = builtinDir
        ? await this.loadFromDir(builtinDir, { isBuiltin: true })
        : 0;
      const userLoaded = await this.loadFromDir(this.pluginsRoot, { isBuiltin: false });
      console.log(
        `[PluginService] Loaded ${builtinLoaded} built-in plugin(s) from ${builtinDir ?? "<unresolved>"} and ${userLoaded} user plugin(s) from ${this.pluginsRoot}`
      );
    } finally {
      // Idempotency must hold even when a scan throws (e.g. EACCES on the
      // user dir): a retry would re-run the built-in scan and trigger
      // "already registered, overwriting" warnings from the contribution
      // registries.
      this.initialized = true;
    }
  }

  /**
   * Canonical app-bundled built-in plugins directory. Resolved at call time
   * because `app.isPackaged` / `process.resourcesPath` are not valid at module
   * evaluation. Mirrors the pattern in HelpService / SoundService — built-ins
   * ship via electron-builder's `extraResources`, so the source directory at
   * the repo root maps 1:1 to `<Resources>/plugins/builtin/` in packaged
   * builds. Returns `null` when the Electron app API is unavailable (tests
   * that mock `electron` with a minimal stub) — the built-in scan is then
   * skipped without aborting user-plugin loading.
   */
  private getBuiltinDir(): string | null {
    try {
      if (typeof app.getAppPath !== "function") return null;
      // Plugins must live alongside the shared esbuild chunks at
      // `dist-electron/electron/chunks/` so the relative `import` paths in
      // their bundled output resolve. In dev this resolves to the repo's
      // `dist-electron/` directory; in packaged builds it resolves inside
      // `app.asar/dist-electron/`, which is on disk via Electron's fs patch.
      // Using a single path for both modes keeps the chunk-relative imports
      // honest — copying the plugins into `Resources/plugins/builtin/` would
      // strand the relative chunk references and produce a silent registration
      // gap (descriptor present, impl never bound).
      return path.join(app.getAppPath(), "dist-electron", "plugins", "builtin");
    } catch (err) {
      console.warn("[PluginService] Failed to resolve built-in plugins directory:", err);
      return null;
    }
  }

  /**
   * Read disabled built-in plugin ids from the user store. Defensive against
   * missing keys (in-memory fallback during tests) and read failures —
   * a failed read returns an empty set so all built-ins activate, matching
   * the safest startup behavior.
   */
  private getDisabledBuiltinIds(): Set<string> {
    try {
      const value = store.get("plugins") as { disabledBuiltins?: unknown } | undefined;
      const list = Array.isArray(value?.disabledBuiltins) ? value.disabledBuiltins : [];
      return new Set(list.filter((id): id is string => typeof id === "string"));
    } catch (err) {
      console.warn("[PluginService] Failed to read disabled built-in plugins from store:", err);
      return new Set();
    }
  }

  private async loadFromDir(root: string, opts: { isBuiltin: boolean }): Promise<number> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.log(
          `[PluginService] No ${opts.isBuiltin ? "built-in" : "user"} plugins directory at ${root}, skipping`
        );
        return 0;
      }
      throw err;
    }

    const pluginDirs = entries.filter((e) => e.isDirectory());
    const disabled = opts.isBuiltin ? this.getDisabledBuiltinIds() : null;
    const results = await Promise.allSettled(
      pluginDirs.map((d) => this.loadPlugin(root, d.name, { isBuiltin: opts.isBuiltin, disabled }))
    );

    let loaded = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        loaded++;
      }
    }
    return loaded;
  }

  private async loadPlugin(
    root: string,
    dirName: string,
    opts: { isBuiltin: boolean; disabled: Set<string> | null }
  ): Promise<LoadedPlugin | null> {
    const pluginDir = path.join(root, dirName);
    const manifestPath = path.join(pluginDir, "plugin.json");

    let content: string;
    try {
      content = await fs.readFile(manifestPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(`[PluginService] No plugin.json in ${dirName}, skipping`);
        return null;
      }
      console.error(`[PluginService] Failed to read ${manifestPath}:`, err);
      return null;
    }

    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      console.error(`[PluginService] Invalid JSON in ${manifestPath}`);
      return null;
    }

    const parseResult = PluginManifestSchema.safeParse(json);
    if (!parseResult.success) {
      console.error(`[PluginService] Invalid manifest in ${dirName}:`, parseResult.error.issues);
      return null;
    }

    const manifest = parseResult.data;

    // Built-ins disabled in Preferences are skipped entirely — neither
    // registered in the plugins map nor activated. The disable persists in
    // electron-store and takes effect on next launch. The name is reserved
    // so a user plugin in the next scan cannot hijack a trusted first-party
    // namespace just because its built-in is off.
    if (opts.isBuiltin && opts.disabled?.has(manifest.name)) {
      console.log(`[PluginService] Built-in plugin "${manifest.name}" is disabled, skipping`);
      this.reservedBuiltinNames.add(manifest.name);
      return null;
    }

    if (this.plugins.has(manifest.name) || this.reservedBuiltinNames.has(manifest.name)) {
      console.error(
        `[PluginService] Duplicate plugin name "${manifest.name}" in ${dirName} — rejecting`
      );
      return null;
    }

    const requiredRange = manifest.engines?.daintree;
    if (requiredRange) {
      if (!semver.satisfies(this.appVersion, requiredRange, { includePrerelease: true })) {
        console.error(
          `[PluginService] Plugin "${manifest.name}" requires Daintree ${requiredRange} but current version is ${this.appVersion} — skipping`
        );
        broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
          type: "error",
          title: "Plugin incompatible",
          message: `Plugin "${manifest.displayName ?? manifest.name}" requires Daintree ${requiredRange} but current version is ${this.appVersion}.`,
        });
        return null;
      }
    } else {
      console.warn(
        `[PluginService] Plugin "${manifest.name}" does not declare engines.daintree — consider adding it to ensure compatibility`
      );
    }

    if (manifest.permissions.length > 0) {
      console.log(
        `[PluginService] Plugin "${manifest.name}" declares permissions: ${manifest.permissions.join(", ")}`
      );
    }

    const plugin: LoadedPlugin = {
      manifest,
      dir: pluginDir,
      loadedAt: Date.now(),
      isBuiltin: opts.isBuiltin,
    };

    if (manifest.main) {
      const resolved = this.resolveEntryPath(pluginDir, manifest.main);
      if (resolved) {
        plugin.resolvedMain = resolved;
      } else {
        console.warn(
          `[PluginService] Plugin ${manifest.name}: main entry path escapes plugin directory, ignoring`
        );
      }
    }

    for (const panel of manifest.contributes.panels) {
      const panelId = `${manifest.name}.${panel.id}`;
      registerPanelKind({
        id: panelId,
        name: panel.name,
        iconId: panel.iconId,
        color: panel.color,
        hasPty: panel.hasPty,
        canRestart: panel.canRestart,
        canConvert: panel.canConvert,
        showInPalette: panel.showInPalette,
        extensionId: manifest.name,
      });
    }

    for (const btn of manifest.contributes.toolbarButtons) {
      const buttonId = `plugin.${manifest.name}.${btn.id}` as PluginToolbarButtonId;
      registerToolbarButton({
        id: buttonId,
        label: btn.label,
        iconId: btn.iconId,
        actionId: btn.actionId,
        priority: btn.priority ?? 3,
        pluginId: manifest.name,
      });
    }
    if (manifest.contributes.toolbarButtons.length > 0) {
      this.scheduleToolbarButtonsBroadcast(false);
    }

    for (const menuItem of manifest.contributes.menuItems) {
      registerPluginMenuItem(manifest.name, menuItem);
    }

    if (manifest.contributes.views.length > 0) {
      console.warn(
        `[PluginService] Plugin "${manifest.name}": contributes.views is not yet implemented and will be ignored`
      );
    }

    if (manifest.contributes.mcpServers.length > 0) {
      console.warn(
        `[PluginService] Plugin "${manifest.name}": contributes.mcpServers is not yet implemented and will be ignored`
      );
    }

    if (manifest.contributes.forgeProviders.length > 0) {
      registerForgeProviders(manifest.name, manifest.contributes.forgeProviders);
    }

    if (manifest.contributes.fileDecorationProviders.length > 0) {
      registerFileDecorationProviders(manifest.name, manifest.contributes.fileDecorationProviders);
    }

    // Insert the plugin into the registry BEFORE importing its main module so
    // synchronous host-API calls made during module evaluation (e.g., a plugin
    // that calls host.registerAction/registerHandler at import time) see the
    // plugin as loaded. Without this, `hasPlugin(pluginId)` returns false
    // inside the plugin's own init, and registerHandler/registerPluginAction
    // throw "Unknown plugin" even for a correctly loaded plugin.
    this.plugins.set(manifest.name, plugin);

    if (plugin.resolvedMain) {
      try {
        const mod = (await import(pathToFileURL(plugin.resolvedMain).href)) as {
          activate?: unknown;
        };
        if (typeof mod.activate === "function") {
          const activate = mod.activate as PluginActivate;
          const { host, revoke } = this.createHost(manifest.name);
          try {
            const cleanup = await this.runActivate(manifest.name, activate, host);
            if (typeof cleanup === "function") {
              this.cleanupMap.set(manifest.name, cleanup);
            }
          } finally {
            revoke();
          }
        }
        // Successful activation (or a main with no activate fn) clears any
        // diagnostic record left over from a prior failed attempt at the same
        // plugin id — relevant when initialize() is run twice against the
        // same service in tests, or in future hot-reload paths.
        this.pluginLoadErrors.delete(manifest.name);
      } catch (err) {
        const record = toPluginLoadErrorRecord(err);
        this.pluginLoadErrors.set(manifest.name, record);
        console.error(`[PluginService] Failed to load main entry for ${manifest.name}:`, err);
      }
    } else {
      this.pluginLoadErrors.delete(manifest.name);
    }

    return plugin;
  }

  private createHost(pluginId: string): { host: PluginHostApi; revoke: () => void } {
    let revoked = false;
    const host: PluginHostApi = {
      get pluginId() {
        return pluginId;
      },
      registerHandler: (channel, handler) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: registerHandler called after activate() returned or timed out`
          );
        }
        this.registerHandler(pluginId, channel, handler);
      },
      broadcastToRenderer: (channel, payload) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: broadcastToRenderer called after activate() returned or timed out`
          );
        }
        if (typeof channel !== "string" || channel.includes(":")) {
          throw new Error(
            `Plugin broadcast channel must be a string without colons: ${String(channel)}`
          );
        }
        broadcastToRenderer(`plugin:${pluginId}:${channel}`, payload);
      },
      getActiveWorktree: async () => {
        const snapshots = await this.fetchAllWorktreeSnapshots();
        const active = snapshots.find((s) => s.isCurrent === true);
        return active ? toPluginWorktreeSnapshot(active) : null;
      },
      getWorktrees: async () => {
        const snapshots = await this.fetchAllWorktreeSnapshots();
        return snapshots.map(toPluginWorktreeSnapshot);
      },
      onDidChangeActiveWorktree: (callback) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: onDidChangeActiveWorktree called after activate() returned or timed out`
          );
        }
        return this.subscribeWorktreeEvent(pluginId, "worktree-activated", async () => {
          if (!this.plugins.has(pluginId)) return;
          try {
            const snapshots = await this.fetchAllWorktreeSnapshots();
            // Re-check after the async fetch so a racing unloadPlugin()
            // doesn't fire the callback into a disposed plugin closure.
            if (!this.plugins.has(pluginId)) return;
            const active = snapshots.find((s) => s.isCurrent === true);
            callback(active ? toPluginWorktreeSnapshot(active) : null);
          } catch (err) {
            console.error(
              `[PluginService] onDidChangeActiveWorktree callback for "${pluginId}" failed:`,
              err
            );
          }
        });
      },
      onDidChangeWorktrees: (callback) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: onDidChangeWorktrees called after activate() returned or timed out`
          );
        }
        const emit = async (): Promise<void> => {
          if (!this.plugins.has(pluginId)) return;
          try {
            const snapshots = await this.fetchAllWorktreeSnapshots();
            if (!this.plugins.has(pluginId)) return;
            callback(snapshots.map(toPluginWorktreeSnapshot));
          } catch (err) {
            console.error(
              `[PluginService] onDidChangeWorktrees callback for "${pluginId}" failed:`,
              err
            );
          }
        };
        // Fires on both add/update and remove so plugins' cached lists stay
        // correct after deletions. Each subscription is tracked separately
        // so a single disposer stops both.
        const disposeUpdate = this.subscribeWorktreeEvent(pluginId, "worktree-update", emit);
        const disposeRemove = this.subscribeWorktreeEvent(pluginId, "worktree-removed", emit);
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          disposeUpdate();
          disposeRemove();
        };
      },
      registerForgeProvider: (descriptor, impl) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: registerForgeProvider called after activate() returned or timed out`
          );
        }
        if (!descriptor || typeof descriptor !== "object") {
          throw new Error(
            `Plugin "${pluginId}" registerForgeProvider: descriptor must be an object`
          );
        }
        if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
          throw new Error(
            `Plugin "${pluginId}" registerForgeProvider: descriptor.id must be a non-empty string`
          );
        }
        if (!impl || typeof impl !== "object") {
          throw new Error(`Plugin "${pluginId}" registerForgeProvider: impl must be an object`);
        }
        // The impl is keyed by the same `{pluginId}.{descriptor.id}` namespace
        // used by the eager descriptor table. Binding an impl whose id wasn't
        // declared in `contributes.forgeProviders` produces an orphaned entry —
        // unreachable through the routing table, since `listMatchingProviders`
        // walks descriptors first. Reject up front so the failure is loud.
        const contributionId = descriptor.id;
        const plugin = this.plugins.get(pluginId);
        const declared = plugin?.manifest.contributes.forgeProviders.some(
          (c) => c.id === contributionId
        );
        if (!declared) {
          throw new Error(
            `Plugin "${pluginId}" registerForgeProvider: descriptor.id "${contributionId}" is not declared in contributes.forgeProviders`
          );
        }

        registerForgeProviderImpl(pluginId, contributionId, impl);

        let disposed = false;
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          // Pass `impl` so a stale disposer (from a prior re-bind that was
          // overwritten via a second registerForgeProvider call on the same
          // id) cannot remove the currently-active impl by mistake — the
          // registry compares identities before deleting.
          unregisterForgeProviderImpl(pluginId, contributionId, impl);
          const list = this.pluginEventCleanups.get(pluginId);
          if (!list) return;
          const idx = list.indexOf(dispose);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.pluginEventCleanups.delete(pluginId);
        };

        let list = this.pluginEventCleanups.get(pluginId);
        if (!list) {
          list = [];
          this.pluginEventCleanups.set(pluginId, list);
        }
        list.push(dispose);
        return dispose;
      },
      registerFileDecorationProvider: (descriptor, impl) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: registerFileDecorationProvider called after activate() returned or timed out`
          );
        }
        if (!descriptor || typeof descriptor !== "object") {
          throw new Error(
            `Plugin "${pluginId}" registerFileDecorationProvider: descriptor must be an object`
          );
        }
        if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
          throw new Error(
            `Plugin "${pluginId}" registerFileDecorationProvider: descriptor.id must be a non-empty string`
          );
        }
        if (!impl || typeof impl !== "object" || typeof impl.provideDecorations !== "function") {
          throw new Error(
            `Plugin "${pluginId}" registerFileDecorationProvider: impl must expose provideDecorations()`
          );
        }
        // Reject ids not declared in `contributes.fileDecorationProviders` for
        // the same reason as forge providers: an undeclared id is unreachable
        // through the eager scope-routing table, so the binding would be a
        // silent orphan. Fail loud at registration instead.
        const contributionId = descriptor.id;
        const plugin = this.plugins.get(pluginId);
        const declared = plugin?.manifest.contributes.fileDecorationProviders.some(
          (c) => c.id === contributionId
        );
        if (!declared) {
          throw new Error(
            `Plugin "${pluginId}" registerFileDecorationProvider: descriptor.id "${contributionId}" is not declared in contributes.fileDecorationProviders`
          );
        }

        registerFileDecorationProviderImpl(pluginId, contributionId, impl);

        let disposed = false;
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          unregisterFileDecorationProviderImpl(pluginId, contributionId, impl);
          const list = this.pluginEventCleanups.get(pluginId);
          if (!list) return;
          const idx = list.indexOf(dispose);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.pluginEventCleanups.delete(pluginId);
        };

        let list = this.pluginEventCleanups.get(pluginId);
        if (!list) {
          list = [];
          this.pluginEventCleanups.set(pluginId, list);
        }
        list.push(dispose);
        return dispose;
      },
      // NOT revoke-guarded: called from the plugin's own post-activation
      // subscription callbacks (worktree changes, polling timers). The
      // liveness guard is plugin membership, not the activation window — once
      // the plugin unloads this becomes a silent no-op.
      invalidateFileDecorations: (scope, paths) => {
        if (!this.plugins.has(pluginId)) return;
        if (typeof scope !== "string" || scope.length === 0) {
          throw new Error(
            `Plugin "${pluginId}" invalidateFileDecorations: scope must be a non-empty string`
          );
        }
        // A plugin may only invalidate scopes it actually declared in
        // `contributes.fileDecorationProviders`. Without this a plugin could
        // force unrelated renderer views to re-pull. Mirrors the
        // registration-time declared-id guard so the manifest stays the
        // single source of truth for what a plugin owns.
        const declaredScopes = this.plugins
          .get(pluginId)
          ?.manifest.contributes.fileDecorationProviders.flatMap((c) => c.scopes);
        if (
          !declaredScopes ||
          !declaredScopes.some((pattern) => scopeMatchesPattern(scope, pattern))
        ) {
          throw new Error(
            `Plugin "${pluginId}" invalidateFileDecorations: scope "${scope}" is not covered by any declared contributes.fileDecorationProviders[].scopes`
          );
        }
        const narrowed =
          Array.isArray(paths) && paths.length > 0
            ? paths.filter((p): p is string => typeof p === "string" && p.length > 0)
            : undefined;
        broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
          name: "plugin:decorations-changed",
          payload: { scope, ...(narrowed && narrowed.length > 0 ? { paths: narrowed } : {}) },
        });
      },
    };
    return {
      host,
      revoke: () => {
        revoked = true;
      },
    };
  }

  private async fetchAllWorktreeSnapshots(): Promise<WorktreeSnapshot[]> {
    const client = this.workspaceClient;
    if (!client) return [];
    try {
      return await client.getAllStatesAsync();
    } catch (err) {
      console.error("[PluginService] Failed to fetch worktree snapshots:", err);
      return [];
    }
  }

  /**
   * Register a listener on WorkspaceClient for the given event and track it
   * against the plugin so `unloadPlugin()` can dispose it. Returns a disposer
   * that removes just this subscription; safe to call multiple times.
   *
   * If WorkspaceClient is not yet wired (early plugin activate during boot),
   * the subscription is queued in `pendingWorktreeSubs` and replayed when
   * `setWorkspaceClient()` is later called. The returned disposer handles
   * both the queued and the live state.
   */
  private subscribeWorktreeEvent(
    pluginId: string,
    event: WorkspaceWorktreeEvent,
    handler: () => void
  ): () => void {
    let boundClient: WorkspaceClient | null = null;
    let pendingRecord: (typeof this.pendingWorktreeSubs)[number] | null = null;
    let disposed = false;

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      if (boundClient) {
        boundClient.off(event, handler);
      } else if (pendingRecord) {
        const idx = this.pendingWorktreeSubs.indexOf(pendingRecord);
        if (idx >= 0) this.pendingWorktreeSubs.splice(idx, 1);
      }
      const list = this.pluginEventCleanups.get(pluginId);
      if (!list) return;
      const idx = list.indexOf(dispose);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.pluginEventCleanups.delete(pluginId);
    };

    let list = this.pluginEventCleanups.get(pluginId);
    if (!list) {
      list = [];
      this.pluginEventCleanups.set(pluginId, list);
    }
    list.push(dispose);

    const client = this.workspaceClient;
    if (client) {
      client.on(event, handler);
      boundClient = client;
    } else {
      pendingRecord = {
        pluginId,
        event,
        handler,
        activate: (c: WorkspaceClient) => {
          if (disposed) return;
          c.on(event, handler);
          boundClient = c;
          pendingRecord = null;
        },
      };
      this.pendingWorktreeSubs.push(pendingRecord);
    }

    return dispose;
  }

  private async runActivate(
    pluginId: string,
    activate: PluginActivate,
    host: PluginHostApi
  ): Promise<void | (() => void)> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => activate(host)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(`Plugin "${pluginId}" activate() timed out after ${ACTIVATE_TIMEOUT_MS}ms`)
            );
          }, ACTIVATE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private resolveEntryPath(pluginDir: string, relativePath: string): string | null {
    const resolved = path.resolve(pluginDir, relativePath);
    const normalizedDir = path.normalize(pluginDir) + path.sep;
    if (!resolved.startsWith(normalizedDir) && resolved !== path.normalize(pluginDir)) {
      return null;
    }
    return resolved;
  }

  hasPlugin(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  registerHandler(pluginId: string, channel: string, handler: PluginIpcHandler): void {
    if (!this.plugins.has(pluginId)) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }
    if (channel.includes(":")) {
      throw new Error(`Plugin channel must not contain colons: ${channel}`);
    }
    if (typeof handler !== "function") {
      throw new Error(`Plugin handler must be a function, got ${typeof handler}`);
    }
    const key = `${pluginId}:${channel}`;
    this.handlerMap.set(key, handler);
  }

  async dispatchHandler(
    pluginId: string,
    channel: string,
    ctx: PluginIpcContext,
    args: unknown[]
  ): Promise<unknown> {
    const key = `${pluginId}:${channel}`;
    const handler = this.handlerMap.get(key);
    if (!handler) {
      throw new Error(`No plugin handler registered for ${key}`);
    }
    try {
      return await handler(ctx, ...args);
    } catch (err) {
      // Contain at the boundary so a throwing plugin handler can't propagate
      // up through `ipcMain.handle` as an unhandled rejection in the main
      // process. The error still surfaces to the renderer (we rethrow after
      // logging) — the renderer-side wrapping in `usePluginActions` turns
      // that rejection into a user-facing toast.
      // TODO(#9232): emit PluginActionAuditRecord to the audit pipeline.
      console.error(`[PluginService] Handler "${key}" threw:`, err);
      throw err;
    }
  }

  removeHandlers(pluginId: string): void {
    const prefix = `${pluginId}:`;
    for (const key of [...this.handlerMap.keys()]) {
      if (key.startsWith(prefix)) {
        this.handlerMap.delete(key);
      }
    }
  }

  unloadPlugin(pluginId: string): void {
    if (!this.plugins.has(pluginId)) return;
    const cleanup = this.cleanupMap.get(pluginId);
    if (cleanup) {
      try {
        cleanup();
      } catch (err) {
        console.error(`[PluginService] Cleanup callback for "${pluginId}" threw:`, err);
      }
      this.cleanupMap.delete(pluginId);
    }
    this.flushPluginEventCleanups(pluginId);

    // Capture the unloaded plugin's declared decoration scopes before clearing
    // the registry so we can tell any renderer that was showing them to
    // re-pull (it will now resolve no impl and clear). Without this, stale
    // decorations from a runtime-unloaded plugin would linger until the next
    // scope/path change or remount.
    const decorationScopes = this.plugins
      .get(pluginId)
      ?.manifest.contributes.fileDecorationProviders.flatMap((c) => c.scopes);

    // Each step is wrapped individually so a throwing registry call can't
    // strand later cleanup steps — partial-unload leaks would re-surface as
    // duplicate-id errors on the next load. Disposer throws are warnings
    // (the cleanup is best-effort), not user-visible errors.
    runUnloadStep(pluginId, "removeHandlers", () => this.removeHandlers(pluginId));
    runUnloadStep(pluginId, "unregisterPluginActions", () =>
      this.unregisterPluginActions(pluginId)
    );
    runUnloadStep(pluginId, "unregisterPluginMenuItems", () => unregisterPluginMenuItems(pluginId));
    runUnloadStep(pluginId, "unregisterPluginToolbarButtons", () => {
      unregisterPluginToolbarButtons(pluginId);
      this.scheduleToolbarButtonsBroadcast(true);
    });
    runUnloadStep(pluginId, "unregisterPluginPanelKinds", () =>
      unregisterPluginPanelKinds(pluginId)
    );
    runUnloadStep(pluginId, "unregisterForgeProviders", () => {
      unregisterForgeProviders(pluginId);
      // Belt-and-suspenders: per-provider disposers pushed onto
      // pluginEventCleanups by host.registerForgeProvider have already fired
      // in flushPluginEventCleanups() above, but a direct bulk-clear guards
      // against any impl entry that wasn't tracked through that path (e.g.
      // a future re-bind that didn't refresh the disposer slot). The bulk
      // call is idempotent — already-cleared keys are silent no-ops.
      unregisterForgeProviderImpls(pluginId);
    });
    runUnloadStep(pluginId, "unregisterFileDecorationProviders", () => {
      unregisterFileDecorationProviders(pluginId);
      unregisterFileDecorationProviderImpls(pluginId);
    });

    this.plugins.delete(pluginId);
    this.pluginLoadErrors.delete(pluginId);

    if (decorationScopes && decorationScopes.length > 0) {
      runUnloadStep(pluginId, "broadcastDecorationsChanged", () => {
        for (const scope of new Set(decorationScopes)) {
          broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
            name: "plugin:decorations-changed",
            payload: { scope },
          });
        }
      });
    }
  }

  private flushPluginEventCleanups(pluginId: string): void {
    const list = this.pluginEventCleanups.get(pluginId);
    if (!list || list.length === 0) {
      this.pluginEventCleanups.delete(pluginId);
      return;
    }
    // Snapshot & clear before invoking so each dispose() call (which mutates
    // the list via splice) doesn't interfere with iteration.
    this.pluginEventCleanups.delete(pluginId);
    for (const dispose of [...list]) {
      try {
        dispose();
      } catch (err) {
        console.error(`[PluginService] Event cleanup for "${pluginId}" threw during unload:`, err);
      }
    }
  }

  listPlugins(): LoadedPluginInfo[] {
    return Array.from(this.plugins.values()).map((p) => ({
      manifest: p.manifest,
      dir: p.dir,
      loadedAt: p.loadedAt,
      isBuiltin: p.isBuiltin,
    }));
  }

  /**
   * Most recent activation error for a plugin id, or `undefined` if the last
   * load succeeded (or the plugin has never been loaded). Cleared on unload
   * and on a subsequent successful activation. Intended for the Settings
   * diagnostic surface (F19) and #9271's provenance store — until that lands
   * the record stays in-memory and does not survive a host restart.
   */
  getPluginLoadError(pluginId: string): PluginLoadErrorRecord | undefined {
    return this.pluginLoadErrors.get(pluginId);
  }

  /**
   * Register a runtime-contributed action for a loaded plugin.
   * Validates id format, namespace ownership, and rejects "restricted" danger.
   * Broadcasts the full action list to all renderers so windows stay in sync.
   */
  registerPluginAction(pluginId: string, contribution: PluginActionContribution): void {
    if (!this.plugins.has(pluginId)) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }
    if (!contribution || typeof contribution !== "object") {
      throw new Error("Plugin action contribution must be an object");
    }
    const { id, title, description, category, kind, danger } = contribution;
    if (typeof id !== "string" || !PLUGIN_ACTION_ID_RE.test(id)) {
      throw new Error(
        `Plugin action id "${id}" is invalid. Expected "{pluginId}.{actionId}" (lowercase start, alphanumerics, dot/dash/underscore).`
      );
    }
    if (!id.startsWith(`${pluginId}.`)) {
      throw new Error(
        `Plugin "${pluginId}" cannot register action "${id}": id must be prefixed with the plugin's own id.`
      );
    }
    if (typeof title !== "string" || !title.trim()) {
      throw new Error(`Plugin action "${id}" must have a non-empty title`);
    }
    if (typeof description !== "string") {
      throw new Error(`Plugin action "${id}" must have a string description`);
    }
    if (typeof category !== "string" || !category.trim()) {
      throw new Error(`Plugin action "${id}" must have a non-empty category`);
    }
    if (!PLUGIN_ACTION_KINDS.has(kind as string)) {
      throw new Error(`Plugin action "${id}" has invalid kind "${kind}"`);
    }
    if (!PLUGIN_ACTION_DANGERS.has(danger as string)) {
      throw new Error(
        `Plugin action "${id}" has invalid danger "${danger}". Plugins may only register "safe" or "confirm" actions.`
      );
    }
    if (this.pluginActions.has(id)) {
      throw new Error(`Plugin action "${id}" is already registered`);
    }

    // Host-authoritative danger: the plugin's self-reported `danger` is
    // advisory. Raise it to "confirm" (never lower) when the plugin holds a
    // high-risk permission, so a plugin can't declare "safe" on a destructive
    // action to slip past the renderer's confirm/MRU/repeatLast gates.
    const manifestPermissions = this.plugins.get(pluginId)?.manifest.permissions ?? [];
    const hasHighRiskPermission = manifestPermissions.some((p) =>
      CONFIRM_TRIGGERING_PERMISSIONS.has(p)
    );
    const effectiveDanger: "safe" | "confirm" =
      danger === "confirm" || hasHighRiskPermission ? "confirm" : "safe";

    const descriptor: PluginActionDescriptor = {
      pluginId,
      id,
      title,
      description,
      category,
      kind,
      danger,
      effectiveDanger,
      keywords: Array.isArray(contribution.keywords) ? [...contribution.keywords] : undefined,
      inputSchema:
        contribution.inputSchema && typeof contribution.inputSchema === "object"
          ? { ...contribution.inputSchema }
          : undefined,
    };

    this.pluginActions.set(id, descriptor);
    let owners = this.pluginActionOwners.get(pluginId);
    if (!owners) {
      owners = new Set();
      this.pluginActionOwners.set(pluginId, owners);
    }
    owners.add(id);

    this.broadcastPluginActions();
  }

  /** Remove a single plugin-registered action. Silent no-op if unknown. */
  unregisterPluginAction(pluginId: string, actionId: string): void {
    const descriptor = this.pluginActions.get(actionId);
    if (!descriptor || descriptor.pluginId !== pluginId) return;

    this.pluginActions.delete(actionId);
    const owners = this.pluginActionOwners.get(pluginId);
    if (owners) {
      owners.delete(actionId);
      if (owners.size === 0) this.pluginActionOwners.delete(pluginId);
    }

    this.broadcastPluginActions();
  }

  /** Bulk cleanup when a plugin is unloaded. Emits a single broadcast. */
  unregisterPluginActions(pluginId: string): void {
    const owners = this.pluginActionOwners.get(pluginId);
    if (!owners || owners.size === 0) return;

    for (const id of owners) {
      this.pluginActions.delete(id);
    }
    this.pluginActionOwners.delete(pluginId);

    this.broadcastPluginActions();
  }

  /** Flattened snapshot of all plugin-registered actions (for renderer pull-on-mount). */
  listPluginActions(): PluginActionDescriptor[] {
    return Array.from(this.pluginActions.values());
  }

  private broadcastPluginActions(): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:actions-changed",
      payload: { actions: this.listPluginActions() },
    });
  }

  /**
   * Coalesce multiple registry mutations in the same microtask into a single
   * broadcast. `unregisterPluginPanelKinds` fires the unregister listener once
   * per removed kind; without this batching a plugin contributing N panels
   * would trigger N broadcasts on unload, each carrying the same shrinking
   * snapshot.
   */
  private schedulePanelKindsBroadcast(): void {
    if (this.disposed) return;
    if (this.panelKindsBroadcastPending) return;
    this.panelKindsBroadcastPending = true;
    queueMicrotask(() => {
      this.panelKindsBroadcastPending = false;
      // Disposal between scheduling and the microtask draining must not leak
      // a phantom broadcast — particularly important for test isolation where
      // a service from one test could otherwise emit into the next.
      if (this.disposed) return;
      this.broadcastPluginPanelKinds();
    });
  }

  private broadcastPluginPanelKinds(): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:panel-kinds-changed",
      payload: { kinds: getPluginPanelKinds() },
    });
  }

  /**
   * Coalesce toolbar-button registry mutations the same way panel kinds are
   * batched (see {@link schedulePanelKindsBroadcast}). Toolbar buttons are only
   * ever mutated from `loadPlugin()` / `unloadPlugin()`, so the two call sites
   * invoke this directly rather than via registry event listeners.
   */
  private scheduleToolbarButtonsBroadcast(complete: boolean): void {
    if (this.disposed) return;
    if (complete) this.toolbarButtonsBroadcastComplete = true;
    if (this.toolbarButtonsBroadcastPending) return;
    this.toolbarButtonsBroadcastPending = true;
    queueMicrotask(() => {
      this.toolbarButtonsBroadcastPending = false;
      const complete = this.toolbarButtonsBroadcastComplete;
      this.toolbarButtonsBroadcastComplete = false;
      if (this.disposed) return;
      this.broadcastPluginToolbarButtons(complete);
    });
  }

  private broadcastPluginToolbarButtons(complete: boolean): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:toolbar-buttons-changed",
      payload: { buttons: getAllPluginToolbarButtonConfigs(), complete },
    });
  }
}

export const pluginService = new PluginService();
