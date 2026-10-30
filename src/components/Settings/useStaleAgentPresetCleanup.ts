import { useEffect, useEffectEvent } from "react";
import { getMergedPresets, type AgentPreset } from "@/config/agents";
import type { AgentSettings, AgentSettingsEntry } from "@shared/types";
import type { PresetInventoryState } from "@shared/utils/agentPresets";
import { savedPresetStatus } from "./AgentScopeEditor/scopeUtils";

interface StaleAgentPresetCleanupInput {
  agentId: string | null;
  settings: AgentSettings | null | undefined;
  ccrPresetsByAgent: Record<string, AgentPreset[]>;
  projectPresetsByAgent: Record<string, AgentPreset[]>;
  presetInventory: PresetInventoryState;
  updateAgent: (agentId: string, updates: Partial<AgentSettingsEntry>) => Promise<void>;
  onSettingsChange?: () => void;
}

/**
 * Stale-preset cleanup in Settings: when a saved presetId no longer resolves
 * (deleted custom preset, CCR route removed from config), clear it so the
 * Settings UI and the stored settings agree. useAgentLauncher.ts does this
 * cleanup on the next launch, but the UI otherwise shows default with a
 * zombie presetId in storage until the user launches the agent again. An id
 * whose presets haven't loaded yet is kept (#15025), and the load finishing
 * reruns this even when it brings nothing.
 */
export function useStaleAgentPresetCleanup({
  agentId,
  settings,
  ccrPresetsByAgent,
  projectPresetsByAgent,
  presetInventory,
  updateAgent,
  onSettingsChange,
}: StaleAgentPresetCleanupInput): void {
  // updateAgent/onSettingsChange are stable Zustand actions / prop callbacks;
  // calling them via useEffectEvent keeps them out of the deps array so the
  // effect only reruns when the settings or the presets change.
  const clearStalePreset = useEffectEvent(() => {
    if (!agentId) return;
    const entry = settings?.agents?.[agentId];
    if (!entry?.presetId) return;
    const ccr = ccrPresetsByAgent[agentId];
    const project = projectPresetsByAgent[agentId];
    const merged = getMergedPresets(agentId, entry.customPresets, ccr, project);
    if (savedPresetStatus(entry.presetId, merged, presetInventory) === "missing") {
      void (async () => {
        await updateAgent(agentId, { presetId: undefined });
        onSettingsChange?.();
      })();
    }
  });
  useEffect(() => {
    void agentId;
    void settings;
    void ccrPresetsByAgent;
    void projectPresetsByAgent;
    void presetInventory.ccr;
    void presetInventory.project;
    clearStalePreset();
  }, [
    agentId,
    settings,
    ccrPresetsByAgent,
    projectPresetsByAgent,
    presetInventory.ccr,
    presetInventory.project,
  ]);
}
