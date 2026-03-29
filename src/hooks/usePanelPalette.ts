import { useCallback, useEffect, useMemo, useState } from "react";
import { getPanelKindIds, getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { hasPanelComponent } from "@/registry/panelComponentRegistry";
import { getEffectiveAgentIds, getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { keybindingService } from "@/services/KeybindingService";
import type { KeyAction } from "@shared/types/keymap";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

export interface PanelKindOption {
  id: string;
  name: string;
  iconId: string;
  color: string;
  description?: string;
  category: "agent" | "tool" | "resume";
  resumeSession?: AgentSessionRecord;
}

export type UsePanelPaletteReturn = UseSearchablePaletteReturn<PanelKindOption> & {
  handleSelect: (option: PanelKindOption) => PanelKindOption | null;
  confirmSelection: () => PanelKindOption | null;
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

export function usePanelPalette(): UsePanelPaletteReturn {
  const userRegistry = useUserAgentRegistryStore((state) => state.registry);
  const agentSettings = useAgentSettingsStore((state) => state.settings);
  const [keybindingVersion, setKeybindingVersion] = useState(0);
  const [resumeSessions, setResumeSessions] = useState<AgentSessionRecord[]>([]);

  useEffect(() => {
    return keybindingService.subscribe(() => setKeybindingVersion((v) => v + 1));
  }, []);

  useEffect(() => {
    window.electron?.agentSessionHistory
      ?.list()
      .then(setResumeSessions)
      .catch(() => {});
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

    const resumeOptions: PanelKindOption[] = resumeSessions.slice(0, 5).map((session) => {
      const agentConfig = getEffectiveAgentConfig(session.agentId);
      const date = new Date(session.savedAt);
      const timeStr = `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
      return {
        id: `resume:${session.sessionId}`,
        name: `Resume ${agentConfig?.name ?? session.agentId}`,
        iconId: agentConfig?.iconId ?? "terminal",
        color: agentConfig?.color ?? "var(--color-canopy-text)",
        description: `${session.sessionId.slice(0, 8)}… · ${timeStr}`,
        category: "resume" as const,
        resumeSession: session,
      };
    });

    return [
      ...agentDedup.values(),
      {
        id: MORE_AGENTS_PANEL_ID,
        name: "More agents...",
        iconId: "sparkles",
        color: "var(--color-canopy-text)",
        description: "Set up additional AI agents",
        category: "agent" as const,
      },
      ...resumeOptions,
      ...toolDedup.values(),
    ];
  }, [userRegistry, keybindingVersion, agentSettings, resumeSessions]);

  const { results, selectedIndex, close, ...paletteRest } = useSearchablePalette<PanelKindOption>({
    items: availableKinds,
    filterFn: filterPanelKinds,
    maxResults: 20,
    paletteId: "panel",
  });

  const handleSelect = useCallback(
    (option: PanelKindOption): PanelKindOption | null => {
      if (option.id === MORE_AGENTS_PANEL_ID) {
        close();
        window.dispatchEvent(
          new CustomEvent("canopy:open-agent-setup-wizard", {
            detail: { returnToPanelPalette: true },
          })
        );
        return null;
      }
      close();
      return option;
    },
    [close]
  );

  const confirmSelection = useCallback((): PanelKindOption | null => {
    if (results.length === 0 || selectedIndex < 0) return null;
    const selected = results[selectedIndex];
    if (!selected) return null;

    if (selected.id === MORE_AGENTS_PANEL_ID) {
      close();
      window.dispatchEvent(
        new CustomEvent("canopy:open-agent-setup-wizard", {
          detail: { returnToPanelPalette: true },
        })
      );
      return selected;
    }
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
