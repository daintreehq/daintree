/**
 * Reads an installed plugin's declared Element Picker guest entry. Separate
 * from the core catalog on purpose: that one is a fixed list the app builds,
 * this one resolves a path a manifest declared. What keeps it safe is where the
 * path comes from — the registry's record of a provider the host vetted, never
 * a renderer or a page — and that the file is contained in the plugin's own
 * directory before a byte of it is read.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { normalizePluginAssetRef } from "../../../shared/config/pluginManifestAssets.js";
import {
  getElementPickerProviderPluginDir,
  isElementPickerProviderCurrent,
} from "../elementPickerProviderRegistry.js";
import type { RegisteredElementPickerProvider } from "../../../shared/elementPicker/providers.js";
import { AppError } from "../../utils/errorTypes.js";
import { isOutsidePluginDir } from "../plugin/pluginManifestAssetFiles.js";

/** The picker's message ceiling; an extractor larger than a reply it may send is not one we load. */
export const MAX_PLUGIN_GUEST_ASSET_BYTES = 256 * 1024;

function refuse(provider: RegisteredElementPickerProvider, message: string): AppError {
  return new AppError({
    code: "INTERNAL",
    message,
    context: { provider: provider.id },
  });
}

/**
 * Resolves to the extractor's source, or throws when the provider is no longer
 * registered, its entry escapes the plugin directory, is not a regular file, or
 * is empty or over {@link MAX_PLUGIN_GUEST_ASSET_BYTES}. The caller re-checks
 * the provider is still current after this returns.
 */
export async function loadPluginGuestAsset(
  provider: RegisteredElementPickerProvider
): Promise<string> {
  if (!isElementPickerProviderCurrent(provider)) {
    throw refuse(provider, "The Element Picker provider is no longer registered");
  }
  const pluginDir = getElementPickerProviderPluginDir(provider);
  if (pluginDir === undefined) {
    throw refuse(provider, "The Element Picker provider has no installed plugin to read from");
  }
  const relative = normalizePluginAssetRef(provider.guestEntry);
  let realDir: string;
  let real: string;
  try {
    realDir = await fs.realpath(pluginDir);
    real = await fs.realpath(path.join(realDir, relative));
  } catch (cause) {
    throw new AppError({
      code: "INTERNAL",
      message: "The Element Picker provider's guest entry is missing",
      context: { provider: provider.id },
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (isOutsidePluginDir(path.relative(realDir, real))) {
    throw refuse(provider, "The Element Picker provider's guest entry resolves outside its plugin");
  }
  const handle = await fs.open(real, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw refuse(provider, "The Element Picker provider's guest entry is not a file");
    if (stat.size === 0)
      throw refuse(provider, "The Element Picker provider's guest entry is empty");
    if (stat.size > MAX_PLUGIN_GUEST_ASSET_BYTES) {
      throw new AppError({
        code: "PAYLOAD_TOO_LARGE",
        message: "The Element Picker provider's guest entry exceeds its ceiling",
        context: { provider: provider.id },
      });
    }
    // One byte past the stat, so a file that grew after it still trips the ceiling.
    const buffer = Buffer.alloc(MAX_PLUGIN_GUEST_ASSET_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0 || bytesRead > MAX_PLUGIN_GUEST_ASSET_BYTES) {
      throw refuse(provider, "The Element Picker provider's guest entry changed while it was read");
    }
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}
