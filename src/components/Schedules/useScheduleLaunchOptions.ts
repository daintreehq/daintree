import { useMemo } from "react";
import { getMergedPresets } from "@/config/agents";
import { resolveSkipPermissions } from "@/components/Settings/AgentScopeEditor";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { getAgentSettingsEntry } from "@shared/types/agentSettings";
import type { AgentPreset } from "@shared/config/agentRegistry";

export interface ScheduleLaunchOptions {
  presets: AgentPreset[];
  /** The chosen preset, or undefined for none (or one this agent no longer has). */
  preset: AgentPreset | undefined;
  /**
   * True when the launch would stop at permission prompts, read the way the
   * launch resolves it. Null until agent settings have loaded.
   */
  stopsAtPrompts: boolean | null;
}

export function useScheduleLaunchOptions(
  agentId: string,
  presetId: string | null
): ScheduleLaunchOptions {
  const settings = useAgentSettingsStore((s) => s.settings);
  const ccrPresets = useCcrPresetsStore((s) => s.ccrPresetsByAgent[agentId]);
  const projectPresets = useProjectPresetsStore((s) => s.presetsByAgent[agentId]);

  return useMemo(() => {
    const entry = getAgentSettingsEntry(settings, agentId);
    const presets = agentId
      ? getMergedPresets(agentId, entry.customPresets, ccrPresets, projectPresets)
      : [];
    const preset = presetId === null ? undefined : presets.find((p) => p.id === presetId);
    const stopsAtPrompts =
      settings && agentId
        ? !resolveSkipPermissions(agentId, entry, preset, settings.globalSkipPermissions ?? false)
        : null;
    return { presets, preset, stopsAtPrompts };
  }, [settings, agentId, presetId, ccrPresets, projectPresets]);
}
