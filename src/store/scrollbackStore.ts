import { create } from "zustand";
import { SCROLLBACK_DEFAULT } from "@shared/config/scrollback";

interface ScrollbackState {
  scrollbackLines: number;
  setScrollbackLines: (lines: number) => void;
}

export const useScrollbackStore = create<ScrollbackState>()((set) => ({
  scrollbackLines: SCROLLBACK_DEFAULT,
  setScrollbackLines: (lines) => set({ scrollbackLines: lines }),
}));
