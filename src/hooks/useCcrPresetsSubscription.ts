import { useEffect } from "react";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import type { AgentPreset } from "@shared/config/agentRegistry";

export function useCcrPresetsSubscription(): void {
  const setCcrPresets = useCcrPresetsStore((s) => s.setCcrPresets);

  useEffect(() => {
    const fetchInitial = async () => {
      if (window.electron?.agentCapabilities?.getCcrPresets) {
        try {
          const presets = await window.electron.agentCapabilities.getCcrPresets();
          if (presets && presets.length > 0) {
            setCcrPresets("claude", presets as AgentPreset[]);
          }
        } catch {
          // Non-critical: CCR presets may not be available
        }
      }
    };

    fetchInitial();

    if (!window.electron?.agentCapabilities?.onPresetsUpdated) return;

    const cleanup = window.electron.agentCapabilities.onPresetsUpdated((payload) => {
      setCcrPresets(payload.agentId, payload.presets as AgentPreset[]);
    });

    return cleanup;
  }, [setCcrPresets]);
}
