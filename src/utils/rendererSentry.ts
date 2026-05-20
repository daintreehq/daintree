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
//
// `Sentry.init` runs synchronously up front so the SDK is ready before the
// first React render. The consent snapshot then hydrates as a detached IPC
// continuation, so bootstrap is not blocked on a renderer→main round-trip.
// Until hydration completes the gate stays closed (`consentState` defaults
// to `"off"` / `!hasSeenPrompt`), which matches the consent semantics: ship
// nothing until we know the user opted in.
export function initRendererSentry(): void {
  if (initialized) return;
  initialized = true;

  // Subscribe BEFORE fetching the initial snapshot so a consent change that
  // lands during hydration (e.g. another window flipping the level) is not
  // lost in the gap between snapshot and subscription. If a broadcast fires
  // during hydration, it wins — the stale snapshot must not overwrite
  // fresher state.
  let liveUpdateReceived = false;
  consentUnsubscribe?.();
  consentUnsubscribe = window.electron?.privacy?.onTelemetryConsentChanged?.((payload) => {
    consentState = payload;
    liveUpdateReceived = true;
  });

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
    // Match the main-process ring size — renderer breadcrumbs merge into
    // crash payloads via IPC, but each process keeps its own buffer. See #7575.
    maxBreadcrumbs: 250,
  });

  // Hydrate the consent snapshot in the background; the gate stays closed
  // until this resolves. The post-hydration re-subscription drops the
  // `liveUpdateReceived` toggle since hydration is done — there is no
  // longer a stale snapshot that could overwrite a fresh broadcast.
  const snapshotPromise = window.electron?.sentry?.getConsentState?.();
  if (snapshotPromise) {
    snapshotPromise
      .then((state) => {
        if (state && !liveUpdateReceived) consentState = state;
        consentUnsubscribe?.();
        consentUnsubscribe = window.electron?.privacy?.onTelemetryConsentChanged?.((payload) => {
          consentState = payload;
        });
      })
      .catch(() => {
        // IPC may not be available (e.g. test environments). Leave gate closed.
      });
  }
}

export interface CaptureOptions {
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
}

/** Report an exception to Sentry. Safe to call from UI components — wraps
 * the renderer SDK so components don't import from the restricted
 * `@sentry/electron/renderer` module directly.
 *
 * Returns the Sentry event ID (a 32-char hex string) so callers can surface
 * it as a user-visible identifier engineers can look up in Sentry. Returns
 * `null` if the SDK isn't initialized (Sentry returns `""` in that case) or
 * if capture itself throws.
 */
export function captureRendererException(error: unknown, options?: CaptureOptions): string | null {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const eventId = Sentry.captureException(err, options);
    return eventId || null;
  } catch (sentryError) {
    // Last-resort sink: Sentry capture failed; logger/IPC may share the fault.
    // eslint-disable-next-line no-console
    console.error("[Renderer] Failed to report error to Sentry:", sentryError);
    return null;
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
