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

  const invoke = useCallback(
    (payload: TArgs) => {
      startTransition(async () => {
        try {
          const raw = await window.electron.plugin.invoke(pluginId, channel, payload);
          if (!isMountedRef.current) return;

          if (isInvokeResult(raw)) {
            if (raw.ok) {
              // Host is authoritative — the renderer holds no schema to refine `unknown` to TResult.
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TResult is author-supplied; validation is host-side
              setData(raw.data as TResult);
              setError(null);
            } else {
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
          // A rejected invoke means the channel never reached its typed
          // dispatch path (missing handler, untrusted sender, or a handler
          // that threw). Surface it as the structured HANDLER_NOT_FOUND code.
          if (!isMountedRef.current) return;
          setError({ ok: false, code: "HANDLER_NOT_FOUND", channel });
        }
      });
    },
    [pluginId, channel]
  );

  return { invoke, isPending, data, error };
}
