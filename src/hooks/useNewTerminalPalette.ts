import { useCallback, useMemo } from "react";
import {
  getLaunchOptions,
  getMoreAgentsOption,
  type LaunchOption,
} from "@/components/TerminalPalette/launchOptions";
import type { LaunchAgentOptions } from "./useAgentLauncher";
import { useWorktreeSelectionStore, useTerminalStore } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import type { WorktreeState } from "@/types";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { actionService } from "@/services/ActionService";
import { getEffectiveAgentIds } from "@shared/config/agentRegistry";

interface UseNewTerminalPaletteProps {
  launchAgent: (
    type: "claude" | "gemini" | "codex" | "opencode" | "terminal",
    options?: LaunchAgentOptions
  ) => Promise<string | null>;
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
  launchAgent,
  worktreeMap,
}: UseNewTerminalPaletteProps): UseNewTerminalPaletteReturn {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const currentProject = useProjectStore((state) => state.currentProject);
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const agentSettings = useAgentSettingsStore((state) => state.settings);

  const options = useMemo(() => {
    const allOptions = getLaunchOptions();
    const registryAgentIds = new Set(getEffectiveAgentIds());

    // When settings haven't loaded yet, show all agents (no filter).
    // When loaded, hide agents explicitly deselected (selected === false).
    // Agents with selected === undefined (pre-migration) are treated as visible.
    const isAgentHidden = (id: string): boolean => {
      if (!agentSettings?.agents) return false;
      return agentSettings.agents[id]?.selected === false;
    };

    const filtered = allOptions.filter(
      (opt) => !registryAgentIds.has(opt.id) || !isAgentHidden(opt.id)
    );

    filtered.push(getMoreAgentsOption());

    return filtered;
  }, [agentSettings]);

  const { results, selectedIndex, close, ...paletteRest } = useSearchablePalette<LaunchOption>({
    items: options,
    filterFn: filterLaunchOptions,
    maxResults: 20,
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
          await addTerminal({
            kind: "browser",
            cwd,
            worktreeId: targetWorktreeId || undefined,
            location: "grid",
          });
          close();
          return;
        }

        await launchAgent(option.type, {
          worktreeId: targetWorktreeId || undefined,
          cwd,
          location: "grid",
        });
        close();
      } catch (error) {
        console.error(`Failed to launch ${option.type} terminal:`, error);
      }
    },
    [activeWorktreeId, worktreeMap, currentProject, launchAgent, addTerminal, close]
  );

  const confirmSelection = useCallback(() => {
    if (results.length > 0 && selectedIndex >= 0) {
      handleSelect(results[selectedIndex]);
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
