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
  handlerRef.current = handler;

  useEffect(() => {
    const dispose = getPluginHostBridge().on(pluginId, channel, (payload) => {
      handlerRef.current(payload as TPayload);
    });
    return dispose;
  }, [pluginId, channel]);
}
