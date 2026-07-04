import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { IFuseOptions } from "fuse.js";
import { getPanelKindIds, getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { getPanelKindDefinition } from "@/registry";
import { getEffectiveAgentIds, getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import {
  subscribeToPluginAgentRegistry,
  getPluginAgentRegistrySnapshot,
} from "@shared/config/pluginAgentRegistry";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePaletteStore } from "@/store/paletteStore";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { keybindingService } from "@/services/KeybindingService";
import { buildResumeSessionItems } from "@/services/resumeSessionItems";
import { useAgentSessionRecords } from "@/hooks/useAgentSessionRecords";
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
  /**
   * Resume entry whose recorded worktree no longer resolves in the live
   * worktree map (deleted/removed). Rendered greyed-out with a "Worktree
   * removed" badge and excluded from keyboard navigation / launch (#10851).
   */
  isStale?: boolean;
  /** Live worktree display name for a resume entry, when it still resolves. */
  worktreeName?: string;
  /** Branch a resume entry was captured on (live value preferred over recorded). */
  branchName?: string;
}

export type UsePanelPaletteReturn = UseSearchablePaletteReturn<PanelKindOption> & {
  handleSelect: (option: PanelKindOption) => PanelKindOption | null;
  confirmSelection: () => PanelKindOption | null;
};

import {
  LAUNCHABLE_AGENT_IDS,
  isBuiltInAgentId,
  isAssistantOnlyAgentId,
} from "@shared/config/agentIds";
import { isAgentInstalled } from "../../shared/utils/agentAvailability";

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Resume entries shown in the panel palette — a short "most recent" shelf.
 * The dedicated resume launcher (`terminal.resumeSessions`) is the browse and
 * search surface for the full journal.
 */
const RECENT_RESUME_COUNT = 5;

const AGENT_LAUNCH_ACTIONS: Record<string, KeyAction> = Object.fromEntries(
  LAUNCHABLE_AGENT_IDS.map((id) => [id, `agent.${id}` as KeyAction])
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

export const MORE_AGENTS_PANEL_ID = "more-agents";

export function usePanelPalette(): UsePanelPaletteReturn {
  const userRegistry = useUserAgentRegistryStore((state) => state.registry);
  const availability = useCliAvailabilityStore((state) => state.availability);
  const isAvailabilityInitialized = useCliAvailabilityStore((state) => state.isInitialized);
  const [keybindingVersion, setKeybindingVersion] = useState(0);
  // Open state read straight from the palette store (the same source
  // useSearchablePalette derives isOpen from) so the journal fetch can be
  // gated on it before the palette hook runs.
  const paletteIsOpen = usePaletteStore((state) => state.activePaletteId === "panel");
  // Journal fetch gated on open; refreshed live when a close path journals a
  // new record, so a just-expired session appears without reopening.
  const { sessions: resumeSessions } = useAgentSessionRecords(paletteIsOpen);
  // Live per-view worktree map: drives stale-entry detection and location labels.
  const worktrees = useWorktreeStore((state) => state.worktrees);
  // Scope the browsable resume list to the current project's own history.
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  // Re-render when a plugin loads/unloads mid-session so agent icon/name/color
  // refresh from the updated registry (#9879).
  const pluginAgentRegistry = useSyncExternalStore(
    subscribeToPluginAgentRegistry,
    getPluginAgentRegistrySnapshot
  );

  useEffect(() => {
    return keybindingService.subscribe(() => setKeybindingVersion((v) => v + 1));
  }, []);

  const availableKinds = useMemo<PanelKindOption[]>(() => {
    // Referenced so this memo re-derives when plugins load/unload mid-session;
    // getEffectiveAgentIds/Config below read the merged (incl. plugin) registry (#9879).
    void pluginAgentRegistry;
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
      // Assistant-only agents are never launchable from the palette — they
      // exist solely for the Daintree Assistant overlay.
      if (isAssistantOnlyAgentId(agentId)) return true;
      if (!isAvailabilityInitialized) return false;
      // Plugin-contributed agents are always shown — greyed-out via the
      // `installed` field when their command is unresolved/uninstalled — rather
      // than silently dropped the way an uninstalled built-in agent is (#10560).
      // Without this, a plugin agent whose availability is still `undefined`
      // (never probed) fails `isAgentInstalled` and vanishes from the palette.
      if (!isBuiltInAgentId(agentId)) return false;
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

    // The journal is fetched unscoped (all worktrees/projects, newest-first).
    // The shared builder scopes it to this project and maps each record to
    // rich metadata; the palette keeps only a launchable most-recent shelf.
    const resumeOptions: PanelKindOption[] = buildResumeSessionItems(resumeSessions, {
      currentProjectId,
      worktrees,
    })
      .filter((item) => !item.isStale)
      .slice(0, RECENT_RESUME_COUNT)
      .map((item) => ({
        id: item.id,
        name: item.name,
        iconId: item.iconId,
        color: item.color,
        description: item.description,
        searchAliases: item.searchAliases,
        category: "resume" as const,
        resumeSession: item.session,
        isStale: item.isStale,
        worktreeName: item.worktreeName,
        branchName: item.branchName,
      }));

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
  }, [
    userRegistry,
    keybindingVersion,
    resumeSessions,
    worktrees,
    currentProjectId,
    availability,
    isAvailabilityInitialized,
    pluginAgentRegistry,
  ]);

  const { results, selectedIndex, close, isOpen, matchesById, ...paletteRest } =
    useSearchablePalette<PanelKindOption>({
      items: availableKinds,
      fuseOptions: PANEL_FUSE_OPTIONS,
      includeMatches: true,
      // Higher ceiling than the default 20 so the browsable resume list can
      // surface many closed sessions across worktrees without one crowding out
      // agents/tools; rendered DOM stays capped via the palette overflow notice.
      maxResults: 60,
      canNavigate: (item) => !item.isStale,
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

  const handleSelect = useCallback(
    (option: PanelKindOption): PanelKindOption | null => {
      // Stale resume entries (removed worktree) can't be launched — swallow the
      // click rather than routing to the setup wizard or attempting a resume.
      if (option.isStale) return null;
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
    if (selected.isStale) return null;

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
