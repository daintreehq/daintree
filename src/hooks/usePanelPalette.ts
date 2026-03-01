import { useCallback, useEffect, useMemo, useState } from "react";
import { getPanelKindIds, getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { hasPanelComponent } from "@/registry/panelComponentRegistry";
import { getEffectiveAgentIds, getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { keybindingService } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";
import type { KeyAction } from "@shared/types/keymap";

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

const AGENT_LAUNCH_ACTIONS: Record<string, KeyAction> = {
  claude: "agent.claude",
  gemini: "agent.gemini",
  codex: "agent.codex",
  opencode: "agent.opencode",
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

export const MORE_AGENTS_PANEL_ID = "more-agents";

export function usePanelPalette(): UsePanelPaletteReturn {
  const userRegistry = useUserAgentRegistryStore((state) => state.registry);
  const agentSettings = useAgentSettingsStore((state) => state.settings);
  const [keybindingVersion, setKeybindingVersion] = useState(0);

  useEffect(() => {
    return keybindingService.subscribe(() => setKeybindingVersion((v) => v + 1));
  }, []);

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

    // When settings haven't loaded, show all agents (no filter).
    // When loaded, hide agents explicitly deselected (selected === false).
    // Agents with selected === undefined (pre-migration) are treated as visible.
    const isAgentHidden = (agentId: string): boolean => {
      if (!agentSettings?.agents) return false;
      return agentSettings.agents[agentId]?.selected === false;
    };

    const agentKinds = getEffectiveAgentIds()
      .filter((agentId) => !isAgentHidden(agentId))
      .map((agentId): PanelKindOption | null => {
        const agentConfig = getEffectiveAgentConfig(agentId);
        if (!agentConfig) return null;
        const actionId = AGENT_LAUNCH_ACTIONS[agentId];
        const displayCombo = actionId ? keybindingService.getDisplayCombo(actionId) : "";
        return {
          id: `agent:${agentId}`,
          name: agentConfig.name,
          iconId: agentConfig.iconId,
          color: agentConfig.color,
          description: displayCombo || agentConfig.shortcut || agentConfig.tooltip,
        };
      })
      .filter((agent): agent is PanelKindOption => agent !== null);

    const dedupedById = new Map<string, PanelKindOption>();
    for (const option of [...panelKinds, ...agentKinds]) {
      if (!dedupedById.has(option.id)) {
        dedupedById.set(option.id, option);
      }
    }

    const result = Array.from(dedupedById.values());

    result.push({
      id: MORE_AGENTS_PANEL_ID,
      name: "More agents...",
      iconId: "settings",
      color: "var(--color-canopy-text)",
      description: "Configure which agents appear in this menu",
    });

    return result;
  }, [userRegistry, keybindingVersion, agentSettings]);

  const { results, selectedIndex, close, ...paletteRest } = useSearchablePalette<PanelKindOption>({
    items: availableKinds,
    filterFn: filterPanelKinds,
    maxResults: 20,
  });

  const handleSelect = useCallback(
    (option: PanelKindOption): PanelKindOption => {
      close();
      if (option.id === MORE_AGENTS_PANEL_ID) {
        void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source: "user" });
      }
      return option;
    },
    [close]
  );

  const confirmSelection = useCallback((): PanelKindOption | null => {
    if (results.length === 0 || selectedIndex < 0) return null;
    const selected = results[selectedIndex];
    if (!selected) return null;
    close();
    if (selected.id === MORE_AGENTS_PANEL_ID) {
      void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source: "user" });
    }
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
