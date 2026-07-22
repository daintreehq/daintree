import {
  enqueueArchiveInstallIntent,
  enqueueArchiveInstallIntents,
} from "./archiveInstallIntent.js";
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
    void enqueueArchiveInstallIntent(filePath).catch((err) =>
      console.error("[MAIN] Failed to queue an opened .dntr archive:", err)
    );
  });

  // Queued as one batch: awaiting each path in turn would let a live event
  // arriving mid-drain jump ahead of the paths still to be queued.
  const pending = getPendingOpenFilePaths();
  clearPendingOpenFilePaths();
  await enqueueArchiveInstallIntents(pending);
}
