import { create } from "zustand";
import { appClient } from "@/clients";
import type { DockMode, DockBehavior } from "@shared/types";

interface DockState {
  mode: DockMode;
  behavior: DockBehavior;
  compactMinimal: boolean;
  peek: boolean;
  isHydrated: boolean;
  popoverHeight: number;

  setMode: (mode: DockMode) => void;
  setBehavior: (behavior: DockBehavior) => void;
  cycleMode: () => void;
  toggleExpanded: () => void;
  setCompactMinimal: (enabled: boolean) => void;
  setPeek: (peek: boolean) => void;
  setPopoverHeight: (height: number) => void;
  hydrate: (
    state: Partial<Pick<DockState, "mode" | "behavior" | "compactMinimal" | "popoverHeight">>
  ) => void;
}

const POPOVER_DEFAULT_HEIGHT = 500;
const POPOVER_MIN_HEIGHT = 300;
const POPOVER_MAX_HEIGHT_RATIO = 0.8;

const MODE_CYCLE: DockMode[] = ["expanded", "compact"];

/** Normalize legacy dock modes to valid modes */
function normalizeDockMode(mode: string): DockMode {
  // Map legacy "slim" and "hidden" to "compact" to preserve minimized appearance
  if (mode === "slim" || mode === "hidden") return "compact";
  if (mode === "expanded") return "expanded";
  // Default to compact for unknown values
  return "compact";
}

export const useDockStore = create<DockState>()((set, get) => ({
  mode: "compact",
  behavior: "auto",
  compactMinimal: false,
  peek: false,
  isHydrated: false,
  popoverHeight: POPOVER_DEFAULT_HEIGHT,

  setMode: (mode) => {
    const normalizedMode = normalizeDockMode(mode);
    // Setting mode explicitly switches to manual behavior
    set({ mode: normalizedMode, behavior: "manual" });
    const state = get();
    void persistDockState({
      mode: normalizedMode,
      behavior: state.behavior,
      compactMinimal: state.compactMinimal,
    });
  },

  setBehavior: (behavior) => {
    set({ behavior });
    const state = get();
    void persistDockState({
      mode: state.mode,
      behavior: state.behavior,
      compactMinimal: state.compactMinimal,
    });
  },

  cycleMode: () => {
    const { mode } = get();
    // In auto mode, cycling switches to manual mode
    const state = get();
    if (state.behavior === "auto") {
      set({ behavior: "manual" });
    }
    const normalizedMode = normalizeDockMode(mode);
    const currentIndex = MODE_CYCLE.indexOf(normalizedMode);
    const nextIndex = (currentIndex + 1) % MODE_CYCLE.length;
    const nextMode = MODE_CYCLE[nextIndex];
    set({ mode: nextMode });
    const finalState = get();
    void persistDockState({
      mode: finalState.mode,
      behavior: finalState.behavior,
      compactMinimal: finalState.compactMinimal,
    });
  },

  toggleExpanded: () => {
    const { mode } = get();
    // Toggle between expanded and compact
    // When toggling, always switch to manual mode
    const nextMode: DockMode = mode === "expanded" ? "compact" : "expanded";
    set({ mode: nextMode, behavior: "manual" });
    const state = get();
    void persistDockState({
      mode: state.mode,
      behavior: state.behavior,
      compactMinimal: state.compactMinimal,
    });
  },

  setCompactMinimal: (enabled) => {
    set({ compactMinimal: enabled });
    const state = get();
    void persistDockState({
      mode: state.mode,
      behavior: state.behavior,
      compactMinimal: enabled,
    });
  },

  setPeek: (peek) => set({ peek }),

  setPopoverHeight: (height) => {
    const clampedHeight = Math.min(
      Math.max(height, POPOVER_MIN_HEIGHT),
      window.innerHeight * POPOVER_MAX_HEIGHT_RATIO
    );
    set({ popoverHeight: clampedHeight });
    void persistPopoverHeight(clampedHeight);
  },

  hydrate: (state) => {
    // Normalize legacy modes during hydration
    const normalizedMode = state.mode ? normalizeDockMode(state.mode) : "expanded";
    set({ ...state, mode: normalizedMode, isHydrated: true });
  },
}));

async function persistPopoverHeight(height: number): Promise<void> {
  try {
    await appClient.setState({ dockedPopoverHeight: height });
  } catch (error) {
    console.error("Failed to persist docked popover height:", error);
  }
}

export { POPOVER_DEFAULT_HEIGHT, POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT_RATIO };

async function persistDockState(state: {
  mode: DockMode;
  behavior: DockBehavior;
  compactMinimal: boolean;
}): Promise<void> {
  try {
    await appClient.setState({
      dockMode: state.mode,
      dockBehavior: state.behavior,
      compactDockMinimal: state.compactMinimal,
    });
  } catch (error) {
    console.error("Failed to persist dock state:", error);
  }
}
