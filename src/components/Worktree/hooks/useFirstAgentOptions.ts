import { useMemo, useSyncExternalStore } from "react";
import { getEffectiveAgentConfig, getEffectiveAgentIds } from "@shared/config/agentRegistry";
import {
  subscribeToPluginAgentRegistry,
  getPluginAgentRegistrySnapshot,
} from "@shared/config/pluginAgentRegistry";
import { isAssistantOnlyAgentId, isBuiltInAgentId } from "@shared/config/agentIds";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";

export interface FirstAgentOption {
  id: string;
  name: string;
  iconId: string;
}

/**
 * Agents the new-worktree dialog can start. Same visibility rule as the New
 * Terminal palette: everything until availability is known, then built-ins
 * that aren't installed drop out while plugin agents always stay reachable.
 */
export function useFirstAgentOptions(): FirstAgentOption[] {
  const availability = useCliAvailabilityStore((s) => s.availability);
  const isAvailabilityInitialized = useCliAvailabilityStore((s) => s.isInitialized);
  const pluginAgentSnapshot = useSyncExternalStore(
    subscribeToPluginAgentRegistry,
    getPluginAgentRegistrySnapshot
  );

  return useMemo(() => {
    const ids = new Set([...getEffectiveAgentIds(), ...Object.keys(pluginAgentSnapshot)]);
    const options: FirstAgentOption[] = [];
    for (const id of ids) {
      if (isAssistantOnlyAgentId(id)) continue;
      if (isAvailabilityInitialized && isBuiltInAgentId(id) && !isAgentInstalled(availability[id]))
        continue;
      const config = getEffectiveAgentConfig(id);
      options.push({ id, name: config?.name ?? id, iconId: config?.iconId ?? id });
    }
    return options;
  }, [availability, isAvailabilityInitialized, pluginAgentSnapshot]);
}
