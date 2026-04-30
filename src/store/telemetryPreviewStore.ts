import { create, type StateCreator } from "zustand";
import type { SanitizedTelemetryEvent } from "@shared/types";

interface TelemetryPreviewStoreState {
  active: boolean;
  events: SanitizedTelemetryEvent[];
  selectedEventId: string | null;

  setActive: (active: boolean) => void;
  appendEvents: (events: SanitizedTelemetryEvent[]) => void;
  clearEvents: () => void;
  setSelectedEvent: (id: string | null) => void;
  reset: () => void;
}

export const TELEMETRY_PREVIEW_MAX_EVENTS = 200;

const createStore: StateCreator<TelemetryPreviewStoreState> = (set) => ({
  active: false,
  events: [],
  selectedEventId: null,

  setActive: (active) =>
    set((state) => {
      if (state.active === active) return state;
      return { active };
    }),

  appendEvents: (incoming) =>
    set((state) => {
      if (incoming.length === 0) return state;
      const existingIds = new Set(state.events.map((e) => e.id));
      const next = state.events.slice();
      for (const event of incoming) {
        if (existingIds.has(event.id)) continue;
        existingIds.add(event.id);
        next.push(event);
      }
      if (next.length > TELEMETRY_PREVIEW_MAX_EVENTS) {
        const trimmed = next.slice(-TELEMETRY_PREVIEW_MAX_EVENTS);
        // If the selected row was in the evicted head, the detail pane would
        // silently blank out while the list still renders rows — reconcile
        // the selection to `null` so the empty-state prompt is shown.
        const stillVisible =
          state.selectedEventId !== null && trimmed.some((e) => e.id === state.selectedEventId);
        return {
          events: trimmed,
          selectedEventId: stillVisible ? state.selectedEventId : null,
        };
      }
      return { events: next };
    }),

  clearEvents: () => set({ events: [], selectedEventId: null }),

  setSelectedEvent: (id) => set({ selectedEventId: id }),

  reset: () => set({ active: false, events: [], selectedEventId: null }),
});

export const useTelemetryPreviewStore = create<TelemetryPreviewStoreState>(createStore);
