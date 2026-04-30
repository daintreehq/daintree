import { create } from "zustand";

interface ThemeBrowserState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useThemeBrowserStore = create<ThemeBrowserState>()((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
