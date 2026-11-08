import { create } from "zustand";
import type { Schedule } from "@shared/types/scheduledRuns";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";
import type { ScheduleStarter } from "@/components/Schedules/scheduleStarters";

/** Where an opening of the Schedules tab lands: the list, or one schedule's history. */
export interface SchedulesViewRequest {
  scheduleId: string | null;
  /** Rises with every opening, so asking again for the page already showing still lands. */
  seq: number;
}

/**
 * The schedule editor, open over Project settings. It is hosted outside
 * Settings, so nothing Settings does (a scope change, another page, a close)
 * can unmount a draft without asking.
 */
export interface ScheduleEditorOpening {
  /** Null for a new schedule; otherwise the schedule as it was when the editor opened. */
  schedule: Schedule | null;
  /** The starter a new schedule was opened from; always null when `schedule` is set. */
  starter: ScheduleStarter | null;
  /** Rises with each opening, so the next one starts from the saved schedule. */
  key: number;
  /** False while the editor animates out; the opening is cleared once it has gone. */
  open: boolean;
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
  editor: ScheduleEditorOpening | null;
  /** What main answered the editor's last save or delete with, for the list to fold in at once. */
  editorAnswer: SchedulesSnapshot | null;
  open: (scheduleId?: string | null) => void;
  markLanded: (seq: number) => void;
  setShowing: (showing: boolean) => void;
  openEditor: (schedule: Schedule | null, starter?: ScheduleStarter | null) => void;
  closeEditor: () => void;
  clearEditor: () => void;
  answerEditor: (snapshot: SchedulesSnapshot) => void;
}

let openings = 0;

export const useSchedulesViewStore = create<SchedulesViewState>()((set) => ({
  request: { scheduleId: null, seq: 0 },
  landedSeq: 0,
  showing: false,
  editor: null,
  editorAnswer: null,
  open: (scheduleId = null) =>
    set((state) => ({ request: { scheduleId, seq: state.request.seq + 1 } })),
  markLanded: (seq) => set((state) => (seq > state.landedSeq ? { landedSeq: seq } : state)),
  setShowing: (showing) => set({ showing }),
  // One editor at a time: an opening never replaces a draft. Only an outside
  // close of Settings, reopened over the editor, could ask while one is up.
  openEditor: (schedule, starter = null) =>
    set((state) =>
      state.editor
        ? state
        : {
            editor: {
              schedule,
              starter: schedule ? null : starter,
              key: ++openings,
              open: true,
            },
          }
    ),
  closeEditor: () =>
    set((state) => (state.editor?.open ? { editor: { ...state.editor, open: false } } : state)),
  clearEditor: () => set({ editor: null }),
  answerEditor: (snapshot) => set({ editorAnswer: snapshot }),
}));

/** An edit is open, or a Schedules tab is in front: a run's notification leaves both alone. */
export function isSchedulesViewHeld(): boolean {
  const { showing, editor } = useSchedulesViewStore.getState();
  return showing || editor !== null;
}
