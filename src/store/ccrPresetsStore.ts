import { create } from "zustand";
import type { AgentPreset } from "@shared/config/agentRegistry";

interface CcrPresetsState {
  ccrPresetsByAgent: Record<string, AgentPreset[]>;
  /**
   * Whether the initial CCR read has settled. An empty `ccrPresetsByAgent` is
   * ambiguous on its own — "no CCR presets exist" and "the read has not
   * happened yet" look identical — so discovery surfaces need this to say
   * whether their snapshot is authoritative.
   */
  isInitialized: boolean;
  setCcrPresets: (agentId: string, presets: AgentPreset[]) => void;
  markInitialized: () => void;
}

export const useCcrPresetsStore = create<CcrPresetsState>((set) => ({
  ccrPresetsByAgent: {},
  isInitialized: false,
  setCcrPresets: (agentId, presets) =>
    set((state) => ({
      ccrPresetsByAgent: { ...state.ccrPresetsByAgent, [agentId]: presets },
      isInitialized: true,
    })),
  markInitialized: () => set({ isInitialized: true }),
}));
