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
 *
 * The chain also carries the window's OOM budget (#15647). Every rebuild
 * replaces the WebContents and the BrowserWindow, so a history kept on either
 * starts empty in the replacement and a window that dies on every restore is
 * rebuilt forever. The rebuild hands the history to the replacement instead,
 * and a window that has used up its recreations shows the recovery page.
 */

import type { WindowRegistry } from "./WindowRegistry.js";
import { windowRestoreArgs, type CreateWindowResult } from "../lifecycle/windowRestore.js";
import type { OpenWindowRecord } from "../services/persistence/windowManifest.js";
import {
  captureWindowRecord,
  clearPendingWindowRecreation,
  markWindowRecreationSetupFailed,
  scheduleOpenWindowsSave,
  setPendingWindowRecreation,
} from "./openWindowsTracker.js";

const OOM_LOOP_WINDOW_MS = 60_000;
const OOM_LOOP_THRESHOLD = 3;

/**
 * Called by an OOM branch at the crash, while the window still holds its
 * views. Returns the rebuild, to run once the window has been destroyed, or
 * `null` when this window has been rebuilt for OOM too often lately: the
 * branch loads the recovery page instead and leaves the window standing.
 */
export type PrepareWindowRecreation = () => (() => Promise<void>) | null;

export interface WindowRecreationDeps {
  windowRegistry: WindowRegistry;
  /** The window this rebuilds, once it is registered. */
  getWindowId: () => number | undefined;
  /** When the windows this one replaced died of a probable OOM; empty for a new window. */
  oomHistory?: readonly number[];
  createWindow: (
    projectId: string | undefined,
    opts: {
      revealMode: "show" | "showInactive";
      backgroundProjectIds?: readonly string[];
      remoteWorkspaceKey?: string;
      oomHistory: readonly number[];
      onRegistered: (windowId: number) => void;
    }
  ) => Promise<CreateWindowResult>;
}

export interface WindowRecreation {
  prepare: PrepareWindowRecreation;
  /**
   * The window is being torn down to be rebuilt. Its `closed` save is skipped:
   * the manifest on disk still holds its record, and the replacement carries
   * it from registration on. A replacement that closes lets go of the record
   * with `clearPendingWindowRecreation`.
   */
  isRecreating: () => boolean;
}

export function createWindowRecreation(deps: WindowRecreationDeps): WindowRecreation {
  let prepared = false;
  const oomHistory = [...(deps.oomHistory ?? [])];
  return {
    isRecreating: () => prepared,
    prepare: () => {
      // Two views dying under the same pressure each reach an OOM branch
      // before the first rebuild runs. One window goes, so one comes back,
      // and it spends one recreation.
      if (prepared) return () => Promise.resolve();

      const now = Date.now();
      while (oomHistory.length > 0 && now - oomHistory[0]! > OOM_LOOP_WINDOW_MS) {
        oomHistory.shift();
      }
      // A refused attempt counts too, so OOMs that keep coming keep the window
      // on the recovery page. Only the latest few can decide the next one.
      oomHistory.push(now);
      if (oomHistory.length > OOM_LOOP_THRESHOLD) oomHistory.shift();
      if (oomHistory.length >= OOM_LOOP_THRESHOLD) return null;
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
            oomHistory: [...oomHistory],
            onRegistered: (id) => {
              replacementId = id;
              setPendingWindowRecreation(id, record);
            },
          });
          // Setup has bound the workspace (or found it gone) and queued the
          // background restores, which the manifest now reads for itself.
          if (replacementId !== undefined) clearPendingWindowRecreation(replacementId);
        } catch (error) {
          if (replacementId !== undefined) markWindowRecreationSetupFailed(replacementId);
          throw error;
        } finally {
          // Nothing else saves until the next focus change or switch.
          scheduleOpenWindowsSave();
        }
      };
    },
  };
}
