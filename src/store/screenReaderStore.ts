import { create } from "zustand";

export type ScreenReaderMode = "auto" | "on" | "off";

interface ScreenReaderState {
  screenReaderMode: ScreenReaderMode;
  osAccessibilityEnabled: boolean;
  setScreenReaderMode: (mode: ScreenReaderMode) => void;
  setOsAccessibilityEnabled: (enabled: boolean) => void;
  resolvedScreenReaderEnabled: () => boolean;
}

export const useScreenReaderStore = create<ScreenReaderState>()((set, get) => ({
  screenReaderMode: "auto",
  osAccessibilityEnabled: false,
  setScreenReaderMode: (mode) => set({ screenReaderMode: mode }),
  setOsAccessibilityEnabled: (enabled) => set({ osAccessibilityEnabled: enabled }),
  resolvedScreenReaderEnabled: () => {
    const { screenReaderMode, osAccessibilityEnabled } = get();
    if (screenReaderMode === "on") return true;
    if (screenReaderMode === "off") return false;
    return osAccessibilityEnabled;
  },
}));
