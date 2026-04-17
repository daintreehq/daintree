import fs from "fs/promises";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import { app } from "electron";
import * as semver from "semver";
import { PluginManifestSchema } from "../schemas/plugin.js";
import type { PluginManifest, PluginIpcHandler } from "../../shared/types/plugin.js";
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

interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  resolvedMain?: string;
  loadedAt: number;
}

export class PluginService {
  private plugins = new Map<string, LoadedPlugin>();
  private handlerMap = new Map<string, PluginIpcHandler>();
  private initialized = false;
  private pluginsRoot: string;
  private appVersion: string;

  constructor(pluginsRoot?: string, appVersion?: string) {
    this.pluginsRoot = pluginsRoot ?? path.join(os.homedir(), ".daintree", "plugins");
    this.appVersion = appVersion ?? app.getVersion();
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

    if (manifest.renderer) {
      console.warn(
        `[PluginService] Plugin "${manifest.name}" uses deprecated 'renderer' field. This field is no longer supported and will be ignored. Daintree plugins use main process entry points only; renderer-side plugins are not supported.`
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

    if (plugin.resolvedMain) {
      try {
        await import(pathToFileURL(plugin.resolvedMain).href);
      } catch (err) {
        console.error(`[PluginService] Failed to load main entry for ${manifest.name}:`, err);
      }
    }

    if (this.plugins.has(manifest.name)) {
      console.warn(
        `[PluginService] Duplicate plugin name "${manifest.name}" in ${dirName}, overwriting previous`
      );
    }
    this.plugins.set(manifest.name, plugin);
    return plugin;
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

  async dispatchHandler(pluginId: string, channel: string, args: unknown[]): Promise<unknown> {
    const key = `${pluginId}:${channel}`;
    const handler = this.handlerMap.get(key);
    if (!handler) {
      throw new Error(`No plugin handler registered for ${key}`);
    }
    return await handler(...args);
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
    this.removeHandlers(pluginId);
    unregisterPluginMenuItems(pluginId);
    unregisterPluginToolbarButtons(pluginId);
    unregisterPluginPanelKinds(pluginId);
    this.plugins.delete(pluginId);
  }

  listPlugins(): LoadedPluginInfo[] {
    return Array.from(this.plugins.values()).map((p) => ({
      manifest: p.manifest,
      dir: p.dir,
      loadedAt: p.loadedAt,
    }));
  }
}

export const pluginService = new PluginService();
