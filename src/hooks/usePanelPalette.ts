import { useCallback, useEffect, useMemo, useState } from "react";
import { getPanelKindIds, getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { hasPanelComponent } from "@/registry/panelComponentRegistry";
import {
  getEffectiveAgentIds,
  getEffectiveAgentConfig,
  type AgentModelConfig,
} from "@shared/config/agentRegistry";
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
  category: "agent" | "tool" | "model";
}

export type PanelPalettePhase = "panel" | "model";

export const DEFAULT_MODEL_OPTION_ID = "__default__";

export type UsePanelPaletteReturn = UseSearchablePaletteReturn<PanelKindOption> & {
  phase: PanelPalettePhase;
  pendingAgentId: string | null;
  handleSelect: (option: PanelKindOption) => PanelKindOption;
  confirmSelection: () => PanelKindOption | null;
  backToPanel: () => void;
};

import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";

const AGENT_LAUNCH_ACTIONS: Record<string, KeyAction> = Object.fromEntries(
  BUILT_IN_AGENT_IDS.map((id) => [id, `agent.${id}` as KeyAction])
);

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

function buildModelOptions(agentId: string): PanelKindOption[] {
  const agentConfig = getEffectiveAgentConfig(agentId);
  if (!agentConfig?.models?.length) return [];

  const options: PanelKindOption[] = [
    {
      id: DEFAULT_MODEL_OPTION_ID,
      name: "Use default model",
      iconId: agentConfig.iconId,
      color: agentConfig.color,
      description: "Launch with the agent's default model",
      category: "model",
    },
    ...agentConfig.models.map(
      (m: AgentModelConfig): PanelKindOption => ({
        id: m.id,
        name: m.name,
        iconId: agentConfig.iconId,
        color: agentConfig.color,
        category: "model",
      })
    ),
  ];
  return options;
}

export function usePanelPalette(): UsePanelPaletteReturn {
  const userRegistry = useUserAgentRegistryStore((state) => state.registry);
  const agentSettings = useAgentSettingsStore((state) => state.settings);
  const [keybindingVersion, setKeybindingVersion] = useState(0);
  const [phase, setPhase] = useState<PanelPalettePhase>("panel");
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);

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
          category: "tool" as const,
        };
      });

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
          category: "agent" as const,
        };
      })
      .filter((agent): agent is PanelKindOption => agent !== null);

    const agentDedup = new Map<string, PanelKindOption>();
    for (const option of agentKinds) {
      if (!agentDedup.has(option.id)) {
        agentDedup.set(option.id, option);
      }
    }

    const toolDedup = new Map<string, PanelKindOption>();
    for (const option of panelKinds) {
      if (!toolDedup.has(option.id)) {
        toolDedup.set(option.id, option);
      }
    }

    return [
      ...agentDedup.values(),
      {
        id: MORE_AGENTS_PANEL_ID,
        name: "More agents...",
        iconId: "settings",
        color: "var(--color-canopy-text)",
        description: "Configure which agents appear in this menu",
        category: "agent" as const,
      },
      ...toolDedup.values(),
    ];
  }, [userRegistry, keybindingVersion, agentSettings]);

  const modelOptions = useMemo<PanelKindOption[]>(() => {
    if (!pendingAgentId) return [];
    return buildModelOptions(pendingAgentId);
  }, [pendingAgentId]);

  const items = phase === "model" ? modelOptions : availableKinds;

  const {
    results,
    selectedIndex,
    close: baseClose,
    ...paletteRest
  } = useSearchablePalette<PanelKindOption>({
    items,
    filterFn: filterPanelKinds,
    maxResults: 20,
    paletteId: "panel",
  });

  const resetPhase = useCallback(() => {
    setPhase("panel");
    setPendingAgentId(null);
  }, []);

  const close = useCallback(() => {
    baseClose();
    resetPhase();
  }, [baseClose, resetPhase]);

  const backToPanel = useCallback(() => {
    resetPhase();
    paletteRest.setQuery("");
  }, [resetPhase, paletteRest]);

  const enterModelPhase = useCallback(
    (agentId: string) => {
      setPendingAgentId(agentId);
      setPhase("model");
      paletteRest.setQuery("");
    },
    [paletteRest]
  );

  const handleSelect = useCallback(
    (option: PanelKindOption): PanelKindOption => {
      if (phase === "panel") {
        if (option.id === MORE_AGENTS_PANEL_ID) {
          close();
          void actionService.dispatch(
            "app.settings.openTab",
            { tab: "agents" },
            { source: "user" }
          );
          return option;
        }
        if (option.id.startsWith("agent:")) {
          const agentId = option.id.slice("agent:".length);
          const agentConfig = getEffectiveAgentConfig(agentId);
          if (agentConfig?.models?.length) {
            enterModelPhase(agentId);
            return option;
          }
        }
        close();
        return option;
      }
      // model phase — close and return the selected model option
      close();
      return option;
    },
    [phase, close, enterModelPhase]
  );

  const confirmSelection = useCallback((): PanelKindOption | null => {
    if (results.length === 0 || selectedIndex < 0) return null;
    const selected = results[selectedIndex];
    if (!selected) return null;

    if (phase === "panel") {
      if (selected.id === MORE_AGENTS_PANEL_ID) {
        close();
        void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source: "user" });
        return selected;
      }
      if (selected.id.startsWith("agent:")) {
        const agentId = selected.id.slice("agent:".length);
        const agentConfig = getEffectiveAgentConfig(agentId);
        if (agentConfig?.models?.length) {
          enterModelPhase(agentId);
          return null;
        }
      }
      close();
      return selected;
    }

    // model phase
    close();
    return selected;
  }, [results, selectedIndex, phase, close, enterModelPhase]);

  return {
    results,
    selectedIndex,
    close,
    ...paletteRest,
    phase,
    pendingAgentId,
    handleSelect,
    confirmSelection,
    backToPanel,
  };
}
