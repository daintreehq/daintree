import { dialog, type BrowserWindow, type WebContents } from "electron";
import { noteTerminationIntent } from "../services/processTerminationIntent.js";

export interface UnresponsiveDialogOptions {
  /** The renderer "Restart view" crashes: the window's foreground view, else its app view. */
  getRestartTarget: () => WebContents | null;
}

/**
 * "Window Not Responding" for a hung window, closed again when the window
 * recovers (#15232). Recovery aborts the box rather than leaving it up saying
 * the window is stuck, and an answer it gives after that is dropped, so a late
 * "Restart view" can't crash a renderer that came back on its own.
 *
 * Returns the cleanup: detaches both listeners and closes any box still up.
 */
export function attachUnresponsiveDialog(
  win: BrowserWindow,
  options: UnresponsiveDialogOptions
): () => void {
  let dialogId = 0;
  // Non-null exactly while a box is up; aborting it closes the box.
  let pending: AbortController | null = null;

  const closeDialog = (): void => {
    // Invalidated before the abort, whose cancel answer must count as stale.
    dialogId++;
    const open = pending;
    pending = null;
    open?.abort();
  };

  const onUnresponsive = (): void => {
    if (pending !== null || win.isDestroyed()) return;
    const controller = new AbortController();
    pending = controller;
    const id = ++dialogId;
    console.warn("[MAIN] Window became unresponsive");

    // Always parented: on macOS a box with no window can't be aborted.
    dialog
      .showMessageBox(win, {
        type: "warning",
        buttons: ["Wait", "Restart view"],
        defaultId: 0,
        title: "Window Not Responding",
        message: "The window is not responding.",
        detail:
          "You can wait for it to recover, or force-restart the view. Force-restarting will immediately terminate and recover the view.",
        signal: controller.signal,
      })
      .then(({ response }) => {
        if (id !== dialogId) return;
        pending = null;
        if (response !== 1 || win.isDestroyed()) return;
        console.warn("[MAIN] User triggered force-restart of unresponsive renderer");
        const target = options.getRestartTarget();
        if (target && !target.isDestroyed()) {
          noteTerminationIntent({ webContentsId: target.id }, "user force-restarted view");
          target.forcefullyCrashRenderer();
        }
      })
      .catch(() => {
        if (id === dialogId) pending = null;
      });
  };

  const onResponsive = (): void => {
    if (pending === null) return;
    closeDialog();
    console.log("[MAIN] Window became responsive again");
  };

  win.on("unresponsive", onUnresponsive);
  win.on("responsive", onResponsive);

  return () => {
    win.removeListener("unresponsive", onUnresponsive);
    win.removeListener("responsive", onResponsive);
    closeDialog();
  };
}
