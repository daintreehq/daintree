import type { BrowserWindow } from "electron";
import {
  clearPendingOpenDirPaths,
  getPendingOpenDirPaths,
  setOpenDirConsumer,
  queuePendingOpenDirPath,
} from "../setup/environment.js";

/**
 * Folder-drop open glue for macOS `open-file` (#10976), extracted from
 * windowServices so the queue/consumer lifecycle is unit-testable. The
 * environment.ts listener already branched directories into `_pendingOpenDirPaths`
 * + `_openDirConsumer`; this module owns (1) the one-shot live consumer that
 * routes warm drops to the primary window and (2) the window-create drain that
 * opens folders queued before any window existed. Both feed the caller's
 * `openDirectory` (the existing `handleDirectoryOpen`) so MRU broadcast / port
 * reattach are inherited, never duplicated.
 */
export interface OpenDirHandlerDeps {
  /** Open a directory as a project in the target window (existing handleDirectoryOpen). */
  openDirectory: (dirPath: string, win: BrowserWindow) => Promise<void>;
  /** Resolve the current primary window for warm drops, or null/undefined if none. */
  resolvePrimaryWindow: () => BrowserWindow | null | undefined;
}

// App-lifetime consumer: macOS `open-file` is app-lifetime, so this wires once.
let openDirConsumerInstalled = false;

/**
 * Install the live directory consumer (idempotent). Warm folder drops route to
 * the primary window; with no live window (macOS stays alive with zero windows)
 * the folder re-queues for the next window-create / `activate` drain.
 */
export function installOpenDirConsumer(deps: OpenDirHandlerDeps): void {
  if (openDirConsumerInstalled) return;
  openDirConsumerInstalled = true;
  setOpenDirConsumer((dirPath) => {
    const primary = deps.resolvePrimaryWindow();
    if (primary && !primary.isDestroyed()) {
      void deps
        .openDirectory(dirPath, primary)
        .catch((err) => console.error("[MAIN] Failed to open dropped folder:", err));
    } else {
      queuePendingOpenDirPath(dirPath);
    }
  });
}

/**
 * Drain folders queued before a window existed, opening each in the fresh
 * window. Opens are serialized (FIFO, last opened ends active) so multiple
 * queued folders don't race on project/PVM state; the loop is fire-and-forget
 * so window setup isn't blocked. A window destroyed mid-drain re-queues the
 * remaining folders instead of silently dropping them.
 */
export function drainPendingOpenDirs(win: BrowserWindow, deps: OpenDirHandlerDeps): void {
  const pending = getPendingOpenDirPaths();
  if (pending.length === 0) return;
  clearPendingOpenDirPaths();
  void (async () => {
    for (const dirPath of pending) {
      if (win.isDestroyed()) {
        queuePendingOpenDirPath(dirPath);
        continue;
      }
      try {
        await deps.openDirectory(dirPath, win);
      } catch (err) {
        console.error("[MAIN] Failed to open dropped folder:", err);
      }
    }
  })();
}

/** Test-only: reset the install-once guard between cases. */
export function _resetOpenDirConsumerForTest(): void {
  openDirConsumerInstalled = false;
}
