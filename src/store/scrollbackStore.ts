import { create } from "zustand";

const DEFAULT_SCROLLBACK_LINES = 5000;

interface ScrollbackState {
  scrollbackLines: number;
  setScrollbackLines: (lines: number) => void;
}

export const useScrollbackStore = create<ScrollbackState>()((set) => ({
  scrollbackLines: DEFAULT_SCROLLBACK_LINES,
  setScrollbackLines: (lines) => set({ scrollbackLines: lines }),
}));
