import { useEffect } from "react";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import type { AgentPreset } from "@shared/config/agentRegistry";

export function useCcrPresetsSubscription(): void {
  const setCcrPresets = useCcrPresetsStore((s) => s.setCcrPresets);
  const markInitialized = useCcrPresetsStore((s) => s.markInitialized);

  useEffect(() => {
    const fetchInitial = async () => {
      if (!window.electron?.agentCapabilities?.getCcrPresets) {
        // No CCR bridge at all: there is nothing to wait for, so the empty map
        // is already the authoritative answer.
        markInitialized();
        return;
      }
      try {
        const presets = await window.electron.agentCapabilities.getCcrPresets();
        if (presets && presets.length > 0) {
          setCcrPresets("claude", presets as AgentPreset[]);
        }
        // Marked on the empty path too — a successful read that found nothing
        // is a complete answer, and only `setCcrPresets` would mark it
        // otherwise, which is exactly the case it skips.
        markInitialized();
      } catch {
        // Non-critical: CCR presets may not be available. Deliberately not
        // marked initialized — a failed read leaves the snapshot unproven.
      }
    };

    fetchInitial();

    if (!window.electron?.agentCapabilities?.onPresetsUpdated) return;

    const cleanup = window.electron.agentCapabilities.onPresetsUpdated((payload) => {
      setCcrPresets(payload.agentId, payload.presets as AgentPreset[]);
    });

    return cleanup;
  }, [setCcrPresets, markInitialized]);
}
