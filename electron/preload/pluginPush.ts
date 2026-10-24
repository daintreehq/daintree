import { CHANNELS } from "../ipc/channels.js";
import { PLUGIN_PUSH_BATCH_CHANNEL } from "../services/plugin/pluginPushProtocol.js";
import type { PreloadIpcRenderer } from "./types.js";

type PluginPushSubscriber = (payload: unknown) => void;
interface PluginPushChannelEntry {
  handler: (event: Electron.IpcRendererEvent, raw: unknown) => void;
  // Keyed by panelId; the `null` key holds broadcast subscribers.
  subscribers: Map<string | null, Set<PluginPushSubscriber>>;
}

// Recent push deliveries, for the renderer's long-frame attribution: plugin
// code runs through the host's React, so a frame spent reacting to a push
// never names the plugin, and the page cannot wrap the contextBridge objects
// the push arrives through. One slot per delivery interval; deliveries to the
// same plugin within a few milliseconds of each other extend the newest slot,
// so a flood costs two clock reads per push and no allocation.
const PUSH_DELIVERY_RING = 128;
const PUSH_DELIVERY_COALESCE_MS = 4;

export interface PluginPushTransport {
  on(
    pluginId: string,
    channel: string,
    panelId: string | null,
    callback: PluginPushSubscriber
  ): () => void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  pluginsWithPushDeliveriesDuring(start: unknown, end: unknown): string[];
}

// Multiplexer for the plugin push transport `plugin:{pluginId}:{channel}`,
// mirroring _terminalDataOn. host.broadcastToRenderer, host.postToPanel, and the
// managed-process stream all push a PluginPanelEventEnvelope `{ panelId, payload }`
// over this channel, and multiple panel instances of one kind each subscribe to
// the same channel. Before #10618 every `plugin.on` call added its own raw
// ipcRenderer.on with no per-instance filter, so every push reached every
// instance. Now one physical listener per full channel fans out by panelId: a
// broadcast envelope (`panelId: null`) reaches only broadcast subscribers (those
// registered via `plugin.on`), and a targeted envelope reaches only the
// subscribers registered for that exact panelId via `plugin.onPanel` — so
// `postToPanel(channel, payload, "panel-a")` no longer leaks to sibling
// instances.
export function createPluginPushTransport(
  ipcRenderer: PreloadIpcRenderer,
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
): PluginPushTransport {
  const _pluginPushChannels = new Map<string, PluginPushChannelEntry>();

  const _pushDeliveryStarts = new Float64Array(PUSH_DELIVERY_RING);
  const _pushDeliveryEnds = new Float64Array(PUSH_DELIVERY_RING);
  const _pushDeliveryPlugins: (string | undefined)[] = new Array(PUSH_DELIVERY_RING);
  let _pushDeliveryCursor = 0;
  let _pushDeliveryCount = 0;

  function _recordPushDelivery(pluginId: string, start: number, end: number): void {
    if (_pushDeliveryCount > 0) {
      const newest = (_pushDeliveryCursor - 1 + PUSH_DELIVERY_RING) % PUSH_DELIVERY_RING;
      if (
        _pushDeliveryPlugins[newest] === pluginId &&
        start - _pushDeliveryEnds[newest]! <= PUSH_DELIVERY_COALESCE_MS
      ) {
        if (end > _pushDeliveryEnds[newest]!) _pushDeliveryEnds[newest] = end;
        return;
      }
    }
    _pushDeliveryStarts[_pushDeliveryCursor] = start;
    _pushDeliveryEnds[_pushDeliveryCursor] = end;
    _pushDeliveryPlugins[_pushDeliveryCursor] = pluginId;
    _pushDeliveryCursor = (_pushDeliveryCursor + 1) % PUSH_DELIVERY_RING;
    if (_pushDeliveryCount < PUSH_DELIVERY_RING) _pushDeliveryCount++;
  }

  function _pluginsWithPushDeliveriesDuring(start: unknown, end: unknown): string[] {
    if (typeof start !== "number" || typeof end !== "number") return [];
    const found: string[] = [];
    for (let i = 0; i < _pushDeliveryCount; i++) {
      const pluginId = _pushDeliveryPlugins[i];
      if (pluginId === undefined || found.includes(pluginId)) continue;
      if (_pushDeliveryEnds[i]! >= start && _pushDeliveryStarts[i]! <= end) found.push(pluginId);
    }
    return found;
  }

  // Main batches every push on this transport into one message per renderer per
  // macrotask (an ordered `[fullChannel, envelope]` array). Each entry is replayed
  // through the per-channel dispatcher below, in order, so panel filtering and
  // subscriber isolation are exactly those of an individually sent push.
  let _pluginPushBatchAttached = false;
  function _attachPluginPushBatchListener(): void {
    if (_pluginPushBatchAttached) return;
    _pluginPushBatchAttached = true;
    ipcRenderer.on(PLUGIN_PUSH_BATCH_CHANNEL, (event, batch: unknown) => {
      if (!Array.isArray(batch)) return;
      for (const entry of batch) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        _pluginPushChannels.get(entry[0])?.handler(event, entry[1]);
      }
    });
  }

  // Main tells plugins whether any renderer listens on a push channel
  // (`host.hasListeners`), so a producer can stop computing pushes nobody wants.
  // What it needs is which `(fullChannel, panelId)` buckets have a subscriber,
  // so that set is reported whole whenever a bucket appears or empties —
  // coalesced to one message per microtask, and never for a second listener
  // joining a bucket that already has one. A whole-set report is idempotent: a
  // lost or reordered one cannot leave main's view drifting.
  //
  // Delivery never depends on it: a report always trails the subscriber that
  // caused it, so main sends every push to this renderer regardless. The first
  // report goes out at preload load, empty; until it lands main counts this
  // renderer as listening everywhere.
  let _pluginListenersDirty = false;
  let _pluginListenersQueued = false;
  function _markPluginListenersChanged(): void {
    _pluginListenersDirty = true;
    if (_pluginListenersQueued) return;
    _pluginListenersQueued = true;
    queueMicrotask(_flushPluginListenerReport);
  }
  function _flushPluginListenerReport(): void {
    _pluginListenersQueued = false;
    if (!_pluginListenersDirty) return;
    _pluginListenersDirty = false;
    const listeners: Array<[string, string | null]> = [];
    for (const [fullChannel, entry] of _pluginPushChannels) {
      for (const panelId of entry.subscribers.keys()) listeners.push([fullChannel, panelId]);
    }
    try {
      ipcRenderer.send(CHANNELS.PLUGIN_REPORT_PUSH_LISTENERS, listeners);
    } catch {
      // A page tearing down; its successor reports afresh.
    }
  }
  _markPluginListenersChanged();

  // A plugin invoke from this renderer — a view pulling its snapshot right after
  // subscribing — must not reach main ahead of the subscription it follows, or
  // the worker could serve it while still told nobody listens, and pause the
  // stream the view is about to rely on.
  function _pluginInvoke(channel: string, ...args: unknown[]): Promise<unknown> {
    _flushPluginListenerReport();
    return invoke(channel, ...args);
  }

  function _pluginPushOn(
    pluginId: string,
    channel: string,
    panelId: string | null,
    callback: PluginPushSubscriber
  ): () => void {
    const fullChannel = `plugin:${pluginId}:${channel}`;
    _attachPluginPushBatchListener();
    let entry = _pluginPushChannels.get(fullChannel);
    if (!entry) {
      const subscribers = new Map<string | null, Set<PluginPushSubscriber>>();
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        // Unwrap the envelope. Every push site enveloples, but normalize
        // defensively: an unexpected shape degrades to a broadcast of the raw
        // value rather than crashing the dispatcher or dropping the push.
        let targetPanelId: string | null = null;
        let payload: unknown = raw;
        if (raw !== null && typeof raw === "object" && "panelId" in raw && "payload" in raw) {
          const env = raw as { panelId: unknown; payload: unknown };
          targetPanelId = typeof env.panelId === "string" ? env.panelId : null;
          payload = env.payload;
        }
        const set = subscribers.get(targetPanelId);
        if (!set || set.size === 0) return;
        const deliveredAt = performance.now();
        // Snapshot before dispatch: a subscriber may unsubscribe (or its panel may
        // unmount) inside its own callback, mutating the Set mid-iteration.
        for (const cb of [...set]) {
          try {
            cb(payload);
          } catch (err) {
            console.error("[Preload] plugin push subscriber threw for", fullChannel, err);
          }
        }
        _recordPushDelivery(pluginId, deliveredAt, performance.now());
      };
      ipcRenderer.on(fullChannel, handler);
      entry = { handler, subscribers };
      _pluginPushChannels.set(fullChannel, entry);
    }
    let set = entry.subscribers.get(panelId);
    if (!set) {
      set = new Set();
      entry.subscribers.set(panelId, set);
      _markPluginListenersChanged();
    }
    // Fresh wrapper per subscription so the same callback can subscribe twice and
    // each cleanup removes only its own registration.
    const wrapped: PluginPushSubscriber = (payload) => callback(payload);
    set.add(wrapped);
    return () => {
      const current = _pluginPushChannels.get(fullChannel);
      if (!current) return;
      const currentSet = current.subscribers.get(panelId);
      if (currentSet) {
        currentSet.delete(wrapped);
        if (currentSet.size === 0) {
          current.subscribers.delete(panelId);
          _markPluginListenersChanged();
        }
      }
      // Tear down the physical listener once every panelId bucket is empty, so an
      // unmounted view doesn't leak its channel listener.
      if (current.subscribers.size === 0) {
        ipcRenderer.removeListener(fullChannel, current.handler);
        _pluginPushChannels.delete(fullChannel);
      }
    };
  }

  return {
    on: _pluginPushOn,
    invoke: _pluginInvoke,
    pluginsWithPushDeliveriesDuring: _pluginsWithPushDeliveriesDuring,
  };
}
