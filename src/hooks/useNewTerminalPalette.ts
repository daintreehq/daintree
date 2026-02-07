import { useCallback, useMemo, useRef } from "react";
import { getLaunchOptions, type LaunchOption } from "@/components/TerminalPalette/launchOptions";
import type { LaunchAgentOptions } from "./useAgentLauncher";
import { useWorktreeSelectionStore, useTerminalStore } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import type { WorktreeState } from "@/types";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";

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

export function useNewTerminalPalette({
  launchAgent,
  worktreeMap,
}: UseNewTerminalPaletteProps): UseNewTerminalPaletteReturn {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const currentProject = useProjectStore((state) => state.currentProject);
  const addTerminal = useTerminalStore((state) => state.addTerminal);

  const options = useMemo(() => getLaunchOptions(), []);

  const closeFnRef = useRef<() => void>(() => {});

  const handleSelect = useCallback(
    async (option: LaunchOption) => {
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
          closeFnRef.current();
          return;
        }

        await launchAgent(option.type, {
          worktreeId: targetWorktreeId || undefined,
          cwd,
          location: "grid",
        });
        closeFnRef.current();
      } catch (error) {
        console.error(`Failed to launch ${option.type} terminal:`, error);
      }
    },
    [activeWorktreeId, worktreeMap, currentProject, launchAgent, addTerminal]
  );

  const { results, selectedIndex, close, ...paletteRest } = useSearchablePalette<LaunchOption>({
    items: options,
    filterFn: filterLaunchOptions,
    maxResults: 20,
  });

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
