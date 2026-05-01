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
  isShowingRecentlyUsed: boolean;
  isStale: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  setSelectedIndex: (index: number) => void;
  selectPrevious: () => void;
  selectNext: () => void;
  executeAction: (item: ActionPaletteItem) => void;
  confirmSelection: () => void;
}

const MAX_RESULTS = 20;
const MAX_MRU_RESULTS = 10;

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
        if (actionMruList.length === 0) return [];

        const itemById = new Map(items.map((item) => [item.id, item]));
        const enabled: ActionPaletteItem[] = [];
        const disabled: ActionPaletteItem[] = [];
        for (const id of actionMruList) {
          const item = itemById.get(id);
          if (!item) continue;
          if (item.enabled) enabled.push(item);
          else disabled.push(item);
        }
        return [...enabled, ...disabled].slice(0, MAX_MRU_RESULTS);
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
    isStale,
    open,
    close,
    toggle,
    setQuery,
    setSelectedIndex,
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
              title: `Couldn't run '${item.title}'`,
              message: formatErrorMessage(result.error, "Action failed."),
            });
          }
        })
        .catch(() => {
          notify({
            type: "error",
            title: `Couldn't run '${item.title}'`,
            message: "An unexpected error occurred.",
          });
        });
    },
    [close]
  );

  const confirmSelection = useCallback(() => {
    // While the deferred filter is catching up, `results` reflects the previous
    // query — firing on Enter would dispatch an action that doesn't match the
    // text in the input. Wait for the next render; the user's repeat Enter
    // (typically <32ms later) will land on the up-to-date selection.
    if (isStale) return;
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      executeAction(results[selectedIndex]!);
    }
  }, [isStale, results, selectedIndex, executeAction]);

  const isShowingRecentlyUsed = query.trim() === "" && results.length > 0;

  return {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex,
    isShowingRecentlyUsed,
    isStale,
    open,
    close,
    toggle,
    setQuery,
    setSelectedIndex,
    selectPrevious,
    selectNext,
    executeAction,
    confirmSelection,
  };
}
