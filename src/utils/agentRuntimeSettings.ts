import type { AgentPreset } from "@/config/agents";
import { getMergedPreset, sanitizeAgentEnv } from "@/config/agents";
import { buildAgentLaunchFlags } from "@shared/types";
import type { AgentSettingsEntry } from "@shared/types/agentSettings";

export interface AgentRuntimeSettingsResolution {
  preset: AgentPreset | undefined;
  presetWasStale: boolean;
  effectiveEntry: AgentSettingsEntry;
  env: Record<string, string> | undefined;
}

export interface ResolveAgentRuntimeSettingsOptions {
  agentId: string;
  presetId?: string;
  entry?: AgentSettingsEntry;
  ccrPresets?: AgentPreset[];
  projectPresets?: AgentPreset[];
}

export function applyPresetBehaviorOverrides(
  entry: AgentSettingsEntry,
  preset: AgentPreset | undefined
): AgentSettingsEntry {
  if (!preset) return entry;
  return {
    ...entry,
    ...(preset.dangerousEnabled !== undefined && {
      dangerousEnabled: preset.dangerousEnabled,
    }),
    ...(preset.customFlags !== undefined && { customFlags: preset.customFlags }),
    ...(preset.inlineMode !== undefined && { inlineMode: preset.inlineMode }),
  };
}

export function mergeAgentRuntimeEnv(
  entry: AgentSettingsEntry,
  preset: AgentPreset | undefined
): Record<string, string> | undefined {
  const sanitizedGlobal = sanitizeAgentEnv(entry.globalEnv as Record<string, unknown>);
  const sanitizedPreset = preset?.env;
  return sanitizedGlobal || sanitizedPreset
    ? { ...sanitizedGlobal, ...sanitizedPreset }
    : undefined;
}

export function resolveAgentRuntimeSettings({
  agentId,
  presetId,
  entry = {},
  ccrPresets,
  projectPresets,
}: ResolveAgentRuntimeSettingsOptions): AgentRuntimeSettingsResolution {
  const preset = presetId
    ? getMergedPreset(agentId, presetId, entry.customPresets, ccrPresets, projectPresets)
    : undefined;
  return {
    preset,
    presetWasStale: !!presetId && !preset,
    effectiveEntry: applyPresetBehaviorOverrides(entry, preset),
    env: mergeAgentRuntimeEnv(entry, preset),
  };
}

function hasContiguousSequence(flags: readonly string[], args: readonly string[]): boolean {
  if (args.length === 0) return true;
  if (args.length > flags.length) return false;
  return flags.some((_, index) => args.every((arg, offset) => flags[index + offset] === arg));
}

export function mergePresetArgsIntoLaunchFlags(
  launchFlags: readonly string[] | undefined,
  preset: AgentPreset | undefined
): string[] {
  const flags = [...(launchFlags ?? [])];
  const args = preset?.args?.filter(Boolean) ?? [];
  if (args.length === 0 || hasContiguousSequence(flags, args)) return flags;
  return [...flags, ...args];
}

export function buildAgentLaunchFlagsForRuntimeSettings(
  entry: AgentSettingsEntry,
  agentId: string,
  preset: AgentPreset | undefined,
  options?: { modelId?: string }
): string[] {
  return buildAgentLaunchFlags(entry, agentId, {
    modelId: options?.modelId,
    presetArgs: preset?.args,
  });
}
