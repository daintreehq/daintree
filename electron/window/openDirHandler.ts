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

// Single serialized chain for EVERY folder open — cold-drain entries and warm
// consumer entries alike. Opening a project mutates shared project/PVM state, so
// concurrent opens (a rapid double-drop, or a warm drop landing mid-drain) would
// race and leave the "last opened ends active" ordering nondeterministic. Each
// open awaits the previous; the chain is fire-and-forget so window setup and the
// open-file listener are never blocked.
let openChain: Promise<void> = Promise.resolve();

function enqueueOpen(task: () => Promise<void>): void {
  openChain = openChain.then(task).catch((err) => {
    console.error("[MAIN] Failed to open dropped folder:", err);
  });
}

/**
 * Install the live directory consumer (idempotent). Warm folder drops route to
 * the primary window; with no live window (macOS stays alive with zero windows)
 * the folder re-queues for the next window-create / `activate` drain. The
 * primary-window check runs at execution time (inside the serialized task), so a
 * window that dies between the drop and the open still re-queues.
 */
export function installOpenDirConsumer(deps: OpenDirHandlerDeps): void {
  if (openDirConsumerInstalled) return;
  openDirConsumerInstalled = true;
  setOpenDirConsumer((dirPath) => {
    enqueueOpen(async () => {
      const primary = deps.resolvePrimaryWindow();
      if (primary && !primary.isDestroyed()) {
        await deps.openDirectory(dirPath, primary);
      } else {
        queuePendingOpenDirPath(dirPath);
      }
    });
  });
}

/**
 * Drain folders queued before a window existed, opening each in the fresh
 * window. Opens are serialized with warm drops via the shared chain (FIFO, last
 * opened ends active). A window destroyed before an open runs re-queues that
 * folder instead of silently dropping it.
 */
export function drainPendingOpenDirs(win: BrowserWindow, deps: OpenDirHandlerDeps): void {
  const pending = getPendingOpenDirPaths();
  if (pending.length === 0) return;
  clearPendingOpenDirPaths();
  for (const dirPath of pending) {
    enqueueOpen(async () => {
      if (win.isDestroyed()) {
        queuePendingOpenDirPath(dirPath);
        return;
      }
      await deps.openDirectory(dirPath, win);
    });
  }
}

/** Test-only: reset the install-once guard and the open chain between cases. */
export function _resetOpenDirConsumerForTest(): void {
  openDirConsumerInstalled = false;
  openChain = Promise.resolve();
}
