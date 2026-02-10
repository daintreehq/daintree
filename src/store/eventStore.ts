import { create, type StateCreator } from "zustand";
import type { EventRecord, EventFilterOptions, EventCategory, EventPayload } from "@shared/types";

export type { EventRecord, EventFilterOptions, EventCategory, EventPayload };

interface EventsState {
  events: EventRecord[];
  isOpen: boolean;
  filters: EventFilterOptions;
  selectedEventId: string | null;
  autoScroll: boolean;

  addEvent: (event: EventRecord) => void;
  addEvents: (events: EventRecord[]) => void;
  setEvents: (events: EventRecord[]) => void;
  clearEvents: () => void;
  togglePanel: () => void;
  setOpen: (open: boolean) => void;
  setFilters: (filters: Partial<EventFilterOptions>) => void;
  clearFilters: () => void;
  setSelectedEvent: (id: string | null) => void;
  setAutoScroll: (autoScroll: boolean) => void;
  reset: () => void;

  getFilteredEvents: () => EventRecord[];
}

const MAX_EVENTS = 1000;

const createEventsStore: StateCreator<EventsState> = (set, get) => ({
  events: [],
  isOpen: false,
  filters: {},
  selectedEventId: null,
  autoScroll: true,

  addEvent: (event) =>
    set((state) => {
      if (state.events.some((e) => e.id === event.id)) {
        return state;
      }

      const newEvents = [...state.events, event];
      if (newEvents.length > MAX_EVENTS) {
        return { events: newEvents.slice(-MAX_EVENTS) };
      }
      return { events: newEvents };
    }),

  addEvents: (events) =>
    set((state) => {
      const existingIds = new Set(state.events.map((e) => e.id));
      const newEvents = events.filter((e) => {
        if (existingIds.has(e.id)) {
          return false;
        }
        existingIds.add(e.id);
        return true;
      });
      const merged = [...state.events, ...newEvents];

      if (merged.length > MAX_EVENTS) {
        return { events: merged.slice(-MAX_EVENTS) };
      }
      return { events: merged };
    }),

  setEvents: (events) => {
    const clamped = events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
    set({ events: clamped });
  },

  clearEvents: () => set({ events: [], selectedEventId: null }),

  togglePanel: () => set((state) => ({ isOpen: !state.isOpen })),

  setOpen: (isOpen) => set({ isOpen }),

  setFilters: (newFilters) =>
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
    })),

  clearFilters: () => set({ filters: {} }),

  setSelectedEvent: (id) => set({ selectedEventId: id }),

  setAutoScroll: (autoScroll) => set({ autoScroll }),

  reset: () =>
    set({
      events: [],
      isOpen: false,
      filters: {},
      selectedEventId: null,
      autoScroll: true,
    }),

  getFilteredEvents: () => {
    const state = get();
    let filtered = state.events;

    const { filters } = state;

    if (filters.types && filters.types.length > 0) {
      filtered = filtered.filter((event) => filters.types!.includes(event.type));
    }

    if (filters.category) {
      filtered = filtered.filter((event) => event.category === filters.category);
    }

    if (filters.categories && filters.categories.length > 0) {
      filtered = filtered.filter((event) => filters.categories!.includes(event.category));
    }

    if (filters.after !== undefined) {
      filtered = filtered.filter((event) => event.timestamp >= filters.after!);
    }
    if (filters.before !== undefined) {
      filtered = filtered.filter((event) => event.timestamp <= filters.before!);
    }

    if (filters.worktreeId) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.worktreeId === filters.worktreeId;
      });
    }

    if (filters.agentId) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.agentId === filters.agentId;
      });
    }

    if (filters.taskId) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.taskId === filters.taskId;
      });
    }

    if (filters.traceId) {
      const normalizedFilter = filters.traceId.toLowerCase();
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.traceId?.toLowerCase() === normalizedFilter;
      });
    }

    if (filters.runId) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.runId === filters.runId;
      });
    }

    if (filters.terminalId) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.terminalId === filters.terminalId;
      });
    }

    if (filters.issueNumber !== undefined) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.issueNumber === filters.issueNumber;
      });
    }

    if (filters.prNumber !== undefined) {
      filtered = filtered.filter((event) => {
        const payload = event.payload;
        return payload && payload.prNumber === filters.prNumber;
      });
    }

    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      filtered = filtered.filter((event) => {
        if (event.type.toLowerCase().includes(searchLower)) {
          return true;
        }
        try {
          const payloadStr = JSON.stringify(event.payload).toLowerCase();
          return payloadStr.includes(searchLower);
        } catch {
          return false;
        }
      });
    }

    return filtered;
  },
});

export const useEventStore = create<EventsState>(createEventsStore);
