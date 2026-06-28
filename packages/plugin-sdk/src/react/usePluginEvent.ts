import { useEffect, useRef } from "react";
import type { PluginEventHandler } from "../../../../shared/types/plugin-sdk-react.js";
import { getPluginHostBridge } from "./hostBridge.js";

/**
 * Subscribe a plugin view to a host push channel — the renderer side of
 * `host.postToPanel(channel, payload)`. Wraps
 * `window.electron.plugin.on(pluginId, channel, cb)` with automatic teardown so
 * a panel can consume a live stream (poll results, subscription pushes) without
 * hand-managing the unsubscribe disposer on unmount.
 *
 * The latest `handler` is kept in a ref and invoked through a stable wrapper, so
 * passing a fresh inline closure each render does NOT re-subscribe (which would
 * drop in-flight pushes during the resubscribe gap). Only a change to
 * `pluginId` or `channel` tears down and re-opens the subscription.
 *
 * Payloads arrive untyped over IPC (structured-clone). `TPayload` narrows the
 * handler signature for the call site; the hook performs no runtime validation —
 * a plugin owns the shape it pushes, mirroring `useHostChannel`'s
 * host-owns-validation contract.
 */
export function usePluginEvent<TPayload = unknown>(
  pluginId: string,
  channel: string,
  handler: PluginEventHandler<TPayload>
): void {
  const handlerRef = useRef(handler);
  // Keep the latest handler in a ref via an effect (not a render-time mutation,
  // which the React 19 compiler rejects). Pushes arrive asynchronously over IPC,
  // so the post-render ref update is always in place before one fires.
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const dispose = getPluginHostBridge().on(pluginId, channel, (payload) => {
      handlerRef.current(payload as TPayload);
    });
    return dispose;
  }, [pluginId, channel]);
}

/**
 * Per-instance sibling of {@link usePluginEvent} — subscribes only to the pushes
 * the plugin's main side targeted at this exact `panelId` via
 * `host.postToPanel(channel, payload, panelId)` (#10618). Two open instances of
 * the same panel kind, each calling this with their own `panelId`, no longer
 * receive each other's pushes. Broadcast pushes (`postToPanel` with no panelId)
 * are NOT delivered here — use {@link usePluginEvent} for those. A panel view
 * gets its instance id from the `panelId` prop the host passes it.
 *
 * Same teardown contract as {@link usePluginEvent}: the latest `handler` is held
 * in a ref behind a stable wrapper, so a fresh inline closure each render does
 * NOT re-subscribe; only a change to `pluginId`, `channel`, or `panelId` tears
 * down and re-opens the subscription.
 */
export function usePluginPanelEvent<TPayload = unknown>(
  pluginId: string,
  channel: string,
  panelId: string,
  handler: PluginEventHandler<TPayload>
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const dispose = getPluginHostBridge().onPanel(pluginId, channel, panelId, (payload) => {
      handlerRef.current(payload as TPayload);
    });
    return dispose;
  }, [pluginId, channel, panelId]);
}
