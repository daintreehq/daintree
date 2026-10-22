import type { PluginPanelBadge, PluginPanelBadgeColor } from "@shared/types/plugin";
import {
  describeToolbarBadge,
  mostSevereBadgeColor,
  toolbarBadgeCountGlyph,
} from "./pluginToolbarBadge";

export interface DockChipBadgeModel {
  /** The capped count the pill shows, or null when the mark is a dot. */
  countGlyph: string | null;
  color: PluginPanelBadgeColor;
  /** Every badge's words, for the tooltip and the chip's accessible name. */
  description: string;
}

/**
 * The badges on one docked panel folded into the single mark its chip can hold.
 * A count pill only when exactly one badge exists and it is a whole number:
 * several counts from unrelated plugins mean nothing summed, so they fall back
 * to a dot that still carries every description. A badge on a panel its plugin
 * does not own is drawn neutral *before* the severity fold, so a foreign error
 * can never lift an owner's neutral badge, and it names its plugin (#13766).
 */
export function foldDockChipBadges(
  entries: readonly (readonly [pluginId: string, badge: PluginPanelBadge])[],
  owner: string | null,
  pluginName: (pluginId: string) => string
): DockChipBadgeModel | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));

  const effective = sorted.map(([pluginId, badge]) =>
    pluginId === owner ? badge : { ...badge, color: "default" as const }
  );
  const color = mostSevereBadgeColor(effective) ?? "default";

  const description = sorted
    .map(([pluginId, badge]) =>
      pluginId === owner
        ? describeToolbarBadge(badge)
        : `${pluginName(pluginId)}: ${describeToolbarBadge(badge)}`
    )
    .join("; ");

  const only = sorted.length === 1 ? sorted[0]![1] : null;
  return { countGlyph: only ? toolbarBadgeCountGlyph(only) : null, color, description };
}

/** The badge's words appended to a chip's accessible name, or nothing. */
export function dockChipBadgeLabelSuffix(model: DockChipBadgeModel | null): string {
  return model ? ` — ${model.description}` : "";
}
