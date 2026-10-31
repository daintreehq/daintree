import { useCallback, useInsertionEffect, useLayoutEffect, useRef, useState } from "react";
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
  const callIdRef = useRef(0);
  // The target changed and no call on the new target has cleared state yet.
  const resetPendingRef = useRef(false);

  // A target change supersedes every call made against the previous target by
  // advancing the never-reset call counter, even before the new target is
  // invoked. An insertion effect fires in the commit that changes the target,
  // even inside a hidden `<Activity>` where layout effects are disconnected,
  // and before any layout effect, so a child that invokes the new target from
  // its own effect in the same commit always lands after the bump. StrictMode
  // doesn't replay insertion effects, so a once-only first call survives.
  useInsertionEffect(() => {
    callIdRef.current += 1;
    resetPendingRef.current = true;
  }, [pluginId, channel]);

  // Insertion effects can't set state, so the reset waits for layout, which
  // also runs when a hidden `<Activity>` is shown again. A call already made on
  // the new target cleared the flag, so its `loading` survives.
  useLayoutEffect(() => {
    if (!resetPendingRef.current) return;
    resetPendingRef.current = false;
    setLoading(false);
    setError(null);
  }, [pluginId, channel]);

  const invoke = useCallback(
    async (args: TArgs): Promise<TResult | undefined> => {
      const callId = ++callIdRef.current;
      resetPendingRef.current = false;
      setLoading(true);
      setError(null);
      try {
        const result = (await getPluginHostBridge().invoke(pluginId, channel, args)) as TResult;
        // Drop the result of a superseded call so a slow earlier invoke can't
        // overwrite the latest state.
        if (callId !== callIdRef.current) return undefined;
        setDisconnected(false);
        return result;
      } catch (err) {
        if (callId !== callIdRef.current) return undefined;
        const wrapped = toHostCallError(err);
        setError(wrapped);
        setDisconnected(isHostLinkError(wrapped));
        return undefined;
      } finally {
        if (callId === callIdRef.current) {
          setLoading(false);
        }
      }
    },
    [pluginId, channel]
  );

  return { invoke, loading, error, disconnected };
}
