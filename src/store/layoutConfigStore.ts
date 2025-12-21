import { create } from "zustand";
import type { TerminalGridConfig } from "@/types";
import { getMaxGridCapacity, ABSOLUTE_MAX_GRID_TERMINALS } from "@/lib/terminalLayout";

const DEFAULT_LAYOUT_CONFIG: TerminalGridConfig = {
  strategy: "automatic",
  value: 3,
};

interface GridDimensions {
  width: number;
  height: number;
}

interface LayoutConfigState {
  layoutConfig: TerminalGridConfig;
  setLayoutConfig: (config: TerminalGridConfig) => void;

  // Grid dimensions for dynamic capacity calculation
  gridDimensions: GridDimensions | null;
  setGridDimensions: (dimensions: GridDimensions | null) => void;

  // Computed max capacity based on current dimensions
  getMaxGridCapacity: () => number;
}

export const useLayoutConfigStore = create<LayoutConfigState>()((set, get) => ({
  layoutConfig: DEFAULT_LAYOUT_CONFIG,
  setLayoutConfig: (config) => set({ layoutConfig: config }),

  gridDimensions: null,
  setGridDimensions: (dimensions) => set({ gridDimensions: dimensions }),

  getMaxGridCapacity: () => {
    const { gridDimensions } = get();
    if (!gridDimensions) return ABSOLUTE_MAX_GRID_TERMINALS;
    return getMaxGridCapacity(gridDimensions.width, gridDimensions.height);
  },
}));
