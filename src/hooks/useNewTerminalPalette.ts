import { useCallback, useMemo } from "react";
import {
  getLaunchOptions,
  getMoreAgentsOption,
  type LaunchOption,
} from "@/components/TerminalPalette/launchOptions";
import { useWorktreeSelectionStore, usePanelStore } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { logError } from "@/utils/logger";
import type { WorktreeState } from "@/types";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { actionService } from "@/services/ActionService";
import { getEffectiveAgentIds } from "@shared/config/agentRegistry";
import { isAgentInstalled } from "../../shared/utils/agentAvailability";

interface UseNewTerminalPaletteProps {
  worktreeMap: Map<string, WorktreeState>;
}

export type UseNewTerminalPaletteReturn = UseSearchablePaletteReturn<LaunchOption> & {
  handleSelect: (option: LaunchOption) => void;
  confirmSelection: () => void;
};

function filterLaunchOptions(items: LaunchOption[], query: string): LaunchOption[] {
  if (!query.trim()) return items;
  const lowerQuery = query.toLowerCase();
  return items.filter(
    (opt) =>
      opt.label.toLowerCase().includes(lowerQuery) ||
      opt.description.toLowerCase().includes(lowerQuery)
  );
}

export const MORE_AGENTS_TERMINAL_ID = "more-agents";

export function useNewTerminalPalette({
  worktreeMap,
}: UseNewTerminalPaletteProps): UseNewTerminalPaletteReturn {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const currentProject = useProjectStore((state) => state.currentProject);
  const addPanel = usePanelStore((state) => state.addPanel);
  const availability = useCliAvailabilityStore((state) => state.availability);
  const isAvailabilityInitialized = useCliAvailabilityStore((state) => state.isInitialized);

  const options = useMemo(() => {
    const allOptions = getLaunchOptions();
    const registryAgentIds = new Set(getEffectiveAgentIds());

    // Before availability is known, show all agents (avoids startup flicker).
    // Once known, hide agents that are not installed.
    const isAgentHidden = (id: string): boolean => {
      if (!isAvailabilityInitialized) return false;
      return !isAgentInstalled(availability[id]);
    };

    const filtered = allOptions.filter(
      (opt) => !registryAgentIds.has(opt.id) || !isAgentHidden(opt.id)
    );

    filtered.push(getMoreAgentsOption());

    return filtered;
  }, [availability, isAvailabilityInitialized]);

  const { results, selectedIndex, close, ...paletteRest } = useSearchablePalette<LaunchOption>({
    items: options,
    filterFn: filterLaunchOptions,
    maxResults: 20,
    paletteId: "new-terminal",
  });

  const handleSelect = useCallback(
    async (option: LaunchOption) => {
      if (option.id === MORE_AGENTS_TERMINAL_ID) {
        close();
        void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source: "user" });
        return;
      }

      const targetWorktreeId = activeWorktreeId;
      const targetWorktree = targetWorktreeId ? worktreeMap.get(targetWorktreeId) : null;
      const cwd = targetWorktree?.path ?? currentProject?.path ?? "";

      try {
        if (option.kind === "browser") {
          await addPanel({
            kind: "browser",
            cwd,
            worktreeId: targetWorktreeId || undefined,
            location: "grid",
          });
          close();
          return;
        }

        const result = await actionService.dispatch(
          "agent.launch",
          {
            agentId: option.launchAgentId,
            worktreeId: targetWorktreeId || undefined,
            cwd,
            location: "grid",
          },
          { source: "user" }
        );
        if (!result.ok) {
          logError(`Failed to launch ${option.launchAgentId} terminal`, undefined, {
            error: result.error,
          });
        }
        close();
      } catch (error) {
        logError(`Failed to launch ${option.launchAgentId} terminal`, error);
      }
    },
    [activeWorktreeId, worktreeMap, currentProject, addPanel, close]
  );

  const confirmSelection = useCallback(() => {
    if (results.length > 0 && selectedIndex >= 0) {
      handleSelect(results[selectedIndex]!);
    }
  }, [results, selectedIndex, handleSelect]);

  return {
    results,
    selectedIndex,
    close,
    ...paletteRest,
    handleSelect,
    confirmSelection,
  };
}
