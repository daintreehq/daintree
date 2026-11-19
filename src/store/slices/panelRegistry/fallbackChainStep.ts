import type { AgentPreset } from "@shared/config/agentRegistry";
import { getMergedPresetIdentities, getMergedPresets } from "@shared/utils/agentPresets";

/** The pane fields a fallback chain is walked by. */
export interface FallbackChainPane {
  agentPresetId?: string;
  originalPresetId?: string;
  fallbackChainIndex?: number;
}

/** The preset inventories a launch resolves against, as the stores hold them. */
export interface FallbackChainPresets {
  customPresets?: AgentPreset[];
  ccrPresets?: AgentPreset[];
  projectPresets?: AgentPreset[];
}

/**
 * The preset a pane hops from when `presetId` is the next step of the chain it
 * walks, on one of the person's own presets (#17917); null for any other move.
 *
 * The chain is the one a usage-limit hop walks (the root's `fallbacks` in the
 * full merge), so the two share one index, and only a pane still on the step
 * before it counts: an edited chain no longer describes where the pane is. The
 * root must be the person's own, since a project's chain never qualifies. A
 * project preset as the step doesn't either: a team file can put other flags
 * under an id the person chose.
 */
export function ownFallbackChainRoot(
  agentId: string,
  pane: FallbackChainPane,
  presetId: string,
  presets: FallbackChainPresets
): string | null {
  const index = pane.fallbackChainIndex ?? 0;
  if (!Number.isInteger(index) || index < 0) return null;
  // A pane that never hopped may predate the root field; one that hopped can't.
  const root = pane.originalPresetId ?? (index === 0 ? pane.agentPresetId : undefined);
  if (!root || !pane.agentPresetId) return null;

  const { customPresets, ccrPresets, projectPresets } = presets;
  const sources = new Map(
    getMergedPresetIdentities(agentId, customPresets, ccrPresets, projectPresets).map((preset) => [
      preset.id,
      preset.source,
    ])
  );
  if (sources.get(root) !== "custom") return null;
  const step = sources.get(presetId);
  if (step === undefined || step === "project") return null;

  const chain =
    getMergedPresets(agentId, customPresets, ccrPresets, projectPresets).find(
      (preset) => preset.id === root
    )?.fallbacks ?? [];
  const current = index === 0 ? root : chain[index - 1];
  if (current === undefined || pane.agentPresetId !== current) return null;
  return chain[index] === presetId ? root : null;
}
