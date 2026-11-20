import type { AgentPreset } from "@shared/config/agentRegistry";
import {
  getMergedPresetIdentities,
  getMergedPresets,
  sanitizePreset,
} from "@shared/utils/agentPresets";

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
  /** The CCR and project inventories have loaded, so an unknown id is gone, not pending. */
  inventoryReady?: boolean;
}

/**
 * The preset a pane hops from when `presetId` is the next step of the chain it
 * walks, on one of the person's own presets (#17917); null for any other move.
 *
 * Once the inventories have loaded, the chain is the one a usage-limit hop
 * walks (the root's `fallbacks` in the merge, a deleted step dropped), so the
 * two share one index. Until then it is the root's list as the person saved
 * it: the merge would drop a step that hasn't loaded yet and move a later one
 * into its slot. Only a pane still on the step before counts, since an edited
 * chain no longer describes where the pane is. The root must be the person's
 * own: a project's chain never qualifies. Nor does a project preset as the
 * step, or one not yet known: a team file can put other flags under an id the
 * person chose.
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
    (presets.inventoryReady === true
      ? getMergedPresets(agentId, customPresets, ccrPresets, projectPresets).find(
          (preset) => preset.id === root
        )
      : // The first valid custom preset with the id, as the merge picks it.
        (customPresets ?? []).map(sanitizePreset).find((preset) => preset?.id === root)
    )?.fallbacks ?? [];
  const current = index === 0 ? root : chain[index - 1];
  if (current === undefined || pane.agentPresetId !== current) return null;
  return chain[index] === presetId ? root : null;
}
