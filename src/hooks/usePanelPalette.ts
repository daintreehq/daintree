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
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { keybindingService } from "@/services/KeybindingService";
import { formatTimeAgo } from "@/utils/timeAgo";
import {
  NO_WORKTREE_GROUP_KEY,
  pathBasename,
  prettifyModelId,
} from "@/services/resumeSessionItems";
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
  /** Grouping key for the browse view: worktree id, or a no-worktree sentinel. */
  groupKey?: string;
  /** Human label for the resume entry's worktree group header. */
  groupLabel?: string;
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
  const [resumeSessions, setResumeSessions] = useState<AgentSessionRecord[]>([]);
  // Live per-view worktree map: drives stale-entry detection and group labels.
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
    // Keep this project's records, then map each to a rich, groupable option.
    // Legacy records with a null projectId (pre-scoping) are kept only when
    // their worktree still resolves in the live map — otherwise there's no
    // reliable way to know they belong here.
    const resumeOptions: PanelKindOption[] = resumeSessions
      .filter((session) => !!session.sessionId)
      .filter((session) => {
        if (session.projectId) return session.projectId === currentProjectId;
        return !!session.worktreeId && worktrees.has(session.worktreeId);
      })
      .map((session) => {
        const agentConfig = getEffectiveAgentConfig(session.agentId);
        const timeAgo = formatTimeAgo(session.savedAt);
        const modelPart = session.agentModelId ? prettifyModelId(session.agentModelId) : null;
        const agentName = agentConfig?.name ?? session.agentId;
        const hasMeaningfulTitle = !!session.title && !isUselessTitle(session.title);
        const name = hasMeaningfulTitle ? `Resume: ${session.title}` : `Resume ${agentName}`;

        const liveWorktree = session.worktreeId ? worktrees.get(session.worktreeId) : undefined;
        const isStale = !!session.worktreeId && !liveWorktree;
        const worktreeName = liveWorktree?.name;
        const branchName = liveWorktree?.branch ?? session.branch;

        const groupKey = session.worktreeId ?? NO_WORKTREE_GROUP_KEY;
        const groupLabel = liveWorktree
          ? liveWorktree.name
          : isStale
            ? session.branch || pathBasename(session.cwd) || "Removed worktree"
            : "No worktree";

        // Second metadata line: agent/model, where it ran, and how long ago.
        const locationPart = isStale ? "Worktree removed" : (worktreeName ?? branchName ?? null);
        const descriptionParts = [
          modelPart,
          hasMeaningfulTitle ? agentName : null,
          locationPart,
          timeAgo,
        ].filter((part): part is string => !!part);
        const description = descriptionParts.join(" · ");

        // Broaden search beyond the title so an agent, branch, model, or
        // worktree name matches even when it never appears in the title. The
        // cwd basename is included so a stale entry whose group label falls
        // back to it (no branch, no live worktree) stays findable.
        const searchAliases = [
          session.agentId,
          agentName,
          modelPart,
          worktreeName,
          branchName,
          pathBasename(session.cwd),
        ].filter((alias): alias is string => !!alias);

        return {
          id: `resume:${session.sessionId}`,
          name,
          iconId: agentConfig?.iconId ?? "terminal",
          color: agentConfig?.color ?? "var(--color-daintree-text)",
          description,
          searchAliases,
          category: "resume" as const,
          resumeSession: session,
          isStale,
          worktreeName,
          branchName,
          groupKey,
          groupLabel,
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

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // Fetch unscoped (all worktrees) so the list is browsable; the memo above
    // filters to the current project and flags stale entries (#10851). Gated on
    // open so closing the palette doesn't re-read the whole journal.
    window.electron?.agentSessionHistory
      ?.list()
      .then((sessions) => {
        if (!cancelled) setResumeSessions(sessions);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
