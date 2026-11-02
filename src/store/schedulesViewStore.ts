import { create } from "zustand";

/** Where an opening of the Schedules tab lands: the list, or one schedule's history. */
export interface SchedulesViewRequest {
  scheduleId: string | null;
  /** Rises with every opening, so asking again for the page already showing still lands. */
  seq: number;
}

interface SchedulesViewState {
  request: SchedulesViewRequest;
  /**
   * The last opening the tab landed on. Project settings unmounts the tab when
   * it leaves project scope, so this lives here: a remount never lands again
   * on an opening it already acted on.
   */
  landedSeq: number;
  /** The Schedules tab is in front: Project settings is open on it. */
  showing: boolean;
  open: (scheduleId?: string | null) => void;
  markLanded: (seq: number) => void;
  setShowing: (showing: boolean) => void;
}

export const useSchedulesViewStore = create<SchedulesViewState>()((set) => ({
  request: { scheduleId: null, seq: 0 },
  landedSeq: 0,
  showing: false,
  open: (scheduleId = null) =>
    set((state) => ({ request: { scheduleId, seq: state.request.seq + 1 } })),
  markLanded: (seq) => set((state) => (seq > state.landedSeq ? { landedSeq: seq } : state)),
  setShowing: (showing) => set({ showing }),
}));
