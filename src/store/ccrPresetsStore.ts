import { create } from "zustand";
import type { AgentPreset } from "@shared/config/agentRegistry";

interface CcrPresetsState {
  ccrPresetsByAgent: Record<string, AgentPreset[]>;
  setCcrPresets: (agentId: string, presets: AgentPreset[]) => void;
}

export const useCcrPresetsStore = create<CcrPresetsState>((set) => ({
  ccrPresetsByAgent: {},
  setCcrPresets: (agentId, presets) =>
    set((state) => ({
      ccrPresetsByAgent: { ...state.ccrPresetsByAgent, [agentId]: presets },
    })),
}));
