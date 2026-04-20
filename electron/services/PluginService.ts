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
} from "../../shared/types/plugin.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import { toPluginWorktreeSnapshot } from "../../shared/utils/pluginWorktreeSnapshot.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import {
  registerPanelKind,
  unregisterPluginPanelKinds,
} from "../../shared/config/panelKindRegistry.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
} from "../../shared/config/toolbarButtonRegistry.js";
import { registerPluginMenuItem, unregisterPluginMenuItems } from "./pluginMenuRegistry.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import type { LoadedPluginInfo } from "../../shared/types/plugin.js";
import type { PluginToolbarButtonId } from "../../shared/types/toolbar.js";

/** Plugin action IDs must be `{pluginId}.{actionId}`. Built-in IDs use colons, so the formats cannot collide. */
const PLUGIN_ACTION_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;

const PLUGIN_ACTION_KINDS = new Set(["command", "query"]);
const PLUGIN_ACTION_DANGERS = new Set(["safe", "confirm"]);

interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  resolvedMain?: string;
  loadedAt: number;
}

const ACTIVATE_TIMEOUT_MS = 5000;

type WorkspaceWorktreeEvent = "worktree-update" | "worktree-activated" | "worktree-removed";

export class PluginService {
  private plugins = new Map<string, LoadedPlugin>();
  private handlerMap = new Map<string, PluginIpcHandler>();
  private cleanupMap = new Map<string, () => void>();
  private pluginActions = new Map<string, PluginActionDescriptor>();
  private pluginActionOwners = new Map<string, Set<string>>();
  private pluginEventCleanups = new Map<string, Array<() => void>>();
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
  private pluginsRoot: string;
  private appVersion: string;

  constructor(pluginsRoot?: string, appVersion?: string) {
    this.pluginsRoot = pluginsRoot ?? path.join(os.homedir(), ".daintree", "plugins");
    this.appVersion = appVersion ?? app.getVersion();
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

    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(this.pluginsRoot, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.log("[PluginService] No plugins directory found, skipping");
        this.initialized = true;
        return;
      }
      throw err;
    }

    const pluginDirs = entries.filter((e) => e.isDirectory());
    const results = await Promise.allSettled(pluginDirs.map((d) => this.loadPlugin(d.name)));

    let loaded = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        loaded++;
      }
    }

    this.initialized = true;
    console.log(`[PluginService] Loaded ${loaded} plugin(s) from ${this.pluginsRoot}`);
  }

  private async loadPlugin(dirName: string): Promise<LoadedPlugin | null> {
    const pluginDir = path.join(this.pluginsRoot, dirName);
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

    if (this.plugins.has(manifest.name)) {
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
      } catch (err) {
        console.error(`[PluginService] Failed to load main entry for ${manifest.name}:`, err);
      }
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
    return await handler(ctx, ...args);
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
    this.removeHandlers(pluginId);
    this.unregisterPluginActions(pluginId);
    unregisterPluginMenuItems(pluginId);
    unregisterPluginToolbarButtons(pluginId);
    unregisterPluginPanelKinds(pluginId);
    this.plugins.delete(pluginId);
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
    }));
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

    const descriptor: PluginActionDescriptor = {
      pluginId,
      id,
      title,
      description,
      category,
      kind,
      danger,
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
    broadcastToRenderer(CHANNELS.PLUGIN_ACTIONS_CHANGED, {
      actions: this.listPluginActions(),
    });
  }
}

export const pluginService = new PluginService();
