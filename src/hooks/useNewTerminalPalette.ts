import { useState, useCallback, useMemo, useEffect } from "react";
import { getLaunchOptions, type LaunchOption } from "@/components/TerminalPalette/launchOptions";
import type { LaunchAgentOptions } from "./useAgentLauncher";
import { useWorktreeSelectionStore, useTerminalStore } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import type { WorktreeState } from "@/types";

interface UseNewTerminalPaletteProps {
  launchAgent: (
    type: "claude" | "gemini" | "codex" | "terminal",
    options?: LaunchAgentOptions
  ) => Promise<string | null>;
  worktreeMap: Map<string, WorktreeState>;
}

export function useNewTerminalPalette({ launchAgent, worktreeMap }: UseNewTerminalPaletteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const currentProject = useProjectStore((state) => state.currentProject);

  const options = useMemo(() => getLaunchOptions(), []);

  const filteredOptions = useMemo(() => {
    if (!query.trim()) return options;
    const lowerQuery = query.toLowerCase();
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(lowerQuery) ||
        opt.description.toLowerCase().includes(lowerQuery)
    );
  }, [options, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredOptions]);

  const open = useCallback(() => {
    setIsOpen(true);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const selectNext = useCallback(() => {
    setSelectedIndex((prev) => (prev >= filteredOptions.length - 1 ? 0 : prev + 1));
  }, [filteredOptions.length]);

  const selectPrevious = useCallback(() => {
    setSelectedIndex((prev) => (prev <= 0 ? filteredOptions.length - 1 : prev - 1));
  }, [filteredOptions.length]);

  const addTerminal = useTerminalStore((state) => state.addTerminal);

  const handleSelect = useCallback(
    async (option: LaunchOption) => {
      const targetWorktreeId = activeWorktreeId;
      const targetWorktree = targetWorktreeId ? worktreeMap.get(targetWorktreeId) : null;
      const cwd = targetWorktree?.path ?? currentProject?.path ?? "";

      try {
        // Handle browser pane specially - it doesn't use the agent launcher
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
    if (filteredOptions.length > 0 && selectedIndex < filteredOptions.length) {
      handleSelect(filteredOptions[selectedIndex]);
    }
  }, [filteredOptions, selectedIndex, handleSelect]);

  return {
    isOpen,
    open,
    close,
    query,
    setQuery,
    results: filteredOptions,
    selectedIndex,
    selectNext,
    selectPrevious,
    handleSelect,
    confirmSelection,
  };
}
