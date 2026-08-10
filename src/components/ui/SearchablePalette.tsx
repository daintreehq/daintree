import { useEffect, useMemo, useRef, useCallback } from "react";
import {
  AppPaletteDialog,
  KBD_CLASS,
  PaletteFooterHints,
  type PaletteSurfaceTier,
} from "@/components/ui/AppPaletteDialog";
import { PaletteOverflowNotice } from "@/components/ui/PaletteOverflowNotice";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";

const noopHoverIndex = () => {};

export interface SearchablePaletteProps<T> {
  isOpen: boolean;
  query: string;
  results: T[];
  selectedIndex: number;
  onQueryChange: (query: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onConfirm: () => void;
  onClose: () => void;

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
  /** Placeholder text for search input */
  searchPlaceholder?: string;
  /** ARIA label for the search input */
  searchAriaLabel?: string;
  /** ID for the listbox container */
  listId?: string;
  /** Prefix for item IDs used in aria-activedescendant */
  itemIdPrefix?: string;

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

  /** Additional keyboard handler called before default handling */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
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
   * chip and lowercases the label for mid-sentence rendering. Ignored when
   * `footer` or `getFooter` is also set — those win, in that order. Use a
   * stable reference (module-level fn or `useCallback`) to avoid recomputing
   * the footer node every render.
   */
  getActionLabel?: (selectedItem: T | null) => string;
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
  matchesById,
  label,
  shortcut,
  ariaLabel,
  tier,
  searchPlaceholder = "Search",
  searchAriaLabel,
  listId = "searchable-palette-list",
  itemIdPrefix = "palette-option",
  emptyMessage = "No items available",
  noMatchMessage,
  emptyContent,
  noMatchContent,
  emptyShortcut,
  emptyEntityName,
  onKeyDown,
  inputPrefix,
  footer,
  getFooter,
  getActionLabel,
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

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && results.length > 0) {
      const selectedItem = listRef.current.children[selectedIndex];
      if (selectedItem instanceof HTMLElement) {
        selectedItem.scrollIntoView({ block: "nearest", behavior: "instant" });
      }
    }
  }, [selectedIndex, results]);

  // Announce the result count to screen readers on the trailing edge of a
  // filter pass. Gated on the `isFiltering` true→false transition (mirrors the
  // visual stale-dim signal) and debounced 400ms so fast typists don't chatter
  // the live region. Empty-query passes are skipped — the listbox already
  // reflects the no-input state and an "N results" announcement there is noise.
  const prevIsFilteringRef = useRef(isFiltering);
  useEffect(() => {
    const wasFiltering = prevIsFilteringRef.current;
    prevIsFilteringRef.current = isFiltering;
    if (!wasFiltering || isFiltering) return;
    // Hosts now keep palettes mounted through their exit animation (#9917), so a
    // late filter pass can resolve after close — don't announce to a closed,
    // invisible palette.
    if (!isOpen) return;
    if (!query.trim()) return;
    const count = results.length;
    const timer = window.setTimeout(() => {
      const message = count === 1 ? "1 result" : `${count} results`;
      useAnnouncerStore.getState().announce(message, "polite");
    }, UI_DOHERTY_THRESHOLD);
    return () => window.clearTimeout(timer);
  }, [isFiltering, query, results.length, isOpen]);

  useEscapeStack(isOpen, () => {
    if (query !== "") {
      onQueryChange("");
    } else {
      onClose();
    }
  });

  const hoverIndexHandler = onHoverIndex ?? noopHoverIndex;

  /**
   * List navigation shared by the query input and the focusable results region
   * (`AppPaletteDialog.Body`), so arrow keys and Enter keep working after Tab
   * moves focus off the input (#11431). Element-agnostic: it reads only
   * key/modifier state, never `currentTarget`.
   */
  const handleNavigationKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
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
          // to so empty-state typing isn't intercepted.
          if (results.length === 0) break;
          e.preventDefault();
          e.stopPropagation();
          hoverIndexHandler(0);
          break;
        case "End":
          if (results.length === 0) break;
          e.preventDefault();
          e.stopPropagation();
          hoverIndexHandler(results.length - 1);
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          onConfirm();
          break;
      }
    },
    [onSelectPrevious, onSelectNext, onConfirm, results.length, hoverIndexHandler]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

      if (onKeyDown) {
        onKeyDown(e);
        if (e.defaultPrevented) return;
      }

      // Tab stays input-only: on the results region it must keep its native
      // traversal so controls rendered after the list stay reachable.
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          onSelectPrevious();
        } else {
          onSelectNext();
        }
        return;
      }

      handleNavigationKeyDown(e);
    },
    [onKeyDown, onSelectPrevious, onSelectNext, handleNavigationKeyDown]
  );

  const activeDescendant =
    results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
      ? `${itemIdPrefix}-${getItemId(results[selectedIndex]!)}`
      : undefined;

  const selectedItem = results[selectedIndex] ?? null;

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
  const rawActionLabel = actionLabelActive ? getActionLabel!(selectedItem) : null;
  const actionLabelFooter = useMemo(() => {
    if (rawActionLabel == null) return null;
    const actionLabel = rawActionLabel.trim() || "Select";
    const phrase = `to ${actionLabel.toLowerCase()}`;
    // One chip, not three. `getActionLabel` names what Enter does for the
    // current selection, which is the only thing a footer is for now — the
    // `↑↓` and `Esc` chips this used to compose were restating conventions.
    return <PaletteFooterHints primaryHint={{ keys: ["↵"], label: phrase }} />;
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
      <p className="mt-2 text-xs text-daintree-text/40">
        Press <kbd className={KBD_CLASS}>{emptyShortcut}</kbd> to create {emptyEntityName}.
      </p>
    ) : null;
  const resolvedEmptyContent = emptyContent ?? autoEmptyChip;

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel={ariaLabel} tier={tier}>
      <AppPaletteDialog.Header
        label={label}
        shortcut={shortcut}
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
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-label={searchAriaLabel ?? searchPlaceholder.replace("...", "")}
          aria-controls={listId}
          aria-activedescendant={activeDescendant}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        className={bodyClassName}
        ariaLabel={label}
        activeDescendant={activeDescendant}
        onNavigationKeyDown={handleNavigationKeyDown}
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
                  noMatchContent={noMatchContent}
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
                className={isFiltering ? "palette-results-stale" : undefined}
                data-stale={isFiltering ? "true" : undefined}
                aria-busy={isFiltering || undefined}
              >
                {results.map((item, index) =>
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

      <AppPaletteDialog.Footer>{footerContent}</AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
