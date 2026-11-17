import { create } from "zustand";

interface Osc52ClipboardState {
  /** Whether plain shells may write this machine's clipboard through OSC 52. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const useOsc52ClipboardStore = create<Osc52ClipboardState>()((set) => ({
  enabled: false,
  setEnabled: (enabled) => set({ enabled }),
}));
