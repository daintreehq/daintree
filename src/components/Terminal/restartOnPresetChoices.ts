import { useMemo } from "react";
import { getMergedPresets, type AgentPreset } from "@/config/agents";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useCodexQuota } from "@/hooks/useCodexQuota";
import { windowLabel } from "@/utils/codexQuotaFormat";
import type { CodexQuotaProfile } from "@shared/types/ipc/agentQuota";

export interface RestartPresetChoice {
  id: string;
  name: string;
  color?: string;
  /** Codex headroom for the preset's home, when there's a reading for it. */
  hint?: string;
}

function setsCodexHome(preset: AgentPreset): boolean {
  return Object.keys(preset.env ?? {}).some((name) => name.toUpperCase() === "CODEX_HOME");
}

/**
 * The reading for the home `preset` launches into. Profiles carry preset names,
 * never ids, and main lists only the agent's own presets — so a project or CCR
 * preset gets no reading rather than a namesake's, and a preset that sets no
 * home of its own runs on the default profile.
 */
export function codexProfileForPreset(
  preset: AgentPreset,
  globalPresetIds: ReadonlySet<string>,
  profiles: readonly CodexQuotaProfile[]
): CodexQuotaProfile | undefined {
  if (!globalPresetIds.has(preset.id)) return undefined;
  const named = profiles.find((profile) => profile.presetNames.includes(preset.name));
  if (named) return named;
  return setsCodexHome(preset) ? undefined : profiles.find((profile) => profile.isDefault);
}

/** "Weekly limit 82% used · plus": the tightest window, plus the plan when reported. */
export function formatCodexHeadroom(profile: CodexQuotaProfile | undefined): string | undefined {
  if (!profile || profile.result.status !== "ok") return undefined;
  const { windows, planType } = profile.result;
  const tightest = windows.reduce<(typeof windows)[number] | undefined>(
    (worst, window) => (!worst || window.usedPercent > worst.usedPercent ? window : worst),
    undefined
  );
  const parts = [
    tightest
      ? `${windowLabel(tightest.windowDurationMins)} ${Math.round(tightest.usedPercent)}% used`
      : undefined,
    planType ?? undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The presets an agent pane can move to: every other preset of its own agent
 * (#13746). Codex quota is read only while `open`, so a closed menu costs no
 * app-server round trips.
 */
export function useRestartPresetChoices(
  agentId: string | undefined,
  currentPresetId: string | undefined,
  open: boolean
): RestartPresetChoice[] {
  const customPresets = useAgentSettingsStore((s) =>
    agentId ? s.settings?.agents?.[agentId]?.customPresets : undefined
  );
  const ccrPresets = useCcrPresetsStore((s) =>
    agentId ? s.ccrPresetsByAgent[agentId] : undefined
  );
  const projectPresets = useProjectPresetsStore((s) =>
    agentId ? s.presetsByAgent[agentId] : undefined
  );
  const { profiles } = useCodexQuota(open && agentId === "codex");

  return useMemo(() => {
    if (!agentId) return [];
    const presets = getMergedPresets(agentId, customPresets, ccrPresets, projectPresets);
    const globalPresetIds =
      agentId === "codex"
        ? new Set(getMergedPresets("codex", customPresets).map((preset) => preset.id))
        : new Set<string>();
    return presets
      .filter((preset) => preset.id !== currentPresetId)
      .map((preset) => ({
        id: preset.id,
        name: preset.name,
        color: preset.color,
        hint: profiles
          ? formatCodexHeadroom(codexProfileForPreset(preset, globalPresetIds, profiles))
          : undefined,
      }));
  }, [agentId, currentPresetId, customPresets, ccrPresets, projectPresets, profiles]);
}
