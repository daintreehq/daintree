import { useState, useCallback, useMemo } from "react";
import type { IFuseOptions } from "fuse.js";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import type { ActionManifestEntry } from "@shared/types/actions";
import { useSearchablePalette } from "./useSearchablePalette";

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
  const title =
    typeof entry.title === "string" && entry.title.trim().length > 0 ? entry.title : entry.id;
  const description = typeof entry.description === "string" ? entry.description : "";
  const category = typeof entry.category === "string" ? entry.category : "General";
  const disabledReason =
    typeof entry.disabledReason === "string" ? entry.disabledReason : undefined;

  return {
    id: entry.id,
    title,
    description,
    category,
    enabled: entry.enabled,
    disabledReason,
    keybinding: keybindingService.getDisplayCombo(entry.id),
    kind: entry.kind,
  };
}

export function useActionPalette(): UseActionPaletteReturn {
  const [isOpen, setIsOpen] = useState(false);

  const allActions = useMemo<ActionPaletteItem[]>(() => {
    if (!isOpen) return [];
    const entries = actionService.list();
    return entries
      .filter((e) => e.kind === "command")
      .map(toActionPaletteItem)
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.title.localeCompare(b.title);
      });
  }, [isOpen]);

  const {
    isOpen: paletteIsOpen,
    query,
    results,
    selectedIndex,
    open: paletteOpen,
    close: paletteClose,
    setQuery,
    selectPrevious,
    selectNext,
  } = useSearchablePalette<ActionPaletteItem>({
    items: allActions,
    fuseOptions: FUSE_OPTIONS,
    maxResults: MAX_RESULTS,
    debounceMs: DEBOUNCE_MS,
  });

  const open = useCallback(() => {
    setIsOpen(true);
    paletteOpen();
  }, [paletteOpen]);

  const close = useCallback(() => {
    setIsOpen(false);
    paletteClose();
  }, [paletteClose]);

  const toggle = useCallback(() => {
    if (paletteIsOpen) {
      close();
    } else {
      open();
    }
  }, [paletteIsOpen, open, close]);

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
    isOpen: paletteIsOpen,
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
