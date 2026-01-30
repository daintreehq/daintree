import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { useWorktrees } from "./useWorktrees";
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
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const terminals = useTerminalStore(useShallow((state) => state.terminals));
  const setFocused = useTerminalStore((state) => state.setFocused);

  const { worktreeMap } = useWorktrees();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  const searchableTerminals = useMemo<SearchableTerminal[]>(() => {
    return terminals
      .filter((t) => t.location !== "trash")
      .filter((t) => t.hasPty !== false) // Exclude orphaned terminals without active PTY processes
      .filter((t) => isPtyPanel(t)) // Only include PTY panels (terminals, agents, dev-preview)
      .map((t) => ({
        id: t.id,
        title: t.title,
        type: t.type,
        kind: t.kind,
        agentId: t.agentId,
        worktreeId: t.worktreeId,
        worktreeName: t.worktreeId ? worktreeMap.get(t.worktreeId)?.name : undefined,
        cwd: t.cwd ?? "", // PTY panels should always have cwd, fallback to empty string
      }));
  }, [terminals, worktreeMap]);

  const fuse = useMemo(() => {
    return new Fuse(searchableTerminals, FUSE_OPTIONS);
  }, [searchableTerminals]);

  const results = useMemo<SearchableTerminal[]>(() => {
    if (!debouncedQuery.trim()) {
      return searchableTerminals.slice(0, MAX_RESULTS);
    }

    const fuseResults = fuse.search(debouncedQuery);
    return fuseResults.slice(0, MAX_RESULTS).map((r) => r.item);
  }, [debouncedQuery, searchableTerminals, fuse]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  const open = useCallback(() => {
    setIsOpen(true);
    setQuery("");
    setSelectedIndex(0);
    setDebouncedQuery("");
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setSelectedIndex(0);
    setDebouncedQuery("");
  }, []);

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
    } else {
      open();
    }
  }, [isOpen, open, close]);

  const selectPrevious = useCallback(() => {
    setSelectedIndex((prev) => (prev <= 0 ? results.length - 1 : prev - 1));
  }, [results.length]);

  const selectNext = useCallback(() => {
    setSelectedIndex((prev) => (prev >= results.length - 1 ? 0 : prev + 1));
  }, [results.length]);

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
