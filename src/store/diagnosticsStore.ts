import { create, type StateCreator } from "zustand";

export type DiagnosticsTab = "problems" | "logs" | "events";

interface DiagnosticsState {
  isOpen: boolean;
  activeTab: DiagnosticsTab;
  height: number;

  toggleDock: () => void;
  openDock: (tab?: DiagnosticsTab) => void;
  closeDock: () => void;
  setActiveTab: (tab: DiagnosticsTab) => void;
  setOpen: (open: boolean) => void;
  setHeight: (height: number) => void;
  reset: () => void;
}

const DEFAULT_HEIGHT = 256;
const MIN_HEIGHT = 128;
const MAX_HEIGHT_RATIO = 0.5; // 50% of viewport

const createDiagnosticsStore: StateCreator<DiagnosticsState> = (set) => ({
  isOpen: false,
  activeTab: "problems",
  height: DEFAULT_HEIGHT,

  toggleDock: () =>
    set((state) => ({
      isOpen: !state.isOpen,
    })),

  openDock: (tab) =>
    set((state) => ({
      isOpen: true,
      activeTab: tab ?? state.activeTab,
    })),

  closeDock: () =>
    set({
      isOpen: false,
    }),

  setActiveTab: (tab) =>
    set({
      activeTab: tab,
    }),

  setOpen: (isOpen) =>
    set({
      isOpen,
    }),

  setHeight: (height) => {
    const maxHeight =
      typeof window !== "undefined" ? window.innerHeight * MAX_HEIGHT_RATIO : height;
    const clampedHeight = Math.min(Math.max(height, MIN_HEIGHT), maxHeight);
    set({ height: clampedHeight });
  },

  reset: () =>
    set({
      isOpen: false,
      activeTab: "problems",
      height: DEFAULT_HEIGHT,
    }),
});

export const useDiagnosticsStore = create<DiagnosticsState>(createDiagnosticsStore);

export const DIAGNOSTICS_MIN_HEIGHT = MIN_HEIGHT;
export const DIAGNOSTICS_MAX_HEIGHT_RATIO = MAX_HEIGHT_RATIO;
export const DIAGNOSTICS_DEFAULT_HEIGHT = DEFAULT_HEIGHT;
