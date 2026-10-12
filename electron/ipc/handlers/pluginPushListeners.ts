import { ipcMain, type IpcMainEvent } from "electron";
import { CHANNELS } from "../channels.js";
import { getIpcDispatcher } from "../dispatcher.js";
import type { ClientEndpoint } from "../endpoint.js";
import { parsePushListenerReport } from "../../schemas/pluginPushListeners.js";
import { onRendererScopeChanged } from "../../window/webContentsRegistry.js";
import {
  getPluginPushListenerRegistry,
  type PluginPushListenerRegistry,
  type PluginPushListenerSource,
} from "../../services/plugin/pluginPushListenerRegistry.js";

/**
 * Reports applied per renderer per second. The preload coalesces a report per
 * microtask and only when its set of subscribed channels changes, so a burst of
 * panels mounting at once is still one message. Past the budget the renderer's
 * state is marked unknown — which counts as listening everywhere — and the newest
 * report is held and applied when the window ends, so a burst never leaves the
 * renderer unknown for good.
 */
export const MAX_PUSH_LISTENER_REPORTS_PER_SECOND = 50;

interface SenderWindow {
  start: number;
  count: number;
  /** The newest report refused in this window, applied when it closes. */
  held?: ReturnType<typeof parsePushListenerReport>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Wire the fire-and-forget channel through which each renderer's preload tells
 * main which plugin push channels it has subscribers for. It feeds the
 * producer-side `host.hasListeners` signal only; push delivery ignores it.
 */
export function registerPluginPushListenerHandlers(
  registry: PluginPushListenerRegistry = getPluginPushListenerRegistry()
): () => void {
  // Keyed by the reporting WebContents, or a remote view's endpoint.
  const windows = new WeakMap<object, SenderWindow>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const applyReport = (key: object, sender: PluginPushListenerSource, payload: unknown): void => {
    const report = parsePushListenerReport(payload);
    const now = Date.now();
    let window = windows.get(key);
    if (!window || now - window.start >= 1_000) {
      if (window?.timer !== undefined) {
        clearTimeout(window.timer);
        timers.delete(window.timer);
      }
      window = { start: now, count: 0 };
      windows.set(key, window);
    }
    window.count++;
    if (window.count <= MAX_PUSH_LISTENER_REPORTS_PER_SECOND) {
      registry.report(sender, report);
      return;
    }
    if (window.held === undefined) registry.report(sender, null);
    window.held = report;
    if (window.timer !== undefined) return;
    const current = window;
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        current.timer = undefined;
        if (windows.get(key) !== current || current.held === undefined) return;
        const held = current.held;
        current.held = undefined;
        windows.set(key, { start: Date.now(), count: 1 });
        registry.report(sender, held);
      },
      Math.max(0, current.start + 1_000 - now)
    );
    timer.unref?.();
    current.timer = timer;
    timers.add(timer);
  };
  const handleReport = (event: IpcMainEvent, payload: unknown): void => {
    // Only the top frame runs the preload that owns the subscriptions.
    if (event.senderFrame && event.senderFrame.parent !== null) return;
    applyReport(event.sender, event.sender, payload);
  };
  // A remote view's report arrives over the link, already narrowed to its top
  // frame by its own Shell. Keyed by the endpoint's handle, the id the push
  // targets give that view, and forgotten when the endpoint closes.
  const remoteSources = new WeakMap<ClientEndpoint, PluginPushListenerSource>();
  const remoteSource = (endpoint: ClientEndpoint): PluginPushListenerSource => {
    let source = remoteSources.get(endpoint);
    if (!source) {
      source = {
        id: endpoint.handle,
        once: (_event, listener) => endpoint.onClose(listener),
      };
      remoteSources.set(endpoint, source);
    }
    return source;
  };
  const offRemote = getIpcDispatcher().registerSend(
    CHANNELS.PLUGIN_REPORT_PUSH_LISTENERS,
    (ctx, payload) => {
      if (ctx.endpoint.kind !== "remote-view") return;
      applyReport(ctx.endpoint, remoteSource(ctx.endpoint), payload);
    }
  );
  ipcMain.on(CHANNELS.PLUGIN_REPORT_PUSH_LISTENERS, handleReport);
  // A renderer can report before it joins a project's scope (a window's first
  // view loads before it is registered), and no report follows the
  // registration. Re-evaluate every watcher — passive ones included, which the
  // periodic reconcile does not keep — whenever scope membership changes.
  const offScope = onRendererScopeChanged(() => registry.reconcile());
  return () => {
    offScope();
    offRemote();
    ipcMain.removeListener(CHANNELS.PLUGIN_REPORT_PUSH_LISTENERS, handleReport);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
