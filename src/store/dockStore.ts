import { create } from "zustand";
import { appClient } from "@/clients";

interface DockState {
  peek: boolean;
  isHydrated: boolean;
  popoverHeight: number;

  setPeek: (peek: boolean) => void;
  setPopoverHeight: (height: number) => void;
  hydrate: (state: Partial<Pick<DockState, "popoverHeight">>) => void;
}

const POPOVER_DEFAULT_HEIGHT = 500;
const POPOVER_MIN_HEIGHT = 300;
const POPOVER_MAX_HEIGHT_RATIO = 0.8;

export const useDockStore = create<DockState>()((set) => ({
  peek: false,
  isHydrated: false,
  popoverHeight: POPOVER_DEFAULT_HEIGHT,

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
    set({ ...state, isHydrated: true });
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
