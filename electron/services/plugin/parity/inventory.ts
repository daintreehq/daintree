import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LoadedPluginInfo, PluginSettingsUiValues } from "../../../../shared/types/plugin.js";
import { PLUGIN_PLATFORMS } from "../../../schemas/plugin.js";

export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number];

/** One installed plugin, as a machine reports it to compare against another. */
export interface PluginInventoryEntry {
  pluginId: string;
  displayName: string;
  version: string;
  /** The declared `engines.daintree` range, or null. */
  engine: string | null;
  /** The operating systems it has a build for; null when it runs on any. */
  platforms: PluginPlatform[] | null;
  remoteUnsupported: boolean;
  /** Refused at load on this machine by the plugin blocklist. */
  blocklisted: boolean;
  /** Ids of its user-scoped secret settings that hold no value on this machine. */
  missingSecrets: string[];
}

export interface PluginInventory {
  /** The Daintree version this machine runs. */
  appVersion: string;
  /** `process.platform` of this machine. */
  platform: string;
  plugins: PluginInventoryEntry[];
}

const id = z.string().min(1).max(256);
const short = z.string().max(256);

export const PluginInventorySchema = z.object({
  appVersion: short,
  platform: short,
  plugins: z
    .array(
      z.object({
        pluginId: id,
        displayName: short,
        version: short,
        engine: short.nullable(),
        platforms: z.array(z.enum(PLUGIN_PLATFORMS)).max(PLUGIN_PLATFORMS.length).nullable(),
        remoteUnsupported: z.boolean(),
        blocklisted: z.boolean(),
        missingSecrets: z.array(id).max(64),
      })
    )
    .max(1024),
});

export interface PluginInventorySource {
  listPlugins(): LoadedPluginInfo[];
  getSettingValuesForUi(
    pluginId: string,
    scope: "user",
    projectId: null
  ): Promise<PluginSettingsUiValues>;
}

export interface BuildInventoryOptions {
  appVersion: string;
  platform: string;
  /** Read which secrets are set: the host answers this, the Shell doesn't need it. */
  includeSecrets?: boolean;
  /** The OSes a plugin's native modules are built for; defaults to reading them from disk. */
  detectPlatforms?: (dir: string) => Promise<PluginPlatform[] | null>;
}

const MAX_SCAN_ENTRIES = 4000;
const MAX_SCAN_DEPTH = 8;
const MAX_NATIVE_MODULES = 64;

function platformOfBinaryHeader(header: Buffer): PluginPlatform | null {
  if (header.length < 4) return null;
  if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    return "linux";
  }
  if (header[0] === 0x4d && header[1] === 0x5a) return "win32";
  const magic = header.readUInt32BE(0);
  // Mach-O thin (32/64-bit, either byte order) and universal binaries.
  if (
    magic === 0xfeedface ||
    magic === 0xfeedfacf ||
    magic === 0xcefaedfe ||
    magic === 0xcffaedfe ||
    magic === 0xcafebabe ||
    magic === 0xbebafeca
  ) {
    return "darwin";
  }
  return null;
}

/**
 * The OSes a plugin's native modules (`*.node`) are built for, read from each
 * binary's header, or null when it ships none. A package whose native code is
 * all one OS's can't load anywhere else, whatever its manifest omits.
 */
export async function detectNativeModulePlatforms(dir: string): Promise<PluginPlatform[] | null> {
  const found = new Set<PluginPlatform>();
  let seen = 0;
  let modules = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || seen >= MAX_SCAN_ENTRIES || modules >= MAX_NATIVE_MODULES) return;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++seen > MAX_SCAN_ENTRIES || modules >= MAX_NATIVE_MODULES) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".node")) {
        modules++;
        const handle = await fs.open(full, "r").catch(() => null);
        if (!handle) continue;
        try {
          const header = Buffer.alloc(4);
          const { bytesRead } = await handle.read(header, 0, 4, 0);
          const platform = platformOfBinaryHeader(header.subarray(0, bytesRead));
          if (platform) found.add(platform);
        } finally {
          await handle.close().catch(() => {});
        }
      }
    }
  };
  await walk(dir, 0);
  return found.size > 0 ? PLUGIN_PLATFORMS.filter((platform) => found.has(platform)) : null;
}

function declaredPlatforms(info: LoadedPluginInfo): PluginPlatform[] | null {
  const declared = info.manifest.platforms;
  if (!declared) return null;
  const known = new Set<string>(PLUGIN_PLATFORMS);
  const list = declared.filter((entry) => known.has(entry));
  return list.length > 0 ? list : null;
}

/**
 * This machine's installed plugins, for comparing with another machine's.
 * Built-in plugins ship with the build, which both machines share, and a
 * project's own plugins travel with its repository, so neither is listed.
 */
export async function buildPluginInventory(
  source: PluginInventorySource,
  options: BuildInventoryOptions
): Promise<PluginInventory> {
  const detect = options.detectPlatforms ?? detectNativeModulePlatforms;
  const seen = new Set<string>();
  const plugins: PluginInventoryEntry[] = [];
  for (const info of source.listPlugins()) {
    if (info.isBuiltin || info.origin !== "global" || seen.has(info.instanceId)) continue;
    seen.add(info.instanceId);
    const manifest = info.manifest;
    let missingSecrets: string[] = [];
    if (options.includeSecrets && !info.blocklisted) {
      const declared = (manifest.contributes.settings ?? [])
        .filter(
          (setting) =>
            (setting.type === "secret" || setting.secret === true) &&
            (setting.scope ?? "user") === "user"
        )
        .map((setting) => setting.id);
      if (declared.length > 0) {
        const values = await source
          .getSettingValuesForUi(info.instanceId, "user", null)
          .catch(() => null);
        const set = new Set(values?.secretsSet ?? []);
        missingSecrets = values ? declared.filter((settingId) => !set.has(settingId)) : [];
      }
    }
    plugins.push({
      pluginId: info.instanceId,
      displayName: manifest.displayName?.trim() || manifest.name,
      version: manifest.version,
      engine: manifest.engines?.daintree ?? null,
      platforms: declaredPlatforms(info) ?? (await detect(info.dir).catch(() => null)),
      remoteUnsupported: manifest.remote === "unsupported",
      blocklisted: info.blocklisted === true,
      missingSecrets,
    });
  }
  return { appVersion: options.appVersion, platform: options.platform, plugins };
}
