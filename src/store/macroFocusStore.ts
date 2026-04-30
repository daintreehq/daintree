import { create } from "zustand";

export type MacroRegion = "grid" | "dock" | "sidebar" | "portal";

const REGION_ORDER: MacroRegion[] = ["grid", "dock", "sidebar", "portal"];

interface MacroFocusState {
  focusedRegion: MacroRegion | null;
  visibility: Record<MacroRegion, boolean>;
  refs: Map<MacroRegion, HTMLElement>;
  setRegionRef: (region: MacroRegion, el: HTMLElement | null) => void;
  setVisibility: (region: MacroRegion, visible: boolean) => void;
  cycleNext: () => void;
  cyclePrev: () => void;
  clearFocus: () => void;
}

function getVisibleRegions(visibility: Record<MacroRegion, boolean>): MacroRegion[] {
  return REGION_ORDER.filter((r) => visibility[r]);
}

export const useMacroFocusStore = create<MacroFocusState>((set, get) => ({
  focusedRegion: null,
  visibility: { grid: true, dock: false, sidebar: true, portal: false },
  refs: new Map(),

  setRegionRef: (region, el) => {
    const { refs } = get();
    if (el) {
      refs.set(region, el);
    } else {
      refs.delete(region);
    }
  },

  setVisibility: (region, visible) => {
    set((state) => {
      if (state.visibility[region] === visible) return state;
      const newVisibility = { ...state.visibility, [region]: visible };
      const newFocused = state.focusedRegion === region && !visible ? null : state.focusedRegion;
      return { visibility: newVisibility, focusedRegion: newFocused };
    });
  },

  cycleNext: () => {
    const { visibility, focusedRegion, refs } = get();
    const visible = getVisibleRegions(visibility);
    if (visible.length === 0) return;

    let next: MacroRegion;
    if (focusedRegion === null) {
      next = visible[0]!;
    } else {
      const idx = visible.indexOf(focusedRegion);
      next = visible[(idx + 1) % visible.length]!;
    }

    set({ focusedRegion: next });
    refs.get(next)?.focus({ preventScroll: true });
  },

  cyclePrev: () => {
    const { visibility, focusedRegion, refs } = get();
    const visible = getVisibleRegions(visibility);
    if (visible.length === 0) return;

    let prev: MacroRegion;
    if (focusedRegion === null) {
      prev = visible[visible.length - 1]!;
    } else {
      const idx = visible.indexOf(focusedRegion);
      prev = visible[(idx - 1 + visible.length) % visible.length]!;
    }

    set({ focusedRegion: prev });
    refs.get(prev)?.focus({ preventScroll: true });
  },

  clearFocus: () => {
    if (get().focusedRegion !== null) {
      set({ focusedRegion: null });
    }
  },
}));
