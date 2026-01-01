import { create } from "zustand";
import { appClient } from "@/clients";
import type { DockMode } from "@shared/types";

interface DockState {
  mode: DockMode;
  autoHideWhenEmpty: boolean;
  peek: boolean;

  setMode: (mode: DockMode) => void;
  cycleMode: () => void;
  toggleExpanded: () => void;
  setAutoHideWhenEmpty: (enabled: boolean) => void;
  setPeek: (peek: boolean) => void;
  hydrate: (state: Partial<Pick<DockState, "mode" | "autoHideWhenEmpty">>) => void;
}

const MODE_CYCLE: DockMode[] = ["expanded", "slim", "hidden"];

export const useDockStore = create<DockState>()((set, get) => ({
  mode: "expanded",
  autoHideWhenEmpty: false,
  peek: false,

  setMode: (mode) => {
    set({ mode });
    const state = get();
    void persistDockState({ mode: state.mode, autoHideWhenEmpty: state.autoHideWhenEmpty });
  },

  cycleMode: () => {
    const current = get().mode;
    const currentIndex = MODE_CYCLE.indexOf(current);
    const nextIndex = (currentIndex + 1) % MODE_CYCLE.length;
    const nextMode = MODE_CYCLE[nextIndex];
    set({ mode: nextMode });
    const state = get();
    void persistDockState({ mode: state.mode, autoHideWhenEmpty: state.autoHideWhenEmpty });
  },

  toggleExpanded: () => {
    const current = get().mode;
    const nextMode: DockMode = current === "expanded" ? "hidden" : "expanded";
    set({ mode: nextMode });
    const state = get();
    void persistDockState({ mode: state.mode, autoHideWhenEmpty: state.autoHideWhenEmpty });
  },

  setAutoHideWhenEmpty: (enabled) => {
    set({ autoHideWhenEmpty: enabled });
    const state = get();
    void persistDockState({ mode: state.mode, autoHideWhenEmpty: state.autoHideWhenEmpty });
  },

  setPeek: (peek) => set({ peek }),

  hydrate: (state) => set(state),
}));

async function persistDockState(state: {
  mode: DockMode;
  autoHideWhenEmpty: boolean;
}): Promise<void> {
  try {
    await appClient.setState({
      dockMode: state.mode,
      dockAutoHideWhenEmpty: state.autoHideWhenEmpty,
    });
  } catch (error) {
    console.error("Failed to persist dock state:", error);
  }
}
