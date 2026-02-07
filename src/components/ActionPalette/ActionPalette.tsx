import { useCallback } from "react";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
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
  const handleSelect = useCallback(
    (item: ActionPaletteItemType) => {
      executeAction(item);
    },
    [executeAction]
  );

  return (
    <SearchablePalette<ActionPaletteItemType>
      isOpen={isOpen}
      query={query}
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={selectPrevious}
      onSelectNext={selectNext}
      onConfirm={confirmSelection}
      onClose={close}
      getItemId={(item) => item.id}
      renderItem={(item, _index, isSelected) => (
        <ActionPaletteItem
          key={item.id}
          item={item}
          isSelected={isSelected}
          onSelect={handleSelect}
        />
      )}
      label="Actions"
      keyHint="⇧⇧"
      ariaLabel="Action palette"
      searchPlaceholder="Search actions..."
      searchAriaLabel="Search actions"
      listId="action-palette-list"
      itemIdPrefix="action-option"
      emptyMessage="No actions available"
      noMatchMessage={`No actions match "${query}"`}
    />
  );
}
