/**
 * Live telemetry preview — session-scoped mirror of outbound payloads.
 *
 * When the user enables preview mode, the main process clones every
 * sanitised Sentry event and analytics `trackEvent` call and streams it to
 * the renderer so the user can inspect exactly what would leave their
 * machine. Preview mode is not persisted — it resets at app launch.
 */

export type SanitizedTelemetryEventKind = "sentry" | "analytics";

export interface SanitizedSentryEvent {
  id: string;
  kind: "sentry";
  timestamp: number;
  /** Derived label for the list row — exception type or message snippet. */
  label: string;
  /** The post-sanitisation event payload that Sentry's transport would send. */
  payload: Record<string, unknown>;
}

export interface SanitizedAnalyticsEvent {
  id: string;
  kind: "analytics";
  timestamp: number;
  /** Analytics event name (e.g. `onboarding.completed`). */
  label: string;
  /** The post-sanitisation event payload handed to Sentry's capture. */
  payload: Record<string, unknown>;
}

export type SanitizedTelemetryEvent = SanitizedSentryEvent | SanitizedAnalyticsEvent;

export interface TelemetryPreviewState {
  active: boolean;
}
