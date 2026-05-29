import path from "path";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import type { MainProcessToastPayload } from "../../shared/types/ipc/maps.js";
import type { PluginInstallResult } from "../../shared/types/plugin.js";
import type { PluginService } from "../services/PluginService.js";
import {
  clearPendingOpenFilePaths,
  getPendingOpenFilePaths,
  setOpenFileConsumer,
} from "./environment.js";

// Structural slice — keeps this module from pulling the full PluginService
// dependency graph into its static import surface (the type is erased).
type PluginInstaller = Pick<PluginService, "installPlugin">;

function showToast(payload: MainProcessToastPayload): void {
  broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, payload);
}

/**
 * Install one `.dntr` archive opened via the macOS `open-file` flow. The path
 * is untrusted (anything the user double-clicks): `installPlugin` validates the
 * archive internally (zip integrity, manifest schema, engine range) and returns
 * a structured `{ status: "failed" }` rather than throwing, so a bad file
 * surfaces as a toast — never a crash.
 */
async function installSideloadedPlugin(
  pluginService: PluginInstaller,
  archivePath: string
): Promise<void> {
  const fileName = path.basename(archivePath);

  let result: PluginInstallResult;
  try {
    result = await pluginService.installPlugin(archivePath, {
      source: "sideload",
      originalUrl: undefined,
    });
  } catch (err) {
    showToast({
      type: "error",
      title: "Plugin install failed",
      message: `Couldn't install "${fileName}": ${
        err instanceof Error ? err.message : "an unexpected error occurred."
      }`,
    });
    return;
  }

  if (result.status === "installed") {
    showToast({
      type: "success",
      title: "Plugin installed",
      message: `Installed "${fileName}".`,
    });
  } else if (result.status === "failed") {
    showToast({
      type: "error",
      title: "Plugin install failed",
      message: `Couldn't install "${fileName}": ${
        result.errors[0]?.message ?? "the archive is invalid."
      }`,
    });
  }
  // cancelled / invalid-url / not-implemented cannot occur for a direct
  // archive-path install — intentionally ignored.
}

/**
 * Wire the macOS `open-file` install path once PluginService is available.
 * Drains any paths queued during cold launch (Finder double-click fires
 * `open-file` before `app.whenReady()` resolves) and installs a live consumer
 * for subsequent events. Call once, after PluginService init.
 */
export async function activateOpenFileInstaller(pluginService: PluginInstaller): Promise<void> {
  // Take over live events first, so an event arriving mid-drain routes through
  // the consumer instead of landing in a queue we've already snapshotted.
  setOpenFileConsumer((filePath) => {
    void installSideloadedPlugin(pluginService, filePath);
  });

  const pending = getPendingOpenFilePaths();
  clearPendingOpenFilePaths();
  for (const filePath of pending) {
    await installSideloadedPlugin(pluginService, filePath);
  }
}
