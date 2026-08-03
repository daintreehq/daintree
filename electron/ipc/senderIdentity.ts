/**
 * Sender-derived identity helpers.
 *
 * Deliberately dependency-free: ownership gates on hot IPC paths (terminal
 * reconnect, project switch) need to read a sender's identity without dragging
 * `ProjectStore` — and with it the database, electron-store, and GitService —
 * into their module graph.
 */

/**
 * Project id carried on a view's document URL. Only the initial (startup-restore)
 * renderer gets a `?projectId=` query string; ProjectViewManager's cold switch
 * views load a static URL. So this is the sole per-sender identity during the
 * startup window where the restored view is already live but `registerInitialView`
 * has not bound it in the project maps yet.
 */
export function getProjectIdFromSenderUrl(sender: Electron.WebContents): string | null {
  const senderWithUrl = sender as Electron.WebContents & { getURL?: () => string };
  if (typeof senderWithUrl.getURL !== "function") return null;

  try {
    return new URL(senderWithUrl.getURL()).searchParams.get("projectId");
  } catch {
    return null;
  }
}
