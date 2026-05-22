import { useCallback, useMemo } from "react";

import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { ActionDanger, ActionManifestEntry } from "@shared/types/actions";
import { usePaletteStore } from "@/store/paletteStore";
import { useActionMruStore } from "@/store/actionMruStore";
import { useActionPrefsStore } from "@/store/actionPrefsStore";
import { extractAcronym, rankActionMatches } from "@/lib/actionPaletteSearch";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useSearchablePalette } from "./useSearchablePalette";

export interface ActionPaletteItem {
  id: string;
  title: string;
  description: string;
  category: string;
  enabled: boolean;
  danger: ActionDanger;
  dangerRationale?: string;
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
  /** Count of pinned items at the start of `results`. The remainder is "Recently used". */
  pinnedCount: number;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  setSelectedIndex: (index: number) => void;
  selectPrevious: () => void;
  selectNext: () => void;
  executeAction: (item: ActionPaletteItem) => void;
  confirmSelection: () => void;
  /** Pin an action to Favorites. Returns false (and surfaces a toast) when the action is `danger:"confirm"`. */
  pinAction: (item: ActionPaletteItem) => boolean;
  unpinAction: (id: string) => void;
  /** Hide an action from Recently used. Fires a 30-second undo toast. No-op for pinned actions. */
  hideAction: (item: ActionPaletteItem) => void;
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
  const dangerRationale =
    typeof entry.dangerRationale === "string" && entry.dangerRationale.trim().length > 0
      ? entry.dangerRationale
      : undefined;
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
    danger: entry.danger,
    dangerRationale,
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
  const getSortedActionMruList = useActionMruStore((state) => state.getSortedActionMruList);
  const pinnedActionIds = useActionPrefsStore((state) => state.pinnedActionIds);
  const hiddenActionIds = useActionPrefsStore((state) => state.hiddenActionIds);

  const allActions = useMemo<ActionPaletteItem[]>(() => {
    if (!isActionOpen) return [];
    const entries = actionService.list();
    return entries.filter((e) => e.kind === "command" && !e.requiresArgs).map(toActionPaletteItem);
  }, [isActionOpen]);

  const filterFn = useCallback(
    (items: ActionPaletteItem[], query: string): ActionPaletteItem[] => {
      // Strip confirm-danger ids from the MRU/Favorites lists so destructive actions
      // persisted from a pre-fix session don't keep surfacing in the
      // "Recently used" rail or get a search-rank bonus (issue #7481).
      const confirmDangerIds = new Set(
        items.filter((item) => item.danger === "confirm").map((item) => item.id)
      );
      const hiddenSet = new Set(hiddenActionIds);
      const pinnedSet = new Set(pinnedActionIds);
      const actionMruList = getSortedActionMruList()
        .map(({ id }) => id)
        .filter((id) => !confirmDangerIds.has(id));

      if (!query.trim()) {
        const itemById = new Map(items.map((item) => [item.id, item]));

        // Favorites: ordered by pin time (insertion order), strip danger:"confirm"
        // and skip ids the action registry no longer exposes.
        const pinnedItems: ActionPaletteItem[] = [];
        for (const id of pinnedActionIds) {
          if (confirmDangerIds.has(id)) continue;
          const item = itemById.get(id);
          if (item) pinnedItems.push(item);
        }

        // Recently used: filter out pinned ids (so they don't appear in both
        // sections) and hidden ids (eviction).
        const enabled: ActionPaletteItem[] = [];
        const disabled: ActionPaletteItem[] = [];
        for (const id of actionMruList) {
          if (pinnedSet.has(id) || hiddenSet.has(id)) continue;
          const item = itemById.get(id);
          if (!item) continue;
          if (item.enabled) enabled.push(item);
          else disabled.push(item);
        }
        const recentItems = [...enabled, ...disabled].slice(0, MAX_MRU_RESULTS);
        return [...pinnedItems, ...recentItems];
      }

      const context = actionService.getContext();
      return rankActionMatches(query, items, actionMruList, {
        focusedTerminalKind: context.focusedTerminalKind,
        focusedWorktreeId: context.focusedWorktreeId,
        isSettingsOpen: context.isSettingsOpen,
      });
    },
    [getSortedActionMruList, pinnedActionIds, hiddenActionIds]
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
      // Enter on a disabled row is a silent no-op: palette stays open, no
      // dispatch, no toast. The inline disabled-reason text in the row already
      // explains why it's unavailable (issue #8814).
      if (!item.enabled) return;
      // Skip confirm-danger actions (e.g. "Delete worktree") from frecency so
      // destructive actions don't land in the "Recently used" rail (#7481).
      if (item.danger !== "confirm") {
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
            // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
            notify({
              type: "error",
              title: `Couldn't run '${item.title}'`,
              message: formatErrorMessage(result.error, "Action failed."),
            });
          }
        })
        .catch(() => {
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
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

  const pinAction = useCallback((item: ActionPaletteItem): boolean => {
    if (item.danger === "confirm") {
      // Mirrors the MRU strip in `filterFn` — destructive actions must
      // round-trip through ConfirmDialog and never appear in the Favorites
      // rail (issue #7481). The pin button surfaces an inline tooltip so the
      // user understands why the click was rejected; we still emit a
      // diagnostic-tier console warn for audit logs.
      console.warn(
        `[useActionPalette] Refusing to pin destructive action '${item.id}' — danger:"confirm" actions cannot be pinned.`
      );
      return false;
    }
    useActionPrefsStore.getState().pinAction(item.id);
    return true;
  }, []);

  const unpinAction = useCallback((id: string) => {
    useActionPrefsStore.getState().unpinAction(id);
  }, []);

  const hideAction = useCallback((item: ActionPaletteItem) => {
    const store = useActionPrefsStore.getState();
    if (store.isActionPinned(item.id)) {
      // Pinned actions can't be hidden — they're explicitly promoted to
      // Favorites. Unpin first if the user wants to evict them.
      return;
    }
    store.hideAction(item.id);
    notify({
      type: "success",
      title: "Hidden from Recently used",
      message: `'${item.title}' won't appear in the empty-query rail.`,
      duration: 30_000,
      urgent: true,
      transient: true,
      action: {
        label: "Show in Recently used",
        onClick: () => useActionPrefsStore.getState().showAction(item.id),
      },
    });
  }, []);

  // When the query is non-empty, results come from `rankActionMatches` (search
  // scoring) and the section split doesn't apply. The empty-query branch is the
  // only path where the first N items are pinned — count them up so consumers
  // can render the "Favorites" / "Recently used" divider at the right offset.
  const pinnedCount = useMemo(() => {
    if (query.trim()) return 0;
    const pinnedSet = new Set(pinnedActionIds);
    let count = 0;
    for (const item of results) {
      if (pinnedSet.has(item.id)) count++;
      else break;
    }
    return count;
  }, [query, results, pinnedActionIds]);

  const isShowingRecentlyUsed = query.trim() === "" && results.length > 0;

  return {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex,
    isShowingRecentlyUsed,
    isStale,
    pinnedCount,
    open,
    close,
    toggle,
    setQuery,
    setSelectedIndex,
    selectPrevious,
    selectNext,
    executeAction,
    confirmSelection,
    pinAction,
    unpinAction,
    hideAction,
  };
}
