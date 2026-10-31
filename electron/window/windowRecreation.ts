/**
 * Rebuilds a window whose renderer died of a probable OOM onto what it was
 * showing when it died, not what it was launched with (#15564).
 *
 * The OOM branches destroy the window before rebuilding it, and destroying it
 * unregisters its context and disposes its view manager: nothing about what it
 * was showing is readable afterwards. So recreation is two calls. The branch
 * prepares it at the crash, which captures the window's record as the
 * manifest would write it (its foreground workspace, local, scratch or
 * host-scoped, and the workspaces it had warm), and runs the returned rebuild
 * once the window is gone. The rebuild goes through the launch restore's
 * mapping, so a host-scoped workspace opens on the picker and moves to its
 * host, and a workspace that no longer exists resolves to the picker.
 */

import type { WindowRegistry } from "./WindowRegistry.js";
import { windowRestoreArgs, type CreateWindowResult } from "../lifecycle/windowRestore.js";
import type { OpenWindowRecord } from "../services/persistence/windowManifest.js";
import {
  captureWindowRecord,
  clearPendingWindowRecreation,
  saveOpenWindowsNow,
  setPendingWindowRecreation,
} from "./openWindowsTracker.js";

/**
 * Called by an OOM branch at the crash, while the window still holds its
 * views. Returns the rebuild, to run once the window has been destroyed.
 */
export type PrepareWindowRecreation = () => () => Promise<void>;

export interface WindowRecreationDeps {
  windowRegistry: WindowRegistry;
  /** The window this rebuilds, once it is registered. */
  getWindowId: () => number | undefined;
  createWindow: (
    projectId: string | undefined,
    opts: {
      revealMode: "show" | "showInactive";
      backgroundProjectIds?: readonly string[];
      remoteWorkspaceKey?: string;
      onRegistered: (windowId: number) => void;
    }
  ) => Promise<CreateWindowResult>;
}

export interface WindowRecreation {
  prepare: PrepareWindowRecreation;
  /**
   * The window is being torn down to be rebuilt. Its `closed` save is skipped:
   * the manifest on disk still holds its record, and the replacement carries
   * it from registration on.
   */
  isRecreating: () => boolean;
}

export function createWindowRecreation(deps: WindowRecreationDeps): WindowRecreation {
  let prepared = false;
  return {
    isRecreating: () => prepared,
    prepare: () => {
      // Two views dying under the same pressure each reach an OOM branch
      // before the first rebuild runs. One window goes, so one comes back.
      if (prepared) return () => Promise.resolve();
      prepared = true;

      const windowId = deps.getWindowId();
      const ctx = windowId === undefined ? undefined : deps.windowRegistry.getByWindowId(windowId);
      const record: OpenWindowRecord = (windowId !== undefined
        ? captureWindowRecord(deps.windowRegistry, windowId)
        : null) ?? { projectId: null };
      // A window behind the one the person is using comes back behind it.
      const browserWindow = ctx?.browserWindow;
      const revealMode =
        browserWindow && !browserWindow.isDestroyed() && !browserWindow.isFocused()
          ? "showInactive"
          : "show";

      return async () => {
        const { projectId, options } = windowRestoreArgs(record);
        let replacementId: number | undefined;
        try {
          await deps.createWindow(projectId, {
            ...options,
            revealMode,
            onRegistered: (id) => {
              replacementId = id;
              setPendingWindowRecreation(id, record);
            },
          });
        } finally {
          if (replacementId !== undefined) clearPendingWindowRecreation(replacementId);
          // Setup has bound the workspace (or found it gone) and queued the
          // background restores, which the manifest now reads for itself.
          // Nothing else saves until the next focus change or switch.
          saveOpenWindowsNow();
        }
      };
    },
  };
}
