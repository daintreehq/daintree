import { reportRendererGlobalError } from "@/utils/rendererGlobalErrorHandlers";

interface SafeFireAndForgetOptions {
  context?: string;
}

export function safeFireAndForget<T>(
  promise: Promise<T>,
  options?: SafeFireAndForgetOptions
): void {
  // why: capture the call site synchronously — once the microtask boundary is
  // crossed inside .catch, the original stack is gone and rejections appear to
  // originate inside this helper.
  const callsiteAnchor = new Error("safeFireAndForget call site");
  if (typeof Error.captureStackTrace === "function") {
    Error.captureStackTrace(callsiteAnchor, safeFireAndForget);
  }

  promise.catch((reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const anchorStack = callsiteAnchor.stack;
    // why: guard against re-entry — if the same Error reaches us twice
    // (shared error constant, broadcast rejection), only stitch the anchor
    // once so concurrent callers don't end up sharing each other's call
    // sites in the Sentry report.
    if (anchorStack && !error.stack?.includes("Caused by:")) {
      error.stack = error.stack ? `${error.stack}\nCaused by: ${anchorStack}` : anchorStack;
    }
    reportRendererGlobalError("unhandledrejection", error, {
      message: options?.context ?? error.message,
    });
  });
}
