import { useMemo } from "react";
import { getMergedPresets } from "@/config/agents";
import {
  resolvePermissionLevel,
  savedPresetStatus,
} from "@/components/Settings/AgentScopeEditor/scopeUtils";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { ownedProjectPresets, presetInventoryState } from "@/utils/presetInventory";
import { getAgentSettingsEntry, permissionArgsForLevel } from "@shared/types/agentSettings";
import type { AgentPreset } from "@shared/config/agentRegistry";

export interface ScheduleLaunchOptions {
  presets: AgentPreset[];
  /** The chosen preset, or undefined for none (or one this agent no longer has). */
  preset: AgentPreset | undefined;
  /**
   * Whether the chosen preset was found. `loading` while a store that could
   * hold it hasn't been read yet, so only `missing` means it's really gone.
   */
  presetStatus: "none" | "found" | "missing" | "loading";
  /**
   * True when the launch adds no permission flag, so the CLI's own defaults
   * decide whether it stops at prompts; read the way the launch resolves it.
   * Auto and Skip all count as false where they add a flag, and Skip all on an
   * agent with no bypass flag counts as true. Null until agent settings and the
   * chosen preset have loaded.
   */
  stopsAtPrompts: boolean | null;
}

export function useScheduleLaunchOptions(
  agentId: string,
  presetId: string | null
): ScheduleLaunchOptions {
  const settings = useAgentSettingsStore((s) => s.settings);
  const ccrPresets = useCcrPresetsStore((s) => s.ccrPresetsByAgent[agentId]);
  const ccrInitialized = useCcrPresetsStore((s) => s.isInitialized);
  const projectPresetsSnapshot = useProjectPresetsStore((s) => s.presetsByAgent[agentId]);
  const hydratedProjectId = useProjectPresetsStore((s) => s.hydratedProjectId);
  const projectId = useProjectStore((s) => s.currentProject?.id);
  const scratchId = useScratchStore((s) => s.currentScratch?.id);

  return useMemo(() => {
    const scope = { projectId, scratchId };
    const projectPresets = ownedProjectPresets(projectPresetsSnapshot, hydratedProjectId, scope);
    const entry = getAgentSettingsEntry(settings, agentId);
    const presets = agentId
      ? getMergedPresets(agentId, entry.customPresets, ccrPresets, projectPresets)
      : [];
    const preset = presetId === null ? undefined : presets.find((p) => p.id === presetId);
    // Custom presets ride with agent settings, so an unread settings object
    // leaves any id it could hold unsettled too.
    const inventory = presetInventoryState(ccrInitialized, hydratedProjectId, scope);
    const status = savedPresetStatus(presetId ?? undefined, presets, inventory);
    const presetStatus = status === "missing" && !settings ? "loading" : status;
    const stopsAtPrompts =
      settings && agentId && presetStatus !== "loading"
        ? permissionArgsForLevel(
            resolvePermissionLevel(agentId, entry, preset, settings.globalSkipPermissions ?? false),
            entry,
            agentId
          ).length === 0
        : null;
    return { presets, preset, presetStatus, stopsAtPrompts };
  }, [
    settings,
    agentId,
    presetId,
    ccrPresets,
    ccrInitialized,
    projectPresetsSnapshot,
    hydratedProjectId,
    projectId,
    scratchId,
  ]);
}
