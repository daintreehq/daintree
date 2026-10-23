/**
 * Finds an installed plugin's declared Element Picker resolver entry, for a
 * plugin resolver host to import. The path comes from the registry's record of
 * a provider the host vetted, never from a request, and is contained in the
 * plugin's own directory before the host is told to load it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizePluginAssetRef } from "../../../shared/config/pluginManifestAssets.js";
import {
  getElementPickerProviderPluginDir,
  isElementPickerProviderCurrent,
} from "../elementPickerProviderRegistry.js";
import type { RegisteredElementPickerProvider } from "../../../shared/elementPicker/providers.js";
import { isOutsidePluginDir } from "../plugin/pluginManifestAssetFiles.js";

/**
 * A resolver bundles whatever it parses with, so this is far past the guest's
 * ceiling; it exists to refuse something that is plainly not a resolver.
 */
export const MAX_PLUGIN_RESOLVER_ENTRY_BYTES = 16 * 1024 * 1024;

/**
 * The resolver entry's `file:` URL, or null when the provider is no longer
 * registered, declares none, or its entry is missing, escapes the plugin
 * directory, is not a regular file, or is empty or over
 * {@link MAX_PLUGIN_RESOLVER_ENTRY_BYTES}. The caller re-checks the provider
 * is still current after this settles.
 */
export async function locatePluginResolverEntry(
  provider: RegisteredElementPickerProvider
): Promise<string | null> {
  if (provider.resolverEntry === undefined || !isElementPickerProviderCurrent(provider)) {
    return null;
  }
  const pluginDir = getElementPickerProviderPluginDir(provider);
  if (pluginDir === undefined) return null;
  try {
    const realDir = await fs.realpath(pluginDir);
    const real = await fs.realpath(
      path.join(realDir, normalizePluginAssetRef(provider.resolverEntry))
    );
    if (isOutsidePluginDir(path.relative(realDir, real))) return null;
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PLUGIN_RESOLVER_ENTRY_BYTES) {
      return null;
    }
    return pathToFileURL(real).href;
  } catch {
    return null;
  }
}
