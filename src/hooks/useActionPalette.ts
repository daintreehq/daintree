import { useCallback, useMemo } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { useShallow } from "zustand/react/shallow";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { ActionManifestEntry } from "@shared/types/actions";
import { usePaletteStore } from "@/store/paletteStore";
import { useActionMruStore } from "@/store/actionMruStore";
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
const MRU_BOOST_FACTOR = 0.05;

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

  const fuse = useMemo(() => new Fuse(allActions, FUSE_OPTIONS), [allActions]);

  const filterFn = useCallback(
    (items: ActionPaletteItem[], query: string): ActionPaletteItem[] => {
      const mruIndexMap = new Map<string, number>();
      actionMruList.forEach((id, index) => mruIndexMap.set(id, index));
      const mruSize = actionMruList.length;

      if (!query.trim()) {
        return [...items].sort((a, b) => {
          if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
          const aIndex = mruIndexMap.get(a.id) ?? Infinity;
          const bIndex = mruIndexMap.get(b.id) ?? Infinity;
          if (aIndex !== bIndex) return aIndex - bIndex;
          return a.title.localeCompare(b.title);
        });
      }

      const fuseResults = fuse.search(query);
      return fuseResults
        .map((r) => {
          const rank = mruIndexMap.get(r.item.id);
          const boost =
            rank !== undefined ? (1 - rank / Math.max(mruSize, 1)) * MRU_BOOST_FACTOR : 0;
          return { item: r.item, boostedScore: (r.score ?? 1) - boost };
        })
        .sort((a, b) => {
          if (a.item.enabled !== b.item.enabled) return a.item.enabled ? -1 : 1;
          return a.boostedScore - b.boostedScore;
        })
        .map((r) => r.item);
    },
    [fuse, actionMruList]
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
      executeAction(results[selectedIndex]);
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
