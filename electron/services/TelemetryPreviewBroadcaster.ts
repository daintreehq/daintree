/**
 * Thin module-level bridge between `TelemetryService` (which taps sanitised
 * events) and the IPC handler (which batches and streams them to renderers).
 *
 * Kept in its own file so `TelemetryService` does not import from
 * `electron/ipc/**` and invert the service/handler dependency direction.
 */
import type { SanitizedTelemetryEvent } from "../../shared/types/ipc/telemetryPreview.js";

let previewActive = false;
let enqueue: ((event: SanitizedTelemetryEvent) => void) | null = null;

export function isTelemetryPreviewActive(): boolean {
  return previewActive;
}

export function setTelemetryPreviewActive(active: boolean): void {
  previewActive = active;
}

export function setTelemetryPreviewEnqueue(
  fn: ((event: SanitizedTelemetryEvent) => void) | null
): void {
  enqueue = fn;
}

/**
 * Called from the Sentry `beforeSend` hook and from `trackEvent` after the
 * analytics payload is constructed. Must never throw — telemetry failures
 * must never escape into product code paths.
 */
export function emitTelemetryPreview(event: SanitizedTelemetryEvent): void {
  if (!previewActive) return;
  if (!enqueue) return;
  try {
    enqueue(event);
  } catch {
    // swallow — preview must never affect production telemetry
  }
}
