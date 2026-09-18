/**
 * Registers one site-preview guest adapter per `contributes.guestAdapters`
 * entry declared by a built-in plugin.
 *
 * The host cannot import plugin code, and it no longer needs to: the manifest is
 * the declaration, the asset path is derived from the adapter id
 * (`guestAdapterAssets.ts`), and the bodies are app assets this build emitted.
 * Adding a second built-in guest runtime is a manifest edit, not an edit here.
 *
 * Registration happens at startup rather than in the owning plugin's
 * activation because the bridge must be able to resolve a binding whether or
 * not that plugin's renderer view has ever been loaded.
 */

import { app } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { registerGuestAdapter } from "./guestAdapters.js";
import { listBuiltinGuestAdapters } from "./guestAdapterAssets.js";

/**
 * The app-bundled built-in plugins directory, resolved at call time because
 * `app.getAppPath()` is not valid at module evaluation.
 *
 * Mirrors `PluginService.getBuiltinDir` — the same single path serves both
 * modes: it is the repo's `dist-electron/` in dev and `app.asar/dist-electron/`
 * when packaged, which Electron's fs patch reads straight off disk.
 * `guestAdapterAssets.test.ts` pins the two resolutions together.
 */
export function resolveBuiltinPluginsDir(): string | null {
  try {
    if (typeof app?.getAppPath !== "function") return null;
    return path.join(app.getAppPath(), "dist-electron", "plugins", "builtin");
  } catch (err) {
    console.warn("[SitePreview] Failed to resolve built-in plugins directory:", err);
    return null;
  }
}

/**
 * Returns a single disposer covering every adapter registered, so a handler's
 * teardown leaves none behind.
 */
export function registerBuiltinGuestAdapters(): () => void {
  const pluginsRoot = resolveBuiltinPluginsDir();
  if (pluginsRoot === null) return () => {};

  // A packaged asset cannot change under the running app. In dev the esbuild
  // watcher rewrites it without restarting Electron, so a cached body would pin
  // whatever was on disk at the first bind for the rest of the session.
  const cache = app.isPackaged === true;

  const disposers = listBuiltinGuestAdapters(pluginsRoot).map((declaration) => {
    const assetPath = path.join(pluginsRoot, declaration.dirName, declaration.assetPath);
    return registerGuestAdapter({
      id: declaration.adapterId,
      pluginId: declaration.pluginId,
      load: () => readFile(assetPath, "utf8"),
      cache,
    });
  });

  return () => {
    for (const dispose of disposers) dispose();
  };
}
