import { useCallback, useMemo } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { useShallow } from "zustand/react/shallow";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { ActionContext, ActionManifestEntry } from "@shared/types/actions";
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
  keywords: string[];
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
    { name: "keywords", weight: 1.5 },
    { name: "description", weight: 1 },
  ],
  threshold: 0.4,
  includeScore: true,
};

const MAX_RESULTS = 20;
const FUSE_SCORE_EPSILON = 0.001;
const CONTEXT_BOOST_FACTOR = 0.08;

function getBoostedCategories(ctx: ActionContext): Set<string> {
  const boosted = new Set<string>();

  switch (ctx.focusedTerminalKind) {
    case "terminal":
      boosted.add("terminal");
      boosted.add("panel");
      break;
    case "agent":
      boosted.add("terminal");
      boosted.add("agent");
      boosted.add("panel");
      break;
    case "browser":
      boosted.add("browser");
      boosted.add("panel");
      break;
    case "notes":
      boosted.add("notes");
      boosted.add("panel");
      break;
    case "dev-preview":
      boosted.add("devServer");
      boosted.add("panel");
      break;
  }

  if (typeof ctx.focusedWorktreeId === "string" && ctx.focusedWorktreeId.trim().length > 0) {
    boosted.add("worktree");
    boosted.add("git");
    boosted.add("github");
  }

  if (ctx.isSettingsOpen === true) {
    boosted.add("settings");
    boosted.add("preferences");
  }

  return boosted;
}

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
    keywords: entry.keywords ?? [],
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

  const fuse = useMemo(() => new Fuse(allActions, FUSE_OPTIONS), [allActions]);

  const filterFn = useCallback(
    (items: ActionPaletteItem[], query: string): ActionPaletteItem[] => {
      const frecencyEntries = getSortedActionMruList();
      const frecencyScoreMap = new Map<string, number>();
      frecencyEntries.forEach(({ id, score }) => frecencyScoreMap.set(id, score));

      if (!query.trim()) {
        return [...items].sort((a, b) => {
          if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
          const aScore = frecencyScoreMap.get(a.id) ?? 0;
          const bScore = frecencyScoreMap.get(b.id) ?? 0;
          if (aScore !== bScore) return bScore - aScore;
          return a.title.localeCompare(b.title);
        });
      }

      const boostedCategories = getBoostedCategories(actionService.getContext());

      const fuseResults = fuse.search(query);
      return fuseResults
        .map((r) => {
          const frecencyScore = frecencyScoreMap.get(r.item.id) ?? 0;
          const contextBoost = boostedCategories.has(r.item.category) ? CONTEXT_BOOST_FACTOR : 0;
          return { item: r.item, fuseScore: (r.score ?? 1) - contextBoost, frecencyScore };
        })
        .sort((a, b) => {
          if (a.item.enabled !== b.item.enabled) return a.item.enabled ? -1 : 1;
          const scoreDiff = a.fuseScore - b.fuseScore;
          if (Math.abs(scoreDiff) > FUSE_SCORE_EPSILON) return scoreDiff;
          if (a.frecencyScore !== b.frecencyScore) return b.frecencyScore - a.frecencyScore;
          return a.item.title.localeCompare(b.item.title);
        })
        .map((r) => r.item);
    },
    [fuse, getSortedActionMruList]
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
