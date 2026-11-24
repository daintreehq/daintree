import { Fragment, useEffect, useMemo, useRef, useCallback } from "react";
import { isPointerClaimed } from "@/lib/pointerClaim";
import { useProgressiveRenderLimit } from "@/hooks/useProgressiveRenderLimit";
import {
  AppPaletteDialog,
  KBD_CLASS,
  PaletteFooterHints,
  PaletteNoMatchHint,
  toHintPhrase,
  type PaletteCloseReason,
  type PaletteSurfaceTier,
} from "@/components/ui/AppPaletteDialog";
import { PaletteOverflowNotice } from "@/components/ui/PaletteOverflowNotice";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { pluralize } from "@/lib/pluralize";
import { isMac } from "@/lib/platform";
import { keyBelongsToField, pageListboxCursor } from "@/hooks/useListboxCursor";

const noopHoverIndex = () => {};

// The action palette's band head, so a later band opens with air above it.
const SECTION_HEADER_CLASS = `${PALETTE_SECTION_LABEL_CLASS} px-3 py-1 not-first:mt-2`;

function sectionRuns<T>(
  items: readonly T[],
  getLabel: (item: T) => string
): { label: string; start: number; items: T[] }[] {
  const runs: { label: string; start: number; items: T[] }[] = [];
  items.forEach((item, index) => {
    const label = getLabel(item);
    const last = runs[runs.length - 1];
    if (last && last.label === label) last.items.push(item);
    else runs.push({ label, start: index, items: [item] });
  });
  return runs;
}

export interface SearchablePaletteProps<T> {
  isOpen: boolean;
  query: string;
  results: T[];
  selectedIndex: number;
  onQueryChange: (query: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  /**
   * Enter on the selected row. `newWindow` is the platform's primary modifier
   * (⌘ on macOS, Ctrl elsewhere), for palettes whose rows can open elsewhere.
   */
  onConfirm: (newWindow: boolean) => void;
  /**
   * Escape with nothing left to clear, or a scrim click. The reason lets a
   * multi-step palette take Escape back a step while a scrim click still closes.
   */
  onClose: (reason?: PaletteCloseReason) => void;

  /** Unique key for each item */
  getItemId: (item: T) => string;
  /**
   * Render a list item. The optional 4th argument is a stable hover callback —
   * forward it to the item's `onPointerMove` so mouse hover keeps `selectedIndex`
   * in sync with the visually highlighted row. Use `onPointerMove` (not
   * `onMouseEnter`) so keyboard scrolling doesn't trigger spurious selection
   * changes when items move under a stationary cursor. The optional 5th
   * argument is the Fuse match ranges for this item — pair with
   * `HighlightedText` from `@/components/ui/HighlightedText` to render
   * per-character match emphasis on string fields.
   */
  renderItem: (
    item: T,
    index: number,
    isSelected: boolean,
    onHoverIndex: (index: number) => void,
    matches: readonly FuseResultMatch[] | undefined
  ) => React.ReactNode;
  /** Called when the pointer hovers a row, for keeping selectedIndex in sync. */
  onHoverIndex?: (index: number) => void;
  /**
   * Moves the cursor to an index. Home/End and PageUp/PageDown need it; without
   * it (or `onHoverIndex` as a fallback) they are left to the input rather than
   * swallowed. The target can be any row, not just an end, so a consumer that
   * skips unselectable rows should look from the target back toward the
   * current row, which never wraps.
   */
  onSelectIndex?: (index: number) => void;
  /**
   * Heads each run of consecutive rows that share a label with the palette
   * section label, as an inert option. Results must already be ordered by
   * band; a label change starts a new band. An empty label draws no head.
   */
  getSectionLabel?: (item: T) => string;
  /**
   * Optional Fuse match ranges keyed by item ID. When provided, each item's
   * matches are forwarded to `renderItem` as the 5th argument. Produced by
   * `useSearchablePalette({ includeMatches: true })`.
   */
  matchesById?: ReadonlyMap<string, readonly FuseResultMatch[]>;

  /** Label shown above the search input */
  label: string;
  /** Canonical shortcut rendered via KbdChord pills. */
  shortcut?: string;
  /** ARIA label for the dialog */
  ariaLabel: string;
  /**
   * Which tier of surface this is — see `PaletteSurfaceTier`. Required and
   * never inferred, so a new picker's author has to decide whether it is a
   * scoped menu or a global command surface rather than inheriting one.
   */
  tier: PaletteSurfaceTier;
  /** The stacking layer, forwarded to `AppPaletteDialog`. */
  zIndex?: "modal" | "nested";
  /** Placeholder text for search input */
  searchPlaceholder?: string;
  /** ARIA label for the search input */
  searchAriaLabel?: string;
  /**
   * Id of an element that describes the search input — for a palette control
   * the user reaches by a chord from the field.
   */
  searchAriaDescribedBy?: string;
  /**
   * Escape empties a non-empty field before it closes, wherever focus is in the
   * palette. Off for a step whose field holds an answer rather than a search
   * (an argument prompt, a branch name), where Escape goes back a step through
   * `onClose("escape")` with the text still in it.
   */
  clearQueryOnEscape?: boolean;
  /** ID for the listbox container */
  listId?: string;
  /** Prefix for item IDs used in aria-activedescendant */
  itemIdPrefix?: string;

  /**
   * The list allows more than one option to be chosen. Semantic only: sets
   * `aria-multiselectable` on the listbox, which the options' own checked state
   * does not replace. The row treatment stays the caller's.
   */
  multiselectable?: boolean;

  /** Message when no items exist */
  emptyMessage?: string;
  /**
   * Message when search yields no results. When omitted the shell renders
   * `No matches for "{query}"` (truncated at 40 chars).
   */
  noMatchMessage?: string;
  /** Content shown below the empty message (no-data state only, hidden during search) */
  emptyContent?: React.ReactNode;
  /** Content shown in the no-match state when a query produces zero results */
  noMatchContent?: React.ReactNode;
  /**
   * Pre-formatted display string for the create-the-missing-thing shortcut
   * (e.g. `"⌘N"` from `useKeybindingDisplay`). When paired with
   * `emptyEntityName` and the trimmed query is empty, the shell auto-renders
   * `Press <kbd>{emptyShortcut}</kbd> to create {emptyEntityName}.` as the
   * empty-state hint. Accepts `null` so consumers can forward
   * `useKeybindingDisplay` output without a guard. Ignored when `emptyContent`
   * is provided.
   */
  emptyShortcut?: string | null;
  /**
   * Lowercase entity phrase used in the auto-rendered empty-state hint
   * (e.g. `"a terminal"`, `"a worktree"`). Required alongside `emptyShortcut`
   * for the chip to render.
   */
  emptyEntityName?: string;

  /**
   * The field's own keys, before default handling: chords that read or edit
   * the query. Field-only; a chord on a list key belongs in `onListKeyDown`.
   */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /**
   * A consumer's chords on the list keys (a modified Enter), offered before the
   * shell's navigation wherever the list keys work: on the field, after
   * `onKeyDown`, and on the results region, which Tab reaches and which hands
   * on only the list keys. `preventDefault()` claims the key.
   */
  onListKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
  /**
   * Optional leading adornment rendered inside the input's border (e.g. the
   * action palette's mode-prefix chip). Forwarded to `AppPaletteDialog.Input`
   * — see that component for layout details.
   */
  inputPrefix?: React.ReactNode;
  /**
   * Custom footer content. Omit — along with `getFooter` and `getActionLabel`
   * — for no footer band at all, which is the right answer for most surfaces.
   */
  footer?: React.ReactNode;
  /**
   * Dynamic footer derived from the currently selected item. Receives `null`
   * when there is no selection (empty results). Takes precedence over
   * `footer` when both are provided. Consumed only by `SearchablePalette`
   * itself — never forwarded to row items, so React Compiler keeps the
   * unchanged row functions cached when arrow keys move selection.
   */
  getFooter?: (selectedItem: T | null) => React.ReactNode;
  /**
   * Sugar for the common case of "the footer says one thing: what Enter does."
   * Returns the verb-noun action label for the current selection (e.g.
   * `"Switch terminal"`, `"Apply theme"`); the shell wraps it in a single `↵`
   * chip and drops the leading capital for mid-sentence rendering. Ignored when
   * `footer` or `getFooter` is also set — those win, in that order. Use a
   * stable reference (module-level fn or `useCallback`) to avoid recomputing
   * the footer node every render. Called only while a row is selected; with
   * nothing selected the footer carries no hint. Return `null` for a selection
   * Enter will not act on (an unavailable row) and the footer carries no hint
   * for it either.
   */
  getActionLabel?: (selectedItem: T) => string | null;
  /**
   * A pane beside the results for the selected row: a clipboard-history
   * preview, where a row can only show an excerpt. Receives `null` with no
   * selection; return `null` and the results take the full width. Outside the
   * listbox and not live — the row's own name is what each arrow press says.
   * Side by side once the window gives the workspace tier its full width
   * (900px), stacked below the results under it; size the results column with
   * `bodyClassName` and use the same breakpoint there.
   */
  getDetail?: (selectedItem: T | null) => React.ReactNode;
  /** Ambient metadata for the header's label row (`AppPaletteDialog.Header` `trailing`). */
  headerTrailing?: React.ReactNode;
  /** Additional className for AppPaletteDialog.Body */
  bodyClassName?: string;
  /** Custom content before the list */
  beforeList?: React.ReactNode;
  /** Custom content after the list */
  afterList?: React.ReactNode;
  /** Custom className for header */
  headerClassName?: string;
  /** Replace the entire body content (list, empty state, beforeList, afterList are ignored) */
  renderBody?: () => React.ReactNode;
  /** Total number of results before truncation, for overflow indicator */
  totalResults?: number;
  /**
   * When true, an indeterminate loading bar appears beneath the search input
   * after a short grace period. Use when the underlying data source is still
   * populating and the user might otherwise see an empty list.
   */
  isLoading?: boolean;
  /**
   * True while a deferred filter pass is catching up to the latest query.
   * Drives a stale-dim on the listbox (via `palette-results-stale`) gated by
   * the 200ms palette stale-delay (`--anti-flicker-delay-palette`) so sub-frame
   * work never flickers. The palette gate is shorter than the 400ms Doherty
   * floor because keystrokes arrive every ~200ms — a 400ms gate would almost
   * never fire before the next keystroke reset it. Reduced-motion and
   * performance-mode CSS bypasses keep the listbox at full opacity.
   */
  isFiltering?: boolean;
}

export function SearchablePalette<T>({
  isOpen,
  query,
  results,
  selectedIndex,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onConfirm,
  onClose,
  getItemId,
  renderItem,
  onHoverIndex,
  onSelectIndex,
  getSectionLabel,
  matchesById,
  label,
  shortcut,
  ariaLabel,
  tier,
  zIndex,
  searchPlaceholder = "Search",
  searchAriaLabel,
  searchAriaDescribedBy,
  clearQueryOnEscape = true,
  listId = "searchable-palette-list",
  itemIdPrefix = "palette-option",
  multiselectable = false,
  emptyMessage = "No items available",
  noMatchMessage,
  emptyContent,
  noMatchContent,
  emptyShortcut,
  emptyEntityName,
  onKeyDown,
  onListKeyDown,
  inputPrefix,
  footer,
  getFooter,
  getActionLabel,
  getDetail,
  headerTrailing,
  bodyClassName,
  beforeList,
  afterList,
  headerClassName,
  renderBody,
  totalResults,
  isLoading = false,
  isFiltering = false,
}: SearchablePaletteProps<T>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const renderLimit = useProgressiveRenderLimit(
    results.length,
    `${isOpen}\u0000${query}`,
    selectedIndex
  );

  const selectedOptionId =
    selectedIndex >= 0 && selectedIndex < results.length
      ? `${itemIdPrefix}-${getItemId(results[selectedIndex]!)}`
      : null;
  const banded = getSectionLabel !== undefined;
  useEffect(() => {
    const list = listRef.current;
    if (!list || selectedOptionId === null) return;
    // Band heads sit between the options, so a banded list finds the row by
    // id. Unbanded lists keep child position: some consumers render rows
    // without ids, and some wrap a row with its heading, which should scroll
    // in with it.
    const selectedItem = banded
      ? list.querySelector(`[id="${CSS.escape(selectedOptionId)}"]`)
      : list.children[selectedIndex];
    // A row the pointer just claimed is already where the user is looking, so
    // revealing it would scroll a half-visible row out from under the pointer.
    // The keys always reveal, even onto a row beneath a resting pointer.
    if (selectedItem instanceof HTMLElement && !isPointerClaimed(selectedItem)) {
      selectedItem.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  }, [selectedOptionId, selectedIndex, banded, results]);

  // One owner for "N results". Two things can end with a count worth saying —
  // a filter pass settling and an announced load landing — and they often end
  // in the same commit. Each schedules through here, so the later one replaces
  // the earlier and a single count is spoken. The count is read when the timer
  // fires, not when it is set, so a list that is still filling says what it
  // settled on.
  //
  // Zero results render `AppPaletteDialog.Empty`, which announces its own
  // "No matches for …". Saying "0 results" as well gives the same news two
  // owners, so zero is skipped — except for a `renderBody` consumer, which
  // draws no Empty and has only the count.
  const resultCountRef = useRef(results.length);
  const hasCustomBodyRef = useRef(renderBody !== undefined);
  useEffect(() => {
    resultCountRef.current = results.length;
    hasCustomBodyRef.current = renderBody !== undefined;
  });
  const countTimerRef = useRef<number | null>(null);
  const cancelCount = useCallback(() => {
    if (countTimerRef.current !== null) {
      window.clearTimeout(countTimerRef.current);
      countTimerRef.current = null;
    }
  }, []);
  const scheduleCount = useCallback(() => {
    cancelCount();
    countTimerRef.current = window.setTimeout(() => {
      countTimerRef.current = null;
      const count = resultCountRef.current;
      if (count === 0 && !hasCustomBodyRef.current) return;
      useAnnouncerStore.getState().announce(pluralize(count, "result"), "polite");
    }, UI_DOHERTY_THRESHOLD);
  }, [cancelCount]);
  useEffect(() => cancelCount, [cancelCount]);

  // A filter pass is announced on its trailing edge — the `isFiltering`
  // true→false transition that also clears the visual stale-dim, or, for a
  // list small enough to filter synchronously, the query change itself, whose
  // results landed in the same render — and debounced so fast typists don't
  // chatter the live region: a new pass cancels the last one's pending count.
  // Empty-query passes are skipped; the listbox already shows the no-input
  // state and a count there is noise.
  const prevIsFilteringRef = useRef(isFiltering);
  const prevQueryRef = useRef(query);
  useEffect(() => {
    const wasFiltering = prevIsFilteringRef.current;
    prevIsFilteringRef.current = isFiltering;
    const queryChanged = prevQueryRef.current !== query;
    prevQueryRef.current = query;
    if (isFiltering) {
      cancelCount();
      return;
    }
    if (!wasFiltering && !queryChanged) return;
    // Hosts now keep palettes mounted through their exit animation (#9917), so a
    // late filter pass can resolve after close — don't announce to a closed,
    // invisible palette.
    if (!isOpen) return;
    if (!query.trim()) return;
    scheduleCount();
  }, [isFiltering, query, isOpen, cancelCount, scheduleCount]);

  // The header's loading sweep is aria-hidden, so a slow load needs words too
  // (WCAG 4.1.3 counts busy indicators as status). Same Doherty gate as the
  // sweep's own onset: a fast load says nothing. Keyed to the load alone, so
  // rows arriving or a query changing mid-load never restart it. Once an
  // announced load lands, the count owner above says what it brought.
  const loadAnnouncedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      loadAnnouncedRef.current = false;
      cancelCount();
      return undefined;
    }
    if (isLoading) {
      const timer = window.setTimeout(() => {
        loadAnnouncedRef.current = true;
        useAnnouncerStore.getState().announce("Loading results", "polite");
      }, UI_DOHERTY_THRESHOLD);
      return () => window.clearTimeout(timer);
    }
    if (loadAnnouncedRef.current) {
      loadAnnouncedRef.current = false;
      scheduleCount();
    }
    return undefined;
  }, [isOpen, isLoading, cancelCount, scheduleCount]);

  // Escape anywhere in the palette clears a query before it closes. The dialog
  // routes both of its Escape paths (its document backstop and the escape
  // stack) through here, so the results region and any control past the list
  // get the same two stages as the field. Focus goes back to the field, since
  // an emptied search is one the user is about to retype.
  const handleDialogClose = useCallback(
    (reason?: PaletteCloseReason) => {
      if (reason === "escape" && clearQueryOnEscape && query !== "") {
        onQueryChange("");
        inputRef.current?.focus({ preventScroll: true });
        return;
      }
      onClose(reason);
    },
    [clearQueryOnEscape, query, onQueryChange, onClose]
  );

  const hoverIndexHandler = onHoverIndex ?? noopHoverIndex;
  const jumpToIndex = onSelectIndex ?? onHoverIndex;

  /**
   * List navigation shared by the query input and the focusable results region
   * (`AppPaletteDialog.Body`), so arrow keys and Enter keep working after Tab
   * moves focus off the input (#11431). Element-agnostic: it reads only
   * key/modifier state, never `currentTarget`.
   */
  const handleNavigationKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (onListKeyDown) {
        onListKeyDown(e);
        if (e.defaultPrevented) return;
      }
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          onSelectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          onSelectNext();
          break;
        case "Home":
          // Override native caret-to-start so the listbox jumps to the first
          // result. The palette input is single-line, the caret rarely needs
          // explicit movement, and matching VS Code / Linear / Raycast keeps
          // the muscle memory consistent. No-op when there's nothing to jump
          // to so empty-state typing isn't intercepted, and when the consumer
          // gave us no way to move the cursor — preventing the default then
          // made the key do nothing at all. A held modifier or a composing IME
          // leaves the key to the field (Shift+Home selects the query).
          if (results.length === 0 || !jumpToIndex || keyBelongsToField(e)) break;
          e.preventDefault();
          e.stopPropagation();
          jumpToIndex(0);
          break;
        case "End":
          if (results.length === 0 || !jumpToIndex || keyBelongsToField(e)) break;
          e.preventDefault();
          e.stopPropagation();
          jumpToIndex(results.length - 1);
          break;
        // A page of rows rather than native scrolling, which would walk the
        // highlighted row off screen and leave Enter committing something the
        // user can no longer see.
        case "PageUp":
        case "PageDown": {
          if (!jumpToIndex || keyBelongsToField(e)) break;
          const target = pageListboxCursor(e.key, selectedIndex, results.length);
          if (target === null) break;
          e.preventDefault();
          e.stopPropagation();
          jumpToIndex(target);
          break;
        }
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          onConfirm(isMac() ? e.metaKey : e.ctrlKey);
          break;
      }
    },
    [
      onListKeyDown,
      onSelectPrevious,
      onSelectNext,
      onConfirm,
      results.length,
      selectedIndex,
      jumpToIndex,
    ]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

      if (onKeyDown) {
        onKeyDown(e);
        if (e.defaultPrevented) return;
      }

      // The field clears its own query and stops the key there, so the
      // dialog's backstop never sees it; an empty field lets Escape through to
      // `handleDialogClose`. Tab is left alone: it moves focus on to the
      // results region and any control past the list, as it does everywhere.
      if (e.key === "Escape" && clearQueryOnEscape && query !== "") {
        e.preventDefault();
        e.stopPropagation();
        onQueryChange("");
        return;
      }

      handleNavigationKeyDown(e);
    },
    [onKeyDown, handleNavigationKeyDown, clearQueryOnEscape, query, onQueryChange]
  );

  const activeDescendant =
    results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
      ? `${itemIdPrefix}-${getItemId(results[selectedIndex]!)}`
      : undefined;

  const selectedItem = results[selectedIndex] ?? null;

  // The listbox is only in the tree while there are rows; an expanded combobox
  // controlling an id that is not rendered points assistive technology at
  // nothing. A `renderBody` consumer draws its own body, so it keeps the claim.
  const listRendered = renderBody ? isOpen : isOpen && results.length > 0;

  // Derive the action label as a primitive so the footer JSX can be memoized
  // by its string content rather than the (changing) selectedItem reference.
  // Without this, arrow-key navigation rebuilds <PaletteFooterHints/> on every
  // selection change even when the label text is identical across items.
  //
  // Honour the documented precedence (getFooter > footer > getActionLabel):
  // skip the getActionLabel call entirely when a higher-precedence footer is
  // supplied, so consumers aren't surprised by getActionLabel side-effects
  // when its output would be discarded anyway.
  const actionLabelActive = !getFooter && footer === undefined && getActionLabel != null;
  // No selection, no hint: with nothing on screen for Enter to act on, a verb
  // in the footer promises an action the key will not take.
  const rawActionLabel =
    actionLabelActive && selectedItem != null ? getActionLabel!(selectedItem) : null;
  const actionLabelFooter = useMemo(() => {
    if (rawActionLabel == null) return null;
    const actionLabel = rawActionLabel.trim() || "Select";
    const phrase = `to ${toHintPhrase(actionLabel)}`;
    // One chip, not three. `getActionLabel` names what Enter does for the
    // current selection, which is the only thing a footer is for now — the
    // `↑↓` and `Esc` chips this used to compose were restating conventions.
    return <PaletteFooterHints primaryHint={{ keys: "Enter", label: phrase }} />;
  }, [rawActionLabel]);

  let footerContent: React.ReactNode;
  if (getFooter) {
    footerContent = getFooter(selectedItem);
  } else if (footer !== undefined) {
    footerContent = footer;
  } else if (actionLabelFooter !== null) {
    footerContent = actionLabelFooter;
  } else {
    footerContent = undefined;
  }

  const autoEmptyChip =
    !emptyContent && emptyShortcut && emptyEntityName ? (
      <p className="mt-2 text-xs text-text-secondary">
        Press <kbd className={KBD_CLASS}>{emptyShortcut}</kbd> to create {emptyEntityName}.
      </p>
    ) : null;
  const resolvedEmptyContent = emptyContent ?? autoEmptyChip;
  const detail = getDetail?.(selectedItem) ?? null;

  return (
    <AppPaletteDialog
      isOpen={isOpen}
      onClose={handleDialogClose}
      ariaLabel={ariaLabel}
      tier={tier}
      zIndex={zIndex}
    >
      <AppPaletteDialog.Header
        label={label}
        shortcut={shortcut}
        trailing={headerTrailing}
        className={headerClassName}
        isLoading={isLoading}
      >
        <AppPaletteDialog.Input
          inputRef={inputRef}
          inputPrefix={inputPrefix}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={searchPlaceholder}
          role="combobox"
          aria-expanded={listRendered}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-label={searchAriaLabel ?? searchPlaceholder.replace(/(?:\.{3}|…)$/, "")}
          aria-describedby={searchAriaDescribedBy}
          aria-controls={listRendered ? listId : undefined}
          aria-activedescendant={activeDescendant}
        />
      </AppPaletteDialog.Header>

      {/* `detail !== null` rather than a second flag: the pane comes and goes
          with the selection, and the results take the width back with it. */}
      <div className={detail !== null ? "flex min-h-0 max-[900px]:flex-col" : "contents"}>
        <AppPaletteDialog.Body
          className={bodyClassName}
          ariaLabel={label}
          activeDescendant={activeDescendant}
          onNavigationKeyDown={handleNavigationKeyDown}
          keepPointerFocusOnInput
        >
          {renderBody ? (
            renderBody()
          ) : (
            <>
              {beforeList}
              {results.length === 0 ? (
                // While loading, suppress the empty state so the header progress
                // bar is the only signal — otherwise the user sees "no results"
                // and the loading bar at the same time. The body keeps its
                // min-height so the modal doesn't collapse before data arrives.
                isLoading ? null : (
                  <AppPaletteDialog.Empty
                    query={query}
                    emptyMessage={emptyMessage}
                    noMatchMessage={noMatchMessage}
                    // Escape clears the query before it closes (handleDialogClose),
                    // so every no-match state has the same way back; a consumer
                    // with a better next step passes its own.
                    noMatchContent={noMatchContent ?? <PaletteNoMatchHint />}
                  >
                    {resolvedEmptyContent}
                  </AppPaletteDialog.Empty>
                )
              ) : (
                <div
                  ref={listRef}
                  id={listId}
                  role="listbox"
                  aria-label={label}
                  aria-multiselectable={multiselectable || undefined}
                  className={isFiltering ? "palette-results-stale" : undefined}
                  data-stale={isFiltering ? "true" : undefined}
                  aria-busy={isFiltering || undefined}
                >
                  {getSectionLabel
                    ? sectionRuns(results.slice(0, renderLimit), getSectionLabel).map((run) => (
                        <Fragment key={`${run.start}-${run.label}`}>
                          {/* Not role="group": inside a listbox, Chromium +
                              VoiceOver drop a group's label and announce "empty
                              group". The head is an inert option instead, as in
                              the action palette; arrow keys skip it because it is
                              not in `results`. An empty label is a run with no
                              head, for palettes that band only some rows. */}
                          {run.label !== "" && (
                            <div
                              className={SECTION_HEADER_CLASS}
                              role="option"
                              aria-disabled="true"
                              aria-selected="false"
                              aria-label={run.label}
                            >
                              {run.label}
                            </div>
                          )}
                          {run.items.map((item, offset) => {
                            const index = run.start + offset;
                            return renderItem(
                              item,
                              index,
                              index === selectedIndex,
                              hoverIndexHandler,
                              matchesById?.get(getItemId(item))
                            );
                          })}
                        </Fragment>
                      ))
                    : results
                        .slice(0, renderLimit)
                        .map((item, index) =>
                          renderItem(
                            item,
                            index,
                            index === selectedIndex,
                            hoverIndexHandler,
                            matchesById?.get(getItemId(item))
                          )
                        )}
                </div>
              )}
              {totalResults != null && (
                <PaletteOverflowNotice shown={results.length} total={totalResults} />
              )}
              {afterList}
            </>
          )}
        </AppPaletteDialog.Body>
        {detail}
      </div>

      <AppPaletteDialog.Footer>{footerContent}</AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
