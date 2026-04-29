import type { EventRecord, EventFilterOptions } from "@shared/types";

export const eventInspectorClient = {
  getEvents: (): Promise<EventRecord[]> => {
    return window.electron.eventInspector.getEvents();
  },

  getFiltered: (filters: EventFilterOptions): Promise<EventRecord[]> => {
    return window.electron.eventInspector.getFiltered(filters);
  },

  clear: (): Promise<void> => {
    return window.electron.eventInspector.clear();
  },

  subscribe: (): void => {
    window.electron.eventInspector.subscribe();
  },

  unsubscribe: (): void => {
    window.electron.eventInspector.unsubscribe();
  },

  onEventBatch: (callback: (events: EventRecord[]) => void): (() => void) => {
    return window.electron.eventInspector.onEventBatch(callback);
  },
} as const;
