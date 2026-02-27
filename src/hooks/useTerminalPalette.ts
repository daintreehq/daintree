import { useCallback, useMemo } from "react";
import type { IFuseOptions } from "fuse.js";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { useWorktrees } from "./useWorktrees";
import { isPtyPanel } from "@shared/types/domain";
import { useSearchablePalette } from "./useSearchablePalette";

export interface SearchableTerminal {
  id: string;
  title: string;
  type: TerminalInstance["type"];
  kind?: TerminalInstance["kind"];
  agentId?: TerminalInstance["agentId"];
  detectedProcessId?: TerminalInstance["detectedProcessId"];
  worktreeId?: string;
  worktreeName?: string;
  /** Working directory - always present since palette only shows PTY panels */
  cwd: string;
}

export interface UseTerminalPaletteReturn {
  isOpen: boolean;
  query: string;
  results: SearchableTerminal[];
  selectedIndex: number;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  selectPrevious: () => void;
  selectNext: () => void;
  selectTerminal: (terminal: SearchableTerminal) => void;
  confirmSelection: () => void;
}

const FUSE_OPTIONS: IFuseOptions<SearchableTerminal> = {
  keys: [
    { name: "title", weight: 2 },
    { name: "type", weight: 1 },
    { name: "worktreeName", weight: 1.5 },
    { name: "cwd", weight: 0.5 },
  ],
  threshold: 0.4,
  includeScore: true,
};

const MAX_RESULTS = 10;
const DEBOUNCE_MS = 200;

export function useTerminalPalette(): UseTerminalPaletteReturn {
  const terminals = useTerminalStore(useShallow((state) => state.terminals));
  const setFocused = useTerminalStore((state) => state.setFocused);

  const { worktreeMap } = useWorktrees();

  const searchableTerminals = useMemo<SearchableTerminal[]>(() => {
    return terminals
      .filter((t) => t.location !== "trash")
      .filter((t) => t.hasPty !== false)
      .filter((t) => isPtyPanel(t))
      .map((t) => ({
        id: t.id,
        title: t.title,
        type: t.type,
        kind: t.kind,
        agentId: t.agentId,
        detectedProcessId: t.detectedProcessId,
        worktreeId: t.worktreeId,
        worktreeName: t.worktreeId ? worktreeMap.get(t.worktreeId)?.name : undefined,
        cwd: t.cwd ?? "",
      }));
  }, [terminals, worktreeMap]);

  const {
    isOpen,
    query,
    results,
    selectedIndex,
    open,
    close,
    toggle,
    setQuery,
    selectPrevious,
    selectNext,
  } = useSearchablePalette<SearchableTerminal>({
    items: searchableTerminals,
    fuseOptions: FUSE_OPTIONS,
    maxResults: MAX_RESULTS,
    debounceMs: DEBOUNCE_MS,
  });

  const selectTerminal = useCallback(
    (terminal: SearchableTerminal) => {
      setFocused(terminal.id);
      close();
    },
    [setFocused, close]
  );

  const confirmSelection = useCallback(() => {
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      selectTerminal(results[selectedIndex]);
    }
  }, [results, selectedIndex, selectTerminal]);

  return {
    isOpen,
    query,
    results,
    selectedIndex,
    open,
    close,
    toggle,
    setQuery,
    selectPrevious,
    selectNext,
    selectTerminal,
    confirmSelection,
  };
}
