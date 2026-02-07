import { useEffect, useRef, useCallback } from "react";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { ActionPaletteItem } from "./ActionPaletteItem";
import type {
  ActionPaletteItem as ActionPaletteItemType,
  UseActionPaletteReturn,
} from "@/hooks/useActionPalette";

type ActionPaletteProps = Pick<
  UseActionPaletteReturn,
  | "isOpen"
  | "query"
  | "results"
  | "selectedIndex"
  | "close"
  | "setQuery"
  | "selectPrevious"
  | "selectNext"
  | "executeAction"
  | "confirmSelection"
>;

export function ActionPalette({
  isOpen,
  query,
  results,
  selectedIndex,
  close,
  setQuery,
  selectPrevious,
  selectNext,
  executeAction,
  confirmSelection,
}: ActionPaletteProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      selectedItem?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          selectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          selectNext();
          break;
        case "Enter":
          e.preventDefault();
          confirmSelection();
          break;
        case "Escape":
          e.preventDefault();
          close();
          break;
        case "Tab":
          e.preventDefault();
          if (e.shiftKey) {
            selectPrevious();
          } else {
            selectNext();
          }
          break;
      }
    },
    [selectPrevious, selectNext, confirmSelection, close]
  );

  const handleSelect = useCallback(
    (item: ActionPaletteItemType) => {
      executeAction(item);
    },
    [executeAction]
  );

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={close} ariaLabel="Action palette">
      <AppPaletteDialog.Header label="Actions" keyHint="⇧⇧">
        <AppPaletteDialog.Input
          inputRef={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search actions..."
          aria-label="Search actions"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls="action-palette-list"
          aria-activedescendant={
            results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
              ? `action-option-${results[selectedIndex].id}`
              : undefined
          }
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        {results.length === 0 ? (
          <AppPaletteDialog.Empty
            query={query}
            emptyMessage="No actions available"
            noMatchMessage={`No actions match "${query}"`}
          />
        ) : (
          <div ref={listRef} id="action-palette-list" role="listbox" aria-label="Actions">
            {results.map((item, index) => (
              <ActionPaletteItem
                key={item.id}
                item={item}
                isSelected={index === selectedIndex}
                onSelect={handleSelect}
              />
            ))}
          </div>
        )}
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer />
    </AppPaletteDialog>
  );
}
