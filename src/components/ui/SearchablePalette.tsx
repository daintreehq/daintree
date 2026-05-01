import { useEffect, useRef, useCallback } from "react";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { PaletteOverflowNotice } from "@/components/ui/PaletteOverflowNotice";
import { useEscapeStack } from "@/hooks";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";

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
  /** Keyboard hint displayed in header (e.g. "⌘P") */
  keyHint?: string;
  /** ARIA label for the dialog */
  ariaLabel: string;
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
  /** Message when search yields no results */
  noMatchMessage?: string;
  /** Content shown below the empty message (no-data state only, hidden during search) */
  emptyContent?: React.ReactNode;

  /** Additional keyboard handler called before default handling */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** Custom footer content. Omit for default keyboard hints. */
  footer?: React.ReactNode;
  /**
   * Dynamic footer derived from the currently selected item. Receives `null`
   * when there is no selection (empty results). Takes precedence over
   * `footer` when both are provided. Consumed only by `SearchablePalette`
   * itself — never forwarded to row items, so per-item `React.memo` stays
   * intact when arrow keys move selection.
   */
  getFooter?: (selectedItem: T | null) => React.ReactNode;
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
   * Drives a stale-dim on the listbox (via `palette-results-stale`) gated by a
   * 400ms transition-delay so sub-frame work never flickers. Reduced-motion
   * and performance-mode CSS bypasses keep the listbox at full opacity.
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
  keyHint,
  ariaLabel,
  searchPlaceholder = "Search...",
  searchAriaLabel,
  listId = "searchable-palette-list",
  itemIdPrefix = "palette-option",
  emptyMessage = "No items available",
  noMatchMessage,
  emptyContent,
  onKeyDown,
  footer,
  getFooter,
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
    if (isOpen) {
      const rafId = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(rafId);
    }
    return undefined;
  }, [isOpen]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && results.length > 0) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      selectedItem?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, results]);

  useEscapeStack(isOpen, () => {
    if (query !== "") {
      onQueryChange("");
    } else {
      onClose();
    }
  });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (onKeyDown) {
        onKeyDown(e);
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
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          onConfirm();
          break;
        case "Tab":
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            onSelectPrevious();
          } else {
            onSelectNext();
          }
          break;
      }
    },
    [onKeyDown, onSelectPrevious, onSelectNext, onConfirm]
  );

  const activeDescendant =
    results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
      ? `${itemIdPrefix}-${getItemId(results[selectedIndex]!)}`
      : undefined;

  const noopHoverIndex = useCallback(() => {}, []);
  const hoverIndexHandler = onHoverIndex ?? noopHoverIndex;

  const footerContent = getFooter ? getFooter(results[selectedIndex] ?? null) : footer;

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel={ariaLabel}>
      <AppPaletteDialog.Header
        label={label}
        keyHint={keyHint}
        className={headerClassName}
        isLoading={isLoading}
      >
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={searchPlaceholder}
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label={searchAriaLabel ?? searchPlaceholder.replace("...", "")}
          aria-controls={listId}
          aria-activedescendant={activeDescendant}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body className={bodyClassName}>
        {renderBody ? (
          renderBody()
        ) : (
          <>
            {beforeList}
            {results.length === 0 ? (
              <AppPaletteDialog.Empty
                query={query}
                emptyMessage={emptyMessage}
                noMatchMessage={noMatchMessage ?? `No items match "${query}"`}
              >
                {emptyContent}
              </AppPaletteDialog.Empty>
            ) : (
              <div
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label={label}
                className={isFiltering ? "palette-results-stale" : undefined}
                data-stale={isFiltering ? "true" : undefined}
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
