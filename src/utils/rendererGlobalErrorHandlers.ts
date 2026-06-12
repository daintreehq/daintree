import { captureRendererException } from "@/utils/rendererSentry";
import { useErrorStore, type ErrorType } from "@/store/errorStore";
import { logError } from "@/utils/logger";
import {
  getErrorMessage,
  classifyError,
  getRetryabilityFromError,
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

// Chromium emits these as a bare ErrorEvent (message only, no `error` object,
// no stack) when a ResizeObserver callback triggers layout that defers
// notifications to the next frame. They are harmless — the leftover
// notifications are delivered then. Our own observers already rAF-defer
// (useResizeObserverRaf, TwoPaneSplitLayout) and debounce (XtermAdapter); the
// residual warning comes from xterm v6's internal scrollable-element layout and
// is not reducible from app code. Surfacing it as a "Renderer Error" only
// trains users to ignore the error panel.
const BENIGN_ERROR_MESSAGE_PATTERNS = [
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
];

function isBenignBrowserError(message: string | undefined): boolean {
  if (!message) return false;
  return BENIGN_ERROR_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern));
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

export function reportRendererGlobalError(
  kind: "unhandledrejection" | "error",
  rawError: unknown,
  metadata: { message?: string; filename?: string; lineno?: number; colno?: number }
): void {
  if (reentrant) {
    // Logger may itself be the source of the re-entrant error; console is the
    // last-resort sink in the global error handler.
    // eslint-disable-next-line no-console
    console.error(`[Renderer] Re-entrant ${kind} suppressed:`, rawError);
    return;
  }

  reentrant = true;
  try {
    const message =
      metadata.message || getErrorMessage(rawError) || `Unhandled ${kind} (no reason provided)`;
    const category = classifyError(rawError);
    const storeType = mapCategoryToStoreType(category);
    const retryability = getRetryabilityFromError(rawError);
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
        retryability,
        correlationId,
      });
    } catch (storeError) {
      // Last-resort sink: the error store has already failed.
      // eslint-disable-next-line no-console
      console.error("[Renderer] Failed to add error to store:", storeError);
    }

    captureRendererException(rawError instanceof Error ? rawError : new Error(message), {
      tags: { source: kind === "unhandledrejection" ? "renderer-rejection" : "renderer-error" },
      extra: {
        correlationId,
        filename: metadata.filename,
        lineno: metadata.lineno,
        colno: metadata.colno,
      },
    });

    try {
      logError(`[${source}] ${message}`, rawError, {
        correlationId,
        kind,
        filename: metadata.filename,
        lineno: metadata.lineno,
        colno: metadata.colno,
      });
    } catch {
      // Last-resort sink: the logger itself failed.
      // eslint-disable-next-line no-console
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

  // A real thrown error always populates `event.error`; the benign browser
  // warnings only ever arrive as a message-only event, so gate on both.
  if (!event.error && isBenignBrowserError(event.message)) return;

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
