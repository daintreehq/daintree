import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { ActionManifestEntry } from "@shared/types/actions";
import { usePaletteStore } from "@/store/paletteStore";
import { useActionMruStore } from "@/store/actionMruStore";
import { extractAcronym, rankActionMatches } from "@/lib/actionPaletteSearch";
import { formatErrorMessage } from "@shared/utils/errorMessage";
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
  titleLower: string;
  categoryLower: string;
  descriptionLower: string;
  titleAcronym: string;
  keywordsLower: readonly string[];
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
  const keywordsLower: readonly string[] = Array.isArray(entry.keywords)
    ? entry.keywords
        .filter((k): k is string => typeof k === "string" && k.length > 0)
        .map((k) => k.toLowerCase())
    : [];

  return {
    id: entry.id,
    title,
    description,
    category,
    enabled: entry.enabled,
    disabledReason,
    keybinding: keybindingService.getDisplayCombo(entry.id),
    kind: entry.kind,
    titleLower: title.toLowerCase(),
    categoryLower: category.toLowerCase(),
    descriptionLower: description.toLowerCase(),
    titleAcronym: extractAcronym(title),
    keywordsLower,
  };
}

export function useActionPalette(): UseActionPaletteReturn {
  const isActionOpen = usePaletteStore((state) => state.activePaletteId === "action");
  const getSortedActionMruList = useActionMruStore(
    useShallow((state) => state.getSortedActionMruList)
  );

  const allActions = useMemo<ActionPaletteItem[]>(() => {
    if (!isActionOpen) return [];
    const entries = actionService.list();
    return entries.filter((e) => e.kind === "command" && !e.requiresArgs).map(toActionPaletteItem);
  }, [isActionOpen]);

  const filterFn = useCallback(
    (items: ActionPaletteItem[], query: string): ActionPaletteItem[] => {
      const actionMruList = getSortedActionMruList().map(({ id }) => id);

      if (!query.trim()) {
        const mruIndexMap = new Map<string, number>();
        actionMruList.forEach((id, index) => mruIndexMap.set(id, index));
        return [...items].sort((a, b) => {
          if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
          const aIndex = mruIndexMap.get(a.id) ?? Infinity;
          const bIndex = mruIndexMap.get(b.id) ?? Infinity;
          if (aIndex !== bIndex) return aIndex - bIndex;
          return a.title.localeCompare(b.title, "en", { sensitivity: "base" });
        });
      }

      const context = actionService.getContext();
      return rankActionMatches(query, items, actionMruList, {
        focusedTerminalKind: context.focusedTerminalKind,
        focusedWorktreeId: context.focusedWorktreeId,
        isSettingsOpen: context.isSettingsOpen,
      });
    },
    [getSortedActionMruList]
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
      // Only record frecency for enabled items so disabled actions don't get
      // promoted to the top from repeated attempts. Dispatch still runs for
      // disabled items so ActionService can surface the disabled-reason toast.
      if (item.enabled) {
        useActionMruStore.getState().recordActionMru(item.id);
      }
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
          if (!result.ok && result.error.code !== "DISABLED") {
            notify({
              type: "error",
              title: "Action failed",
              message: formatErrorMessage(result.error, "Action failed."),
            });
          }
        })
        .catch(() => {
          notify({
            type: "error",
            title: "Action failed",
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
