import * as Sentry from "@sentry/electron/renderer";

export type ConsentLevel = "off" | "errors" | "full";

export interface ConsentState {
  level: ConsentLevel;
  hasSeenPrompt: boolean;
}

let consentState: ConsentState = { level: "off", hasSeenPrompt: false };
let initialized = false;
let consentUnsubscribe: (() => void) | undefined;

// The renderer SDK auto-supplies a dummy DSN; events travel via IPC to main,
// which owns the real DSN, the HTTP transport, and path sanitization. The
// consent gate runs here in `beforeSend` to drop events before they leave
// the renderer — `Sentry.init` is not idempotent and `Sentry.close` is
// terminal, so runtime toggling must happen via this mutable closure.
export async function initRendererSentry(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // Subscribe BEFORE fetching the initial snapshot so a consent change that
  // lands during the await (e.g. another window flipping the level) is not
  // lost in the gap between snapshot and subscription. If a broadcast fires
  // during hydration, it wins — we must not overwrite fresher state with the
  // stale snapshot.
  let liveUpdateReceived = false;
  consentUnsubscribe?.();
  consentUnsubscribe = window.electron?.privacy?.onTelemetryConsentChanged?.((payload) => {
    consentState = payload;
    liveUpdateReceived = true;
  });

  try {
    const state = await window.electron?.sentry?.getConsentState();
    if (state && !liveUpdateReceived) consentState = state;
  } catch {
    // IPC may not be available (e.g. test environments). Leave gate closed.
  }

  Sentry.init({
    // globalHandlersIntegration would double-capture with our existing
    // window.error / unhandledrejection listeners (rendererGlobalErrorHandlers).
    // The React error boundary and root callbacks call captureException
    // directly, so we own every entrypoint deliberately.
    integrations: (defaults) => defaults.filter((i) => i.name !== "GlobalHandlers"),
    beforeSend: (event) => {
      if (!consentState.hasSeenPrompt || consentState.level === "off") return null;
      return event;
    },
    beforeBreadcrumb: (breadcrumb) => {
      if (!consentState.hasSeenPrompt || consentState.level === "off") return null;
      return breadcrumb;
    },
  });

  consentUnsubscribe?.();
  consentUnsubscribe = window.electron?.privacy?.onTelemetryConsentChanged?.((payload) => {
    consentState = payload;
  });
}

export interface CaptureOptions {
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
}

/** Report an exception to Sentry. Safe to call from UI components — wraps
 * the renderer SDK so components don't import from the restricted
 * `@sentry/electron/renderer` module directly.
 */
export function captureRendererException(error: unknown, options?: CaptureOptions): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    Sentry.captureException(err, options);
  } catch (sentryError) {
    console.error("[Renderer] Failed to report error to Sentry:", sentryError);
  }
}

export function updateRendererSentryConsent(level: ConsentLevel, hasSeenPrompt: boolean): void {
  consentState = { level, hasSeenPrompt };
}

export function getRendererSentryConsent(): ConsentState {
  return consentState;
}

/** Test-only reset to allow re-initialization between tests. */
export function _resetRendererSentryForTest(): void {
  initialized = false;
  consentState = { level: "off", hasSeenPrompt: false };
  consentUnsubscribe?.();
  consentUnsubscribe = undefined;
}
