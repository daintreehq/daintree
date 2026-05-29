import path from "path";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { appendPendingError } from "../ipc/pendingErrorsStore.js";
import { getAllAppWebContents } from "../window/webContentsRegistry.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type { MainProcessToastPayload } from "../../shared/types/ipc/maps.js";
import type { PluginInstallResult } from "../../shared/types/plugin.js";
import type { ErrorRecord } from "../../shared/types/ipc/errors.js";
import type { PluginService } from "../services/PluginService.js";
import {
  clearPendingOpenFilePaths,
  getPendingOpenFilePaths,
  setOpenFileConsumer,
} from "./environment.js";

// Structural slice — keeps this module from pulling the full PluginService
// dependency graph into its static import surface (the type is erased).
type PluginInstaller = Pick<PluginService, "installPlugin">;

function hasLiveRenderer(): boolean {
  return getAllAppWebContents().some((wc) => !wc.isDestroyed());
}

function showToast(payload: MainProcessToastPayload): void {
  broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, payload);
}

/**
 * Surface an install failure. On a cold launch the queued-path drain can finish
 * before the first window paints, and on macOS the app stays alive with no
 * windows — in both cases `broadcastToRenderer` has no targets and the toast is
 * dropped. So when no renderer is live, persist the failure via
 * `appendPendingError` (the same durable inbox `globalErrorHandlers` uses for
 * pre-ready fatals) so it surfaces on the next renderer mount instead of
 * vanishing. A live renderer gets the immediate toast.
 */
function surfaceInstallError(fileName: string, detail: string): void {
  if (hasLiveRenderer()) {
    showToast({
      type: "error",
      title: "Plugin install failed",
      message: `Couldn't install "${fileName}": ${detail}`,
    });
    return;
  }
  const record: ErrorRecord = {
    id: `plugin-sideload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    type: "validation",
    message: `Couldn't install "${fileName}": ${detail}`,
    source: "main-process",
    retryability: "none",
    dismissed: false,
  };
  appendPendingError(record);
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
    surfaceInstallError(fileName, formatErrorMessage(err, "an unexpected error occurred"));
    return;
  }

  if (result.status === "installed") {
    // Success feedback is best-effort: if no window is open (cold launch still
    // painting, or all windows closed on macOS), skip the toast — the plugin
    // list reflects the install when a window next mounts. Only failures get
    // the durable `appendPendingError` fallback, since a lost error is worse
    // than a lost success.
    if (hasLiveRenderer()) {
      showToast({
        type: "success",
        title: "Plugin installed",
        message: `Installed "${fileName}".`,
      });
    }
  } else if (result.status === "failed") {
    surfaceInstallError(fileName, result.errors[0]?.message ?? "the archive is invalid.");
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
