import { ipcMain, type BrowserWindow, type IpcMainEvent, type WebContents } from "electron";
import { CHANNELS } from "../channels.js";
import { getIpcDispatcher } from "../dispatcher.js";
import type { ClientEndpoint } from "../endpoint.js";
import {
  getProjectForWebContents,
  getWindowForWebContents,
  isCachedViewWebContents,
  onRendererScopeChanged,
} from "../../window/webContentsRegistry.js";
import {
  getFocusedPanelTracker,
  type FocusedPanelTracker,
} from "../../services/FocusedPanelTracker.js";

/**
 * Hands a remote-bound view's report to the host its window is attached to.
 * Returns false when the sender is not bound to a host, which leaves the report
 * to this machine's own tracker. Installed by the Remote Hosts Shell boot.
 */
export type FocusedPanelHostRelay = (
  senderWebContentsId: number,
  channel: string,
  args: unknown[]
) => boolean;

let hostRelay: FocusedPanelHostRelay | null = null;

export function setFocusedPanelHostRelay(relay: FocusedPanelHostRelay | null): () => void {
  hostRelay = relay;
  return () => {
    if (hostRelay === relay) hostRelay = null;
  };
}

/**
 * Wire the fire-and-forget channel through which each project view reports the
 * kind of panel holding its DOM focus (#13221). The sender, its window and its
 * project are resolved here from `event.sender`, never taken from the payload,
 * and the payload is re-normalised by the tracker.
 *
 * A view bound to a remote host shows that host's project, so its report is
 * the host's plugins' to see, not this machine's: it is relayed together with
 * whether the view has native focus here, which the host cannot observe. The
 * host takes those relays from its link, keyed by the view's endpoint.
 */
export function registerPluginFocusedPanelHandlers(
  tracker: FocusedPanelTracker = getFocusedPanelTracker()
): () => void {
  const watched = new WeakSet<WebContents>();
  const relayed = new Map<number, { sender: WebContents; payload: unknown; focused: boolean }>();
  const watchedWindows = new Set<BrowserWindow>();

  const isNativelyFocused = (sender: WebContents): boolean => {
    if (sender.isDestroyed()) return false;
    const window = getWindowForWebContents(sender);
    return (
      !!window && !window.isDestroyed() && window.isFocused() && !isCachedViewWebContents(sender.id)
    );
  };

  /** Relay a remote-bound sender's last report; false once it is no longer bound to a host. */
  const relay = (sender: WebContents, payload: unknown, force: boolean): boolean => {
    const focused = isNativelyFocused(sender);
    const previous = relayed.get(sender.id);
    if (!force && previous && previous.focused === focused) return true;
    if (!hostRelay?.(sender.id, CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL, [payload, focused])) {
      relayed.delete(sender.id);
      return false;
    }
    relayed.set(sender.id, { sender, payload, focused });
    return true;
  };

  const refreshRelays = (): void => {
    for (const { sender, payload } of [...relayed.values()]) relay(sender, payload, false);
  };

  const handleReport = (event: IpcMainEvent, payload: unknown): void => {
    // Only the top frame runs the preload that owns the report.
    if (event.senderFrame && event.senderFrame.parent !== null) return;
    const sender = event.sender;
    if (sender.isDestroyed()) return;
    const window = getWindowForWebContents(sender);
    if (!window || window.isDestroyed()) return;
    const senderId = sender.id;
    if (!watched.has(sender)) {
      watched.add(sender);
      sender.once("destroyed", () => {
        relayed.delete(senderId);
        tracker.removeSender(senderId);
      });
      // A crashed renderer keeps its WebContents, so `destroyed` alone would
      // leave its last report standing until the reload reports again.
      sender.on("render-process-gone", () => tracker.removeSender(senderId));
      // Which view holds native focus decides whose report counts, and that
      // can change with no new report (a warm switch back to a view whose
      // answer is unchanged), so re-derive on the view's own focus edges.
      const onFocusEdge = () => {
        tracker.refresh();
        refreshRelays();
      };
      sender.on("focus", onFocusEdge);
      sender.on("blur", onFocusEdge);
    }
    if (!watchedWindows.has(window)) {
      // The window's own edges: a child view does not reliably blur with it.
      watchedWindows.add(window);
      window.on("focus", refreshRelays);
      window.on("blur", refreshRelays);
      window.once("closed", () => watchedWindows.delete(window));
    }
    if (relay(sender, payload, true)) {
      tracker.removeSender(senderId);
      return;
    }
    tracker.report(senderId, window.id, getProjectForWebContents(senderId), payload);
  };

  ipcMain.on(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL, handleReport);

  // Host side: a remote view's relay, keyed by its endpoint's handle and
  // forgotten when the endpoint closes.
  const remoteWatched = new WeakSet<ClientEndpoint>();
  const offRemote = getIpcDispatcher().registerSend(
    CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL,
    (ctx, payload, focused) => {
      const endpoint = ctx.endpoint;
      if (endpoint.kind !== "remote-view" || endpoint.isClosed()) return;
      if (!remoteWatched.has(endpoint)) {
        remoteWatched.add(endpoint);
        const handle = endpoint.handle;
        endpoint.onClose(() => tracker.removeRemote(handle));
      }
      tracker.reportRemote(endpoint.handle, endpoint.projectId, payload, focused === true);
    }
  );

  // A view reports before it is registered to its project (the first view
  // loads first), and an unchanged answer is never re-sent, so re-attribute
  // when scope membership changes.
  const offScope = onRendererScopeChanged(() => {
    tracker.refresh();
    refreshRelays();
  });
  return () => {
    offScope();
    offRemote();
    ipcMain.removeListener(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL, handleReport);
    for (const window of watchedWindows) {
      if (window.isDestroyed()) continue;
      window.removeListener("focus", refreshRelays);
      window.removeListener("blur", refreshRelays);
    }
    watchedWindows.clear();
    relayed.clear();
  };
}
