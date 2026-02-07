import { useCallback, useMemo, useRef } from "react";
import type { IFuseOptions } from "fuse.js";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { useWorktrees } from "./useWorktrees";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { isPtyPanel } from "@shared/types/domain";

export interface SearchableTerminal {
  id: string;
  title: string;
  type: TerminalInstance["type"];
  kind?: TerminalInstance["kind"];
  agentId?: TerminalInstance["agentId"];
  worktreeId?: string;
  worktreeName?: string;
  /** Working directory - always present since palette only shows PTY panels */
  cwd: string;
}

export type UseTerminalPaletteReturn = UseSearchablePaletteReturn<SearchableTerminal> & {
  selectTerminal: (terminal: SearchableTerminal) => void;
};

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
        worktreeId: t.worktreeId,
        worktreeName: t.worktreeId ? worktreeMap.get(t.worktreeId)?.name : undefined,
        cwd: t.cwd ?? "",
      }));
  }, [terminals, worktreeMap]);

  const closeFnRef = useRef<() => void>(() => {});

  const handleSelect = useCallback(
    (terminal: SearchableTerminal) => {
      setFocused(terminal.id);
      closeFnRef.current();
    },
    [setFocused]
  );

  const palette = useSearchablePalette<SearchableTerminal>({
    items: searchableTerminals,
    fuseOptions: FUSE_OPTIONS,
    maxResults: 10,
    onSelect: handleSelect,
  });

  closeFnRef.current = palette.close;

  return {
    ...palette,
    selectTerminal: handleSelect,
  };
}
