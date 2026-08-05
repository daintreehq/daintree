import { useCallback, useMemo } from "react";

import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { ActionDanger, ActionManifestEntry } from "@shared/types/actions";
import { usePaletteStore } from "@/store/paletteStore";
import { useActionMruStore } from "@/store/actionMruStore";
import { useActionPrefsStore } from "@/store/actionPrefsStore";
import { createActionRanker, extractAcronym, rankActionMatches } from "@/lib/actionPaletteSearch";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isPanelLimitError } from "@/services/actions/definitions/panelLimitError";
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
  /**
   * When set, picking this row dispatches this action id instead of `id` — the
   * row's headless action declared `palette: { mode: "redirect" }` and points
   * at an interactive sibling (e.g. a dialog-opener). See `PaletteBehavior`.
   */
  redirectTo?: string;
  keybinding?: string;
  kind: string;
  /**
   * Set for plugin-contributed actions. Their synthetic definition surfaces its
   * own failure toast in `usePluginActions`, so the palette suppresses its
   * generic `{ ok: false }` toast for these rows to avoid double-notifying.
   */
  pluginId?: string;
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

export function toActionPaletteItem(entry: ActionManifestEntry): ActionPaletteItem {
  const title =
    typeof entry.title === "string" && entry.title.trim().length > 0 ? entry.title : entry.id;
  const description = typeof entry.description === "string" ? entry.description : "";
  const category = typeof entry.category === "string" ? entry.category : "General";
  // A `requireContext` palette action surfaces as disabled-with-reason: fold
  // its palette-only flags into the row's enabled/disabledReason so the
  // existing disabled-row UX (grayed, inline reason, Enter no-ops) applies
  // without touching the manifest's dispatch-facing `enabled`.
  const enabled = entry.enabled && entry.paletteDisabled !== true;
  const disabledReason =
    typeof entry.paletteDisabledReason === "string"
      ? entry.paletteDisabledReason
      : typeof entry.disabledReason === "string"
        ? entry.disabledReason
        : undefined;
  const redirectTo =
    typeof entry.paletteRedirectTo === "string" ? entry.paletteRedirectTo : undefined;
  const dangerRationale =
    typeof entry.dangerRationale === "string" && entry.dangerRationale.trim().length > 0
      ? entry.dangerRationale.trim()
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
    enabled,
    danger: entry.danger,
    dangerRationale,
    disabledReason,
    redirectTo,
    keybinding: keybindingService.getDisplayCombo(entry.id),
    kind: entry.kind,
    pluginId: entry.pluginId,
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
  const actionUsageEntries = useActionMruStore((state) => state.actionUsageEntries);
  const pinnedActionIds = useActionPrefsStore((state) => state.pinnedActionIds);
  const hiddenActionIds = useActionPrefsStore((state) => state.hiddenActionIds);

  const allActions = useMemo<ActionPaletteItem[]>(() => {
    if (!isActionOpen) return [];
    // Palette rows never read the JSON schemas — skip their compilation and
    // cloning so first open doesn't pay the deferred ~300-action compile.
    const entries = actionService.list(undefined, { includeSchemas: false });
    return entries
      .filter((e) => {
        if (e.kind !== "command") return false;
        // Explicit palette opt-out (PaletteBehavior "hidden") wins regardless
        // of schema shape.
        if (e.paletteHidden) return false;
        // A redirect entry runs its interactive sibling, not itself, so its own
        // args are irrelevant — show it even when its schema would require args.
        if (e.paletteRedirectTo) return true;
        // Default: gate on the schema heuristic, as before.
        return !e.requiresArgs;
      })
      .map(toActionPaletteItem);
  }, [isActionOpen]);

  // Strip confirm-danger ids from the MRU/Favorites lists so destructive actions
  // persisted from a pre-fix session don't keep surfacing in the
  // "Recently used" rail or get a search-rank bonus (issue #7481).
  const confirmDangerIds = useMemo(
    () => new Set(allActions.filter((item) => item.danger === "confirm").map((item) => item.id)),
    [allActions]
  );
  const itemById = useMemo(() => new Map(allActions.map((item) => [item.id, item])), [allActions]);
  const hiddenSet = useMemo(() => new Set(hiddenActionIds), [hiddenActionIds]);
  const pinnedSet = useMemo(() => new Set(pinnedActionIds), [pinnedActionIds]);
  const rankActions = useMemo(() => createActionRanker(allActions), [allActions]);
  const actionMruList = useMemo(() => {
    if (actionUsageEntries.size === 0) return [];
    return getSortedActionMruList().filter(({ id }) => !confirmDangerIds.has(id));
  }, [getSortedActionMruList, actionUsageEntries, confirmDangerIds]);

  const filterFn = useCallback(
    (items: ActionPaletteItem[], query: string): ActionPaletteItem[] => {
      if (!query.trim()) {
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
        for (const { id } of actionMruList) {
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
      const rankContext = {
        focusedTerminalKind: context.focusedTerminalKind,
        focusedWorktreeId: context.focusedWorktreeId,
        isSettingsOpen: context.isSettingsOpen,
      };
      return items === allActions
        ? rankActions(query, actionMruList, rankContext)
        : rankActionMatches(query, items, actionMruList, rankContext);
    },
    [
      pinnedActionIds,
      confirmDangerIds,
      itemById,
      hiddenSet,
      pinnedSet,
      allActions,
      rankActions,
      actionMruList,
    ]
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
      // A redirect row runs its interactive sibling (e.g. a dialog-opener)
      // instead of the headless action the user searched for. MRU above still
      // records the picked id so the familiar entry reappears.
      const dispatchId = item.redirectTo ?? item.id;
      // Read off `dispatchId`, not `item.id` — a redirect row's failure comes
      // from the sibling that actually ran, so that's the definition whose
      // toast ownership matters.
      const selfNotifies = actionService.selfNotifiesOnExecutionError(
        dispatchId as Parameters<typeof actionService.selfNotifiesOnExecutionError>[0]
      );
      void actionService
        .dispatch(
          dispatchId as Parameters<typeof actionService.dispatch>[0],
          {},
          {
            source: "user",
          }
        )
        .then((result) => {
          if (result.ok) return;
          // DISABLED is already visible on the originating surface (#8814).
          if (result.error.code === "DISABLED") return;
          // Two kinds of action own their failure toast, and only for a failure
          // thrown out of run() (EXECUTION_ERROR): a plugin action, whose
          // synthetic run() self-notifies in usePluginActions, and a built-in
          // that opted in via `selfNotifiesOnExecutionError`. Suppress the
          // generic palette toast for exactly those so the specific message
          // isn't stacked under a vaguer duplicate. Everything else — a failure
          // raised before run() (e.g. NOT_FOUND when the action was
          // unregistered while the palette was open), or a built-in that never
          // self-notifies — still needs the palette to toast.
          if (
            result.error.code === "EXECUTION_ERROR" &&
            (item.pluginId !== undefined || selfNotifies)
          ) {
            return;
          }
          // A refusal for a full grid is reported by `addPanel` itself, with the
          // count and the actual recovery, before the action throws — so it is
          // already on screen for every panel-opening action rather than one
          // that opted in. Restating it as "Couldn't run X" adds a vaguer
          // duplicate of a message the user is looking at (#11666).
          if (isPanelLimitError(result.error.message)) return;
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
          notify({
            type: "error",
            title: `Couldn't run '${item.title}'`,
            message: formatErrorMessage(result.error, "Action failed."),
          });
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
    let count = 0;
    for (const item of results) {
      if (pinnedSet.has(item.id)) count++;
      else break;
    }
    return count;
  }, [query, results, pinnedSet]);

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
