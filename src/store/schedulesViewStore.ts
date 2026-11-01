import { create } from "zustand";

/** Where an opening of the Schedules view lands: the list, or one schedule's page. */
export interface SchedulesViewRequest {
  scheduleId: string | null;
  /** Rises with every opening, so asking again for the page already showing still lands. */
  seq: number;
}

interface SchedulesViewState {
  isOpen: boolean;
  request: SchedulesViewRequest;
  open: (scheduleId?: string | null) => void;
  close: () => void;
}

export const useSchedulesViewStore = create<SchedulesViewState>()((set) => ({
  isOpen: false,
  request: { scheduleId: null, seq: 0 },
  open: (scheduleId = null) =>
    set((state) => ({ isOpen: true, request: { scheduleId, seq: state.request.seq + 1 } })),
  close: () => set({ isOpen: false }),
}));
