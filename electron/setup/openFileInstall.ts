import { enqueueArchiveInstallIntent } from "./archiveInstallIntent.js";
import {
  clearPendingOpenFilePaths,
  getPendingOpenFilePaths,
  setOpenFileConsumer,
} from "./environment.js";

/**
 * Wire the macOS `open-file` path once the app is ready to prompt. Drains any
 * paths queued during cold launch (Finder double-click fires `open-file` before
 * `app.whenReady()` resolves) and installs a live consumer for subsequent
 * events. Call once, after PluginService init.
 *
 * A double-clicked archive is never installed here — it is queued for the
 * confirmation prompt in `archiveInstallIntent.ts` (#11280), which previews the
 * manifest and lets the renderer complete the install only on approval.
 */
export async function activateOpenFileInstaller(): Promise<void> {
  // Take over live events first, so an event arriving mid-drain routes through
  // the consumer instead of landing in a queue we've already snapshotted.
  setOpenFileConsumer((filePath) => {
    void enqueueArchiveInstallIntent(filePath);
  });

  const pending = getPendingOpenFilePaths();
  clearPendingOpenFilePaths();
  for (const filePath of pending) {
    await enqueueArchiveInstallIntent(filePath);
  }
}
