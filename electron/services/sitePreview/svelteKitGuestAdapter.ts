/**
 * The Site Builder's guest runtime, registered as a host-owned adapter.
 *
 * The body is the IIFE `scripts/build-main.mjs` bundles from
 * `plugins/builtin/sveltekit-builder/renderer/guest/entry.ts`. It is resolved
 * the same way `PluginService` resolves built-in plugins — under
 * `app.getAppPath()/dist-electron/plugins/builtin/` — which is the repo's
 * `dist-electron/` in dev and `app.asar/dist-electron/` when packaged, so one
 * path serves both.
 */

import { app } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { registerGuestAdapter } from "./guestAdapters.js";

/**
 * Mirrors `GUEST_ADAPTER_ID` in
 * `plugins/builtin/sveltekit-builder/shared/protocol.ts`; the host cannot
 * import plugin code, so `SitePreviewBridgeProtocolDrift` pins the two together.
 */
export const SVELTEKIT_GUEST_ADAPTER_ID = "daintree.sveltekit-builder.guest";

const PLUGIN_ID = "daintree.sveltekit-builder";

function guestAssetPath(): string {
  // Resolved per call: `app.getAppPath()` is not valid at module evaluation.
  return path.join(
    app.getAppPath(),
    "dist-electron",
    "plugins",
    "builtin",
    "sveltekit-builder",
    "guest",
    "runtime.js"
  );
}

export function registerSvelteKitGuestAdapter(): () => void {
  return registerGuestAdapter({
    id: SVELTEKIT_GUEST_ADAPTER_ID,
    pluginId: PLUGIN_ID,
    load: () => readFile(guestAssetPath(), "utf8"),
    // A packaged asset cannot change under the running app. In dev the esbuild
    // watcher rewrites it without restarting Electron, so a cached body would
    // pin whatever was on disk at the first bind.
    cache: app.isPackaged,
  });
}
