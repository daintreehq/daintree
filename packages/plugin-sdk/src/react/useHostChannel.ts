import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { UseHostChannelResult } from "../../../../shared/types/plugin-sdk-react.js";
import { getPluginHostBridge } from "./hostBridge.js";
import { isHostLinkError, toHostCallError } from "./hostErrors.js";

/**
 * Typed companion to `host.registerHandler(channel, schema, handler)` for
 * plugin views. Wraps `window.electron.plugin.invoke(pluginId, channel, args)`
 * with single-flight `loading` / `error` state, so a plugin view can call
 * `invoke(args)` from an event handler and render the result without
 * hand-rolling the try/catch shape every time.
 *
 * The hook does not subscribe to the channel's schema — the host owns
 * validation and throws `SCHEMA_ERROR:` / `PERMISSION_REQUIRED:` prefixed
 * errors that surface here as the rejected promise / `error` value. Plugin
 * authors should treat both prefixes as authoring bugs (manifest capability
 * missing, or wrong args shape) rather than runtime failures to surface to
 * end users.
 *
 * Concurrent `invoke()` calls keep only the latest result/error — stale
 * resolutions are dropped so a fast click that triggers two invokes never
 * lets the older response overwrite the newer one. `loading` reflects the
 * latest call only. Changing `pluginId` or `channel` supersedes every call
 * started against the previous target the same way, even before the new
 * target is invoked: those calls resolve `undefined` and change nothing.
 *
 * In a window attached to another machine the plugin's host code runs there,
 * and the link can drop. A call that could not reach the host fails with
 * `HostDisconnectedError`; one whose answer was lost after it was sent fails
 * with `OutcomeUnknownError` (it may have run). Either sets `disconnected`
 * until a later call gets through, so a view can show a quiet offline state
 * instead of an error.
 */
export function useHostChannel<TArgs = unknown, TResult = unknown>(
  pluginId: string,
  channel: string
): UseHostChannelResult<TArgs, TResult> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  // The latest call's id and the target it was made against. The id is never
  // reset, so every later call outranks any earlier one still in flight.
  const latestCallRef = useRef({ id: 0, pluginId, channel });

  // A target change supersedes calls made against the previous target by
  // advancing the id, but only when the latest call isn't already against the
  // new target: a child's effect can invoke the new target before this effect
  // runs, and StrictMode replays this effect with the same target. Bumping
  // unconditionally would drop that first call and leave `loading` stuck.
  // Layout timing commits the bump before any IPC reply can settle.
  useLayoutEffect(() => {
    const latest = latestCallRef.current;
    if (latest.pluginId === pluginId && latest.channel === channel) return;
    latestCallRef.current = { id: latest.id + 1, pluginId, channel };
    setLoading(false);
    setError(null);
  }, [pluginId, channel]);

  const invoke = useCallback(
    async (args: TArgs): Promise<TResult | undefined> => {
      const callId = latestCallRef.current.id + 1;
      latestCallRef.current = { id: callId, pluginId, channel };
      setLoading(true);
      setError(null);
      try {
        const result = (await getPluginHostBridge().invoke(pluginId, channel, args)) as TResult;
        // Drop the result of a superseded call so a slow earlier invoke can't
        // overwrite the latest state.
        if (callId !== latestCallRef.current.id) return undefined;
        setDisconnected(false);
        return result;
      } catch (err) {
        if (callId !== latestCallRef.current.id) return undefined;
        const wrapped = toHostCallError(err);
        setError(wrapped);
        setDisconnected(isHostLinkError(wrapped));
        return undefined;
      } finally {
        if (callId === latestCallRef.current.id) {
          setLoading(false);
        }
      }
    },
    [pluginId, channel]
  );

  return { invoke, loading, error, disconnected };
}
