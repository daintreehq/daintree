import { create } from "zustand";
import type { AgentPreset } from "@shared/config/agentRegistry";

interface ProjectPresetsState {
  presetsByAgent: Record<string, AgentPreset[]>;
  setPresetsByAgent: (byAgent: Record<string, AgentPreset[]>) => void;
  reset: () => void;
}

export const useProjectPresetsStore = create<ProjectPresetsState>((set) => ({
  presetsByAgent: {},
  setPresetsByAgent: (byAgent) => set({ presetsByAgent: byAgent }),
  reset: () => set({ presetsByAgent: {} }),
}));
