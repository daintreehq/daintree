import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import type { ActionManifestEntry } from "@shared/types/actions";

export interface ActionPaletteItem {
  id: string;
  title: string;
  description: string;
  category: string;
  enabled: boolean;
  disabledReason?: string;
  keybinding?: string;
  kind: string;
}

export interface UseActionPaletteReturn {
  isOpen: boolean;
  query: string;
  results: ActionPaletteItem[];
  selectedIndex: number;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  selectPrevious: () => void;
  selectNext: () => void;
  executeAction: (item: ActionPaletteItem) => void;
  confirmSelection: () => void;
}

const FUSE_OPTIONS: IFuseOptions<ActionPaletteItem> = {
  keys: [
    { name: "title", weight: 2 },
    { name: "category", weight: 1.5 },
    { name: "description", weight: 1 },
  ],
  threshold: 0.4,
  includeScore: true,
};

const MAX_RESULTS = 20;
const DEBOUNCE_MS = 200;

function toActionPaletteItem(entry: ActionManifestEntry): ActionPaletteItem {
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    category: entry.category,
    enabled: entry.enabled,
    disabledReason: entry.disabledReason,
    keybinding: keybindingService.getDisplayCombo(entry.id),
    kind: entry.kind,
  };
}

export function useActionPalette(): UseActionPaletteReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState("");

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

  const allActions = useMemo<ActionPaletteItem[]>(() => {
    if (!isOpen) return [];
    const entries = actionService.list();
    return entries
      .filter((e) => e.kind === "command")
      .map(toActionPaletteItem)
      .sort((a, b) => {
        // Enabled actions first
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.title.localeCompare(b.title);
      });
  }, [isOpen]);

  const fuse = useMemo(() => {
    return new Fuse(allActions, FUSE_OPTIONS);
  }, [allActions]);

  const results = useMemo<ActionPaletteItem[]>(() => {
    if (!debouncedQuery.trim()) {
      return allActions.slice(0, MAX_RESULTS);
    }

    const fuseResults = fuse.search(debouncedQuery);
    return fuseResults.slice(0, MAX_RESULTS).map((r) => r.item);
  }, [debouncedQuery, allActions, fuse]);

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

  const executeAction = useCallback(
    (item: ActionPaletteItem) => {
      if (!item.enabled) return;
      close();
      void actionService.dispatch(
        item.id as Parameters<typeof actionService.dispatch>[0],
        undefined,
        { source: "user" }
      );
    },
    [close]
  );

  const confirmSelection = useCallback(() => {
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      executeAction(results[selectedIndex]);
    }
  }, [results, selectedIndex, executeAction]);

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
    executeAction,
    confirmSelection,
  };
}
