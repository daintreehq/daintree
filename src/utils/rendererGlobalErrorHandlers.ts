import * as Sentry from "@sentry/electron/renderer";
import { useErrorStore, type ErrorType } from "@/store/errorStore";
import { logError } from "@/utils/logger";
import {
  getErrorMessage,
  classifyError,
  isTransientError,
  type ErrorCategory,
} from "@/utils/errorContext";

let registered = false;
let reentrant = false;

function isAbortRejection(reason: unknown): boolean {
  if (reason instanceof DOMException && reason.name === "AbortError") return true;
  if (reason instanceof Error && reason.name === "AbortError") return true;
  if (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    (reason as { name: unknown }).name === "AbortError"
  )
    return true;
  return false;
}

function mapCategoryToStoreType(category: ErrorCategory): ErrorType {
  switch (category) {
    case "network":
      return "network";
    case "filesystem":
      return "filesystem";
    case "git":
      return "git";
    case "process":
      return "process";
    default:
      return "unknown";
  }
}

function getStack(reason: unknown): string | undefined {
  if (reason instanceof Error && reason.stack) return reason.stack;
  return undefined;
}

function reportRendererGlobalError(
  kind: "unhandledrejection" | "error",
  rawError: unknown,
  metadata: { message?: string; filename?: string; lineno?: number; colno?: number }
): void {
  if (reentrant) {
    console.error(`[Renderer] Re-entrant ${kind} suppressed:`, rawError);
    return;
  }

  reentrant = true;
  try {
    const message =
      metadata.message || getErrorMessage(rawError) || `Unhandled ${kind} (no reason provided)`;
    const category = classifyError(rawError);
    const storeType = mapCategoryToStoreType(category);
    const transient = isTransientError(rawError);
    const stack = getStack(rawError);
    const correlationId = crypto.randomUUID();

    const source = kind === "unhandledrejection" ? "Renderer Promise Rejection" : "Renderer Error";

    let details = stack ?? "";
    if (metadata.filename) {
      const location = [
        metadata.filename,
        metadata.lineno != null ? `:${metadata.lineno}` : "",
        metadata.colno != null ? `:${metadata.colno}` : "",
      ].join("");
      details = details ? `${details}\n\nLocation: ${location}` : `Location: ${location}`;
    }

    try {
      useErrorStore.getState().addError({
        type: storeType,
        message,
        details: details || undefined,
        source,
        context: metadata.filename ? { filePath: metadata.filename } : undefined,
        isTransient: transient,
        correlationId,
      });
    } catch (storeError) {
      console.error("[Renderer] Failed to add error to store:", storeError);
    }

    try {
      const sentryError = rawError instanceof Error ? rawError : new Error(message);
      Sentry.captureException(sentryError, {
        tags: { source: kind === "unhandledrejection" ? "renderer-rejection" : "renderer-error" },
        extra: {
          correlationId,
          filename: metadata.filename,
          lineno: metadata.lineno,
          colno: metadata.colno,
        },
      });
    } catch (sentryError) {
      console.error("[Renderer] Failed to report error to Sentry:", sentryError);
    }

    try {
      logError(`[${source}] ${message}`, rawError, {
        correlationId,
        kind,
        filename: metadata.filename,
        lineno: metadata.lineno,
        colno: metadata.colno,
      });
    } catch {
      console.error(`[Renderer] Failed to log ${kind}:`, rawError);
    }
  } finally {
    reentrant = false;
  }
}

function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  const { reason } = event;

  if (isAbortRejection(reason)) return;

  reportRendererGlobalError("unhandledrejection", reason, {
    message: reason != null ? getErrorMessage(reason) : "Unhandled promise rejection (no reason)",
  });
}

function handleWindowError(event: ErrorEvent): void {
  if (!event.error && !event.message) return;

  reportRendererGlobalError("error", event.error ?? event.message, {
    message: event.message,
    filename: event.filename || undefined,
    lineno: event.lineno || undefined,
    colno: event.colno || undefined,
  });
}

export function registerRendererGlobalErrorHandlers(): () => void {
  if (registered) return () => {};

  registered = true;
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  window.addEventListener("error", handleWindowError);

  return () => {
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    window.removeEventListener("error", handleWindowError);
    registered = false;
  };
}
