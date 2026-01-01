import { create } from "zustand";
import { appClient } from "@/clients";
import type { DockMode, DockBehavior } from "@shared/types";

interface DockState {
  mode: DockMode;
  behavior: DockBehavior;
  autoHideWhenEmpty: boolean;
  peek: boolean;
  isHydrated: boolean;

  setMode: (mode: DockMode) => void;
  setBehavior: (behavior: DockBehavior) => void;
  cycleMode: () => void;
  toggleExpanded: () => void;
  setAutoHideWhenEmpty: (enabled: boolean) => void;
  setPeek: (peek: boolean) => void;
  hydrate: (state: Partial<Pick<DockState, "mode" | "behavior" | "autoHideWhenEmpty">>) => void;
}

const MODE_CYCLE: DockMode[] = ["expanded", "hidden"];

export const useDockStore = create<DockState>()((set, get) => ({
  mode: "hidden",
  behavior: "auto",
  autoHideWhenEmpty: false,
  peek: false,
  isHydrated: false,

  setMode: (mode) => {
    const normalizedMode: DockMode = mode === "slim" ? "hidden" : mode;
    // Setting mode explicitly switches to manual behavior
    set({ mode: normalizedMode, behavior: "manual" });
    const state = get();
    void persistDockState({
      mode: normalizedMode,
      behavior: state.behavior,
      autoHideWhenEmpty: state.autoHideWhenEmpty,
    });
  },

  setBehavior: (behavior) => {
    set({ behavior });
    const state = get();
    void persistDockState({
      mode: state.mode,
      behavior: state.behavior,
      autoHideWhenEmpty: state.autoHideWhenEmpty,
    });
  },

  cycleMode: () => {
    const { mode, behavior } = get();
    // In auto mode, cycling switches to manual mode
    if (behavior === "auto") {
      set({ behavior: "manual" });
    }
    const normalizedMode: DockMode = mode === "slim" ? "hidden" : mode;
    const currentIndex = MODE_CYCLE.indexOf(normalizedMode);
    const nextIndex = (currentIndex + 1) % MODE_CYCLE.length;
    const nextMode = MODE_CYCLE[nextIndex];
    set({ mode: nextMode });
    const state = get();
    void persistDockState({
      mode: state.mode,
      behavior: state.behavior,
      autoHideWhenEmpty: state.autoHideWhenEmpty,
    });
  },

  toggleExpanded: () => {
    const { mode, behavior } = get();
    // In auto mode, toggling switches to manual mode
    if (behavior === "auto") {
      set({ behavior: "manual" });
    }
    const nextMode: DockMode = mode === "expanded" ? "hidden" : "expanded";
    set({ mode: nextMode });
    const state = get();
    void persistDockState({
      mode: state.mode,
      behavior: state.behavior,
      autoHideWhenEmpty: state.autoHideWhenEmpty,
    });
  },

  setAutoHideWhenEmpty: (enabled) => {
    set({ autoHideWhenEmpty: enabled });
    const state = get();
    void persistDockState({
      mode: state.mode,
      behavior: state.behavior,
      autoHideWhenEmpty: state.autoHideWhenEmpty,
    });
  },

  setPeek: (peek) => set({ peek }),

  hydrate: (state) => set({ ...state, isHydrated: true }),
}));

async function persistDockState(state: {
  mode: DockMode;
  behavior: DockBehavior;
  autoHideWhenEmpty: boolean;
}): Promise<void> {
  try {
    await appClient.setState({
      dockMode: state.mode,
      dockBehavior: state.behavior,
      dockAutoHideWhenEmpty: state.autoHideWhenEmpty,
    });
  } catch (error) {
    console.error("Failed to persist dock state:", error);
  }
}
