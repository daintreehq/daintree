import { useCallback, useEffect, useRef, useState } from "react";
import type { UseHostChannelResult } from "../../../../shared/types/plugin-sdk-react.js";
import { getPluginHostBridge } from "./hostBridge.js";

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
 * latest call only.
 */
export function useHostChannel<TArgs = unknown, TResult = unknown>(
  pluginId: string,
  channel: string
): UseHostChannelResult<TArgs, TResult> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const callIdRef = useRef(0);

  // Clear loading/error when the channel target changes. The call counter is
  // monotonic and is NOT reset here: resetting it would let an in-flight call
  // from the prior target (e.g. callId 1) collide with the first new call (also
  // callId 1) and pass the stale-call guard below, clobbering the new target's
  // state. A never-reset counter guarantees every later call outranks any
  // earlier in-flight one.
  useEffect(() => {
    setLoading(false);
    setError(null);
  }, [pluginId, channel]);

  const invoke = useCallback(
    async (args: TArgs): Promise<TResult | undefined> => {
      const callId = ++callIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = (await getPluginHostBridge().invoke(pluginId, channel, args)) as TResult;
        // Drop the result of a superseded call so a slow earlier invoke can't
        // overwrite the latest state.
        if (callId !== callIdRef.current) return undefined;
        return result;
      } catch (err) {
        if (callId !== callIdRef.current) return undefined;
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        return undefined;
      } finally {
        if (callId === callIdRef.current) {
          setLoading(false);
        }
      }
    },
    [pluginId, channel]
  );

  return { invoke, loading, error };
}
