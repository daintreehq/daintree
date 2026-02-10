import { useCallback, useMemo } from "react";
import { getPanelKindIds, getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { hasPanelComponent } from "@/registry/panelComponentRegistry";
import { getEffectiveAgentIds, getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";

export interface PanelKindOption {
  id: string;
  name: string;
  iconId: string;
  color: string;
  description?: string;
}

export type UsePanelPaletteReturn = UseSearchablePaletteReturn<PanelKindOption> & {
  handleSelect: (option: PanelKindOption) => PanelKindOption;
  confirmSelection: () => PanelKindOption | null;
};

function filterPanelKinds(items: PanelKindOption[], query: string): PanelKindOption[] {
  if (!query.trim()) return items;
  const lowerQuery = query.toLowerCase();
  return items.filter(
    (opt) =>
      opt.name.toLowerCase().includes(lowerQuery) ||
      (opt.description && opt.description.toLowerCase().includes(lowerQuery))
  );
}

export function usePanelPalette(): UsePanelPaletteReturn {
  const userRegistry = useUserAgentRegistryStore((state) => state.registry);

  const availableKinds = useMemo<PanelKindOption[]>(() => {
    const allKindIds = getPanelKindIds();

    const panelKinds = allKindIds
      .filter((kindId) => {
        if (kindId === "agent") return false;
        const config = getPanelKindConfig(kindId);
        if (!config) return false;
        if (config.showInPalette === false) return false;
        if (!hasPanelComponent(kindId)) return false;
        return true;
      })
      .map((kindId) => {
        const config = getPanelKindConfig(kindId)!;
        return {
          id: kindId,
          name: config.name,
          iconId: config.iconId,
          color: config.color,
          description: config.shortcut,
        };
      });

    const agentKinds = getEffectiveAgentIds()
      .map((agentId): PanelKindOption | null => {
        const agentConfig = getEffectiveAgentConfig(agentId);
        if (!agentConfig) return null;
        return {
          id: `agent:${agentId}`,
          name: agentConfig.name,
          iconId: agentConfig.iconId,
          color: agentConfig.color,
          description: agentConfig.shortcut ?? agentConfig.tooltip,
        };
      })
      .filter((agent): agent is PanelKindOption => agent !== null);

    const dedupedById = new Map<string, PanelKindOption>();
    for (const option of [...panelKinds, ...agentKinds]) {
      if (!dedupedById.has(option.id)) {
        dedupedById.set(option.id, option);
      }
    }

    return Array.from(dedupedById.values());
  }, [userRegistry]);

  const { results, selectedIndex, close, ...paletteRest } = useSearchablePalette<PanelKindOption>({
    items: availableKinds,
    filterFn: filterPanelKinds,
    maxResults: 20,
  });

  const handleSelect = useCallback(
    (option: PanelKindOption): PanelKindOption => {
      close();
      return option;
    },
    [close]
  );

  const confirmSelection = useCallback((): PanelKindOption | null => {
    if (results.length === 0 || selectedIndex < 0) return null;
    const selected = results[selectedIndex];
    if (!selected) return null;
    close();
    return selected;
  }, [results, selectedIndex, close]);

  return {
    results,
    selectedIndex,
    close,
    ...paletteRest,
    handleSelect,
    confirmSelection,
  };
}
