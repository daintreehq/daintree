import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { PluginInvokeError, PluginInvokeResult } from "@shared/types/plugin";

export interface UseHostChannelResult<TArgs, TResult> {
  /** Invoke the channel with a single typed payload. */
  invoke: (payload: TArgs) => void;
  /** True while an invocation is in flight. */
  isPending: boolean;
  /** The last successful result, or `null` before the first success. */
  data: TResult | null;
  /** The last structured failure, or `null` when the last call succeeded. */
  error: PluginInvokeError | null;
}

function isInvokeResult(value: unknown): value is PluginInvokeResult<unknown> {
  return typeof value === "object" && value !== null && "ok" in value;
}

/**
 * Typed renderer-side client for a plugin's typed host channel. Mirrors the
 * host-side {@link PluginChannelSchema} contract: `invoke(payload)` sends a
 * single typed payload and the host validates it, gates it on declared
 * permissions, and resolves a {@link PluginInvokeResult} envelope. Success
 * populates `data`; a structured failure (or a rejected invoke, surfaced as
 * `HANDLER_NOT_FOUND`) populates `error`.
 *
 * This is the foundation for the future `@daintreehq/plugin-sdk/react` package
 * but ships in-tree for now. `TArgs`/`TResult` are author-supplied — the
 * renderer holds no Zod schema, so validation is host-authoritative.
 */
export function useHostChannel<TArgs = unknown, TResult = unknown>(
  pluginId: string,
  channel: string
): UseHostChannelResult<TArgs, TResult> {
  const [isPending, startTransition] = useTransition();
  const [data, setData] = useState<TResult | null>(null);
  const [error, setError] = useState<PluginInvokeError | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Last-write-wins: a slower earlier invoke must not clobber a newer one's
  // result. Each call captures its id and bails if a later call superseded it.
  const callIdRef = useRef(0);

  const invoke = useCallback(
    (payload: TArgs) => {
      const callId = ++callIdRef.current;
      startTransition(async () => {
        try {
          const raw = await window.electron.plugin.invoke(pluginId, channel, payload);
          if (!isMountedRef.current || callId !== callIdRef.current) return;

          if (isInvokeResult(raw)) {
            if (raw.ok) {
              // Host is authoritative — the renderer holds no schema to refine `unknown` to TResult.
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TResult is author-supplied; validation is host-side
              setData(raw.data as TResult);
              setError(null);
            } else {
              // Clear stale data so a caller can't render an old payload next
              // to a fresh denial/validation error.
              setData(null);
              setError(raw);
            }
            return;
          }

          // An untyped channel resolves a raw value rather than an envelope —
          // treat it as success data so the hook still works against legacy
          // (non-schema) registrations.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TResult is author-supplied; validation is host-side
          setData(raw as TResult);
          setError(null);
        } catch {
          // A rejected invoke means dispatch never reached the typed handler:
          // the channel isn't registered (or the sender wasn't trusted). Typed
          // handlers that throw at runtime are returned as a HANDLER_ERROR
          // envelope above, so they don't land here.
          if (!isMountedRef.current || callId !== callIdRef.current) return;
          setData(null);
          setError({ ok: false, code: "HANDLER_NOT_FOUND", channel });
        }
      });
    },
    [pluginId, channel]
  );

  return { invoke, isPending, data, error };
}
