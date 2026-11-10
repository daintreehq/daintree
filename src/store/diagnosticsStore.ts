import { create, type StateCreator } from "zustand";

export type DiagnosticsTab = "problems" | "logs" | "events" | "telemetry" | "perf" | "whySlow";

interface DiagnosticsState {
  isOpen: boolean;
  activeTab: DiagnosticsTab;
  height: number;
  maxHeight: number;
  /**
   * Left by an opener that hands the keyboard to the dock along with the view
   * (one whose own surface just closed, so focus has nowhere useful to return).
   * The dock takes it once mounted and focuses its selected tab.
   */
  tabFocusRequest: { focusVisible: boolean } | null;

  toggleDock: () => void;
  openDock: (tab?: DiagnosticsTab) => void;
  closeDock: () => void;
  setActiveTab: (tab: DiagnosticsTab) => void;
  setOpen: (open: boolean) => void;
  setHeight: (height: number) => void;
  setMaxHeight: (max: number) => void;
  requestTabFocus: (focusVisible: boolean) => void;
  clearTabFocusRequest: () => void;
  reset: () => void;
}

const DEFAULT_HEIGHT = 256;
const MIN_HEIGHT = 128;
const MAX_HEIGHT_RATIO = 0.5; // 50% of viewport

const initialMaxHeight =
  typeof window !== "undefined"
    ? Math.max(window.innerHeight * MAX_HEIGHT_RATIO, MIN_HEIGHT)
    : DEFAULT_HEIGHT;

const createDiagnosticsStore: StateCreator<DiagnosticsState> = (set) => ({
  isOpen: false,
  activeTab: "problems",
  height: DEFAULT_HEIGHT,
  maxHeight: initialMaxHeight,
  tabFocusRequest: null,

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
      tabFocusRequest: null,
    }),

  setActiveTab: (tab) =>
    set({
      activeTab: tab,
    }),

  setOpen: (isOpen) =>
    set({
      isOpen,
    }),

  setHeight: (height) =>
    set((state) => {
      const clampedHeight = Math.min(Math.max(height, MIN_HEIGHT), state.maxHeight);
      return { height: clampedHeight };
    }),

  setMaxHeight: (max) =>
    set((state) => {
      const nextMax = Math.max(max, MIN_HEIGHT);
      const clampedHeight = Math.min(state.height, nextMax);
      // Returning the existing state reference makes Zustand 5 skip the
      // subscriber notification — important because ResizeObserver can
      // fire the same parent height repeatedly during layout churn.
      if (clampedHeight === state.height && nextMax === state.maxHeight) {
        return state;
      }
      return { maxHeight: nextMax, height: clampedHeight };
    }),

  requestTabFocus: (focusVisible) => set({ tabFocusRequest: { focusVisible } }),

  clearTabFocusRequest: () => set({ tabFocusRequest: null }),

  reset: () =>
    set({
      isOpen: false,
      activeTab: "problems",
      height: DEFAULT_HEIGHT,
      maxHeight: initialMaxHeight,
      tabFocusRequest: null,
    }),
});

export const useDiagnosticsStore = create<DiagnosticsState>(createDiagnosticsStore);

export const DIAGNOSTICS_MIN_HEIGHT = MIN_HEIGHT;
export const DIAGNOSTICS_MAX_HEIGHT_RATIO = MAX_HEIGHT_RATIO;
export const DIAGNOSTICS_DEFAULT_HEIGHT = DEFAULT_HEIGHT;
