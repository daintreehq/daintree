import type { AgentPreset } from "@/config/agents";
import { getMergedPreset, sanitizeAgentEnv } from "@/config/agents";
import {
  buildAgentLaunchFlags,
  combineDangerousModes,
  combineInlineModes,
  resolveDangerousMode,
  resolveInlineMode,
} from "@shared/types";
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
  // Layer the preset's tri-state bypass mode on top of the agent's resolved
  // mode and bake the combined result onto the effective entry, so the single
  // `resolveEffectiveBypass` chokepoint sees the final intent (a preset "off"
  // vetoes an agent/global "on"). `dangerousEnabled` is mirrored for any
  // legacy boolean reader of the merged entry.
  const combinedMode = combineDangerousModes(
    resolveDangerousMode(entry),
    resolveDangerousMode(preset)
  );
  // Layer the preset's tri-state inline mode on top of the agent's resolved mode
  // and bake the combined result onto the effective entry, so the single
  // resolveEffectiveInlineMode chokepoint sees the final intent (#10876) — a
  // preset "off" (alt-screen) vetoes an agent/global "on" (inline), just like
  // the bypass tri-state above.
  const combinedInline = combineInlineModes(resolveInlineMode(entry), resolveInlineMode(preset));
  return {
    ...entry,
    dangerousMode: combinedMode,
    dangerousEnabled: combinedMode === "on",
    inlineMode: combinedInline,
    ...(preset.customFlags !== undefined && { customFlags: preset.customFlags }),
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
  options?: { modelId?: string; globalSkipPermissions?: boolean; globalUseAltScreen?: boolean }
): string[] {
  return buildAgentLaunchFlags(entry, agentId, {
    modelId: options?.modelId,
    presetArgs: preset?.args,
    globalSkipPermissions: options?.globalSkipPermissions,
    globalUseAltScreen: options?.globalUseAltScreen,
  });
}
