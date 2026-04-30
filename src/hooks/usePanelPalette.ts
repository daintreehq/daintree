import { useCallback, useEffect, useMemo, useState } from "react";
import type { IFuseOptions } from "fuse.js";
import { getPanelKindIds, getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { getPanelKindDefinition } from "@/registry";
import { getEffectiveAgentIds, getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { keybindingService } from "@/services/KeybindingService";
import { formatTimeAgo } from "@/utils/timeAgo";
import { isUselessTitle } from "@shared/utils/isUselessTitle";
import type { KeyAction } from "@shared/types/keymap";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

export interface PanelKindOption {
  id: string;
  name: string;
  iconId: string;
  color: string;
  description?: string;
  searchAliases?: string[];
  category: "agent" | "tool" | "resume";
  installed?: boolean;
  resumeSession?: AgentSessionRecord;
}

export type UsePanelPaletteReturn = UseSearchablePaletteReturn<PanelKindOption> & {
  handleSelect: (option: PanelKindOption) => PanelKindOption | null;
  confirmSelection: () => PanelKindOption | null;
};

import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { isAgentInstalled } from "../../shared/utils/agentAvailability";

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

const AGENT_LAUNCH_ACTIONS: Record<string, KeyAction> = Object.fromEntries(
  BUILT_IN_AGENT_IDS.map((id) => [id, `agent.${id}` as KeyAction])
);

const PANEL_FUSE_OPTIONS: IFuseOptions<PanelKindOption> = {
  keys: [
    { name: "name", weight: 2 },
    { name: "searchAliases", weight: 1.5 },
    { name: "description", weight: 1 },
  ],
  threshold: 0.4,
  includeScore: true,
};

function prettifyModelId(modelId: string): string {
  let name = modelId;
  const slashIdx = name.lastIndexOf("/");
  if (slashIdx >= 0) name = name.slice(slashIdx + 1);
  name = name
    .replace(/^claude-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return name;
}

export const MORE_AGENTS_PANEL_ID = "more-agents";

export function usePanelPalette(): UsePanelPaletteReturn {
  const userRegistry = useUserAgentRegistryStore((state) => state.registry);
  const availability = useCliAvailabilityStore((state) => state.availability);
  const isAvailabilityInitialized = useCliAvailabilityStore((state) => state.isInitialized);
  const [keybindingVersion, setKeybindingVersion] = useState(0);
  const [resumeSessions, setResumeSessions] = useState<AgentSessionRecord[]>([]);
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  useEffect(() => {
    return keybindingService.subscribe(() => setKeybindingVersion((v) => v + 1));
  }, []);

  const availableKinds = useMemo<PanelKindOption[]>(() => {
    const panelKinds = getPanelKindIds()
      .filter((kindId) => {
        if (kindId === "agent") return false;
        const config = getPanelKindConfig(kindId);
        if (!config) return false;
        if (config.showInPalette === false) return false;
        if (!getPanelKindDefinition(kindId)) return false;
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
          searchAliases: config.searchAliases,
          category: "tool" as const,
        };
      });

    const isAgentHidden = (agentId: string): boolean => {
      if (!isAvailabilityInitialized) return false;
      return !isAgentInstalled(availability[agentId]);
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
          description: displayCombo || agentConfig.tooltip,
          category: "agent" as const,
          installed: isAvailabilityInitialized
            ? isAgentInstalled(availability[agentId])
            : undefined,
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

    const resumeOptions: PanelKindOption[] = resumeSessions
      .filter((session) => !!session.sessionId)
      .slice(0, 5)
      .map((session) => {
        const agentConfig = getEffectiveAgentConfig(session.agentId);
        const timeAgo = formatTimeAgo(session.savedAt);
        const modelPart = session.agentModelId ? prettifyModelId(session.agentModelId) : null;
        const agentName = agentConfig?.name ?? session.agentId;
        const hasMeaningfulTitle = !!session.title && !isUselessTitle(session.title);
        const name = hasMeaningfulTitle ? `Resume: ${session.title}` : `Resume ${agentName}`;
        const descriptionParts = [modelPart, hasMeaningfulTitle ? agentName : null, timeAgo].filter(
          (part): part is string => !!part
        );
        const description = descriptionParts.join(" · ");
        return {
          id: `resume:${session.sessionId}`,
          name,
          iconId: agentConfig?.iconId ?? "terminal",
          color: agentConfig?.color ?? "var(--color-daintree-text)",
          description,
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
        color: "var(--color-daintree-text)",
        description: "Set up additional AI agents",
        category: "agent" as const,
      },
      ...toolDedup.values(),
      ...resumeOptions,
    ];
  }, [userRegistry, keybindingVersion, resumeSessions, availability, isAvailabilityInitialized]);

  const { results, selectedIndex, close, isOpen, matchesById, ...paletteRest } =
    useSearchablePalette<PanelKindOption>({
      items: availableKinds,
      fuseOptions: PANEL_FUSE_OPTIONS,
      includeMatches: true,
      maxResults: 20,
      paletteId: "panel",
    });

  useEffect(() => {
    if (!isOpen) return;
    const { lastCheckedAt, refresh, isInitialized, initialize } =
      useCliAvailabilityStore.getState();
    if (!isInitialized) {
      void initialize();
      return;
    }
    const isStale = !lastCheckedAt || Date.now() - lastCheckedAt > STALE_THRESHOLD_MS;
    if (isStale) void refresh().catch(() => {});
  }, [isOpen]);

  useEffect(() => {
    let cancelled = false;
    window.electron?.agentSessionHistory
      ?.list(activeWorktreeId ?? undefined)
      .then((sessions) => {
        if (!cancelled) setResumeSessions(sessions);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeWorktreeId]);

  const handleSelect = useCallback(
    (option: PanelKindOption): PanelKindOption | null => {
      if (option.id === MORE_AGENTS_PANEL_ID || option.installed === false) {
        close();
        window.dispatchEvent(
          new CustomEvent("daintree:open-agent-setup-wizard", {
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

    if (selected.id === MORE_AGENTS_PANEL_ID || selected.installed === false) {
      close();
      window.dispatchEvent(
        new CustomEvent("daintree:open-agent-setup-wizard", {
          detail: { returnToPanelPalette: true },
        })
      );
      return null;
    }
    close();
    return selected;
  }, [results, selectedIndex, close]);

  return {
    results,
    selectedIndex,
    close,
    isOpen,
    matchesById,
    ...paletteRest,
    handleSelect,
    confirmSelection,
  };
}
