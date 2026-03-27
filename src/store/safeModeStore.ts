import { create } from "zustand";

interface SafeModeState {
  safeMode: boolean;
  setSafeMode: (value: boolean) => void;
}

export const useSafeModeStore = create<SafeModeState>((set) => ({
  safeMode: false,
  setSafeMode: (value) => set({ safeMode: value }),
}));
