import { unfreezeWebContents } from "./webContentsLifecycle.js";

/**
 * Thaw a routed target, then send — the fix for the stranded-dispatch half of
 * #11790, shared by the MCP renderer bridge and plugin `host.dispatch`
 * (#13119).
 *
 * Under the efficiency profile a cached background view is CDP-frozen, and a
 * frozen renderer cannot run JS: the dispatch IPC queues in Mojo and nothing
 * ever answers it, so the caller waits out the full deadline for what looks
 * like an execution failure — and the queued request still runs once the view
 * thaws, after the caller was told it failed. Chromium never auto-resumes a
 * frozen renderer on focus or re-attach, so an explicit `"active"` is the only
 * thing that rescues it.
 *
 * Awaited, unlike the fire-and-forget `void unfreezeWebContents(...)` at the
 * lifecycle call sites: those only need the view running again eventually,
 * whereas the IPC queued here is precisely what the thaw has to precede.
 *
 * Thaw only, matching `unfreezeActiveAgentViews`: the view stays cached, so its
 * renderer keeps demoting its own periodic work. Nothing here attaches, shows,
 * focuses, or activates the view either: a caller driving project A must never
 * disturb what the user is looking at.
 *
 * The caller registers its pending entry and deadline before calling this, so
 * the deadline covers the CDP round trip.
 */
export function thawThenSend(
  webContents: Electron.WebContents,
  isStillPending: () => boolean,
  send: () => void
): void {
  void unfreezeWebContents(webContents)
    .catch(() => {
      // `unfreezeWebContents` already swallows the expected teardown/navigation
      // CDP errors, so anything landing here is unexpected. Refusing to send
      // would convert a thaw hiccup into a guaranteed deadline failure; sending
      // anyway leaves a genuinely-still-frozen view failing exactly as it did
      // before this path existed, and costs nothing when the thaw did work.
    })
    .then(() => {
      // The deadline may have fired, or the view may have been destroyed, while
      // the CDP round trip was outstanding. Either way the request is already
      // settled, so sending now would emit an IPC for a requestId nothing is
      // waiting on.
      if (!isStillPending() || webContents.isDestroyed()) return;
      send();
    });
}
