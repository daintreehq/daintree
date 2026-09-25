import type {
  IpcEnvelope,
  IpcErrorEnvelope,
  SerializedError,
} from "../../../shared/types/ipc/errors.js";
import type { AppErrorCode } from "../../../shared/types/appError.js";
import {
  deserializeError,
  serializeError,
  wrapSuccess,
} from "../../../shared/utils/ipcErrorSerialization.js";
import { AppError } from "../../utils/errorTypes.js";

/**
 * Errors cross the link in the same envelope `security.ts` produces for local
 * IPC. Stacks describe the sending machine's source tree and help nobody on
 * the other side, so they are dropped before anything is sent.
 */
function stripStacks(error: SerializedError): SerializedError {
  const out: SerializedError = { ...error, stack: undefined };
  if (out.cause) out.cause = stripStacks(out.cause);
  return out;
}

export function linkErrorEnvelope(error: unknown): IpcErrorEnvelope {
  return { __daintreeIpcEnvelope: true, ok: false, error: stripStacks(serializeError(error)) };
}

export function linkSuccessEnvelope(data: unknown): IpcEnvelope {
  return wrapSuccess(data);
}

export function appErrorEnvelope(
  code: AppErrorCode,
  message: string,
  userMessage?: string
): IpcErrorEnvelope {
  return linkErrorEnvelope(new AppError({ code, message, userMessage }));
}

export function hostDisconnectedEnvelope(detail: string): IpcErrorEnvelope {
  return appErrorEnvelope(
    "HOST_DISCONNECTED",
    `Link to host closed: ${detail}`,
    "The connection to the host was lost."
  );
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** A peer-supplied error, minus anything `deserializeError` would assign unsafely. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizePeerError(error: SerializedError, depth = 0): SerializedError {
  const out: SerializedError = { ...error, stack: undefined };
  out.properties = isRecord(out.properties)
    ? Object.fromEntries(Object.entries(out.properties).filter(([key]) => !UNSAFE_KEYS.has(key)))
    : undefined;
  if (!isRecord(out.context)) out.context = undefined;
  out.cause =
    isRecord(out.cause) && depth < 8
      ? sanitizePeerError(
          {
            ...out.cause,
            name: String(out.cause.name ?? "Error"),
            message: String(out.cause.message ?? ""),
          },
          depth + 1
        )
      : undefined;
  return out;
}

/** Unwrap an envelope the peer sent back: the data, or the reconstructed error thrown. */
export function unwrapEnvelope(envelope: IpcEnvelope): unknown {
  if (envelope.ok) return envelope.data;
  throw deserializeError(sanitizePeerError(envelope.error));
}
