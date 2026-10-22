import { useEffect, useMemo } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanelBadges, usePluginPanelBadgeStore } from "@/store/pluginPanelBadgeStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
import { usePanelOwnerPluginId } from "@/components/Panel/PluginPanelBadges";
import { foldDockChipBadges, type DockChipBadgeModel } from "./dockChipBadgeModel";

/**
 * What a plugin set on this panel via `host.setPanelBadge`, folded for its dock
 * chip. Initialises the badge store itself: a docked panel's header is not
 * mounted, so nothing else is guaranteed to have subscribed.
 */
export function useDockChipBadge(panelId: string): DockChipBadgeModel | null {
  const init = usePluginPanelBadgeStore((s) => s.init);
  useEffect(() => init(), [init]);

  const badges = usePanelBadges(panelId);
  const owner = usePanelOwnerPluginId(panelId);
  const metaById = usePluginRuntimeStore((s) => s.pluginMetaById);

  return useMemo(
    () =>
      foldDockChipBadges(
        Object.entries(badges),
        owner,
        (pluginId) =>
          metaById.get(pluginId)?.displayName ?? pluginManifestIdFromInstanceKey(pluginId)
      ),
    [badges, owner, metaById]
  );
}

/**
 * The chip's badge mark: a capped count pill or a dot, inline after the title.
 * Decorative — the chip's accessible name carries the words — so there is no
 * live region here, and the tooltip is a pointer-only disclosure of the full
 * text. Neutral by construction: never the accent, never green.
 */
export function DockChipBadge({ model }: { model: DockChipBadgeModel | null }) {
  if (!model) return null;
  const { countGlyph, color, description } = model;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-hidden="true"
          data-dock-chip-badge={countGlyph ? "count" : "dot"}
          data-badge-color={color}
          className="dock-chip-badge"
        >
          {countGlyph}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{description}</TooltipContent>
    </Tooltip>
  );
}
