export type ConsentLevel = "off" | "errors" | "full";

export interface ConsentState {
  level: ConsentLevel;
  hasSeenPrompt: boolean;
}

export interface CaptureOptions {
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
}

let consentState: ConsentState = { level: "off", hasSeenPrompt: false };
let initialized = false;
let consentUnsubscribe: (() => void) | undefined;

// Queue for captureException calls that arrive before the dynamic import resolves.
// Consent is re-checked in beforeSend at send time, so queued events keep
// identical semantics to the pre-deferral behaviour.
type QueuedCapture = { error: unknown; options?: CaptureOptions };
let captureQueue: QueuedCapture[] | null = [];

// Resolves once the SDK dynamic import is complete.
let sdkCaptureException: ((error: unknown, options?: CaptureOptions) => string) | null = null;

// The renderer SDK auto-supplies a dummy DSN; events travel via IPC to main,
// which owns the real DSN, the HTTP transport, and path sanitization. The
// consent gate runs here in `beforeSend` to drop events before they leave
// the renderer — `Sentry.init` is not idempotent and `Sentry.close` is
// terminal, so runtime toggling must happen via this mutable closure.
//
// Init is kicked off fire-and-forget at bootstrap time so the ~130 KB SDK
// module graph is fetched in parallel with React hydration rather than on the
// serialised critical path. Until the import resolves, captureException calls
// are queued and replayed. Consent is re-checked in beforeSend at send time,
// so queued-then-replayed events keep identical semantics.
//
// Returns a promise that resolves once Sentry.init has run. Bootstrap callers
// may ignore it (fire-and-forget); tests may await it to assert post-init state.
export function initRendererSentry(): Promise<void> {
  if (initialized) return Promise.resolve();
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

  // Dynamic import removes ~130 KB from the synchronous first-render eval
  // path. The main process already deferred for exactly this reason
  // (globalServicesInit.ts). Events captured during the import window are
  // queued and replayed; consent is still checked in beforeSend at send time.
  return import("@sentry/electron/renderer").then((Sentry) => {
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

    sdkCaptureException = (error: unknown, options?: CaptureOptions) => {
      const err = error instanceof Error ? error : new Error(String(error));
      return Sentry.captureException(err, options);
    };

    // Replay any events that arrived before the SDK was ready.
    const queued = captureQueue ?? [];
    captureQueue = null;
    for (const item of queued) {
      try {
        sdkCaptureException(item.error, item.options);
      } catch {
        // Best-effort replay — drop silently if replay itself throws.
      }
    }

    // Hydrate the consent snapshot in the background; the gate stays closed
    // until this resolves. The post-hydration re-subscription drops the
    // `liveUpdateReceived` toggle since hydration is done — there is no
    // longer a stale snapshot that could overwrite a fresh broadcast.
    const snapshotPromise = window.electron?.sentry?.getConsentState?.();
    if (snapshotPromise) {
      snapshotPromise
        .then((state) => {
          if (state && !liveUpdateReceived) consentState = state;
          // Install the steady-state listener BEFORE unsubscribing the
          // hydration-aware one so we never have a coverage gap — if the
          // re-subscribe throws, the hydration listener stays active and
          // future broadcasts still update `consentState`.
          const steadyStateUnsubscribe = window.electron?.privacy?.onTelemetryConsentChanged?.(
            (payload) => {
              consentState = payload;
            }
          );
          consentUnsubscribe?.();
          consentUnsubscribe = steadyStateUnsubscribe;
        })
        .catch(() => {
          // IPC may not be available (e.g. test environments). Leave gate
          // closed; the hydration-aware listener registered above stays
          // active, so future broadcasts can still open it.
        });
    }
  });
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
    if (sdkCaptureException) {
      const eventId = sdkCaptureException(error, options);
      return eventId || null;
    }
    // SDK not yet loaded — queue for replay.
    if (captureQueue) {
      captureQueue.push({ error, options });
    }
    return null;
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
  sdkCaptureException = null;
  captureQueue = [];
}
