import { create } from "zustand";
import type { ProjectOnlineOnlyFiles } from "@shared/types/onlineOnlyFiles";
import { hasOnlineOnlyEntries } from "@shared/utils/onlineOnlyFiles";

interface OnlineOnlyFilesState {
  /** `asking` until `watch` first answers, so nothing is read into a project not yet heard about. */
  phase: "idle" | "asking" | "answered";
  /** This view's project, or null when none of this applies to it. */
  files: ProjectOnlineOnlyFiles | null;
  /** The newest revision taken since the last `ask`. A push can overtake the `watch` answer. */
  revision: number;
  /** A new host process counts revisions from the start again, so each ask starts over. */
  ask: () => void;
  answer: (files: ProjectOnlineOnlyFiles | null) => void;
  reset: () => void;
}

export const useOnlineOnlyFilesStore = create<OnlineOnlyFilesState>((set, get) => ({
  phase: "idle",
  files: null,
  revision: 0,
  ask: () => set((s) => ({ phase: s.phase === "answered" ? s.phase : "asking", revision: 0 })),
  answer: (files) => {
    if (files === null) {
      // A push can't be null, so this is `watch` saying the project doesn't qualify.
      set({ phase: "answered", files: null, revision: 0 });
      return;
    }
    if (files.revision <= get().revision) return;
    set({ phase: "answered", files, revision: files.revision });
  },
  reset: () => set({ phase: "idle", files: null, revision: 0 }),
}));

export function selectOnlineOnlyOutstanding(state: OnlineOnlyFilesState): boolean {
  return hasOnlineOnlyEntries(state.files?.git) || hasOnlineOnlyEntries(state.files?.workingTree);
}

/** Too early to say that everything has downloaded: `watch` or a first walk hasn't answered. */
export function selectOnlineOnlyUnsettled(state: OnlineOnlyFilesState): boolean {
  if (state.phase === "asking") return true;
  return state.files !== null && (state.files.git === null || state.files.workingTree === null);
}
