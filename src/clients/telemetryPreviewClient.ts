import type { SanitizedTelemetryEvent, TelemetryPreviewState } from "@shared/types";

export const telemetryPreviewClient = {
  getState: (): Promise<TelemetryPreviewState> => {
    return window.electron.telemetry.preview.getState();
  },

  toggle: (active: boolean): Promise<TelemetryPreviewState> => {
    return window.electron.telemetry.preview.toggle(active);
  },

  subscribe: (): void => {
    window.electron.telemetry.preview.subscribe();
  },

  unsubscribe: (): void => {
    window.electron.telemetry.preview.unsubscribe();
  },

  onEventBatch: (callback: (events: SanitizedTelemetryEvent[]) => void): (() => void) => {
    return window.electron.telemetry.preview.onEventBatch(callback);
  },

  onStateChanged: (callback: (state: TelemetryPreviewState) => void): (() => void) => {
    return window.electron.telemetry.preview.onStateChanged(callback);
  },
} as const;
