import { create } from "zustand";
import type { AgentPreset } from "@shared/config/agentRegistry";

interface ProjectPresetsState {
  presetsByAgent: Record<string, AgentPreset[]>;
  /**
   * Which project the loaded snapshot belongs to, or null when nothing has
   * loaded. An empty `presetsByAgent` cannot distinguish "this project declares
   * no presets" from "the load has not finished", and the store is reused
   * across project switches, so discovery surfaces check ownership before
   * treating the snapshot as this project's answer.
   */
  hydratedProjectId: string | null;
  setPresetsByAgent: (projectId: string, byAgent: Record<string, AgentPreset[]>) => void;
  reset: () => void;
}

export const useProjectPresetsStore = create<ProjectPresetsState>((set) => ({
  presetsByAgent: {},
  hydratedProjectId: null,
  setPresetsByAgent: (projectId, byAgent) =>
    set({ presetsByAgent: byAgent, hydratedProjectId: projectId }),
  reset: () => set({ presetsByAgent: {}, hydratedProjectId: null }),
}));
