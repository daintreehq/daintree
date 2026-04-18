import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { ActionManifestEntry } from "@shared/types/actions";
import { usePaletteStore } from "@/store/paletteStore";
import { useActionMruStore } from "@/store/actionMruStore";
import { useSearchablePalette } from "./useSearchablePalette";
import { rankActionMatches } from "@/lib/actionPaletteSearch";

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
  totalResults: number;
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

const MAX_RESULTS = 20;

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
  const isActionOpen = usePaletteStore((state) => state.activePaletteId === "action");
  const actionMruList = useActionMruStore(useShallow((state) => state.actionMruList));

  const allActions = useMemo<ActionPaletteItem[]>(() => {
    if (!isActionOpen) return [];
    const entries = actionService.list();
    return entries.filter((e) => e.kind === "command" && !e.requiresArgs).map(toActionPaletteItem);
  }, [isActionOpen]);

  const actionIdString = useMemo(
    () =>
      allActions
        .map((a) => a.id)
        .sort()
        .join(","),
    [allActions]
  );

  const filterFn = useCallback(
    (items: ActionPaletteItem[], query: string): ActionPaletteItem[] => {
      const mruIndexMap = new Map<string, number>();
      actionMruList.forEach((id, index) => mruIndexMap.set(id, index));

      if (!query.trim()) {
        return [...items].sort((a, b) => {
          if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
          const aIndex = mruIndexMap.get(a.id) ?? Infinity;
          const bIndex = mruIndexMap.get(b.id) ?? Infinity;
          if (aIndex !== bIndex) return aIndex - bIndex;
          return a.title.localeCompare(b.title);
        });
      }

      const scored = rankActionMatches(query, items, mruIndexMap);
      return scored.slice(0, MAX_RESULTS).map((s) => s.item);
    },
    [actionMruList, actionIdString]
  );

  const {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex,
    open,
    close,
    toggle,
    setQuery,
    selectPrevious,
    selectNext,
  } = useSearchablePalette<ActionPaletteItem>({
    items: allActions,
    filterFn,
    maxResults: MAX_RESULTS,
    paletteId: "action",
  });

  const executeAction = useCallback(
    (item: ActionPaletteItem) => {
      if (!item.enabled) return;
      useActionMruStore.getState().recordActionMru(item.id);
      close();
      void actionService
        .dispatch(
          item.id as Parameters<typeof actionService.dispatch>[0],
          {},
          {
            source: "user",
          }
        )
        .then((result) => {
          if (!result.ok) {
            notify({
              type: "error",
              title: "Action Failed",
              message: result.error.message,
            });
          }
        })
        .catch(() => {
          notify({
            type: "error",
            title: "Action Failed",
            message: "An unexpected error occurred.",
          });
        });
    },
    [close]
  );

  const confirmSelection = useCallback(() => {
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      executeAction(results[selectedIndex]!);
    }
  }, [results, selectedIndex, executeAction]);

  return {
    isOpen,
    query,
    results,
    totalResults,
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
