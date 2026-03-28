import fs from "fs/promises";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import { PluginManifestSchema } from "../schemas/plugin.js";
import type { PluginManifest } from "../../shared/types/plugin.js";
import { registerPanelKind } from "../../shared/config/panelKindRegistry.js";
import type { LoadedPluginInfo } from "../../shared/types/plugin.js";

interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  resolvedMain?: string;
  resolvedRenderer?: string;
  loadedAt: number;
}

export class PluginService {
  private plugins = new Map<string, LoadedPlugin>();
  private initialized = false;
  private pluginsRoot: string;

  constructor(pluginsRoot?: string) {
    this.pluginsRoot = pluginsRoot ?? path.join(os.homedir(), ".canopy", "plugins");
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

    if (manifest.renderer) {
      const resolved = this.resolveEntryPath(pluginDir, manifest.renderer);
      if (resolved) {
        plugin.resolvedRenderer = resolved;
      } else {
        console.warn(
          `[PluginService] Plugin ${manifest.name}: renderer entry path escapes plugin directory, ignoring`
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

  listPlugins(): LoadedPluginInfo[] {
    return Array.from(this.plugins.values()).map((p) => ({
      manifest: p.manifest,
      dir: p.dir,
      resolvedRenderer: p.resolvedRenderer,
      loadedAt: p.loadedAt,
    }));
  }
}

export const pluginService = new PluginService();
