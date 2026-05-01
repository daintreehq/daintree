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
  | "totalResults"
  | "selectedIndex"
  | "isShowingRecentlyUsed"
  | "close"
  | "setQuery"
  | "setSelectedIndex"
  | "selectPrevious"
  | "selectNext"
  | "executeAction"
  | "confirmSelection"
>;

export function ActionPalette({
  isOpen,
  query,
  results,
  totalResults,
  selectedIndex,
  isShowingRecentlyUsed,
  close,
  setQuery,
  setSelectedIndex,
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
      onHoverIndex={setSelectedIndex}
      getItemId={(item) => item.id}
      renderItem={(item, index, isSelected, onHoverIndex) => (
        <ActionPaletteItem
          key={item.id}
          item={item}
          isSelected={isSelected}
          onSelect={handleSelect}
          onHover={() => onHoverIndex(index)}
        />
      )}
      label="Actions"
      keyHint="⇧⇧"
      ariaLabel="Action palette"
      searchPlaceholder="Search actions..."
      searchAriaLabel="Search actions"
      listId="action-palette-list"
      itemIdPrefix="action-option"
      emptyMessage="No recently used actions"
      noMatchMessage={`No actions match "${query}"`}
      totalResults={totalResults}
      beforeList={
        isShowingRecentlyUsed ? (
          <div className="px-3 pt-2 pb-1 text-xs text-daintree-text/40">Recently used</div>
        ) : null
      }
      emptyContent={
        <p className="mt-2 text-xs text-daintree-text/40">
          Actions depend on the focused panel and current context.
        </p>
      }
    />
  );
}
