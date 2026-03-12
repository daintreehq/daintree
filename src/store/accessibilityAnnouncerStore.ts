import { create } from "zustand";

interface AnnouncementEntry {
  msg: string;
  id: number;
}

interface AnnouncerState {
  polite: AnnouncementEntry | null;
  assertive: AnnouncementEntry | null;
  announce: (msg: string, priority?: "polite" | "assertive") => void;
}

let counter = 0;

export const useAnnouncerStore = create<AnnouncerState>((set) => ({
  polite: null,
  assertive: null,
  announce: (msg, priority = "polite") => {
    const id = ++counter;
    if (priority === "assertive") {
      set({ assertive: { msg, id } });
    } else {
      set({ polite: { msg, id } });
    }
  },
}));
