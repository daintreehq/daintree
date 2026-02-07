import { useEffect, useRef, useCallback } from "react";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";

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
  /** Render a list item */
  renderItem: (item: T, index: number, isSelected: boolean) => React.ReactNode;

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

  /** Additional keyboard handler called before default handling */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** Custom footer content. Omit for default keyboard hints. */
  footer?: React.ReactNode;
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
  label,
  keyHint,
  ariaLabel,
  searchPlaceholder = "Search...",
  searchAriaLabel,
  listId = "searchable-palette-list",
  itemIdPrefix = "palette-option",
  emptyMessage = "No items available",
  noMatchMessage,
  onKeyDown,
  footer,
  bodyClassName,
  beforeList,
  afterList,
  headerClassName,
  renderBody,
}: SearchablePaletteProps<T>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      const rafId = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(rafId);
    }
  }, [isOpen]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && results.length > 0) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      selectedItem?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, results]);

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
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
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
    [onKeyDown, onSelectPrevious, onSelectNext, onConfirm, onClose]
  );

  const activeDescendant =
    results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
      ? `${itemIdPrefix}-${getItemId(results[selectedIndex])}`
      : undefined;

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel={ariaLabel}>
      <AppPaletteDialog.Header label={label} keyHint={keyHint} className={headerClassName}>
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
              />
            ) : (
              <div ref={listRef} id={listId} role="listbox" aria-label={label}>
                {results.map((item, index) => renderItem(item, index, index === selectedIndex))}
              </div>
            )}
            {afterList}
          </>
        )}
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>{footer}</AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
