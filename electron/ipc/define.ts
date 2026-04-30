import { z } from "zod";
import {
  typedHandle,
  typedHandleValidated,
  typedHandleWithContext,
  typedHandleWithContextValidated,
} from "./utils.js";
import { ValidationError } from "./validationError.js";
import type { IpcContext } from "./types.js";
import type { IpcInvokeMap } from "../types/index.js";
import type { ForbidIpcEnvelopeKeys } from "../../shared/types/ipc/errors.js";

export { ValidationError };

type Channel = keyof IpcInvokeMap;
type Cleanup = () => void;

// Reject handler return types that overlap with the envelope discriminator.
// security.ts auto-wraps every handler return in {ok: true, data}; a handler
// returning {ok: false, ...} would be silently nested inside a success
// envelope. This constraint forces such handlers to throw instead.
type SafeResult<K extends Channel> = ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>;

type PlainHandler<K extends Channel> = (
  ...args: IpcInvokeMap[K]["args"]
) => Promise<SafeResult<K>> | SafeResult<K>;

type ContextHandler<K extends Channel> = (
  ctx: IpcContext,
  ...args: IpcInvokeMap[K]["args"]
) => Promise<SafeResult<K>> | SafeResult<K>;

type ValidatedPayloadHandler<K extends Channel, S extends z.ZodTypeAny> = (
  payload: z.output<S>
) => Promise<IpcInvokeMap[K]["result"]> | IpcInvokeMap[K]["result"];

type ValidatedContextPayloadHandler<K extends Channel, S extends z.ZodTypeAny> = (
  ctx: IpcContext,
  payload: z.output<S>
) => Promise<IpcInvokeMap[K]["result"]> | IpcInvokeMap[K]["result"];

export interface PlainOpSpec<K extends Channel> {
  channel: K;
  handler: PlainHandler<K>;
  withContext?: false;
  schema?: undefined;
}

export interface ContextOpSpec<K extends Channel> {
  channel: K;
  handler: ContextHandler<K>;
  withContext: true;
  schema?: undefined;
}

export interface PlainOpValidatedSpec<K extends Channel, S extends z.ZodTypeAny = z.ZodTypeAny> {
  channel: K;
  schema: S;
  handler: ValidatedPayloadHandler<K, S>;
  withContext?: false;
}

export interface ContextOpValidatedSpec<K extends Channel, S extends z.ZodTypeAny = z.ZodTypeAny> {
  channel: K;
  schema: S;
  handler: ValidatedContextPayloadHandler<K, S>;
  withContext: true;
}

export type OpSpec<K extends Channel = Channel> =
  | PlainOpSpec<K>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | PlainOpValidatedSpec<K, any>
  | ContextOpSpec<K>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | ContextOpValidatedSpec<K, any>;

/**
 * Declare a single IPC operation. The `channel` key is constrained to
 * `IpcInvokeMap`, so the handler signature is enforced against the shared
 * type map.
 */
export function op<K extends Channel>(channel: K, handler: PlainHandler<K>): PlainOpSpec<K>;
export function op<K extends Channel>(
  channel: K,
  handler: ContextHandler<K>,
  options: { withContext: true }
): ContextOpSpec<K>;
export function op<K extends Channel>(
  channel: K,
  handler: PlainHandler<K> | ContextHandler<K>,
  options?: { withContext: true }
): OpSpec<K> {
  if (options?.withContext) {
    return { channel, handler: handler as ContextHandler<K>, withContext: true };
  }
  return { channel, handler: handler as PlainHandler<K> };
}

/**
 * Declare an IPC operation whose first argument is parsed by a Zod schema
 * before the handler runs. On parse failure the wrapper logs the full Zod
 * issue list locally (main process only) and throws a {@link ValidationError}
 * with a sanitized message — the schema shape, field paths, and user-supplied
 * values are never propagated to the renderer.
 *
 * The handler receives `z.output<S>`, so transform-bearing schemas pass their
 * post-parse value type into the body.
 *
 * Use this in place of {@link op} when an inbound payload should be validated
 * at the IPC boundary. Semantic checks (path containment, access, etc.) still
 * belong inside the handler — `opValidated` only enforces structural
 * validation.
 */
export function opValidated<K extends Channel, S extends z.ZodTypeAny>(
  channel: K,
  schema: S,
  handler: ValidatedPayloadHandler<K, S>
): PlainOpValidatedSpec<K, S>;
export function opValidated<K extends Channel, S extends z.ZodTypeAny>(
  channel: K,
  schema: S,
  handler: ValidatedContextPayloadHandler<K, S>,
  options: { withContext: true }
): ContextOpValidatedSpec<K, S>;
export function opValidated<K extends Channel, S extends z.ZodTypeAny>(
  channel: K,
  schema: S,
  handler: ValidatedPayloadHandler<K, S> | ValidatedContextPayloadHandler<K, S>,
  options?: { withContext: true }
): PlainOpValidatedSpec<K, S> | ContextOpValidatedSpec<K, S> {
  if (options?.withContext) {
    return {
      channel,
      schema,
      handler: handler as ValidatedContextPayloadHandler<K, S>,
      withContext: true,
    };
  }
  return {
    channel,
    schema,
    handler: handler as ValidatedPayloadHandler<K, S>,
  };
}

// Using `any` here so the operation map accepts heterogeneous channel keys;
// the individual `op()` calls still enforce the per-channel handler signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpMap = Record<string, OpSpec<any>>;

export type InvokerFn = (channel: string, ...args: unknown[]) => Promise<unknown>;

export type PreloadBindings<Ops extends OpMap> = {
  [M in keyof Ops]: Ops[M] extends OpSpec<infer K extends Channel>
    ? (...args: IpcInvokeMap[K]["args"]) => Promise<IpcInvokeMap[K]["result"]>
    : never;
};

export interface IpcNamespace<Ops extends OpMap> {
  name: string;
  ops: Ops;
  /** Wire `ipcMain.handle` for every operation. Returns a cleanup function. */
  register(): Cleanup;
  /** List of channel strings this namespace owns. */
  channels(): string[];
  /**
   * Build the preload-side bindings object. Pass an invoker that wraps
   * `ipcRenderer.invoke` (typically one that unwraps envelopes). The returned
   * object mirrors the `ops` shape, with each method typed against its channel.
   */
  preloadBindings(invoke: InvokerFn): PreloadBindings<Ops>;
}

/**
 * Declare-once IPC namespace. Colocates channel strings, handler
 * implementations, and (via {@link IpcNamespace.preloadBindings}) the
 * preload-side binding shape in one definition site.
 *
 * Use {@link op} for each entry so the handler signature is constrained by
 * the `IpcInvokeMap` type for the declared channel. Use {@link opValidated}
 * when the first argument should be parsed by a Zod schema before the handler
 * body runs.
 */
export function defineIpcNamespace<const Ops extends OpMap>(input: {
  name: string;
  ops: Ops;
}): IpcNamespace<Ops> {
  const { name, ops } = input;

  return {
    name,
    ops,
    register(): Cleanup {
      const cleanups: Cleanup[] = [];
      try {
        for (const method of Object.keys(ops)) {
          const spec = ops[method]!;
          if (spec.schema) {
            if (spec.withContext) {
              cleanups.push(
                typedHandleWithContextValidated(spec.channel, spec.schema, spec.handler)
              );
            } else {
              cleanups.push(typedHandleValidated(spec.channel, spec.schema, spec.handler));
            }
          } else if (spec.withContext) {
            cleanups.push(typedHandleWithContext(spec.channel, spec.handler));
          } else {
            cleanups.push(typedHandle(spec.channel, spec.handler));
          }
        }
      } catch (error) {
        // Partial-unwind: if any registration throws (e.g. duplicate channel),
        // tear down the handlers we already installed so they don't outlive
        // the failed register() call.
        for (const cleanup of cleanups.reverse()) {
          try {
            cleanup();
          } catch (cleanupError) {
            console.error(
              `[ipc] Cleanup during failed register() for namespace "${name}":`,
              cleanupError
            );
          }
        }
        throw error;
      }
      return () => {
        for (const cleanup of cleanups.reverse()) {
          try {
            cleanup();
          } catch (error) {
            console.error(`[ipc] Cleanup failed for namespace "${name}":`, error);
          }
        }
      };
    },
    channels(): string[] {
      return Object.values(ops).map((spec) => spec.channel);
    },
    preloadBindings(invoke: InvokerFn): PreloadBindings<Ops> {
      const bindings: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      for (const method of Object.keys(ops)) {
        const channel = ops[method]!.channel;
        bindings[method] = (...args: unknown[]) => invoke(channel, ...args);
      }
      return bindings as unknown as PreloadBindings<Ops>;
    },
  };
}
