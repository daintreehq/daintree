import { useCallback, useMemo } from "react";

import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { ActionDanger, ActionManifestEntry } from "@shared/types/actions";
import { usePaletteStore } from "@/store/paletteStore";
import { useActionMruStore } from "@/store/actionMruStore";
import { useActionPrefsStore } from "@/store/actionPrefsStore";
import { createActionRanker, extractAcronym, rankActionMatches } from "@/lib/actionPaletteSearch";
import { getActionCategoryLabel, orderActionCategories } from "@/config/actionCategoryOrder";
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

/**
 * A contiguous labelled run of `results`. Sections are presentation metadata
 * only — headers never enter `results`, so keyboard navigation stays a flat
 * walk over the rows and arrow keys skip the dividers for free.
 */
export interface ActionPaletteSection {
  /** Stable identity: `favorites`, `recently-used`, or `category:{raw}`. */
  readonly id: string;
  readonly label: string;
  /** Index into `results` of this section's first row. */
  readonly start: number;
  readonly count: number;
}

export interface UseActionPaletteReturn {
  isOpen: boolean;
  query: string;
  results: ActionPaletteItem[];
  totalResults: number;
  /** Always within `results`, or -1 when there are none. See the clamp below. */
  selectedIndex: number;
  isStale: boolean;
  /**
   * Section runs covering `results` on the empty-query browse rail. Empty
   * during a typed search, where ranking replaces grouping.
   */
  sections: readonly ActionPaletteSection[];
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
const MAX_MRU_RESULTS = 5;

const EMPTY_SECTIONS: readonly ActionPaletteSection[] = [];

/**
 * Section id of the frecency band. The palette only offers the "Hide from
 * Recently used" control on these rows — it's the one section the control acts
 * on, and offering it against a category row would promise an eviction that
 * surface can't perform.
 */
export const RECENTLY_USED_SECTION_ID = "recently-used";

/**
 * The search path stays capped — ranking past the twentieth match is noise, and
 * `PaletteOverflowNotice` reports the remainder. The empty-query rail is the
 * browsable inventory, so capping it would defeat the point; it caps itself at
 * the number of registered actions.
 *
 * Module-level: `useSearchablePalette` reads this inside its filter memo, and a
 * fresh closure per render would invalidate that memo every time.
 */
const resolveMaxResults = (query: string): number =>
  query.trim() ? MAX_RESULTS : Number.POSITIVE_INFINITY;

export function toActionPaletteItem(entry: ActionManifestEntry): ActionPaletteItem {
  const title =
    typeof entry.title === "string" && entry.title.trim().length > 0 ? entry.title : entry.id;
  const description = typeof entry.description === "string" ? entry.description : "";
  const rawCategory = typeof entry.category === "string" ? entry.category : "General";
  const category = rawCategory === "portal" ? "Web" : rawCategory;
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

  /**
   * The empty-query rail: Favorites, then a short recents band, then every
   * remaining action grouped by category. Recall on top, browsing below — a
   * palette opened to find out what the app can do has somewhere to go.
   *
   * Built as one memo so the flat row array and the section runs describing it
   * are always produced together and can never disagree about an offset.
   */
  const browseModel = useMemo(() => {
    const items: ActionPaletteItem[] = [];
    const sections: ActionPaletteSection[] = [];
    const pushSection = (id: string, label: string, rows: ActionPaletteItem[]) => {
      if (rows.length === 0) return;
      sections.push({ id, label, start: items.length, count: rows.length });
      items.push(...rows);
    };

    // Favorites: ordered by pin time (insertion order), strip danger:"confirm"
    // and skip ids the action registry no longer exposes.
    const pinnedItems: ActionPaletteItem[] = [];
    for (const id of pinnedActionIds) {
      if (confirmDangerIds.has(id)) continue;
      const item = itemById.get(id);
      if (item) pinnedItems.push(item);
    }
    pushSection("favorites", "Favorites", pinnedItems);

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
    pushSection(
      RECENTLY_USED_SECTION_ID,
      "Recently used",
      [...enabled, ...disabled].slice(0, MAX_MRU_RESULTS)
    );

    // Browse: everything not already on screen above. Excluding the promoted
    // rows keeps every action to exactly one row, which the rest of the palette
    // depends on — `key`, the `action-option-{id}` DOM id behind
    // aria-activedescendant, the `data-action-id` scroll lookup and the
    // selection-follow ref all assume an id identifies one row.
    //
    // Only ids actually rendered above are skipped, not every preference id: an
    // MRU entry past the recents cap, or one hidden from the recents rail, is
    // still part of the inventory and reappears in its category. Hiding demotes
    // an action out of frecency; it doesn't retire the action.
    const promotedIds = new Set(items.map((item) => item.id));
    const byCategory = new Map<string, ActionPaletteItem[]>();
    for (const item of allActions) {
      if (promotedIds.has(item.id)) continue;
      // danger:"confirm" stays off the empty-query rail, as it already is for
      // Favorites and Recently used (#7481). Search still surfaces these — a
      // user who types the name has named the destructive action; one who is
      // scrolling an inventory has not.
      if (item.danger === "confirm") continue;
      const bucket = byCategory.get(item.category);
      if (bucket) bucket.push(item);
      else byCategory.set(item.category, [item]);
    }
    for (const category of orderActionCategories(byCategory.keys())) {
      const rows = byCategory.get(category)!;
      // Sort by title so the inventory reads alphabetically within a group, and
      // break ties on id: registry insertion order shifts with plugin load
      // order, and a browse list that reorders between opens isn't browsable.
      rows.sort((a, b) => a.titleLower.localeCompare(b.titleLower) || a.id.localeCompare(b.id));
      pushSection(`category:${category}`, getActionCategoryLabel(category), rows);
    }

    return { items, sections: sections as readonly ActionPaletteSection[] };
  }, [
    pinnedActionIds,
    confirmDangerIds,
    itemById,
    actionMruList,
    pinnedSet,
    hiddenSet,
    allActions,
  ]);

  const filterFn = useCallback(
    (items: ActionPaletteItem[], query: string): ActionPaletteItem[] => {
      if (!query.trim()) return browseModel.items;

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
    [browseModel, allActions, rankActions, actionMruList]
  );

  const {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex: rawSelectedIndex,
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
    maxResults: resolveMaxResults,
    paletteId: "action",
  });

  // `results` is the browse inventory exactly when it is the array the browse
  // memo built — `useSearchablePalette` hands back the filter's own array
  // whenever nothing was sliced off. Identity, not a re-read of `query`, is
  // what keeps the two in step: filtering runs on the *deferred* query, so a
  // `query`-based test would label a still-rendering browse list as search
  // results the moment a key goes down, and vice versa on clearing.
  const sections = results === browseModel.items ? browseModel.sections : EMPTY_SECTIONS;

  // Results are computed during render but `selectedIndex` is reconciled a
  // frame later in an effect, so between the two the stored index can point
  // past the end of a list that just shrank. Typing turns ~300 browse rows into
  // a handful of matches, which makes that window trivial to hit; clamp on read
  // so the highlight, aria-activedescendant and Enter all agree on a row that
  // exists. Resetting from the query setter instead would clobber the
  // selection-follow ref and land on the wrong row.
  const selectedIndex =
    rawSelectedIndex >= 0 && rawSelectedIndex < results.length
      ? rawSelectedIndex
      : results.length > 0
        ? 0
        : -1;

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
    // `selectedIndex` is the clamped read above, so it already names a row that
    // exists whenever there is one.
    if (selectedIndex >= 0) {
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
      message: `You can still find '${item.title}' by searching or browsing its category.`,
      duration: 30_000,
      urgent: true,
      transient: true,
      action: {
        label: "Show in Recently used",
        onClick: () => useActionPrefsStore.getState().showAction(item.id),
      },
    });
  }, []);

  return {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex,
    isStale,
    sections,
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
